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


def _apply_concurrency_changes(old: Settings, new: Settings) -> None:
    pool = get_pool()
    if pool is not None and old.general.concurrency_total != new.general.concurrency_total:
        pool.resize(new.general.concurrency_total)
    if old.general.concurrency_per_provider != new.general.concurrency_per_provider:
        get_semaphores().resize(new.general.concurrency_per_provider)


@router.get("/settings")
def read_settings():
    return get_settings().model_dump()


@router.put("/settings")
def write_settings(payload: Settings):
    old = get_settings()
    update_settings(payload)
    _apply_concurrency_changes(old, payload)
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
    _apply_concurrency_changes(old, fresh)
    return fresh.model_dump()
