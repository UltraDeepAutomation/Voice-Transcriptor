"""Deepgram Nova-3 — ultra-fast transcription (~300ms latency).

Uses the pre-recorded REST endpoint:
  POST https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true

Accepts raw audio bytes (WAV/MP3/etc.) as the request body.
Deepgram bills per second — ideal for chunked processing.
"""

import logging
from typing import Any, Dict, Optional

from backend.http_retry import RemoteError, request_with_retry

logger = logging.getLogger(__name__)

# Re-export for backward compatibility
DeepgramRemoteError = RemoteError

DEEPGRAM_API_BASE = "https://api.deepgram.com/v1"


def deepgram_transcribe(
    *,
    api_key: str,
    audio_bytes: bytes,
    filename: str,
    model: str = "nova-3",
    language: Optional[str] = None,
    smart_format: bool = True,
) -> Dict[str, Any]:
    """Transcribe audio using Deepgram's pre-recorded API.

    Returns {"text": str, "raw": dict}.
    """
    if not api_key:
        raise RemoteError("Deepgram API key is not configured")

    url = f"{DEEPGRAM_API_BASE}/listen"

    # Build query params
    params: Dict[str, str] = {
        "model": model or "nova-3",
        "smart_format": "true" if smart_format else "false",
    }
    if language and language.lower() not in ("auto", ""):
        params["language"] = language
    else:
        params["detect_language"] = "true"

    # Detect content type from filename
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "wav"
    mime_map = {
        "wav": "audio/wav",
        "mp3": "audio/mpeg",
        "ogg": "audio/ogg",
        "webm": "audio/webm",
        "flac": "audio/flac",
        "m4a": "audio/mp4",
    }
    content_type = mime_map.get(ext, "audio/wav")

    headers = {
        "Authorization": f"Token {api_key}",
        "Content-Type": content_type,
    }

    logger.info("deepgram_transcribe: model=%s, audio=%d bytes", model, len(audio_bytes))
    r = request_with_retry(
        "POST", url,
        headers=headers,
        params=params,
        data=audio_bytes,
        timeout=60,
    )

    if r.status_code >= 400:
        error_text = r.text[:400]
        raise RemoteError(f"Deepgram API error (HTTP {r.status_code}): {error_text}")

    try:
        result = r.json()
    except Exception:
        raise RemoteError(f"Deepgram: invalid JSON response: {r.text[:300]}")

    # Extract text from Deepgram response structure
    text = ""
    try:
        alternatives = result["results"]["channels"][0]["alternatives"]
        if alternatives:
            text = alternatives[0].get("transcript", "")
    except (KeyError, IndexError):
        pass

    logger.info("deepgram_transcribe: success, %d chars", len(text))
    return {
        "text": str(text).strip(),
        "raw": result,
    }
