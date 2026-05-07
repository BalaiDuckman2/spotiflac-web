"""Tests for spotify_search wrapper. SpotifyMetadataClient is monkeypatched."""
from __future__ import annotations

import pytest

from app.core import spotify_search


class _FakeClient:
    def __init__(self):
        self.calls: list[str] = []
        self.responses: dict[str, dict] = {}

    def _get(self, path: str, **kwargs):
        self.calls.append(path)
        for key, val in self.responses.items():
            if key in path:
                return val
        return {}


@pytest.fixture
def fake_client(monkeypatch):
    fc = _FakeClient()
    monkeypatch.setattr(spotify_search, "_get_client", lambda: fc)
    yield fc


def test_search_returns_all_buckets(fake_client):
    fake_client.responses["/search"] = {
        "tracks": {"items": [
            {"id": "t1", "name": "One More Time", "artists": [{"name": "Daft Punk"}],
             "album": {"name": "Discovery", "images": [{"url": "http://cover/t1.jpg"}]},
             "duration_ms": 320000,
             "external_urls": {"spotify": "https://open.spotify.com/track/t1"}},
        ]},
        "albums": {"items": [
            {"id": "a1", "name": "Discovery", "artists": [{"name": "Daft Punk"}],
             "images": [{"url": "http://cover/a1.jpg"}],
             "release_date": "2001-03-12", "total_tracks": 14,
             "external_urls": {"spotify": "https://open.spotify.com/album/a1"}},
        ]},
        "playlists": {"items": [
            {"id": "p1", "name": "Daft Essentials", "owner": {"display_name": "Spotify"},
             "images": [{"url": "http://cover/p1.jpg"}], "tracks": {"total": 50},
             "external_urls": {"spotify": "https://open.spotify.com/playlist/p1"}},
        ]},
        "artists": {"items": [
            {"id": "ar1", "name": "Daft Punk", "images": [{"url": "http://cover/ar1.jpg"}],
             "external_urls": {"spotify": "https://open.spotify.com/artist/ar1"}},
        ]},
    }

    result = spotify_search.search("daft punk", ["track", "album", "playlist", "artist"], limit=20)

    assert result["tracks"][0]["title"] == "One More Time"
    assert result["tracks"][0]["url"] == "https://open.spotify.com/track/t1"
    assert result["albums"][0]["year"] == "2001"
    assert result["albums"][0]["total_tracks"] == 14
    assert result["playlists"][0]["owner"] == "Spotify"
    assert result["artists"][0]["name"] == "Daft Punk"


def test_search_filters_unknown_types(fake_client):
    fake_client.responses["/search"] = {"tracks": {"items": []}}
    spotify_search.search("foo", ["track", "podcast", "show"])
    # The path should include only valid types.
    last = fake_client.calls[-1]
    assert "type=track" in last
    assert "podcast" not in last
    assert "show" not in last


def test_search_drops_null_items(fake_client):
    fake_client.responses["/search"] = {
        "tracks": {"items": [None, {"id": "t1", "name": "X", "artists": [], "album": {}, "external_urls": {}}, None]},
        "albums": {"items": [None, None]},
        "playlists": None,
        "artists": {"items": []},
    }
    result = spotify_search.search("x", ["track", "album", "playlist", "artist"])
    assert len(result["tracks"]) == 1
    assert result["tracks"][0]["id"] == "t1"
    assert result["albums"] == []
    assert result["playlists"] == []


def test_search_empty_types_defaults_to_all(fake_client):
    fake_client.responses["/search"] = {}
    spotify_search.search("foo", [])
    last = fake_client.calls[-1]
    assert "type=track%2Calbum%2Cplaylist%2Cartist" in last


def test_get_artist_albums_groups(fake_client):
    fake_client.responses["/artists/ar1?"] = {}  # not used, helper below uses prefix
    # Two _get calls happen: /artists/{id} then /artists/{id}/albums
    # We use prefix matches; first path is /artists/ar1, second is /artists/ar1/albums
    def get(path: str, **kwargs):
        fake_client.calls.append(path)
        if path.startswith("/artists/ar1/albums"):
            return {
                "items": [
                    {"id": "a1", "name": "Discovery", "artists": [{"name": "Daft Punk"}],
                     "release_date": "2001", "total_tracks": 14,
                     "album_group": "album", "images": [],
                     "external_urls": {"spotify": "https://open.spotify.com/album/a1"}},
                    {"id": "s1", "name": "Da Funk", "artists": [{"name": "Daft Punk"}],
                     "release_date": "1995", "total_tracks": 1,
                     "album_group": "single", "images": [],
                     "external_urls": {"spotify": "https://open.spotify.com/album/s1"}},
                ],
            }
        if path.startswith("/artists/ar1"):
            return {"name": "Daft Punk", "images": [{"url": "http://cover/artist.jpg"}]}
        return {}

    fake_client._get = get  # type: ignore[assignment]

    result = spotify_search.get_artist_albums("ar1", limit=50)

    assert result["id"] == "ar1"
    assert result["name"] == "Daft Punk"
    assert result["cover_url"] == "http://cover/artist.jpg"
    assert len(result["items"]) == 2
    groups = [it["album_group"] for it in result["items"]]
    assert "album" in groups and "single" in groups
