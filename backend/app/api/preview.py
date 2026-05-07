from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.metadata import fetch_preview, is_valid_spotify_url, _preview_cache, _preview_lock
from ..core.library import check_already_present
from ..core.history_db import record_fetch
import time as _time

router = APIRouter()


class PreviewRequest(BaseModel):
    url: str


class LibraryCheckRequest(BaseModel):
    track_ids: list[str]
    isrcs: list[str] = []
    fingerprints: list[dict] = []  # [{artist, title, album}]


@router.post("/preview")
def preview(req: PreviewRequest):
    url = req.url.strip()
    if not is_valid_spotify_url(url):
        raise HTTPException(400, "Invalid Spotify URL")
    try:
        result = fetch_preview(url)
    except Exception as e:
        raise HTTPException(502, f"Failed to fetch metadata: {e}") from e
    # Warm the cache so /download doesn't re-fetch (which costs another ~6s
    # for a 1200-track playlist and risks Spotify rate limits or partial
    # truncation on flaky responses).
    with _preview_lock:
        _preview_cache[url] = (_time.monotonic(), result)
    record_fetch(
        kind=result.kind,
        spotify_id=result.id,
        title=result.title,
        cover_url=result.cover_url,
        url=result.raw_url,
        total_tracks=result.total_tracks,
    )
    return result.to_dto()


@router.post("/library/check")
def library_check(req: LibraryCheckRequest):
    """Return list of track ids that already exist in /music."""
    present: list[str] = []
    for tid, isrc, fp in zip(req.track_ids, req.isrcs, req.fingerprints):
        if check_already_present(isrc=isrc, fingerprint=fp):
            present.append(tid)
    return {"already_present_ids": present}
