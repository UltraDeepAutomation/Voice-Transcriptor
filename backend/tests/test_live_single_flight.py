"""Single-flight guard for ``LiveSession.maybe_transcribe``.

Before the guard, a Stop-time forced flush could run CONCURRENTLY with a
periodic pass still inside its 60 s inference ceiling: two passes
transcribed overlapping windows and interleaved their emits, producing
duplicated or out-of-order tail text. Now a forced call awaits the
in-flight pass (then transcribes only the true remainder), and periodic
ticks during a pass are skipped.
"""

import asyncio
import threading
import unittest
from unittest import mock

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.live import LiveConfig, LiveSession


def _pcm_seconds(seconds: float) -> bytes:
    return b"\x01\x00" * int(seconds * LIVE_SAMPLE_RATE_HZ)


async def _feed(session: LiveSession, seconds: float) -> None:
    frame_bytes = 2048 * 2
    payload = _pcm_seconds(seconds)
    for offset in range(0, len(payload), frame_bytes):
        await session.append_pcm16le(payload[offset:offset + frame_bytes])


class LiveSingleFlightTests(unittest.IsolatedAsyncioTestCase):
    def _session(self) -> LiveSession:
        return LiveSession(
            model_name="tiny",
            language=None,
            config=LiveConfig(window_sec=8.0, overlap_sec=1.0, ring_slack_sec=10.0),
        )

    async def test_force_awaits_inflight_pass_no_concurrent_inference(self):
        session = self._session()
        await _feed(session, 3.0)

        state = {"active": 0, "max_active": 0}
        lock = threading.Lock()

        def fake_transcribe(audio, model, **kwargs):
            with lock:
                state["active"] += 1
                state["max_active"] = max(state["max_active"], state["active"])
            threading.Event().wait(0.15)  # slow inference, executor thread
            with lock:
                state["active"] -= 1
            return {"segments": [{"start": 0.0, "end": 2.5, "text": "привет"}]}

        with mock.patch("backend.live.transcribe_audio", side_effect=fake_transcribe):
            first = asyncio.create_task(session.maybe_transcribe())
            await asyncio.sleep(0.02)  # let the periodic pass enter inference
            # Speech continues while the first pass is in flight — this is
            # exactly the Stop-time situation the guard exists for.
            await _feed(session, 2.0)
            second = await session.maybe_transcribe(force=True)
            await first

        self.assertEqual(state["max_active"], 1, "two passes must never overlap")
        # The forced pass ran AFTER the first completed and saw fresh
        # uncovered audio, so it performed its own real transcription.
        self.assertIsNotNone(second)

    async def test_periodic_tick_during_inflight_is_skipped(self):
        session = self._session()
        await _feed(session, 3.0)

        calls = {"n": 0}

        def fake_transcribe(audio, model, **kwargs):
            calls["n"] += 1
            threading.Event().wait(0.12)
            return {"segments": []}

        with mock.patch("backend.live.transcribe_audio", side_effect=fake_transcribe):
            first = asyncio.create_task(session.maybe_transcribe())
            await asyncio.sleep(0.02)
            skipped = await session.maybe_transcribe()  # non-force tick
            await first

        self.assertIsNone(skipped)
        self.assertEqual(calls["n"], 1, "periodic tick must not stack a second pass")


if __name__ == "__main__":
    unittest.main()
