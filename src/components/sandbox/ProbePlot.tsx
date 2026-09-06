import { useMemo } from 'react';
import { Plot2D } from '../plot/Plot2D';
import type { Layer, PlotScene } from '../../plot/scene';
import { withAlpha } from '../../plot/scene';

export interface Trace {
  id: string;
  label: string;
  unit: string;
  colour: string;
  xs: Float64Array;
  ys: Float64Array;
  /** Drawn dashed and half-weight: the closed form, not the simulation. */
  predicted?: Float64Array;
  predictedLabel?: string;
}

/**
 * Pads a range so a trace never touches the frame, so a constant signal gets a
 * sensible window rather than a zero-height one, and — importantly — so a
 * *conserved* quantity is drawn as the flat line it is.
 *
 * Auto-scaling is right almost always and badly wrong for conservation. Total
 * energy that holds to a part in ten million, magnified until the last two
 * digits fill the chart, looks like a violent oscillation; a student watching
 * their pendulum's energy apparently thrash about has been told the opposite
 * of the truth. Below a hundredth of a percent of the signal's own size there
 * is nothing physical left to see, only the integrator's last bits, so the
 * window is widened to that floor and the line goes flat.
 */
function padRange(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1];
  const centre = (min + max) / 2;
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  const floor = magnitude > 0 ? magnitude * 1e-4 : 0;

  if (max - min < Math.max(1e-12, floor)) {
    const span = Math.max(floor, 1e-6, Math.abs(centre) * 1e-4);
    return [centre - span, centre + span];
  }
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
}

/**
 * One live chart per unit.
 *
 * Putting an angle in degrees and a speed in metres per second on one pair of
 * axes produces a chart where the interesting one is a flat line at the
 * bottom, so traces are grouped by unit and each group gets its own panel with
 * the unit as its y-axis label. It costs vertical space and it is the only
 * arrangement in which both signals are actually readable.
 */
export function ProbePlot({
  traces,
  xLabel,
  cursorTime,
  height,
  fill = false,
}: {
  traces: Trace[];
  xLabel: string;
  /** Drawn as a vertical line: where the shared clock currently is. */
  cursorTime: number | null;
  height: number;
  /** Take the whole of a flex parent instead of the fixed height. Used where
   * the plot is one of two filling a pane rather than one of several stacked
   * in a scrolling column; `height` is then only the minimum. */
  fill?: boolean;
}) {
  const scene = useMemo((): PlotScene => {
    const layers: Layer[] = [];
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;

    for (const t of traces) {
      for (let i = 0; i < t.xs.length; i++) {
        const x = t.xs[i];
        const y = t.ys[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
      if (t.predicted) {
        for (let i = 0; i < t.predicted.length; i++) {
          const y = t.predicted[i];
          if (!Number.isFinite(y)) continue;
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
      }
    }

    for (const t of traces) {
      if (t.predicted) {
        layers.push({
          type: 'polyline',
          xs: t.xs,
          ys: t.predicted,
          colour: withAlpha(t.colour, 0.75),
          width: 1.25,
          style: 'dashed',
        });
      }
      layers.push({ type: 'polyline', xs: t.xs, ys: t.ys, colour: t.colour, width: 1.75 });
    }

    if (cursorTime !== null && Number.isFinite(cursorTime)) {
      layers.push({ type: 'vline', x: cursorTime, colour: 'rgba(139,124,246,0.7)', width: 1 });
    }

    const [lo, hi] = padRange(yMin, yMax);
    const legend = traces.flatMap((t) => [
      { label: t.label, colour: t.colour },
      ...(t.predicted ? [{ label: t.predictedLabel ?? 'Prediction', colour: t.colour, dashed: true }] : []),
    ]);

    return {
      viewport: {
        xMin: Number.isFinite(xMin) ? xMin : 0,
        xMax: Number.isFinite(xMax) && xMax > xMin ? xMax : 1,
        yMin: lo,
        yMax: hi,
      },
      layers,
      showGrid: true,
      showMinorGrid: false,
      showAxes: true,
      xLabel,
      yLabel: traces[0]?.unit || '',
      legend: legend.length > 1 ? legend : undefined,
    };
  }, [traces, xLabel, cursorTime]);

  return (
    <div style={fill ? { minHeight: height } : { height }} className={fill ? 'h-full w-full' : 'w-full'}>
      <Plot2D
        scene={scene}
        staticView
        showCrosshair={false}
        readout={(x, y) => `${xLabel} ${x.toPrecision(4)} · ${y.toPrecision(4)} ${traces[0]?.unit ?? ''}`}
      />
    </div>
  );
}

/** Groups traces by unit so each chart has one meaningful y axis. */
export function groupByUnit(traces: Trace[]): Trace[][] {
  const groups = new Map<string, Trace[]>();
  for (const t of traces) {
    const list = groups.get(t.unit);
    if (list) list.push(t);
    else groups.set(t.unit, [t]);
  }
  return [...groups.values()];
}
