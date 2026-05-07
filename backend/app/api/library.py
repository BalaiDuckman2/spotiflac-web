from __future__ import annotations

from fastapi import APIRouter

from ..core.library import rescan

router = APIRouter()


@router.post("/library/rescan")
def library_rescan():
    n = rescan()
    return {"indexed_keys": n}
