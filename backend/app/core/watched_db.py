from __future__ import annotations

import threading
from datetime import datetime
from typing import Any

from .history_db import get_conn

_lock = threading.Lock()


def init_watched_db() -> None:
    conn = get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS watched_playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            spotify_playlist_id TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL,
            name TEXT,
            cover_url TEXT,
            added_at TEXT NOT NULL,
            last_synced_at TEXT,
            last_error TEXT,
            is_active INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_watched_active ON watched_playlists(is_active);
        """
    )
    conn.commit()


def add_watched(
    *,
    spotify_playlist_id: str,
    url: str,
    name: str,
    cover_url: str,
) -> dict[str, Any]:
    with _lock:
        conn = get_conn()
        conn.execute(
            """
            INSERT INTO watched_playlists
              (spotify_playlist_id, url, name, cover_url, added_at, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(spotify_playlist_id) DO UPDATE SET
              url = excluded.url,
              name = excluded.name,
              cover_url = excluded.cover_url,
              is_active = 1
            """,
            (spotify_playlist_id, url, name, cover_url, datetime.utcnow().isoformat()),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM watched_playlists WHERE spotify_playlist_id = ?",
            (spotify_playlist_id,),
        ).fetchone()
        return dict(row)


def remove_watched(playlist_db_id: int) -> bool:
    with _lock:
        conn = get_conn()
        cur = conn.execute(
            "DELETE FROM watched_playlists WHERE id = ?", (playlist_db_id,)
        )
        conn.commit()
        return cur.rowcount > 0


def list_watched() -> list[dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM watched_playlists ORDER BY added_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_watched(playlist_db_id: int) -> dict[str, Any] | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM watched_playlists WHERE id = ?", (playlist_db_id,)
    ).fetchone()
    return dict(row) if row else None


def update_sync_status(
    playlist_db_id: int, *, success: bool, error: str | None
) -> None:
    now = datetime.utcnow().isoformat()
    with _lock:
        conn = get_conn()
        if success:
            conn.execute(
                "UPDATE watched_playlists SET last_synced_at = ?, last_error = NULL WHERE id = ?",
                (now, playlist_db_id),
            )
        else:
            conn.execute(
                "UPDATE watched_playlists SET last_error = ? WHERE id = ?",
                (error or "unknown error", playlist_db_id),
            )
        conn.commit()
