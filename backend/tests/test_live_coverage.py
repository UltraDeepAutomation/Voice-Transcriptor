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


class FinalizeCoverageReportTests(unittest.TestCase):
    """``finalize_envelope`` is the contract the frontend trusts when it
    decides to adopt the live transcript instead of re-transcribing the
    saved recording. A false ``complete`` silently ships a transcript
    with holes, so every way of ending up short must clear the flag."""

    def _session(self) -> LiveSession:
        return LiveSession(
            model_name="tiny",
            language=None,
            config=LiveConfig(window_sec=8.0, overlap_sec=1.0, ring_slack_sec=10.0),
        )

    @staticmethod
    def _segments_for(audio, *_args, **_kwargs):
        end = audio.shape[0] / float(LIVE_SAMPLE_RATE_HZ)
        return {"segments": [{"start": 0.0, "end": end, "text": "hello"}]}

    def test_fully_covered_session_reports_complete(self):
        session = self._session()

        async def run():
            with mock.patch("backend.live.transcribe_audio", self._segments_for):
                await _feed(session, 3.0)
                await session.maybe_transcribe(force=True)

        asyncio.run(run())
        env = session.finalize_envelope()
        self.assertTrue(env["complete"])
        self.assertEqual(env["dropped_sec"], 0.0)
        self.assertEqual(env["uncovered_tail_sec"], 0.0)
        self.assertAlmostEqual(env["total_sec"], env["covered_sec"], delta=0.01)
        self.assertTrue(env["text"])

    def test_untranscribed_tail_clears_complete(self):
        """Audio arriving after the last pass, with no forced flush."""
        session = self._session()

        async def run():
            with mock.patch("backend.live.transcribe_audio", self._segments_for):
                await _feed(session, 2.0)
                await session.maybe_transcribe()
            await _feed(session, 1.5)

        asyncio.run(run())
        env = session.finalize_envelope()
        self.assertFalse(env["complete"])
        self.assertGreater(env["uncovered_tail_sec"], 1.0)

    def test_dropped_audio_clears_complete(self):
        """The assist fell behind far enough that a window was capped."""
        session = self._session()

        async def run():
            await _feed(session, 40.0)
            with mock.patch("backend.live.transcribe_audio", self._segments_for):
                await session.maybe_transcribe(force=True)

        asyncio.run(run())
        env = session.finalize_envelope()
        self.assertGreater(env["dropped_sec"], 0.0)
        self.assertFalse(env["complete"])

    def test_failed_final_pass_clears_complete(self):
        session = self._session()

        def boom(*_args, **_kwargs):
            raise RuntimeError("model exploded")

        async def run():
            await _feed(session, 2.0)
            with mock.patch("backend.live.transcribe_audio", boom):
                await session.maybe_transcribe(force=True)

        asyncio.run(run())
        env = session.finalize_envelope()
        self.assertFalse(env["complete"])
        self.assertEqual(env["covered_sec"], 0.0)

    def test_empty_session_is_not_complete(self):
        """No audio at all must never certify coverage — otherwise an
        empty transcript would be adopted as authoritative."""
        env = self._session().finalize_envelope()
        self.assertFalse(env["complete"])
        self.assertEqual(env["total_sec"], 0.0)


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


