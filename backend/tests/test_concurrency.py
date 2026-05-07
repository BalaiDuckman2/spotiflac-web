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
