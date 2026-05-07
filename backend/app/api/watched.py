from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import watched_db
from ..core.metadata import fetch_preview, is_valid_spotify_url
from ..core.playlist_watcher import sync_one_playlist
from ..core.queue import get_queue

router = APIRouter()


class AddWatchedRequest(BaseModel):
    url: str


@router.get("/watched")
def list_watched():
    return {"items": watched_db.list_watched()}


@router.post("/watched")
def add_watched(req: AddWatchedRequest):
    url = req.url.strip()
    if not is_valid_spotify_url(url):
        raise HTTPException(400, "Invalid Spotify URL")

    try:
        preview = fetch_preview(url)
    except Exception as e:
        raise HTTPException(502, f"Failed to fetch playlist metadata: {e}") from e

    if preview.kind != "playlist":
        raise HTTPException(400, f"URL must point to a playlist (got {preview.kind})")

    row = watched_db.add_watched(
        spotify_playlist_id=preview.id,
        url=preview.raw_url,
        name=preview.title,
        cover_url=preview.cover_url,
    )
    return row


@router.delete("/watched/{playlist_id}")
def delete_watched(playlist_id: int):
    removed = watched_db.remove_watched(playlist_id)
    if not removed:
        raise HTTPException(404, "Watched playlist not found")
    return {"removed": True}


@router.post("/watched/{playlist_id}/sync")
def sync_now(playlist_id: int):
    pl = watched_db.get_watched(playlist_id)
    if not pl:
        raise HTTPException(404, "Watched playlist not found")
    report = sync_one_playlist(pl, get_queue())
    return report
