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
    request<{ job_ids: string[]; skipped: number }>('/api/download', {
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

  rescan: () => request<{ indexed_keys: number }>('/api/library/rescan', { method: 'POST' }),

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
