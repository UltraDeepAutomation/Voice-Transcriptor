"""``CloseStream`` must not race the transcript ``Finalize`` flushes.

Both frames used to be written in the same millisecond, so the stream
could be torn down before Deepgram returned the audio that Finalize had
just flushed. Measured across 14 sessions in one main.log: sessions whose
last segment arrived naturally (``speech_final=true``) left 0.25 s of
audio undecoded on average, while sessions still mid-utterance at Stop
(``speech_final=false``) left 1.86 s — the clause the user had just
spoken. That is the difference the user described between "it ended
exactly where I stopped" and "the last sentence is missing".

``finalize()`` now waits for the flushed transcript before closing,
bounded by ``FINALIZE_FLUSH_WAIT_SEC`` and short-circuited the moment it
arrives.
"""

from __future__ import annotations

import asyncio
import json
import time
import unittest
from unittest import mock

from backend.remote_deepgram_live import DeepgramLiveSession


class FakeUpstreamWs:
    """Records the frames finalize writes, with arrival order preserved."""

    def __init__(self):
        self.sent: list[str] = []

    async def send(self, payload):
        self.sent.append(json.loads(payload).get("type"))

    async def close(self):
        return None

    @property
    def types(self) -> list[str]:
        return list(self.sent)


def _session() -> DeepgramLiveSession:
    session = DeepgramLiveSession(api_key="k")
    session._ws = FakeUpstreamWs()
    # finalize() drains background work it never started in this harness.
    session._keepalive_task = None
    session._recv_task = None
    return session


class FinalizeFlushOrderingTests(unittest.IsolatedAsyncioTestCase):
    async def test_close_stream_waits_for_the_flushed_transcript(self):
        session = _session()
        arrival: dict[str, float] = {}

        async def deliver_final_after(delay: float):
            await asyncio.sleep(delay)
            arrival["final"] = time.perf_counter()
            session._final_arrived.set()

        ws = session._ws  # finalize() releases the reference on close
        started = time.perf_counter()
        task = asyncio.create_task(deliver_final_after(0.20))
        await session.finalize(wait_timeout=0.5)
        await task

        self.assertIn("Finalize", ws.types)
        self.assertIn("CloseStream", ws.types)
        self.assertLess(
            ws.types.index("Finalize"),
            ws.types.index("CloseStream"),
            "Finalize must precede CloseStream",
        )
        # The close must land after the transcript, not race it.
        self.assertGreaterEqual(time.perf_counter() - started, 0.20)

    async def test_wait_short_circuits_when_the_transcript_lands_early(self):
        """A prompt Deepgram must not be made to pay the full ceiling."""
        session = _session()

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
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 1.0, f"finalize waited {elapsed:.2f}s despite an early final")

    async def test_silent_upstream_still_closes_within_the_ceiling(self):
        """No transcript ever arrives — the stream must still close."""
        session = _session()
        ws = session._ws  # finalize() releases the reference on close
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.15
        ):
            await session.finalize(wait_timeout=0.5)
        elapsed = time.perf_counter() - started
        self.assertIn("CloseStream", ws.types)
        self.assertGreaterEqual(elapsed, 0.15)
        self.assertLess(elapsed, 2.0)

    async def test_a_stale_final_from_earlier_does_not_satisfy_the_wait(self):
        """The event is cleared before waiting, so a final that arrived
        mid-recording cannot be mistaken for the flushed one."""
        session = _session()
        session._final_arrived.set()  # as if a mid-stream final had landed
        started = time.perf_counter()
        with mock.patch(
            "backend.remote_deepgram_live.FINALIZE_FLUSH_WAIT_SEC", 0.15
        ):
            await session.finalize(wait_timeout=0.5)
        self.assertGreaterEqual(time.perf_counter() - started, 0.15)


if __name__ == "__main__":
    unittest.main()
