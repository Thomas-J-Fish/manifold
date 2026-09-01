import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The split both sandboxes use: the bench on the left, the instruments on the
 * right.
 *
 * The proportion is draggable and kept in component state rather than in the
 * document. It is a view preference rather than part of the experiment, and
 * putting it in the project file would mean every drag of the divider marked
 * the project unsaved — which is the kind of small dishonesty that teaches
 * people to ignore the unsaved-changes dot.
 */
export function SandboxLayout({
  canvas,
  instruments,
  storageKey,
}: {
  canvas: ReactNode;
  instruments: ReactNode;
  storageKey: string;
}) {
  const [fraction, setFraction] = useState(() => 0.62);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    // Remembered per sandbox, but only for this window: the two modes want
    // different proportions and nobody wants to set them twice.
    const saved = sessionStorage.getItem(`manifold.split.${storageKey}`);
    if (saved) {
      const v = Number(saved);
      if (Number.isFinite(v) && v > 0.2 && v < 0.85) setFraction(v);
    }
  }, [storageKey]);

  const onMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      const next = Math.min(0.82, Math.max(0.24, (e.clientX - box.left) / box.width));
      setFraction(next);
      sessionStorage.setItem(`manifold.split.${storageKey}`, String(next));
    },
    [storageKey],
  );

  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
    };
  }, [onMove]);

  return (
    <div ref={containerRef} className="flex h-full w-full min-w-0">
      <div className="relative min-w-0" style={{ width: `${fraction * 100}%` }}>
        {canvas}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown={() => {
          draggingRef.current = true;
        }}
        className="group relative w-px shrink-0 cursor-col-resize bg-edge"
      >
        <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-accent/25" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface-0">{instruments}</div>
    </div>
  );
}
