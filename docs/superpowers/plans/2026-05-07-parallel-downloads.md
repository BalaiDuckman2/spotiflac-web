# Parallel Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-threaded download worker with a thread pool of N workers that respects a per-provider concurrency cap. Both limits are configurable from the Settings UI and resize live.

**Architecture:** A `WorkerPool` of N daemon threads pulls from the existing `JobQueue`. Each worker, for each job, walks `job.services` and acquires a `ProviderSemaphores` slot for each provider before spawning a single-provider subprocess. Per-provider fallback moves from inside the subprocess to the worker loop, which makes the per-provider cap strict.

**Tech Stack:** Python 3.11, FastAPI, threading + multiprocessing.Queue (already in `queue.py`), Pydantic v2, React + Vite + Tailwind.

**Reference spec:** `docs/superpowers/specs/2026-05-07-parallel-downloads-design.md`

---

## File Structure

| File | Role |
|------|------|
| `backend/app/core/settings.py` | **Modify** — add 2 fields on `GeneralSettings` |
| `backend/app/core/concurrency.py` | **Create** — `ProviderSemaphores` |
| `backend/app/core/worker.py` | **Modify** — replace `Worker` with `WorkerPool`, refactor `_process_job` |
| `backend/app/api/settings.py` | **Modify** — call resize on PUT |
| `backend/app/main.py` | **Modify** — wire `WorkerPool` startup/teardown |
| `backend/tests/test_concurrency.py` | **Create** — semaphores + pool unit tests |
| `backend/tests/test_worker_pool.py` | **Create** — fallback + cancel + speedup tests |
| `backend/tests/test_settings.py` | **Modify** — assert defaults + validators |
| `frontend/src/lib/api.ts` | **Modify** — add 2 fields on `SettingsDTO['general']` |
| `frontend/src/pages/Settings.tsx` | **Modify** — add Performance section in `GeneralTab` |
| `README.md` | **Modify** — document new env-effective settings |

---

## Task 1: Add concurrency fields to settings

**Files:**
- Modify: `backend/app/core/settings.py:27-38` (the `GeneralSettings` class)
- Modify: `backend/tests/test_settings.py`

- [ ] **Step 1.1: Write the failing test**

Append to `backend/tests/test_settings.py`:

```python
import pytest
from pydantic import ValidationError

from app.core.settings import GeneralSettings, Settings


def test_concurrency_defaults():
    g = GeneralSettings()
    assert g.concurrency_total == 4
    assert g.concurrency_per_provider == 2


def test_concurrency_bounds():
    with pytest.raises(ValidationError):
        GeneralSettings(concurrency_total=0)
    with pytest.raises(ValidationError):
        GeneralSettings(concurrency_total=17)
    with pytest.raises(ValidationError):
        GeneralSettings(concurrency_per_provider=0)
    with pytest.raises(ValidationError):
        GeneralSettings(concurrency_per_provider=9)


def test_settings_loads_existing_json_without_concurrency_fields(tmp_path, monkeypatch):
    """Existing settings.json without the new fields should still load (backward compat)."""
    monkeypatch.setattr("app.core.settings.CONFIG_DIR", tmp_path)
    monkeypatch.setattr("app.core.settings.SETTINGS_PATH", tmp_path / "settings.json")
    (tmp_path / "settings.json").write_text(
        '{"general": {"providers": ["tidal"], "quality": "LOSSLESS"}, "file_management": {}}',
        encoding="utf-8",
    )
    from app.core.settings import load_settings
    s = load_settings()
    assert s.general.concurrency_total == 4
    assert s.general.concurrency_per_provider == 2
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
cd backend && pytest tests/test_settings.py::test_concurrency_defaults -v
```

Expected: FAIL with `AttributeError: 'GeneralSettings' object has no attribute 'concurrency_total'`.

- [ ] **Step 1.3: Add the fields**

In `backend/app/core/settings.py`, modify the import line at the top:

```python
from pydantic import BaseModel, Field
```

becomes:

```python
from pydantic import BaseModel, Field
```

(no change — already correct)

Then modify the `GeneralSettings` class (around line 27) to add two fields right after `qobuz_token`:

