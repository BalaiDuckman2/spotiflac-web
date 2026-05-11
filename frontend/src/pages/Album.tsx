import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Check, Disc3, Download, MoreHorizontal, RefreshCw,
  RotateCcw, Trash2,
} from 'lucide-react';

import { api, AlbumTrackDTO, SearchAlbumDTO, VerifyResponseDTO } from '@/lib/api';
import { cn } from '@/lib/cn';
import ConfirmDeleteModal from '@/components/ConfirmDeleteModal';
import CandidatesPicker from '@/components/CandidatesPicker';
import { formatDuration } from '@/lib/format';
import { useToast } from '@/components/Toaster';
import ArtistLink from '@/components/ArtistLink';

const PAGE_SIZE = 50;

function formatBytes(b: number | null): string {
  if (!b) return '–';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} Go`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} Mo`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} Ko`;
  return `${b} o`;
}

function parseSpotifyAlbumId(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/album\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

type ConfirmMode =
  | { kind: 'delete-tracks'; paths: string[]; titles: string[] }
  | { kind: 'delete-album' }
  | { kind: 'refetch-album' }
  | { kind: 'redownload-track'; path: string; title: string };

export default function Album() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const url = params.get('url');
  const spotifyIdParam = params.get('spotify_id');
  const libArtist = params.get('artist');
  const libAlbum = params.get('album');
  const libDisc = parseInt(params.get('disc') ?? '1', 10) || 1;

  const cameFromLibrary = Boolean(libArtist && libAlbum && !url && !spotifyIdParam);
  const urlSpotifyId = useMemo(() => parseSpotifyAlbumId(url), [url]);

  // Step 1: when coming from library, resolve spotify_album_id via the library detail
  const libraryQ = useQuery({
    queryKey: ['library-album-resolve', libArtist, libAlbum, libDisc],
    queryFn: () => api.library.albumDetail(libArtist!, libAlbum!, libDisc),
    enabled: cameFromLibrary,
  });

  const resolvedSpotifyId =
    spotifyIdParam || urlSpotifyId || libraryQ.data?.spotify_album_id || null;

  // Step 2: once we have an id, fetch the unified DTO
  const albumQ = useQuery({
    queryKey: ['album', resolvedSpotifyId],
    queryFn: () => api.album.get({ spotify_id: resolvedSpotifyId! }),
    enabled: Boolean(resolvedSpotifyId),
  });

  const data = albumQ.data;
  const tracks = data?.tracks ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmMode | null>(null);
  const [candidates, setCandidates] = useState<SearchAlbumDTO[] | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
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

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['album', resolvedSpotifyId] });
    qc.invalidateQueries({ queryKey: ['library-albums'] });
    qc.invalidateQueries({ queryKey: ['library-album-resolve'] });
    qc.invalidateQueries({ queryKey: ['jobs'] });
  };

  // Use library names for write operations if we have them; else use the DTO's
  const writeAlbumArtist = libArtist || data?.album_artist || '';
  const writeAlbum = libAlbum || data?.album || '';
  const writeDisc = libArtist ? libDisc : 1;

  const downloadMut = useMutation({
    mutationFn: (ids: string[]) => api.download(data!.spotify_url, ids),
    onSuccess: (res, requestedIds) => {
      setSelected(new Set());
      const queued = res.job_ids.length;
      const skipped = res.skipped_existing;
      const msg =
        queued > 0
          ? `${queued} piste${queued > 1 ? 's' : ''} en file (sur ${requestedIds.length})${skipped > 0 ? ` · ${skipped} déjà sur disque` : ''}.`
          : `Aucune piste en file (${skipped} déjà sur disque).`;
      if (queued > 0) {
        toast.success(msg, { action: { label: 'Voir Downloads', to: '/downloads' } });
      } else {
        toast.info(msg);
      }
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (paths: string[]) => api.library.deleteTracks(paths),
    onSuccess: (res) => {
      setSelected(new Set());
      setConfirm(null);
      toast.success(
        `${res.deleted} fichier${res.deleted > 1 ? 's' : ''} supprimé${res.deleted > 1 ? 's' : ''} · ${formatBytes(res.freed_bytes)} libéré${res.freed_bytes > 1 ? 's' : ''}.`,
      );
      invalidateAll();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setConfirm(null);
    },
  });

  const redownloadTrackMut = useMutation({
    mutationFn: (path: string) => api.library.redownloadTrack(path),
    onSuccess: () => {
      setConfirm(null);
      toast.success('Piste remise en file de téléchargement.', {
        action: { label: 'Voir Downloads', to: '/downloads' },
      });
      invalidateAll();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setConfirm(null);
    },
  });

  const refetchAlbumMut = useMutation({
    mutationFn: () =>
      api.library.redownloadAlbum(writeAlbumArtist, writeAlbum, writeDisc),
    onSuccess: (res) => {
      setConfirm(null);
      toast.success(
        `Album supprimé (${res.deleted_files} fichier${res.deleted_files > 1 ? 's' : ''}) et ${res.job_ids.length} piste${res.job_ids.length > 1 ? 's' : ''} mise${res.job_ids.length > 1 ? 's' : ''} en file.`,
        { action: { label: 'Voir Downloads', to: '/downloads' } },
      );
      invalidateAll();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setConfirm(null);
    },
  });

  const verifyMut = useMutation({
    mutationFn: (spotify_album_id?: string) =>
      api.library.verify({
        album_artist: writeAlbumArtist,
        album: writeAlbum,
        disc_number: writeDisc,
        spotify_album_id,
      }),
    onSuccess: (res: VerifyResponseDTO) => {
      if (res.verified) {
        setCandidates(null);
        toast.success('Album vérifié contre Spotify.');
        invalidateAll();
      } else {
        setCandidates(res.candidates);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ------- Filter / paginate tracks -------
  const filteredTracks = useMemo(() => {
    if (!search.trim()) return tracks;
    const s = search.toLowerCase();
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(s) ||
        t.artists.toLowerCase().includes(s),
    );
  }, [tracks, search]);

  const totalPages = Math.max(1, Math.ceil(filteredTracks.length / PAGE_SIZE));
  const paged = filteredTracks.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // ------- Multi-select math -------
  const selectedTracks = useMemo(
    () => tracks.filter((t) => selected.has(t.spotify_track_id)),
    [tracks, selected],
  );
  const selectedMissing = selectedTracks.filter((t) => !t.on_disk);
  const selectedPresent = selectedTracks.filter((t) => t.on_disk);

  const allFilteredSelected =
    filteredTracks.length > 0 && filteredTracks.every((t) => selected.has(t.spotify_track_id));

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiltered = (checked: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      filteredTracks.forEach((t) => {
        if (checked) next.add(t.spotify_track_id);
        else next.delete(t.spotify_track_id);
      });
      return next;
    });
  };

  // ------- Action handlers -------
  const downloadMissing = () => {
    const missingIds = tracks.filter((t) => !t.on_disk).map((t) => t.spotify_track_id);
    if (missingIds.length === 0) return;
    downloadMut.mutate(missingIds);
  };

  const downloadSelectedMissing = () => {
    const ids = selectedMissing.map((t) => t.spotify_track_id);
    if (ids.length === 0) return;
    downloadMut.mutate(ids);
  };

  const askDeleteSelectedPresent = () => {
    if (selectedPresent.length === 0) return;
    setConfirm({
      kind: 'delete-tracks',
      paths: selectedPresent.map((t) => t.local_path!),
      titles: selectedPresent.map(
        (t) => `${t.track_number.toString().padStart(2, '0')} – ${t.title}`,
      ),
    });
  };

  // ------- Loading & local-only modes -------
  if (!resolvedSpotifyId && !cameFromLibrary) {
    return (
      <div className="mx-auto max-w-5xl px-8 pt-8">
        <p className="text-sm text-gray-500">Album non spécifié.</p>
        <button
          onClick={() => navigate(-1)}
          className="text-sm text-blue-600 hover:underline"
        >
          ← Retour
        </button>
      </div>
    );
  }

  if (cameFromLibrary && libraryQ.isLoading) {
    return <div className="mx-auto max-w-5xl px-8 pt-8 text-sm text-gray-500">Chargement…</div>;
  }

  // Local-only mode: came from library but album has no spotify_album_id
  if (
    cameFromLibrary &&
    libraryQ.data &&
    !libraryQ.data.spotify_album_id &&
    !resolvedSpotifyId
  ) {
    return (
      <div className="mx-auto max-w-5xl px-8 pb-16 pt-8">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
        >
          <ArrowLeft size={14} /> Retour
        </button>
        <div className="mt-6 flex items-end gap-6">
          <div className="h-48 w-48 flex-shrink-0 overflow-hidden rounded-xl bg-gray-100 shadow-lg">
            {libraryQ.data.cover_url ? (
              <img
                src={libraryQ.data.cover_url}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-gray-300">
                <Disc3 size={64} />
              </div>
            )}
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Album
            </div>
            <h1 className="mt-1 text-3xl font-bold leading-tight">{libraryQ.data.album}</h1>
            <div className="mt-1 text-base text-gray-700">{libraryQ.data.album_artist}</div>
          </div>
        </div>
        <div className="mt-6 rounded-xl border border-yellow-200 bg-yellow-50 p-5">
          <h2 className="text-sm font-semibold text-yellow-900">Album non vérifié</h2>
          <p className="mt-1 text-sm text-yellow-800">
            Fais Verify pour récupérer la tracklist Spotify complète et accéder à toutes les
            actions (télécharger les pistes manquantes, re-télécharger l'album, etc.).
          </p>
          <button
            onClick={() => verifyMut.mutate(undefined)}
            disabled={verifyMut.isPending}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-yellow-300 px-3 py-1.5 text-sm font-semibold text-black hover:bg-yellow-400 disabled:opacity-50"
          >
            <RefreshCw size={14} className={cn(verifyMut.isPending && 'animate-spin')} />
            {verifyMut.isPending ? '…' : 'Verify'}
          </button>
        </div>

        {candidates && (
          <div className="mt-4">
            <CandidatesPicker
              candidates={candidates}
              onPick={(id) => {
                setCandidates(null);
                verifyMut.mutate(id);
              }}
              onClose={() => setCandidates(null)}
            />
          </div>
        )}
      </div>
    );
  }

  if (albumQ.isLoading) {
    return <div className="mx-auto max-w-5xl px-8 pt-8 text-sm text-gray-500">Chargement…</div>;
  }
  if (albumQ.isError) {
    return (
      <div className="mx-auto max-w-5xl px-8 pt-8">
        <button
          onClick={() => navigate(-1)}
          className="text-sm text-gray-500 hover:underline"
        >
          ← Retour
        </button>
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(albumQ.error as Error).message}
        </div>
      </div>
    );
  }
  if (!data) return null;

  const missingCount = tracks.length - data.tracks_on_disk;
  const isComplete = data.tracks_on_disk === tracks.length && tracks.length > 0;
  const hasLocal = data.tracks_on_disk > 0;

  const confirmRender = (() => {
    if (!confirm) return null;
    if (confirm.kind === 'redownload-track') {
      return (
        <ConfirmDeleteModal
          open
          title="Re-télécharger cette piste ?"
          warning={`« ${confirm.title} » sera supprimée et téléchargée à nouveau.`}
          confirmLabel="Re-télécharger"
          loading={redownloadTrackMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => redownloadTrackMut.mutate(confirm.path)}
        />
      );
    }
    if (confirm.kind === 'refetch-album') {
      return (
        <ConfirmDeleteModal
          open
          title={`Re-télécharger l'album « ${data.album} » ?`}
          warning={`Tous les fichiers actuels (${data.tracks_on_disk} piste${data.tracks_on_disk > 1 ? 's' : ''}) seront supprimés puis re-téléchargés.`}
          confirmLabel="Re-télécharger"
          loading={refetchAlbumMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => refetchAlbumMut.mutate()}
        />
      );
    }
    if (confirm.kind === 'delete-album') {
      const paths = tracks.filter((t) => t.on_disk).map((t) => t.local_path!);
      return (
        <ConfirmDeleteModal
          open
          title={`Supprimer l'album « ${data.album} » ?`}
          warning={`${paths.length} piste${paths.length > 1 ? 's' : ''} sur disque`}
          items={tracks
            .filter((t) => t.on_disk)
            .map((t) => `${t.track_number.toString().padStart(2, '0')} – ${t.title}`)}
          loading={deleteMut.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => deleteMut.mutate(paths)}
        />
      );
    }
    // delete-tracks
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

  return (
    <div className="mx-auto max-w-5xl px-8 pb-24 pt-8">
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft size={14} /> Retour
      </button>

      <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-end">
        <div className="h-48 w-48 flex-shrink-0 overflow-hidden rounded-xl bg-gray-100 shadow-lg">
          {data.cover_url ? (
            <img src={data.cover_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-gray-300">
              <Disc3 size={64} />
            </div>
          )}
        </div>
        <div className="flex-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Album {data.year && <span className="ml-1">· {data.year}</span>}
          </div>
          <h1 className="mt-1 text-3xl font-bold leading-tight">{data.album}</h1>
          <div className="mt-1 text-base text-gray-700">
            <ArtistLink
              artistId={data.artist_id}
              name={data.album_artist}
              className="font-medium"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <StatusPill
              onDisk={data.tracks_on_disk}
              total={tracks.length}
              complete={isComplete}
            />
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {missingCount > 0 && (
              <button
                onClick={downloadMissing}
                disabled={downloadMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-yellow-400 px-3 py-1.5 text-sm font-semibold text-black hover:bg-yellow-500 disabled:opacity-50"
              >
                <Download size={14} />
                {downloadMut.isPending
                  ? '…'
                  : `Télécharger ${missingCount} piste${missingCount > 1 ? 's' : ''} manquante${missingCount > 1 ? 's' : ''}`}
              </button>
            )}
            {cameFromLibrary && (
              <button
                onClick={() => verifyMut.mutate(undefined)}
                disabled={verifyMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <RefreshCw size={14} className={cn(verifyMut.isPending && 'animate-spin')} />
                {verifyMut.isPending ? '…' : 'Re-vérifier'}
              </button>
            )}
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                title="Plus d'actions"
              >
                <MoreHorizontal size={14} />
              </button>
              {menuOpen && (
                <div className="absolute left-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirm({ kind: 'refetch-album' });
                    }}
                    disabled={!hasLocal}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-orange-700 hover:bg-orange-50 disabled:opacity-40"
                    title={!hasLocal ? 'Aucun fichier sur disque' : ''}
                  >
                    <RotateCcw size={12} /> Re-télécharger l'album
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirm({ kind: 'delete-album' });
                    }}
                    disabled={!hasLocal}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
                    title={!hasLocal ? 'Aucun fichier sur disque' : ''}
                  >
                    <Trash2 size={12} /> Supprimer l'album du disque
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {candidates && (
        <div className="mt-5">
          <CandidatesPicker
            candidates={candidates}
            onPick={(id) => {
              setCandidates(null);
              verifyMut.mutate(id);
            }}
            onClose={() => setCandidates(null)}
          />
        </div>
      )}

      {tracks.length > PAGE_SIZE && (
        <div className="mt-5">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Filtrer les pistes…"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-yellow-300 focus:ring-2 focus:ring-yellow-200"
          />
        </div>
      )}

      <div className="mt-5 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={(e) => toggleAllFiltered(e.target.checked)}
                  aria-label="Tout sélectionner"
                />
              </th>
              <th className="w-10 px-3 py-2">#</th>
              <th className="px-3 py-2">Titre</th>
              <th className="w-20 px-3 py-2">Durée</th>
              <th className="w-28 px-3 py-2">Statut</th>
              <th className="w-24 px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((t) => (
              <TrackRow
                key={t.spotify_track_id}
                t={t}
                selected={selected.has(t.spotify_track_id)}
                onToggle={() => toggle(t.spotify_track_id)}
                onDownload={() => downloadMut.mutate([t.spotify_track_id])}
                onRedownload={() =>
                  setConfirm({
                    kind: 'redownload-track',
                    path: t.local_path!,
                    title: t.title,
                  })
                }
                onDelete={() =>
                  setConfirm({
                    kind: 'delete-tracks',
                    paths: [t.local_path!],
                    titles: [`${t.track_number.toString().padStart(2, '0')} – ${t.title}`],
                  })
                }
                downloadPending={downloadMut.isPending}
              />
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-400">
                  Aucune piste{search ? ' ne correspond' : ''}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-1 text-sm">
          <button
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-30"
          >
            Previous
          </button>
          {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={cn(
                'h-7 w-7 rounded text-xs',
                p === page ? 'bg-yellow-300 font-semibold' : 'hover:bg-gray-100',
              )}
            >
              {p}
            </button>
          ))}
          <button
            disabled={page === totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">
          <span className="mr-3">
            {selected.size} sélectionnée{selected.size > 1 ? 's' : ''}
          </span>
          <button
            onClick={() => setSelected(new Set())}
            className="mr-2 rounded px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            Annuler
          </button>
          <button
            onClick={downloadSelectedMissing}
            disabled={selectedMissing.length === 0 || downloadMut.isPending}
            className="mr-2 inline-flex items-center gap-1 rounded bg-yellow-400 px-3 py-1 text-xs font-semibold text-black hover:bg-yellow-500 disabled:opacity-40"
          >
            <Download size={12} /> Télécharger {selectedMissing.length} manquante{selectedMissing.length > 1 ? 's' : ''}
          </button>
          <button
            onClick={askDeleteSelectedPresent}
            disabled={selectedPresent.length === 0}
            className="inline-flex items-center gap-1 rounded bg-red-600 px-3 py-1 text-xs font-semibold hover:bg-red-700 disabled:opacity-40"
          >
            <Trash2 size={12} /> Supprimer {selectedPresent.length} présente{selectedPresent.length > 1 ? 's' : ''}
          </button>
        </div>
      )}

      {confirmRender}
    </div>
  );
}

