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
 * The x range is authoritative and y is derived from it, so panning and
 * symmetric zooming leave the lock intact and only a deliberate one-axis zoom
 * (alt- or shift-scroll) can break it — at which point this pulls it back on
 * the next frame. The tolerance stops the correction from fighting sub-pixel
 * rounding and re-rendering forever.
 */
export function useSquareScales(
  plotRef: RefObject<PlotHandle | null>,
  viewport: Viewport,
  enabled = true,
): void {
  // Deliberately the quiet setter: relocking the scales is the app tidying up
  // after itself, not an edit, and it must not leave an unsaved-changes mark
  // on a project the user has only looked at.
  const fitViewport = useStore((s) => s.fitViewport);
  useEffect(() => {
    if (!enabled) return;
    const aspect = plotRef.current?.plotAspect?.();
    if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return;

    const halfX = (viewport.xMax - viewport.xMin) / 2;
    const halfY = (viewport.yMax - viewport.yMin) / 2;
    if (halfX <= 0 || halfY <= 0) return;

    const wanted = halfX * aspect;
    if (Math.abs(wanted - halfY) / halfY < 0.005) return;

    const cy = (viewport.yMin + viewport.yMax) / 2;
    fitViewport({ ...viewport, yMin: cy - wanted, yMax: cy + wanted });
  });
}
