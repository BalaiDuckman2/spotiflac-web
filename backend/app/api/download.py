from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.metadata import fetch_preview, is_valid_spotify_url
from ..core.paths import build_track_path, resolve_existing
from ..core.queue import Job, get_queue, make_job_id
from ..core.settings import MUSIC_DIR, get_settings

router = APIRouter()


class DownloadRequest(BaseModel):
    url: str
    track_ids: list[str]
    # Optional override; if absent we re-fetch the URL preview to build context
    kind: str | None = None


@router.post("/download")
def enqueue_download(req: DownloadRequest):
    if not is_valid_spotify_url(req.url):
        raise HTTPException(400, "Invalid Spotify URL")
    if not req.track_ids:
        raise HTTPException(400, "track_ids is empty")

    settings = get_settings()
    preview = fetch_preview(req.url)
    selected_ids = set(req.track_ids)

    by_id = {t["id"]: t for t in preview.tracks}
    chosen = [
        (t, i + 1)
        for i, t in enumerate(preview.tracks)
        if t["id"] in selected_ids
    ]
    if not chosen:
        raise HTTPException(400, "no matching tracks")

    q = get_queue()
    job_ids: list[str] = []

    is_album = preview.kind == "album"
    is_playlist = preview.kind == "playlist"

    for track, position in chosen:
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
        ctx = (
            {"playlist": preview.title, "position": position}
            if is_playlist
            else {}
        )
        target = build_track_path(
            settings.file_management,
            kind=preview.kind,
            track_meta=track_meta_for_path,
            context=ctx,
            base_dir=MUSIC_DIR,
        )
        resolved = resolve_existing(target, settings.file_management.on_existing)
        if resolved is None:
            # Skip — already exists
            continue
        target_str = str(resolved)

        jid = make_job_id()
        job = Job(
            id=jid,
            spotify_track_id=track["id"],
            track_meta=track,
            target_path=target_str,
            services=list(settings.general.providers),
            quality=settings.general.quality,
            embed_lyrics=settings.general.embed_lyrics,
            enrich_metadata=True,
            sp_dc=settings.general.sp_dc,
            qobuz_token=settings.general.qobuz_token,
            position=position,
            is_album=is_album,
            context={
                "kind": preview.kind,
                "title": preview.title,
                "url": req.url,
                "cover_url": preview.cover_url,
            },
        )
        q.enqueue(job)
        job_ids.append(jid)

    return {"job_ids": job_ids, "skipped": len(chosen) - len(job_ids)}
