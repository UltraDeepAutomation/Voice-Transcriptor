"""Canonical audio/video upload Content-Type mapping.

Python's ``mimetypes.guess_type`` returns provider-hostile values for formats
we use heavily: ``.webm`` becomes ``video/webm`` even for audio-only Opus
containers, ``.opus`` becomes ``audio/ogg``, and ``.m4a`` may become the legacy
``audio/mp4a-latm``. Keep the explicit wire mapping in one module so recording
serving and remote provider uploads cannot drift.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path


AUDIO_EXT_TO_MIME: dict[str, str] = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".aac": "audio/aac",
    ".webm": "audio/webm",
    ".wma": "audio/x-ms-wma",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".3gp": "video/3gpp",
}


def audio_content_type(filename: str) -> str:
    """Return the canonical Content-Type for a supported upload filename."""
    ext = Path(filename or "").suffix.lower()
    if ext in AUDIO_EXT_TO_MIME:
        return AUDIO_EXT_TO_MIME[ext]
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"
