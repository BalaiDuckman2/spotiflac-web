from __future__ import annotations

import asyncio
import logging
import threading
from collections import deque
from datetime import datetime
from typing import AsyncIterator


class _LogBus:
    def __init__(self, capacity: int = 1000) -> None:
        self._buffer: deque[dict] = deque(maxlen=capacity)
        self._subscribers: list[asyncio.Queue] = []
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def emit(self, level: str, msg: str) -> None:
        event = {
            "ts": datetime.utcnow().isoformat(),
            "level": level,
            "msg": msg,
        }
        with self._lock:
            self._buffer.append(event)
            subs = list(self._subscribers)
        loop = self._loop
        if loop is None:
            return
        for q in subs:
            try:
                loop.call_soon_threadsafe(q.put_nowait, event)
            except RuntimeError:
                pass

    def history(self) -> list[dict]:
        with self._lock:
            return list(self._buffer)

    async def subscribe(self) -> AsyncIterator[dict]:
        q: asyncio.Queue = asyncio.Queue()
        # Replay buffer on connect
        with self._lock:
            for e in list(self._buffer):
                q.put_nowait(e)
            self._subscribers.append(q)
        try:
            while True:
                yield await q.get()
        finally:
            with self._lock:
                if q in self._subscribers:
                    self._subscribers.remove(q)


_bus = _LogBus()


def get_bus() -> _LogBus:
    return _bus


def emit_log(level: str, msg: str) -> None:
    _bus.emit(level, msg)


class _BusHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = record.levelname.lower()
            if level == "warning":
                level = "warn"
            _bus.emit(level, self.format(record))
        except Exception:
            pass


def install_log_bridge() -> None:
    handler = _BusHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
    root = logging.getLogger()
    if not any(isinstance(h, _BusHandler) for h in root.handlers):
        root.addHandler(handler)
        root.setLevel(logging.INFO)
