import { X } from 'lucide-react';

import { SearchAlbumDTO } from '@/lib/api';

type Props = {
  candidates: SearchAlbumDTO[];
  onPick: (id: string) => void;
  onClose: () => void;
};

export default function CandidatesPicker({ candidates, onPick, onClose }: Props) {
  return (
    <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-yellow-900">
          Plusieurs correspondances — choisis la bonne
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
              {c.cover_url && (
                <img src={c.cover_url} alt="" className="h-full w-full object-cover" />
              )}
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
