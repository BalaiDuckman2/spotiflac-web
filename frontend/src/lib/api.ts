async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type TrackDTO = {
  id: string;
  title: string;
  artists: string;
  album: string;
  album_artist: string;
  duration_ms: number;
  isrc: string;
  track_number: number;
  disc_number: number;
  year: string;
  cover_url: string;
  external_url: string;
  position: number;
};

export type PreviewDTO = {
  kind: 'track' | 'album' | 'playlist';
  id: string;
  title: string;
  cover_url: string;
  subtitle: string;
  total_tracks: number;
  tracks: TrackDTO[];
  url: string;
};

export type JobDTO = {
  id: string;
  spotify_track_id: string;
  track: { title: string; artists: string; album: string; cover_url: string; duration_ms: number };
  target_path: string;
  status: 'queued' | 'downloading' | 'ok' | 'failed' | 'cancelled';
  provider_used: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  context: { kind?: string; title?: string; url?: string; cover_url?: string };
  position: number;
};

export type LibraryAlbumDTO = {
  album_artist: string;
  album: string;
  disc_number: number;
  cover_url: string | null;
  tracks_present: number;
  tracks_expected: number | null;
  status: 'complete' | 'incomplete' | 'unknown';
  spotify_album_id: string | null;
  verified: boolean;
  missing_track_numbers: number[];
  paths_count: number;
};

export type LibraryTrackDTO = {
  path: string;
  track_number: number;
  disc_number: number;
  title: string;
  artist: string;
  duration_sec: number;
  size_bytes: number;
  isrc: string;
};

export type LibraryAlbumDetailDTO = {
  album_artist: string;
  album: string;
  disc_number: number;
  cover_url: string | null;
  spotify_album_id: string | null;
  tracks: LibraryTrackDTO[];
};

export type VerifyResponseDTO =
  | {
      verified: true;
      spotify_album_id: string;
      spotify_total: number;
      missing: { number: number; title: string; spotify_track_id: string }[];
    }
  | {
      verified: false;
      candidates: SearchAlbumDTO[];
    };

export type SearchTrackDTO = {
  id: string;
  title: string;
  artists: string;
  album: string;
  cover_url: string;
  duration_ms: number;
  url: string;
};

export type SearchAlbumDTO = {
  id: string;
  title: string;
  artists: string;
  cover_url: string;
  year: string;
  total_tracks: number;
  url: string;
  album_group?: 'album' | 'single';
};

export type SearchPlaylistDTO = {
  id: string;
  name: string;
  owner: string;
  cover_url: string;
  total_tracks: number;
  url: string;
};

export type SearchArtistDTO = {
  id: string;
  name: string;
  cover_url: string;
  url: string;
};

export type SearchResultDTO = {
  tracks: SearchTrackDTO[];
  albums: SearchAlbumDTO[];
  playlists: SearchPlaylistDTO[];
  artists: SearchArtistDTO[];
};

export type ArtistAlbumsDTO = {
  id: string;
  name: string;
  cover_url: string;
  items: SearchAlbumDTO[];
};

export type SettingsDTO = {
  general: {
    providers: string[];
    quality: 'LOSSLESS' | 'HI_RES' | 'MAX';
    accent: string;
    font: string;
    sound_effects: boolean;
    embed_lyrics: boolean;
    embed_max_quality_cover: boolean;
    embed_genre: boolean;
    sp_dc: string;
    qobuz_token: string;
    concurrency_total: number;
    concurrency_per_provider: number;
  };
  file_management: {
    track_template: string;
    playlist_template: string;
    on_existing: 'skip' | 'overwrite' | 'rename';
  };
};

