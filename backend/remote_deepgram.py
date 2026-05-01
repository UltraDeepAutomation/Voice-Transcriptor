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
import mimetypes
from typing import Any, Dict, Optional

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

DEEPGRAM_API_BASE = "https://api.deepgram.com/v1"


def deepgram_transcribe(
    *,
    api_key: str,
    audio_bytes: bytes,
    filename: str,
    model: str = "nova-3",
    language: Optional[str] = None,
    diarize: bool = False,
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
        # ``words[...].speaker`` which we ignore for the simple text
        # path — caller receives the full transcript and can inspect
        # ``raw`` for speaker segmentation.
        params["diarize"] = "true"
    if language and language.lower() not in ("auto", ""):
        params["language"] = language
    else:
        params["detect_language"] = "true"

    # Detect content type from filename. All extensions admitted by
    # ALLOWED_AUDIO_EXTS in main.py must be mapped here; anything not
    # in the explicit table falls through to mimetypes.guess_type and
    # finally to application/octet-stream (Deepgram accepts it for
    # every common codec). The old "audio/wav" default caused silent
    # 400s when an AAC or MP4 upload was mislabelled as WAV.
    # Extension-less filenames (common for browser-downloaded files that
    # lost their suffix) previously defaulted to "audio/wav" which
    # triggered silent 400s when the body was actually webm/m4a. Default
    # to application/octet-stream — Deepgram sniffs the container bytes
    # and accepts any common codec that way.
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mime_map = {
        "wav": "audio/wav",
        "mp3": "audio/mpeg",
        "ogg": "audio/ogg",
        "oga": "audio/ogg",
        "opus": "audio/ogg",  # Opus in Ogg container
        "webm": "audio/webm",
        "flac": "audio/flac",
        "m4a": "audio/mp4",
        "mp4": "audio/mp4",
        "aac": "audio/aac",
    }
    content_type = (
        mime_map.get(ext)
        or (mimetypes.guess_type(filename)[0] if ext else None)
        or "application/octet-stream"
    )

    headers = {
        "Authorization": f"Token {api_key}",
        "Content-Type": content_type,
    }

    logger.info("deepgram_transcribe: model=%s, audio=%d bytes", model, len(audio_bytes))
    # Adaptive timeout for large-file uploads.
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
    # Formula: ``read = max(180, body_mb * 8)`` seconds.
    #   * 180 s floor covers small files even on a tarpit-slow link.
    #   * 8 s/MB ceiling covers ~1 Mbit/s sustained upload (typical
    #     mobile-tethered minimum) plus headroom for Deepgram's own
    #     processing time after the body is fully received.
    # Connect stays at 10 s — DNS + TLS handshake is independent of body size.
    body_mb = max(1.0, len(audio_bytes) / (1024 * 1024))
    read_timeout = max(180, int(body_mb * 8))
    # Retries scaled inversely to body size: small files keep the 3-attempt
    # transient-recovery behaviour, large uploads attempt twice. Three full
    # retries of a 50 MB body waste 150 MB on a network that's already
    # struggling — the second attempt is the diagnostic value, beyond that
    # is bandwidth waste.
    upload_retries = 3 if body_mb < 5 else 2
    r = request_with_retry(
        "POST", url,
        headers=headers,
        params=params,
        data=audio_bytes,
        timeout=(10, read_timeout),
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
        # Try paragraphs first (structured paragraph output)
        paragraphs_obj = channel.get("alternatives", [{}])[0].get("paragraphs")
        if paragraphs_obj and isinstance(paragraphs_obj, dict):
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
            alternatives = channel.get("alternatives", [])
            if alternatives:
                text = alternatives[0].get("transcript", "")
    except (KeyError, IndexError):
        pass

    logger.info("deepgram_transcribe: success, %d chars", len(text))
    return {
        "text": str(text).strip(),
        "raw": result,
    }
