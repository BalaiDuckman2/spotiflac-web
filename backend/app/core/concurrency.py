from __future__ import annotations

import threading


class ProviderSemaphores:
    """Per-provider concurrency cap.

    Each provider name maps to a BoundedSemaphore. `acquire` is cancellable:
    callers pass an `Event` that will short-circuit the wait loop. `resize`
    swaps the underlying semaphores in-place; workers holding old slots
    continue to hold them until they release, but new acquires use the new
    cap.
    """

    def __init__(self, per_provider: int) -> None:
        if per_provider < 1:
            raise ValueError(f"per_provider must be >= 1, got {per_provider}")
        self._per_provider = per_provider
        self._sems: dict[str, threading.BoundedSemaphore] = {}
        self._lock = threading.Lock()

    def acquire(
        self,
        provider: str,
        cancel_event: threading.Event,
        poll_s: float = 0.5,
    ) -> bool:
        """Block until a slot is free for `provider` OR `cancel_event` is set.

        Returns True on acquisition, False if cancelled before acquiring.
        Re-fetches the semaphore on each poll so that a `resize` mid-wait is
        picked up immediately on the next iteration. If a resize swaps the
        semaphore between the lock-protected lookup and the timed acquire,
        the slot is released on the old semaphore and the loop retries to
        avoid briefly exceeding the new cap.
        """
        while not cancel_event.is_set():
            with self._lock:
                sem = self._sems.get(provider)
                if sem is None:
                    sem = threading.BoundedSemaphore(self._per_provider)
                    self._sems[provider] = sem
            if sem.acquire(timeout=poll_s):
                with self._lock:
                    current = self._sems.get(provider)
                if current is sem:
                    return True
                # Resize swapped the sem mid-wait; release the old one and retry.
                try:
                    sem.release()
                except ValueError:
                    pass
        return False

    def release(self, provider: str) -> None:
        with self._lock:
            sem = self._sems.get(provider)
        if sem is not None:
            try:
                sem.release()
            except ValueError:
                # If resize swapped the semaphore between acquire and release,
                # this releases a slot we didn't take on the new sem; the slot
                # on the orphaned old sem is intentionally abandoned (it gets
                # GC'd). The new sem's cap stays correct.
                pass

    def resize(self, new_per_provider: int) -> None:
        """Swap all semaphores to the new cap. Old slot holders keep their slots."""
        if new_per_provider < 1:
            raise ValueError(
                f"new_per_provider must be >= 1, got {new_per_provider}"
            )
        with self._lock:
            self._per_provider = new_per_provider
            self._sems = {
                name: threading.BoundedSemaphore(new_per_provider)
                for name in self._sems
            }
