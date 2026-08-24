"""Sber GigaAM-v3 ASR engine — Russian-only local transcription.

Why an adapter: ``transcribe_audio`` is the SSOT entry point used by
file jobs, live assist and recovery paths. Faster-whisper stays the
default engine; models whose id starts with the catalog prefix
``gigaam-`` dispatch here.

Contract with upstream (github.com/salute-developers/GigaAM):
* ``gigaam.load_model("<v3_e2e_rnnt|v3_rnnt>")`` — weights download on
  first use into the package's own cache;
* ``model.transcribe(path, word_timestamps=True)`` accepts **≤25 s** of
  audio — anything longer is sliced here into sequential chunks and
  stitched back by absolute time;
* results expose ``.text`` and, with timestamps, ``.words[i].start/end/
  text`` — mapped onto the same segment/word shape faster-whisper
  produces so every downstream consumer (live trim, coverage math,
  frontend merge) works unchanged.

The engine is Russian-only: the language parameter is accepted for
signature compatibility and pinned to ru semantics upstream.
"""

from __future__ import annotations

import logging
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
import soundfile as sf

logger = logging.getLogger(__name__)

# Upstream hard limit is 25 s; stay clear of it so encoder padding and
# rounding never push a request past the boundary.
GIGAAM_MAX_CHUNK_SEC = 20.0

_MODEL_CACHE: Dict[str, Any] = {}
_MODEL_LOCK = threading.Lock()

_LAST_LOAD_ERROR: Optional[str] = None


def gigaam_import_error() -> Optional[str]:
    """Return why the engine is unavailable, or None when usable."""
    global _LAST_LOAD_ERROR
    try:
        import gigaam  # noqa: F401
        return None
    except Exception as e:  # pragma: no cover - environment-dependent
        _LAST_LOAD_ERROR = f"{type(e).__name__}: {e}"
        return _LAST_LOAD_ERROR


def _load_model(model_id: str) -> Any:
    with _MODEL_LOCK:
        model = _MODEL_CACHE.get(model_id)
        if model is not None:
            return model
        import gigaam

        upstream_name = model_id.removeprefix("gigaam-").replace("-", "_")
        logger.info("gigaam: loading %s (upstream name %s)", model_id, upstream_name)
        model = gigaam.load_model(upstream_name)
        _MODEL_CACHE[model_id] = model
        return model


def _write_wav(audio_16k_mono: np.ndarray) -> Path:
    handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    handle.close()
    path = Path(handle.name)
    sf.write(str(path), np.asarray(audio_16k_mono, dtype=np.float32), 16000,
             subtype="PCM_16")
    return path


def _chunk_bounds(total_sec: float) -> list[tuple[float, float]]:
    if total_sec <= GIGAAM_MAX_CHUNK_SEC:
        return [(0.0, total_sec)]
    bounds: list[tuple[float, float]] = []
    t = 0.0
    while t < total_sec - 1e-6:
        end = min(t + GIGAAM_MAX_CHUNK_SEC, total_sec)
        bounds.append((t, end))
        t = end
    return bounds


def _words_from_result(result: Any, offset: float) -> list[dict]:
    words = getattr(result, "words", None)
    if not words:
        return []
    out: list[dict] = []
    for w in words:
        try:
            w_start = float(w.start) + offset
            w_end = float(w.end) + offset
            text = str(getattr(w, "text", "") or "").strip()
        except Exception:
            continue
        if not text or w_end <= w_start:
            continue
        out.append({"word": text, "start": round(w_start, 3), "end": round(w_end, 3)})
    return out


def transcribe_gigaam(
    audio_16k_mono: np.ndarray,
    model_id: str,
    word_timestamps: bool = True,
) -> Dict[str, Any]:
    """Transcribe 16 kHz mono float32 PCM with a GigaAM-v3 model.

    Return shape matches :func:`backend.transcribe.transcribe_audio`
    (segments with absolute times; ``words`` when requested) so callers
    need no engine branching beyond dispatch.
    """
    if audio_16k_mono.ndim == 2 and audio_16k_mono.shape[1] == 1:
        audio_16k_mono = audio_16k_mono[:, 0]
    audio = np.ascontiguousarray(audio_16k_mono, dtype=np.float32)
    total_sec = len(audio) / 16000.0
    if total_sec <= 0:
        return {"segments": [], "language": "ru", "duration": 0.0}

    model = _load_model(model_id)
    segments: list[dict[str, Any]] = []
    wav_path = _write_wav(audio)
    try:
        for start, end in _chunk_bounds(total_sec):
            lo = int(start * 16000)
            hi = int(end * 16000)
            chunk_path = _write_wav(audio[lo:hi])
            try:
                result = model.transcribe(str(chunk_path), word_timestamps=True)
            finally:
                try:
                    chunk_path.unlink(missing_ok=True)
                except OSError:
                    pass
            text = str(getattr(result, "text", "") or "").strip()
            seg_words = _words_from_result(result, offset=start) if word_timestamps else []
            if not text and not seg_words:
                continue
            seg_start = start
            if seg_words:
                seg_start = min(seg_start, seg_words[0]["start"])
                seg_end = max(end, seg_words[-1]["end"])
            else:
                seg_end = end
            segments.append({
                "start": round(seg_start, 3),
                "end": round(min(seg_end, total_sec), 3),
                "text": text,
                **({"words": seg_words} if seg_words else {}),
            })
    finally:
        try:
            wav_path.unlink(missing_ok=True)
        except OSError:
            pass

    return {"segments": segments, "language": "ru", "duration": round(total_sec, 3)}
