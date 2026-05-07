"""Tests for WorkerPool — uses a fake subprocess factory so no real spawns occur."""
from __future__ import annotations

import threading
import time

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
            job.provider_used = provider
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
        # Spread across providers so per-provider cap (2) is not the bottleneck.
        provider_options = ["tidal", "qobuz", "amazon", "spoti"]
        jobs = []
        for i in range(8):
            j = _make_job(services=[provider_options[i % 4]])
            jobs.append(j)
            q.enqueue(j)
        start = time.monotonic()
        assert _wait_for(lambda: all(j.status == "ok" for j in jobs), timeout=2.0)
        elapsed = time.monotonic() - start
        # Sequential would be 8 * 0.1 = 0.8s. With 4 workers spread across 4 providers, ~0.2s + overhead.
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
        providers_attempted = [p for (jid, p) in runner.calls if jid == j.id]
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
        assert _wait_for(lambda: pool.active_count() == 2, timeout=3.0)
    finally:
        pool.stop()


def test_cancel_during_acquire_does_not_hang(setup):
    q, sems, runner = setup
    runner.delay_s = 0.5
    pool = WorkerPool(total=4, sems=sems)
    pool.start()
    try:
        # Saturate Tidal cap (2).
        blockers = [_make_job(services=["tidal"]) for _ in range(2)]
        for b in blockers:
            q.enqueue(b)
        # Wait for blockers to actually start.
        assert _wait_for(lambda: all(b.status == "downloading" for b in blockers), timeout=0.5)

        # Add a 3rd Tidal job — will wait for sema.
        victim = _make_job(services=["tidal"])
        q.enqueue(victim)
        # Victim should reach 'downloading' (worker picked it up) but be stuck on acquire.
        assert _wait_for(lambda: victim.status == "downloading", timeout=0.5)

        cancel_start = time.monotonic()
        q.cancel(victim.id)
        assert _wait_for(lambda: victim.status == "cancelled", timeout=1.5)
        assert time.monotonic() - cancel_start < 1.5
    finally:
        pool.stop()
