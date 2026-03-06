"""Groq Whisper API — ultra-fast transcription (299× realtime).

Uses the OpenAI-compatible /v1/audio/transcriptions endpoint with
direct file upload (multipart/form-data). No base64 encoding overhead.

Groq's LPU hardware transcribes 10 minutes of audio in ~2 seconds.
"""

import time
from typing import Any, Dict, Optional

import requests
from requests import RequestException


class RemoteError(RuntimeError):
    pass


GroqRemoteError = RemoteError

# Groq supports whisper-large-v3 and distil-whisper-large-v3-en
GROQ_MODELS = [
    "whisper-large-v3",
    "distil-whisper-large-v3-en",
    "whisper-large-v3-turbo",
]

GROQ_API_BASE = "https://api.groq.com/openai/v1"


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


def groq_transcribe(
    *,
    api_key: str,
    audio_bytes: bytes,
    filename: str,
    model: str = "whisper-large-v3-turbo",
    language: Optional[str] = None,
    response_format: str = "json",
) -> Dict[str, Any]:
    """Transcribe audio using Groq's Whisper API.
    
    Returns {"text": str, "raw": dict}.
    """
    if not api_key:
        raise RemoteError("Groq API key is not configured")

    url = f"{GROQ_API_BASE}/audio/transcriptions"
    headers = {"Authorization": f"Bearer {api_key}"}

    # Detect MIME type from filename
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "wav"
    mime_map = {
        "wav": "audio/wav",
        "mp3": "audio/mpeg",
        "ogg": "audio/ogg",
        "webm": "audio/webm",
        "flac": "audio/flac",
        "m4a": "audio/mp4",
    }
    mime = mime_map.get(ext, "audio/wav")

    files = {"file": (filename, audio_bytes, mime)}
    data: Dict[str, Any] = {
        "model": model,
        "response_format": response_format,
    }
    if language and language != "auto":
        data["language"] = language

    r = _request_with_retry(
        "POST", url, headers=headers, files=files, data=data, timeout=60
    )

    if r.status_code >= 400:
        error_text = r.text[:400]
        raise RemoteError(f"Groq API error (HTTP {r.status_code}): {error_text}")

    try:
        result = r.json()
    except Exception:
        raise RemoteError(f"Groq: invalid JSON response: {r.text[:300]}")

    text = result.get("text", "")
    return {
        "text": str(text).strip(),
        "raw": result,
    }
