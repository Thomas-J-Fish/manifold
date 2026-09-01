import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useElementSize } from '../../hooks/useElementSize';
import {
  DARK_THEME,
  drawScene,
  measureGutters,
  type PlotScene,
  type Transform,
  Transform as TransformClass,
} from '../../plot/scene';
import type { Viewport } from '../../core/types';

export interface PlotHandle {
  /** The rendered plot as a PNG data URL, at the requested pixel scale. */
  toDataUrl(scale?: number): string;
  /** World coordinates of the last pointer position, if the pointer is inside. */
  cursor(): { x: number; y: number } | null;
  /**
   * The plot area's pixel height divided by its pixel width.
   *
   * This is the number "make one unit on x the same length as one unit on y"
   * needs, and it is only knowable here — it depends on the window size and on
   * how wide the axis labels turned out, neither of which the store can see.
   */
  plotAspect(): number | null;
}

export interface PlotPointerEvent {
  x: number;
  y: number;
  /** Pixel position within the canvas. */
  px: number;
  py: number;
  shiftKey: boolean;
  altKey: boolean;
  button: number;
}

interface Props {
  scene: PlotScene;
  onViewportChange?: (v: Viewport) => void;
  /** Disables the built-in pan and zoom; used where a mode owns the gestures. */
  staticView?: boolean;
  /** Locks panning and zooming to one axis. */
  lockY?: boolean;
  onPointerDown?: (e: PlotPointerEvent) => boolean | void;
  onPointerMove?: (e: PlotPointerEvent) => void;
  onPointerUp?: (e: PlotPointerEvent) => void;
  onDoubleClick?: (e: PlotPointerEvent) => void;
  /** Renders the value readout in the corner; return null to suppress it. */
  readout?: (x: number, y: number) => string | null;
  showCrosshair?: boolean;
  className?: string;
}

/**
 * The shared plotting surface.
 *
 * The canvas is the only thing that redraws when the viewport changes; React
 * is not involved in a pan, which is what keeps dragging smooth. The scene is
 * held in a ref and painted from an effect, so a new scene object from a parent
 * re-render costs one repaint and no reconciliation of anything below here.
 */
