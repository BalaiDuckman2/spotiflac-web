from pathlib import Path

import pytest
from mutagen.flac import FLAC, StreamInfo

from app.core.library import (
    _Index,
    _fingerprint,
    _norm,
)


def test_norm_strips_punct():
    assert _norm("AC/DC: Greatest!") == "ac dc greatest"
    assert _norm("  Foo   Bar  ") == "foo bar"
    assert _norm("") == ""


def test_fingerprint_identical():
    a = _fingerprint("AC/DC", "Back in Black", "Back: in Black")
    b = _fingerprint("ac-dc", "back in black", "back in black")
    assert a == b


def _make_fake_flac(path: Path, *, title: str, artist: str, album: str, isrc: str = ""):
    """Mutagen needs a valid FLAC stream; we cheat by building tags only via touch."""
    # Use a tiny silent FLAC fixture would need real audio. For testing the index,
    # we can just ensure FLAC() raises on an empty file → the index skips it.
    # So instead, mock at the _Index level by patching _build to call .add directly.
    pass


def test_index_add_via_dict(monkeypatch):
    idx = _Index()
    fake_path = "/music/fake.flac"

    class FakeFlac:
        def __init__(self, p):
            self._tags = {
                "ISRC": ["USRC17600001"],
                "TITLE": ["My Song"],
                "ARTIST": ["The Band"],
                "ALBUM": ["Album One"],
            }

        def get(self, key, default=None):
            return self._tags.get(key, default)

    monkeypatch.setattr("app.core.library.FLAC", FakeFlac)
    idx.add(Path(fake_path))
    assert idx.has(isrc="USRC17600001")
    assert idx.has(fingerprint={"artist": "the band", "title": "my song", "album": "album one"})
    assert not idx.has(isrc="OTHER")


def test_index_remove(monkeypatch):
    idx = _Index()
    fake_path = "/music/fake.flac"

    class FakeFlac:
        def __init__(self, p):
            pass

        def get(self, key, default=None):
            return {
                "ISRC": ["X"],
                "TITLE": ["t"],
                "ARTIST": ["a"],
                "ALBUM": ["al"],
            }.get(key, default)

    monkeypatch.setattr("app.core.library.FLAC", FakeFlac)
    idx.add(Path(fake_path))
    assert idx.has(isrc="X")
    idx.remove(Path(fake_path))
    assert not idx.has(isrc="X")


def test_index_has_empty_inputs(monkeypatch):
    idx = _Index()
    assert not idx.has(isrc="", fingerprint=None)
    assert not idx.has(isrc="", fingerprint={"artist": "", "title": "", "album": ""})


# ---------------------------------------------------------------------------
# Album aggregation
# ---------------------------------------------------------------------------

def _norm_pathkey(p) -> str:
    """OS-agnostic path key: forward slashes only."""
    return str(p).replace("\\", "/")


def _make_fake_flac_factory(rows):
    """rows: list of dicts keyed by tag name. Returns a FakeFlac class that
    looks up the row matching its constructor path (str)."""
    by_path = {_norm_pathkey(r["__path__"]): r for r in rows}

    class FakeFlac:
        def __init__(self, path):
            self._row = by_path[_norm_pathkey(path)]

        def get(self, key, default=None):
            v = self._row.get(key)
            if v is None:
                return default
            # Real Mutagen always returns lists for vorbis comments
            return v if isinstance(v, list) else [v]

    return FakeFlac


def _add_many(idx, rows, monkeypatch):
    monkeypatch.setattr("app.core.library.FLAC", _make_fake_flac_factory(rows))
    for r in rows:
        idx.add(Path(r["__path__"]))


