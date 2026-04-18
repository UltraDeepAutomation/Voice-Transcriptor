"""Local Whisper transcription: audio array → segments + text.

Thread-safe model cache, empty-sequence error handling, stereo channel merge.
"""

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

# Per-model locks: loading model A must not serialise with loading
# model B. A global lock caused a first-time large-v3 request to block
# every concurrent transcription (even for already-loaded models) for
# the 10+ seconds of the large model load. Double-checked locking: fast
# path reads the cache dict directly (atomic under the GIL), slow path
# acquires a per-name lock to prevent duplicate loads of the SAME model.
_MODEL_LOCK = threading.Lock()  # Guards the name→lock registry.
_MODEL_NAME_LOCKS: Dict[str, threading.Lock] = {}
_MODEL_CACHE: Dict[str, WhisperModel] = {}
_MODEL_WARM_STATE: Dict[str, Dict[str, float]] = {}
_CPU_COUNT = max(1, os.cpu_count() or 1)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("invalid integer env %s=%r; using default=%d", name, raw, default)
        return default


_DEFAULT_CPU_THREADS = max(
    4,
    min(8, _env_int("TRANSCRIPTOR_WHISPER_CPU_THREADS", max(4, _CPU_COUNT // 2))),
)
_DEFAULT_NUM_WORKERS = max(
    1,
    min(3, _env_int("TRANSCRIPTOR_WHISPER_NUM_WORKERS", 2 if _CPU_COUNT >= 8 else 1)),
)


def _is_empty_sequence_transcribe_error(exc: Exception) -> bool:
    msg = str(exc or "").lower()
    return "empty sequence" in msg and "max()" in msg


def _empty_transcribe_result(duration: float = 0.0) -> Dict[str, Any]:
    return {
        "language": None,
        "language_probability": 0.0,
        "duration": float(duration or 0.0),
        "segments": [],
        "text": "",
    }


def _model(model_name: str) -> WhisperModel:
    # CPU default tuned for typical laptops.
    # Fast path: hot cache hit with no lock held (dict reads are
    # atomic under the GIL). Prevents parallel users of model A from
    # blocking on a concurrent first-time load of model B.
    m = _MODEL_CACHE.get(model_name)
    if m is not None:
        return m
    # Per-name lock registry. The registry dict itself is guarded by
    # _MODEL_LOCK so two callers can't race to create the per-name lock.
    with _MODEL_LOCK:
        per_lock = _MODEL_NAME_LOCKS.setdefault(model_name, threading.Lock())
    # Slow path: serialise only duplicate loads of the SAME model.
    with per_lock:
        m = _MODEL_CACHE.get(model_name)
        if m is not None:
            return m
        started = time.perf_counter()
        m = WhisperModel(
            model_name,
            device="cpu",
            compute_type="int8",
            cpu_threads=_DEFAULT_CPU_THREADS,
            num_workers=_DEFAULT_NUM_WORKERS,
        )
        _MODEL_CACHE[model_name] = m
        logger.info(
            "whisper model loaded: model=%s cpu_threads=%d num_workers=%d load_ms=%d",
            model_name,
            _DEFAULT_CPU_THREADS,
            _DEFAULT_NUM_WORKERS,
            int((time.perf_counter() - started) * 1000),
        )
        return m


def warm_model(model_name: str, probe: bool = False) -> Dict[str, float]:
    started = time.perf_counter()
    _model(model_name)
    load_ms = int((time.perf_counter() - started) * 1000)
    probe_ms = 0
    if probe:
        probe_started = time.perf_counter()
        try:
            transcribe_audio(
                np.zeros((16000,), dtype=np.float32),
                model_name,
                language=None,
                vad_filter=True,
                word_timestamps=False,
                beam_size=1,
                best_of=1,
            )
        except Exception:
            logger.exception("whisper warm probe failed: model=%s", model_name)
        probe_ms = int((time.perf_counter() - probe_started) * 1000)
    state = {
        "loaded_ms": float(load_ms),
        "probe_ms": float(probe_ms),
        "warmed_at": float(time.time()),
    }
    with _MODEL_LOCK:
        _MODEL_WARM_STATE[model_name] = state
    return state


def warm_state(model_name: str) -> Dict[str, float]:
    with _MODEL_LOCK:
        return dict(_MODEL_WARM_STATE.get(model_name) or {})


def _build_result(
    segments,
    info,
    word_timestamps: bool,
) -> Dict[str, Any]:
    """Convert faster-whisper segment iterator + info into a result dict.

    Shared by both transcribe_audio and transcribe_file to avoid duplication.
    """
    out_segments: List[Dict[str, Any]] = []
    text_parts: List[str] = []
    for s in segments:
        seg: Dict[str, Any] = {
            "start": float(s.start),
            "end": float(s.end),
            "text": (s.text or "").strip(),
        }
        words = getattr(s, "words", None)
        if word_timestamps and words:
            seg["words"] = [
                {
                    "start": float(w.start),
                    "end": float(w.end),
                    "word": w.word,
                    "prob": float(w.probability) if w.probability is not None else None,
                }
                for w in words
            ]
        out_segments.append(seg)
        if seg["text"]:
            text_parts.append(seg["text"])

    return {
        "language": getattr(info, "language", None),
        "language_probability": float(
            getattr(info, "language_probability", 0.0) or 0.0
        ),
        "duration": float(getattr(info, "duration", 0.0) or 0.0),
        "segments": out_segments,
        "text": " ".join(text_parts).strip(),
    }


def transcribe_audio(
    audio_16k_mono: np.ndarray,
    model_name: str,
    language: Optional[str] = None,
    vad_filter: bool = True,
    word_timestamps: bool = False,
    beam_size: int = 1,
    best_of: int = 1,
) -> Dict[str, Any]:
    """Transcribe 16kHz mono audio (float32 numpy array)."""

    if audio_16k_mono is None:
        raise ValueError("audio_16k_mono is required")

    # Accept either (n,) or (n,1)
    if audio_16k_mono.ndim == 2 and audio_16k_mono.shape[1] == 1:
        audio_16k_mono = audio_16k_mono[:, 0]

    model = _model(model_name)
    try:
        segments, info = model.transcribe(
            audio_16k_mono,
            language=language or None,
            vad_filter=vad_filter,
            word_timestamps=word_timestamps,
            beam_size=beam_size,
            best_of=best_of,
        )
    except Exception as e:
        if _is_empty_sequence_transcribe_error(e):
            duration = float(audio_16k_mono.shape[0]) / 16000.0 if audio_16k_mono is not None else 0.0
            return _empty_transcribe_result(duration)
        raise

    return _build_result(segments, info, word_timestamps)


def transcribe_file(
    path_wav_16k_mono: str,
    model_name: str,
    language: Optional[str] = None,
    vad_filter: bool = True,
    word_timestamps: bool = False,
    beam_size: int = 1,
    best_of: int = 1,
) -> Dict[str, Any]:
    if not os.path.exists(path_wav_16k_mono):
        raise FileNotFoundError(path_wav_16k_mono)

    model = _model(model_name)
    if os.path.getsize(path_wav_16k_mono) <= 64:
        return _empty_transcribe_result(0.0)
    try:
        segments, info = model.transcribe(
            path_wav_16k_mono,
            language=language or None,
            vad_filter=vad_filter,
            word_timestamps=word_timestamps,
            beam_size=beam_size,
            best_of=best_of,
        )
    except Exception as e:
        if _is_empty_sequence_transcribe_error(e):
            return _empty_transcribe_result(0.0)
        raise

    return _build_result(segments, info, word_timestamps)


def merge_channel_transcripts(t1: Dict[str, Any], t2: Dict[str, Any]) -> Dict[str, Any]:
    merged = []
    for seg in t1.get("segments", []):
        merged.append({**seg, "speaker": "A"})
    for seg in t2.get("segments", []):
        merged.append({**seg, "speaker": "B"})
    merged.sort(key=lambda s: (s.get("start", 0.0), s.get("speaker", "")))
    text = []
    for s in merged:
        t = (s.get("text") or "").strip()
        if t:
            text.append(f"{s.get('speaker', '?')}: {t}")
    # Preserve the full result-dict shape so callers can rely on
    # ``duration`` and ``language_probability`` being present whether
    # the file was mono or stereo. The mono path (via _build_result)
    # already sets both keys; stereo merge must match to prevent
    # caller-side KeyError / None fallthroughs for duration-based
    # telemetry and auto-detect confidence.
    return {
        "language": t1.get("language") or t2.get("language"),
        "language_probability": max(
            float(t1.get("language_probability") or 0.0),
            float(t2.get("language_probability") or 0.0),
        ),
        "duration": max(
            float(t1.get("duration") or 0.0),
            float(t2.get("duration") or 0.0),
        ),
        "channel_mode": "stereo_split",
        "segments": merged,
        "text": "\n".join(text).strip(),
    }
