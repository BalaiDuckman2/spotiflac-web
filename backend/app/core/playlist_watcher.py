from __future__ import annotations

import logging
import threading
from typing import Any

from . import history_db, watched_db
from .logs import emit_log
from .metadata import PreviewResult, fetch_preview
from .paths import build_track_path, resolve_existing
from .queue import Job, JobQueue, get_queue, make_job_id
from .settings import MUSIC_DIR, get_settings

logger = logging.getLogger(__name__)


def enqueue_new_tracks_from_playlist(
    preview: PreviewResult,
    playlist_url: str,
    queue: JobQueue,
) -> list[str]:
    """Enqueue tracks from `preview` that are not already downloaded or queued.

    Returns the list of new job ids.
    """
    if preview.kind != "playlist":
        raise ValueError(f"expected a playlist preview, got {preview.kind}")

    settings = get_settings()
    track_ids = [t["id"] for t in preview.tracks]
    already_downloaded = history_db.existing_track_ids(track_ids)
    in_queue = {
        j.spotify_track_id
        for j in queue.list_active()
        if j.spotify_track_id
    }

    new_job_ids: list[str] = []
    for i, track in enumerate(preview.tracks):
        tid = track["id"]
        if tid in already_downloaded or tid in in_queue:
            continue
        position = i + 1

        track_meta_for_path = {
            "title": track["title"],
            "artist": track["artists"],
            "album": track["album"],
            "album_artist": track.get("album_artist") or track["artists"],
            "track": track.get("track_number") or position,
            "year": track.get("year") or "",
            "isrc": track.get("isrc") or "",
            "disc": track.get("disc_number") or 1,
        }
        target = build_track_path(
            settings.file_management,
            kind="playlist",
            track_meta=track_meta_for_path,
            context={"playlist": preview.title, "position": position},
            base_dir=MUSIC_DIR,
        )
        resolved = resolve_existing(target, settings.file_management.on_existing)
        if resolved is None:
            continue

        jid = make_job_id()
        job = Job(
            id=jid,
            spotify_track_id=tid,
            track_meta=track,
            target_path=str(resolved),
            services=list(settings.general.providers),
            quality=settings.general.quality,
            embed_lyrics=settings.general.embed_lyrics,
            enrich_metadata=True,
            sp_dc=settings.general.sp_dc,
            qobuz_token=settings.general.qobuz_token,
            position=position,
            is_album=False,
            context={
                "kind": "playlist",
                "title": preview.title,
                "url": playlist_url,
                "cover_url": preview.cover_url,
            },
        )
        queue.enqueue(job)
        new_job_ids.append(jid)

    return new_job_ids


def sync_one_playlist(pl: dict[str, Any], queue: JobQueue) -> dict[str, Any]:
    """Sync a single watched playlist. Updates DB status. Returns a small report."""
    try:
        preview = fetch_preview(pl["url"])
        new_ids = enqueue_new_tracks_from_playlist(preview, pl["url"], queue)
        watched_db.update_sync_status(pl["id"], success=True, error=None)
        if new_ids:
            emit_log(
                "info",
                f"watcher: enqueued {len(new_ids)} new track(s) from '{preview.title}'",
            )
        return {
            "ok": True,
            "new_job_ids": new_ids,
            "total_tracks": preview.total_tracks,
        }
    except Exception as exc:
        msg = str(exc) or exc.__class__.__name__
        watched_db.update_sync_status(pl["id"], success=False, error=msg)
        logger.warning("watcher: sync failed for %s: %s", pl.get("url"), msg)
        emit_log("warn", f"watcher: sync failed for {pl.get('name') or pl.get('url')}: {msg}")
        return {"ok": False, "error": msg}


class PlaylistWatcher(threading.Thread):
    POLL_INTERVAL_SECONDS = 15 * 60   # 15 min
    INITIAL_DELAY_SECONDS = 30        # let the app finish booting before first run

    def __init__(self) -> None:
        super().__init__(name="playlist-watcher", daemon=True)
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        if self._stop.wait(self.INITIAL_DELAY_SECONDS):
            return
        while not self._stop.is_set():
            try:
                self._sync_all()
            except Exception:
                logger.exception("watcher: unexpected error in sync loop")
            if self._stop.wait(self.POLL_INTERVAL_SECONDS):
                return

    def _sync_all(self) -> None:
        queue = get_queue()
        playlists = watched_db.list_watched()
        active = [p for p in playlists if p.get("is_active")]
        if not active:
            return
        emit_log("debug", f"watcher: checking {len(active)} watched playlist(s)")
        for pl in active:
            if self._stop.is_set():
                return
            sync_one_playlist(pl, queue)


_watcher: PlaylistWatcher | None = None


def start_watcher() -> None:
    global _watcher
    if _watcher and _watcher.is_alive():
        return
    _watcher = PlaylistWatcher()
    _watcher.start()


def stop_watcher() -> None:
    global _watcher
    if _watcher:
        _watcher.stop()
        _watcher.join(timeout=2)
