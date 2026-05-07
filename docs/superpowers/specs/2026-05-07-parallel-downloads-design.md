# Parallel Downloads — Design

**Date:** 2026-05-07
**Status:** Approved, ready for implementation plan
**Scope:** Replace the single-threaded download worker with a worker pool that respects a per-provider concurrency cap. Live-resizable from the Settings UI.

## Goal

Today, `Worker` is a single thread that pops one job at a time from `JobQueue` and spawns one subprocess (`downloader_runner`) which internally tries Tidal → Qobuz → Amazon. Bulk downloads (album of 20, playlist of 200) are serialized end-to-end. The user wants meaningful speedup without provoking 429s from any single provider.

**Success criteria:** downloading a 20-track album with default settings (4 global, 2 per provider) finishes in roughly `ceil(20/4) × per_track_time` instead of `20 × per_track_time`, while never running more than 2 concurrent subprocesses against the same provider.

## Non-goals

- Job priority (everything stays FIFO).
- Disk quota / bandwidth throttling.
- Adaptive backoff on 429 (already handled by the underlying `SpotiFLAC-Module-Version`).
- Visual grouping of jobs by album/playlist in the queue view.

## Architecture

```
JobQueue (FIFO, thread-safe — unchanged)
    │
    ▼
WorkerPool (N daemon threads, configurable)
    │  per worker:
    │   1. q.get_next() → Job
    │   2. for provider in job.services:
    │       - sems.acquire(provider, cancel_event)   # blocks if cap reached
    │       - spawn subprocess with services=[provider]   # single provider, no in-process fallback
    │       - parse stdout, wait, capture result
    │       - sems.release(provider)
    │       - if success: break
    │   3. queue.update(job)  # ok / failed / cancelled
    │
    ▼
ProviderSemaphores  (BoundedSemaphore per provider name)
```

The fallback chain moves from inside the subprocess to the worker loop. The subprocess is kept simple: one provider per spawn. This is what makes the per-provider cap **strict** rather than best-effort — we know exactly which provider each running subprocess is using.

**Tradeoff:** when a provider fails, the worker pays subprocess cold-start cost (~1-2s for SpotiFLAC import) before retrying with the next provider. For FLAC downloads in the 15-30s range this is 5-10% overhead in the worst case (first provider fails, second succeeds). Acceptable in exchange for a real cap.

## Components

### Settings additions (`backend/app/core/settings.py`)

Two new fields on `GeneralSettings`:

```python
concurrency_total: int = Field(default=4, ge=1, le=16)
concurrency_per_provider: int = Field(default=2, ge=1, le=8)
```

Pydantic validators clamp out-of-range values. Existing `settings.json` files load fine — Pydantic fills missing fields with defaults.

### `ProviderSemaphores` (new, in `backend/app/core/concurrency.py`)

```python
class ProviderSemaphores:
    def __init__(self, per_provider: int) -> None: ...
    def acquire(self, provider: str, cancel_event: threading.Event, poll_s: float = 0.5) -> bool:
        """Acquire one slot for `provider`. Returns False if cancel_event set during wait."""
    def release(self, provider: str) -> None: ...
    def resize(self, new_per_provider: int) -> None:
        """Replace the underlying semaphores. In-flight workers continue holding old ones
        until they release; new acquires use the new bounded count."""
```

Internal: `dict[str, BoundedSemaphore]`. `acquire` polls with timeout to remain cancellable. Provider keys are lazy-created on first `acquire` (since the set of providers is configurable elsewhere).

### `WorkerPool` (new, replaces `Worker` in `backend/app/core/worker.py`)

```python
class WorkerPool:
    def __init__(self, total: int, sems: ProviderSemaphores) -> None: ...
    def start(self) -> None: ...                 # spawn `total` daemon threads
    def stop(self) -> None: ...                  # set stop on all workers, join
    def resize(self, new_total: int) -> None:    # grow → spawn new threads ; shrink → flag N workers to exit after current job
```

Each worker thread owns a private `_should_stop_after_current` event, set by `resize` when shrinking. Worker checks it before each `q.get_next()`.

### Worker loop (modified `_process_job`)

Pseudocode:

```python
def _process_job(job: Job, sems: ProviderSemaphores) -> None:
    job.status = "downloading"
    job.started_at = datetime.utcnow()
    q.update(job)

    cancel_event = threading.Event()
    job._cancel_event = cancel_event   # so cancel() can wake the acquire

    for provider in job.services:
        if job.cancel_requested:
            break
        if not sems.acquire(provider, cancel_event):
            break  # cancelled while waiting
        try:
            result = _run_single_provider(job, provider)
            if result.ok:
                job.status = "ok"
                job.provider_used = provider
                # ... record_download, add_to_index, etc.
                return
        finally:
            sems.release(provider)

    if job.cancel_requested:
        job.status = "cancelled"
    else:
        job.status = "failed"
    q.update(job)
```

