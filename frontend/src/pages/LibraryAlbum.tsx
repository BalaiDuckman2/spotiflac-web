import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, RotateCcw, Trash2, AlertCircle } from 'lucide-react';

import { api, LibraryTrackDTO } from '@/lib/api';
import { cn } from '@/lib/cn';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';

type ConfirmMode =
  | { kind: 'tracks'; paths: string[]; titles: string[] }
  | { kind: 'album' }
  | { kind: 'redownload'; path: string; title: string };

function formatDuration(seconds: number): string {
  if (!seconds) return '–';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(b: number): string {
  if (!b) return '–';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} Go`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} Mo`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} Ko`;
  return `${b} o`;
}

export default function LibraryAlbum() {
  const [params] = useSearchParams();
  const artist = params.get('artist') ?? '';
  const album = params.get('album') ?? '';
  const disc = parseInt(params.get('disc') ?? '1', 10) || 1;
  const qc = useQueryClient();
  const navigate = useNavigate();

  const detailQ = useQuery({
    queryKey: ['library-album', artist, album, disc],
    queryFn: () => api.library.albumDetail(artist, album, disc),
    enabled: Boolean(artist && album),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tracks = detailQ.data?.tracks ?? [];
  const totalSize = useMemo(() => tracks.reduce((s, t) => s + t.size_bytes, 0), [tracks]);

  const allSelected = tracks.length > 0 && selected.size === tracks.length;
  const someSelected = selected.size > 0;

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(tracks.map((t) => t.path)));
  };

  const deleteMut = useMutation({
    mutationFn: (paths: string[]) => api.library.deleteTracks(paths),
    onSuccess: (data) => {
      setError(null);
      setSelected(new Set());
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['library-albums'] });
      qc.invalidateQueries({ queryKey: ['library-album', artist, album, disc] });
      // If everything is gone, go back to the library list.
      if (data.deleted >= tracks.length) {
        navigate('/library');
      }
    },
    onError: (e: Error) => {
      setError(e.message);
      setConfirm(null);
    },
  });

  const redownloadMut = useMutation({
    mutationFn: (path: string) => api.library.redownloadTrack(path),
    onSuccess: () => {
      setError(null);
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['library-album', artist, album, disc] });
    },
    onError: (e: Error) => {
      setError(e.message);
      setConfirm(null);
    },
  });

  const confirmRender = (() => {
    if (!confirm) return null;
    if (confirm.kind === 'redownload') {
      return (
        <ConfirmDeleteModal
          open
          title="Re-télécharger cette piste ?"
          warning={`« ${confirm.title} » sera supprimée et téléchargée à nouveau.`}
          confirmLabel="Re-télécharger"
          loading={redownloadMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => redownloadMut.mutate(confirm.path)}
        />
      );
    }
    if (confirm.kind === 'album') {
      return (
        <ConfirmDeleteModal
          open
          title={`Supprimer l'album « ${album} » ?`}
          warning={`${tracks.length} piste${tracks.length > 1 ? 's' : ''} · ${formatBytes(totalSize)}`}
          items={tracks.map((t) => `${t.track_number.toString().padStart(2, '0')} – ${t.title}`)}
          loading={deleteMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => deleteMut.mutate(tracks.map((t) => t.path))}
        />
      );
    }
    // tracks
    return (
      <ConfirmDeleteModal
        open
        title={`Supprimer ${confirm.paths.length} piste${confirm.paths.length > 1 ? 's' : ''} ?`}
        items={confirm.titles}
        loading={deleteMut.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => deleteMut.mutate(confirm.paths)}
      />
    );
  })();

  if (!artist || !album) {
    return (
      <div className="mx-auto max-w-5xl px-8 pt-8">
        <p className="text-sm text-gray-500">Album non spécifié.</p>
        <Link to="/library" className="text-sm text-blue-600 hover:underline">
          ← Retour à la Library
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-8 pb-16 pt-8">
      <Link
        to="/library"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft size={14} /> Retour à la Library
      </Link>

      {detailQ.isLoading && (
        <div className="mt-6 text-sm text-gray-500">Chargement…</div>
      )}

      {detailQ.isError && (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={14} />
          {(detailQ.error as Error).message}
        </div>
      )}

      {detailQ.data && (
        <>
          <div className="mt-6 flex items-start gap-5">
            <div className="h-32 w-32 flex-shrink-0 overflow-hidden rounded-xl bg-gray-100 shadow">
              {detailQ.data.cover_url && (
                <img
                  src={detailQ.data.cover_url}
                  alt=""
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <div className="flex-1">
              <h1 className="text-2xl font-bold">{detailQ.data.album}</h1>
              <div className="text-sm text-gray-600">{detailQ.data.album_artist}</div>
              {detailQ.data.disc_number > 1 && (
                <div className="mt-1 text-xs text-gray-500">Disc {detailQ.data.disc_number}</div>
              )}
              <div className="mt-2 text-xs text-gray-500">
                {tracks.length} piste{tracks.length > 1 ? 's' : ''} · {formatBytes(totalSize)}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={() => setConfirm({ kind: 'album' })}
                  disabled={tracks.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  <Trash2 size={14} /> Supprimer l'album
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Tout sélectionner"
                    />
                  </th>
                  <th className="w-10 px-3 py-2">#</th>
                  <th className="px-3 py-2">Titre</th>
                  <th className="w-20 px-3 py-2">Durée</th>
                  <th className="w-20 px-3 py-2">Taille</th>
                  <th className="w-24 px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => (
                  <TrackRow
                    key={t.path}
                    t={t}
                    selected={selected.has(t.path)}
                    onToggle={() => toggle(t.path)}
                    onDelete={() =>
                      setConfirm({
                        kind: 'tracks',
                        paths: [t.path],
                        titles: [`${t.track_number.toString().padStart(2, '0')} – ${t.title}`],
                      })
                    }
                    onRedownload={() =>
                      setConfirm({ kind: 'redownload', path: t.path, title: t.title })
                    }
                  />
                ))}
                {tracks.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-400">
                      Aucune piste sur le disque pour cet album.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {someSelected && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">
          <span className="mr-3">
            {selected.size} piste{selected.size > 1 ? 's' : ''} sélectionnée{selected.size > 1 ? 's' : ''}
          </span>
          <button
            onClick={() => setSelected(new Set())}
            className="mr-2 rounded px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            Annuler
          </button>
          <button
            onClick={() => {
              const sel = tracks.filter((t) => selected.has(t.path));
              setConfirm({
                kind: 'tracks',
                paths: sel.map((t) => t.path),
                titles: sel.map(
                  (t) => `${t.track_number.toString().padStart(2, '0')} – ${t.title}`,
                ),
              });
            }}
            className="rounded bg-red-600 px-3 py-1 text-xs font-semibold hover:bg-red-700"
          >
            Supprimer la sélection
          </button>
        </div>
      )}

      {confirmRender}
    </div>
  );
}

function TrackRow({
  t,
  selected,
  onToggle,
  onDelete,
  onRedownload,
}: {
  t: LibraryTrackDTO;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRedownload: () => void;
}) {
  return (
    <tr className={cn('border-b border-gray-100 last:border-b-0', selected && 'bg-yellow-50')}>
      <td className="px-3 py-2">
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label="Sélectionner" />
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-gray-500">
        {t.track_number ? t.track_number.toString().padStart(2, '0') : '–'}
      </td>
      <td className="px-3 py-2">
        <div className="truncate font-medium">{t.title || '(sans titre)'}</div>
        {t.artist && <div className="truncate text-xs text-gray-500">{t.artist}</div>}
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-gray-600">
        {formatDuration(t.duration_sec)}
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-gray-600">
        {formatBytes(t.size_bytes)}
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-1">
          <button
            onClick={onRedownload}
            title="Re-télécharger"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          >
            <RotateCcw size={14} />
          </button>
          <button
            onClick={onDelete}
            title="Supprimer"
            className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}
