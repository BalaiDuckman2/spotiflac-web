from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

from .concurrency import ProviderSemaphores
from .history_db import record_download
from .library import add_to_index
from .logs import emit_log
from .queue import Job, get_queue
from .settings import get_settings

logger = logging.getLogger(__name__)


def _build_payload(job: Job, provider: str) -> dict:
    return {
        "track_id": job.spotify_track_id,
        "output_path": job.target_path,
        "services": [provider],   # single provider — fallback handled by worker
        "quality": job.quality,
        "embed_lyrics": job.embed_lyrics,
        "enrich_metadata": job.enrich_metadata,
        "sp_dc": job.sp_dc,
        "qobuz_token": job.qobuz_token,
        "position": job.position,
        "is_album": job.is_album,
    }


def _spawn_subprocess(payload: dict) -> subprocess.Popen:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.core.downloader_runner"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace",
    )
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(payload))
    proc.stdin.close()
    return proc


def _cleanup_partial(files: list[str]) -> None:
    for f in files:
        try:
            p = Path(f)
            if p.exists() and p.is_file():
                p.unlink()
        except OSError:
            pass


def _run_single_provider(job: Job, provider: str) -> bool:
    """Spawn one subprocess for `provider`. Update job state. Return True on success.

    On success: job.target_path, job.provider_used updated; history/library indexed.
    On failure: job.error is set; caller decides whether to try the next provider.
    """
    payload = _build_payload(job, provider)
    proc = _spawn_subprocess(payload)
    job._proc = proc

    last_error: str | None = None
    final_path: str | None = None
    files_started: list[str] = []

    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                emit_log("debug", f"runner: {line}")
                continue

            etype = event.get("type")
            if etype == "start":
                f = event.get("file")
                if f:
                    files_started.append(f)
                    if f not in job.files_created:
                        job.files_created.append(f)
            elif etype == "done":
                final_path = event.get("path") or job.target_path
                if final_path and final_path not in job.files_created:
                    job.files_created.append(final_path)
            elif etype == "error":
                last_error = event.get("msg") or last_error

            if job.cancel_requested:
                emit_log("warn", f"cancel requested for {job.id}")
                proc.terminate()
                break

        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
    except Exception as e:
        logger.exception("runner error")
        last_error = str(e)
        try:
            proc.kill()
        except Exception:
            pass
    finally:
        job._proc = None

    if job.cancel_requested:
        return False  # caller will mark cancelled

    if proc.returncode == 0 and final_path and Path(final_path).exists():
        job.target_path = final_path
        job.provider_used = provider
        add_to_index(Path(final_path))
        record_download(
            spotify_track_id=job.spotify_track_id,
            track=job.track_meta,
            file_path=final_path,
            provider=provider,
            context=job.context,
        )
        emit_log("info", f"done {job.track_meta.get('title')} via {provider}")
        return True

    job.error = last_error or f"exit code {proc.returncode}"
    _cleanup_partial(files_started)
    emit_log("warn", f"provider {provider} failed for {job.id}: {job.error}")
    return False


def _process_job(job: Job, sems: ProviderSemaphores) -> None:
    q = get_queue()
    job.status = "downloading"
    job.started_at = datetime.utcnow()
    cancel_event = threading.Event()
    job._cancel_event = cancel_event
    q.update(job)
    emit_log("info", f"start {job.track_meta.get('title')} → {job.target_path}")

    try:
        for provider in list(job.services):
            if job.cancel_requested:
                break
            if not sems.acquire(provider, cancel_event):
                break  # cancelled while waiting
            try:
                if job.cancel_requested:
                    # Cancel arrived between sem.acquire returning True and us
                    # checking. Release the slot and exit the fallback loop.
                    break
                ok = _run_single_provider(job, provider)
                if ok:
                    job.status = "ok"
                    return
                if job.cancel_requested:
                    break
            finally:
                sems.release(provider)

        if job.cancel_requested:
            job.status = "cancelled"
            _cleanup_partial(job.files_created)
            emit_log("warn", f"cancelled {job.id}")
        else:
            job.status = "failed"
            if not job.error:
                job.error = "all providers failed"
            _cleanup_partial(job.files_created)
            emit_log("error", f"failed {job.id}: {job.error}")
    finally:
        job.finished_at = datetime.utcnow()
        job._cancel_event = None
        q.update(job)


class _Worker(threading.Thread):
    def __init__(self, pool: "WorkerPool", index: int) -> None:
        super().__init__(name=f"downloader-worker-{index}", daemon=True)
        self._pool = pool
        self._stop = threading.Event()

    def request_stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        q = get_queue()
        while not self._stop.is_set():
            job = q.get_next(timeout=1.0)
            if job is None:
                continue
            try:
                _process_job(job, self._pool._sems)
            except Exception:
                logger.exception("unexpected job error")
                job.status = "failed"
                job.error = "internal worker error"
                job.finished_at = datetime.utcnow()
                q.update(job)


class WorkerPool:
    """N daemon worker threads sharing a JobQueue and ProviderSemaphores."""

    def __init__(self, total: int, sems: ProviderSemaphores) -> None:
        self._total = total
        self._sems = sems
        self._workers: list[_Worker] = []
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            for i in range(self._total):
                w = _Worker(self, len(self._workers) + i)
                w.start()
                self._workers.append(w)

    def stop(self) -> None:
        with self._lock:
            for w in self._workers:
                w.request_stop()
            workers = list(self._workers)
            self._workers.clear()
        for w in workers:
            w.join(timeout=5.0)

    def resize(self, new_total: int) -> None:
        with self._lock:
            current = len(self._workers)
            if new_total > current:
                for i in range(new_total - current):
                    w = _Worker(self, current + i)
                    w.start()
                    self._workers.append(w)
            elif new_total < current:
                # Flag the trailing workers to exit after their current job.
                to_stop = self._workers[new_total:]
                self._workers = self._workers[:new_total]
                for w in to_stop:
                    w.request_stop()
            self._total = new_total

    def active_count(self) -> int:
        with self._lock:
            return len([w for w in self._workers if w.is_alive()])


# --- Module-level singletons (kept for compatibility with main.py) ---

_pool: WorkerPool | None = None
_sems: ProviderSemaphores | None = None


def get_semaphores() -> ProviderSemaphores:
    global _sems
    if _sems is None:
        _sems = ProviderSemaphores(get_settings().general.concurrency_per_provider)
    return _sems


def get_pool() -> WorkerPool | None:
    return _pool


def start_worker() -> None:
    """Compat entrypoint: starts the WorkerPool with current settings."""
    global _pool, _sems
    if _pool is not None:
        return
    s = get_settings().general
    _sems = ProviderSemaphores(s.concurrency_per_provider)
    _pool = WorkerPool(total=s.concurrency_total, sems=_sems)
    _pool.start()


def stop_worker() -> None:
    global _pool, _sems
    if _pool is not None:
        _pool.stop()
        _pool = None
    _sems = None
