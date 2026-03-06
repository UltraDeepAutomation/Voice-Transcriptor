import os
import threading
from typing import Any, Dict, List, Optional

import numpy as np
from faster_whisper import WhisperModel


_MODEL_LOCK = threading.Lock()
_MODEL_CACHE: Dict[str, WhisperModel] = {}


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
    with _MODEL_LOCK:
        m = _MODEL_CACHE.get(model_name)
        if m is None:
            m = WhisperModel(model_name, device="cpu", compute_type="int8")
            _MODEL_CACHE[model_name] = m
        return m


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
    return {
        "language": t1.get("language") or t2.get("language"),
        "channel_mode": "stereo_split",
        "segments": merged,
        "text": "\n".join(text).strip(),
    }
