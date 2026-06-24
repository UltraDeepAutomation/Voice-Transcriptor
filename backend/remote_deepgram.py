"""Deepgram Nova-3 — pre-recorded REST transcription.

Uses the synchronous listen endpoint:
    POST https://api.deepgram.com/v1/listen

Used for:
  * File uploads and stop-time fallback transcription of the canonical WAV.
  * NOT used for live streaming — see ``backend.remote_deepgram_live``
    which is the single source of truth for live Deepgram sessions.

Accepts raw audio bytes (WAV/MP3/etc.) as the request body.
"""

import logging
from typing import Any, Dict, Optional

from backend.audio_mime import audio_content_type
from backend.http_retry import RemoteError, request_with_retry

logger = logging.getLogger(__name__)


class DeepgramRemoteError(RemoteError):
    """Deepgram-specific remote failure (REST / pre-recorded API).

    Subclass of ``RemoteError`` so callers can catch provider-specific
    failures (``except DeepgramRemoteError`` → switch to OpenRouter or
    local Whisper) or a generic remote failure (``except RemoteError``).

    Previously this was a bare ``DeepgramRemoteError = RemoteError``
    alias — ``main.py`` imported it as ``DgRemoteError`` which gave
    zero provider discrimination at the catch site (``except
    (OrRemoteError, DgRemoteError)`` was equivalent to catching
    ``RemoteError`` twice).
    """


# ``raise RemoteError(...)`` inside this module must now produce the
# Deepgram subclass. The assignment replaces the locally-bound name
# without touching the base class in http_retry.
RemoteError = DeepgramRemoteError  # type: ignore[misc]

# 1.1.25 SSOT: imported from ``backend.deepgram_endpoints`` so REST
# and live modules share one source of truth for the Deepgram host.
# Re-exported as ``DEEPGRAM_API_BASE`` for backward compat with any
# external caller that imports the old name.
from backend.deepgram_endpoints import DEEPGRAM_REST_BASE as DEEPGRAM_API_BASE  # noqa: E402,F401


_DEEPGRAM_CONNECT_TIMEOUT_SEC = 10
_DEEPGRAM_SMALL_AUDIO_BYTES = 1 * 1024 * 1024
_DEEPGRAM_LARGE_AUDIO_BYTES = 5 * 1024 * 1024


def _deepgram_http_policy(audio_size_bytes: int) -> tuple[tuple[int, int], int]:
    """Return (timeout, attempts) for Deepgram REST by body size.

    Short live-capture recoveries are usually tiny compressed payloads.
    They should fail fast on provider stalls instead of inheriting the
    long upload budget required by multi-megabyte files.
    """
    size = max(0, int(audio_size_bytes or 0))
    body_mb = max(1.0, size / (1024 * 1024))

    if size <= _DEEPGRAM_SMALL_AUDIO_BYTES:
        return (_DEEPGRAM_CONNECT_TIMEOUT_SEC, 12), 1
    if size < _DEEPGRAM_LARGE_AUDIO_BYTES:
        return (_DEEPGRAM_CONNECT_TIMEOUT_SEC, max(45, int(body_mb * 10))), 2
    return (_DEEPGRAM_CONNECT_TIMEOUT_SEC, max(180, int(body_mb * 8))), 2


def _format_deepgram_speaker_words(words: object) -> str:
    """Return a speaker-labelled transcript from Deepgram word objects."""
    if not isinstance(words, list) or not words:
        return ""
    parts: list[str] = []
    current_speaker: Optional[int] = None
    current_words: list[str] = []
    saw_speaker = False

    def flush() -> None:
        nonlocal current_words
        if not current_words:
            return
        text = " ".join(current_words).strip()
        if not text:
            current_words = []
            return
        if current_speaker is None:
            parts.append(text)
        else:
            parts.append(f"Speaker {current_speaker}: {text}")
        current_words = []

    for item in words:
        if not isinstance(item, dict):
            continue
        token = str(item.get("punctuated_word") or item.get("word") or "").strip()
        if not token:
            continue
        speaker_raw = item.get("speaker")
        speaker: Optional[int] = None
        if speaker_raw is not None:
            try:
                speaker = int(speaker_raw)
                saw_speaker = True
            except (TypeError, ValueError):
                speaker = current_speaker
        else:
            speaker = current_speaker
        if current_words and speaker != current_speaker:
            flush()
        current_speaker = speaker
        current_words.append(token)

    flush()
    return "\n\n".join(parts) if saw_speaker else ""


