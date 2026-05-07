from pathlib import Path

from app.core.paths import build_track_path, resolve_existing, sanitize
from app.core.settings import FileManagementSettings


def test_sanitize_strips_illegal():
    assert sanitize('a/b\\c:d*?"<>|') == "a_b_c_d______"
    assert sanitize("  trailing.  ") == "trailing"
    assert sanitize("") == "_"


def test_build_track_path_album(tmp_path):
    s = FileManagementSettings()
    p = build_track_path(
        s,
        kind="album",
        track_meta={
            "title": "Hello",
            "artist": "World",
            "album": "Greetings",
            "album_artist": "World",
            "track": 3,
            "year": "2024",
            "isrc": "X",
        },
        base_dir=tmp_path,
    )
    assert p == tmp_path / "World" / "Greetings" / "03 - Hello.flac"


def test_build_track_path_playlist(tmp_path):
    s = FileManagementSettings()
    p = build_track_path(
        s,
        kind="playlist",
        track_meta={"title": "Track A", "artist": "Artist"},
        context={"playlist": "My Mix", "position": 7},
        base_dir=tmp_path,
    )
    assert p == tmp_path / "Playlists" / "My Mix" / "07 - Artist - Track A.flac"


def test_build_track_path_sanitizes(tmp_path):
    s = FileManagementSettings()
    p = build_track_path(
        s,
        kind="album",
        track_meta={
            "title": "AC/DC?",
            "artist": "AC/DC",
            "album": "Back: in Black",
            "album_artist": "AC/DC",
            "track": 1,
        },
        base_dir=tmp_path,
    )
    assert "/" not in p.name
    assert "AC_DC" in str(p)


def test_resolve_existing_skip(tmp_path):
    target = tmp_path / "x.flac"
    target.write_bytes(b"")
    assert resolve_existing(target, "skip") is None


def test_resolve_existing_overwrite(tmp_path):
    target = tmp_path / "x.flac"
    target.write_bytes(b"")
    assert resolve_existing(target, "overwrite") == target


def test_resolve_existing_rename(tmp_path):
    target = tmp_path / "x.flac"
    target.write_bytes(b"")
    new = resolve_existing(target, "rename")
    assert new == tmp_path / "x (1).flac"
    new.write_bytes(b"")
    new2 = resolve_existing(target, "rename")
    assert new2 == tmp_path / "x (2).flac"


def test_resolve_existing_missing(tmp_path):
    target = tmp_path / "missing.flac"
    assert resolve_existing(target, "skip") == target
