# SpotiFLAC Web

Self-hosted web UI that mirrors the SpotiFLAC desktop app — paste a Spotify URL,
preview the tracks, and download them as FLAC into a volume that Swing Music
(or any other library scanner) indexes.

## Stack

- **Backend**: FastAPI + Uvicorn (Python 3.11), wrapping
  [`SpotiFLAC-Module-Version`](https://github.com/ShuShuzinhuu/SpotiFLAC-Module-Version)
  — fallback chain Tidal → Qobuz → Amazon, no Spotify account required.
- **Frontend**: React + Vite + Tailwind, served as a static SPA from FastAPI.
- **Queue**: in-memory FIFO, one download at a time, run in a subprocess so it
  can be cancelled mid-flight.
- **Persistence**: `/config/settings.json` (atomic) + `/config/history.db` (SQLite).

## Quick start (Docker)

```bash
docker compose up -d --build
```

Then open `http://<host>:8000`.

Behind Nginx Proxy Manager: create a Proxy Host pointing at
`http://<host>:8000`, enable **Websockets Support** (covers SSE for live logs),
add TLS via Let's Encrypt.

## Volumes

| Path inside container | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `/music`              | Output FLAC tree. Mount the same path Swing Music indexes. |
| `/config`             | `settings.json` + `history.db`                       |

## Default file layout

- Tracks/albums: `/music/{album_artist}/{album}/{track:02d} - {title}.flac`
- Playlists:    `/music/Playlists/{playlist}/{position:02d} - {artist} - {title}.flac`

Both templates are configurable in **Settings → File Management**.

## Environment variables

| Variable                       | Default          | Notes                                        |
| ------------------------------ | ---------------- | -------------------------------------------- |
| `CONFIG_DIR`                   | `/config`        |                                              |
| `MUSIC_DIR`                    | `/music`         |                                              |
| `TZ`                           | `Europe/Paris`   |                                              |
| `LOG_LEVEL`                    | `INFO`           |                                              |
| `SPOTIFLAC_INITIAL_PROVIDERS`  | _unset_          | Seeds provider chain on first run only       |

All other knobs live in the Settings page and persist to `/config/settings.json`.

## Development

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
export CONFIG_DIR=./config MUSIC_DIR=./music
uvicorn app.main:app --reload --port 8000
```

Run tests:

```bash
pytest
```

### Frontend

```bash
cd frontend
npm install
npm run dev   # → http://localhost:5173, proxies /api to localhost:8000
```

## API reference

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST   | `/api/preview` | `{url}` → metadata + tracklist |
| POST   | `/api/library/check` | mark which tracks already exist on disk |
| POST   | `/api/download` | `{url, track_ids}` → `{job_ids}` |
| GET    | `/api/jobs` | active + recent queue state |
| POST   | `/api/jobs/{id}/cancel` | cancel queued or kill subprocess |
| POST   | `/api/jobs/{id}/retry` | re-enqueue a failed/cancelled job |
| DELETE | `/api/jobs/{id}` | remove a queued job |
| POST   | `/api/jobs/cancel-all` | cancel everything pending |
| GET    | `/api/history/downloads` | paginated, sortable, searchable |
| GET    | `/api/history/fetches` | recent preview history |
| DELETE | `/api/history/downloads/{id}?delete_file=true` | remove entry, optionally the file |
| GET/PUT | `/api/settings` | settings JSON |
| POST   | `/api/settings/reset` | back to defaults |
| GET    | `/api/settings/export` | download `settings.json` |
| POST   | `/api/library/rescan` | rebuild the library index |
| GET    | `/api/logs/stream` | SSE log stream |
| GET    | `/api/status` | provider availability snapshot |
| GET    | `/api/modules` | runtime dep versions |

## Verification checklist

1. `docker compose up -d`, open the URL behind NPM.
2. Paste a track URL → preview shows cover + metadata → click **Download** → FLAC
   appears in `/music/{artist}/{album}/`.
3. Paste an album → **Download All** → jobs run sequentially in *History → Queue*.
4. Click **Cancel** while a download runs → process killed, partial file cleaned up,
   job marked `cancelled`.
5. Re-paste the same URL → tracks already in the library show greyed out.
6. Paste a playlist → files land under `/music/Playlists/{name}/…`.
7. Change provider order in **Settings**, save, restart container → setting
   persists.
8. Trigger a Swing Music rescan → new files indexed without tag errors.

## Notes

- Spotify rate-limiting (HTTP 429) is handled by the underlying module with
  `Retry-After` honoring.
- The Python module exposes no per-byte progress callback; this UI shows
  `queued / downloading / ok / failed / cancelled` per track and polls every 2 s.
- `multiprocessing` uses `spawn` on Windows and `fork` on Linux; the subprocess
  entrypoint is a clean `python -m app.core.downloader_runner` so both work.
