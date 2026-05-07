from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..core import spotify_search

router = APIRouter()

_VALID_TYPES = {"track", "album", "playlist", "artist"}


@router.get("/search")
def search(
    q: str = Query(..., min_length=1, description="search query"),
    types: str = Query("track,album,playlist,artist", description="comma-separated types"),
    limit: int = Query(20, ge=1, le=50),
):
    type_list = [t.strip() for t in types.split(",") if t.strip()]
    bad = [t for t in type_list if t not in _VALID_TYPES]
    if bad:
        raise HTTPException(400, f"unknown type(s): {bad}")
    try:
        return spotify_search.search(q, type_list, limit=limit)
    except Exception as e:
        raise HTTPException(502, f"spotify search failed: {e}")


@router.get("/spotify/artist/{artist_id}/albums")
def artist_albums(artist_id: str, limit: int = Query(50, ge=1, le=50)):
    try:
        return spotify_search.get_artist_albums(artist_id, limit=limit)
    except Exception as e:
        raise HTTPException(502, f"spotify artist lookup failed: {e}")
