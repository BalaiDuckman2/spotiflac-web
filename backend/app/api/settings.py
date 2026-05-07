from __future__ import annotations

import json

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from ..core.settings import (
    Settings,
    get_settings,
    update_settings,
)

router = APIRouter()


@router.get("/settings")
def read_settings():
    return get_settings().model_dump()


@router.put("/settings")
def write_settings(payload: Settings):
    update_settings(payload)
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
    update_settings(fresh)
    return fresh.model_dump()
