from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from SpotiFLAC.providers.spotify_metadata import SpotifyMetadataClient, parse_spotify_url
from SpotiFLAC.core.models import TrackMetadata

logger = logging.getLogger(__name__)


_client: SpotifyMetadataClient | None = None


def get_client() -> SpotifyMetadataClient:
    global _client
    if _client is None:
        _client = SpotifyMetadataClient(timeout_s=15)
    return _client


# In-memory preview cache: avoids re-fetching huge playlists on every action.
# Keyed by Spotify URL. TTL is short enough that user-visible staleness is fine.
_PREVIEW_CACHE_TTL_S = 300.0   # 5 minutes
_preview_cache: dict[str, tuple[float, "PreviewResult"]] = {}
_preview_lock = threading.Lock()


def cached_preview(url: str) -> "PreviewResult":
    """Return cached PreviewResult for `url`, fetching only if missing/stale."""
    now = time.monotonic()
    with _preview_lock:
        entry = _preview_cache.get(url)
        if entry and now - entry[0] < _PREVIEW_CACHE_TTL_S:
            return entry[1]
    result = fetch_preview(url)
    with _preview_lock:
        _preview_cache[url] = (now, result)
        # Cap memory: keep at most 32 entries.
        if len(_preview_cache) > 32:
            oldest = min(_preview_cache.items(), key=lambda kv: kv[1][0])[0]
            _preview_cache.pop(oldest, None)
    return result


def invalidate_preview_cache(url: str | None = None) -> None:
    with _preview_lock:
        if url is None:
            _preview_cache.clear()
        else:
            _preview_cache.pop(url, None)


def track_to_dto(t: TrackMetadata, *, position: int | None = None) -> dict[str, Any]:
    return {
        "id": t.id,
        "title": t.title,
        "artists": t.artists,
        "album": t.album,
        "album_artist": t.album_artist,
        "duration_ms": t.duration_ms,
        "isrc": t.isrc,
        "track_number": t.track_number,
        "disc_number": t.disc_number,
        "year": t.year,
        "cover_url": t.cover_url,
        "external_url": t.external_url,
        "position": position if position is not None else t.track_number,
    }


@dataclass
class PreviewResult:
    kind: str          # "track", "album", "playlist", "artist"
    id: str
    title: str
    cover_url: str
    subtitle: str
    total_tracks: int
    tracks: list[dict[str, Any]]
    raw_url: str

    def to_dto(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "id": self.id,
            "title": self.title,
            "cover_url": self.cover_url,
            "subtitle": self.subtitle,
            "total_tracks": self.total_tracks,
            "tracks": self.tracks,
            "url": self.raw_url,
        }


def fetch_preview(url: str) -> PreviewResult:
    """Fetch metadata for a Spotify URL and produce a frontend-ready preview."""
    info = parse_spotify_url(url)
    kind = info["type"]
    sid = info["id"]
    client = get_client()

    if kind == "track":
        meta = client.get_track(sid)
        return PreviewResult(
            kind="track",
            id=sid,
            title=meta.title,
            cover_url=meta.cover_url,
            subtitle=meta.artists,
            total_tracks=1,
            tracks=[track_to_dto(meta, position=1)],
            raw_url=url,
        )

    if kind == "album":
        album, tracks = client.get_album_tracks(sid)
        cover = (album.get("images") or [{}])[0].get("url", "")
        artists = ", ".join(a.get("name", "") for a in album.get("artists", []))
        year = (album.get("release_date") or "")[:4]
        return PreviewResult(
            kind="album",
            id=sid,
            title=album.get("name", "Unknown"),
            cover_url=cover,
            subtitle=f"{artists} · {len(tracks)} tracks · {year}".strip(" ·"),
            total_tracks=len(tracks),
            tracks=[track_to_dto(t, position=t.track_number or i + 1) for i, t in enumerate(tracks)],
            raw_url=url,
        )

    if kind == "playlist":
        playlist, tracks = client.get_playlist_tracks(sid)
        owner = (playlist.get("owner") or {}).get("display_name", "")
        followers = (playlist.get("followers") or {}).get("total", 0)
        cover = (playlist.get("images") or [{}])[0].get("url", "")
        return PreviewResult(
            kind="playlist",
            id=sid,
            title=playlist.get("name", "Unknown Playlist"),
            cover_url=cover,
            subtitle=f"{owner} · {len(tracks)} tracks · {followers} followers",
            total_tracks=len(tracks),
            tracks=[track_to_dto(t, position=i + 1) for i, t in enumerate(tracks)],
            raw_url=url,
        )

    raise ValueError(f"Unsupported Spotify URL kind: {kind}")


SPOTIFY_URL_RE = re.compile(
    r"^https?://(open|play|embed)\.spotify\.com/(intl-[a-z]{2}/)?(track|album|playlist)/[A-Za-z0-9]+",
    re.IGNORECASE,
)


def is_valid_spotify_url(url: str) -> bool:
    if not url:
        return False
    if url.startswith("spotify:"):
        return True
    return bool(SPOTIFY_URL_RE.match(url.strip()))
