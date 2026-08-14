"""A client that goes away must not be logged as a server error.

``_is_broken_pipe_error`` decides whether a failed WebSocket send gets a
DEBUG line or a WARNING with a full traceback. It used to classify purely
by matching substrings of the exception message, which missed
``ConnectionClosedOK`` — its message reads ``received 1000 (no status
received [internal]); then sent 1000 …`` and matches none of the
patterns. One session's main.log carried thirteen multi-frame tracebacks
for what was just the renderer closing its socket at the end of a
recording.

The classifier is now type-first and walks the cause chain, because
uvicorn re-raises the disconnect wrapped in its own error. These tests
pin both halves of that behaviour, and — just as important — that a
genuine bug (the JSON-encoding failure the traceback logging exists for)
still gets its traceback.
"""

from __future__ import annotations

import unittest

from backend.tests.test_live import IsolatedBackendMainImportMixin


class BrokenPipeClassificationTests(IsolatedBackendMainImportMixin, unittest.TestCase):
    def test_connection_closed_ok_is_a_disconnect(self):
        from websockets.exceptions import ConnectionClosedOK

        self.assertTrue(self.main._is_broken_pipe_error(ConnectionClosedOK(None, None)))

    def test_connection_closed_error_is_a_disconnect(self):
        from websockets.exceptions import ConnectionClosedError

        self.assertTrue(self.main._is_broken_pipe_error(ConnectionClosedError(None, None)))

    def test_disconnect_wrapped_by_the_asgi_server_is_still_a_disconnect(self):
        """uvicorn raises its own error `from` the websockets exception."""
        from websockets.exceptions import ConnectionClosedOK

        try:
            try:
                raise ConnectionClosedOK(None, None)
            except Exception as inner:
                raise RuntimeError("Unexpected ASGI message 'websocket.send'") from inner
        except Exception as outer:
            self.assertTrue(self.main._is_broken_pipe_error(outer))

    def test_starlette_disconnect_is_a_disconnect(self):
        self.assertTrue(
            self.main._is_broken_pipe_error(self.main.WebSocketDisconnect(code=1000))
        )

    def test_plain_broken_pipe_still_classifies(self):
        self.assertTrue(self.main._is_broken_pipe_error(BrokenPipeError(32, "Broken pipe")))

    def test_real_bugs_keep_their_traceback(self):
        """The failure mode the traceback logging exists for — a value
        that cannot be JSON-encoded leaking into a segment dict — must
        never be silenced as a disconnect."""
        self.assertFalse(
            self.main._is_broken_pipe_error(
                TypeError("Object of type float32 is not JSON serializable")
            )
        )
        self.assertFalse(self.main._is_broken_pipe_error(ValueError("bad payload")))

    def test_cause_chain_walk_terminates_on_a_cycle(self):
        a = RuntimeError("a")
        b = RuntimeError("b")
        a.__context__ = b
        b.__context__ = a
        self.assertFalse(self.main._is_broken_pipe_error(a))


if __name__ == "__main__":
    unittest.main()
