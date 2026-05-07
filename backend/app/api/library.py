from __future__ import annotations

import logging
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from mutagen.flac import FLAC
from pydantic import BaseModel

from ..core import spotify_search
from ..core.library import AlbumInfo, _norm, get_index, rescan
from ..core.metadata import get_client
from ..core.settings import MUSIC_DIR
from .download import DownloadRequest, enqueue_download

logger = logging.getLogger(__name__)
router = APIRouter()

_VERIFY_CACHE_TTL = timedelta(hours=24)
_SIM_STRONG = 0.8
_SIM_WEAK = 0.5


# --------------------------------------------------------------------------
# DTO
# --------------------------------------------------------------------------

def _album_dto(a: AlbumInfo) -> dict:
    exp = a.expected
    cover_url = (
        f"/api/library/cover?path={a.cover_path}" if a.cover_path else None
    )
    return {
        "album_artist":          a.album_artist,
        "album":                 a.album,
        "disc_number":           a.disc_number,
        "cover_url":             cover_url,
        "tracks_present":        len(a.track_numbers),
        "tracks_expected":       exp,
        "status":                a.status,
        "spotify_album_id":      a.spotify_album_id,
        "verified":              a.last_verified_at is not None,
        "missing_track_numbers": a.missing_track_numbers,
        "paths_count":           len(a.paths),
    }


# --------------------------------------------------------------------------
# Existing rescan endpoint (kept)
# --------------------------------------------------------------------------

@router.post("/library/rescan")
def library_rescan():
    n = rescan()
    return {"indexed_keys": n}


# --------------------------------------------------------------------------
# Albums list
# --------------------------------------------------------------------------

@router.get("/library/albums")
def list_albums(
    status: str = Query("incomplete", pattern="^(all|complete|incomplete|unknown)$"),
    search: str = Query(""),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    items, total = get_index().list_albums(
        status=status, search=search, limit=limit, offset=offset
    )
    return {
        "items":  [_album_dto(a) for a in items],
        "total":  total,
        "limit":  limit,
        "offset": offset,
    }


# --------------------------------------------------------------------------
# Verify
# --------------------------------------------------------------------------

class VerifyRequest(BaseModel):
    album_artist: str
    album: str
    disc_number: int = 1
    spotify_album_id: str | None = None    # locked-in choice from candidates


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _build_verify_response(info: AlbumInfo) -> dict:
    """Call get_album_tracks for info.spotify_album_id, fill totals, return DTO."""
    if not info.spotify_album_id:
        raise HTTPException(500, "build_verify_response without spotify_album_id")
    client = get_client()
    album_raw, tracks = client.get_album_tracks(info.spotify_album_id)
    info.spotify_total = album_raw.get("total_tracks", 0) or len(tracks)
    info.last_verified_at = datetime.utcnow()
    missing_numbers = info.missing_track_numbers
    missing = [
        {
            "number":            t.track_number,
            "title":             t.title,
            "spotify_track_id":  t.id,
        }
        for t in tracks
        if t.track_number in missing_numbers
    ]
    return {
        "verified":         True,
        "spotify_album_id": info.spotify_album_id,
        "spotify_total":    info.spotify_total,
        "missing":          missing,
    }


@router.post("/library/albums/verify")
def verify_album(req: VerifyRequest):
    info = get_index().get_album(req.album_artist, req.album, req.disc_number)
    if info is None:
        raise HTTPException(404, "album not in library index")

    # Body-supplied id locks the choice (used by frontend after the candidates
    # picker). Skip search entirely.
    if req.spotify_album_id:
        info.spotify_album_id = req.spotify_album_id

    if info.spotify_album_id:
        try:
            return _build_verify_response(info)
        except Exception as e:
            raise HTTPException(502, f"spotify lookup failed: {e}")

    # No known id — search by name.
    query = f"{req.album_artist} {req.album}"
    try:
        results = spotify_search.search(query, ["album"], limit=5)
    except Exception as e:
        raise HTTPException(502, f"spotify search failed: {e}")
    candidates = results.get("albums", [])
    if not candidates:
        raise HTTPException(404, "no matching album on spotify")

    target = f"{req.album_artist} {req.album}"
    scored = [
        (c, _similarity(target, f"{c['artists']} {c['title']}"))
        for c in candidates
    ]
    scored.sort(key=lambda x: x[1], reverse=True)
    top, top_sim = scored[0]

    if top_sim >= _SIM_STRONG:
        info.spotify_album_id = top["id"]
        try:
            return _build_verify_response(info)
        except Exception as e:
            raise HTTPException(502, f"spotify lookup failed: {e}")

    if top_sim >= _SIM_WEAK:
        return {"verified": False, "candidates": [c for c, _ in scored]}

    raise HTTPException(404, "no confident match (best similarity %.2f)" % top_sim)


# --------------------------------------------------------------------------
# Complete
# --------------------------------------------------------------------------

class CompleteRequest(BaseModel):
    album_artist: str
    album: str
    disc_number: int = 1


@router.post("/library/albums/complete")
def complete_album(req: CompleteRequest):
    info = get_index().get_album(req.album_artist, req.album, req.disc_number)
    if info is None:
        raise HTTPException(404, "album not in library index")

    # Verify if missing or stale.
    is_stale = (
        info.last_verified_at is None
        or datetime.utcnow() - info.last_verified_at > _VERIFY_CACHE_TTL
    )
    if not info.spotify_album_id or is_stale:
        verify_resp = verify_album(VerifyRequest(
            album_artist=req.album_artist,
            album=req.album,
            disc_number=req.disc_number,
        ))
        if not verify_resp.get("verified"):
            # Ambiguous candidates — caller must pick first.
            raise HTTPException(409, "verify is ambiguous; pass spotify_album_id via /verify first")

    # Re-pull the canonical tracklist to get track_ids of missing tracks.
    client = get_client()
    _album, tracks = client.get_album_tracks(info.spotify_album_id)
    missing_numbers = set(info.missing_track_numbers)
    missing_track_ids = [t.id for t in tracks if t.track_number in missing_numbers]

    if not missing_track_ids:
        return {"missing_count": 0, "job_ids": []}

    album_url = f"https://open.spotify.com/album/{info.spotify_album_id}"
    result = enqueue_download(DownloadRequest(url=album_url, track_ids=missing_track_ids))
    return {
        "missing_count": len(missing_track_ids),
        "job_ids":       result["job_ids"],
        "skipped":       result.get("skipped_existing", 0),
    }


# --------------------------------------------------------------------------
# Cover proxy
# --------------------------------------------------------------------------

@router.get("/library/cover")
def get_cover(path: str = Query(...)):
    try:
        p = Path(path).resolve()
    except OSError:
        raise HTTPException(400, "invalid path")
    music = MUSIC_DIR.resolve()
    try:
        p.relative_to(music)
    except ValueError:
        raise HTTPException(403, "path outside MUSIC_DIR")
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "file not found")
    try:
        flac = FLAC(p)
    except Exception:
        raise HTTPException(415, "not a FLAC file")
    if not flac.pictures:
        raise HTTPException(404, "no embedded picture")
    pic = flac.pictures[0]
    return Response(
        content=pic.data,
        media_type=pic.mime or "image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )
