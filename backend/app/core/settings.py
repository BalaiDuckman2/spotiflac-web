from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
MUSIC_DIR = Path(os.environ.get("MUSIC_DIR", "/music"))
SETTINGS_PATH = CONFIG_DIR / "settings.json"

Provider = Literal["tidal", "qobuz", "amazon", "spoti"]
Quality = Literal["LOSSLESS", "HI_RES", "MAX"]
OnExisting = Literal["skip", "overwrite", "rename"]


class FileManagementSettings(BaseModel):
    track_template: str = "{album_artist}/{album}/{track:02d} - {title}.flac"
    playlist_template: str = "Playlists/{playlist}/{position:02d} - {artist} - {title}.flac"
    on_existing: OnExisting = "skip"


class GeneralSettings(BaseModel):
    providers: list[Provider] = Field(default_factory=lambda: ["tidal", "qobuz", "amazon"])
    quality: Quality = "LOSSLESS"
    accent: str = "yellow"
    font: str = "Google Sans"
    sound_effects: bool = True
    embed_lyrics: bool = True
    embed_max_quality_cover: bool = True
    embed_genre: bool = True
    sp_dc: str = ""
    qobuz_token: str = ""
    concurrency_total: int = Field(default=4, ge=1, le=16)
    concurrency_per_provider: int = Field(default=2, ge=1, le=8)


class Settings(BaseModel):
    general: GeneralSettings = Field(default_factory=GeneralSettings)
    file_management: FileManagementSettings = Field(default_factory=FileManagementSettings)


def _seed_from_env(s: Settings) -> Settings:
    """Optional one-time seed from env at first run."""
    initial = os.environ.get("SPOTIFLAC_INITIAL_PROVIDERS")
    if initial:
        providers = [p.strip() for p in initial.split(",") if p.strip()]
        valid = [p for p in providers if p in ("tidal", "qobuz", "amazon", "spoti")]
        if valid:
            s.general.providers = valid  # type: ignore[assignment]
    return s


def load_settings() -> Settings:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if SETTINGS_PATH.exists():
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            return Settings.model_validate(data)
        except (json.JSONDecodeError, ValueError):
            backup = SETTINGS_PATH.with_suffix(".json.bak")
            SETTINGS_PATH.rename(backup)
    s = _seed_from_env(Settings())
    save_settings(s)
    return s


def save_settings(settings: Settings) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    payload = settings.model_dump_json(indent=2)
    fd, tmp_path = tempfile.mkstemp(
        prefix=".settings-", suffix=".json", dir=str(CONFIG_DIR)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp_path, SETTINGS_PATH)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


_cached: Settings | None = None


def get_settings() -> Settings:
    global _cached
    if _cached is None:
        _cached = load_settings()
    return _cached


def update_settings(new: Settings) -> Settings:
    global _cached
    save_settings(new)
    _cached = new
    return new
