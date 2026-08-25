"""main.log must stay readable enough to diagnose a real report.

Measured on a real 42 833-line archive: 29.5 % of it was
``GET /api/health``, another 29.5 % ``GET /api/network`` and 15.5 %
``PUT /api/ui/live-draft`` — three quarters of the support log was the
renderer confirming on a timer that nothing had changed, while the 135
recordings actually saved made up 0.3 %.

The filter mutes exactly one thing: a SUCCESSFUL request to a path the
UI polls. A failing poll is the most interesting line in the file, so it
survives, as does every non-polled endpoint.
"""

import logging
import unittest

from backend.main import _ACCESS_LOG_POLLED_PATHS, _MutedPollingAccessFilter


def _record(path: str, status: int, method: str = "GET") -> logging.LogRecord:
    """Build a record shaped like uvicorn.access emits."""
    record = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:1234", method, path, "1.1", status),
        exc_info=None,
    )
    return record


class AccessLogFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.filter = _MutedPollingAccessFilter()

    def test_successful_polls_are_dropped(self) -> None:
        for path in _ACCESS_LOG_POLLED_PATHS:
            with self.subTest(path=path):
                self.assertFalse(self.filter.filter(_record(path, 200)))

    def test_a_failing_poll_is_kept(self) -> None:
        # A wedged backend answering /api/health with 500 is the single
        # most useful line in the file.
        for status in (400, 401, 404, 500, 503):
            with self.subTest(status=status):
                self.assertTrue(self.filter.filter(_record("/api/health", status)))

    def test_redirects_are_kept(self) -> None:
        self.assertTrue(self.filter.filter(_record("/api/health", 307)))

    def test_query_strings_do_not_defeat_the_match(self) -> None:
        self.assertFalse(self.filter.filter(_record("/api/health?probe=1", 200)))

    def test_unpolled_endpoints_are_always_kept(self) -> None:
        for path in (
            "/api/recordings",
            "/api/recordings/save-with-audio",
            "/api/transcribe/warmup",
            "/api/models/local/small/download",
            "/api/live/recoveries",
        ):
            with self.subTest(path=path):
                self.assertTrue(self.filter.filter(_record(path, 200)))

    def test_a_polled_prefix_is_not_a_polled_path(self) -> None:
        # Substring matching would silence the download and delete
        # routes along with the list they hang off.
        self.assertTrue(self.filter.filter(_record("/api/models/local/tiny", 200)))

    def test_records_of_another_shape_pass_through(self) -> None:
        # A filter must never be the reason a log line disappears.
        odd = logging.LogRecord(
            name="uvicorn.access", level=logging.INFO, pathname=__file__,
            lineno=1, msg="something else", args=None, exc_info=None,
        )
        self.assertTrue(self.filter.filter(odd))

        short = logging.LogRecord(
            name="uvicorn.access", level=logging.INFO, pathname=__file__,
            lineno=1, msg="%s %s", args=("a", "b"), exc_info=None,
        )
        self.assertTrue(self.filter.filter(short))

    def test_non_numeric_status_passes_through(self) -> None:
        record = _record("/api/health", 200)
        record.args = ("127.0.0.1:1", "GET", "/api/health", "1.1", "not-a-status")
        self.assertTrue(self.filter.filter(record))

    def test_non_string_path_passes_through(self) -> None:
        record = _record("/api/health", 200)
        record.args = ("127.0.0.1:1", "GET", None, "1.1", 200)
        self.assertTrue(self.filter.filter(record))

    def test_the_filter_is_installed_exactly_once(self) -> None:
        installed = [
            f for f in logging.getLogger("uvicorn.access").filters
            if isinstance(f, _MutedPollingAccessFilter)
        ]
        self.assertEqual(len(installed), 1)


if __name__ == "__main__":
    unittest.main()
