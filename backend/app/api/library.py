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
from ..core.library import (
    AlbumInfo, _norm, _parse_int, get_index, remove_from_index, rescan,
)
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


# --------------------------------------------------------------------------
# Album detail (per-track listing)
# --------------------------------------------------------------------------

@router.get("/library/album")
def get_album_detail(
    artist: str = Query(...),
    album: str = Query(...),
    disc: int = Query(1),
):
    info = get_index().get_album(artist, album, disc)
    if info is None:
        raise HTTPException(404, "album not in library index")
    tracks = []
    for raw in info.paths:
        p = Path(raw)
        if not p.exists() or not p.is_file():
            continue
        try:
            flac = FLAC(p)
        except Exception:
            continue
        try:
            size = p.stat().st_size
        except OSError:
            size = 0
        duration = int(flac.info.length) if flac.info else 0
        tracks.append({
            "path":         str(p),
            "track_number": _parse_int(flac.get("TRACKNUMBER"), default=0) or 0,
            "disc_number":  _parse_int(flac.get("DISCNUMBER"), default=1) or 1,
            "title":        (flac.get("TITLE") or [""])[0],
            "artist":       (flac.get("ARTIST") or [""])[0],
            "duration_sec": duration,
            "size_bytes":   size,
            "isrc":         (flac.get("ISRC") or [""])[0],
        })
    tracks.sort(key=lambda t: (t["disc_number"], t["track_number"]))
    return {
        "album_artist":     info.album_artist,
        "album":            info.album,
        "disc_number":      info.disc_number,
        "cover_url":        (
            f"/api/library/cover?path={info.cover_path}" if info.cover_path else None
        ),
        "spotify_album_id": info.spotify_album_id,
        "tracks":           tracks,
    }


# --------------------------------------------------------------------------
# Artist paths helper (used by "delete artist" in the UI)
# --------------------------------------------------------------------------

@router.get("/library/artist/paths")
def get_artist_paths(artist: str = Query(...)):
    artist_n = _norm(artist)
    paths: list[str] = []
    album_count = 0
    # list_albums returns a locked snapshot; we filter by exact normalized artist.
    items, _ = get_index().list_albums(status="all", search="", limit=10_000, offset=0)
    for info in items:
        if _norm(info.album_artist) == artist_n:
            paths.extend(info.paths)
            album_count += 1
    return {"artist": artist, "paths": paths, "album_count": album_count}


# --------------------------------------------------------------------------
# Delete tracks (batch)
# --------------------------------------------------------------------------

class DeleteTracksRequest(BaseModel):
    paths: list[str]


def _cleanup_empty_dirs(d: Path, *, stop_at: Path) -> None:
    """Remove `d` and its parents up to (but not including) `stop_at` while empty."""
    cur = d
    while cur != stop_at:
        try:
            cur.relative_to(stop_at)
        except ValueError:
            return
        if not cur.exists() or not cur.is_dir():
            return
        try:
            next(cur.iterdir())
            return  # not empty
        except StopIteration:
            pass
        try:
            cur.rmdir()
        except OSError:
            return
        cur = cur.parent


@router.post("/library/tracks/delete")
def delete_tracks(req: DeleteTracksRequest):
    if not req.paths:
        return {"deleted": 0, "freed_bytes": 0, "errors": 0}
    music_root = MUSIC_DIR.resolve()
    deleted = 0
    freed = 0
    errors = 0
    parent_dirs: set[Path] = set()
    for raw in req.paths:
        try:
            p = Path(raw).resolve()
            p.relative_to(music_root)  # path-traversal guard
        except (OSError, ValueError):
            errors += 1
            continue
        if not p.is_file():
            errors += 1
            continue
        try:
            size = p.stat().st_size
        except OSError:
            size = 0
        try:
            p.unlink()
        except OSError:
            errors += 1
            continue
        remove_from_index(p)
        deleted += 1
        freed += size
        parent_dirs.add(p.parent)
    for d in parent_dirs:
        _cleanup_empty_dirs(d, stop_at=music_root)
    # Force a rescan so AlbumInfo.track_numbers reflects reality
    # (remove_from_index drops the path but leaves stale track_numbers).
    if deleted:
        rescan()
    return {"deleted": deleted, "freed_bytes": freed, "errors": errors}


# --------------------------------------------------------------------------
# Redownload one track (delete file, enqueue via existing download flow)
# --------------------------------------------------------------------------

class RedownloadRequest(BaseModel):
    path: str


@router.post("/library/tracks/redownload")
def redownload_track(req: RedownloadRequest):
    music_root = MUSIC_DIR.resolve()
    try:
        p = Path(req.path).resolve()
        p.relative_to(music_root)
    except (OSError, ValueError):
        raise HTTPException(400, "invalid path")
    if not p.is_file():
        raise HTTPException(404, "file not found")
    try:
        flac = FLAC(p)
    except Exception:
        raise HTTPException(415, "not a FLAC file")
    isrc = (flac.get("ISRC") or [""])[0].upper().strip()
    if not isrc:
        raise HTTPException(
            422, "track has no ISRC tag; cannot resolve Spotify ID for redownload"
        )
    # Search Spotify by ISRC: the /search endpoint accepts `q=isrc:XXX`.
    try:
        results = spotify_search.search(f"isrc:{isrc}", ["track"], limit=1)
    except Exception as e:
        raise HTTPException(502, f"spotify search failed: {e}")
    tracks = results.get("tracks", [])
    if not tracks:
        raise HTTPException(404, "no Spotify match for this ISRC")
    track_id = tracks[0].get("id")
    if not track_id:
        raise HTTPException(404, "spotify match missing id")
    # Delete existing file so the new download writes to the same target.
    try:
        p.unlink()
    except OSError as e:
        raise HTTPException(500, f"could not delete existing file: {e}")
    remove_from_index(p)
    url = f"https://open.spotify.com/track/{track_id}"
    try:
        result = enqueue_download(DownloadRequest(url=url, track_ids=[track_id]))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"enqueue failed: {e}")
    return {
        "queued":   True,
        "job_ids":  result.get("job_ids", []),
        "track_id": track_id,
    }
