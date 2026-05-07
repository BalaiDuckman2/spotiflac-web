# Spotify Search — Design

**Date:** 2026-05-07
**Status:** Approved, ready for implementation plan
**Scope:** Add a Spotify name-based search (tracks, albums, playlists, artists) accessible from the Home page via a unified URL/search input. Adds an `/artist/:id` page showing the artist's discography. Unblocks the Library page's "verify external imports" use case.

## Goal

Today the Home page only accepts a Spotify URL. To download anything you must already have the URL. The user wants to type "daft punk discovery" and get instant results to fetch from. The same plumbing also lets the upcoming Library page resolve incomplete albums for files imported from outside SpotiFLAC (no need for a manual URL-paste action).

**Success criteria:**
- Typing "discovery daft punk" in the Home input shows the album in <500ms with cover and metadata. One click navigates to the existing fetch page.
- Typing a Spotify URL still works exactly as today (input auto-detects URL vs free text).
- An "Artists" search result navigates to `/artist/<id>` showing every album/single from that artist.

## Non-goals

- Pagination beyond the first 20 results per type (covers 95% of cases).
- Persistent search history.
- Recommendations / "Made for you" features.
- A dedicated `/search` page (the Home input is sufficient for v1).
- Search inside Spotify podcasts/episodes/audiobooks.

## Why this is cheap

The existing `SpotifyMetadataClient` (in the SpotiFLAC package) already authenticates via OAuth client_credentials and holds a Bearer token usable for the entire Spotify Web API. Adding `search()` and `get_artist_albums()` is a few lines that reuse the existing `_get` helper.

## Architecture

```
Home input (text)
   │
   │  if URL → existing /fetch flow
   │  else   → debounced GET /api/search?q=...
   ▼
FastAPI: GET /api/search
   │
   ▼
SpotifyMetadataClient.search()  →  GET /v1/search (Spotify Web API)
                                   uses already-cached Bearer token

Home input (artist click)
   │
   ▼
navigate('/artist/<id>')
   │
   ▼
FastAPI: GET /api/spotify/artist/<id>/albums
   │
   ▼
SpotifyMetadataClient.get_artist_albums()  →  GET /v1/artists/{id}/albums
```

## Backend

### `SpotifyMetadataClient` extensions

In a new helper module (`backend/app/core/spotify_search.py`) — keeping changes out of the third-party package, we wrap the existing client:

```python
from SpotiFLAC.providers.spotify_metadata import SpotifyMetadataClient

class SearchResult(TypedDict):
    tracks: list[dict]
    albums: list[dict]
    playlists: list[dict]
    artists: list[dict]

def search(query: str, types: list[str], limit: int = 20) -> SearchResult:
    client = _get_client()
    type_param = ",".join(t for t in types if t in {"track", "album", "playlist", "artist"})
    raw = client._get(f"/search?q={urlencode({'q': query})}&type={type_param}&limit={limit}&market=FR")
    return {
        "tracks":    [_track_dto(t)    for t in raw.get("tracks",    {}).get("items", []) if t],
        "albums":    [_album_dto(a)    for a in raw.get("albums",    {}).get("items", []) if a],
        "playlists": [_playlist_dto(p) for p in raw.get("playlists", {}).get("items", []) if p],
        "artists":   [_artist_dto(a)   for a in raw.get("artists",   {}).get("items", []) if a],
    }

def get_artist_albums(artist_id: str, limit: int = 50) -> dict:
    client = _get_client()
    artist = client._get(f"/artists/{artist_id}")
    raw    = client._get(f"/artists/{artist_id}/albums?include_groups=album,single&limit={limit}&market=FR")
    return {
        "id":        artist_id,
        "name":      artist.get("name"),
        "cover_url": _best_image(artist.get("images", [])),
        "items":     [_album_dto(a, include_group=True) for a in raw.get("items", [])],
    }
```

