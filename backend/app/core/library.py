from __future__ import annotations

import logging
import re
import threading
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


class _Index:
    def __init__(self) -> None:
        self.by_isrc: dict[str, str] = {}
        self.by_fp: dict[tuple[str, str, str], str] = {}
        self._lock = threading.Lock()
        self._built = False

    def build(self, root: Path) -> None:
        with self._lock:
            self.by_isrc.clear()
            self.by_fp.clear()
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
                if isrc:
                    self.by_isrc.setdefault(isrc, str(path))
                fp = _fingerprint(artist, title, album)
                if fp != ("", "", ""):
                    self.by_fp.setdefault(fp, str(path))
                count += 1
            self._built = True
            logger.info("library index built: %d FLAC files under %s", count, root)

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
            if isrc:
                self.by_isrc[isrc] = str(path)
            fp = _fingerprint(artist, title, album)
            if fp != ("", "", ""):
                self.by_fp[fp] = str(path)

    def remove(self, path: Path) -> None:
        with self._lock:
            sp = str(path)
            for k, v in list(self.by_isrc.items()):
                if v == sp:
                    del self.by_isrc[k]
            for k, v in list(self.by_fp.items()):
                if v == sp:
                    del self.by_fp[k]

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

    @property
    def is_built(self) -> bool:
        return self._built


_index = _Index()


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
