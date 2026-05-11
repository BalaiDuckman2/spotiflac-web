import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Download, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import SearchResults from '@/components/SearchResults';

const SPOTIFY_URL_RE = /^(https?:\/\/(open|play)\.spotify\.com\/|spotify:)/i;

export default function Home() {
  const [input, setInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const trimmed = input.trim();
  const isUrl = useMemo(() => SPOTIFY_URL_RE.test(trimmed), [trimmed]);

  // Debounce free-text input for search
  useEffect(() => {
    if (isUrl || trimmed.length < 2) {
      setDebouncedQuery('');
      setExpanded(false);
      return;
    }
    const t = setTimeout(() => setDebouncedQuery(trimmed), 300);
    return () => clearTimeout(t);
  }, [trimmed, isUrl]);

  const previewMut = useMutation({
    mutationFn: (u: string) => api.preview(u),
    onSuccess: (data) => {
      qc.setQueryData(['preview', data.url], data);
      if (data.kind === 'album') {
        navigate(`/album?url=${encodeURIComponent(data.url)}`);
      } else {
        navigate(`/fetch?url=${encodeURIComponent(data.url)}`);
      }
    },
  });

  const searchQ = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: () => api.search(debouncedQuery),
    enabled: !!debouncedQuery,
    staleTime: 30_000,
  });

  const fetchesQ = useQuery({
    queryKey: ['fetches'],
    queryFn: () => api.history.fetches({ limit: 12 }),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!isUrl || !trimmed) return;
    previewMut.mutate(trimmed);
  };

  return (
    <div className="mx-auto max-w-5xl px-8 pb-16 pt-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500 text-white">
            <span className="text-xl">♪</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">SpotiFLAC</h1>
          <span className="rounded-md bg-yellow-300 px-2 py-0.5 text-xs font-semibold">
            v0.1
          </span>
        </div>
        <p className="text-sm text-gray-500">
          Get Spotify tracks in true FLAC from Tidal, Qobuz &amp; Amazon Music — no account
          required.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mt-8 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search Spotify or paste a URL…"
            className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-yellow-300 focus:ring-2 focus:ring-yellow-200"
          />
          {searchQ.isFetching && !isUrl && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              …
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={!isUrl || previewMut.isPending}
          title={isUrl ? 'Fetch this URL' : 'Paste a Spotify URL or pick a search result'}
          className={cn(
            'flex items-center gap-2 rounded-lg bg-yellow-400 px-4 py-2.5 text-sm font-semibold text-black transition',
            'hover:bg-yellow-500 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <Download size={16} />
          {previewMut.isPending ? 'Fetching…' : 'Fetch'}
        </button>
      </form>

      {previewMut.isError && (
        <p className="mt-3 text-sm text-red-600">{(previewMut.error as Error).message}</p>
      )}

      {!isUrl && (
        <SearchResults
          data={searchQ.data}
          loading={searchQ.isFetching}
          query={debouncedQuery}
          expanded={expanded}
          onToggleExpanded={() => setExpanded((v) => !v)}
        />
      )}

      <h2 className="mt-12 text-sm font-semibold text-gray-700">Recent Fetch</h2>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {fetchesQ.data?.items.map((f) => (
          <button
            key={f.id}
            onClick={() => {
              if (f.kind === 'album') {
                navigate(`/album?url=${encodeURIComponent(f.url)}`);
              } else {
                setInput(f.url);
                previewMut.mutate(f.url);
              }
            }}
            className="group relative overflow-hidden rounded-lg border border-gray-200 bg-white p-2 text-left hover:shadow-md"
          >
            <div className="aspect-square overflow-hidden rounded-md bg-gray-100">
              {f.cover_url && (
                <img
                  src={f.cover_url}
                  alt={f.title}
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <div className="mt-2 truncate text-sm font-medium">{f.title}</div>
            <div className="text-xs text-gray-500">{f.total_tracks} tracks</div>
            <span
              className={cn(
                'mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold',
                f.kind === 'playlist' && 'bg-purple-100 text-purple-700',
                f.kind === 'album' && 'bg-blue-100 text-blue-700',
                f.kind === 'track' && 'bg-gray-100 text-gray-700',
              )}
            >
              {f.kind}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                api.history.deleteFetch(f.id).then(() => fetchesQ.refetch());
              }}
              className="absolute right-1 top-1 rounded bg-white/80 p-1 opacity-0 group-hover:opacity-100"
              title="Remove"
            >
              <Trash2 size={12} />
            </button>
          </button>
        ))}
      </div>
      {fetchesQ.data?.items.length === 0 && (
        <p className="mt-4 text-sm text-gray-400">No fetches yet — paste a Spotify URL or search above.</p>
      )}
    </div>
  );
}
