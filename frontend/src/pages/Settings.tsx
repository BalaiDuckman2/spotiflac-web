import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Save, RotateCcw, Download, GripVertical } from 'lucide-react';

import { api, SettingsDTO } from '@/lib/api';
import { cn } from '@/lib/cn';

const PROVIDER_LABELS: Record<string, string> = {
  tidal: 'Tidal',
  qobuz: 'Qobuz',
  amazon: 'Amazon Music',
  spoti: 'SpotiDownloader',
};

export default function Settings() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.get() });
  const [draft, setDraft] = useState<SettingsDTO | null>(null);
  const [tab, setTab] = useState<'general' | 'files' | 'status'>('general');

  useEffect(() => {
    if (settingsQ.data && !draft) setDraft(settingsQ.data);
  }, [settingsQ.data]);

  const save = useMutation({
    mutationFn: (s: SettingsDTO) => api.settings.set(s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const reset = useMutation({
    mutationFn: () => api.settings.reset(),
    onSuccess: (s) => {
      setDraft(s);
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  if (!draft) return <div className="p-8 text-sm text-gray-500">Loading…</div>;

  const update = <K extends keyof SettingsDTO>(section: K, patch: Partial<SettingsDTO[K]>) => {
    setDraft({ ...draft, [section]: { ...draft[section], ...patch } });
  };

  return (
    <div className="mx-auto max-w-5xl px-8 pb-16 pt-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <div className="flex gap-2">
          <a
            href="/api/settings/export"
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            <Download size={14} /> Export
          </a>
          <button
            onClick={() => {
              if (confirm('Reset all settings to default?')) reset.mutate();
            }}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50"
          >
            <RotateCcw size={14} /> Reset to Default
          </button>
          <button
            onClick={() => save.mutate(draft)}
            disabled={save.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-yellow-400 px-4 py-1.5 text-sm font-semibold text-black hover:bg-yellow-500 disabled:opacity-50"
          >
            <Save size={14} /> Save Changes
          </button>
        </div>
      </div>

      <div className="mt-4 flex gap-1 border-b border-gray-200">
        {(
          [
            ['general', 'General'],
            ['files', 'File Management'],
            ['status', 'Status'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              'border-b-2 px-4 py-2 text-sm font-medium',
              tab === k
                ? 'border-yellow-400 text-yellow-700'
                : 'border-transparent text-gray-500 hover:text-gray-800',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === 'general' && (
          <GeneralTab draft={draft} update={update} />
        )}
        {tab === 'files' && <FilesTab draft={draft} update={update} />}
        {tab === 'status' && <StatusTab />}
      </div>
    </div>
  );
}

function GeneralTab({
  draft,
  update,
}: {
  draft: SettingsDTO;
  update: <K extends keyof SettingsDTO>(section: K, patch: Partial<SettingsDTO[K]>) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const old = draft.general.providers;
    const oldIdx = old.indexOf(active.id as string);
    const newIdx = old.indexOf(over.id as string);
    update('general', { providers: arrayMove(old, oldIdx, newIdx) });
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-4">
        <Field label="Quality">
          <select
            value={draft.general.quality}
            onChange={(e) => update('general', { quality: e.target.value as any })}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="LOSSLESS">Lossless (16-bit / 44.1kHz)</option>
            <option value="HI_RES">Hi-Res (24-bit / up to 96kHz)</option>
            <option value="MAX">Max (provider's best)</option>
          </select>
        </Field>

        <Field label="Provider chain (drag to reorder)">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={draft.general.providers} strategy={verticalListSortingStrategy}>
              <div className="space-y-1">
                {draft.general.providers.map((p) => (
                  <ProviderRow key={p} id={p} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </Field>

        <Field label="Accent">
          <select
            value={draft.general.accent}
            onChange={(e) => update('general', { accent: e.target.value })}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <option value="yellow">Yellow</option>
            <option value="blue">Blue</option>
            <option value="green">Green</option>
            <option value="pink">Pink</option>
          </select>
        </Field>

        <Field label="Font">
          <select
            value={draft.general.font}
            onChange={(e) => update('general', { font: e.target.value })}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <option>Google Sans</option>
            <option>Inter</option>
            <option>System</option>
          </select>
        </Field>
      </div>

      <div className="space-y-4">
        <Toggle
          label="Embed lyrics"
          checked={draft.general.embed_lyrics}
          onChange={(v) => update('general', { embed_lyrics: v })}
        />
        <Toggle
          label="Embed max-quality cover"
          checked={draft.general.embed_max_quality_cover}
          onChange={(v) => update('general', { embed_max_quality_cover: v })}
        />
        <Toggle
          label="Embed genre"
          checked={draft.general.embed_genre}
          onChange={(v) => update('general', { embed_genre: v })}
        />
        <Field label="Spotify sp_dc cookie (for synced lyrics)">
          <input
            type="password"
            value={draft.general.sp_dc}
            onChange={(e) => update('general', { sp_dc: e.target.value })}
            placeholder="optional"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Qobuz token (fallback auth)">
          <input
            type="password"
            value={draft.general.qobuz_token}
            onChange={(e) => update('general', { qobuz_token: e.target.value })}
            placeholder="optional"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
        </Field>
      </div>
    </div>
  );
}

function ProviderRow({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-gray-400 hover:text-gray-700"
      >
        <GripVertical size={16} />
      </button>
      <span className="font-medium">{PROVIDER_LABELS[id] ?? id}</span>
    </div>
  );
}

function FilesTab({
  draft,
  update,
}: {
  draft: SettingsDTO;
  update: <K extends keyof SettingsDTO>(section: K, patch: Partial<SettingsDTO[K]>) => void;
}) {
  return (
    <div className="space-y-4">
      <Field label="Track / album template">
        <input
          value={draft.file_management.track_template}
          onChange={(e) => update('file_management', { track_template: e.target.value })}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm"
        />
      </Field>
      <Field label="Playlist template">
        <input
          value={draft.file_management.playlist_template}
          onChange={(e) => update('file_management', { playlist_template: e.target.value })}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm"
        />
      </Field>
      <p className="text-xs text-gray-500">
        Placeholders: <code>{'{title}'}</code>, <code>{'{artist}'}</code>,{' '}
        <code>{'{album}'}</code>, <code>{'{album_artist}'}</code>,{' '}
        <code>{'{track:02d}'}</code>, <code>{'{position:02d}'}</code>,{' '}
        <code>{'{playlist}'}</code>, <code>{'{year}'}</code>, <code>{'{isrc}'}</code>
      </p>
      <Field label="When file already exists">
        <select
          value={draft.file_management.on_existing}
          onChange={(e) => update('file_management', { on_existing: e.target.value as any })}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        >
          <option value="skip">Skip</option>
          <option value="overwrite">Overwrite</option>
          <option value="rename">Rename (append number)</option>
        </select>
      </Field>
    </div>
  );
}

function StatusTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['status'], queryFn: () => api.status() });
  const refresh = useMutation({
    mutationFn: () => api.refreshStatus(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });

  return (
    <div>
      <button
        onClick={() => refresh.mutate()}
        className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        Refresh
      </button>
      <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Provider</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Checked</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.providers ?? []).map((p) => (
              <tr key={p.name} className="border-b border-gray-100 last:border-b-0">
                <td className="px-3 py-2 font-medium">{PROVIDER_LABELS[p.name] ?? p.name}</td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-xs font-semibold',
                      p.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700',
                    )}
                  >
                    {p.ok ? 'OK' : 'DOWN'}
                  </span>
                  {p.error && <span className="ml-2 text-xs text-gray-500">{p.error}</span>}
                </td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  {new Date(p.checked_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-semibold text-gray-700">{label}</div>
      {children}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between">
      <span className="text-sm">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 rounded-full transition',
          checked ? 'bg-yellow-400' : 'bg-gray-300',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
    </label>
  );
}
