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
        Re-fetches the semaphore on each poll so that a `resize` mid-wait is
        picked up immediately on the next iteration.
        """
        self._get_or_create(provider)  # ensure entry exists
        while not cancel_event.is_set():
            with self._lock:
                sem = self._sems[provider]
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
