import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, Check, Disc3, MoreHorizontal, RefreshCw, Search, Trash2,
} from 'lucide-react';

import { api, LibraryAlbumDTO } from '@/lib/api';
import { cn } from '@/lib/cn';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';

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

      {albumsQ.isLoading && (
        <div className="mt-8 text-sm text-gray-400">Chargement…</div>
      )}

      {albumsQ.data && albumsQ.data.items.length === 0 && (
        <div className="mt-8 text-center text-sm text-gray-400">
          {status === 'incomplete'
            ? 'Aucun album incomplet. Belle librairie !'
            : 'Aucun résultat.'}
        </div>
      )}

      {albumsQ.data && albumsQ.data.items.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {albumsQ.data.items.map((a) => (
            <AlbumCard key={`${a.album_artist}|${a.album}|${a.disc_number}`} album={a} />
          ))}
        </div>
      )}

      {albumsQ.data && albumsQ.data.total > limit && (
        <div className="mt-6 flex items-center justify-center gap-2 text-sm">
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

function AlbumCard({ album }: { album: LibraryAlbumDTO }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'album'; paths: string[] }
    | { kind: 'artist'; paths: string[]; albumCount: number }
    | null
  >(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const goToDetail = () => {
    const qs = new URLSearchParams({
      artist: album.album_artist,
      album: album.album,
      disc: String(album.disc_number),
    }).toString();
    navigate(`/album?${qs}`);
  };

  const openDeleteAlbum = useMutation({
    mutationFn: () =>
      api.library.albumDetail(album.album_artist, album.album, album.disc_number),
    onSuccess: (data) => {
      setMenuOpen(false);
      setConfirm({ kind: 'album', paths: data.tracks.map((t) => t.path) });
    },
    onError: (e: Error) => setError(e.message),
  });

  const openDeleteArtist = useMutation({
    mutationFn: () => api.library.artistPaths(album.album_artist),
    onSuccess: (data) => {
      setMenuOpen(false);
      setConfirm({ kind: 'artist', paths: data.paths, albumCount: data.album_count });
    },
    onError: (e: Error) => setError(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (paths: string[]) => api.library.deleteTracks(paths),
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ['library-albums'] });
    },
    onError: (e: Error) => {
      setError(e.message);
      setConfirm(null);
    },
  });

  const present = album.tracks_present;
  const expected = album.tracks_expected;
  const pct = expected ? Math.min(100, Math.round((present / expected) * 100)) : 0;

  return (
    <div className="group relative overflow-hidden rounded-lg border border-gray-200 bg-white p-2 transition hover:shadow-md">
      <button onClick={goToDetail} className="block w-full text-left">
        <div className="aspect-square overflow-hidden rounded-md bg-gray-100">
          {album.cover_url ? (
            <img
              src={album.cover_url}
              alt={album.album}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-300">
              <Disc3 size={40} />
            </div>
          )}
        </div>
        <div className="mt-2 truncate text-sm font-medium" title={album.album}>
          {album.album}
          {album.disc_number > 1 && (
            <span className="ml-1 text-xs text-gray-400">(Disc {album.disc_number})</span>
          )}
        </div>
        <div className="truncate text-xs text-gray-500" title={album.album_artist}>
          {album.album_artist}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          {expected ? (
            <>
              {album.status === 'complete' ? (
                <span className="flex items-center gap-1 text-[11px] font-semibold text-green-700">
                  <Check size={11} /> {present}/{expected}
                </span>
              ) : (
                <>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full bg-yellow-400" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[11px] tabular-nums text-gray-500">
                    {present}/{expected}
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="text-[11px] text-gray-400">{present} pistes · non vérifié</span>
          )}
        </div>
      </button>

      <div className="absolute right-2 top-2" ref={menuRef}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className={cn(
            'rounded-full bg-white/90 p-1 shadow transition',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          title="Plus d'actions"
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
            <button
              onClick={() => openDeleteAlbum.mutate()}
              disabled={openDeleteAlbum.isPending}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 size={12} /> Supprimer l'album
            </button>
            <button
              onClick={() => openDeleteArtist.mutate()}
              disabled={openDeleteArtist.isPending}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 size={12} /> Supprimer l'artiste
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-red-600">
          <AlertCircle size={10} /> {error}
        </div>
      )}

      {confirm && confirm.kind === 'album' && (
        <ConfirmDeleteModal
          open
          title={`Supprimer l'album « ${album.album} » ?`}
          warning={`${confirm.paths.length} piste${confirm.paths.length > 1 ? 's' : ''} de ${album.album_artist}`}
          loading={deleteMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => deleteMut.mutate(confirm.paths)}
        />
      )}
      {confirm && confirm.kind === 'artist' && (
        <ConfirmDeleteModal
          open
          title={`Supprimer tous les albums de « ${album.album_artist} » ?`}
          warning={`${confirm.albumCount} album${confirm.albumCount > 1 ? 's' : ''} · ${confirm.paths.length} piste${confirm.paths.length > 1 ? 's' : ''}`}
          loading={deleteMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => deleteMut.mutate(confirm.paths)}
        />
      )}
    </div>
  );
}
