# Library Page — Design

**Date:** 2026-05-07
**Status:** Approved, ready for implementation plan
**Scope:** A new `/library` page that lists albums on disk grouped by `(ALBUMARTIST, ALBUM, DISCNUMBER)`, flags incomplete albums, and offers a one-click "Complete" action that resolves the missing tracks via Spotify and enqueues them through the existing download pipeline.

## Goal

The user wants to see, at a glance, which albums in their `/music` library are missing tracks, and to fill in the holes without reconstructing the original Spotify URL by hand. Today, the closest thing in the UI is the in-memory dedup index (`library.py`) — used only to mark "already present" during preview — and the `Downloads → Library` tab, which is per-track download history with no album grouping.

**Success criteria:** for an album of 12 tracks where the user has 10 FLACs on disk, the Library page shows that album as `10/12 incomplete`, and clicking "Complete" enqueues 2 download jobs without further interaction.

## Non-goals

- Visual cover grid (list view first, grid is a v2 polish).
- Auto-verifying every album against Spotify at boot (would hammer Spotify).
- Bulk "Complete all incomplete" action.
- Tracking incomplete playlists (playlists mutate on Spotify; semantics are different).
- (delivered separately by the Spotify Search feature, used by `/verify`)
- Cross-album duplicate detection (separate feature on the original idea list).

## Architecture

The existing in-memory `_Index` in `backend/app/core/library.py` is extended with a third dictionary, `by_album`, populated during the same FLAC scan that already builds `by_isrc` and `by_fp`. No new persistence layer; the index rebuilds at startup (a few seconds for ~10k FLACs) and stays in sync via the existing `add_to_index` / `remove_from_index` hooks.

```
Disk: /music/**/*.flac
   │
   │  startup: _Index.build()
   ▼
_Index
   ├─ by_isrc       (existing)
   ├─ by_fp         (existing)
   └─ by_album      (NEW)  → AlbumInfo per (album_artist, album, disc)
   ▲
   │  cross-ref at build time
history_db.downloads (collection_url → spotify_album_id)
   ▲
   │  on user action
SpotifyMetadataClient (existing, used by downloader_runner)
   │  verify: fetch canonical tracklist
   │  complete: enqueue missing tracks via existing JobQueue
```

## Data model

```python
@dataclass
class AlbumInfo:
    album_artist: str               # original casing for display
    album: str                      # original casing for display
    disc_number: int                # 1 by default
    cover_path: str | None          # path to one FLAC for cover extraction
    paths: list[str]                # all FLAC files in this album/disc
    track_numbers: set[int]         # tracks present (TRACKNUMBER tag)
    track_total: int | None         # TRACKTOTAL/TOTALTRACKS tag (None if absent)
    spotify_album_id: str | None    # known via history or after verify
    spotify_total: int | None       # source of truth once verified
    last_verified_at: datetime | None
```

Index key is `(_norm(album_artist), _norm(album), disc_number)` so that case/punct variations collapse to one entry. Display fields keep original casing from the first FLAC seen.

## Status logic

For each album:

```
expected = spotify_total or track_total or (max(track_numbers) if track_numbers else None)
present  = len(track_numbers)
status   = "complete"   if expected and present >= expected and no gaps in 1..expected
           "incomplete" if expected and (present < expected or gaps exist)
           "unknown"    otherwise
```

`unknown` albums are hidden by default (filter chip toggles).

## Cross-reference with history_db

At index build time, after the FLAC scan, query history_db once:

```sql
SELECT album, artists, collection_url
  FROM downloads
 WHERE collection_url LIKE '%open.spotify.com/album/%';
```

For each row, extract `spotify_album_id` from the URL and apply it to the matching `AlbumInfo` (lookup by normalized album_artist + album). This costs one query per startup, runs in milliseconds.

## API

### `GET /api/library/albums`

