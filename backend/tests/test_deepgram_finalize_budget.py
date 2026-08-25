"""The post-Finalize wait budget is chosen from tail coverage.

Measured over 410 real stops in main.log: 267 (65 %) ended with the
streamed audio ALREADY fully covered by finalized segments — Finalize
had nothing left to flush and Deepgram answered with nothing — yet each
had first burned the full ``FINALIZE_FLUSH_WAIT_SEC`` ceiling. Total
stop-side latency was 608 s, almost all of it spent waiting for messages
that were never coming.

The information that proves nothing is missing (bytes streamed vs the
end of the last finalized segment) is local state we hold the whole
time. It used to be consulted only inside the timeout handler, i.e.
strictly after the cost had been paid. Now it picks the budget up front:

  * uncovered tail -> full ceiling, then the retry. Truncating here would
    cost the user real words.
  * covered tail   -> a short confirmation window.
"""

from __future__ import annotations

import asyncio
import json
import time
import unittest
from unittest import mock

from backend.remote_deepgram_live import (
    COVERAGE_GAP_MIN_SEC,
    FINALIZE_COVERED_WAIT_SEC,
    FINALIZE_EMPTY_TAIL_WAIT_SEC,
    FINALIZE_FLUSH_WAIT_SEC,
    TAIL_GUARD_MIN_SEC,
    DeepgramLiveSession,
)


class FakeUpstreamWs:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, payload):
        self.sent.append(json.loads(payload).get("type"))

    async def close(self):
        return None

    @property
    def types(self) -> list[str]:
        return list(self.sent)


def _session(
    *,
    streamed_sec: float,
    covered_end: float,
    tail_speech_sec: float = 0.0,
) -> DeepgramLiveSession:
    """A session whose tail is either silence or recognised speech.

    ``tail_speech_sec`` seeds an interim speech span running past
    ``covered_end`` — the difference between "the user was still talking
    when Stop landed" and "the user finished and then reached for the
    hotkey", which is what the budget now turns on.
    """
    session = DeepgramLiveSession(api_key="k")
    session._ws = FakeUpstreamWs()
    session._keepalive_task = None
    session._recv_task = None
    # bytes_sent is the only input to streamed_sec: 16 kHz, 16-bit mono.
    session.stats.bytes_sent = int(streamed_sec * 2 * session._cfg.sample_rate)
    if covered_end > 0:
        session._finalized_segments = [{"start": 0.0, "end": covered_end, "text": "x"}]
    if tail_speech_sec > 0:
        session._interim_speech_spans = [
            (covered_end, covered_end + tail_speech_sec)
        ]
    return session


class TailCoverageTests(unittest.TestCase):
    def test_coverage_is_derived_from_bytes_and_segment_ends(self):
        session = _session(streamed_sec=10.0, covered_end=9.5)
        streamed, covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(streamed, 10.0, places=2)
        self.assertAlmostEqual(covered, 9.5, places=2)
        self.assertAlmostEqual(gap, 0.5, places=2)
        self.assertEqual(speech, 0.0)

    def test_no_finalized_segments_means_everything_is_uncovered(self):
        session = _session(streamed_sec=4.0, covered_end=0.0)
        _streamed, covered, gap, _speech = session._tail_coverage()
        self.assertEqual(covered, 0.0)
        self.assertAlmostEqual(gap, 4.0, places=2)

    def test_a_silent_session_reports_no_gap(self):
        session = _session(streamed_sec=0.0, covered_end=0.0)
        self.assertEqual(session._tail_coverage(), (0.0, 0.0, 0.0, 0.0))

    def test_trailing_silence_is_a_gap_with_no_speech_in_it(self):
        # The common shape: the user finished speaking at 52.08 s and
        # pressed Stop at 54.0 s. Almost every recording ends this way.
        session = _session(streamed_sec=54.0, covered_end=52.08)
        _streamed, _covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 1.92, places=2)
        self.assertEqual(speech, 0.0)

    def test_speech_in_the_tail_is_measured(self):
        session = _session(streamed_sec=54.0, covered_end=52.0, tail_speech_sec=1.5)
        _streamed, _covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 2.0, places=2)
        self.assertAlmostEqual(speech, 1.5, places=2)

    def test_overlapping_interims_are_not_counted_twice(self):
        # A rolling re-decode emits many hypotheses over the same audio.
        session = _session(streamed_sec=54.0, covered_end=52.0)
        session._interim_speech_spans = [(52.0, 53.5), (52.4, 53.8), (53.0, 54.0)]
        _streamed, _covered, _gap, speech = session._tail_coverage()
        self.assertAlmostEqual(speech, 2.0, places=2)

    def test_speech_before_the_last_final_does_not_count_as_tail(self):
        # Those words are already in the transcript.
        session = _session(streamed_sec=54.0, covered_end=52.0)
        session._interim_speech_spans = [(10.0, 40.0)]
        _streamed, _covered, _gap, speech = session._tail_coverage()
        self.assertEqual(speech, 0.0)


class WaitBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_empty_tail_uses_the_short_confirmation_window(self):
        # 0.1 s past the last final is a segment boundary, not a tail.
        # Nothing is unflushed, so the ceiling buys nothing.
        session = _session(streamed_sec=90.0, covered_end=89.9)
        ws = session._ws
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 3.0
        ), mock.patch(
            "backend.remote_deepgram_live.FINALIZE_EMPTY_TAIL_WAIT_SEC", 0.12
        ):
            await session.finalize(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertIn("CloseStream", ws.types)
        self.assertGreaterEqual(elapsed, 0.12)
        self.assertLess(elapsed, 1.0, f"covered tail waited {elapsed:.2f}s")

    async def test_uncovered_tail_still_gets_the_full_ceiling(self):
        # Real unflushed speech: truncating the wait here would cost the
        # user the clause they just spoke.
        session = _session(streamed_sec=90.0, covered_end=85.0, tail_speech_sec=4.0)
        ws = session._ws
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.25
        ), mock.patch(
            "backend.remote_deepgram_live.FINALIZE_COVERED_WAIT_SEC", 0.01
        ):
            await session.finalize(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertIn("CloseStream", ws.types)
        # First wait (0.25) plus the tail-guard retry wait (0.25).
        self.assertGreaterEqual(elapsed, 0.25)
        # The retry Finalize must actually have been sent.
        self.assertEqual(ws.types.count("Finalize"), 2)

    async def test_an_early_final_short_circuits_either_budget(self):
        session = _session(streamed_sec=90.0, covered_end=85.0, tail_speech_sec=4.0)

        async def deliver_now():
            await asyncio.sleep(0.02)
            session._final_arrived.set()

        started = time.perf_counter()
        task = asyncio.create_task(deliver_now())
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 5.0
        ):
            await session.finalize(wait_timeout=0.5)
        await task
        self.assertLess(time.perf_counter() - started, 1.0)

    async def test_a_small_but_real_tail_is_not_treated_as_jitter(self):
        """The regression that cost a user the end of a sentence.

        Production 2026-08-25 14:33:16: gap=0.50 s, no interim had
        decoded it, the stream closed 0.25 s after Finalize and the
        transcript arrived ending mid-clause. 0.50 s is below the retry
        threshold but far above boundary jitter — Finalize has real audio
        to flush there and the answer takes a round trip.
        """
        session = _session(streamed_sec=24.36, covered_end=23.86)
        _streamed, _covered, gap, speech = session._tail_coverage()
        self.assertAlmostEqual(gap, 0.50, places=2)
        self.assertEqual(speech, 0.0)
        self.assertGreater(gap, COVERAGE_GAP_MIN_SEC)
        self.assertLess(gap, TAIL_GUARD_MIN_SEC)

        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_EMPTY_TAIL_WAIT_SEC", 0.01
        ), mock.patch(
            "backend.remote_deepgram_live.FINALIZE_COVERED_WAIT_SEC", 0.30
        ):
            await session.finalize(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertGreaterEqual(
            elapsed, 0.30,
            f"a 0.50 s tail was given the jitter window ({elapsed:.2f}s)",
        )

    async def test_empty_tail_never_triggers_the_retry(self):
        # A retry on an empty tail is a round trip that cannot produce
        # anything: every streamed second is already in a final.
        session = _session(streamed_sec=90.0, covered_end=89.95)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_EMPTY_TAIL_WAIT_SEC", 0.05
        ):
            await session.finalize(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 1)


class TrailingSilenceTests(unittest.IsolatedAsyncioTestCase):
    """The shape almost every recording ends in."""

    async def test_uncovered_audio_retries_even_when_no_speech_was_seen(self):
        # A trailing pause and a provider that stopped emitting interims
        # look identical to the speech signal, and only the second loses
        # the user's words. Uncovered audio therefore decides; measured
        # in production, gating on speech alone cost four seconds of a
        # real sentence.
        session = _session(streamed_sec=54.0, covered_end=52.08)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ), mock.patch(
            "backend.remote_deepgram_live.FINALIZE_COVERED_WAIT_SEC", 0.01
        ):
            await session.finalize(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 2)
        self.assertIn("CloseStream", ws.types)

    async def test_speech_in_the_tail_still_triggers_the_retry(self):
        # The user was mid-clause when Stop landed. This is the case the
        # guard exists for and it must be unchanged.
        session = _session(streamed_sec=54.0, covered_end=52.0, tail_speech_sec=1.5)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ), mock.patch(
            "backend.remote_deepgram_live.FINALIZE_COVERED_WAIT_SEC", 0.01
        ):
            await session.finalize(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 2)

    async def test_the_covered_case_still_closes_fast(self):
        # The saving that remains and is safe: nothing uncovered at all,
        # so there is provably nothing to flush.
        session = _session(streamed_sec=90.0, covered_end=89.9)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 3.0
        ), mock.patch(
            "backend.remote_deepgram_live.FINALIZE_COVERED_WAIT_SEC", 0.05
        ):
            await session.finalize(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 1)

    def test_the_predicate_can_only_add_confidence_never_remove_it(self):
        session = _session(streamed_sec=54.0, covered_end=52.0)
        # Uncovered audio alone is enough — this is the case that
        # regressed when speech was allowed to veto it.
        self.assertTrue(session._tail_needs_flush(5.0, 0.0))
        # Speech alone is also enough.
        self.assertTrue(session._tail_needs_flush(0.0, TAIL_GUARD_MIN_SEC))
        # Neither signal over the threshold: nothing to wait for.
        self.assertFalse(
            session._tail_needs_flush(TAIL_GUARD_MIN_SEC - 0.01, TAIL_GUARD_MIN_SEC - 0.01)
        )


