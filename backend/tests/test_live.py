import unittest
import asyncio
import base64
import importlib
import io
import json
import os
import sys
from unittest import mock

from backend.live import LiveConfig, LiveSession


class WebSocketAuthTokenTests(unittest.TestCase):
    def setUp(self):
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")

    def tearDown(self):
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)

    def test_websocket_token_comes_from_subprotocol_not_query(self):
        token = "tok value/with unicode ью"
        encoded = base64.urlsafe_b64encode(token.encode("utf-8")).decode("ascii").rstrip("=")

        class FakeWebSocket:
            headers = {
                "sec-websocket-protocol": (
                    f"{self.main.WS_AUTH_SUBPROTOCOL}, "
                    f"{self.main.WS_AUTH_TOKEN_PREFIX}{encoded}"
                )
            }
            query_params = {"token": "query-token-must-not-win"}

        ws = FakeWebSocket()

        self.assertEqual(self.main._websocket_api_token(ws), token)
        self.assertEqual(
            self.main._websocket_accept_subprotocol(ws),
            self.main.WS_AUTH_SUBPROTOCOL,
        )

    def test_websocket_query_token_is_ignored(self):
        class FakeWebSocket:
            headers = {}
            query_params = {"token": self.main.API_TOKEN}

        self.assertEqual(self.main._websocket_api_token(FakeWebSocket()), "")

    def test_websocket_header_token_still_supports_non_browser_clients(self):
        class FakeWebSocket:
            headers = {"x-api-token": "header-token"}
            query_params = {}

        self.assertEqual(self.main._websocket_api_token(FakeWebSocket()), "header-token")

    def test_http_query_token_is_ignored(self):
        request = type("FakeRequest", (), {})()
        request.url = type("FakeURL", (), {"path": "/api/config"})()
        request.headers = {}
        request.query_params = {"token": self.main.API_TOKEN}
        request.method = "GET"
        request.client = type("FakeClient", (), {"host": "127.0.0.1"})()

        with self.assertRaises(self.main.HTTPException) as raised:
            asyncio.run(self.main._require_api_auth(request))

        self.assertEqual(raised.exception.status_code, 401)

    def test_http_header_token_authenticates(self):
        request = type("FakeRequest", (), {})()
        request.url = type("FakeURL", (), {"path": "/api/config"})()
        request.headers = {"x-api-token": self.main.API_TOKEN}
        request.query_params = {}
        request.method = "GET"
        request.client = type("FakeClient", (), {"host": "127.0.0.1"})()

        asyncio.run(self.main._require_api_auth(request))

    def test_network_probe_requires_token_but_health_does_not(self):
        request = type("FakeRequest", (), {})()
        request.url = type("FakeURL", (), {"path": "/api/network"})()
        request.headers = {}
        request.query_params = {}
        request.method = "GET"
        request.client = type("FakeClient", (), {"host": "127.0.0.1"})()

        with self.assertRaises(self.main.HTTPException) as raised:
            asyncio.run(self.main._require_api_auth(request))

        self.assertEqual(raised.exception.status_code, 401)

        request.url = type("FakeURL", (), {"path": "/api/health"})()
        asyncio.run(self.main._require_api_auth(request))


class LiveSessionTailTests(unittest.IsolatedAsyncioTestCase):
    async def test_force_transcribe_bypasses_min_step_for_stop_tail(self):
        sr = 16_000
        session = LiveSession(
            model_name="tiny",
            language=None,
            config=LiveConfig(
                sample_rate=sr,
                window_sec=8.0,
                min_step_sec=10.0,
                min_audio_sec=0.1,
            ),
        )
        await session.append_pcm16le(b"\x01\x00" * sr)

        calls = []

        def fake_transcribe(audio, *_args, **_kwargs):
            calls.append(audio.shape[0])
            return {
                "segments": [
                    {
                        "start": 0.0,
                        "end": audio.shape[0] / sr,
                        "text": "tail words",
                    }
                ]
            }

        with mock.patch("backend.live.transcribe_audio", side_effect=fake_transcribe):
            self.assertIsNone(await session.maybe_transcribe())

            forced = await session.maybe_transcribe(force=True)
            self.assertIsNotNone(forced)
            self.assertEqual(forced["segments"][0]["text"], "tail words")

            self.assertIsNone(await session.maybe_transcribe(force=True))

        self.assertEqual(calls, [sr])


class DeepgramLiveSessionTailTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        os.environ["TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG"] = "1"
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        self.main = importlib.import_module("backend.main")

    def tearDown(self):
        try:
            self.main.jobs.shutdown(timeout=0.1)
        except Exception:
            pass
        for name in ("backend.main", "backend.config"):
            sys.modules.pop(name, None)
        os.environ.pop("TRANSCRIPTOR_DISABLE_PARENT_WATCHDOG", None)

    async def test_deepgram_upstream_close_keeps_receiving_tail_pcm_until_finalize(self):
        class FakeStats:
            bytes_sent = 0
            chunks_sent = 0
            segments_final = 1
            segments_interim = 0
            connect_ms = 1.0
            finalize_ms = 1.0

            def as_dict(self):
                return {}

        class FakeDeepgramSession:
            def __init__(self, *_args, **_kwargs):
                self.stats = FakeStats()
                self._closed = True
                self.last_error = "upstream closed early"
                self.last_fatal = False

            async def connect(self):
                return None

            async def send_pcm(self, _chunk):
                raise AssertionError("closed upstream must not receive PCM")

            async def events(self):
                if False:
                    yield {}
                return

            async def finalize(self, wait_timeout=3.0):
                return {"text": "partial", "segments": [], "durationSec": 0.0, "stats": {}}

            def final_text(self):
                return "partial"

            async def close(self):
                self._closed = True

            @property
            def is_closed(self):
                return self._closed

        class FakeWebSocket:
            def __init__(self):
                self.messages: asyncio.Queue[dict] = asyncio.Queue()
                self.sent: list[dict] = []

            async def receive(self):
                return await self.messages.get()

            async def send_text(self, text):
                self.sent.append(json.loads(text))

        ws = FakeWebSocket()
        recovery = {
            "pcm_file": io.BytesIO(),
            "bytes": 0,
            "chunks": 0,
            "had_error": False,
        }

        with mock.patch.object(self.main, "DeepgramLiveSession", FakeDeepgramSession):
            task = asyncio.create_task(self.main._run_deepgram_live_session(
                websocket=ws,
                api_key="dg",
                model="nova-3",
                language="auto",
                diarize=False,
                recovery=recovery,
            ))
            await asyncio.sleep(0.01)
            self.assertFalse(task.done())
            await ws.messages.put({"type": "websocket.receive", "bytes": b"tail-pcm"})
            await ws.messages.put({"type": "websocket.receive", "text": json.dumps({"type": "finalize"})})
            await asyncio.wait_for(task, timeout=1.0)

        self.assertTrue(recovery["had_error"])
        self.assertEqual(recovery["bytes"], len(b"tail-pcm"))
        self.assertEqual(recovery["chunks"], 1)
        self.assertEqual(recovery["pcm_file"].getvalue(), b"tail-pcm")


if __name__ == "__main__":
    unittest.main()
