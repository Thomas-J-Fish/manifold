import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react';
import type { PlotHandle } from '../plot/Plot2D';

/* A single shared handle onto whichever plot the active tab is showing.
 *
 * "Export the plot as PNG" comes from the native menu, which has no idea which
 * component is on screen. Rather than every mode registering an export callback,
 * each mode attaches this one ref to its <Plot2D>, and the export handler reads
 * whatever is currently attached. Modes that render something other than a
 * Plot2D — the 3D scene, the fractal canvas — register their own handle instead.
 */

export interface SurfaceHandle {
  toDataUrl(scale?: number): string;
  /** Present only on surfaces that are a 2D plot; see PlotHandle. */
  plotAspect?(): number | null;
}

const PlotRefContext = createContext<RefObject<SurfaceHandle | null> | null>(null);

export function PlotRefProvider({ children }: { children: ReactNode }) {
  const ref = useRef<SurfaceHandle | null>(null);
  return <PlotRefContext.Provider value={ref}>{children}</PlotRefContext.Provider>;
}

export function usePlotRef(): RefObject<SurfaceHandle | null> {
  const ref = useContext(PlotRefContext);
  if (!ref) throw new Error('usePlotRef must be used inside a PlotRefProvider');
  return ref;
}

/** Narrower type for modes whose surface really is a Plot2D. */
export function usePlot2DRef(): RefObject<PlotHandle | null> {
  return usePlotRef() as RefObject<PlotHandle | null>;
}
