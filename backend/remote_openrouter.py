"""OpenRouter — multimodal transcription & text upscaling.

Uses the chat completions endpoint with audio inputs for transcription,
and standard text completions for upscale/post-processing.
"""

import base64
import logging
import mimetypes
from typing import Any, Dict

from backend.http_retry import RemoteError, request_with_retry

logger = logging.getLogger(__name__)


class OpenRouterError(RemoteError):
    """OpenRouter-specific remote failure.

    Subclass of the generic ``RemoteError`` so callers can either:
      * catch ``OpenRouterError`` specifically (retry, fall back to
        local Whisper, pick a different OpenRouter model), or
      * catch ``RemoteError`` to handle any provider failure uniformly.

    Prior to this subclass, ``main.py`` imported the base ``RemoteError``
    under the alias ``OrRemoteError`` and pretended it was a distinct
    type — catching ``(OrRemoteError, DgRemoteError)`` was just
    catching ``RemoteError`` twice with no provider discrimination.
    """


# Re-export under the legacy name so any downstream import that used
# ``from backend.remote_openrouter import RemoteError`` keeps working.
# New code should import ``OpenRouterError`` directly.
RemoteError = OpenRouterError  # type: ignore[misc]


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def openrouter_transcribe(
    *, api_key: str, model: str, audio_bytes: bytes, filename: str
) -> Dict[str, Any]:
    """Best-effort transcription via OpenRouter audio inputs.

    OpenRouter routes to a multimodal model; output is plain text.
    Diarization depends on the model.
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

    logger.info("openrouter_transcribe: model=%s, audio=%d bytes", model, len(audio_bytes))
    # Adaptive timeout matching remote_deepgram.py — the OpenRouter audio
    # path base64-encodes the audio bytes inline in the JSON body, so the
    # uploaded payload is ~1.33× the raw audio size. ``requests`` applies
    # the read-timeout to the whole socket including the write/upload
    # phase, so a large audio body on a slow link trips the timeout
    # mid-upload. Same formula as the Deepgram path: 180 s floor + 8 s
    # per encoded MB (rounded up to account for base64 inflation).
    encoded_mb = max(1.0, (len(audio_bytes) * 1.34) / (1024 * 1024))
    read_timeout = max(180, int(encoded_mb * 8))
    r = request_with_retry(
        "POST", url, headers=headers, json=payload, timeout=(10, read_timeout),
    )

    if r.status_code >= 400:
        error_text = r.text[:400]
        if "input_audio" in error_text.lower() or "image" in error_text.lower():
            raise RemoteError(
                f"Model '{model}' does not support audio input. Please use a model that supports audio, "
                f"such as: google/gemini-2.5-flash, openai/gpt-4o-audio-preview"
            )
        raise RemoteError(f"openrouter failed: HTTP {r.status_code} {error_text}")

    js = r.json()
    text = ""
    try:
        text = js["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as shape_err:
        # OpenRouter changed the response shape (or echoed an empty
        # error envelope). Returning ``str(js)`` made the entire raw
        # API response — potentially echoing the user's prompt and
        # the audio's base64 payload — visible to the caller as if
        # it were the transcribed text. Far better to surface the
        # shape mismatch as a RemoteError so the route handler maps
        # it to a 502 with a sane message and the renderer falls
        # back to local Whisper.
        raise RemoteError(
            f"OpenRouter response shape unexpected: {type(shape_err).__name__}"
        ) from shape_err

    logger.info("openrouter_transcribe: success, %d chars", len(text))
    return {"text": text, "raw": js}


def openrouter_upscale_text(
    *, api_key: str, model: str, text: str, instruction: str
) -> Dict[str, Any]:
    """Upscale/improve transcript text via OpenRouter chat completion."""
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

    logger.info("openrouter_upscale: model=%s, text=%d chars", model, len(source_text))
    # Same (connect, read) split as openrouter_transcribe. Upscale can
    # be slower than transcribe (large Gemini generations), so read budget
    # is 120s. Connect budget stays at 10s — DNS path is identical.
    r = request_with_retry("POST", url, headers=headers, json=payload, timeout=(10, 120))

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

    logger.info("openrouter_upscale: success, %d chars", len(out_text))
    return {"text": out_text, "raw": js}