def deepgram_transcribe(
    *,
    api_key: str,
    audio_bytes: bytes,
    filename: str,
    model: str = "nova-3",
    language: Optional[str] = None,
    diarize: bool = False,
    num_speakers: Optional[str] = None,
) -> Dict[str, Any]:
    """Transcribe audio using Deepgram's pre-recorded API.

    Returns {"text": str, "raw": dict}.

    Note: ``smart_format`` is intentionally disabled. It only fully supports
    English / Spanish / French; for Russian and other languages it applies
    a "basic formatting" pass that actually strips punctuation. We instead
    enable the individual features that work across all languages
    (``punctuate``, ``paragraphs``, ``numerals``).
    """
    if not api_key:
        raise RemoteError("Deepgram API key is not configured")

    url = f"{DEEPGRAM_API_BASE}/listen"

    params: Dict[str, str] = {
        "model": model or "nova-3",
        "punctuate": "true",
        "paragraphs": "true",
        "numerals": "true",
        "filler_words": "false",
    }
    if diarize:
        # Deepgram REST flag for speaker labelling. The response adds
        # ``words[...].speaker`` and the user-facing text below renders
        # speaker-labelled paragraphs from that canonical word list.
        params["diarize"] = "true"
        speakers_raw = str(num_speakers or "").strip()
        if speakers_raw:
            try:
                speakers = int(speakers_raw)
            except ValueError as exc:
                raise RemoteError("Deepgram num_speakers must be an integer") from exc
            if speakers < 1 or speakers > 10:
                raise RemoteError("Deepgram num_speakers must be between 1 and 10")
            params["num_speakers"] = str(speakers)
    if language and language.lower() not in ("auto", ""):
        params["language"] = language
    else:
        params["detect_language"] = "true"

    content_type = audio_content_type(filename)

    headers = {
        "Authorization": f"Token {api_key}",
        "Content-Type": content_type,
    }

    timeout, upload_retries = _deepgram_http_policy(len(audio_bytes))
    logger.info(
        "deepgram_transcribe: model=%s, audio=%d bytes timeout=%s attempts=%d",
        model,
        len(audio_bytes),
        timeout,
        upload_retries,
    )
    # Adaptive timeout for Deepgram REST uploads.
    #
    # User report (1 May 2026): a 26.6 MB m4a from a slow / cross-region
    # link (RU → us-east Deepgram) failed with
    #   network error after 3 attempts: ('Connection aborted.',
    #   TimeoutError('The write operation timed out'))
    # Root cause: ``requests`` applies the read-timeout to the SOCKET as
    # a whole, including the upload (write) phase. With the body still
    # being uploaded after 60 s the socket trips its idle timeout and
    # raises during ``data=`` send. Retrying the same 26 MB POST 3 times
    # just bled bandwidth — the bottleneck is upload speed, not transient
    # provider hiccups.
    #
    # Large files keep the old generous budget: ``read = max(180,
    # body_mb * 8)`` seconds, with two attempts. Short live recordings
    # use one 12 s attempt, because the body is already only a few
    # dozen KB after compaction; waiting 20-35 s there is provider or
    # network stall, not meaningful transcription work.
    r = request_with_retry(
        "POST", url,
        headers=headers,
        params=params,
        data=audio_bytes,
        timeout=timeout,
        retries=upload_retries,
    )

    if r.status_code >= 400:
        error_text = r.text[:400]
        raise RemoteError(f"Deepgram API error (HTTP {r.status_code}): {error_text}")

    try:
        result = r.json()
    except Exception:
        raise RemoteError(f"Deepgram: invalid JSON response: {r.text[:300]}")

    # Extract text from Deepgram response structure.
    # When paragraphs=true, Deepgram returns a structured paragraphs object
    # with proper sentence grouping. We join paragraphs with double newlines
    # to produce clean, WhisperFlow-quality formatted output.
    text = ""
    try:
        channel = result["results"]["channels"][0]
        alternatives = channel.get("alternatives", [])
        alternative = alternatives[0] if alternatives else {}
        if diarize:
            text = _format_deepgram_speaker_words(alternative.get("words"))
        # Try paragraphs first (structured paragraph output)
        paragraphs_obj = alternative.get("paragraphs")
        if not text and paragraphs_obj and isinstance(paragraphs_obj, dict):
            paragraph_list = paragraphs_obj.get("paragraphs", [])
            if paragraph_list:
                para_texts = []
                for para in paragraph_list:
                    sentences = para.get("sentences", [])
                    para_text = " ".join(
                        s.get("text", "") for s in sentences
                    ).strip()
                    if para_text:
                        para_texts.append(para_text)
                if para_texts:
                    text = "\n\n".join(para_texts)
        # Fallback to flat transcript
        if not text:
            if alternatives:
                text = alternatives[0].get("transcript", "")
    except (KeyError, IndexError) as e:
        # 1.1.25: previously ``pass``-swallowed without context. A
        # Deepgram schema change (rename/restructure of channels/
        # alternatives) silently produced empty transcripts on
        # every call — the user saw "success, 0 chars" and assumed
        # the audio was bad. Now log enough context to identify
        # the breakage.
        logger.warning(
            "deepgram_transcribe: response shape mismatch (%s). "
            "Result keys at root: %r — falling back to empty text.",
            e,
            list(result.keys()) if isinstance(result, dict) else type(result).__name__,
        )

    logger.info("deepgram_transcribe: success, %d chars", len(text))
    return {
        "text": str(text).strip(),
        "raw": result,
    }
