import { useEffect, type RefObject } from 'react';
import type { PlotHandle } from '../plot/Plot2D';
import { useStore } from '../../core/store';
import type { Viewport } from '../../core/types';

/**
 * Keeps one unit on x the same number of pixels as one unit on y.
 *
 * On a graph this is a preference. On a bench it is a correctness requirement:
 * with unequal scales a ball is drawn as an ellipse, a 45° ramp is not at 45°,
 * a circular pendulum arc becomes an oval, and a resistor's rectangle comes out
 * square. Every one of those quietly misinforms, and the first two make the
 * geometry on screen disagree with the geometry being simulated.
 *
 * By default the x range is authoritative and y is derived from it, so panning
 * and symmetric zooming leave the lock intact and only a deliberate one-axis
 * zoom (alt- or shift-scroll) can break it — at which point this pulls it back
 * on the next frame. The tolerance stops the correction from fighting
 * sub-pixel rounding and re-rendering forever.
 *
 * `mode: 'contain'` instead treats the requested rectangle as a minimum and
 * widens whichever axis needs it. That is what a diagram with a fixed shape in
 * it wants — a pole–zero plot has to show the whole unit circle, and deriving
 * y from x in a wide pane crops the top and bottom off it.
 */
export function useSquareScales(
  plotRef: RefObject<PlotHandle | null>,
  viewport: Viewport,
  enabled = true,
  mode: 'derive-y' | 'contain' = 'derive-y',
): void {
  // Deliberately the quiet setter: relocking the scales is the app tidying up
  // after itself, not an edit, and it must not leave an unsaved-changes mark
  // on a project the user has only looked at.
  const fitViewport = useStore((s) => s.fitViewport);
  useEffect(() => {
    if (!enabled) return undefined;

    /* Read the viewport as it is *now*, not as it was when this render began.
     *
     * A mode that reframes itself — switching from a feasible region to a
     * constraint curve, say — does so in its own effect, which runs before
     * this one in the same commit. Squaring the argument passed in at render
     * time would then write the *old* rectangle back over the new one, and
     * because the reframe is keyed on the view it never runs again: the mode
     * silently keeps the previous view's frame. Taking the live value means
     * this only ever adjusts whatever the last word was. */
    const live = (): Viewport => {
      const state = useStore.getState();
      const tab = state.project.tabs.find((t) => t.id === state.project.activeTabId);
      return tab?.viewport ?? viewport;
    };

    const apply = (): boolean => {
      const viewport = live();
      const aspect = plotRef.current?.plotAspect?.();
      /* The plot reports its aspect only once it has drawn, because the plot
       * area's width depends on how wide the axis labels turned out. On a
       * *moving* surface the next frame re-runs this effect and picks the
       * number up; on a still one — a pole–zero diagram, a lens — there is no
       * next frame, and without the retry below the scales stay unequal and
       * the unit circle is an ellipse for as long as the view is open. */
      if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return false;

      const halfX = (viewport.xMax - viewport.xMin) / 2;
      const halfY = (viewport.yMax - viewport.yMin) / 2;
      if (halfX <= 0 || halfY <= 0) return true;

      const wanted = halfX * aspect;
      if (Math.abs(wanted - halfY) / halfY < 0.005) return true;

      const cy = (viewport.yMin + viewport.yMax) / 2;
      if (mode === 'contain' && wanted < halfY) {
        // y is the binding constraint: keep it and widen x to match.
        const cx = (viewport.xMin + viewport.xMax) / 2;
        const half = halfY / aspect;
        fitViewport({ ...viewport, xMin: cx - half, xMax: cx + half });
        return true;
      }
      fitViewport({ ...viewport, yMin: cy - wanted, yMax: cy + wanted });
      return true;
    };

    if (apply()) return undefined;
    // Bounded: a handful of frames, then give up rather than spin for ever on
    // a surface that never reports a box at all.
    let tries = 0;
    let frame = 0;
    const retry = () => {
      if (apply() || ++tries > 8) return;
      frame = requestAnimationFrame(retry);
    };
    frame = requestAnimationFrame(retry);
    return () => cancelAnimationFrame(frame);
  });
}
