import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Check, Info, X } from 'lucide-react';

import { cn } from '@/lib/cn';

type ToastKind = 'success' | 'error' | 'info';

type ToastAction = {
  label: string;
  to?: string;
  onClick?: () => void;
};

type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
};

type ToastApi = {
  success: (message: string, opts?: { action?: ToastAction; durationMs?: number }) => void;
  error: (message: string, opts?: { action?: ToastAction; durationMs?: number }) => void;
  info: (message: string, opts?: { action?: ToastAction; durationMs?: number }) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION_MS = 4000;
const MAX_VISIBLE = 3;

let nextId = 1;

export function ToasterProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, opts?: { action?: ToastAction; durationMs?: number }) => {
      const id = nextId++;
      const duration = opts?.durationMs ?? DEFAULT_DURATION_MS;
      setToasts((t) => {
        const next = [...t, { id, kind, message, action: opts?.action }];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  const api: ToastApi = {
    success: (m, o) => push('success', m, o),
    error: (m, o) => push('error', m, o),
    info: (m, o) => push('info', m, o),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToasterProvider>');
  return ctx;
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(r);
  }, []);

  const palette = {
    success: 'border-green-200 bg-white text-green-900',
    error: 'border-red-200 bg-white text-red-900',
    info: 'border-gray-200 bg-white text-gray-900',
  }[toast.kind];

  const Icon = {
    success: Check,
    error: AlertCircle,
    info: Info,
  }[toast.kind];

  const iconColor = {
    success: 'text-green-600',
    error: 'text-red-600',
    info: 'text-gray-500',
  }[toast.kind];

  const action = toast.action;

  return (
    <div
      className={cn(
        'pointer-events-auto flex min-w-[280px] max-w-[420px] items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg transition-all duration-200',
        palette,
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
    >
      <Icon size={16} className={cn('flex-shrink-0', iconColor)} />
      <span className="flex-1">{toast.message}</span>
      {action && action.to && (
        <Link
          to={action.to}
          onClick={onDismiss}
          className="flex-shrink-0 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-gray-800"
        >
          {action.label}
        </Link>
      )}
      {action && !action.to && action.onClick && (
        <button
          onClick={() => {
            action.onClick?.();
            onDismiss();
          }}
          className="flex-shrink-0 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-gray-800"
        >
          {action.label}
        </button>
      )}
      <button
        onClick={onDismiss}
        className="flex-shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
