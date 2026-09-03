"""The send path never lets Deepgram stall the renderer's socket (§3.6).

Measured failure, 2026-09-02 00:40: ``await session.send_pcm(data)`` sat
in the middle of the loop that reads the renderer's WebSocket, so a
wedged upstream stopped the app reading its own socket for the whole 5 s
send timeout — four times in one recording, 20 s in which no frame was
read and the user's ``finalize`` waited behind hundreds of binary
frames. Two of those sessions ended fatally. The timeout was also the
likely cause of the runs: ``asyncio.wait_for`` cancels ``ws.send``
mid-frame, which ``websockets`` documents as leaving the connection
undefined.

What is pinned here:

* the receiver keeps reading while the upstream refuses every write;
* ``Finalize`` is applied only after the queued audio has reached
  Deepgram — by construction, because it rides the same queue;
* a wedged upstream is detected by the AGE of unsent audio, reported
  fatally through the session, and answered by closing the socket
  (never by cancelling a write).
"""

from __future__ import annotations

import asyncio
import io
import json
import unittest
from unittest import mock

from backend.tests.test_live import IsolatedBackendMainImportMixin


class _FakeWebSocket:
    """The renderer side: a queue of ASGI messages and captured sends."""

    def __init__(self):
        self.messages: "asyncio.Queue[dict]" = asyncio.Queue()
        self.sent: list[dict] = []

    async def receive(self):
        return await self.messages.get()

    async def send_text(self, text):
        self.sent.append(json.loads(text))


class _FakeStats:
    def __init__(self):
        self.bytes_sent = 0
        self.bytes_offered = 0
        self.chunks_sent = 0
        self.segments_final = 1
        self.segments_interim = 0
        self.connect_ms = 1.0
        self.finalize_ms = 1.0

    def as_dict(self):
        return {}


class _FakeUpstream:
    """A Deepgram session whose writes can be held open indefinitely.

    ``block.set()`` is what a healthy socket does immediately; leaving it
    clear is a wedged one. ``send_pcm`` deliberately does NOT time out —
    the production one does not either any more.
    """

    instances: list["_FakeUpstream"] = []

    def __init__(self, *_a, **_kw):
        self.stats = _FakeStats()
        self.block = asyncio.Event()
        self.block.set()
        self.sent_pcm: list[bytes] = []
        self.fatal_reports: list[str] = []
        self.undelivered = 0
        self.bytes_at_drain: int | None = None
        self._closed = False
        self.last_error = None
        self.last_fatal = False
        self._events: "asyncio.Queue[dict]" = asyncio.Queue()
        _FakeUpstream.instances.append(self)

    async def connect(self):
        return None

    async def send_pcm(self, chunk):
        await self.block.wait()
        if self._closed:
            return
        self.sent_pcm.append(chunk)
        self.stats.bytes_sent += len(chunk)
        self.stats.bytes_offered += len(chunk)

    def note_undelivered_audio(self, nbytes):
        self.undelivered += nbytes
        self.stats.bytes_offered += nbytes

    def report_fatal(self, message):
        self.fatal_reports.append(message)
        self.last_error = message
        self.last_fatal = True
        self._closed = True
        self._events.put_nowait({"type": "error", "error": message, "fatal": True})

    async def events(self):
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def drain_transcript(self, on_budget=None):
        self.bytes_at_drain = sum(len(c) for c in self.sent_pcm)
        return {
            "text": "ok", "segments": [], "durationSec": 0.0, "stats": {},
            "uncoveredSpeechSec": 0.0, "streamedSec": 0.0, "coveredEndSec": 0.0,
        }

    async def shutdown(self, wait_timeout=3.0):
        await self.close()

    async def close(self):
        self._closed = True
        self.block.set()
        self._events.put_nowait(None)

    @property
    def is_closed(self):
        return self._closed


def _recovery() -> dict:
    return {"pcm_file": io.BytesIO(), "bytes": 0, "chunks": 0, "had_error": False}


