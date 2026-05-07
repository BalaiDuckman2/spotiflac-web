import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw, Search, Sparkles, X, AlertCircle } from 'lucide-react';

import { api, LibraryAlbumDTO, SearchAlbumDTO, VerifyResponseDTO } from '@/lib/api';
import { cn } from '@/lib/cn';

type StatusFilter = 'incomplete' | 'all' | 'complete' | 'unknown';

export default function Library() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>('incomplete');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const limit = 50;

  const albumsQ = useQuery({
    queryKey: ['library-albums', status, search, page],
    queryFn: () => api.library.albums({ status, search, limit, offset: page * limit }),
  });

  const rescan = useMutation({
    mutationFn: () => api.rescan(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library-albums'] }),
  });

  return (
    <div className="mx-auto max-w-6xl px-8 pb-16 pt-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Library</h1>
        <button
          onClick={() => rescan.mutate()}
          disabled={rescan.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(rescan.isPending && 'animate-spin')} />
          Rescan
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search artist or album…"
            className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm"
          />
        </div>
        <div className="flex gap-1 rounded-lg border border-gray-200 p-1">
          {(['incomplete', 'complete', 'unknown', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => {
                setStatus(s);
                setPage(0);
              }}
              className={cn(
                'rounded px-3 py-1 text-xs font-semibold capitalize',
                status === s ? 'bg-yellow-300 text-black' : 'text-gray-500 hover:bg-gray-100',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="w-10 px-3 py-2"></th>
              <th className="px-3 py-2">Album</th>
              <th className="w-44 px-3 py-2">Tracks</th>
              <th className="w-28 px-3 py-2">Status</th>
              <th className="w-44 px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {albumsQ.data?.items.map((a) => (
              <AlbumRow key={`${a.album_artist}|${a.album}|${a.disc_number}`} album={a} />
            ))}
            {albumsQ.data && albumsQ.data.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-gray-400">
                  {status === 'incomplete'
                    ? 'No incomplete albums. Nice library!'
                    : 'Nothing matches.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {albumsQ.data && albumsQ.data.total > limit && (
        <div className="mt-3 flex items-center justify-center gap-2 text-sm">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="rounded px-3 py-1 hover:bg-gray-100 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-gray-500">
            {page * limit + 1}–{Math.min((page + 1) * limit, albumsQ.data.total)} /{' '}
            {albumsQ.data.total}
          </span>
          <button
            disabled={(page + 1) * limit >= albumsQ.data.total}
            onClick={() => setPage((p) => p + 1)}
            className="rounded px-3 py-1 hover:bg-gray-100 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function AlbumRow({ album }: { album: LibraryAlbumDTO }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [candidates, setCandidates] = useState<SearchAlbumDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completeMsg, setCompleteMsg] = useState<string | null>(null);

  const verify = useMutation({
    mutationFn: (spotify_album_id?: string) =>
      api.library.verify({
        album_artist: album.album_artist,
        album: album.album,
        disc_number: album.disc_number,
        spotify_album_id,
      }),
    onSuccess: (data: VerifyResponseDTO) => {
      setError(null);
      if (data.verified) {
        setCandidates(null);
        qc.invalidateQueries({ queryKey: ['library-albums'] });
      } else {
        setCandidates(data.candidates);
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  const complete = useMutation({
    mutationFn: () =>
      api.library.complete({
        album_artist: album.album_artist,
        album: album.album,
        disc_number: album.disc_number,
      }),
    onSuccess: (data) => {
      setError(null);
      setCompleteMsg(`Enqueued ${data.job_ids.length} of ${data.missing_count} missing track(s).`);
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const ratio = album.tracks_expected
    ? `${album.tracks_present} / ${album.tracks_expected}`
    : `${album.tracks_present} / ?`;
  const pct = album.tracks_expected
    ? Math.min(100, Math.round((album.tracks_present / album.tracks_expected) * 100))
    : 0;

  const cover = album.cover_url ?? '';

  return (
    <>
      <tr className="border-b border-gray-100 last:border-b-0">
        <td className="px-3 py-2">
          <button onClick={() => setExpanded((v) => !v)} className="text-gray-400 hover:text-gray-700">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-gray-100">
              {cover && <img src={cover} alt="" className="h-full w-full object-cover" />}
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium">
                {album.album}
                {album.disc_number > 1 && (
                  <span className="ml-2 text-xs text-gray-400">(Disc {album.disc_number})</span>
                )}
              </div>
              <div className="truncate text-xs text-gray-500">{album.album_artist}</div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="text-xs text-gray-600">{ratio}</div>
          {album.tracks_expected && (
            <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-gray-100">
              <div
                className={cn(
                  'h-full',
                  album.status === 'complete' ? 'bg-green-500' : 'bg-yellow-400',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </td>
        <td className="px-3 py-2">
          <StatusBadge status={album.status} verified={album.verified} />
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-1">
            <div className="flex gap-1">
              <button
                onClick={() => verify.mutate(undefined)}
                disabled={verify.isPending}
                className="rounded px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                {verify.isPending ? '…' : 'Verify'}
              </button>
              {album.status === 'incomplete' && (
                <button
                  onClick={() => complete.mutate()}
                  disabled={complete.isPending}
                  className="flex items-center gap-1 rounded bg-yellow-300 px-2 py-0.5 text-xs font-semibold text-black hover:bg-yellow-400 disabled:opacity-50"
                >
                  <Sparkles size={12} /> {complete.isPending ? '…' : 'Complete'}
                </button>
              )}
            </div>
            {completeMsg && <div className="text-[11px] text-green-700">{completeMsg}</div>}
            {error && (
              <div className="flex items-center gap-1 text-[11px] text-red-600">
                <AlertCircle size={11} /> {error}
              </div>
            )}
          </div>
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-gray-100 bg-gray-50">
          <td colSpan={5} className="px-3 py-3">
            <div className="text-xs text-gray-600">
              {album.tracks_expected ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 md:grid-cols-4">
                  {Array.from({ length: album.tracks_expected }, (_, i) => i + 1).map((n) => {
                    const present = !album.missing_track_numbers.includes(n);
                    return (
                      <div key={n} className={cn('flex items-center gap-2', !present && 'text-red-600')}>
                        <span className={cn('w-5 text-right tabular-nums', present ? 'text-gray-400' : 'text-red-500')}>
                          {n}
                        </span>
                        <span>{present ? '✓' : '✗ missing'}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-gray-500">
                  No track-total information. Click <b>Verify</b> to query Spotify.
                </div>
              )}
              <div className="mt-2 text-[11px] text-gray-400">
                {album.paths_count} file{album.paths_count > 1 ? 's' : ''} on disk
                {album.spotify_album_id && (
                  <span className="ml-2">
                    · spotify:album:<code>{album.spotify_album_id}</code>
                  </span>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}

      {candidates && (
        <tr>
          <td colSpan={5}>
            <CandidatesPicker
              candidates={candidates}
              onPick={(id) => {
                setCandidates(null);
                verify.mutate(id);
              }}
              onClose={() => setCandidates(null)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function StatusBadge({ status, verified }: { status: string; verified: boolean }) {
  const styles: Record<string, string> = {
    complete: 'bg-green-100 text-green-700',
    incomplete: 'bg-yellow-100 text-yellow-800',
    unknown: 'bg-gray-100 text-gray-600',
  };
  return (
    <div className="flex items-center gap-1">
      <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase', styles[status])}>
        {status}
      </span>
      {verified && (
        <span className="text-[10px] text-gray-400" title="Verified against Spotify">✓</span>
      )}
    </div>
  );
}

function CandidatesPicker({
  candidates,
  onPick,
  onClose,
}: {
  candidates: SearchAlbumDTO[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="m-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-yellow-900">
          Multiple matches — pick the right one
        </div>
        <button onClick={onClose} className="rounded p-0.5 text-gray-500 hover:bg-yellow-100">
          <X size={12} />
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
        {candidates.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            className="flex items-center gap-2 rounded border border-yellow-200 bg-white p-2 text-left text-sm hover:bg-yellow-100"
          >
            <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-gray-100">
              {c.cover_url && <img src={c.cover_url} alt="" className="h-full w-full object-cover" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{c.title}</div>
              <div className="truncate text-xs text-gray-500">
                {c.artists}
                {c.year && ` · ${c.year}`}
                {c.total_tracks ? ` · ${c.total_tracks} tracks` : ''}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
