"""Regression tests for live-stream audio coverage and event ordering.

Both bugs covered here manifested to the user as lost words:

  * ``LiveSession`` sized every window from the CURRENT tail of the ring
    buffer, so a single slow inference pass left the audio recorded
    meanwhile untranscribed, and the forced final flush keyed off the
    wrong watermark and skipped the trailing clause.

  * ``DeepgramLiveSession._enqueue_event`` re-queued head items behind
    the queue's remaining tail when evicting an interim under
    back-pressure, silently reordering committed segments.
"""

import asyncio
import unittest
from unittest import mock

from backend.audio_constants import LIVE_SAMPLE_RATE_HZ
from backend.live import LiveConfig, LiveSession
from backend.remote_deepgram_live import DeepgramLiveSession


def _pcm_seconds(seconds: float) -> bytes:
    return b"\x01\x00" * int(seconds * LIVE_SAMPLE_RATE_HZ)


async def _feed(session: LiveSession, seconds: float) -> None:
    """Append audio the way the WebSocket receiver does — in small
    frames rather than one giant chunk, so ring-eviction behaviour under
    test matches production."""
    frame_bytes = 2048 * 2
    payload = _pcm_seconds(seconds)
    for offset in range(0, len(payload), frame_bytes):
        await session.append_pcm16le(payload[offset:offset + frame_bytes])


class LiveWindowCoverageTests(unittest.TestCase):
    def _session(self) -> LiveSession:
        return LiveSession(
            model_name="tiny",
            language=None,
            config=LiveConfig(window_sec=8.0, overlap_sec=1.0, ring_slack_sec=10.0),
        )

    def test_window_reaches_back_past_window_sec_after_a_slow_pass(self):
        """A pass slower than window_sec must not leave an audio hole.

        Simulates: 20 s of audio arrives while the previous inference is
        still running. The next window has to cover from the last
        covered point (0 s) forward, not just the trailing 8 s.
        """
        session = self._session()
        captured = {}

        def fake_transcribe(audio, *_args, **_kwargs):
            captured["samples"] = int(audio.shape[0])
            return {"segments": []}

        async def run():
            await _feed(session, 20.0)
            with mock.patch("backend.live.transcribe_audio", fake_transcribe):
                await session.maybe_transcribe()

        asyncio.run(run())

        window_sec = captured["samples"] / float(LIVE_SAMPLE_RATE_HZ)
        # Ring holds window_sec + ring_slack_sec (18 s); the usable
        # ceiling is one second below that.
        self.assertGreater(
            window_sec,
            8.0,
            "window must exceed the nominal window_sec to catch up after a slow pass",
        )
        self.assertAlmostEqual(window_sec, 17.0, delta=0.5)

    def test_forced_final_flush_runs_after_a_periodic_pass(self):
        """The tail spoken just before Stop must still be transcribed.

        The forced flush previously compared against the watermark set
        when a pass STARTED, so once a periodic pass had begun the final
        flush short-circuited and the trailing words were dropped.
        """
        session = self._session()
        calls = []

        def fake_transcribe(audio, *_args, **_kwargs):
            calls.append(int(audio.shape[0]))
            return {"segments": []}

        async def run():
            with mock.patch("backend.live.transcribe_audio", fake_transcribe):
                await _feed(session, 2.0)
                await session.maybe_transcribe()
                # Trailing clause arrives after the periodic pass.
                await _feed(session, 1.5)
                return await session.maybe_transcribe(force=True)

        asyncio.run(run())

        self.assertEqual(len(calls), 2, "forced flush must run a second pass for the tail")

    def test_forced_flush_is_a_noop_when_everything_is_covered(self):
        session = self._session()

        def fake_transcribe(_audio, *_args, **_kwargs):
            return {"segments": []}

        async def run():
            with mock.patch("backend.live.transcribe_audio", fake_transcribe):
                await _feed(session, 2.0)
                await session.maybe_transcribe()
                return await session.maybe_transcribe(force=True)

        self.assertIsNone(asyncio.run(run()))

    def test_failed_pass_does_not_advance_coverage(self):
        """Audio fed to a pass that raised must be retried, not skipped."""
        session = self._session()

        def boom(*_args, **_kwargs):
            raise RuntimeError("model exploded")

        async def run():
            await _feed(session, 2.0)
            with mock.patch("backend.live.transcribe_audio", boom):
                out = await session.maybe_transcribe()
            return out

        out = asyncio.run(run())
        self.assertEqual(out["type"], "error")
        self.assertEqual(session._covered_sec, 0.0)


class DeepgramEventOrderingTests(unittest.TestCase):
    def _session(self) -> DeepgramLiveSession:
        return DeepgramLiveSession(api_key="k")

    def test_critical_event_eviction_preserves_fifo_order(self):
        """Evicting an interim must not reorder the committed segments.

        Queue layout under back-pressure is [final-1, interim, final-2 …].
        The old implementation popped final-1 and interim looking for a
        victim, then pushed final-1 back at the TAIL — behind final-2 and
        everything else still queued — so the consumer merged sentences
        out of order.
        """
        session = self._session()
        session._event_queue = asyncio.Queue(maxsize=4)
        session._event_queue.put_nowait({"type": "segments", "id": 1})
        session._event_queue.put_nowait({"type": "interim", "id": 2})
        session._event_queue.put_nowait({"type": "segments", "id": 3})
        session._event_queue.put_nowait({"type": "segments", "id": 4})

        session._enqueue_event({"type": "segments", "id": 5}, is_critical=True)

        drained = []
        while not session._event_queue.empty():
            drained.append(session._event_queue.get_nowait())

        self.assertEqual(
            [item["id"] for item in drained],
            [1, 3, 4, 5],
            "interim must be dropped in place; finals keep arrival order",
        )

    def test_sentinel_still_lands_when_queue_is_saturated(self):
        session = self._session()
        session._event_queue = asyncio.Queue(maxsize=2)
        session._event_queue.put_nowait({"type": "segments", "id": 1})
        session._event_queue.put_nowait({"type": "segments", "id": 2})

        session._enqueue_event(session._QUEUE_SENTINEL, is_critical=True)

        drained = []
        while not session._event_queue.empty():
            drained.append(session._event_queue.get_nowait())
        self.assertIn(session._QUEUE_SENTINEL, drained)


if __name__ == "__main__":
    unittest.main()