class DroppedSecondsAccountingTests(unittest.TestCase):
    """``droppedSec`` counts audio the model never saw (B-068).

    ``need_sec`` includes the overlap head, which is re-fed on purpose
    and was already decoded. Subtracting it from the window cap counted
    covered audio as lost, overstating the loss by exactly
    ``overlap_sec`` on every truncation — an error that accumulates in
    the total the envelope reports and the user-facing warning prints,
    and the existing test only asserted "> 0.0".
    """

    def _session(self, **over) -> LiveSession:
        cfg = dict(window_sec=8.0, overlap_sec=1.0, ring_slack_sec=10.0)
        cfg.update(over)
        return LiveSession(model_name="tiny", language=None, config=LiveConfig(**cfg))

    @staticmethod
    def _segments_for(audio, *_args, **_kwargs):
        end = audio.shape[0] / float(LIVE_SAMPLE_RATE_HZ)
        return {"segments": [{"start": 0.0, "end": end, "text": "hello"}]}

    def test_the_drop_is_the_audio_before_the_window_and_after_coverage(self):
        session = self._session()

        async def run():
            await _feed(session, 40.0)
            with mock.patch("backend.live.transcribe_audio", self._segments_for):
                await session.maybe_transcribe(force=True)

        asyncio.run(run())
        env = session.finalize_envelope()
        max_window = session._max_window_sec()
        total = env["total_sec"]
        # Nothing was covered before this pass, so everything before the
        # window's start is the loss — and not a second more.
        self.assertAlmostEqual(
            env["dropped_sec"], max(0.0, total - max_window), places=3
        )

    def test_a_second_truncation_does_not_double_count_the_overlap(self):
        session = self._session()

        async def run():
            await _feed(session, 40.0)
            with mock.patch("backend.live.transcribe_audio", self._segments_for):
                await session.maybe_transcribe(force=True)
                first = session._dropped_sec_total
                await _feed(session, 40.0)
                await session.maybe_transcribe(force=True)
                return first, session._dropped_sec_total

        first, second = asyncio.run(run())
        max_window = session._max_window_sec()
        # The second pass loses the audio between where the first pass
        # finished and where the second window starts. With the overlap
        # counted in, each pass reported a full ``overlap_sec`` more.
        self.assertAlmostEqual(second - first, 40.0 - max_window, places=3)

    def test_a_session_that_keeps_up_reports_no_drop_at_all(self):
        session = self._session()

        async def run():
            await _feed(session, 3.0)
            with mock.patch("backend.live.transcribe_audio", self._segments_for):
                await session.maybe_transcribe(force=True)

        asyncio.run(run())
        self.assertEqual(session.finalize_envelope()["dropped_sec"], 0.0)


class OverlapGuardWithinOnePassTests(unittest.TestCase):
    """The repeat guard sees what THIS pass has already emitted (B-069).

    ``_emitted_tail_text`` read only the committed segments, and this
    pass's segments are committed after the loop — so segment k was
    compared against the transcript as it stood before the pass, and a
    decoder that split a boundary clause into two adjacent segments in
    ONE window sailed straight through.
    """

    def _session(self) -> LiveSession:
        return LiveSession(
            model_name="tiny",
            language=None,
            config=LiveConfig(
                window_sec=8.0,
                overlap_sec=1.0,
                ring_slack_sec=10.0,
                word_timestamps=False,
            ),
        )

    def test_a_repeat_inside_one_pass_is_trimmed(self):
        session = self._session()

        def segments(audio, *_a, **_k):
            return {
                "segments": [
                    {"start": 0.0, "end": 1.0, "text": "починить очень важно"},
                    {"start": 1.0, "end": 2.0, "text": "починить очень важно снова"},
                ]
            }

        async def run():
            await _feed(session, 3.0)
            with mock.patch("backend.live.transcribe_audio", segments):
                return await session.maybe_transcribe(force=True)

        out = asyncio.run(run())
        texts = [seg["text"] for seg in out["segments"]]
        self.assertEqual(texts, ["починить очень важно", "снова"])

    def test_a_text_trimmed_segment_moves_its_start_past_the_watermark(self):
        # B-071: the word branch re-anchors a trimmed event so the
        # frontend's time-ordered merge does not see it overlap
        # committed content; the text branch left the start where it was.
        session = self._session()

        def segments(audio, *_a, **_k):
            return {
                "segments": [
                    {"start": 0.0, "end": 1.5, "text": "первая часть"},
                    {"start": 0.5, "end": 2.5, "text": "первая часть вторая"},
                ]
            }

        async def run():
            await _feed(session, 3.0)
            with mock.patch("backend.live.transcribe_audio", segments):
                return await session.maybe_transcribe(force=True)

        out = asyncio.run(run())
        first, second = out["segments"]
        self.assertEqual(second["text"], "вторая")
        self.assertGreaterEqual(
            second["start"],
            first["end"],
            "a trimmed segment still reports a start inside committed audio",
        )


class ErrorEscalationTests(unittest.TestCase):
    def test_escalation_is_by_count_and_keeps_no_write_only_state(self):
        # B-078: ``_last_error_signature`` was written on both error
        # paths and cleared on success, and read nowhere.
        session = LiveSession(model_name="tiny", language=None)
        self.assertFalse(hasattr(session, "_last_error_signature"))


if __name__ == "__main__":
    unittest.main()
