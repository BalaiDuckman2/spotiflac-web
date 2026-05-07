from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from mutagen.flac import FLAC

from .settings import MUSIC_DIR

logger = logging.getLogger(__name__)


_PUNCT = re.compile(r"[^\w\s]+", re.UNICODE)


def _norm(s: str) -> str:
    if not s:
        return ""
    s = s.lower().strip()
    s = _PUNCT.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def _fingerprint(artist: str, title: str, album: str) -> tuple[str, str, str]:
    return (_norm(artist), _norm(title), _norm(album))


@dataclass
class AlbumInfo:
    album_artist: str               # original casing
    album: str                      # original casing
    disc_number: int = 1
    cover_path: str | None = None
    paths: list[str] = field(default_factory=list)
    track_numbers: set[int] = field(default_factory=set)
    track_total: int | None = None
    spotify_album_id: str | None = None
    spotify_total: int | None = None
    last_verified_at: datetime | None = None

    @property
    def expected(self) -> int | None:
        if self.spotify_total:
            return self.spotify_total
        if self.track_total:
            return self.track_total
        if self.track_numbers:
            return max(self.track_numbers)
        return None

    @property
    def status(self) -> str:
        exp = self.expected
        if exp is None:
            return "unknown"
        present = len(self.track_numbers)
        # complete = no gaps in 1..exp AND we have at least exp tracks
        if present >= exp and self.track_numbers >= set(range(1, exp + 1)):
            return "complete"
        return "incomplete"

    @property
    def missing_track_numbers(self) -> list[int]:
        exp = self.expected
        if exp is None:
            return []
        return sorted(set(range(1, exp + 1)) - self.track_numbers)

    @property
    def key(self) -> tuple[str, str, int]:
        return (_norm(self.album_artist), _norm(self.album), self.disc_number)


def _parse_int(value, default=None):
    if value is None:
        return default
    if isinstance(value, list):
        if not value:
            return default
        value = value[0]
    s = str(value).strip()
    # Sometimes tags are "3/12" — take only the leading number.
    s = s.split("/")[0]
    try:
        return int(s)
    except ValueError:
        return default


