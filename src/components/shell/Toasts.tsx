import { useEffect } from 'react';
import { useStore } from '../../core/store';
import { IconCheck, IconClose, IconInfo, IconWarning } from '../ui/Icons';

const LIFETIME: Record<string, number> = { success: 3200, info: 4200, warn: 7000, error: 11000 };

/** Transient notifications, stacked bottom-right. Errors linger longest
 *  because they are the ones the user actually has to read. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: { id: string; kind: string; message: string; detail?: string };
  onDismiss: () => void;
}) {
  useEffect(() => {
    const ms = LIFETIME[toast.kind] ?? 4000;
    const timer = setTimeout(onDismiss, ms);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss]);

  const palette =
    toast.kind === 'error'
      ? 'border-rose-500/50 bg-rose-950/80 text-rose-100'
      : toast.kind === 'warn'
        ? 'border-amber-500/50 bg-amber-950/70 text-amber-100'
        : toast.kind === 'success'
          ? 'border-emerald-500/40 bg-emerald-950/70 text-emerald-100'
          : 'border-edge bg-surface-3/95 text-ink';

  const Icon = toast.kind === 'error' || toast.kind === 'warn' ? IconWarning : toast.kind === 'success' ? IconCheck : IconInfo;

  return (
    <div
      className={`toast-enter pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 shadow-pop backdrop-blur ${palette}`}
      role="status"
    >
      <Icon size={15} className="mt-0.5 shrink-0 opacity-80" />
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-snug">{toast.message}</p>
        {toast.detail && <p className="mt-0.5 break-words text-2xs opacity-70">{toast.detail}</p>}
      </div>
      <button type="button" onClick={onDismiss} className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100">
        <IconClose size={12} />
      </button>
    </div>
  );
}