```python
class GeneralSettings(BaseModel):
    providers: list[Provider] = Field(default_factory=lambda: ["tidal", "qobuz", "amazon"])
    quality: Quality = "LOSSLESS"
    accent: str = "yellow"
    font: str = "Google Sans"
    sound_effects: bool = True
    embed_lyrics: bool = True
    embed_max_quality_cover: bool = True
    embed_genre: bool = True
    sp_dc: str = ""
    qobuz_token: str = ""
    concurrency_total: int = Field(default=4, ge=1, le=16)
    concurrency_per_provider: int = Field(default=2, ge=1, le=8)
```

- [ ] **Step 1.4: Run all settings tests**

```bash
cd backend && pytest tests/test_settings.py -v
```

Expected: all PASS.

- [ ] **Step 1.5: Commit**

```bash
git add backend/app/core/settings.py backend/tests/test_settings.py
git commit -m "feat(settings): add concurrency_total and concurrency_per_provider"
```

---

## Task 2: Create `ProviderSemaphores`

**Files:**
- Create: `backend/app/core/concurrency.py`
- Create: `backend/tests/test_concurrency.py`

- [ ] **Step 2.1: Write the failing tests**

Create `backend/tests/test_concurrency.py`:

```python
import threading
import time

import pytest

from app.core.concurrency import ProviderSemaphores


def test_acquire_release_basic():
    sems = ProviderSemaphores(per_provider=2)
    assert sems.acquire("tidal", threading.Event()) is True
    assert sems.acquire("tidal", threading.Event()) is True
    sems.release("tidal")
    sems.release("tidal")


def test_acquire_blocks_when_full():
    sems = ProviderSemaphores(per_provider=1)
    sems.acquire("tidal", threading.Event())

    acquired_at = []

    def worker():
        sems.acquire("tidal", threading.Event())
        acquired_at.append(time.monotonic())

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.2)
    assert acquired_at == []  # still blocked
    release_at = time.monotonic()
    sems.release("tidal")
    t.join(timeout=2.0)
    assert acquired_at, "second acquire should have completed"
    assert acquired_at[0] >= release_at - 0.05


def test_acquire_returns_false_when_cancelled():
    sems = ProviderSemaphores(per_provider=1)
    sems.acquire("tidal", threading.Event())  # saturate

    cancel = threading.Event()
    result = []

    def worker():
        result.append(sems.acquire("tidal", cancel, poll_s=0.05))

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.15)
    cancel.set()
    t.join(timeout=1.0)
    assert result == [False]


def test_resize_grow_unblocks_waiters():
    sems = ProviderSemaphores(per_provider=1)
    sems.acquire("tidal", threading.Event())

    acquired = []

    def worker():
        acquired.append(sems.acquire("tidal", threading.Event(), poll_s=0.05))

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.15)
    assert acquired == []
    sems.resize(2)
    t.join(timeout=1.0)
    assert acquired == [True]


def test_resize_shrink_does_not_revoke_existing():
    """Workers holding old slots keep them; new acquires use new cap."""
    sems = ProviderSemaphores(per_provider=4)
    for _ in range(4):
        sems.acquire("tidal", threading.Event())
    sems.resize(2)
    # Old holders still hold their 4 slots; release them.
    for _ in range(4):
        sems.release("tidal")
    # Now new cap of 2 is in effect.
    assert sems.acquire("tidal", threading.Event()) is True
    assert sems.acquire("tidal", threading.Event()) is True

    cancel = threading.Event()
    result = []

    def worker():
        result.append(sems.acquire("tidal", cancel, poll_s=0.05))

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    time.sleep(0.2)
    cancel.set()
    t.join(timeout=1.0)
    assert result == [False]  # blocked because new cap is 2
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
cd backend && pytest tests/test_concurrency.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.core.concurrency'`.

- [ ] **Step 2.3: Implement `ProviderSemaphores`**

Create `backend/app/core/concurrency.py`:

