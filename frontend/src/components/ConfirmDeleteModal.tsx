import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

import { cn } from '@/lib/cn';

type Props = {
  open: boolean;
  title: string;
  items?: string[];
  warning?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
};

const MAX_ITEMS_SHOWN = 10;

export default function ConfirmDeleteModal({
  open,
  title,
  items,
  warning,
  confirmLabel = 'Supprimer',
  onConfirm,
  onCancel,
  loading,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, loading, onCancel]);

  if (!open) return null;

  const shown = items ? items.slice(0, MAX_ITEMS_SHOWN) : [];
  const hidden = items ? Math.max(0, items.length - MAX_ITEMS_SHOWN) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div
        className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
            <AlertTriangle size={18} />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            {warning && (
              <p className="mt-1 text-sm text-gray-600">{warning}</p>
            )}
          </div>
        </div>

        {shown.length > 0 && (
          <div className="mx-5 mt-3 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
            <ul className="space-y-0.5">
              {shown.map((it, i) => (
                <li key={i} className="truncate">
                  · {it}
                </li>
              ))}
              {hidden > 0 && (
                <li className="text-gray-400">… et {hidden} autre{hidden > 1 ? 's' : ''}</li>
              )}
            </ul>
          </div>
        )}

        <p className="px-5 pt-3 text-xs text-gray-500">
          Cette action est irréversible. Les fichiers seront effacés du disque.
        </p>

        <div className="mt-4 flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
          >
            Annuler
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-semibold text-white',
              'bg-red-600 hover:bg-red-700 disabled:opacity-50',
            )}
          >
            {loading ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
