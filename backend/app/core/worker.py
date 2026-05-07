from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

from .history_db import record_download
from .library import add_to_index
from .logs import emit_log
from .queue import Job, get_queue
from .settings import MUSIC_DIR

logger = logging.getLogger(__name__)


def _build_payload(job: Job) -> dict:
    return {
        "track_id": job.spotify_track_id,
        "output_path": job.target_path,
        "services": job.services,
        "quality": job.quality,
        "embed_lyrics": job.embed_lyrics,
        "enrich_metadata": job.enrich_metadata,
        "sp_dc": job.sp_dc,
        "qobuz_token": job.qobuz_token,
        "position": job.position,
        "is_album": job.is_album,
    }


def _spawn_subprocess(payload: dict) -> subprocess.Popen:
    """Run downloader_runner.py as a subprocess.

    Using `python -m app.core.downloader_runner` keeps imports relative-safe
    and works on Windows (spawn) and Linux (fork).
    """
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


def _process_job(job: Job) -> None:
    q = get_queue()
    job.status = "downloading"
    job.started_at = datetime.utcnow()
    q.update(job)
    emit_log("info", f"start {job.track_meta.get('title')} → {job.target_path}")

    payload = _build_payload(job)
    proc = _spawn_subprocess(payload)

    last_provider: str | None = None
    last_error: str | None = None
    final_path: str | None = None

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
                    job.files_created.append(f)
            elif etype == "provider":
                last_provider = event.get("name") or last_provider
            elif etype == "done":
                final_path = event.get("path") or job.target_path
                job.provider_used = event.get("provider") or last_provider
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
        logger.exception("worker error")
        last_error = str(e)
        try:
            proc.kill()
        except Exception:
            pass

    job.finished_at = datetime.utcnow()

    if job.cancel_requested:
        job.status = "cancelled"
        _cleanup_partial(job.files_created)
        emit_log("warn", f"cancelled {job.id}")
    elif proc.returncode == 0 and final_path and Path(final_path).exists():
        job.status = "ok"
        job.target_path = final_path
        add_to_index(Path(final_path))
        record_download(
            spotify_track_id=job.spotify_track_id,
            track=job.track_meta,
            file_path=final_path,
            provider=job.provider_used or "unknown",
            context=job.context,
        )
        emit_log("info", f"done {job.track_meta.get('title')} via {job.provider_used}")
    else:
        job.status = "failed"
        job.error = last_error or f"exit code {proc.returncode}"
        _cleanup_partial(job.files_created)
        emit_log("error", f"failed {job.id}: {job.error}")

    q.update(job)


class Worker(threading.Thread):
    def __init__(self) -> None:
        super().__init__(name="downloader-worker", daemon=True)
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        q = get_queue()
        while not self._stop.is_set():
            job = q.get_next(timeout=1.0)
            if job is None:
                continue
            try:
                _process_job(job)
            except Exception:
                logger.exception("unexpected job error")
                job.status = "failed"
                job.error = "internal worker error"
                job.finished_at = datetime.utcnow()
                q.update(job)


_worker: Worker | None = None


def start_worker() -> None:
    global _worker
    if _worker and _worker.is_alive():
        return
    _worker = Worker()
    _worker.start()


def stop_worker() -> None:
    global _worker
    if _worker:
        _worker.stop()
