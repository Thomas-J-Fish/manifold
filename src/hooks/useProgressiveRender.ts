import { useEffect, useRef, useState } from 'react';

export interface ProgressiveState {
  /** Increments whenever new work has been done, to trigger a repaint. */
  version: number;
  /** 0…1. */
  progress: number;
  done: boolean;
}

interface Options {
  /** Re-starts the computation whenever this changes. */
  key: string;
  /** Total units of work, e.g. rows of pixels. */
  total: number;
  /** Does units [from, to). Must be cheap per unit and free of side effects
   *  outside the buffer the caller owns. */
  step: (from: number, to: number) => void;
  /** Units attempted in the first slice; adapts from there. */
  initialChunk?: number;
  /** Milliseconds of work per animation frame. */
  budgetMs?: number;
  enabled?: boolean;
}

/**
 * Runs a long computation in slices, a few milliseconds per frame.
 *
 * A full-window Mandelbrot at high iteration counts is hundreds of millions of
 * operations — far past what fits in a frame. Rather than move it to a worker
 * (which would mean serialising the expression, the palette and the buffer, and
 * a second copy of the maths), it is cut into slices sized to a time budget.
 * The chunk size adapts to whatever the machine actually managed last frame, so
 * a fast machine does big slices and a slow one stays responsive. The picture
 * appears progressively, which is also simply nicer to look at than a frozen
 * window followed by a sudden image.
 */
export function useProgressiveRender(options: Options): ProgressiveState {
  const { key, total, step, initialChunk = 8, budgetMs = 10, enabled = true } = options;
  const [state, setState] = useState<ProgressiveState>({ version: 0, progress: 0, done: false });
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!enabled || total <= 0) {
      setState({ version: 0, progress: 1, done: true });
      return;
    }

    let cursor = 0;
    let chunk = initialChunk;
    let frame = 0;
    let cancelled = false;
    setState({ version: 0, progress: 0, done: false });

    const run = () => {
      if (cancelled) return;
      const start = performance.now();
      let workedThisFrame = 0;

      while (cursor < total && performance.now() - start < budgetMs) {
        const to = Math.min(total, cursor + chunk);
        stepRef.current(cursor, to);
        workedThisFrame += to - cursor;
        cursor = to;
      }

      // Retarget the chunk size at roughly one budget's worth of work, damped
      // so a single slow frame does not collapse it to nothing.
      const elapsed = Math.max(0.1, performance.now() - start);
      const rate = workedThisFrame / elapsed;
      chunk = Math.max(1, Math.round((chunk + rate * budgetMs) / 2));

      setState((prev) => ({
        version: prev.version + 1,
        progress: cursor / total,
        done: cursor >= total,
      }));

      if (cursor < total) frame = requestAnimationFrame(run);
    };

    frame = requestAnimationFrame(run);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // `step` is intentionally excluded: it is a fresh closure every render and
    // the caller declares what actually invalidates the work through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, total, enabled, initialChunk, budgetMs]);

  return state;
}
