from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..core.history_db import (
    clear_all_downloads,
    delete_download,
    delete_fetch,
    list_downloads,
    list_fetches,
)

router = APIRouter()


@router.get("/history/downloads")
def downloads(
    search: str = "",
    sort: str = "downloaded_at",
    direction: str = "desc",
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    rows, total = list_downloads(
        search=search,
        sort=sort,
        direction=direction,
        limit=limit,
        offset=offset,
    )
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/history/fetches")
def fetches(
    limit: int = Query(30, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    rows, total = list_fetches(limit=limit, offset=offset)
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


@router.delete("/history/downloads/{download_id}")
def delete_download_entry(download_id: int, delete_file: bool = False):
    row = delete_download(download_id, delete_file=delete_file)
    if not row:
        raise HTTPException(404, "entry not found")
    return {"deleted": True, "file_deleted": delete_file}


@router.delete("/history/fetches/{fetch_id}")
def delete_fetch_entry(fetch_id: int):
    ok = delete_fetch(fetch_id)
    if not ok:
        raise HTTPException(404, "entry not found")
    return {"deleted": True}


@router.delete("/history/downloads")
def clear_downloads():
    n = clear_all_downloads()
    return {"deleted": n}
