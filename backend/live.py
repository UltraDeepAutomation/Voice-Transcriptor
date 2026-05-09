import asyncio
import logging
from dataclasses import dataclass
from collections import deque
from typing import Optional

import numpy as np

from backend.transcribe import transcribe_audio

logger = logging.getLogger(__name__)

@dataclass
class LiveConfig:
    sample_rate: int = 16000
    window_sec: float = 8.0
    overlap_sec: float = 1.0
    min_step_sec: float = 1.0
    min_audio_sec: float = 0.7
    emit_epsilon_sec: float = 0.05


# Consecutive transcribe failures before we escalate to a fatal error.
# Single transient errors (audio glitch, model hiccup) should not kill
# the live session — but an unrecoverable failure (model unload, OOM,
# corrupted state) repeats forever, so we bound retries and surface
# a fatal event to the frontend.
_LIVE_MAX_CONSECUTIVE_ERRORS = 3


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
        self._consecutive_errors = 0
        self._last_error_signature: Optional[str] = None
        # 1.1.25: accumulator of every emitted segment so the
        # ``finalize_envelope`` method below can return the full
        # transcript at session end. Without this, the WS handler's
        # "final" envelope was always empty even when the local
        # pipeline produced N segments — frontend then mis-classified
        # the session as "no text" and triggered an unnecessary
        # recovery REST round-trip.
        self._emitted_segments: list[dict] = []

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
                logger.debug("no audio window yet, skipping transcribe")
                return None

            audio_duration = audio_window.shape[0] / float(sr)
            if audio_duration < self.cfg.min_audio_sec:
                logger.debug(
                    "audio too short (%.2fs < %.2fs), skipping transcribe",
                    audio_duration, self.cfg.min_audio_sec,
                )
                return None

            offset_sec = (total_samples - int(audio_window.shape[0])) / float(sr)
            self._last_transcribe_sec = total_sec

        # Transcribe outside the lock — offload CPU-heavy inference to thread pool
        # so the event loop stays responsive for WS I/O.
        try:
            logger.info(
                "transcribing %d samples (%.2fs)",
                audio_window.shape[0], audio_window.shape[0] / sr,
            )
            loop = asyncio.get_running_loop()
            # Wrap in `asyncio.wait_for` with a hard 60 s ceiling. A wedged
            # Whisper worker (CUDA OOM hang, ctranslate2 deadlock on a
            # corrupt model file, stalled disk IO during first-load of a
            # new model) would otherwise block this coroutine forever,
            # which in turn freezes the WS forwarder loop in main.py that
            # invokes `maybe_transcribe` in a tight cycle — the user would
            # see an alive socket with NO further transcription output
            # and no error event to recover from. 60 s is ~12× a realistic
            # CPU inference of a 30 s window on small; a genuinely slow
            # machine (old Mac Intel on large-v3) stays well under budget.
            #
            # Note on cancellation semantics: `wait_for` cancels the
            # FUTURE, but threads in the default executor cannot be
            # forcibly interrupted in Python — the worker thread keeps
            # running until the native call returns. The coroutine here
            # returns an error envelope immediately regardless, so the
            # WS session can escalate via `_consecutive_errors` instead
            # of hanging. Leaked worker thread is acceptable on the
            # already-unrecoverable CUDA-hang path.
            result = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: transcribe_audio(
                        audio_window,
                        self.model_name,
                        language=self.language,
                        vad_filter=True,
                        word_timestamps=False,
                        beam_size=1,
                        best_of=1,
                    ),
                ),
                timeout=60.0,
            )
            logger.info(
                "transcribe result: %d segments",
                len(result.get('segments', [])),
            )
        except asyncio.TimeoutError:
            # Surface as a typed error; same escalation as other
            # transcribe failures (bounded retries before fatal).
            self._consecutive_errors += 1
            signature = "LocalTranscribeTimeout: inference exceeded 60 s"
            self._last_error_signature = signature
            logger.error(
                "transcribe timeout (%d/%d consecutive)",
                self._consecutive_errors,
                _LIVE_MAX_CONSECUTIVE_ERRORS,
            )
            fatal = self._consecutive_errors >= _LIVE_MAX_CONSECUTIVE_ERRORS
            return {
                "type": "error",
                "error": signature,
                "fatal": bool(fatal),
            }
        except Exception as e:
            # Typed error envelope — bounded retries before escalating.
            # The transcriber loop in main.py forwards this to the frontend
            # via `_ws_send_json`, so the user sees what went wrong rather
            # than watching a silent dead session.
            self._consecutive_errors += 1
            signature = f"{type(e).__name__}: {e}"
            self._last_error_signature = signature
            logger.error(
                "transcribe error (%d/%d consecutive): %s",
                self._consecutive_errors,
                _LIVE_MAX_CONSECUTIVE_ERRORS,
                signature,
                exc_info=True,
            )
            fatal = self._consecutive_errors >= _LIVE_MAX_CONSECUTIVE_ERRORS
            return {
                "type": "error",
                "error": signature,
                "fatal": bool(fatal),
            }

        # Reset on any successful inference pass — transient hiccups
        # should not count against us forever.
        self._consecutive_errors = 0
        self._last_error_signature = None

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
            logger.debug("no new segments to emit")
            return None
        logger.info("emitting %d new segments", len(new_segments))
        # 1.1.25: keep an internal cumulative copy so
        # ``finalize_envelope`` can return the full transcript at end.
        self._emitted_segments.extend(new_segments)
        return {"type": "segments", "segments": new_segments}

    def finalize_envelope(self) -> dict:
        """Return the canonical end-of-session payload for this LiveSession.

        Joins every previously-emitted segment into a single transcript
        and reports the duration as the latest segment's end-time. Used
        by ``_run_local_live_session`` to fill the ``"final"`` WebSocket
        message — the frontend treats an empty final envelope as a
        signal to fall back to recovery.
        """
        segments = list(self._emitted_segments)
        text = " ".join(
            (s.get("text") or "").strip() for s in segments if s.get("text")
        ).strip()
        duration_sec = max(
            (float(s.get("end") or 0.0) for s in segments),
            default=0.0,
        )
        return {
            "text": text,
            "segments": segments,
            "duration_sec": round(duration_sec, 3),
        }
