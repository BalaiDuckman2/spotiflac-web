import json
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.settings import GeneralSettings


@pytest.fixture
def tmp_config(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    # Force re-import to pick up new env
    import importlib
    from app.core import settings as settings_mod

    importlib.reload(settings_mod)
    yield settings_mod, tmp_path
    importlib.reload(settings_mod)


def test_load_creates_default(tmp_config):
    settings_mod, cfg = tmp_config
    s = settings_mod.load_settings()
    assert s.general.providers == ["tidal", "qobuz", "amazon"]
    assert (cfg / "settings.json").exists()


def test_save_atomic(tmp_config):
    settings_mod, cfg = tmp_config
    s = settings_mod.load_settings()
    s.general.accent = "blue"
    settings_mod.save_settings(s)
    loaded = settings_mod.load_settings()
    assert loaded.general.accent == "blue"


def test_corrupted_falls_back(tmp_config):
    settings_mod, cfg = tmp_config
    (cfg / "settings.json").write_text("{not json")
    s = settings_mod.load_settings()
    assert s.general.accent == "yellow"
    assert (cfg / "settings.json.bak").exists()


def test_seed_from_env(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("SPOTIFLAC_INITIAL_PROVIDERS", "qobuz,tidal")
    import importlib
    from app.core import settings as settings_mod

    importlib.reload(settings_mod)
    s = settings_mod.load_settings()
    assert s.general.providers == ["qobuz", "tidal"]


def test_concurrency_defaults():
    g = GeneralSettings()
    assert g.concurrency_total == 4
    assert g.concurrency_per_provider == 2


def test_concurrency_bounds():
    with pytest.raises(ValidationError):
        GeneralSettings(concurrency_total=0)
    with pytest.raises(ValidationError):
        GeneralSettings(concurrency_total=17)
    with pytest.raises(ValidationError):
        GeneralSettings(concurrency_per_provider=0)
    with pytest.raises(ValidationError):
        GeneralSettings(concurrency_per_provider=9)
    # Upper bounds should be accepted
    GeneralSettings(concurrency_total=16)
    GeneralSettings(concurrency_per_provider=8)


def test_settings_loads_existing_json_without_concurrency_fields(tmp_path, monkeypatch):
    """Existing settings.json without the new fields should still load (backward compat)."""
    monkeypatch.setattr("app.core.settings.CONFIG_DIR", tmp_path)
    monkeypatch.setattr("app.core.settings.SETTINGS_PATH", tmp_path / "settings.json")
    (tmp_path / "settings.json").write_text(
        '{"general": {"providers": ["tidal"], "quality": "LOSSLESS"}, "file_management": {}}',
        encoding="utf-8",
    )
    from app.core.settings import load_settings
    s = load_settings()
    assert s.general.concurrency_total == 4
    assert s.general.concurrency_per_provider == 2
