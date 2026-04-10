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
        timeout=(5, 30),
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
