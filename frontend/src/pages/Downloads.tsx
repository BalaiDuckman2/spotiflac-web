import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, X, RotateCcw, Search } from 'lucide-react';

import { api, JobDTO } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatDuration } from '@/lib/format';

type Tab = 'queue' | 'recent' | 'library' | 'fetches';

export default function Downloads() {
  const [tab, setTab] = useState<Tab>('queue');

  const jobsQ = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs(),
    refetchInterval: 2000,
  });

  const jobs = jobsQ.data?.jobs ?? [];
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'downloading');
  const recent = jobs.filter((j) => j.status === 'ok' || j.status === 'failed' || j.status === 'cancelled');

  return (
    <div className="mx-auto max-w-6xl px-8 pb-16 pt-8">
      <h1 className="text-2xl font-bold">Downloads</h1>

      <div className="mt-4 flex gap-1 border-b border-gray-200">
        <TabButton active={tab === 'queue'} onClick={() => setTab('queue')}>
          Queue
          {active.length > 0 && <Pill>{active.length}</Pill>}
        </TabButton>
        <TabButton active={tab === 'recent'} onClick={() => setTab('recent')}>
          Recent
          {recent.length > 0 && <Pill muted>{recent.length}</Pill>}
        </TabButton>
        <TabButton active={tab === 'library'} onClick={() => setTab('library')}>
          Library
        </TabButton>
        <TabButton active={tab === 'fetches'} onClick={() => setTab('fetches')}>
          Fetches
        </TabButton>
      </div>

      <div className="mt-6">
        {tab === 'queue' && <QueuePanel active={active} />}
        {tab === 'recent' && <RecentPanel recent={recent} />}
        {tab === 'library' && <LibraryPanel />}
        {tab === 'fetches' && <FetchesPanel />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium',
        active
          ? 'border-yellow-400 text-yellow-700'
          : 'border-transparent text-gray-500 hover:text-gray-800',
      )}
    >
      {children}
    </button>
  );
}

function Pill({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 text-[11px] font-semibold',
        muted ? 'bg-gray-100 text-gray-600' : 'bg-yellow-200 text-yellow-800',
      )}
    >
      {children}
    </span>
  );
}

