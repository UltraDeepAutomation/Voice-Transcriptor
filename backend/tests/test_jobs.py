import unittest

from backend.jobs import JobCancelledError, JobStore


class JobStoreCancellationTests(unittest.TestCase):
    def test_cancel_sets_terminal_state_and_event(self):
        store = JobStore(max_workers=1)
        store.create("job-1")

        job = store.cancel("job-1")

        self.assertIsNotNone(job)
        self.assertEqual(job.status, "cancelled")
        self.assertTrue(job.cancel_event.is_set())
        self.assertTrue(store.is_cancelled("job-1"))
        with self.assertRaises(JobCancelledError):
            store.raise_if_cancelled("job-1")
        store.shutdown(timeout=0.1)

    def test_cancelled_job_cannot_be_overwritten_by_worker_setters(self):
        store = JobStore(max_workers=1)
        store.create("job-1")
        store.cancel("job-1")

        store.set_running("job-1")
        store.set_progress("job-1", 0.7)
        store.set_done("job-1", {"text": "late"}, {"txt": "/tmp/late.txt"})
        store.set_error("job-1", "late error")

        job = store.get("job-1")
        self.assertIsNotNone(job)
        self.assertEqual(job.status, "cancelled")
        self.assertIsNone(job.error)
        self.assertIsNone(job.result)
        self.assertEqual(job.result_files, {})
        self.assertEqual(job.progress, 0.0)
        store.shutdown(timeout=0.1)

    def test_done_job_is_not_cancelled(self):
        store = JobStore(max_workers=1)
        store.create("job-1")
        store.set_running("job-1")
        store.set_done("job-1", {"text": "ok"}, {"txt": "/tmp/ok.txt"})

        job = store.cancel("job-1")

        self.assertIsNotNone(job)
        self.assertEqual(job.status, "done")
        self.assertFalse(job.cancel_event.is_set())
        store.shutdown(timeout=0.1)


if __name__ == "__main__":
    unittest.main()
