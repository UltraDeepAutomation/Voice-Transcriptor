"""The upload/from-path pipeline must leave a record.

Two stretches of the transcription pipeline produced no log line at all:

* ``backend/jobs.py`` had no logger. The only trace of an upload job in
  main.log was the uvicorn access line for the POST that created it —
  not whether it started, how long it ran, what it produced, or why it
  stopped. A user reporting "I dropped in a file and nothing came out"
  produced a support log with nothing to read.
* ``backend/audio.py`` logged ffmpeg FAILURES only. Decoding the source
  is the heaviest step in the pipeline, and a slow import was
  indistinguishable in the log from a fast one — or from none at all.

Both are now recorded at the one place every caller passes through, so a
new call site cannot ship silent.
"""

import logging
import unittest
from datetime import datetime, timedelta, timezone

from backend.audio import _describe_ffmpeg_file, _ffmpeg_io_paths
from backend.jobs import JobStore


class JobLifecycleLoggingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = JobStore(max_workers=1)

    def tearDown(self) -> None:
        self.store.shutdown(timeout=0.1)

    def test_start_records_the_queue_wait(self) -> None:
        # Queue wait separates "the app is slow" from "the pool is
        # saturated", and is not recoverable after the fact.
        self.store.create("j1")
        with self.assertLogs("backend.jobs", level="INFO") as captured:
            self.store.set_running("j1")
        self.assertIn("job start: id=j1", captured.output[0])
        self.assertIn("queued_ms=", captured.output[0])

    def test_done_records_duration_and_text_length(self) -> None:
        # A job that "succeeded" with empty text is a different outcome
        # from one that produced words; the two were indistinguishable.
        self.store.create("j2")
        self.store.set_running("j2")
        with self.assertLogs("backend.jobs", level="INFO") as captured:
            self.store.set_done("j2", {"text": "hello there"}, {"txt": "/tmp/a.txt"})
        line = captured.output[-1]
        self.assertIn("job done: id=j2", line)
        self.assertIn("text_len=11", line)
        self.assertIn("files=txt", line)
        self.assertIn("ran_ms=", line)

    def test_an_empty_result_is_visible_as_such(self) -> None:
        self.store.create("j3")
        self.store.set_running("j3")
        with self.assertLogs("backend.jobs", level="INFO") as captured:
            self.store.set_done("j3", {"text": ""}, {})
        self.assertIn("text_len=0", captured.output[-1])
        self.assertIn("files=-", captured.output[-1])

    def test_failure_is_a_warning_carrying_the_reason(self) -> None:
        # WARNING so it stands out from the per-job success records —
        # this is the line a support reader is looking for.
        self.store.create("j4")
        self.store.set_running("j4")
        with self.assertLogs("backend.jobs", level="WARNING") as captured:
            self.store.set_error("j4", "ffmpeg failed to convert audio")
        line = captured.output[-1]
        self.assertTrue(line.startswith("WARNING"))
        self.assertIn("job failed: id=j4", line)
        self.assertIn("ffmpeg failed to convert audio", line)
        self.assertIn("progress=", line)

    def test_cancel_records_how_far_it_got(self) -> None:
        # 0.02 is a user changing their mind; 0.95 is a user who gave up
        # waiting. The log has to tell them apart.
        self.store.create("j5")
        self.store.set_running("j5")
        self.store.set_progress("j5", 0.95)
        with self.assertLogs("backend.jobs", level="INFO") as captured:
            self.store.cancel("j5")
        self.assertIn("job cancelled: id=j5", captured.output[-1])
        self.assertIn("progress=0.95", captured.output[-1])

    def test_a_transition_that_no_ops_logs_nothing(self) -> None:
        # set_done on an already-terminal job is a documented no-op; it
        # must not emit a second completion record.
        self.store.create("j6")
        self.store.set_running("j6")
        self.store.set_done("j6", {"text": "x"}, {})
        logger = logging.getLogger("backend.jobs")
        with self.assertNoLogs(logger, level="INFO"):
            self.store.set_done("j6", {"text": "y"}, {})
            self.store.set_error("j6", "late")
        self.assertEqual(self.store.get("j6").result["text"], "x")

    def test_an_unknown_job_id_logs_nothing(self) -> None:
        logger = logging.getLogger("backend.jobs")
        with self.assertNoLogs(logger, level="INFO"):
            self.store.set_running("missing")
            self.store.set_done("missing", {"text": "x"}, {})
            self.store.cancel("missing")

    def test_started_at_is_recorded_on_the_job(self) -> None:
        self.store.create("j7")
        before = datetime.now(timezone.utc)
        self.store.set_running("j7")
        job = self.store.get("j7")
        self.assertIsNotNone(job.started_at)
        self.assertGreaterEqual(job.started_at, before - timedelta(seconds=1))


class FfmpegLogFieldTests(unittest.TestCase):
    def test_io_paths_are_read_back_from_the_argv(self) -> None:
        # Every command in the module is built in this shape, so reading
        # it back beats threading two parameters through six call sites.
        cmd = ["ffmpeg", "-y", "-i", "/tmp/in.mp4", "-ar", "16000", "/tmp/out.wav"]
        self.assertEqual(_ffmpeg_io_paths(cmd), ("/tmp/in.mp4", "/tmp/out.wav"))

    def test_io_paths_degrade_instead_of_raising(self) -> None:
        # This feeds a log line and must never be able to fail a
        # conversion.
        self.assertEqual(_ffmpeg_io_paths([]), (None, None))
        self.assertEqual(_ffmpeg_io_paths(["ffmpeg", "-i"]), (None, None))
        self.assertEqual(_ffmpeg_io_paths(["ffmpeg", "-version"])[1], None)

    def test_describe_reports_name_and_size(self) -> None:
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as fh:
            fh.write(b"0123456789")
            path = fh.name
        try:
            self.assertEqual(
                _describe_ffmpeg_file(path), f"{os.path.basename(path)}(10B)"
            )
        finally:
            os.unlink(path)

    def test_describe_survives_a_missing_file(self) -> None:
        self.assertEqual(_describe_ffmpeg_file("/nope/gone.wav"), "gone.wav")
        self.assertEqual(_describe_ffmpeg_file(None), "?")


if __name__ == "__main__":
    unittest.main()