function QueuePanel({ active }: { active: JobDTO[] }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const cancelAll = useMutation({
    mutationFn: () => api.cancelAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const downloading = active.filter((j) => j.status === 'downloading').length;
  const queued = active.filter((j) => j.status === 'queued').length;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-gray-600">
          {downloading > 0 && (
            <span>
              <span className="font-semibold text-yellow-700">{downloading}</span> downloading
            </span>
          )}
          {downloading > 0 && queued > 0 && <span className="mx-2 text-gray-300">·</span>}
          {queued > 0 && (
            <span>
              <span className="font-semibold">{queued}</span> queued
            </span>
          )}
          {active.length === 0 && <span className="text-gray-400">Idle</span>}
        </div>
        {active.length > 0 && (
          <button
            onClick={() => {
              if (confirm(`Cancel ${active.length} job(s)?`)) cancelAll.mutate();
            }}
            className="text-sm text-red-600 hover:underline"
          >
            Cancel all
          </button>
        )}
      </div>

      <JobsTable
        jobs={active}
        emptyText="Nothing in queue. Paste a Spotify URL on Home to start a download."
        onCancel={(id) => cancel.mutate(id)}
        onRemove={(id) => remove.mutate(id)}
      />
    </div>
  );
}

function RecentPanel({ recent }: { recent: JobDTO[] }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: (id: string) => api.retryJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const clear = useMutation({
    mutationFn: () => api.clearFinished(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const ok = recent.filter((j) => j.status === 'ok').length;
  const failed = recent.filter((j) => j.status === 'failed').length;
  const cancelled = recent.filter((j) => j.status === 'cancelled').length;

  // Most recent first
  const sorted = [...recent].sort((a, b) => {
    const ta = a.finished_at ? Date.parse(a.finished_at) : 0;
    const tb = b.finished_at ? Date.parse(b.finished_at) : 0;
    return tb - ta;
  });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-gray-600">
          {ok > 0 && (
            <span>
              <span className="font-semibold text-green-700">{ok}</span> done
            </span>
          )}
          {ok > 0 && (failed > 0 || cancelled > 0) && <span className="mx-2 text-gray-300">·</span>}
          {failed > 0 && (
            <span>
              <span className="font-semibold text-red-700">{failed}</span> failed
            </span>
          )}
          {failed > 0 && cancelled > 0 && <span className="mx-2 text-gray-300">·</span>}
          {cancelled > 0 && (
            <span>
              <span className="font-semibold text-gray-600">{cancelled}</span> cancelled
            </span>
          )}
          {recent.length === 0 && <span className="text-gray-400">No recent activity</span>}
        </div>
        {recent.length > 0 && (
          <button
            onClick={() => clear.mutate()}
            className="text-sm text-red-600 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      <JobsTable
        jobs={sorted}
        emptyText="Nothing here. Completed and failed downloads appear in this tab."
        onRetry={(id) => retry.mutate(id)}
      />
    </div>
  );
}

function JobsTable({
  jobs,
  emptyText,
  onCancel,
  onRemove,
  onRetry,
}: {
  jobs: JobDTO[];
  emptyText: string;
  onCancel?: (id: string) => void;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="px-3 py-2">Track</th>
            <th className="px-3 py-2">Album</th>
            <th className="px-3 py-2">Duration</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Provider</th>
            <th className="w-32 px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              onCancel={onCancel ? () => onCancel(j.id) : undefined}
              onRemove={onRemove ? () => onRemove(j.id) : undefined}
              onRetry={onRetry ? () => onRetry(j.id) : undefined}
            />
          ))}
          {jobs.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-400">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function JobRow({
  job,
  onCancel,
  onRemove,
  onRetry,
}: {
  job: JobDTO;
  onCancel?: () => void;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  return (
    <tr className="border-b border-gray-100 last:border-b-0">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          {job.context.cover_url && (
            <img src={job.context.cover_url} className="h-8 w-8 rounded object-cover" alt="" />
          )}
          <div>
            <div className="font-medium">{job.track.title}</div>
            <div className="text-xs text-gray-500">{job.track.artists}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-gray-600">{job.track.album}</td>
      <td className="px-3 py-2 text-gray-600">{formatDuration(job.track.duration_ms)}</td>
      <td className="px-3 py-2">
        <StatusBadge status={job.status} />
        {job.error && <div className="mt-1 text-xs text-red-500">{job.error}</div>}
      </td>
      <td className="px-3 py-2 text-xs text-gray-600">{job.provider_used ?? '—'}</td>
      <td className="px-3 py-2">
        <div className="flex gap-1">
          {job.status === 'queued' && onRemove && (
            <button onClick={onRemove} className="rounded p-1 hover:bg-gray-100" title="Remove">
              <X size={14} />
            </button>
          )}
          {job.status === 'downloading' && onCancel && (
            <button onClick={onCancel} className="rounded p-1 hover:bg-gray-100" title="Cancel">
              <X size={14} />
            </button>
          )}
          {(job.status === 'failed' || job.status === 'cancelled') && onRetry && (
            <button onClick={onRetry} className="rounded p-1 hover:bg-gray-100" title="Retry">
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: JobDTO['status'] }) {
  const map: Record<JobDTO['status'], string> = {
    queued: 'bg-gray-100 text-gray-700',
    downloading: 'bg-yellow-100 text-yellow-800',
    ok: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-gray-200 text-gray-600',
  };
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase', map[status])}>
      {status}
    </span>
  );
}

function LibraryPanel() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const limit = 50;

  const q = useQuery({
    queryKey: ['downloads', search, page],
    queryFn: () => api.history.downloads({ search, limit, offset: page * limit }),
  });

  const del = useMutation({
    mutationFn: ({ id, file }: { id: number; file: boolean }) =>
      api.history.deleteDownload(id, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });

  const clear = useMutation({
    mutationFn: () => api.history.clearDownloads(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search library…"
            className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm"
          />
        </div>
        <button
          onClick={() => {
            if (confirm('Clear all download history? Files on disk are kept.')) clear.mutate();
          }}
          className="text-sm text-red-600 hover:underline"
        >
          Clear All
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Album</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Downloaded</th>
              <th className="w-24 px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((d) => (
              <tr key={d.id} className="border-b border-gray-100 last:border-b-0">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {d.cover_url && (
                      <img src={d.cover_url} className="h-8 w-8 rounded object-cover" alt="" />
                    )}
                    <div>
                      <div className="font-medium">{d.title}</div>
                      <div className="text-xs text-gray-500">{d.artists}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 text-gray-600">{d.album}</td>
                <td className="px-3 py-2 text-gray-600">{formatDuration(d.duration_ms)}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{d.provider}</td>
                <td className="px-3 py-2 text-xs text-gray-600">{formatDate(d.downloaded_at)}</td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => del.mutate({ id: d.id, file: false })}
                    title="Remove from history"
                    className="rounded p-1 hover:bg-gray-100"
                  >
                    <X size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Delete file from disk too?'))
                        del.mutate({ id: d.id, file: true });
                    }}
                    title="Delete entry + file"
                    className="rounded p-1 text-red-500 hover:bg-red-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {(q.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-400">
                  No downloads in library yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {q.data && q.data.total > limit && (
        <div className="mt-3 flex items-center justify-center gap-2 text-sm">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="rounded px-3 py-1 hover:bg-gray-100 disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-gray-500">
            {page * limit + 1}–{Math.min((page + 1) * limit, q.data.total)} / {q.data.total}
          </span>
          <button
            disabled={(page + 1) * limit >= q.data.total}
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

function FetchesPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fetches'], queryFn: () => api.history.fetches({ limit: 50 }) });
  const del = useMutation({
    mutationFn: (id: number) => api.history.deleteFetch(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fetches'] }),
  });

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Tracks</th>
            <th className="px-3 py-2">Fetched</th>
            <th className="w-16 px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {(q.data?.items ?? []).map((f) => (
            <tr key={f.id} className="border-b border-gray-100 last:border-b-0">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  {f.cover_url && (
                    <img src={f.cover_url} className="h-8 w-8 rounded object-cover" alt="" />
                  )}
                  <a
                    href={`/fetch?url=${encodeURIComponent(f.url)}`}
                    className="font-medium hover:underline"
                  >
                    {f.title}
                  </a>
                </div>
              </td>
              <td className="px-3 py-2 text-xs uppercase text-gray-500">{f.kind}</td>
              <td className="px-3 py-2 text-gray-600">{f.total_tracks}</td>
              <td className="px-3 py-2 text-xs text-gray-600">{formatDate(f.fetched_at)}</td>
              <td className="px-3 py-2">
                <button onClick={() => del.mutate(f.id)} className="rounded p-1 hover:bg-gray-100">
                  <X size={14} />
                </button>
              </td>
            </tr>
          ))}
          {(q.data?.items ?? []).length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-8 text-center text-sm text-gray-400">
                No fetches yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
