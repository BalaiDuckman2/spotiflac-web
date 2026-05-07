"""Thin wrapper around SpotiFLAC's SpotifyMetadataClient for name-based search.

Reuses the existing OAuth client_credentials Bearer token (held inside
SpotifyMetadataClient) so we don't manage auth separately. Calls into
the private `_get` helper because that's where the token + 429 retry
live; if SpotiFLAC ever renames or refactors `_get`, the unit tests in
test_spotify_search.py will catch it.
"""
from __future__ import annotations

from typing import TypedDict
from urllib.parse import urlencode

from SpotiFLAC.providers.spotify_metadata import SpotifyMetadataClient

from .metadata import get_client as _get_client   # share the singleton/token

_VALID_TYPES = {"track", "album", "playlist", "artist"}
_DEFAULT_MARKET = "FR"


class SearchResult(TypedDict):
    tracks: list[dict]
    albums: list[dict]
    playlists: list[dict]
    artists: list[dict]


def search(query: str, types: list[str], limit: int = 20) -> SearchResult:
    """Search Spotify by free text. `types` filters which buckets are queried."""
    type_param = ",".join(t for t in types if t in _VALID_TYPES)
    if not type_param:
        type_param = "track,album,playlist,artist"
    qs = urlencode({"q": query, "type": type_param, "limit": limit, "market": _DEFAULT_MARKET})
    raw = _get_client()._get(f"/search?{qs}")
    return {
        "tracks":    [_track_dto(t)    for t in (raw.get("tracks")    or {}).get("items", []) if t],
        "albums":    [_album_dto(a)    for a in (raw.get("albums")    or {}).get("items", []) if a],
        "playlists": [_playlist_dto(p) for p in (raw.get("playlists") or {}).get("items", []) if p],
        "artists":   [_artist_dto(a)   for a in (raw.get("artists")   or {}).get("items", []) if a],
    }


def get_artist_albums(artist_id: str, limit: int = 50) -> dict:
    """Return artist info + every album/single grouped by `album_group`."""
    client = _get_client()
    artist = client._get(f"/artists/{artist_id}")
    raw = client._get(
        f"/artists/{artist_id}/albums?include_groups=album,single&limit={limit}&market={_DEFAULT_MARKET}"
    )
    return {
        "id":        artist_id,
        "name":      artist.get("name", ""),
        "cover_url": _best_image(artist.get("images", [])),
        "items":     [_album_dto(a, include_group=True) for a in raw.get("items", [])],
    }


def _best_image(images: list[dict]) -> str:
    return images[0].get("url", "") if images else ""


def _track_dto(t: dict) -> dict:
    album = t.get("album") or {}
    return {
        "id":          t.get("id", ""),
        "title":       t.get("name", ""),
        "artists":     ", ".join(a.get("name", "") for a in t.get("artists", [])),
        "album":       album.get("name", ""),
        "cover_url":   _best_image(album.get("images", [])),
        "duration_ms": t.get("duration_ms", 0),
        "url":         t.get("external_urls", {}).get("spotify", ""),
    }


def _album_dto(a: dict, include_group: bool = False) -> dict:
    dto = {
        "id":           a.get("id", ""),
        "title":        a.get("name", ""),
        "artists":      ", ".join(ar.get("name", "") for ar in a.get("artists", [])),
        "cover_url":    _best_image(a.get("images", [])),
        "year":         (a.get("release_date") or "")[:4],
        "total_tracks": a.get("total_tracks", 0),
        "url":          a.get("external_urls", {}).get("spotify", ""),
    }
    if include_group:
        dto["album_group"] = a.get("album_group", "album")
    return dto


def _playlist_dto(p: dict) -> dict:
    return {
        "id":           p.get("id", ""),
        "name":         p.get("name", ""),
        "owner":        (p.get("owner") or {}).get("display_name", ""),
        "cover_url":    _best_image(p.get("images", [])),
        "total_tracks": (p.get("tracks") or {}).get("total", 0),
        "url":          p.get("external_urls", {}).get("spotify", ""),
    }


def _artist_dto(a: dict) -> dict:
    return {
        "id":        a.get("id", ""),
        "name":      a.get("name", ""),
        "cover_url": _best_image(a.get("images", [])),
        "url":       a.get("external_urls", {}).get("spotify", ""),
    }
