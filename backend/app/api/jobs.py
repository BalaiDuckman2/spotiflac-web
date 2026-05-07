from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..core.queue import Job, get_queue, make_job_id

router = APIRouter()


@router.get("/jobs")
def list_jobs():
    q = get_queue()
    jobs = q.list_all()
    return {"jobs": [j.to_dto() for j in jobs]}


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    q = get_queue()
    j = q.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j.to_dto()


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    q = get_queue()
    j = q.cancel(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return {"id": j.id, "status": j.status}


@router.delete("/jobs/{job_id}")
def remove_job(job_id: str):
    q = get_queue()
    ok = q.remove(job_id)
    if not ok:
        raise HTTPException(409, "job not removable (already running or finished)")
    return {"removed": True}


@router.post("/jobs/{job_id}/retry")
def retry_job(job_id: str):
    q = get_queue()
    j = q.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    if j.status not in ("failed", "cancelled"):
        raise HTTPException(409, "only failed/cancelled jobs can be retried")
    new = Job(
        id=make_job_id(),
        spotify_track_id=j.spotify_track_id,
        track_meta=j.track_meta,
        target_path=j.target_path,
        services=j.services,
        quality=j.quality,
        embed_lyrics=j.embed_lyrics,
        enrich_metadata=j.enrich_metadata,
        sp_dc=j.sp_dc,
        qobuz_token=j.qobuz_token,
        position=j.position,
        is_album=j.is_album,
        context=j.context,
    )
    q.enqueue(new)
    return {"new_id": new.id}


@router.post("/jobs/cancel-all")
def cancel_all():
    q = get_queue()
    n = q.cancel_all()
    return {"cancelled": n}


@router.post("/jobs/clear-finished")
def clear_finished():
    q = get_queue()
    n = q.clear_finished()
    return {"cleared": n}