```python
from __future__ import annotations

import threading
from typing import Dict


class ProviderSemaphores:
    """Per-provider concurrency cap.

    Each provider name maps to a BoundedSemaphore. `acquire` is cancellable:
    callers pass an `Event` that will short-circuit the wait loop. `resize`
    swaps the underlying semaphores in-place; workers holding old slots
    continue to hold them until they release, but new acquires use the new
    cap.
    """

    def __init__(self, per_provider: int) -> None:
        self._per_provider = per_provider
        self._sems: Dict[str, threading.BoundedSemaphore] = {}
        self._lock = threading.Lock()

    def _get_or_create(self, provider: str) -> threading.BoundedSemaphore:
        with self._lock:
            sem = self._sems.get(provider)
            if sem is None:
                sem = threading.BoundedSemaphore(self._per_provider)
                self._sems[provider] = sem
            return sem

    def acquire(
        self,
        provider: str,
        cancel_event: threading.Event,
        poll_s: float = 0.5,
    ) -> bool:
        """Block until a slot is free for `provider` OR `cancel_event` is set.

        Returns True on acquisition, False if cancelled before acquiring.
        """
        sem = self._get_or_create(provider)
        while not cancel_event.is_set():
            if sem.acquire(timeout=poll_s):
                return True
        return False

    def release(self, provider: str) -> None:
        with self._lock:
            sem = self._sems.get(provider)
        if sem is not None:
            try:
                sem.release()
            except ValueError:
                # Released more than acquired — ignore (resize edge case).
                pass

    def resize(self, new_per_provider: int) -> None:
        """Swap all semaphores to the new cap. Old slot holders keep their slots."""
        with self._lock:
            self._per_provider = new_per_provider
            self._sems = {
                name: threading.BoundedSemaphore(new_per_provider)
                for name in self._sems
            }
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
cd backend && pytest tests/test_concurrency.py -v
```

Expected: all 5 PASS.

- [ ] **Step 2.5: Commit**

```bash
git add backend/app/core/concurrency.py backend/tests/test_concurrency.py
git commit -m "feat(concurrency): ProviderSemaphores with cancellable acquire and live resize"
```

---

## Task 3: Refactor `_process_job` to per-provider loop

This is the largest task. We're moving the provider fallback chain from inside the subprocess to the worker, and adding the semaphore-acquire/release wrap.

**Files:**
- Modify: `backend/app/core/worker.py`
- Modify: `backend/app/core/queue.py` (add `_cancel_event` and `_proc` fields to `Job`)
- Create: `backend/tests/test_worker_pool.py`

- [ ] **Step 3.1: Add private fields to `Job` dataclass**

In `backend/app/core/queue.py`, modify the `Job` dataclass (around line 16) to add two private runtime fields. After `cancel_requested: bool = False`:

```python
    cancel_requested: bool = False
    # Runtime-only (not in DTO). Set by worker; used by cancel().
    _cancel_event: object = field(default=None, repr=False, compare=False)
    _proc: object = field(default=None, repr=False, compare=False)
```

(Use `object` to avoid a hard `threading`/`subprocess` import in `queue.py`.)

- [ ] **Step 3.2: Modify `JobQueue.cancel` to wake waiters and terminate subprocess**

In `backend/app/core/queue.py`, modify `cancel` (around lines 95-107):

```python
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
                # Wake any worker blocked on a provider semaphore.
                ev = job._cancel_event
                if ev is not None:
                    try:
                        ev.set()
                    except Exception:
                        pass
                # Terminate the running subprocess if any.
                proc = job._proc
                if proc is not None:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
            return job
```

Apply the same `ev.set()` + `proc.terminate()` block in `cancel_all` for any job in `downloading`:

```python
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
                    else:
                        ev = job._cancel_event
                        if ev is not None:
                            try:
                                ev.set()
                            except Exception:
                                pass
                        proc = job._proc
                        if proc is not None:
                            try:
                                proc.terminate()
                            except Exception:
                                pass
                    n += 1
        return n
```

- [ ] **Step 3.3: Write the failing worker-pool tests**

Create `backend/tests/test_worker_pool.py`:

```python
"""Tests for WorkerPool — uses a fake subprocess factory so no real spawns occur."""
from __future__ import annotations

import threading
import time
from unittest.mock import patch

import pytest

from app.core.concurrency import ProviderSemaphores
from app.core.queue import Job, JobQueue, make_job_id
from app.core.worker import WorkerPool


def _make_job(services=None, **overrides) -> Job:
    base = dict(
        id=make_job_id(),
        spotify_track_id="abc",
        track_meta={"title": "T", "artists": "A", "album": "Al", "duration_ms": 1},
        target_path="/tmp/T.flac",
        services=list(services or ["tidal"]),
        quality="LOSSLESS",
        embed_lyrics=False,
        enrich_metadata=False,
        sp_dc="",
        qobuz_token="",
        position=1,
        is_album=False,
    )
    base.update(overrides)
    return Job(**base)


class FakeRunner:
    """Replaces _run_single_provider. Records calls and simulates outcomes."""

    def __init__(self):
        self.active_per_provider: dict[str, int] = {}
        self.peak_per_provider: dict[str, int] = {}
        self.calls: list[tuple[str, str]] = []  # (job_id, provider)
        self._lock = threading.Lock()
        self.fail_providers: set[str] = set()
        self.delay_s: float = 0.05

    def __call__(self, job, provider):
        with self._lock:
            self.active_per_provider[provider] = self.active_per_provider.get(provider, 0) + 1
            self.peak_per_provider[provider] = max(
                self.peak_per_provider.get(provider, 0),
                self.active_per_provider[provider],
            )
            self.calls.append((job.id, provider))
        try:
            time.sleep(self.delay_s)
            if provider in self.fail_providers:
                return False
            return True
        finally:
            with self._lock:
                self.active_per_provider[provider] -= 1


@pytest.fixture
def setup(monkeypatch):
    q = JobQueue()
    sems = ProviderSemaphores(per_provider=2)
    runner = FakeRunner()

    monkeypatch.setattr("app.core.worker.get_queue", lambda: q)
    monkeypatch.setattr("app.core.worker._run_single_provider", runner)

    yield q, sems, runner


def _wait_for(predicate, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_pool_speedup(setup):
    q, sems, runner = setup
    pool = WorkerPool(total=4, sems=sems)
    pool.start()
    try:
        runner.delay_s = 0.1
        jobs = [_make_job(services=["tidal", "qobuz", "amazon"]) for _ in range(8)]
        # Spread across providers so per-provider cap (2) is not the bottleneck.
        for i, j in enumerate(jobs):
            j.services = [["tidal", "qobuz", "amazon", "spoti"][i % 4]]
            sems._get_or_create(j.services[0])  # ensure sem exists
            q.enqueue(j)
        start = time.monotonic()
        assert _wait_for(lambda: all(j.status == "ok" for j in jobs), timeout=2.0)
        elapsed = time.monotonic() - start
        # Sequential would be 8 * 0.1 = 0.8s. With 4 workers, ~0.2s plus overhead.
        assert elapsed < 0.6, f"expected <0.6s with pool of 4, got {elapsed:.3f}s"
    finally:
        pool.stop()


def test_per_provider_cap_strict(setup):
    q, sems, runner = setup
    pool = WorkerPool(total=4, sems=sems)
    pool.start()
    try:
        runner.delay_s = 0.1
        jobs = [_make_job(services=["tidal"]) for _ in range(6)]
        for j in jobs:
            q.enqueue(j)
        assert _wait_for(lambda: all(j.status == "ok" for j in jobs), timeout=3.0)
        assert runner.peak_per_provider["tidal"] <= 2
    finally:
        pool.stop()


def test_provider_fallback(setup):
    q, sems, runner = setup
    runner.fail_providers = {"tidal"}
    pool = WorkerPool(total=1, sems=sems)
    pool.start()
    try:
        j = _make_job(services=["tidal", "qobuz"])
        q.enqueue(j)
        assert _wait_for(lambda: j.status in ("ok", "failed"), timeout=2.0)
        assert j.status == "ok"
        assert j.provider_used == "qobuz"
        # Both providers were attempted.
        providers_attempted = [p for (_, p) in runner.calls if _ == j.id]
        assert providers_attempted == ["tidal", "qobuz"]
    finally:
        pool.stop()


def test_all_providers_fail_marks_failed(setup):
    q, sems, runner = setup
    runner.fail_providers = {"tidal", "qobuz"}
    pool = WorkerPool(total=1, sems=sems)
    pool.start()
    try:
        j = _make_job(services=["tidal", "qobuz"])
        q.enqueue(j)
        assert _wait_for(lambda: j.status in ("ok", "failed"), timeout=2.0)
        assert j.status == "failed"
    finally:
        pool.stop()


def test_resize_grow(setup):
    q, sems, runner = setup
    pool = WorkerPool(total=1, sems=sems)
    pool.start()
    try:
        runner.delay_s = 0.2
        jobs = [_make_job(services=[p]) for p in ["tidal", "qobuz", "amazon", "spoti"]]
        for j in jobs:
            q.enqueue(j)
        time.sleep(0.05)
        pool.resize(4)
        assert _wait_for(lambda: all(j.status == "ok" for j in jobs), timeout=1.5)
    finally:
        pool.stop()


def test_resize_shrink(setup):
    q, sems, runner = setup
    pool = WorkerPool(total=4, sems=sems)
    pool.start()
    try:
        # Let pool settle.
        time.sleep(0.05)
        pool.resize(2)
        # Wait for shrink to take effect (workers exit between jobs).
        assert _wait_for(lambda: pool.active_count() == 2, timeout=2.0)
    finally:
        pool.stop()


def test_cancel_during_acquire_does_not_hang(setup):
    q, sems, runner = setup
    runner.delay_s = 0.5
    pool = WorkerPool(total=2, sems=sems)
    pool.start()
    try:
        # Saturate Tidal cap (2).
        blockers = [_make_job(services=["tidal"]) for _ in range(2)]
        for b in blockers:
            q.enqueue(b)
        time.sleep(0.1)  # let blockers grab their sema

        # Add a 3rd Tidal job — will wait for sema.
        # But pool is also size 2, so this 3rd job won't even be picked yet
        # unless one worker is free. Use a separate provider for blockers and
        # tidal for the victim, plus pool size 4.
        pool.resize(4)
        time.sleep(0.05)
        victim = _make_job(services=["tidal"])
        q.enqueue(victim)
        assert _wait_for(lambda: victim.status == "downloading", timeout=0.5)

        cancel_start = time.monotonic()
        q.cancel(victim.id)
        assert _wait_for(lambda: victim.status == "cancelled", timeout=1.0)
        assert time.monotonic() - cancel_start < 0.8
    finally:
        pool.stop()
```

