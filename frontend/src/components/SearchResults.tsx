import { useNavigate } from 'react-router-dom';
import { Disc3, ListMusic, Music2, User } from 'lucide-react';

import {
  SearchResultDTO,
  SearchAlbumDTO,
  SearchArtistDTO,
  SearchPlaylistDTO,
  SearchTrackDTO,
} from '@/lib/api';
import { formatDuration } from '@/lib/format';

type Props = {
  data: SearchResultDTO | undefined;
  loading: boolean;
  query: string;
  expanded: boolean;
  onToggleExpanded: () => void;
};

export default function SearchResults({ data, loading, query, expanded, onToggleExpanded }: Props) {
  if (!query) return null;
  if (loading && !data) {
    return (
      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
        Searching…
      </div>
    );
  }
  if (!data) return null;

  const totalShown = data.tracks.length + data.albums.length + data.playlists.length + data.artists.length;
  if (totalShown === 0) {
    return (
      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
        No results for "{query}".
      </div>
    );
  }

  const cap = expanded ? 20 : 5;

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
      {data.albums.length > 0 && (
        <Section icon={<Disc3 size={14} />} title="Albums" count={data.albums.length}>
          {data.albums.slice(0, cap).map((a) => (
            <AlbumRow key={a.id} item={a} />
          ))}
        </Section>
      )}
      {data.artists.length > 0 && (
        <Section icon={<User size={14} />} title="Artists" count={data.artists.length}>
          {data.artists.slice(0, cap).map((a) => (
            <ArtistRow key={a.id} item={a} />
          ))}
        </Section>
      )}
      {data.tracks.length > 0 && (
        <Section icon={<Music2 size={14} />} title="Tracks" count={data.tracks.length}>
          {data.tracks.slice(0, cap).map((t) => (
            <TrackRow key={t.id} item={t} />
          ))}
        </Section>
      )}
      {data.playlists.length > 0 && (
        <Section icon={<ListMusic size={14} />} title="Playlists" count={data.playlists.length}>
          {data.playlists.slice(0, cap).map((p) => (
            <PlaylistRow key={p.id} item={p} />
          ))}
        </Section>
      )}
      {!expanded && totalShown > 5 && (
        <button
          onClick={onToggleExpanded}
          className="block w-full border-t border-gray-100 py-2 text-center text-xs font-semibold text-yellow-700 hover:bg-yellow-50"
        >
          Show more
        </button>
      )}
      {expanded && (
        <button
          onClick={onToggleExpanded}
          className="block w-full border-t border-gray-100 py-2 text-center text-xs font-semibold text-gray-500 hover:bg-gray-50"
        >
          Show less
        </button>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <div className="flex items-center gap-2 bg-gray-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
        {icon}
        {title}
        <span className="text-gray-400">· {count}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function Row({
  cover,
  primary,
  secondary,
  tertiary,
  onClick,
}: {
  cover: string | undefined;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  tertiary?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-yellow-50"
    >
      <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-gray-100">
        {cover && <img src={cover} alt="" className="h-full w-full object-cover" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{primary}</div>
        {secondary && <div className="truncate text-xs text-gray-500">{secondary}</div>}
      </div>
      {tertiary && <div className="text-xs text-gray-400">{tertiary}</div>}
    </button>
  );
}

function AlbumRow({ item }: { item: SearchAlbumDTO }) {
  const navigate = useNavigate();
  return (
    <Row
      cover={item.cover_url}
      primary={item.title}
      secondary={`${item.artists}${item.year ? ` · ${item.year}` : ''}`}
      tertiary={`${item.total_tracks} tracks`}
      onClick={() => navigate(`/album?url=${encodeURIComponent(item.url)}`)}
    />
  );
}

function ArtistRow({ item }: { item: SearchArtistDTO }) {
  const navigate = useNavigate();
  return (
    <Row
      cover={item.cover_url}
      primary={item.name}
      secondary="Open discography"
      onClick={() => navigate(`/artist/${item.id}`)}
    />
  );
}

function TrackRow({ item }: { item: SearchTrackDTO }) {
  const navigate = useNavigate();
  return (
    <Row
      cover={item.cover_url}
      primary={item.title}
      secondary={`${item.artists} · ${item.album}`}
      tertiary={formatDuration(item.duration_ms)}
      onClick={() => navigate(`/fetch?url=${encodeURIComponent(item.url)}`)}
    />
  );
}

function PlaylistRow({ item }: { item: SearchPlaylistDTO }) {
  const navigate = useNavigate();
  return (
    <Row
      cover={item.cover_url}
      primary={item.name}
      secondary={`by ${item.owner || 'Unknown'}`}
      tertiary={`${item.total_tracks} tracks`}
      onClick={() => navigate(`/fetch?url=${encodeURIComponent(item.url)}`)}
    />
  );
}