class BudgetAnnouncementTests(unittest.IsolatedAsyncioTestCase):
    """The stop's deadline is published before the waiting starts.

    The renderer used to bound its own wait with a constant while this
    side could legitimately spend nine seconds; 24 % of stops measured on
    2026-08-25 ran past that constant, and everything the extra wait
    recovered arrived after the transcript had been delivered. The
    coverage analysis that decides the budget happens here, so the number
    is published from here.
    """

    async def test_an_uncovered_tail_announces_the_ceiling_and_the_retry(self):
        session = _session(streamed_sec=90.0, covered_end=85.0, tail_speech_sec=4.0)
        seen: list[tuple[float, bool]] = []
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.05
        ):
            await session.finalize(
                wait_timeout=0.3,
                on_budget=lambda budget, more: seen.append((budget, more)),
            )
        self.assertEqual(len(seen), 1, "announced exactly once")
        budget, expects_more = seen[0]
        self.assertTrue(expects_more, "an uncovered tail expects the wait to add words")
        # Worst case, not the expected case: the retry pays the ceiling again.
        self.assertAlmostEqual(budget, 0.10, places=3)

    async def test_an_empty_tail_announces_that_waiting_buys_nothing(self):
        session = _session(streamed_sec=90.0, covered_end=89.95)
        seen: list[tuple[float, bool]] = []
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_EMPTY_TAIL_WAIT_SEC", 0.02
        ):
            await session.finalize(
                wait_timeout=0.3,
                on_budget=lambda budget, more: seen.append((budget, more)),
            )
        self.assertEqual(len(seen), 1)
        budget, expects_more = seen[0]
        self.assertFalse(expects_more)
        self.assertAlmostEqual(budget, 0.02, places=3)

    async def test_a_throwing_consumer_cannot_break_the_stop(self):
        session = _session(streamed_sec=90.0, covered_end=89.95)
        ws = session._ws

        def explode(_budget: float, _more: bool) -> None:
            raise RuntimeError("consumer is broken")

        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_EMPTY_TAIL_WAIT_SEC", 0.02
        ):
            await session.finalize(wait_timeout=0.3, on_budget=explode)
        self.assertIn("CloseStream", ws.types, "the stop completed anyway")

    async def test_no_consumer_is_the_default(self):
        session = _session(streamed_sec=90.0, covered_end=89.95)
        ws = session._ws   # finalize() releases the socket on its way out
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_EMPTY_TAIL_WAIT_SEC", 0.02
        ):
            await session.finalize(wait_timeout=0.3)
        self.assertIn("CloseStream", ws.types)


class BudgetConstantTests(unittest.TestCase):
    def test_the_short_window_covers_only_empty_tails(self):
        # The 0.25 s window is measured on stops whose gap was 0.06-0.24 s
        # — nothing past the last final but boundary jitter. It was once
        # applied to every tail that did not need a RETRY, which is a band
        # up to TAIL_GUARD_MIN_SEC (0.75 s) wide, and it cost a user real
        # words: production 2026-08-25 14:33:16, gap=0.50 s, the stream
        # closed 0.25 s after Finalize and the sentence was delivered
        # ending mid-clause.
        #
        # The short window must not reach past what jitter means.
        self.assertLessEqual(FINALIZE_EMPTY_TAIL_WAIT_SEC, COVERAGE_GAP_MIN_SEC)
        # And a tail that is small but real gets a window sized from
        # actual round trips (p95 0.49 s), not from the empty case.
        self.assertGreater(FINALIZE_COVERED_WAIT_SEC, 0.49)
        self.assertGreater(FINALIZE_COVERED_WAIT_SEC, FINALIZE_EMPTY_TAIL_WAIT_SEC)

    def test_confirmation_window_is_shorter_than_the_full_ceiling(self):
        self.assertLess(FINALIZE_COVERED_WAIT_SEC, FINALIZE_FLUSH_WAIT_SEC)

    def test_the_guard_threshold_bounds_what_covered_can_hide(self):
        # "Covered" tolerates up to TAIL_GUARD_MIN_SEC of slack, so the
        # confirmation window must not be the only thing standing between
        # the user and a lost tail — the threshold is what keeps that
        # slack small.
        self.assertLessEqual(TAIL_GUARD_MIN_SEC, 1.0)


if __name__ == "__main__":
    unittest.main()