function StatusPill({
  onDisk,
  total,
  complete,
}: {
  onDisk: number;
  total: number;
  complete: boolean;
}) {
  if (total === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
        Aucune piste
      </span>
    );
  }
  if (complete) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">
        <Check size={11} /> Complet · {onDisk}/{total}
      </span>
    );
  }
  if (onDisk === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
        Pas sur disque · 0/{total}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-[11px] font-semibold text-yellow-800">
      Incomplet · {onDisk}/{total}
    </span>
  );
}

function TrackRow({
  t,
  selected,
  onToggle,
  onDownload,
  onRedownload,
  onDelete,
  downloadPending,
}: {
  t: AlbumTrackDTO;
  selected: boolean;
  onToggle: () => void;
  onDownload: () => void;
  onRedownload: () => void;
  onDelete: () => void;
  downloadPending: boolean;
}) {
  return (
    <tr
      className={cn(
        'border-b border-gray-100 last:border-b-0',
        selected && 'bg-yellow-50',
      )}
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label="Sélectionner"
        />
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-gray-500">
        {t.track_number || '–'}
      </td>
      <td className="px-3 py-2">
        <div className="truncate font-medium">{t.title || '(sans titre)'}</div>
        {t.artists && (
          <div className="truncate text-xs text-gray-500">
            <ArtistLink artistId={t.artist_id} name={t.artists} />
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-xs tabular-nums text-gray-600">
        {formatDuration(t.duration_ms)}
      </td>
      <td className="px-3 py-2 text-xs">
        {t.on_disk ? (
          <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 font-semibold text-green-700">
            <Check size={10} /> Sur disque
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 font-semibold text-gray-600">
            Manquant
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        {t.on_disk ? (
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
        ) : (
          <button
            onClick={onDownload}
            disabled={downloadPending}
            title="Télécharger"
            className="inline-flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40"
          >
            <Download size={12} />
          </button>
        )}
      </td>
    </tr>
  );
}