`_run_single_provider` is essentially today's `_process_job` body but with `services=[provider]` in the payload, simplifying the result handling (no need to track which provider succeeded — we know).

### Cancel handling

- `cancel(job_id)` (already exists) sets `job.cancel_requested`. Extend it to also set `job._cancel_event` if present, so a worker waiting on a saturated semaphore wakes immediately.
- `cancel_all` continues to work — it iterates all jobs setting the flag.
- Running subprocess termination: store `job._proc` reference. On cancel, `proc.terminate()` (existing path).

### Live settings update

In the settings PUT handler (`backend/app/api/settings.py`), after persisting:

```python
if old.general.concurrency_total != new.general.concurrency_total:
    worker_pool.resize(new.general.concurrency_total)
if old.general.concurrency_per_provider != new.general.concurrency_per_provider:
    sems.resize(new.general.concurrency_per_provider)
```

No restart required.

### UI changes (`frontend/src/pages/Settings.tsx`)

Add a "Performance" section with two number inputs (or sliders) for the new fields. Short helper text on the per-provider one: "lower if you see 429 errors". Existing queue/history pages don't need changes — they already iterate `/api/jobs` and will naturally render multiple `downloading` entries.

## Data flow

Unchanged from today's perspective of API consumers. `/api/jobs` returns the same DTO; clients that polled it sequentially will now see multiple `downloading` entries simultaneously. No DB migration.

## Edge cases

- **All providers saturated:** worker blocks on `acquire` of the first provider in chain. FIFO ordering on the main queue ensures no starvation.
- **Provider removed from `services` list mid-flight:** old semaphore is still held by in-flight workers; `release` works as long as the dict entry exists. New acquires won't hit it.
- **Subprocess crash:** `proc.wait()` returns nonzero → counted as provider failure → fallback to next provider.
- **Cancel during semaphore wait:** poll loop checks `cancel_event` every 500ms, returns False, worker exits cleanly.
- **Resize while jobs running:** old workers finish their current job; new workers spawned (grow) or flagged to exit after current (shrink). No interruption to in-flight jobs.
- **Concurrent settings PUT during resize:** the resize calls are themselves serialized by the GIL + the settings cache lock; idempotent.

## Testing strategy

New file `backend/tests/test_concurrency.py`:

1. **Speedup**: with a mocked `_spawn_subprocess` that sleeps 100ms, pool of 4 finishes 10 jobs in <500ms (vs ~1000ms for pool of 1).
2. **Per-provider cap**: enqueue 10 jobs all with `services=["tidal"]`. Assert that at no observed instant did more than 2 subprocesses run concurrently. Use a shared counter incremented inside the mocked subprocess.
3. **Provider fallback**: mock subprocess to fail on Tidal, succeed on Qobuz. Assert provider_used == "qobuz" and that Tidal sema was acquired then released before Qobuz acquired.
4. **Resize grow**: pool starts at 2, resize to 4, assert that 4 jobs run concurrently after resize.
5. **Resize shrink**: pool at 4, resize to 2 mid-stream, assert no more than 2 active after current jobs finish, and pool eventually has 2 threads.
6. **Cancel during acquire**: saturate Tidal sema (2 jobs), enqueue a 3rd Tidal job (waiting), cancel it. Assert it transitions to `cancelled` within 1s and worker doesn't hang.

Existing `test_queue.py` must continue passing — `JobQueue` contract is unchanged.

## Migration

- No DB migration.
- Existing `settings.json` files will load with new fields auto-defaulted by Pydantic on next read.
- First run after deploy: workers start with `concurrency_total=4`, `concurrency_per_provider=2`.

## Files touched

| File | Change |
|------|--------|
| `backend/app/core/settings.py` | +2 fields on `GeneralSettings` with validators |
| `backend/app/core/concurrency.py` | New: `ProviderSemaphores` |
| `backend/app/core/worker.py` | Replace `Worker` with `WorkerPool`; refactor `_process_job` to per-provider loop |
| `backend/app/api/settings.py` | Hook resize calls into PUT handler |
| `backend/app/main.py` (or wherever `start_worker` is called) | Replace `start_worker()` with `WorkerPool` startup wiring |
| `backend/tests/test_concurrency.py` | New |
| `frontend/src/pages/Settings.tsx` | Add Performance section with 2 inputs |
| `README.md` | Document new settings |

## Implementation order (suggestion for the plan)

1. Add settings fields + validators (smallest, isolated).
2. Build `ProviderSemaphores` + unit tests.
3. Build `WorkerPool` skeleton with grow/shrink, no provider logic yet.
4. Refactor `_process_job` to per-provider loop, integrate semaphores.
5. Wire PUT settings → resize.
6. Frontend Settings UI.
7. End-to-end test against real (test) Spotify URL.
