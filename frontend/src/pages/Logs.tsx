import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

type LogEntry = { ts: string; level: string; msg: string };

export default function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as LogEntry;
        setEntries((prev) => [...prev.slice(-999), data]);
      } catch {}
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (autoScroll && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const filtered = entries.filter((e) => level === 'all' || e.level === level);

  return (
    <div className="flex h-screen flex-col p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Logs</h1>
        <div className="flex gap-2 text-sm">
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as any)}
            className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
          >
            <option value="all">All</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <button
            onClick={() => setEntries([])}
            className="rounded-lg border border-gray-200 px-3 py-1 hover:bg-gray-50"
          >
            Clear
          </button>
        </div>
      </div>

      <pre
        ref={ref}
        className="mt-4 flex-1 overflow-auto rounded-lg border border-gray-200 bg-gray-900 p-4 font-mono text-xs leading-relaxed text-gray-100"
      >
        {filtered.map((e, i) => (
          <div key={i} className="whitespace-pre-wrap">
            <span className="text-gray-500">{e.ts.slice(11, 19)}</span>{' '}
            <span className={cn('font-semibold', levelColor(e.level))}>
              {e.level.toUpperCase()}
            </span>{' '}
            <span>{e.msg}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function levelColor(level: string): string {
  if (level === 'error') return 'text-red-400';
  if (level === 'warn') return 'text-yellow-400';
  if (level === 'info') return 'text-blue-300';
  return 'text-gray-400';
}