class SendQueueTests(IsolatedBackendMainImportMixin, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        _FakeUpstream.instances.clear()

    def _run(self, ws, recovery):
        return asyncio.create_task(
            self.main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            )
        )

    async def test_receiver_keeps_reading_while_the_upstream_refuses_writes(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            upstream = _FakeUpstream.instances[0]
            upstream.block.clear()  # every write from here on hangs

            frames = [bytes([i]) * 400 for i in range(1, 21)]
            for frame in frames:
                await ws.messages.put({"type": "websocket.receive", "bytes": frame})
            await asyncio.sleep(0.05)

            # The renderer's socket was drained even though not one byte
            # could be written upstream: every frame is in the recovery
            # spool and nothing is left queued on the WebSocket.
            self.assertEqual(recovery["chunks"], len(frames))
            self.assertEqual(recovery["pcm_file"].getvalue(), b"".join(frames))
            self.assertTrue(ws.messages.empty())

            upstream.block.set()
            await ws.messages.put(
                {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
            )
            await asyncio.wait_for(task, timeout=5.0)

    async def test_finalize_is_applied_after_the_queued_audio(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            upstream = _FakeUpstream.instances[0]
            upstream.block.clear()

            frames = [bytes([i]) * 700 for i in range(1, 11)]
            for frame in frames:
                await ws.messages.put({"type": "websocket.receive", "bytes": frame})
            await asyncio.sleep(0.02)
            await ws.messages.put(
                {"type": "websocket.receive", "text": json.dumps({"type": "finalize"})}
            )
            # Stop is in flight while the upstream is still refusing
            # writes; only now does it start accepting.
            await asyncio.sleep(0.02)
            self.assertIsNone(upstream.bytes_at_drain)
            upstream.block.set()

            await asyncio.wait_for(task, timeout=5.0)

        total = sum(len(f) for f in frames)
        self.assertEqual(
            upstream.bytes_at_drain, total,
            "Finalize ran before all queued audio reached Deepgram",
        )
        self.assertEqual(b"".join(upstream.sent_pcm), b"".join(frames))
        # Batched into ~50 ms writes rather than one write per frame.
        self.assertLess(len(upstream.sent_pcm), len(frames))

    async def test_a_wedged_upstream_is_detected_and_reported(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream), \
                mock.patch.object(self.main, "_SEND_WEDGE_TIMEOUT_SEC", 0.2), \
                mock.patch.object(self.main, "_SEND_WEDGE_POLL_SEC", 0.02), \
                mock.patch.object(self.main, "_SEND_FLUSH_DEADLINE_SEC", 1.0):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            upstream = _FakeUpstream.instances[0]
            upstream.block.clear()

            for i in range(1, 6):
                await ws.messages.put(
                    {"type": "websocket.receive", "bytes": bytes([i]) * 800}
                )
            # No finalize: the wedge alone must end the session.
            await asyncio.wait_for(task, timeout=5.0)

        self.assertTrue(
            upstream.fatal_reports,
            "a wedged upstream must be reported through the session",
        )
        self.assertIn("wedged", upstream.fatal_reports[0])
        self.assertTrue(upstream.is_closed)
        errors = [m for m in ws.sent if m.get("type") == "error"]
        self.assertTrue(errors, f"no error envelope reached the renderer: {ws.sent}")
        self.assertTrue(errors[0]["fatal"])
        self.assertTrue(recovery["had_error"])

    async def test_dropped_audio_is_still_counted_as_offered(self):
        ws = _FakeWebSocket()
        recovery = _recovery()
        with mock.patch.object(self.main, "DeepgramLiveSession", _FakeUpstream), \
                mock.patch.object(self.main, "_SEND_QUEUE_MAX_BYTES", 2000), \
                mock.patch.object(self.main, "_SEND_WEDGE_TIMEOUT_SEC", 0.3), \
                mock.patch.object(self.main, "_SEND_WEDGE_POLL_SEC", 0.02), \
                mock.patch.object(self.main, "_SEND_FLUSH_DEADLINE_SEC", 1.0):
            task = self._run(ws, recovery)
            await asyncio.sleep(0.02)
            upstream = _FakeUpstream.instances[0]
            upstream.block.clear()

            for i in range(1, 11):
                await ws.messages.put(
                    {"type": "websocket.receive", "bytes": bytes([i]) * 500}
                )
            await asyncio.wait_for(task, timeout=5.0)

        # 5000 bytes captured, at most 2000 could be queued: the rest is
        # declared undelivered so the coverage math still sees the whole
        # recording (B1 / _tail_coverage).
        self.assertGreater(upstream.undelivered, 0)
        self.assertEqual(recovery["bytes"], 5000)


if __name__ == "__main__":
    unittest.main()