Use of `client._get` is intentional: it's the same private helper that all other endpoints use (token + retry + 429 handling). We're effectively a sibling of `get_track` / `get_album_tracks`. **Risk:** calling a private method of a third-party package — if SpotiFLAC renames or refactors `_get`, search breaks. Mitigation: pin the SpotiFLAC version in `requirements.txt` (already the case), and the test suite covers this method's behavior so an upgrade regression is caught immediately.

`market=FR` is hardcoded in v1; if internationalisation becomes relevant, expose it via settings.

### DTOs

Minimal, frontend-friendly shapes. All include `url` so the frontend can pass it straight to `/fetch`.

```python
def _track_dto(t: dict) -> dict:
    return {
        "id":        t["id"],
        "title":     t["name"],
        "artists":   ", ".join(a["name"] for a in t.get("artists", [])),
        "album":     t.get("album", {}).get("name", ""),
        "cover_url": _best_image(t.get("album", {}).get("images", [])),
        "duration_ms": t.get("duration_ms", 0),
        "url":       t.get("external_urls", {}).get("spotify", ""),
    }

def _album_dto(a: dict, include_group: bool = False) -> dict:
    return {
        "id":           a["id"],
        "title":        a["name"],
        "artists":      ", ".join(ar["name"] for ar in a.get("artists", [])),
        "cover_url":    _best_image(a.get("images", [])),
        "year":         (a.get("release_date") or "")[:4],
        "total_tracks": a.get("total_tracks", 0),
        "url":          a.get("external_urls", {}).get("spotify", ""),
        **({"album_group": a.get("album_group", "album")} if include_group else {}),
    }

def _playlist_dto(p: dict) -> dict:
    return {
        "id":           p["id"],
        "name":         p["name"],
        "owner":        p.get("owner", {}).get("display_name", ""),
        "cover_url":    _best_image(p.get("images", [])),
        "total_tracks": p.get("tracks", {}).get("total", 0),
        "url":          p.get("external_urls", {}).get("spotify", ""),
    }

def _artist_dto(a: dict) -> dict:
    return {
        "id":        a["id"],
        "name":      a["name"],
        "cover_url": _best_image(a.get("images", [])),
        "url":       a.get("external_urls", {}).get("spotify", ""),
    }
```

### API endpoints

In a new router `backend/app/api/search.py`:

```
GET /api/search?q=<query>&types=track,album,playlist,artist&limit=20
  → 200: SearchResult
  → 400: empty q or unknown type
  → 502: Spotify upstream error

GET /api/spotify/artist/{artist_id}/albums?limit=50
  → 200: {id, name, cover_url, items: [...album DTOs...]}
  → 502: Spotify upstream error
```

Defaults: `types=track,album,playlist,artist` (all four), `limit=20` (max 50, clamped server-side).

### Caching

Spotify's Bearer token is held in the existing client (1h expiry, auto-refresh). Beyond that, no caching for v1 — search is interactive and results change. If 429s become an issue we can add an LRU on `(query, types)` with 5-minute TTL.

## Frontend

### Home input (modified)

The existing input becomes a unified field. Detection is:

```
isSpotifyUrl = /^(https?:\/\/(open|play)\.spotify\.com\/|spotify:)/.test(input.trim())
```

- `isSpotifyUrl === true`: existing flow. Show "Fetch" button. Submit triggers preview.
- `isSpotifyUrl === false` and length >= 2: debounced search query (300ms). Render results panel below the input.

Results panel layout (under input, hidden when no query):

```
┌─ Albums ────────────────────────────────────┐
│ [cover] Discovery — Daft Punk · 14 · 2001   │
│ [cover] Random Access Memories — Daft Punk  │
│ ...                                          │
│ See more                                     │
├─ Artists ───────────────────────────────────┤
│ [cover] Daft Punk                            │
├─ Tracks ────────────────────────────────────┤
│ [cover] One More Time — Daft Punk · Discovery│
├─ Playlists ─────────────────────────────────┤
│ [cover] Daft Punk Essentials — Spotify       │
└──────────────────────────────────────────────┘
```

Top 5 per section initially. "See more" toggles to top 20.

Click handlers:
- track / album / playlist → `navigate('/fetch?url=' + encodeURIComponent(item.url))`
- artist → `navigate('/artist/' + item.id)`

