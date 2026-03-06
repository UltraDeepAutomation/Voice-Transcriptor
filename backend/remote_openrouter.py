import base64
import mimetypes
import time
from typing import Any, Dict

import requests
from requests import RequestException


class RemoteError(RuntimeError):
    pass


def _request_with_retry(method: str, url: str, retries: int = 3, **kwargs):
    last_err = None
    for attempt in range(retries):
        try:
            return requests.request(method, url, **kwargs)
        except RequestException as e:
            last_err = e
            if attempt == retries - 1:
                break
            # First retry is fast (0.3s), subsequent retries use longer backoff.
            time.sleep(0.3 if attempt == 0 else 0.8 * attempt)
    raise RemoteError(f"network error: {last_err}")


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def openrouter_transcribe(
    *, api_key: str, model: str, audio_bytes: bytes, filename: str
) -> Dict[str, Any]:
    """Best-effort transcription via OpenRouter audio inputs.

    OpenRouter routes to a multimodal model; output is plain text. Diarization depends on the model.
    """

    key = (api_key or "").strip()
    if not key:
        raise RemoteError("OpenRouter key is not configured")

    mt, _ = mimetypes.guess_type(filename or "")
    fmt = (mt or "audio/wav").split("/")[-1]

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload: Dict[str, Any] = {
        "model": model or "google/gemini-2.5-flash",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        # Keep prompt minimal for lower latency and avoid extra formatting work.
                        "text": "Transcribe audio exactly. Return only transcript text.",
                    },
                    {
                        "type": "input_audio",
                        "input_audio": {"data": _b64(audio_bytes), "format": fmt},
                    },
                ],
            }
        ],
        "stream": False,
        "temperature": 0.0,
    }

    r = _request_with_retry("POST", url, headers=headers, json=payload, timeout=60)
    if r.status_code >= 400:
        error_text = r.text[:400]
        if "input_audio" in error_text.lower() or "image" in error_text.lower():
            raise RemoteError(
                f"Model '{model}' does not support audio input. Please use a model that supports audio, such as: google/gemini-2.5-flash, openai/gpt-4o-audio-preview, or anthropic/claude-3-opus-20240229"
            )
        raise RemoteError(f"openrouter failed: HTTP {r.status_code} {error_text}")
    js = r.json()

    text = ""
    try:
        text = js["choices"][0]["message"]["content"]
    except Exception:
        text = str(js)
    return {"text": text, "raw": js}


def openrouter_upscale_text(
    *, api_key: str, model: str, text: str, instruction: str
) -> Dict[str, Any]:
    key = (api_key or "").strip()
    if not key:
        raise RemoteError("OpenRouter key is not configured")

    source_text = (text or "").strip()
    if not source_text:
        raise RemoteError("empty text for upscale")

    url = "https://openrouter.ai/api/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload: Dict[str, Any] = {
        "model": model or "google/gemini-2.5-flash",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You improve transcript text quality. Preserve meaning and language. "
                    "Return only final polished text without explanations."
                ),
            },
            {
                "role": "user",
                "content": f"{instruction}\n\nText:\n{source_text}",
            },
        ],
        "temperature": 0.15,
        "stream": False,
    }
    r = _request_with_retry("POST", url, headers=headers, json=payload, timeout=120)
    if r.status_code >= 400:
        raise RemoteError(f"openrouter upscale failed: HTTP {r.status_code} {r.text[:400]}")
    js = r.json()

    out_text = ""
    try:
        out_text = (js["choices"][0]["message"]["content"] or "").strip()
    except Exception:
        out_text = ""
    if not out_text:
        raise RemoteError("openrouter upscale returned empty text")
    return {"text": out_text, "raw": js}