- [ ] **Step 3.4: Run tests to verify they fail**

```bash
cd backend && pytest tests/test_worker_pool.py -v
```

Expected: FAIL with `ImportError: cannot import name 'WorkerPool'` and `cannot import name '_run_single_provider'`.

- [ ] **Step 3.5: Refactor `worker.py` — extract single-provider runner**

Replace the entire contents of `backend/app/core/worker.py` with:

```python
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

    On success: job.status, job.provider_used, job.target_path are updated and
    history/library indexed. On failure: job.error is set; caller decides whether
    to try the next provider.
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
                ok = _run_single_provider(job, provider)
                if ok:
                    job.status = "ok"
                    job.finished_at = datetime.utcnow()
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
    global _pool
    if _pool is not None:
        _pool.stop()
        _pool = None
```

- [ ] **Step 3.6: Run worker-pool tests**

```bash
cd backend && pytest tests/test_worker_pool.py -v
```

Expected: all PASS. If `test_resize_shrink` is flaky on Windows due to timing, increase the `_wait_for` timeout to 3.0.

- [ ] **Step 3.7: Run all tests to make sure nothing broke**

```bash
cd backend && pytest -v
```

Expected: all PASS.

- [ ] **Step 3.8: Commit**

```bash
git add backend/app/core/worker.py backend/app/core/queue.py backend/tests/test_worker_pool.py
git commit -m "feat(worker): WorkerPool with per-provider cap and worker-level fallback"
```

---

## Task 4: Wire live resize into settings PUT

**Files:**
- Modify: `backend/app/api/settings.py`

- [ ] **Step 4.1: Update the PUT handler to diff and resize**

