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
