from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from .settings import MUSIC_DIR, FileManagementSettings, OnExisting

_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def sanitize(name: str, max_len: int = 180) -> str:
    if not name:
        return "_"
    name = unicodedata.normalize("NFC", name)
    name = _ILLEGAL.sub("_", name).strip().rstrip(".")
    if not name:
        return "_"
    if len(name) > max_len:
        name = name[:max_len].rstrip()
    return name


def _format_template(template: str, ctx: dict) -> str:
    """Apply template, sanitizing each value before substitution so that
    illegal chars in metadata (e.g. "AC/DC") don't act as path separators."""
    safe_ctx: dict = {}
    for k, v in ctx.items():
        sv = _safe_value(v)
        if isinstance(sv, str):
            safe_ctx[k] = sanitize(sv) if sv else ""
        else:
            safe_ctx[k] = sv
    formatted = template.format(**safe_ctx)
    parts = [p for p in formatted.split("/") if p]
    return "/".join(parts)


def _safe_value(v) -> str:
    if v is None:
        return ""
    if isinstance(v, int):
        return v
    return str(v)


def build_track_path(
    settings: FileManagementSettings,
    *,
    kind: str,
    track_meta: dict,
    context: dict | None = None,
    base_dir: Path | None = None,
) -> Path:
    """Build absolute output path.

    `kind` is "track", "album", or "playlist".
    `track_meta` provides title, artist, album, album_artist, track, year, isrc, disc.
    `context` may include playlist name and track position for playlists.
    """
    base = base_dir or MUSIC_DIR
    ctx = {
        "title": track_meta.get("title") or "",
        "artist": track_meta.get("artist") or "",
        "album": track_meta.get("album") or "",
        "album_artist": track_meta.get("album_artist") or track_meta.get("artist") or "",
        "track": int(track_meta.get("track") or 0),
        "year": track_meta.get("year") or "",
        "isrc": track_meta.get("isrc") or "",
        "disc": int(track_meta.get("disc") or 1),
        "playlist": (context or {}).get("playlist") or "",
        "position": int((context or {}).get("position") or 0),
    }
    template = settings.playlist_template if kind == "playlist" else settings.track_template
    rel = _format_template(template, ctx)
    return base / rel


def resolve_existing(target: Path, on_existing: OnExisting) -> Path | None:
    """Apply the configured policy when `target` already exists.

    Returns the path to write, or None if the file should be skipped.
    """
    if not target.exists():
        return target
    if on_existing == "skip":
        return None
    if on_existing == "overwrite":
        return target
    # rename: append (1), (2)...
    stem = target.stem
    suffix = target.suffix
    parent = target.parent
    n = 1
    while True:
        candidate = parent / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
        n += 1