Replace `backend/app/api/settings.py` with:

```python
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from ..core.settings import (
    Settings,
    get_settings,
    update_settings,
)
from ..core.worker import get_pool, get_semaphores

router = APIRouter()


@router.get("/settings")
def read_settings():
    return get_settings().model_dump()


@router.put("/settings")
def write_settings(payload: Settings):
    old = get_settings()
    update_settings(payload)
    # Live-resize the pool if concurrency changed.
    pool = get_pool()
    if pool is not None and old.general.concurrency_total != payload.general.concurrency_total:
        pool.resize(payload.general.concurrency_total)
    if old.general.concurrency_per_provider != payload.general.concurrency_per_provider:
        get_semaphores().resize(payload.general.concurrency_per_provider)
    return payload.model_dump()


@router.get("/settings/export", response_class=PlainTextResponse)
def export_settings():
    return PlainTextResponse(
        get_settings().model_dump_json(indent=2),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="settings.json"'},
    )


@router.post("/settings/reset")
def reset_settings():
    fresh = Settings()
    old = get_settings()
    update_settings(fresh)
    pool = get_pool()
    if pool is not None and old.general.concurrency_total != fresh.general.concurrency_total:
        pool.resize(fresh.general.concurrency_total)
    if old.general.concurrency_per_provider != fresh.general.concurrency_per_provider:
        get_semaphores().resize(fresh.general.concurrency_per_provider)
    return fresh.model_dump()
```

- [ ] **Step 4.2: Smoke-test by running the server and hitting the API**

```bash
cd backend
$env:CONFIG_DIR = "./_dev_config"
$env:MUSIC_DIR = "./_dev_music"
python -m uvicorn app.main:app --port 8001
```

In another terminal (PowerShell):

```powershell
$current = Invoke-RestMethod -Uri http://localhost:8001/api/settings -Method GET
$current.general.concurrency_total = 6
$current.general.concurrency_per_provider = 3
$body = $current | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri http://localhost:8001/api/settings -Method PUT -Body $body -ContentType "application/json"
```

Expected: response echoes the new settings (200 OK). Server logs show no errors. GET again to confirm persistence:

```powershell
(Invoke-RestMethod -Uri http://localhost:8001/api/settings).general.concurrency_total
# → 6
```

Stop server with Ctrl-C.

- [ ] **Step 4.3: Commit**

```bash
git add backend/app/api/settings.py
git commit -m "feat(api): live-resize WorkerPool on settings PUT"
```

---

## Task 5: Frontend — add Performance section

**Files:**
- Modify: `frontend/src/lib/api.ts:55-67` (the `SettingsDTO['general']` type)
- Modify: `frontend/src/pages/Settings.tsx` (add inputs in `GeneralTab`)

- [ ] **Step 5.1: Extend the SettingsDTO type**

In `frontend/src/lib/api.ts`, modify the `SettingsDTO['general']` type (around line 56) to add the two new fields just after `qobuz_token`:

```typescript
export type SettingsDTO = {
  general: {
    providers: string[];
    quality: 'LOSSLESS' | 'HI_RES' | 'MAX';
    accent: string;
    font: string;
    sound_effects: boolean;
    embed_lyrics: boolean;
    embed_max_quality_cover: boolean;
    embed_genre: boolean;
    sp_dc: string;
    qobuz_token: string;
    concurrency_total: number;
    concurrency_per_provider: number;
  };
  file_management: {
    track_template: string;
    playlist_template: string;
    on_existing: 'skip' | 'overwrite' | 'rename';
  };
};
```

- [ ] **Step 5.2: Add the Performance section in `GeneralTab`**

In `frontend/src/pages/Settings.tsx`, modify the `GeneralTab` function. Find the closing `</div>` of the second column (around line 226, after the `qobuz_token` Field). Insert a third column or extend the second column with the new section. Easiest: append to the right column inside `<div className="space-y-4">` (the second column block ending around line 226):

Add right before the closing `</div>` of the right column, after the qobuz_token Field:

