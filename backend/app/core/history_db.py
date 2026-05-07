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
