import json
import os
from pathlib import Path

import pytest


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
