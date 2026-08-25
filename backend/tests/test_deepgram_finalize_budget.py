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
    FINALIZE_COVERED_WAIT_SEC,
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


def _session(*, streamed_sec: float, covered_end: float) -> DeepgramLiveSession:
    session = DeepgramLiveSession(api_key="k")
    session._ws = FakeUpstreamWs()
    session._keepalive_task = None
    session._recv_task = None
    # bytes_sent is the only input to streamed_sec: 16 kHz, 16-bit mono.
    session.stats.bytes_sent = int(streamed_sec * 2 * session._cfg.sample_rate)
    if covered_end > 0:
        session._finalized_segments = [{"start": 0.0, "end": covered_end, "text": "x"}]
    return session


class TailCoverageTests(unittest.TestCase):
    def test_coverage_is_derived_from_bytes_and_segment_ends(self):
        session = _session(streamed_sec=10.0, covered_end=9.5)
        streamed, covered, gap = session._tail_coverage()
        self.assertAlmostEqual(streamed, 10.0, places=2)
        self.assertAlmostEqual(covered, 9.5, places=2)
        self.assertAlmostEqual(gap, 0.5, places=2)

    def test_no_finalized_segments_means_everything_is_uncovered(self):
        session = _session(streamed_sec=4.0, covered_end=0.0)
        _streamed, covered, gap = session._tail_coverage()
        self.assertEqual(covered, 0.0)
        self.assertAlmostEqual(gap, 4.0, places=2)

    def test_a_silent_session_reports_no_gap(self):
        session = _session(streamed_sec=0.0, covered_end=0.0)
        self.assertEqual(session._tail_coverage(), (0.0, 0.0, 0.0))


class WaitBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_covered_tail_uses_the_short_confirmation_window(self):
        # Nothing is unflushed, so the ceiling buys nothing. This is the
        # 65 % case from the logs.
        session = _session(streamed_sec=90.0, covered_end=89.9)
        ws = session._ws
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 3.0
        ), mock.patch(
            "backend.remote_deepgram_live.FINALIZE_COVERED_WAIT_SEC", 0.12
        ):
            await session.finalize(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertIn("CloseStream", ws.types)
        self.assertGreaterEqual(elapsed, 0.12)
        self.assertLess(elapsed, 1.0, f"covered tail waited {elapsed:.2f}s")

    async def test_uncovered_tail_still_gets_the_full_ceiling(self):
        # Real unflushed speech: truncating the wait here would cost the
        # user the clause they just spoke.
        session = _session(streamed_sec=90.0, covered_end=85.0)
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
        session = _session(streamed_sec=90.0, covered_end=85.0)

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

    async def test_covered_tail_never_triggers_the_retry(self):
        # A retry on a covered stream is a round trip that cannot produce
        # anything: every streamed second is already in a final.
        session = _session(streamed_sec=90.0, covered_end=89.95)
        ws = session._ws
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_COVERED_WAIT_SEC", 0.05
        ):
            await session.finalize(wait_timeout=0.5)
        self.assertEqual(ws.types.count("Finalize"), 1)


class BudgetConstantTests(unittest.TestCase):
    def test_confirmation_window_sits_above_the_observed_p95_round_trip(self):
        # 411 measured post-Finalize round trips: median 0.26 s,
        # p90 0.36 s, p95 0.49 s. A budget below p95 would start
        # truncating finals that were genuinely on their way.
        self.assertGreater(FINALIZE_COVERED_WAIT_SEC, 0.49)

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
