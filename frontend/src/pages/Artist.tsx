import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';

import { api, SearchAlbumDTO } from '@/lib/api';

export default function Artist() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['artist', id],
    queryFn: () => api.artistAlbums(id!),
    enabled: !!id,
  });

  if (q.isLoading) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>;
  }
  if (q.isError) {
    return <div className="p-8 text-sm text-red-600">{(q.error as Error).message}</div>;
  }
  if (!q.data) return null;

  const albums = q.data.items.filter((a) => a.album_group !== 'single');
  const singles = q.data.items.filter((a) => a.album_group === 'single');

  return (
    <div className="mx-auto max-w-6xl px-8 pb-16 pt-8">
      <button
        onClick={() => navigate(-1)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft size={14} /> Back
      </button>

      <div className="flex items-end gap-6">
        <div className="h-40 w-40 flex-shrink-0 overflow-hidden rounded-full bg-gray-100">
          {q.data.cover_url && (
            <img src={q.data.cover_url} alt={q.data.name} className="h-full w-full object-cover" />
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500">Artist</div>
          <h1 className="mt-1 text-4xl font-bold">{q.data.name}</h1>
          <div className="mt-2 text-sm text-gray-500">
            {albums.length} albums · {singles.length} singles & EPs
          </div>
        </div>
      </div>

      <Section title={`Albums (${albums.length})`} items={albums} />
      <Section title={`Singles & EPs (${singles.length})`} items={singles} />
    </div>
  );
}

function Section({ title, items }: { title: string; items: SearchAlbumDTO[] }) {
  const navigate = useNavigate();
  if (items.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((a) => (
          <button
            key={a.id}
            onClick={() => navigate(`/fetch?url=${encodeURIComponent(a.url)}`)}
            className="group overflow-hidden rounded-lg border border-gray-200 bg-white p-2 text-left transition hover:shadow-md"
          >
            <div className="aspect-square overflow-hidden rounded-md bg-gray-100">
              {a.cover_url && (
                <img src={a.cover_url} alt={a.title} className="h-full w-full object-cover" />
              )}
            </div>
            <div className="mt-2 truncate text-sm font-medium">{a.title}</div>
            <div className="truncate text-xs text-gray-500">
              {a.year}
              {a.year && a.total_tracks ? ' · ' : ''}
              {a.total_tracks ? `${a.total_tracks} tracks` : ''}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
