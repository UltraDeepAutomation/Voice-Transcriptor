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
    # ``timeout=(connect, read)`` tuple. ``10`` for connect: matches the
    # live-WS handshake budget (``remote_deepgram_live.connect`` uses 15s
    # with retry; REST has its own 3-attempt retry and shorter per-attempt
    # budgets keep total latency bounded). The prior 5s connect budget
    # fired false-positive timeouts on cold-DNS and mobile-tethered
    # uplinks — exactly the scenario the live-WS fix targeted. ``60``
    # for read: Deepgram REST returns quickly (<5s) for normal audio;
    # the 60s ceiling is only for pathologically long files or
    # upstream congestion.
    r = request_with_retry(
        "POST", url,
        headers=headers,
        params=params,
        data=audio_bytes,
        timeout=(10, 60),
        retries=3,
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
