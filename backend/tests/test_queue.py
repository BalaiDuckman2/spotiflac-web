from app.core.queue import Job, JobQueue, make_job_id


def _make_job(**overrides) -> Job:
    base = dict(
        id=make_job_id(),
        spotify_track_id="abc",
        track_meta={"title": "T", "artists": "A", "album": "Al", "duration_ms": 1},
        target_path="/music/T.flac",
        services=["tidal"],
        quality="LOSSLESS",
        embed_lyrics=True,
        enrich_metadata=True,
        sp_dc="",
        qobuz_token="",
        position=1,
        is_album=False,
    )
    base.update(overrides)
    return Job(**base)


def test_enqueue_and_get():
    q = JobQueue()
    j = _make_job()
    q.enqueue(j)
    next_job = q.get_next(timeout=0.1)
    assert next_job is not None
    assert next_job.id == j.id


def test_cancel_queued():
    q = JobQueue()
    j = _make_job()
    q.enqueue(j)
    cancelled = q.cancel(j.id)
    assert cancelled.status == "cancelled"
    next_job = q.get_next(timeout=0.1)
    assert next_job is None


def test_remove_only_when_queued():
    q = JobQueue()
    j = _make_job()
    q.enqueue(j)
    j.status = "downloading"
    assert not q.remove(j.id)
    j.status = "queued"
    assert q.remove(j.id)


def test_retry_target():
    q = JobQueue()
    j = _make_job()
    j.status = "failed"
    q.enqueue(j)
    fetched = q.get(j.id)
    assert fetched.status == "failed"


def test_dto_keys():
    j = _make_job()
    dto = j.to_dto()
    assert dto["id"] == j.id
    assert dto["track"]["title"] == "T"
    assert dto["status"] == "queued"
