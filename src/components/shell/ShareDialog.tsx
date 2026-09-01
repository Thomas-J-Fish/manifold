import { useEffect, useState } from 'react';
import { useStore } from '../../core/store';
import { buildShareUrl } from '../../core/share';
import { Button, Callout } from '../ui/controls';
import { IconClose, IconCopy } from '../ui/Icons';

/**
 * "Send someone this exact scene."
 *
 * The whole project travels inside the link, so there is nothing to host and
 * nothing to expire. It also means the link is long — a few thousand
 * characters — which is fine in a message but startling in an address bar, so
 * the size is shown rather than hidden, and a project too big to carry is told
 * so plainly instead of producing a link that fails somewhere downstream.
 */
export function ShareDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const pushToast = useStore((s) => s.pushToast);
  const [state, setState] = useState<{ url: string; length: number; tooLong: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    buildShareUrl(project)
      .then((r) => live && setState(r))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard access needs a secure context and can be refused outright,
      // so the text stays selectable as the fallback rather than the feature
      // simply appearing to do nothing.
      pushToast({ kind: 'warn', message: 'Could not reach the clipboard — select the link and copy it by hand.' });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl border border-edge bg-surface-2 shadow-pop"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Share a link"
      >
        <header className="flex items-start justify-between gap-4 border-b border-edge px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-ink">Share a link</h2>
            <p className="mt-0.5 text-2xs text-ink-faint">
              The whole project travels inside the link. Nothing is uploaded anywhere.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <IconClose size={15} />
          </button>
        </header>

        <div className="space-y-3 px-5 py-4">
          {error && <Callout kind="error">{error}</Callout>}

          {!state && !error && <p className="text-2xs text-ink-faint">Packing the project…</p>}

          {state && (
            <>
              <textarea
                readOnly
                data-testid="share-url"
                value={state.url}
                onFocus={(e) => e.currentTarget.select()}
                className="h-28 w-full resize-none rounded-md border border-edge bg-surface-1 p-2.5 font-mono text-2xs leading-relaxed text-ink-dim focus:border-accent focus:outline-none"
              />

              {state.tooLong ? (
                <Callout kind="warn">
                  At {state.length.toLocaleString()} characters this link is too long to survive most messaging
                  apps, usually because the project contains an imported dataset. Save it as a file and send that
                  instead.
                </Callout>
              ) : (
                <p className="text-2xs text-ink-faint">
                  {state.length.toLocaleString()} characters. Anyone who opens it gets a copy they can change
                  freely — it is a copy, not a shared document, so their edits never come back to you.
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button onClick={onClose}>Close</Button>
                <Button variant="accent" onClick={copy} testId="share-copy">
                  <span className="flex items-center gap-1.5">
                    <IconCopy size={12} />
                    {copied ? 'Copied' : 'Copy link'}
                  </span>
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
