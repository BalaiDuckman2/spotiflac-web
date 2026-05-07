from __future__ import annotations

import importlib.metadata as md

from fastapi import APIRouter

router = APIRouter()


_TRACKED = [
    "SpotiFLAC",
    "fastapi",
    "uvicorn",
    "pydantic",
    "mutagen",
    "sse-starlette",
    "requests",
]


@router.get("/modules")
def modules():
    items = []
    for name in _TRACKED:
        try:
            ver = md.version(name)
            items.append({"name": name, "version": ver, "ok": True})
        except md.PackageNotFoundError:
            items.append({"name": name, "version": None, "ok": False})
    return {"modules": items}
