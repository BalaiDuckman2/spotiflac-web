import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function Modules() {
  const q = useQuery({ queryKey: ['modules'], queryFn: () => api.modules() });

  return (
    <div className="mx-auto max-w-3xl px-8 pb-16 pt-8">
      <h1 className="text-2xl font-bold">Modules</h1>
      <p className="mt-1 text-sm text-gray-500">
        Versions of the Python dependencies powering this instance.
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Package</th>
              <th className="px-3 py-2">Version</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.modules ?? []).map((m) => (
              <tr key={m.name} className="border-b border-gray-100 last:border-b-0">
                <td className="px-3 py-2 font-mono">{m.name}</td>
                <td className="px-3 py-2 font-mono text-gray-600">{m.version ?? '—'}</td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-xs font-semibold',
                      m.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700',
                    )}
                  >
                    {m.ok ? 'OK' : 'MISSING'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
