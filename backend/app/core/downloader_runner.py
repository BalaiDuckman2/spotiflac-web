"""Subprocess entry point for a single track download.

Reads a JSON payload from stdin, runs SpotiFLAC's `download_one` against
a single Spotify track, and emits NDJSON events on stdout. Designed so
the parent worker can `terminate()` cleanly and parse incremental events.

Stdin payload:
    {
      "track_id":     "<spotify track id>",
      "output_path":  "<absolute path including .flac extension>",
      "services":     ["tidal","qobuz","amazon","spoti"],
      "quality":      "LOSSLESS"|"HI_RES"|"MAX",
      "embed_lyrics": bool,
      "enrich_metadata": bool,
      "sp_dc":        "<spotify cookie>",
      "qobuz_token":  "<token>",
      "position":     int,
      "is_album":     bool,
    }

Stdout events (one JSON per line):
    {"type":"start","file":"<path>"}        # provider has begun writing
    {"type":"provider","name":"tidal"}      # current provider being attempted
    {"type":"done","path":"<path>","provider":"tidal","format":"flac"}
    {"type":"error","msg":"..."}
"""
from __future__ import annotations

import json
import logging
import os
import sys
import traceback


def _emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )


def main() -> int:
    _setup_logging()
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except Exception as e:
        _emit({"type": "error", "msg": f"invalid payload: {e}"})
        return 1

    try:
        from SpotiFLAC.providers.spotify_metadata import SpotifyMetadataClient
        from SpotiFLAC.downloader import DownloadOptions, _build_provider, download_one

        track_id = payload["track_id"]
        output_path = payload["output_path"]
        services = payload.get("services") or ["tidal", "qobuz", "amazon"]
        quality = payload.get("quality", "LOSSLESS")
        position = int(payload.get("position", 1))

        client = SpotifyMetadataClient(timeout_s=15)
        meta = client.get_track(track_id)
        _emit({
            "type": "start",
            "file": output_path,
            "title": meta.title,
            "artist": meta.artists,
        })

        opts = DownloadOptions(
            output_dir=os.path.dirname(output_path) or ".",
            output_path=output_path,
            services=services,
            quality=quality,
            embed_lyrics=bool(payload.get("embed_lyrics", True)),
            enrich_metadata=bool(payload.get("enrich_metadata", True)),
            lyrics_spotify_token=payload.get("sp_dc", "") or "",
            qobuz_token=payload.get("qobuz_token", "") or None,
            is_album=bool(payload.get("is_album", False)),
            allow_fallback=True,
        )

        # Build providers
        providers = []
        for name in opts.services:
            p = _build_provider(name, opts)
            if p:
                providers.append(p)
        if not providers:
            _emit({"type": "error", "msg": f"No valid providers in {opts.services}"})
            return 1

        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # Emit attempted provider names for visibility
        for p in providers:
            _emit({"type": "provider", "name": p.name})

        result = download_one(meta, opts.output_dir, providers, opts, position=position)

        if result.success and result.file_path:
            _emit({
                "type": "done",
                "path": result.file_path,
                "provider": result.provider,
                "format": result.format or "flac",
            })
            return 0

        _emit({"type": "error", "msg": result.error or "all providers failed"})
        return 1

    except KeyboardInterrupt:
        _emit({"type": "error", "msg": "cancelled"})
        return 130
    except Exception as e:
        _emit({"type": "error", "msg": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()})
        return 1


if __name__ == "__main__":
    sys.exit(main())
