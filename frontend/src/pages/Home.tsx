import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/Toaster';

export default function Home() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

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

  const fetchesQ = useQuery({
    queryKey: ['fetches'],
    queryFn: () => api.history.fetches({ limit: 12 }),
  });

  const items = fetchesQ.data?.items ?? [];

  return (
    <div className="mx-auto max-w-5xl px-8 pb-16 pt-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Home</h1>
        <button
          onClick={() => navigate('/search')}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Search size={14} />
          Search Spotify
        </button>
      </div>

      <h2 className="mt-8 text-sm font-semibold text-gray-700">Recent fetches</h2>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((f: any) => (
          <button
            key={f.id}
            onClick={() => {
              if (f.kind === 'album') {
                navigate(`/album?url=${encodeURIComponent(f.url)}`);
              } else {
                previewMut.mutate(f.url);
              }
            }}
            className="group relative overflow-hidden rounded-lg border border-gray-200 bg-white p-2 text-left hover:shadow-md"
          >
            <div className="aspect-square overflow-hidden rounded-md bg-gray-100">
              {f.cover_url && (
                <img src={f.cover_url} alt={f.title} className="h-full w-full object-cover" />
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
      {items.length === 0 && (
        <p className="mt-4 text-sm text-gray-400">
          No fetches yet —{' '}
          <button
            onClick={() => navigate('/search')}
            className="font-medium text-yellow-700 hover:underline"
          >
            search Spotify
          </button>{' '}
          to start.
        </p>
      )}
    </div>
  );
}
