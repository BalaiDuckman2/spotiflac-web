from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.metadata import fetch_preview, is_valid_spotify_url
from ..core.library import check_already_present
from ..core.history_db import record_fetch

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
