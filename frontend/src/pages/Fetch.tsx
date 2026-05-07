import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ArrowUp, X } from 'lucide-react';

import { api, JobDTO, PreviewDTO, TrackDTO } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';

const PAGE_SIZE = 50;

export default function FetchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const url = params.get('url') ?? '';
  const qc = useQueryClient();

  const previewQ = useQuery({
    queryKey: ['preview', url],
    queryFn: () => api.preview(url),
    enabled: !!url,
  });

  const preview = previewQ.data;

  const isrcs = useMemo(
    () => (preview?.tracks ?? []).map((t) => t.isrc || ''),
    [preview],
  );
  const fingerprints = useMemo(
    () =>
      (preview?.tracks ?? []).map((t) => ({
        artist: t.artists,
        title: t.title,
        album: t.album,
      })),
    [preview],
  );

  const checkQ = useQuery({
    queryKey: ['check', preview?.id],
    queryFn: () =>
      api.libraryCheck(
        preview!.tracks.map((t) => t.id),
        isrcs,
        fingerprints,
      ),
    enabled: !!preview && preview.tracks.length > 0,
  });

  const alreadyPresent = useMemo(
    () => new Set(checkQ.data?.already_present_ids ?? []),
    [checkQ.data],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'default' | 'title' | 'duration'>('default');
  const [page, setPage] = useState(1);

  // Initialize selection: all except already present
  useEffect(() => {
    if (!preview) return;
    setSelected(
      new Set(preview.tracks.filter((t) => !alreadyPresent.has(t.id)).map((t) => t.id)),
    );
  }, [preview, alreadyPresent]);

  const downloadMut = useMutation({
    mutationFn: (ids: string[]) => api.download(url, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      navigate('/history');
    },
  });

  const filteredTracks = useMemo(() => {
    if (!preview) return [];
    let list = [...preview.tracks];
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(s) ||
          t.artists.toLowerCase().includes(s) ||
          t.album.toLowerCase().includes(s),
      );
    }
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'duration') list.sort((a, b) => a.duration_ms - b.duration_ms);
    return list;
  }, [preview, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filteredTracks.length / PAGE_SIZE));
  const paged = filteredTracks.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const allFilteredSelected =
    filteredTracks.length > 0 && filteredTracks.every((t) => selected.has(t.id));

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const downloadAll = () => {
    if (!preview) return;
    const ids = preview.tracks.filter((t) => !alreadyPresent.has(t.id)).map((t) => t.id);
    downloadMut.mutate(ids);
  };

  const downloadSelected = () => {
    downloadMut.mutate(Array.from(selected));
  };

  const downloadOne = (id: string) => {
    downloadMut.mutate([id]);
  };

  if (previewQ.isLoading) {
    return <div className="p-8 text-sm text-gray-500">Loading preview…</div>;
  }
  if (previewQ.isError) {
    return <div className="p-8 text-sm text-red-600">{(previewQ.error as Error).message}</div>;
  }
  if (!preview) return null;

  return (
    <div className="mx-auto max-w-6xl px-8 pb-24 pt-8">
      <header className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex gap-5">
          <div className="h-32 w-32 flex-shrink-0 overflow-hidden rounded-lg bg-gray-100">
            {preview.cover_url && (
              <img src={preview.cover_url} alt="" className="h-full w-full object-cover" />
            )}
          </div>
          <div className="flex flex-1 flex-col">
            <div className="text-xs uppercase text-gray-500">{preview.kind}</div>
            <h1 className="text-2xl font-bold">{preview.title}</h1>
            <div className="mt-1 text-sm text-gray-600">{preview.subtitle}</div>
            <div className="mt-auto flex items-center gap-2 pt-3">
              <button
                onClick={downloadAll}
                disabled={downloadMut.isPending}
                className="flex items-center gap-2 rounded-lg bg-yellow-400 px-4 py-2 text-sm font-semibold text-black hover:bg-yellow-500 disabled:opacity-50"
              >
                <Download size={16} />
                Download All
              </button>
              <button
                onClick={downloadSelected}
                disabled={downloadMut.isPending || selected.size === 0}
                className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                Download Selected ({selected.size})
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="mt-5 flex items-center gap-3">
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search tracks…"
          className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-yellow-300 focus:ring-2 focus:ring-yellow-200"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as any)}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
        >
          <option value="default">Default</option>
          <option value="title">Title</option>
          <option value="duration">Duration</option>
        </select>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={(e) => {
                    setSelected((s) => {
                      const next = new Set(s);
                      filteredTracks.forEach((t) => {
                        if (e.target.checked) next.add(t.id);
                        else next.delete(t.id);
                      });
                      return next;
                    });
                  }}
                />
              </th>
              <th className="w-10 px-3 py-2">#</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Album</th>
              <th className="w-20 px-3 py-2">Duration</th>
              <th className="w-24 px-3 py-2">Status</th>
              <th className="w-20 px-3 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((t) => {
              const present = alreadyPresent.has(t.id);
              return (
                <tr
                  key={t.id}
                  className={cn(
                    'border-b border-gray-100 last:border-b-0',
                    present && 'bg-gray-50 text-gray-400',
                  )}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggle(t.id)}
                    />
                  </td>
                  <td className="px-3 py-2 text-gray-500">{t.position}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.title}</div>
                    <div className="text-xs text-gray-500">{t.artists}</div>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{t.album}</td>
                  <td className="px-3 py-2 text-gray-600">{formatDuration(t.duration_ms)}</td>
                  <td className="px-3 py-2 text-xs">
                    {present && (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 text-gray-700">
                        in library
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => downloadOne(t.id)}
                      disabled={downloadMut.isPending || present}
                      title={present ? 'Already in library' : 'Download'}
                      className="flex items-center gap-1 rounded border border-gray-200 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40"
                    >
                      <Download size={12} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {paged.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-400">
                  No tracks
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
          {totalPages > 10 && <span className="px-1 text-gray-400">…</span>}
          <button
            disabled={page === totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded px-2 py-1 hover:bg-gray-100 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}

      <button
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className="fixed bottom-6 right-6 flex h-10 w-10 items-center justify-center rounded-full bg-yellow-400 text-black shadow-lg hover:bg-yellow-500"
        title="Scroll to top"
      >
        <ArrowUp size={18} />
      </button>
    </div>
  );
}
