import importlib
import os
import sys
import unittest


class DeepgramEndpointTests(unittest.TestCase):
    def setUp(self):
        self._old_host = os.environ.get("TRANSCRIPTOR_DEEPGRAM_HOST")

    def tearDown(self):
        if self._old_host is None:
            os.environ.pop("TRANSCRIPTOR_DEEPGRAM_HOST", None)
        else:
            os.environ["TRANSCRIPTOR_DEEPGRAM_HOST"] = self._old_host
        sys.modules.pop("backend.deepgram_endpoints", None)

    def _reload(self):
        sys.modules.pop("backend.deepgram_endpoints", None)
        return importlib.import_module("backend.deepgram_endpoints")

    def test_blank_host_uses_default(self):
        os.environ["TRANSCRIPTOR_DEEPGRAM_HOST"] = "   "
        mod = self._reload()

        self.assertEqual(mod.DEEPGRAM_REST_BASE, "https://api.deepgram.com/v1")
        self.assertEqual(mod.DEEPGRAM_LIVE_URL, "wss://api.deepgram.com/v1/listen")

    def test_host_port_override_is_allowed(self):
        os.environ["TRANSCRIPTOR_DEEPGRAM_HOST"] = "localhost:8765"
        mod = self._reload()

        self.assertEqual(mod.DEEPGRAM_REST_BASE, "https://localhost:8765/v1")
        self.assertEqual(mod.DEEPGRAM_LIVE_URL, "wss://localhost:8765/v1/listen")

    def test_scheme_or_path_override_falls_back_to_default(self):
        """A malformed override must not take the backend down.

        This module is imported transitively from ``backend.main``, so
        raising here killed the process before uvicorn started: Electron
        saw the child exit, retried eight times, and reported a generic
        "backend did not start" with no pointer to the offending env
        var. Matching ``backend.main._env_int``, the value is rejected
        with a warning and the documented default is used instead.
        """
        for value in ("https://api.deepgram.com", "api.deepgram.com/v1", "api deepgram com"):
            with self.subTest(value=value):
                os.environ["TRANSCRIPTOR_DEEPGRAM_HOST"] = value
                with self.assertLogs("backend.deepgram_endpoints", level="WARNING"):
                    mod = self._reload()
                self.assertEqual(mod.DEEPGRAM_REST_BASE, "https://api.deepgram.com/v1")
                self.assertEqual(mod.DEEPGRAM_LIVE_URL, "wss://api.deepgram.com/v1/listen")


if __name__ == "__main__":
    unittest.main()
