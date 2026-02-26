import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Optional


@dataclass
class Job:
    id: str
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    error: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    result_files: Dict[str, str] = field(default_factory=dict)  # kind -> path
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class JobStore:
    def __init__(self, max_workers: int = 2, max_jobs: int = 300):
        self._lock = threading.Lock()
        self._jobs: Dict[str, Job] = {}
        self._pool = ThreadPoolExecutor(max_workers=max_workers)
        self._max_jobs = max_jobs

    def _prune(self) -> None:
        if len(self._jobs) <= self._max_jobs:
            return
        ordered = sorted(self._jobs.values(), key=lambda j: j.created_at)
        drop = len(self._jobs) - self._max_jobs
        for job in ordered[:drop]:
            self._jobs.pop(job.id, None)

    def create(self, job_id: str) -> Job:
        with self._lock:
            self._prune()
            job = Job(id=job_id)
            self._jobs[job_id] = job
            return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def submit(self, fn, *args, **kwargs) -> None:
        self._pool.submit(fn, *args, **kwargs)

    def set_running(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.status = "running"
            job.progress = 0.01

    def set_progress(self, job_id: str, progress: float) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.progress = max(0.0, min(1.0, float(progress)))

    def set_done(
        self, job_id: str, result: Dict[str, Any], result_files: Dict[str, str]
    ) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.status = "done"
            job.progress = 1.0
            job.result = result
            job.result_files = result_files

    def set_error(self, job_id: str, error: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.status = "error"
            job.error = error