Query params: `status` (one of `all`, `complete`, `incomplete`, `unknown`; default `incomplete`), `search` (substring on artist or album, case-insensitive), `limit` (default 50, max 200), `offset`.

Response:
```json
{
  "items": [
    {
      "album_artist": "Daft Punk",
      "album": "Random Access Memories",
      "disc_number": 1,
      "cover_url": "/api/library/cover?path=...",   // proxy endpoint serving embedded art
      "tracks_present": 10,
      "tracks_expected": 13,
      "status": "incomplete",
      "spotify_album_id": "4m2880jivSbbyEGAKfITCa",
      "verified": true,
      "missing_track_numbers": [4, 7, 11]
    }
  ],
  "total": 27,
  "limit": 50,
  "offset": 0
}
```

### `POST /api/library/albums/verify`

Body: `{album_artist, album, disc_number?}`.

Logic:
- If `spotify_album_id` known (from history cross-ref or a previous verify): `SpotifyMetadataClient.get_album_tracks(id)` → updates `spotify_total`, `last_verified_at`, builds the missing list by diffing track numbers.
- Else: call `spotify_search.search(f"{album_artist} {album}", types=["album"], limit=5)`.
  - If top result has similarity > 0.8 (Jaro-Winkler on normalized "artist album" vs result's "artist title"): silently use it. Save `spotify_album_id` on the AlbumInfo. Continue with the get_album_tracks path.
  - If 0.5–0.8: respond 200 with `{verified: false, candidates: [...top 5 album DTOs...]}`. Frontend opens a picker modal; user choice triggers a follow-up call with `spotify_album_id` in the body to lock the choice.
  - If < 0.5 or empty results: respond 404 `{error: "not_found"}`.

Response (success):
```json
{
  "verified": true,
  "spotify_album_id": "4m2880jivSbbyEGAKfITCa",
  "spotify_total": 13,
  "missing": [
    {"number": 4, "title": "Within", "spotify_track_id": "..."},
    {"number": 7, "title": "Touch", "spotify_track_id": "..."}
  ]
}
```

Response (ambiguous):
```json
{
  "verified": false,
  "candidates": [
    {"id": "abc", "title": "Discovery", "artists": "Daft Punk", "year": "2001", "total_tracks": 14, "cover_url": "...", "url": "..."},
    ...
  ]
}
```

Optional body field `spotify_album_id`: when present, skip the search and use this ID directly (called by the frontend after the user picks from the candidates).

### `POST /api/library/albums/complete`

Body: `{album_artist, album, disc_number?}`.

Logic:
1. If not verified within last 24h → run verify first.
2. Resolve missing tracks (those whose `track_number` ∉ `track_numbers`).
3. Enqueue each via the existing download path (single-track URL `https://open.spotify.com/track/<id>` per missing track).

Response:
```json
{
  "verified": true,
  "missing_count": 3,
  "job_ids": ["a1b2c3", "d4e5f6", "g7h8i9"]
}
```

### `GET /api/library/cover?path=<absolute path>`

Streams the first embedded picture from the FLAC at `path`, or 404 if none. Path validation: must resolve under `MUSIC_DIR` (no path traversal). Cached `Cache-Control: max-age=3600`.

## Frontend

**Route:** `/library`. Sidebar item between `Downloads` and `Watched`, icon `Disc3` from lucide-react.

**Layout (list view):**

- Top bar: search input (debounced 300ms), filter chips `All | Incomplete | Unknown`, `Rescan` button (calls existing `POST /api/library/rescan`).
- Table:

| Cover (40px) | Artist · Album | Tracks | Status | Actions |
|---|---|---|---|---|
| (img) | Daft Punk · Random Access Memories | 10/13 ▓▓▓▓▓░░ | incomplete | Verify · Complete |

- Click on a row → expand to show track-by-track list with ✓ (present) / ✗ (missing).
- After Verify or Complete: optimistic UI update + invalidate the `albums` query.

No polling. Manual refresh on action.

## Edge cases

- **Multi-disc albums**: indexed per disc. Display title appends "(Disc N)" if `disc_number > 1`.
- **Various Artists compilations**: grouped by `ALBUMARTIST`, so a single compilation collapses to one album even though `ARTIST` differs per track.
- **Albums with no tracks numbered**: `track_numbers` is empty set. Status defaults to `unknown`, hidden by default. Verify still possible (will populate via Spotify).
- **TRACKTOTAL absent and not verified**: `unknown` status. Hidden until user toggles filter.
- **External imports without history match**: no `spotify_album_id` known. Verify runs a Spotify name-search; if the top match has similarity > 0.8, it's used silently (covers most cases). Ambiguous results surface a candidates picker; truly unknown albums return 404 and stay `unknown`.
- **Stale cache**: `last_verified_at` older than 24h → re-verify on next Complete call.
- **Cold start**: index lost; rebuilt during `init_library()`. History cross-ref re-runs.
- **External imports without Spotify trace**: handled by `verify` (fuzzy search). May fail for obscure releases; status remains `unknown` and Complete returns an error.

## Testing strategy

`backend/tests/test_library.py` (extend):
- Album aggregation: 5 FLACs in `/music/Daft Punk/RAM/` → one AlbumInfo with `paths` of length 5, correct `track_numbers`.
- Multi-disc: `/music/Pink Floyd/The Wall/Disc 1/` and `/Disc 2/` → two AlbumInfo entries.
- Case insensitivity: "Daft Punk" and "daft punk" collapse to one entry.
- Status: complete / incomplete / unknown match expected.
- Cross-ref with history_db populates `spotify_album_id`.

`backend/tests/test_library_api.py` (new):
- `GET /albums?status=incomplete` filters correctly.
- `POST /verify` with mocked `SpotifyMetadataClient` updates `last_verified_at` and `spotify_total`.
- `POST /complete` enqueues N jobs where N == missing count; mocked metadata client.
- Cover endpoint: rejects paths outside `MUSIC_DIR` with 403.

## Migration

- No DB migration. The history_db already has `collection_url` populated; we just query it differently at startup.
- `library.py` `_Index` gains a new field; existing callers (dedup checks) untouched.
- Existing `/api/library/rescan` keeps the same contract (returns indexed key count); the album index is rebuilt as part of the same scan.

## Files touched

| File | Change |
|------|--------|
| `backend/app/core/library.py` | Extend `_Index` with `by_album`, add `AlbumInfo` dataclass, helpers for status |
| `backend/app/api/library.py` | New endpoints: GET albums, POST verify, POST complete, GET cover |
| `backend/app/core/history_db.py` | New helper `albums_with_spotify_id() -> dict[(artist, album), str]` |
| `backend/tests/test_library.py` | Extend with album aggregation tests |
| `backend/tests/test_library_api.py` | New |
| `frontend/src/lib/api.ts` | New `library` namespace: `albums`, `verify`, `complete` |
| `frontend/src/pages/Library.tsx` | New page component (list view + expand) |
| `frontend/src/components/Sidebar.tsx` | Add `/library` nav item |
| `frontend/src/main.tsx` | Add route |
| `README.md` | Document the page |

## Implementation order (suggestion for the plan)

1. Backend: extend `_Index` with `by_album` (no API yet, just internal), unit tests.
2. Backend: history_db cross-ref helper, hook into `_Index.build`.
3. Backend: `GET /api/library/albums` endpoint + DTO + filter/pagination.
4. Backend: cover proxy endpoint with path validation.
5. Backend: `POST /verify` (uses spotify_search + Jaro-Winkler) with mocked Spotify in tests.
6. Backend: `POST /complete` reusing the `/api/download` enqueue path.
7. Frontend: API client additions.
8. Frontend: Library page (top bar, table, expand row, actions).
9. Frontend: sidebar + route wiring.
10. Manual e2e on a real `/music` directory with at least one incomplete album.
