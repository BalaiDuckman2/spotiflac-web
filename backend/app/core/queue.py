from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from queue import Empty, Queue
from typing import Any, Literal, Optional

JobStatus = Literal["queued", "downloading", "ok", "failed", "cancelled"]


@dataclass
class Job:
    id: str
    spotify_track_id: str
    track_meta: dict[str, Any]              # DTO
    target_path: str
    services: list[str]
    quality: str
    embed_lyrics: bool
    enrich_metadata: bool
    sp_dc: str
    qobuz_token: str
    position: int
    is_album: bool
    context: dict[str, Any] = field(default_factory=dict)  # {kind, title, url}
    status: JobStatus = "queued"
    provider_used: Optional[str] = None
    error: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    files_created: list[str] = field(default_factory=list)
    cancel_requested: bool = False

    def to_dto(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "spotify_track_id": self.spotify_track_id,
            "track": {
                "title": self.track_meta.get("title"),
                "artists": self.track_meta.get("artists"),
                "album": self.track_meta.get("album"),
                "cover_url": self.track_meta.get("cover_url"),
                "duration_ms": self.track_meta.get("duration_ms"),
            },
            "target_path": self.target_path,
            "status": self.status,
            "provider_used": self.provider_used,
            "error": self.error,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "context": self.context,
            "position": self.position,
        }


class JobQueue:
    """Thread-safe FIFO queue with O(1) lookup by id."""

    def __init__(self, max_history: int = 500) -> None:
        self._q: Queue[str] = Queue()
        self._jobs: dict[str, Job] = {}
        self._history: deque[str] = deque(maxlen=max_history)
        self._lock = threading.Lock()
        self._listeners: list = []  # callable(job)

    def enqueue(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job
        self._q.put(job.id)
        self._notify(job)

    def get_next(self, timeout: float = 1.0) -> Optional[Job]:
        try:
            jid = self._q.get(timeout=timeout)
        except Empty:
            return None
        with self._lock:
            job = self._jobs.get(jid)
            if not job or job.cancel_requested:
                if job:
                    job.status = "cancelled"
                    job.finished_at = datetime.utcnow()
                    self._history.append(jid)
                self._notify(job) if job else None
                return None
            return job

    def update(self, job: Job) -> None:
        self._notify(job)

    def cancel(self, job_id: str) -> Optional[Job]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            if job.status == "queued":
                job.cancel_requested = True
                job.status = "cancelled"
                job.finished_at = datetime.utcnow()
                self._history.append(job_id)
            elif job.status == "downloading":
                job.cancel_requested = True
            return job

    def cancel_all(self) -> int:
        n = 0
        with self._lock:
            for job in self._jobs.values():
                if job.status in ("queued", "downloading"):
                    job.cancel_requested = True
                    if job.status == "queued":
                        job.status = "cancelled"
                        job.finished_at = datetime.utcnow()
                        self._history.append(job.id)
                    n += 1
        return n

    def remove(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.status != "queued":
                return False
            job.cancel_requested = True
            job.status = "cancelled"
            job.finished_at = datetime.utcnow()
            self._history.append(job_id)
            return True

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list_all(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def list_active(self) -> list[Job]:
        with self._lock:
            return [j for j in self._jobs.values() if j.status in ("queued", "downloading")]

    def prune(self, keep_recent: int = 200) -> int:
        """Drop completed/failed/cancelled beyond a recent window. Returns count removed."""
        with self._lock:
            done_ids = [
                j.id
                for j in self._jobs.values()
                if j.status in ("ok", "failed", "cancelled")
            ]
            done_ids.sort(
                key=lambda jid: self._jobs[jid].finished_at or datetime.min,
                reverse=True,
            )
            to_remove = done_ids[keep_recent:]
            for jid in to_remove:
                self._jobs.pop(jid, None)
            return len(to_remove)

    def add_listener(self, fn) -> None:
        self._listeners.append(fn)

    def _notify(self, job) -> None:
        for fn in list(self._listeners):
            try:
                fn(job)
            except Exception:
                pass


_queue: JobQueue | None = None


def get_queue() -> JobQueue:
    global _queue
    if _queue is None:
        _queue = JobQueue()
    return _queue


def make_job_id() -> str:
    return uuid.uuid4().hex[:12]