export const Plot2D = forwardRef<PlotHandle, Props>(function Plot2D(props, ref) {
  const {
    scene,
    onViewportChange,
    staticView = false,
    lockY = false,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    readout,
    showCrosshair = true,
    className,
  } = props;

  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformRef = useRef<Transform | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const [cursor, setCursor] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  const dragRef = useRef<{ px: number; py: number; view: Viewport; panning: boolean } | null>(null);

  // ---------------------------------------------------------------- painting

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(size.width * dpr);
    const h = Math.round(size.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    transformRef.current = drawScene(ctx, sceneRef.current, size.width, size.height, DARK_THEME);
  }, [size.width, size.height]);

  useEffect(() => {
    paint();
  }, [paint, scene]);

  useImperativeHandle(
    ref,
    () => ({
      toDataUrl(scale = 2) {
        const off = document.createElement('canvas');
        off.width = Math.round(size.width * scale);
        off.height = Math.round(size.height * scale);
        const ctx = off.getContext('2d');
        if (!ctx) return '';
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        drawScene(ctx, sceneRef.current, size.width, size.height, DARK_THEME);
        return off.toDataURL('image/png');
      },
      cursor: () => (cursor ? { x: cursor.x, y: cursor.y } : null),
      plotAspect: () => {
        const box = transformRef.current?.box;
        return box && box.width > 0 ? box.height / box.width : null;
      },
    }),
    [size.width, size.height, cursor],
  );

  // ---------------------------------------------------------------- gestures

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const tr = transformRef.current;
    if (!canvas || !tr) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return { px, py, x: tr.x(px), y: tr.y(py) };
  }, []);

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (staticView || !onViewportChange) return;
      e.preventDefault();
      const p = toWorld(e.clientX, e.clientY);
      if (!p) return;
      const v = sceneRef.current.viewport;
      // A trackpad reports many small deltas and a mouse wheel a few large
      // ones; the exponential keeps both feeling like the same gesture.
      const factor = Math.exp(e.deltaY * 0.0016);
      const zoomX = e.altKey ? 1 : factor;
      const zoomY = lockY || e.shiftKey ? 1 : factor;
      onViewportChange({
        xMin: p.x + (v.xMin - p.x) * zoomX,
        xMax: p.x + (v.xMax - p.x) * zoomX,
        yMin: p.y + (v.yMin - p.y) * zoomY,
        yMax: p.y + (v.yMax - p.y) * zoomY,
      });
    },
    [staticView, onViewportChange, toWorld, lockY],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Registered manually because React's synthetic wheel handler is passive
    // and cannot call preventDefault, which would let the window scroll.
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const pointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    if (!p) return;
    const consumed = onPointerDown?.({ ...p, shiftKey: e.shiftKey, altKey: e.altKey, button: e.button });
    if (consumed) {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { px: p.px, py: p.py, view: sceneRef.current.viewport, panning: false };
      return;
    }
    if (staticView || !onViewportChange) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: p.px, py: p.py, view: { ...sceneRef.current.viewport }, panning: true };
  };

  const pointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    if (!p) return;
    setCursor(p);
    const drag = dragRef.current;
    if (drag?.panning && onViewportChange) {
      const tr = transformRef.current;
      if (!tr) return;
      const dx = (p.px - drag.px) / tr.scaleX;
      const dy = (p.py - drag.py) / tr.scaleY;
      onViewportChange({
        xMin: drag.view.xMin - dx,
        xMax: drag.view.xMax - dx,
        yMin: drag.view.yMin + dy,
        yMax: drag.view.yMax + dy,
      });
      return;
    }
    onPointerMove?.({ ...p, shiftKey: e.shiftKey, altKey: e.altKey, button: e.button });
  };

  const pointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* the capture may already have been lost; nothing to release */
    }
    if (p) onPointerUp?.({ ...p, shiftKey: e.shiftKey, altKey: e.altKey, button: e.button });
  };

  const readoutText = cursor && readout ? readout(cursor.x, cursor.y) : null;

  return (
    <div ref={containerRef} className={`relative h-full w-full ${className ?? ''}`}>
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none select-none"
        style={{ cursor: staticView ? 'default' : dragRef.current?.panning ? 'grabbing' : 'crosshair' }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={(e) => {
          const p = toWorld(e.clientX, e.clientY);
          if (p) onDoubleClick?.({ ...p, shiftKey: e.shiftKey, altKey: e.altKey, button: e.button });
        }}
      />
      {showCrosshair && cursor && <Crosshair cursor={cursor} transform={transformRef.current} />}
      {readoutText && (
        <div className="pointer-events-none absolute right-3 bottom-3 whitespace-pre-line rounded-md border border-edge bg-surface-0/90 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-ink-dim shadow-panel">
          {readoutText}
        </div>
      )}
    </div>
  );
});

/** A thin guide pair following the pointer. Drawn in the DOM rather than on the
 *  canvas so it moves without forcing the whole scene to repaint. */
function Crosshair({
  cursor,
  transform,
}: {
  cursor: { px: number; py: number };
  transform: Transform | null;
}) {
  if (!transform) return null;
  const box = transform.box;
  const inside =
    cursor.px >= box.left &&
    cursor.px <= box.left + box.width &&
    cursor.py >= box.top &&
    cursor.py <= box.top + box.height;
  if (!inside) return null;
  return (
    <>
      <div
        className="pointer-events-none absolute bg-accent/25"
        style={{ left: cursor.px, top: box.top, width: 1, height: box.height }}
      />
      <div
        className="pointer-events-none absolute bg-accent/25"
        style={{ left: box.left, top: cursor.py, width: box.width, height: 1 }}
      />
    </>
  );
}

/** Recomputes the plot box for a given canvas size without painting, so modes
 *  can size their offscreen rasters to match the plot area exactly. */
export function plotBoxFor(scene: PlotScene, width: number, height: number): TransformClass | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const box = measureGutters(ctx, scene, width, height);
  return new TransformClass(scene.viewport, box, scene.logY ?? false);
}
