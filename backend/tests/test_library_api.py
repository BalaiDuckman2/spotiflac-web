"""Tests for the library API endpoints. Spotify is mocked.

Calls the FastAPI route functions directly (no HTTP layer) to avoid pulling in
httpx as a dev dependency.
"""
from __future__ import annotations

from datetime import datetime

import pytest
from fastapi import HTTPException

from app.api import library as library_api
from app.api.library import (
    CompleteRequest,
    VerifyRequest,
    list_albums,
    verify_album,
)
from app.core import library as library_core
from app.core.library import AlbumInfo, _Index


@pytest.fixture
def fresh_index(monkeypatch):
    idx = _Index()
    idx._built = True
    monkeypatch.setattr(library_core, "_index", idx)
    yield idx


def _add_album(idx: _Index, *, artist="X", album="Y", disc=1, present=(1, 2, 3),
               total=3, spid=None, verified=False):
    info = AlbumInfo(album_artist=artist, album=album, disc_number=disc)
    info.paths = [f"/m/{album}/{n:02d}.flac" for n in present]
    info.cover_path = info.paths[0]
    info.track_numbers = set(present)
    info.track_total = total
    info.spotify_album_id = spid
    if verified:
        info.last_verified_at = datetime.utcnow()
        info.spotify_total = total
    idx.by_album[info.key] = info
    return info


# ---------------------------------------------------------------------------
# list_albums
# ---------------------------------------------------------------------------

def test_list_albums_default_filter_is_incomplete(fresh_index):
    _add_album(fresh_index, album="Done", present=(1, 2, 3), total=3)
    _add_album(fresh_index, album="Holes", present=(1, 3), total=3)
    body = list_albums(status="incomplete", search="", limit=50, offset=0)
    titles = [it["album"] for it in body["items"]]
    assert titles == ["Holes"]
    assert body["total"] == 1


def test_list_albums_status_all(fresh_index):
    _add_album(fresh_index, album="Done", present=(1, 2, 3), total=3)
    _add_album(fresh_index, album="Holes", present=(1, 3), total=3)
    body = list_albums(status="all", search="", limit=50, offset=0)
    assert body["total"] == 2


# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------

class _FakeTrack:
    def __init__(self, n, t, tid):
        self.track_number, self.title, self.id = n, t, tid


def test_verify_with_known_id(fresh_index, monkeypatch):
    info = _add_album(fresh_index, artist="Daft Punk", album="RAM",
                      present=(1, 2), total=13, spid="abc123")

    def fake_get_album_tracks(self, album_id):
        assert album_id == "abc123"
        return ({"total_tracks": 13}, [
            _FakeTrack(n, f"t{n}", f"id{n}") for n in range(1, 14)
        ])
    from SpotiFLAC.providers.spotify_metadata import SpotifyMetadataClient
    monkeypatch.setattr(SpotifyMetadataClient, "get_album_tracks", fake_get_album_tracks)

    body = verify_album(VerifyRequest(album_artist="Daft Punk", album="RAM"))
    assert body["verified"] is True
    assert body["spotify_total"] == 13
    assert len(body["missing"]) == 11
    assert info.last_verified_at is not None


def test_verify_with_strong_similarity_search(fresh_index, monkeypatch):
    _add_album(fresh_index, artist="Daft Punk", album="Discovery",
               present=(1, 2), total=14)

    def fake_search(query, types, limit=20):
        return {"albums": [
            {"id": "found1", "title": "Discovery", "artists": "Daft Punk",
             "year": "2001", "total_tracks": 14, "cover_url": "", "url": ""},
        ]}
    monkeypatch.setattr(library_api.spotify_search, "search", fake_search)

    def fake_get_album_tracks(self, album_id):
        assert album_id == "found1"
        return ({"total_tracks": 14}, [
            _FakeTrack(n, f"t{n}", f"id{n}") for n in range(1, 15)
        ])
    from SpotiFLAC.providers.spotify_metadata import SpotifyMetadataClient
    monkeypatch.setattr(SpotifyMetadataClient, "get_album_tracks", fake_get_album_tracks)

    body = verify_album(VerifyRequest(album_artist="Daft Punk", album="Discovery"))
    assert body["verified"] is True
    assert body["spotify_album_id"] == "found1"


def test_verify_with_supplied_spotify_id_skips_search(fresh_index, monkeypatch):
    _add_album(fresh_index, artist="A", album="B", present=(1,), total=2)

    search_called = []
    def fake_search(*a, **kw):
        search_called.append(True)
        return {"albums": []}
    monkeypatch.setattr(library_api.spotify_search, "search", fake_search)

    def fake_get_album_tracks(self, album_id):
        return ({"total_tracks": 2},
                [_FakeTrack(1, "t1", "i1"), _FakeTrack(2, "t2", "i2")])
    from SpotiFLAC.providers.spotify_metadata import SpotifyMetadataClient
    monkeypatch.setattr(SpotifyMetadataClient, "get_album_tracks", fake_get_album_tracks)

    body = verify_album(VerifyRequest(
        album_artist="A", album="B", spotify_album_id="user_picked",
    ))
    assert body["spotify_album_id"] == "user_picked"
    assert not search_called


def test_verify_album_not_in_index_returns_404(fresh_index):
    with pytest.raises(HTTPException) as exc:
        verify_album(VerifyRequest(album_artist="No", album="Such"))
    assert exc.value.status_code == 404


def test_verify_no_search_results_returns_404(fresh_index, monkeypatch):
    _add_album(fresh_index, artist="X", album="Y", present=(1,), total=2)
    monkeypatch.setattr(library_api.spotify_search, "search",
                        lambda *a, **kw: {"albums": []})
    with pytest.raises(HTTPException) as exc:
        verify_album(VerifyRequest(album_artist="X", album="Y"))
    assert exc.value.status_code == 404