export const api = {
  preview: (url: string) =>
    request<PreviewDTO>('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  libraryCheck: (
    track_ids: string[],
    isrcs: string[],
    fingerprints: { artist: string; title: string; album: string }[],
  ) =>
    request<{ already_present_ids: string[] }>('/api/library/check', {
      method: 'POST',
      body: JSON.stringify({ track_ids, isrcs, fingerprints }),
    }),

  download: (url: string, track_ids: string[]) =>
    request<{
      job_ids: string[];
      skipped_existing: number;
      errored: number;
      unmatched: number;
      preview_tracks: number;
    }>('/api/download', {
      method: 'POST',
      body: JSON.stringify({ url, track_ids }),
    }),

  jobs: () => request<{ jobs: JobDTO[] }>('/api/jobs'),

  cancelJob: (id: string) =>
    request<{ id: string; status: string }>(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  retryJob: (id: string) =>
    request<{ new_id: string }>(`/api/jobs/${id}/retry`, { method: 'POST' }),

  removeJob: (id: string) =>
    request<{ removed: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' }),

  cancelAll: () => request<{ cancelled: number }>('/api/jobs/cancel-all', { method: 'POST' }),

  clearFinished: () =>
    request<{ cleared: number }>('/api/jobs/clear-finished', { method: 'POST' }),

  rescan: () => request<{ indexed_keys: number }>('/api/library/rescan', { method: 'POST' }),

  library: {
    albums: (params: { status?: string; search?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      return request<{ items: LibraryAlbumDTO[]; total: number; limit: number; offset: number }>(
        `/api/library/albums${qs ? `?${qs}` : ''}`,
      );
    },
    verify: (body: {
      album_artist: string;
      album: string;
      disc_number?: number;
      spotify_album_id?: string;
    }) =>
      request<VerifyResponseDTO>('/api/library/albums/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    complete: (body: { album_artist: string; album: string; disc_number?: number }) =>
      request<{ missing_count: number; job_ids: string[]; skipped?: number }>(
        '/api/library/albums/complete',
        { method: 'POST', body: JSON.stringify(body) },
      ),
    coverUrl: (path: string) => `/api/library/cover?path=${encodeURIComponent(path)}`,
    albumDetail: (artist: string, album: string, disc = 1) =>
      request<LibraryAlbumDetailDTO>(
        `/api/library/album?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&disc=${disc}`,
      ),
    artistPaths: (artist: string) =>
      request<{ artist: string; paths: string[]; album_count: number }>(
        `/api/library/artist/paths?artist=${encodeURIComponent(artist)}`,
      ),
    deleteTracks: (paths: string[]) =>
      request<{ deleted: number; freed_bytes: number; errors: number }>(
        '/api/library/tracks/delete',
        { method: 'POST', body: JSON.stringify({ paths }) },
      ),
    redownloadTrack: (path: string) =>
      request<{ queued: boolean; job_ids: string[]; track_id: string }>(
        '/api/library/tracks/redownload',
        { method: 'POST', body: JSON.stringify({ path }) },
      ),
  },

  search: (q: string, types: string[] = ['track', 'album', 'playlist', 'artist'], limit = 20) =>
    request<SearchResultDTO>(
      `/api/search?q=${encodeURIComponent(q)}&types=${types.join(',')}&limit=${limit}`,
    ),

  artistAlbums: (artistId: string, limit = 50) =>
    request<ArtistAlbumsDTO>(`/api/spotify/artist/${artistId}/albums?limit=${limit}`),

  history: {
    downloads: (params: {
      search?: string;
      sort?: string;
      direction?: string;
      limit?: number;
      offset?: number;
    }) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      return request<{ items: any[]; total: number; limit: number; offset: number }>(
        `/api/history/downloads?${qs}`,
      );
    },
    fetches: (params: { limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      return request<{ items: any[]; total: number }>(`/api/history/fetches?${qs}`);
    },
    deleteDownload: (id: number, deleteFile: boolean) =>
      request<{ deleted: boolean; file_deleted: boolean }>(
        `/api/history/downloads/${id}?delete_file=${deleteFile}`,
        { method: 'DELETE' },
      ),
    deleteFetch: (id: number) =>
      request<{ deleted: boolean }>(`/api/history/fetches/${id}`, { method: 'DELETE' }),
    clearDownloads: () =>
      request<{ deleted: number }>('/api/history/downloads', { method: 'DELETE' }),
  },

  settings: {
    get: () => request<SettingsDTO>('/api/settings'),
    set: (s: SettingsDTO) =>
      request<SettingsDTO>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(s),
      }),
    reset: () => request<SettingsDTO>('/api/settings/reset', { method: 'POST' }),
  },

  status: () =>
    request<{ providers: { name: string; ok: boolean; error: string | null; checked_at: string }[] }>(
      '/api/status',
    ),

  refreshStatus: () =>
    request<{ providers: any[] }>('/api/status/refresh', { method: 'POST' }),

  modules: () =>
    request<{ modules: { name: string; version: string | null; ok: boolean }[] }>('/api/modules'),

  watched: {
    list: () => request<{ items: WatchedPlaylistDTO[] }>('/api/watched'),
    add: (url: string) =>
      request<WatchedPlaylistDTO>('/api/watched', {
        method: 'POST',
        body: JSON.stringify({ url }),
      }),
    remove: (id: number) =>
      request<{ removed: boolean }>(`/api/watched/${id}`, { method: 'DELETE' }),
    syncNow: (id: number) =>
      request<{ ok: boolean; new_job_ids?: string[]; total_tracks?: number; error?: string }>(
        `/api/watched/${id}/sync`,
        { method: 'POST' },
      ),
  },
};

export type WatchedPlaylistDTO = {
  id: number;
  spotify_playlist_id: string;
  url: string;
  name: string;
  cover_url: string;
  added_at: string;
  last_synced_at: string | null;
  last_error: string | null;
  is_active: number;
};
