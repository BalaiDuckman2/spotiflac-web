import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2, Eye } from 'lucide-react';

import { api, WatchedPlaylistDTO } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

export default function Watched() {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');

  const listQ = useQuery({
    queryKey: ['watched'],
    queryFn: () => api.watched.list(),
    refetchInterval: 30_000,
  });

  const addMut = useMutation({
    mutationFn: (u: string) => api.watched.add(u),
    onSuccess: () => {
      setUrl('');
      qc.invalidateQueries({ queryKey: ['watched'] });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    addMut.mutate(trimmed);
  };

  const items = listQ.data?.items ?? [];

  return (
    <div className="mx-auto max-w-5xl px-8 pb-16 pt-8">
      <div className="flex items-center gap-3">
        <Eye size={22} className="text-yellow-600" />
        <h1 className="text-2xl font-bold">Watched playlists</h1>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Auto-download new tracks as they're added to a Spotify playlist. Checked every 15 minutes.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex items-center gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://open.spotify.com/playlist/…"
          className="flex-1 rounded-lg border border-gray-200 bg-white py-2.5 px-3 text-sm outline-none focus:border-yellow-300 focus:ring-2 focus:ring-yellow-200"
        />
        <button
          type="submit"
          disabled={addMut.isPending || !url.trim()}
          className={cn(
            'flex items-center gap-2 rounded-lg bg-yellow-400 px-4 py-2.5 text-sm font-semibold text-black transition',
            'hover:bg-yellow-500 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <Plus size={16} />
          {addMut.isPending ? 'Adding…' : 'Add'}
        </button>
      </form>

      {addMut.isError && (
        <p className="mt-3 text-sm text-red-600">{(addMut.error as Error).message}</p>
      )}

      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((pl) => (
          <WatchedCard key={pl.id} playlist={pl} />
        ))}
      </div>

      {!listQ.isLoading && items.length === 0 && (
        <p className="mt-8 text-center text-sm text-gray-400">
          No watched playlists yet — paste a public Spotify playlist URL above.
        </p>
      )}
    </div>
  );
}

function WatchedCard({ playlist }: { playlist: WatchedPlaylistDTO }) {
  const qc = useQueryClient();

  const syncMut = useMutation({
    mutationFn: () => api.watched.syncNow(playlist.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watched'] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });

  const removeMut = useMutation({
    mutationFn: () => api.watched.remove(playlist.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watched'] }),
  });

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex gap-3 p-3">
        <div className="h-16 w-16 flex-none overflow-hidden rounded-md bg-gray-100">
          {playlist.cover_url && (
            <img
              src={playlist.cover_url}
              alt={playlist.name}
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <a
            href={playlist.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-medium hover:underline"
          >
            {playlist.name || 'Unknown playlist'}
          </a>
          <div className="mt-1 text-xs text-gray-500">
            {playlist.last_synced_at ? (
              <>Synced {formatDate(playlist.last_synced_at)}</>
            ) : (
              <>Never synced yet</>
            )}
          </div>
          {syncMut.data?.ok && (
            <div className="mt-1 text-xs text-green-700">
              {(syncMut.data.new_job_ids?.length ?? 0) > 0
                ? `Enqueued ${syncMut.data.new_job_ids?.length} new track(s)`
                : 'Up to date'}
            </div>
          )}
        </div>
      </div>

      {playlist.last_error && (
        <div className="border-t border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
          {playlist.last_error}
        </div>
      )}

      <div className="mt-auto flex items-center justify-end gap-1 border-t border-gray-100 bg-gray-50 px-2 py-1.5">
        <button
          onClick={() => syncMut.mutate()}
          disabled={syncMut.isPending}
          title="Sync now"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-700 hover:bg-white disabled:opacity-50"
        >
          <RefreshCw size={13} className={syncMut.isPending ? 'animate-spin' : ''} />
          Sync now
        </button>
        <button
          onClick={() => {
            if (confirm(`Stop watching "${playlist.name}"?`)) removeMut.mutate();
          }}
          title="Remove"
          className="rounded p-1 text-red-500 hover:bg-red-50"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