def test_album_aggregation_groups_by_album(monkeypatch):
    idx = _Index()
    rows = [
        {"__path__": "/m/RAM/01.flac", "ALBUMARTIST": "Daft Punk", "ALBUM": "RAM",
         "ARTIST": "Daft Punk", "TITLE": "Give Life Back to Music",
         "TRACKNUMBER": "1", "TRACKTOTAL": "13", "DISCNUMBER": "1"},
        {"__path__": "/m/RAM/02.flac", "ALBUMARTIST": "Daft Punk", "ALBUM": "RAM",
         "ARTIST": "Daft Punk", "TITLE": "The Game of Love",
         "TRACKNUMBER": "2", "TRACKTOTAL": "13", "DISCNUMBER": "1"},
        {"__path__": "/m/RAM/04.flac", "ALBUMARTIST": "Daft Punk", "ALBUM": "RAM",
         "ARTIST": "Daft Punk", "TITLE": "Within",
         "TRACKNUMBER": "4", "TRACKTOTAL": "13", "DISCNUMBER": "1"},
    ]
    _add_many(idx, rows, monkeypatch)
    info = idx.get_album("Daft Punk", "RAM", 1)
    assert info is not None
    assert info.track_numbers == {1, 2, 4}
    assert info.track_total == 13
    assert info.expected == 13
    assert info.status == "incomplete"
    assert info.missing_track_numbers == [3, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    assert len(info.paths) == 3


def test_album_status_complete(monkeypatch):
    idx = _Index()
    rows = [
        {"__path__": f"/m/A/{i:02d}.flac", "ALBUMARTIST": "X", "ALBUM": "A",
         "ARTIST": "X", "TITLE": f"t{i}", "TRACKNUMBER": str(i), "TRACKTOTAL": "3"}
        for i in (1, 2, 3)
    ]
    _add_many(idx, rows, monkeypatch)
    info = idx.get_album("X", "A")
    assert info.status == "complete"


def test_album_status_unknown_when_no_total_no_tracknumber(monkeypatch):
    idx = _Index()
    rows = [
        {"__path__": "/m/A/x.flac", "ALBUMARTIST": "X", "ALBUM": "A",
         "ARTIST": "X", "TITLE": "x"},
    ]
    _add_many(idx, rows, monkeypatch)
    info = idx.get_album("X", "A")
    assert info.status == "unknown"


def test_album_case_insensitive_grouping(monkeypatch):
    idx = _Index()
    rows = [
        {"__path__": "/m/A/01.flac", "ALBUMARTIST": "Daft Punk", "ALBUM": "RAM",
         "ARTIST": "Daft Punk", "TITLE": "t1", "TRACKNUMBER": "1", "TRACKTOTAL": "2"},
        {"__path__": "/m/A/02.flac", "ALBUMARTIST": "daft punk", "ALBUM": "ram",
         "ARTIST": "Daft Punk", "TITLE": "t2", "TRACKNUMBER": "2", "TRACKTOTAL": "2"},
    ]
    _add_many(idx, rows, monkeypatch)
    info = idx.get_album("Daft Punk", "RAM")
    assert info is not None
    assert info.track_numbers == {1, 2}
    assert info.status == "complete"
    # No second entry created
    assert len([k for k in idx.by_album.keys() if k[1] == "ram"]) == 1


def test_album_multidisc_separate(monkeypatch):
    idx = _Index()
    rows = [
        {"__path__": "/m/W/d1-01.flac", "ALBUMARTIST": "Pink Floyd", "ALBUM": "The Wall",
         "ARTIST": "Pink Floyd", "TITLE": "t", "TRACKNUMBER": "1", "TRACKTOTAL": "13",
         "DISCNUMBER": "1"},
        {"__path__": "/m/W/d2-01.flac", "ALBUMARTIST": "Pink Floyd", "ALBUM": "The Wall",
         "ARTIST": "Pink Floyd", "TITLE": "t", "TRACKNUMBER": "1", "TRACKTOTAL": "13",
         "DISCNUMBER": "2"},
    ]
    _add_many(idx, rows, monkeypatch)
    d1 = idx.get_album("Pink Floyd", "The Wall", 1)
    d2 = idx.get_album("Pink Floyd", "The Wall", 2)
    assert d1 is not None and d2 is not None
    assert d1.disc_number == 1 and d2.disc_number == 2


def test_list_albums_filter_status(monkeypatch):
    idx = _Index()
    rows = [
        {"__path__": "/m/c/01.flac", "ALBUMARTIST": "Z", "ALBUM": "Complete",
         "ARTIST": "Z", "TITLE": "t", "TRACKNUMBER": "1", "TRACKTOTAL": "1"},
        {"__path__": "/m/i/01.flac", "ALBUMARTIST": "Z", "ALBUM": "Incomplete",
         "ARTIST": "Z", "TITLE": "t", "TRACKNUMBER": "1", "TRACKTOTAL": "5"},
    ]
    _add_many(idx, rows, monkeypatch)
    idx._built = True   # bypass init_library

    items, total = idx.list_albums(status="complete", limit=10)
    assert total == 1 and items[0].album == "Complete"

    items, total = idx.list_albums(status="incomplete", limit=10)
    assert total == 1 and items[0].album == "Incomplete"

    items, total = idx.list_albums(status="all", limit=10)
    assert total == 2


def test_list_albums_search(monkeypatch):
    idx = _Index()
    rows = [
        {"__path__": "/m/a/01.flac", "ALBUMARTIST": "Daft Punk", "ALBUM": "RAM",
         "ARTIST": "Daft Punk", "TITLE": "t", "TRACKNUMBER": "1", "TRACKTOTAL": "2"},
        {"__path__": "/m/b/01.flac", "ALBUMARTIST": "Justice", "ALBUM": "Cross",
         "ARTIST": "Justice", "TITLE": "t", "TRACKNUMBER": "1", "TRACKTOTAL": "2"},
    ]
    _add_many(idx, rows, monkeypatch)
    idx._built = True

    items, total = idx.list_albums(search="daft", status="all")
    assert total == 1 and items[0].album_artist == "Daft Punk"
