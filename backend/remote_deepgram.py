"""Deepgram Nova-3 — ultra-fast transcription (~300ms latency).

Uses the pre-recorded REST endpoint:
  POST https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true

Accepts raw audio bytes (WAV/MP3/etc.) as the request body.
Deepgram bills per second — ideal for chunked processing.
"""

import time
from typing import Any, Dict, Optional

import requests
from requests import RequestException


class RemoteError(RuntimeError):
    pass


DeepgramRemoteError = RemoteError

DEEPGRAM_API_BASE = "https://api.deepgram.com/v1"


def _request_with_retry(method: str, url: str, retries: int = 3, **kwargs):
    last_err = None
    for attempt in range(retries):
        try:
            return requests.request(method, url, **kwargs)
        except RequestException as e:
            last_err = e
            if attempt == retries - 1:
                break
            time.sleep(0.3 if attempt == 0 else 0.8 * attempt)
    raise RemoteError(f"network error: {last_err}")


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

    r = _request_with_retry(
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

    return {
        "text": str(text).strip(),
        "raw": result,
    }