```tsx
        <div className="border-t border-gray-200 pt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Performance
          </div>
          <Field label={`Parallel downloads (total): ${draft.general.concurrency_total}`}>
            <input
              type="range"
              min={1}
              max={16}
              value={draft.general.concurrency_total}
              onChange={(e) =>
                update('general', { concurrency_total: parseInt(e.target.value, 10) })
              }
              className="w-full"
            />
          </Field>
          <Field
            label={`Max per provider: ${draft.general.concurrency_per_provider}`}
          >
            <input
              type="range"
              min={1}
              max={8}
              value={draft.general.concurrency_per_provider}
              onChange={(e) =>
                update('general', { concurrency_per_provider: parseInt(e.target.value, 10) })
              }
              className="w-full"
            />
          </Field>
          <p className="text-xs text-gray-500">
            Lower the per-provider cap if you see HTTP 429 errors. Changes apply
            immediately.
          </p>
        </div>
```

- [ ] **Step 5.3: Type-check the frontend**

```bash
cd frontend && npm run build
```

Expected: build succeeds. (If `tsc` is run via the build script, this surfaces type errors.)

- [ ] **Step 5.4: Manual smoke test in dev mode**

```bash
cd frontend && npm run dev
# Open http://localhost:5173, go to Settings → General. Verify the Performance
# section is visible, sliders update the numbers, Save Changes succeeds.
```

Expected: UI works, no console errors.

- [ ] **Step 5.5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/pages/Settings.tsx
git commit -m "feat(ui): Performance section in Settings (concurrency sliders)"
```

---

## Task 6: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 6.1: Document the new settings**

In `README.md`, find the "Notes" section near the bottom (around line 118). Add a new bullet under it (or add a new short section just above):

```markdown
- Parallel downloads: configured in **Settings → General → Performance**.
  Defaults to 4 total / 2 per provider. Live-resizable, no restart needed.
  Lower the per-provider cap if you observe HTTP 429 from a provider.
```

Also extend the "Verification checklist" to add a step:

```markdown
9. In **Settings → General → Performance**, set total = 6 and per-provider = 3.
   Paste an album with ≥6 tracks → observe up to 6 simultaneous `downloading`
   entries in the History/Queue, with no more than 3 hitting the same provider.
```

- [ ] **Step 6.2: Commit**

```bash
git add README.md
git commit -m "docs: document parallel download settings"
```

---

## Task 7: End-to-end verification

This is a manual checkpoint, not a code change. Run before declaring the feature done.

- [ ] **Step 7.1: Build the Docker image**

```bash
docker compose up -d --build
```

Expected: container starts, no errors in `docker logs`.

- [ ] **Step 7.2: Verify defaults loaded**

```bash
curl http://localhost:8000/api/settings | python -m json.tool
```

Expected: response includes `"concurrency_total": 4` and `"concurrency_per_provider": 2`.

- [ ] **Step 7.3: Test parallel downloads with a real album**

In the UI, paste an album URL with ≥8 tracks. Click Download All. Open the Queue/History view.

Expected: up to 4 tracks show `downloading` simultaneously. The album finishes in roughly `ceil(N/4) × per_track_time` instead of `N × per_track_time`. All tracks land in `/music/{artist}/{album}/`.

- [ ] **Step 7.4: Test the per-provider cap**

In Settings, set provider chain to `[tidal]` only and `concurrency_per_provider = 2`. Paste a playlist with ≥6 tracks. Click Download All.

Expected: never more than 2 simultaneous `downloading` (visible in the Queue view), even though the global pool is 4.

- [ ] **Step 7.5: Test live resize**

While downloads are running, open Settings and change `concurrency_total` from 4 to 1. Save.

Expected: within ~one job duration, only 1 simultaneous `downloading` is visible. Existing in-flight jobs finish naturally; no jobs are dropped.

- [ ] **Step 7.6: Test cancel-all**

Queue 10 tracks. Click Cancel All.

Expected: all queued jobs flip to `cancelled` immediately. Any in-flight subprocesses are terminated within a few seconds. Partial files are cleaned up.

---

## Done criteria

- All `pytest` tests pass.
- `npm run build` passes.
- Manual checklist (Task 7) passes.
- New settings appear in `/api/settings` GET and persist across restart (`settings.json` written).
- README updated.
