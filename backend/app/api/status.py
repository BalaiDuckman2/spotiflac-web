from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Any

from fastapi import APIRouter

router = APIRouter()


_state: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _check_provider(name: str) -> dict[str, Any]:
    """Lightweight ping. The SpotiFLAC providers don't expose a health endpoint;
    we just import their module and confirm it's loadable, since real auth
    happens lazily on first track. This is an approximation, not a guarantee."""
    try:
        from SpotiFLAC.downloader import _build_provider, DownloadOptions

        opts = DownloadOptions(output_dir=".")
        p = _build_provider(name, opts)
        ok = p is not None
        return {
            "name": name,
            "ok": ok,
            "checked_at": datetime.utcnow().isoformat(),
            "error": None if ok else "provider unavailable",
        }
    except Exception as e:
        return {
            "name": name,
            "ok": False,
            "checked_at": datetime.utcnow().isoformat(),
            "error": str(e),
        }


def refresh_status() -> None:
    with _lock:
        for name in ("tidal", "qobuz", "amazon", "spoti"):
            _state[name] = _check_provider(name)


@router.get("/status")
def status():
    with _lock:
        if not _state:
            refresh_status()
        return {"providers": list(_state.values())}


@router.post("/status/refresh")
def status_refresh():
    refresh_status()
    return status()
