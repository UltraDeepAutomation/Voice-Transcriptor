import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional


TERMINAL_JOB_PRUNE_GRACE = timedelta(minutes=15)


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | running | done | error | cancelled
    progress: float = 0.0
    error: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    result_files: Dict[str, str] = field(default_factory=dict)  # kind -> path
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    terminal_observed_at: Optional[datetime] = None
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)


class JobCancelledError(RuntimeError):
    """Raised by worker checkpoints when a user cancelled the job."""


class JobStore:
    def __init__(self, max_workers: int = 2, max_jobs: int = 300):
        self._lock = threading.Lock()
        self._jobs: Dict[str, Job] = {}
        self.max_workers = max_workers
        # Single field, not two. ``max_jobs`` and a private ``_max_jobs``
        # previously held the same number: ``_prune`` read the private
        # one while the public one was the documented knob, so setting
        # ``store.max_jobs`` had no effect and the two could silently
        # disagree.
        self.max_jobs = max_jobs
        self._pool = ThreadPoolExecutor(max_workers=max_workers)

    def _prune(self) -> None:
        if len(self._jobs) <= self.max_jobs:
            return
        # Never evict jobs whose worker thread is still running, whose
        # terminal state has not yet been observed by a client, or whose
        # terminal state was observed only moments ago.  Evicting any of
        # those silently loses result/download access: set_done / set_error
        # no-op on unknown ids, while the HTTP poller sees a 404 instead of
        # the terminal result it was waiting for.  The cap is deliberately
        # soft; memory is cheaper than losing a completed transcription.
        now = datetime.now(timezone.utc)
        evictable = sorted(
            [
                j
                for j in self._jobs.values()
                if j.status in ("done", "error", "cancelled")
                and j.terminal_observed_at is not None
                and (now - j.terminal_observed_at) >= TERMINAL_JOB_PRUNE_GRACE
            ],
            key=lambda j: (j.terminal_observed_at or j.created_at, j.created_at),
        )
        drop = len(self._jobs) - self.max_jobs
        for job in evictable[:drop]:
            self._jobs.pop(job.id, None)

    def create(self, job_id: str) -> Job:
        with self._lock:
            self._prune()
            job = Job(id=job_id)
            self._jobs[job_id] = job
            return job

    def get(self, job_id: str) -> Optional[Job]:
        """Return the job, marking a terminal state as client-observed.

        Invariant: the 15-minute prune grace starts at the FIRST poll
        after completion, whoever polls. Polling is therefore part of
        the lifecycle contract, not a side effect — clients must fetch
        the job they care about; a health-check that merely lists jobs
        must use a non-observing path (there is none today by design).
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if job and job.status in ("done", "error", "cancelled") and job.terminal_observed_at is None:
                job.terminal_observed_at = datetime.now(timezone.utc)
            return job

    def submit(self, fn, *args, **kwargs) -> None:
        self._pool.submit(fn, *args, **kwargs)

    # All four setters use ``.get`` + None-guard instead of bracket access.
    # _prune (invoked on every ``create``) evicts the oldest jobs when the
    # store exceeds max_jobs; a worker thread that is still updating an
    # evicted job would hit KeyError and die mid-transcription, leaving the
    # job permanently "running" from the client's perspective. Silently
    # no-op'ing on a pruned id is the correct contract here: the result is
    # already unreachable via the public ``get`` API, so there is nothing
    # to preserve.
    def set_running(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if job.status != "queued":
                return
            job.status = "running"
            job.progress = 0.01

    def set_progress(self, job_id: str, progress: float) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if job.status not in ("queued", "running"):
                return
            # Monotonic by contract (BUG-65): a late callback from a
            # superseded pipeline stage must never drag the displayed
            # percentage backwards.
            job.progress = max(job.progress, min(1.0, max(0.0, float(progress))))

    def set_done(
        self, job_id: str, result: Dict[str, Any], result_files: Dict[str, str]
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if job.status in ("cancelled", "done", "error"):
                return
            job.status = "done"
            job.progress = 1.0
            job.result = result
            job.result_files = result_files

    def set_error(self, job_id: str, error: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if job.status in ("cancelled", "done", "error"):
                return
            job.status = "error"
            job.error = error

    def cancel(self, job_id: str) -> Optional[Job]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status in ("done", "error", "cancelled"):
                return job
            job.status = "cancelled"
            job.error = None
            job.cancel_event.set()
            return job

    def is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            return bool(job and job.status == "cancelled")

    def cancel_event(self, job_id: str) -> Optional[threading.Event]:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.cancel_event if job else None

    def raise_if_cancelled(self, job_id: str) -> None:
        if self.is_cancelled(job_id):
            raise JobCancelledError("job cancelled")

    def shutdown(self, timeout: float = 20.0) -> None:
        """Gracefully stop the worker pool.

        Cancels queued-but-not-started futures (safe — they never ran,
        no state to lose) and waits up to ``timeout`` seconds for
        in-flight worker threads to drain. Called from the FastAPI
        lifespan shutdown branch so Electron's SIGTERM doesn't kill
        mid-write transcription threads and leave half-written
        ``.json`` / ``.txt`` result files on disk (which subsequently
        parse-fail on next launch and look to the user like corrupt
        recordings).

        Python's `ThreadPoolExecutor.shutdown(wait=True)` has no
        timeout parameter, so we run it in a helper thread and
        ``.join(timeout)`` instead. If in-flight work is truly wedged
        (ffmpeg stuck, CUDA hang), the helper thread is daemon so the
        process exits cleanly anyway — but we gave the good path a
        chance to finish first.
        """
        import threading as _th
        shutdown_thread = _th.Thread(
            target=lambda: self._pool.shutdown(wait=True, cancel_futures=True),
            name="job-pool-shutdown",
            daemon=True,
        )
        shutdown_thread.start()
        shutdown_thread.join(timeout=timeout)
