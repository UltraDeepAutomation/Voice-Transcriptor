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
            time.sleep(0.8 * (attempt + 1))
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
                        "text": "Transcribe this audio. If possible, label speakers as Speaker 1/2/etc.",
                    },
                    {
                        "type": "input_audio",
                        "input_audio": {"data": _b64(audio_bytes), "format": fmt},
                    },
                ],
            }
        ],
        "stream": False,
    }

    r = _request_with_retry("POST", url, headers=headers, json=payload, timeout=180)
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
