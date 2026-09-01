import { useEffect, useState } from 'react';
import { answerDiscard, onDiscardRequest, type DiscardAnswer } from '../../core/webBridge';
import { Button } from '../ui/controls';

/* The web stand-in for the native "you have unsaved changes" sheet.
 *
 * `window.confirm` was the obvious shortcut and is the wrong one: it offers two
 * buttons and the choice here is genuinely three-way. Collapsing "Save" and
 * "Don't Save" into one OK button means the only way to keep your work is to
 * cancel, notice, save by hand, and try again — and most people will simply
 * press OK and lose it.
 */
export function DiscardDialog() {
  const [request, setRequest] = useState<{ verb: string } | null>(null);

  useEffect(() => onDiscardRequest((r) => setRequest(r ? { verb: r.verb } : null)), []);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answer('cancel');
      if (e.key === 'Enter') answer('save');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  const answer = (choice: DiscardAnswer) => answerDiscard(choice);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-8 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-label="Unsaved changes"
    >
      <div className="w-full max-w-sm rounded-xl border border-edge bg-surface-2 p-5 shadow-pop">
        <h2 className="text-sm font-semibold text-ink">This project has unsaved changes.</h2>
        <p className="mt-1.5 text-2xs leading-relaxed text-ink-dim">
          Your tabs, expressions and simulation settings will be lost if you {request.verb} without saving.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => answer('cancel')} testId="discard-cancel">
            Cancel
          </Button>
          <Button onClick={() => answer('discard')} testId="discard-discard">
            Don’t save
          </Button>
          <Button variant="accent" onClick={() => answer('save')} testId="discard-save">
            Save…
          </Button>
        </div>
      </div>
    </div>
  );
}