class _Index:
    def __init__(self) -> None:
        self.by_isrc: dict[str, str] = {}
        self.by_fp: dict[tuple[str, str, str], str] = {}
        self.by_album: dict[tuple[str, str, int], AlbumInfo] = {}
        self._lock = threading.Lock()
        self._built = False

    def build(self, root: Path) -> None:
        from .history_db import albums_with_spotify_id   # local import: avoid cycle
        with self._lock:
            self.by_isrc.clear()
            self.by_fp.clear()
            self.by_album.clear()
            if not root.exists():
                self._built = True
                return
            count = 0
            for path in root.rglob("*.flac"):
                try:
                    flac = FLAC(path)
                except Exception:
                    continue
                isrc = (flac.get("ISRC") or [""])[0].upper().strip()
                title = (flac.get("TITLE") or [""])[0]
                artist = (flac.get("ARTIST") or [""])[0]
                album = (flac.get("ALBUM") or [""])[0]
                album_artist = (
                    (flac.get("ALBUMARTIST") or flac.get("ALBUM ARTIST") or [artist] or [""])[0]
                )
                disc = _parse_int(flac.get("DISCNUMBER"), default=1) or 1
                track_num = _parse_int(flac.get("TRACKNUMBER"), default=None)
                track_total = (
                    _parse_int(flac.get("TRACKTOTAL"), default=None)
                    or _parse_int(flac.get("TOTALTRACKS"), default=None)
                )

                if isrc:
                    self.by_isrc.setdefault(isrc, str(path))
                fp = _fingerprint(artist, title, album)
                if fp != ("", "", ""):
                    self.by_fp.setdefault(fp, str(path))

                if album:
                    key = (_norm(album_artist), _norm(album), disc)
                    info = self.by_album.get(key)
                    if info is None:
                        info = AlbumInfo(
                            album_artist=album_artist or "Unknown",
                            album=album,
                            disc_number=disc,
                            cover_path=str(path),
                        )
                        self.by_album[key] = info
                    info.paths.append(str(path))
                    if track_num is not None:
                        info.track_numbers.add(track_num)
                    # First non-null TRACKTOTAL wins (different files in same album
                    # should agree; if they don't, the first scanned holds).
                    if track_total and info.track_total is None:
                        info.track_total = track_total

                count += 1

            # Cross-reference with history_db to fill spotify_album_id.
            try:
                refs = albums_with_spotify_id()
                for (artist_n, album_n), spid in refs.items():
                    for key, info in self.by_album.items():
                        if key[0] == artist_n and key[1] == album_n:
                            info.spotify_album_id = spid
            except Exception:
                logger.exception("library: history cross-ref failed (non-fatal)")

            self._built = True
            logger.info(
                "library index built: %d FLAC files, %d albums under %s",
                count, len(self.by_album), root,
            )

    def add(self, path: Path) -> None:
        with self._lock:
            try:
                flac = FLAC(path)
            except Exception:
                return
            isrc = (flac.get("ISRC") or [""])[0].upper().strip()
            title = (flac.get("TITLE") or [""])[0]
            artist = (flac.get("ARTIST") or [""])[0]
            album = (flac.get("ALBUM") or [""])[0]
            album_artist = (
                (flac.get("ALBUMARTIST") or flac.get("ALBUM ARTIST") or [artist] or [""])[0]
            )
            disc = _parse_int(flac.get("DISCNUMBER"), default=1) or 1
            track_num = _parse_int(flac.get("TRACKNUMBER"), default=None)
            track_total = (
                _parse_int(flac.get("TRACKTOTAL"), default=None)
                or _parse_int(flac.get("TOTALTRACKS"), default=None)
            )

            if isrc:
                self.by_isrc[isrc] = str(path)
            fp = _fingerprint(artist, title, album)
            if fp != ("", "", ""):
                self.by_fp[fp] = str(path)

            if album:
                key = (_norm(album_artist), _norm(album), disc)
                info = self.by_album.get(key)
                if info is None:
                    info = AlbumInfo(
                        album_artist=album_artist or "Unknown",
                        album=album,
                        disc_number=disc,
                        cover_path=str(path),
                    )
                    self.by_album[key] = info
                if str(path) not in info.paths:
                    info.paths.append(str(path))
                if track_num is not None:
                    info.track_numbers.add(track_num)
                if track_total and info.track_total is None:
                    info.track_total = track_total

    def remove(self, path: Path) -> None:
        with self._lock:
            sp = str(path)
            for k, v in list(self.by_isrc.items()):
                if v == sp:
                    del self.by_isrc[k]
            for k, v in list(self.by_fp.items()):
                if v == sp:
                    del self.by_fp[k]
            # Album removal: drop the path from every album it was in;
            # rebuild track_numbers from remaining files would require re-reading
            # tags, which is expensive. Instead, just drop the path; the album
            # re-aggregates correctly on next full rescan.
            for key, info in list(self.by_album.items()):
                if sp in info.paths:
                    info.paths.remove(sp)
                    if not info.paths:
                        del self.by_album[key]

    def has(self, *, isrc: str = "", fingerprint: dict | None = None) -> bool:
        with self._lock:
            isrc_norm = (isrc or "").upper().strip()
            if isrc_norm and isrc_norm in self.by_isrc:
                return True
            if fingerprint:
                fp = _fingerprint(
                    fingerprint.get("artist", ""),
                    fingerprint.get("title", ""),
                    fingerprint.get("album", ""),
                )
                if fp != ("", "", "") and fp in self.by_fp:
                    return True
            return False

    def get_album(
        self, album_artist: str, album: str, disc_number: int = 1
    ) -> AlbumInfo | None:
        with self._lock:
            return self.by_album.get((_norm(album_artist), _norm(album), disc_number))

    def list_albums(
        self,
        *,
        status: str = "all",
        search: str = "",
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[AlbumInfo], int]:
        if not self._built:
            init_library()
        with self._lock:
            items = list(self.by_album.values())
        if status != "all":
            items = [a for a in items if a.status == status]
        if search:
            s = _norm(search)
            items = [
                a for a in items
                if s in _norm(a.album_artist) or s in _norm(a.album)
            ]
        items.sort(key=lambda a: (a.album_artist.lower(), a.album.lower(), a.disc_number))
        total = len(items)
        return items[offset:offset + limit], total

    @property
    def is_built(self) -> bool:
        return self._built


_index = _Index()


def get_index() -> _Index:
    return _index


def rescan(root: Path | None = None) -> int:
    """Rebuild the library index. Returns number of files indexed."""
    _index.build(root or MUSIC_DIR)
    return len(_index.by_isrc) + len(_index.by_fp)


def init_library() -> None:
    """Lazy initial build at startup; safe to call multiple times."""
    if not _index.is_built:
        _index.build(MUSIC_DIR)


def add_to_index(path: Path) -> None:
    _index.add(path)


def remove_from_index(path: Path) -> None:
    _index.remove(path)


def check_already_present(*, isrc: str = "", fingerprint: dict | None = None) -> bool:
    if not _index.is_built:
        init_library()
    return _index.has(isrc=isrc, fingerprint=fingerprint)
