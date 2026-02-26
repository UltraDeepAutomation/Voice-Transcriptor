import asyncio
from dataclasses import dataclass
from collections import deque
from typing import Optional

import numpy as np

from backend.transcribe import transcribe_audio


@dataclass
class LiveConfig:
    sample_rate: int = 16000
    window_sec: float = 12.0
    overlap_sec: float = 1.0
    min_step_sec: float = 0.8
    min_audio_sec: float = 0.7
    emit_epsilon_sec: float = 0.05


class LiveSession:
    def __init__(
        self,
        model_name: str,
        language: Optional[str],
        config: Optional[LiveConfig] = None,
    ):
        self.model_name = model_name
        self.language = language
        self.cfg = config or LiveConfig()

        self._ring = deque()  # deque[np.ndarray]
        self._ring_samples = 0
        self._total_samples = 0
        self._lock = asyncio.Lock()
        self._last_transcribe_sec = 0.0
        self._last_emitted_end = 0.0

    def _get_last_samples(self, n: int) -> np.ndarray:
        if n <= 0 or self._ring_samples <= 0:
            return np.zeros((0,), dtype=np.float32)
        need = min(int(n), int(self._ring_samples))

        parts = []
        remaining = need
        for chunk in reversed(self._ring):
            if remaining <= 0:
                break
            if chunk.shape[0] <= remaining:
                parts.append(chunk)
                remaining -= int(chunk.shape[0])
            else:
                parts.append(chunk[-remaining:])
                remaining = 0
        if not parts:
            return np.zeros((0,), dtype=np.float32)
        parts.reverse()
        return np.concatenate(parts)

    async def append_pcm16le(self, chunk: bytes) -> None:
        if not chunk:
            return
        if len(chunk) % 2 != 0:
            chunk = chunk[: len(chunk) - 1]
        if not chunk:
            return

        pcm = np.frombuffer(chunk, dtype=np.int16)
        audio = (pcm.astype(np.float32) / 32768.0).clip(-1.0, 1.0)
        async with self._lock:
            self._ring.append(audio)
            self._ring_samples += int(audio.shape[0])
            self._total_samples += int(audio.shape[0])

            # Keep only a rolling buffer; global timing uses _total_samples.
            max_keep = int((self.cfg.window_sec + 10.0) * self.cfg.sample_rate)
            while self._ring and self._ring_samples > max_keep:
                dropped = self._ring.popleft()
                self._ring_samples -= int(dropped.shape[0])

    async def maybe_transcribe(self):
        sr = self.cfg.sample_rate

        async with self._lock:
            total_samples = int(self._total_samples)
            total_sec = total_samples / float(sr)
            if total_sec - self._last_transcribe_sec < self.cfg.min_step_sec:
                return None

            win = int(self.cfg.window_sec * sr)
            audio_window = self._get_last_samples(win)

            # Skip if no audio yet or audio too short
            if audio_window.shape[0] == 0:
                print("[live] no audio window yet, skipping transcribe")
                return None

            audio_duration = audio_window.shape[0] / float(sr)
            if audio_duration < self.cfg.min_audio_sec:
                print(
                    f"[live] audio too short ({audio_duration:.2f}s < {self.cfg.min_audio_sec}s), skipping transcribe"
                )
                return None

            offset_sec = (total_samples - int(audio_window.shape[0])) / float(sr)
            self._last_transcribe_sec = total_sec

        # Transcribe outside the lock (CPU heavy)
        try:
            print(
                f"[live] transcribing {audio_window.shape[0]} samples ({audio_window.shape[0] / sr:.2f}s)"
            )
            result = transcribe_audio(
                audio_window,
                self.model_name,
                language=self.language,
                vad_filter=True,
                word_timestamps=False,
                beam_size=1,
                best_of=1,
            )
            print(
                f"[live] transcribe result: {len(result.get('segments', []))} segments"
            )
        except Exception as e:
            print(f"[live] transcribe error: {e}")
            import traceback

            traceback.print_exc()
            return None

        new_segments = []
        for s in result.get("segments", []):
            g_end = offset_sec + float(s.get("end", 0.0) or 0.0)
            if g_end <= self._last_emitted_end + self.cfg.emit_epsilon_sec:
                continue
            g_start = offset_sec + float(s.get("start", 0.0) or 0.0)
            text = (s.get("text") or "").strip()
            if not text:
                continue
            new_segments.append({"start": g_start, "end": g_end, "text": text})
            self._last_emitted_end = max(self._last_emitted_end, g_end)

        if not new_segments:
            print("[live] no new segments to emit")
            return None
        print(f"[live] emitting {len(new_segments)} new segments")
        return {"type": "segments", "segments": new_segments}
