import unittest
from datetime import datetime, timedelta, timezone

from backend.jobs import JobCancelledError, JobStore, TERMINAL_JOB_PRUNE_GRACE


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

    def test_prune_does_not_evict_unobserved_terminal_result(self):
        store = JobStore(max_workers=1, max_jobs=1)
        store.create("job-1")
        store.set_done("job-1", {"text": "finished"}, {"txt": "/tmp/finished.txt"})

        store.create("job-2")
        store.create("job-3")

        job = store.get("job-1")
        self.assertIsNotNone(job)
        self.assertEqual(job.status, "done")
        self.assertEqual(job.result, {"text": "finished"})
        store.shutdown(timeout=0.1)

    def test_prune_keeps_recently_observed_terminal_result(self):
        store = JobStore(max_workers=1, max_jobs=1)
        store.create("job-1")
        store.set_done("job-1", {"text": "finished"}, {"txt": "/tmp/finished.txt"})
        self.assertIsNotNone(store.get("job-1"))

        store.create("job-2")
        store.create("job-3")

        self.assertIsNotNone(store.get("job-1"))
        store.shutdown(timeout=0.1)

    def test_prune_evicts_observed_terminal_result_after_grace(self):
        store = JobStore(max_workers=1, max_jobs=1)
        store.create("job-1")
        store.set_done("job-1", {"text": "finished"}, {"txt": "/tmp/finished.txt"})
        observed = store.get("job-1")
        self.assertIsNotNone(observed)
        observed.terminal_observed_at = (
            datetime.now(timezone.utc) - TERMINAL_JOB_PRUNE_GRACE - timedelta(seconds=1)
        )

        store.create("job-2")
        store.create("job-3")

        self.assertIsNone(store.get("job-1"))
        store.shutdown(timeout=0.1)


if __name__ == "__main__":
    unittest.main()