Empty state: "Type to search, or paste a Spotify URL".
Loading state: spinner inline on the right of the input.
Error state: "Search failed: <message>" toast, panel hidden.

### New page `/artist/:id`

```
┌────────────────────────────────────────────────┐
│  [large cover]                                  │
│  Daft Punk                                      │
│                                                 │
│  Albums (24)                                    │
│  ┌─────┬─────┬─────┬─────┐                     │
│  │ ... │ ... │ ... │ ... │   (grid)            │
│  └─────┴─────┴─────┴─────┘                     │
│                                                 │
│  Singles & EPs (37)                             │
│  ┌─────┬─────┬─────┬─────┐                     │
│  │ ... │ ... │ ... │ ... │                     │
│  └─────┴─────┴─────┴─────┘                     │
└────────────────────────────────────────────────┘
```

Items grouped by `album_group` (`album` / `single`). Click on an album → `/fetch?url=...`.

## Edge cases

- **Spotify token expired between calls**: `_ensure_token` already handles refresh transparently.
- **Empty query**: 400 from API, frontend hides the panel.
- **Spotify 429**: `_get` already sleeps `Retry-After` and retries; surfaces 502 only after exhaustion.
- **Spotify returns null in `items`**: filtered out (`if t` / `if a` guards in DTO mapping).
- **Artist with no albums**: page shows "No albums found".
- **User pastes URL into input that just contained search query**: detection re-runs on every keystroke; UI flips between modes seamlessly.
- **Search returns same album multiple times** (deluxe edition, regional variants): user disambiguation. v1 shows them all.

## Testing strategy

`backend/tests/test_spotify_search.py` (new):
- `search()` with mocked `_get` returns expected DTO shapes for each type.
- `search()` filters out null items in `items` lists.
- `get_artist_albums()` groups by `album_group` (smoke).
- API endpoints return 400 on empty `q`, 200 with body on valid input.
- Type-filter param parsing (`types=album,track`) works.

Frontend: manual smoke (no e2e harness in this project for search interactions).

## Migration

- No DB changes.
- No breaking API changes; `/api/preview` still consumed by Home for the URL path. The new `/api/search` is additive.

## Files touched

| File | Change |
|------|--------|
| `backend/app/core/spotify_search.py` | New module wrapping `SpotifyMetadataClient` for search |
| `backend/app/api/search.py` | New router: `GET /search`, `GET /spotify/artist/{id}/albums` |
| `backend/app/main.py` | Register the new router |
| `backend/tests/test_spotify_search.py` | New |
| `frontend/src/lib/api.ts` | Add `api.search(...)` and `api.artistAlbums(...)` |
| `frontend/src/pages/Home.tsx` | Replace URL-only input with unified input + results panel |
| `frontend/src/pages/Artist.tsx` | New page |
| `frontend/src/main.tsx` | Add `/artist/:id` route |
| `frontend/src/components/SearchResults.tsx` | New component (extracted from Home for clarity) |
| `README.md` | Document the search feature |

## Implementation order (suggestion for the plan)

1. Backend: `spotify_search.py` module with `search()` + `get_artist_albums()`, unit tests.
2. Backend: API router + register in main.py.
3. Frontend: API client additions.
4. Frontend: `SearchResults` component (pure, given a SearchResult, render panel).
5. Frontend: integrate into Home input with URL-vs-text detection + debounce.
6. Frontend: `Artist` page + route.
7. Manual smoke against real Spotify API.

## Follow-up: Library spec revision

After this lands, revise `2026-05-07-library-page-design.md`:
- Drop the `POST /albums/link` endpoint.
- In `POST /albums/verify`: when `spotify_album_id` is unknown, call `search(artist + album, types=["album"], limit=5)`. If top match similarity > 0.8 → use it silently. If 0.5–0.8 → return `verified: false` + `candidates` for user choice. If < 0.5 → return 404 `not_found`.
- Frontend Library row gets a "Verify" button that handles all three cases (silent, choice modal, error).
