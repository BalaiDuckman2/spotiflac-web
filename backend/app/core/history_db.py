from __future__ import annotations

import os
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from .settings import CONFIG_DIR

DB_PATH = CONFIG_DIR / "history.db"

_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


_conn: sqlite3.Connection | None = None


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = _connect()
        _init_schema(_conn)
    return _conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            spotify_track_id TEXT NOT NULL,
            title TEXT,
            artists TEXT,
            album TEXT,
            cover_url TEXT,
            file_path TEXT,
            format TEXT DEFAULT 'flac',
            sample_rate TEXT DEFAULT '44.1kHz',
            bit_depth TEXT DEFAULT '16-bit',
            duration_ms INTEGER DEFAULT 0,
            provider TEXT,
            kind TEXT,
            collection_title TEXT,
            collection_url TEXT,
            downloaded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_downloads_at ON downloads(downloaded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_downloads_track ON downloads(spotify_track_id);

        CREATE TABLE IF NOT EXISTS fetches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            spotify_id TEXT NOT NULL,
            title TEXT,
            cover_url TEXT,
            url TEXT,
            total_tracks INTEGER DEFAULT 0,
            fetched_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fetches_at ON fetches(fetched_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fetches_unique ON fetches(kind, spotify_id);
        """
    )
    conn.commit()


def record_download(
    *,
    spotify_track_id: str,
    track: dict[str, Any],
    file_path: str,
    provider: str,
    context: dict[str, Any],
) -> None:
    with _lock:
        conn = get_conn()
        conn.execute(
            """
            INSERT INTO downloads
            (spotify_track_id, title, artists, album, cover_url, file_path,
             duration_ms, provider, kind, collection_title, collection_url, downloaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                spotify_track_id,
                track.get("title"),
                track.get("artists"),
                track.get("album"),
                track.get("cover_url") or context.get("cover_url"),
                file_path,
                track.get("duration_ms", 0),
                provider,
                context.get("kind"),
                context.get("title"),
                context.get("url"),
                datetime.utcnow().isoformat(),
            ),
        )
        conn.commit()


def record_fetch(
    *,
    kind: str,
    spotify_id: str,
    title: str,
    cover_url: str,
    url: str,
    total_tracks: int,
) -> None:
    with _lock:
        conn = get_conn()
        # Upsert: update fetched_at if exists
        conn.execute(
            """
            INSERT INTO fetches (kind, spotify_id, title, cover_url, url, total_tracks, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, spotify_id) DO UPDATE SET
              title = excluded.title,
              cover_url = excluded.cover_url,
              url = excluded.url,
              total_tracks = excluded.total_tracks,
              fetched_at = excluded.fetched_at
            """,
            (kind, spotify_id, title, cover_url, url, total_tracks, datetime.utcnow().isoformat()),
        )
        conn.commit()


def list_downloads(
    *,
    search: str = "",
    sort: str = "downloaded_at",
    direction: str = "desc",
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    sort_col = {
        "downloaded_at": "downloaded_at",
        "title": "title",
        "artists": "artists",
        "album": "album",
        "duration": "duration_ms",
    }.get(sort, "downloaded_at")
    direction = "DESC" if direction.lower() == "desc" else "ASC"
    where = ""
    params: list[Any] = []
    if search:
        where = "WHERE title LIKE ? OR artists LIKE ? OR album LIKE ?"
        like = f"%{search}%"
        params.extend([like, like, like])

    conn = get_conn()
    total = conn.execute(f"SELECT COUNT(*) FROM downloads {where}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM downloads {where} ORDER BY {sort_col} {direction} LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return [dict(r) for r in rows], total


def list_fetches(*, limit: int = 30, offset: int = 0) -> tuple[list[dict], int]:
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) FROM fetches").fetchone()[0]
    rows = conn.execute(
        "SELECT * FROM fetches ORDER BY fetched_at DESC LIMIT ? OFFSET ?",
        [limit, offset],
    ).fetchall()
    return [dict(r) for r in rows], total


def delete_download(download_id: int, *, delete_file: bool = False) -> dict | None:
    with _lock:
        conn = get_conn()
        row = conn.execute(
            "SELECT * FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
        if not row:
            return None
        if delete_file and row["file_path"]:
            try:
                p = Path(row["file_path"])
                if p.exists():
                    p.unlink()
            except OSError:
                pass
        conn.execute("DELETE FROM downloads WHERE id = ?", (download_id,))
        conn.commit()
        return dict(row)


def delete_fetch(fetch_id: int) -> bool:
    with _lock:
        conn = get_conn()
        cur = conn.execute("DELETE FROM fetches WHERE id = ?", (fetch_id,))
        conn.commit()
        return cur.rowcount > 0


def clear_all_downloads() -> int:
    with _lock:
        conn = get_conn()
        cur = conn.execute("DELETE FROM downloads")
        conn.commit()
        return cur.rowcount


def albums_with_spotify_id() -> dict[tuple[str, str], str]:
    """Return {(normalized_album_artist, normalized_album): spotify_album_id}.

    Reads the per-track download history and extracts the album id from the
    `collection_url` of rows where the collection was a Spotify album.
    Used by the library index at build time to fill `spotify_album_id`
    on AlbumInfo entries.
    """
    import re
    from .library import _norm   # local import to avoid cycle at module load

    conn = get_conn()
    rows = conn.execute(
        """
        SELECT album, artists, collection_url
          FROM downloads
         WHERE collection_url LIKE '%open.spotify.com/album/%'
        """
    ).fetchall()

    out: dict[tuple[str, str], str] = {}
    pat = re.compile(r"open\.spotify\.com/album/([A-Za-z0-9]+)")
    for r in rows:
        m = pat.search(r["collection_url"] or "")
        if not m:
            continue
        spid = m.group(1)
        # `artists` in this row is the track-level ARTIST (often == album_artist
        # for a regular album, but may differ for compilations). Best-effort.
        key = (_norm(r["artists"] or ""), _norm(r["album"] or ""))
        if key != ("", ""):
            out.setdefault(key, spid)
    return out


def existing_track_ids(track_ids: list[str]) -> set[str]:
    if not track_ids:
        return set()
    conn = get_conn()
    placeholders = ",".join("?" * len(track_ids))
    rows = conn.execute(
        f"SELECT DISTINCT spotify_track_id FROM downloads WHERE spotify_track_id IN ({placeholders})",
        track_ids,
    ).fetchall()
    return {r["spotify_track_id"] for r in rows}
