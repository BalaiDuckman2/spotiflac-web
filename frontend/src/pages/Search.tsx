import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search as SearchIcon, Download } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import SearchResults from '@/components/SearchResults';
import { useToast } from '@/components/Toaster';

const SPOTIFY_URL_RE = /^(https?:\/\/(open|play)\.spotify\.com\/|spotify:)/i;

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? '';
  const [input, setInput] = useState(initial);
  const [debouncedQuery, setDebouncedQuery] = useState(initial);
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const trimmed = input.trim();
  const isUrl = useMemo(() => SPOTIFY_URL_RE.test(trimmed), [trimmed]);

  useEffect(() => {
    if (isUrl || trimmed.length < 2) {
      setDebouncedQuery('');
      setExpanded(false);
      return;
    }
    const t = setTimeout(() => {
      setDebouncedQuery(trimmed);
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set('q', trimmed);
        return next;
      });
    }, 300);
    return () => clearTimeout(t);
  }, [trimmed, isUrl, setParams]);

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
    onError: (e: Error) => toast.error(e.message),
  });

  const searchQ = useQuery({
    queryKey: ['search', debouncedQuery],
    queryFn: () => api.search(debouncedQuery),
    enabled: !!debouncedQuery,
    staleTime: 30_000,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!isUrl || !trimmed) return;
    previewMut.mutate(trimmed);
  };

  return (
    <div className="mx-auto max-w-5xl px-8 pb-16 pt-8">
      <h1 className="text-2xl font-bold">Search</h1>
      <p className="mt-1 text-sm text-gray-500">
        Search Spotify by name, or paste a track / album / playlist URL to fetch it.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search Spotify or paste a URL…"
            className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-yellow-300 focus:ring-2 focus:ring-yellow-200"
          />
          {searchQ.isFetching && !isUrl && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">…</div>
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

      {!isUrl && (
        <SearchResults
          data={searchQ.data}
          loading={searchQ.isFetching}
          query={debouncedQuery}
          expanded={expanded}
          onToggleExpanded={() => setExpanded((v) => !v)}
        />
      )}
    </div>
  );
}
