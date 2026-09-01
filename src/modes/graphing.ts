/* Turning a tab's expression list into a plot scene.
 *
 * Kept apart from the React component so it can be reasoned about — and tested
 * — as a pure function of (expressions, parameters, viewport) → layers.
 */

import { derivative, findExtrema, findRoots, integrate } from '../core/math/numeric';
import { marchingSquares, sampleFunction, sampleParametric, type Viewport as SampleView } from '../core/math/sampling';
import type { EvalScope } from '../core/math/scope';
import type { ExpressionItem } from '../core/types';
import type { Layer } from '../plot/scene';
import { withAlpha } from '../plot/scene';

export interface GraphResult {
  layers: Layer[];
  legend: { label: string; colour: string; dashed?: boolean }[];
  /** Per-expression diagnostics for the sidebar and the readout. */
  notes: { id: string; label: string; text: string }[];
  errors: { id: string; message: string }[];
}

export interface BuildOptions {
  expressions: ExpressionItem[];
  scope: EvalScope;
  view: SampleView;
  /** Analytical extras cost real time; skipped while an animation is running. */
  detailed: boolean;
}

export function buildGraphScene(opts: BuildOptions): GraphResult {
  const { expressions, scope, view, detailed } = opts;
  const layers: Layer[] = [];
  const legend: GraphResult['legend'] = [];
  const notes: GraphResult['notes'] = [];
  const errors: GraphResult['errors'] = [];

  expressions.forEach((expr, index) => {
    if (!expr.visible || expr.kind === 'definition' || !expr.source.trim()) return;
    const label = expr.label || defaultLabel(expr, index);

    switch (expr.kind) {
      case 'function': {
        const { fn, error } = scope.compile1(expr.source, 'x');
        if (error) {
          errors.push({ id: expr.id, message: error });
          return;
        }
        const segments = sampleFunction(fn, view);
        if (expr.fill) {
          layers.push({ type: 'area', segments, baseline: 0, colour: withAlpha(expr.colour, 0.18) });
        }
        if (expr.showIntegral) {
          const lo = Math.min(expr.integralFrom, expr.integralTo);
          const hi = Math.max(expr.integralFrom, expr.integralTo);
          const shaded = sampleFunction(fn, { ...view, xMin: lo, xMax: hi });
          layers.push({ type: 'area', segments: shaded, baseline: 0, colour: withAlpha(expr.colour, 0.3) });
          const result = integrate(fn, expr.integralFrom, expr.integralTo, 1e-10);
          notes.push({
            id: expr.id,
            label,
            text: `∫ from ${trim(expr.integralFrom)} to ${trim(expr.integralTo)} = ${trim(result.value, 8)}${
              result.converged ? '' : ' (did not fully converge)'
            }`,
          });
          layers.push({ type: 'vline', x: expr.integralFrom, colour: withAlpha(expr.colour, 0.6), style: 'dotted', width: 1 });
          layers.push({ type: 'vline', x: expr.integralTo, colour: withAlpha(expr.colour, 0.6), style: 'dotted', width: 1 });
        }
        layers.push({
          type: 'curve',
          segments,
          colour: expr.colour,
          width: expr.width,
          style: expr.style,
        });
        if (expr.showDerivative) {
          const dSegments = sampleFunction((x) => derivative(fn, x), view);
          layers.push({
            type: 'curve',
            segments: dSegments,
            colour: expr.colour,
            width: Math.max(1, expr.width - 0.6),
            style: 'dashed',
            alpha: 0.65,
          });
          legend.push({ label: `${label}′`, colour: expr.colour, dashed: true });
        }
        if (expr.showFeatures && detailed) {
          // Root and extremum finding sweeps the whole visible range twice, so
          // it is skipped during playback where the plot changes every frame.
          for (const r of findRoots(fn, view.xMin, view.xMax, 1400)) {
            layers.push({ type: 'marker', x: r, y: 0, label: `x = ${trim(r, 6)}`, colour: expr.colour, radius: 3.5 });
          }
          for (const e of findExtrema(fn, view.xMin, view.xMax, 900)) {
            if (e.y < view.yMin || e.y > view.yMax) continue;
            layers.push({
              type: 'marker',
              x: e.x,
              y: e.y,
              label: `${e.kind === 'max' ? 'max' : 'min'} ${trim(e.y, 5)}`,
              colour: expr.colour,
              radius: 3.5,
              offset: [8, e.kind === 'max' ? -10 : 12],
            });
          }
        }
        legend.push({ label, colour: expr.colour });
        break;
      }

      case 'parametric': {
        const cx = scope.compile1(expr.source, 't');
        const cy = scope.compile1(expr.source2 || '0', 't');
        if (cx.error || cy.error) {
          errors.push({ id: expr.id, message: cx.error ?? cy.error ?? 'Invalid parametric curve' });
          return;
        }
        // The two closures share one frame, so t must be written by whichever
        // is called last; sampling calls them in lock-step, which is safe.
        const segments = sampleParametric(cx.fn, cy.fn, expr.tMin, expr.tMax, view);
        layers.push({ type: 'curve', segments, colour: expr.colour, width: expr.width, style: expr.style });
        legend.push({ label, colour: expr.colour });
        break;
      }

      case 'polar': {
        const { fn, error } = scope.compile1(expr.source, 'θ');
        const alt = error ? scope.compile1(expr.source, 'theta') : null;
        const radial = error ? alt?.fn : fn;
        if (!radial || (error && alt?.error)) {
          errors.push({ id: expr.id, message: error ?? 'Invalid polar curve' });
          return;
        }
        const segments = sampleParametric(
          (t) => radial(t) * Math.cos(t),
          (t) => radial(t) * Math.sin(t),
          expr.tMin,
          expr.tMax,
          view,
        );
        layers.push({ type: 'curve', segments, colour: expr.colour, width: expr.width, style: expr.style });
        legend.push({ label, colour: expr.colour });
        break;
      }

      case 'implicit': {
        const { fn, error } = scope.compile2(expr.source, 'x', 'y');
        if (error) {
          errors.push({ id: expr.id, message: error });
          return;
        }
        const data = marchingSquares(fn, view, 0, detailed ? 300 : 180);
        layers.push({ type: 'segments', data, colour: expr.colour, width: expr.width, style: expr.style });
        legend.push({ label, colour: expr.colour });
        break;
      }

      case 'inequality': {
        const { fn, error } = scope.compile2(expr.source, 'x', 'y');
        if (error) {
          errors.push({ id: expr.id, message: error });
          return;
        }
        const mask = buildMask(fn, view, expr.colour, detailed ? 260 : 150);
        if (mask) layers.push({ type: 'image', ...mask, alpha: 0.42, smooth: true });
        const boundary = marchingSquares(fn, view, 0, detailed ? 280 : 160);
        layers.push({ type: 'segments', data: boundary, colour: expr.colour, width: 1.6 });
        legend.push({ label, colour: expr.colour });
        break;
      }

      case 'points': {
        const parsed = parsePoints(expr.source);
        if (!parsed.length) {
          errors.push({ id: expr.id, message: 'No points could be read. Use "x, y" per line.' });
          return;
        }
        layers.push({
          type: 'points',
          xs: parsed.map((p) => p[0]),
          ys: parsed.map((p) => p[1]),
          colour: expr.colour,
          radius: Math.max(2, expr.width + 1),
        });
        legend.push({ label: `${label} (${parsed.length})`, colour: expr.colour });
        break;
      }
    }
  });

  return { layers, legend, notes, errors };
}

/** Rasterises the region where `fn` is positive, as a translucent overlay. */
function buildMask(
  fn: (x: number, y: number) => number,
  view: SampleView,
  colour: string,
  resolution: number,
): { image: ImageData; x0: number; y0: number; x1: number; y1: number } | null {
  if (typeof document === 'undefined') return null;
  const nx = Math.max(32, Math.min(resolution, 400));
  const ny = Math.max(32, Math.min(Math.round((resolution * view.height) / view.width), 400));
  const image = new ImageData(nx, ny);
  const rgb = hexToRgb(colour);
  const dx = (view.xMax - view.xMin) / (nx - 1);
  const dy = (view.yMax - view.yMin) / (ny - 1);
  for (let j = 0; j < ny; j++) {
    // Row 0 of an ImageData is the top of the picture, which is yMax.
    const y = view.yMax - j * dy;
    for (let i = 0; i < nx; i++) {
      const v = fn(view.xMin + i * dx, y);
      const k = (j * nx + i) * 4;
      if (Number.isFinite(v) && v > 0) {
        image.data[k] = rgb[0];
        image.data[k + 1] = rgb[1];
        image.data[k + 2] = rgb[2];
        image.data[k + 3] = 255;
      }
    }
  }
  return { image, x0: view.xMin, y0: view.yMin, x1: view.xMax, y1: view.yMax };
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return [139, 124, 246];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** Reads "x,y" pairs separated by newlines or semicolons. */
export function parsePoints(source: string): [number, number][] {
  const out: [number, number][] = [];
  for (const chunk of source.split(/[;\n]+/)) {
    const parts = chunk.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

function defaultLabel(expr: ExpressionItem, index: number): string {
  const source = expr.source.length > 22 ? `${expr.source.slice(0, 21)}…` : expr.source;
  switch (expr.kind) {
    case 'parametric':
      return `(${source}, …)`;
    case 'polar':
      return `r = ${source}`;
    case 'implicit':
      return `${source} = 0`;
    case 'inequality':
      return `${source} > 0`;
    case 'points':
      return `points ${index + 1}`;
    default:
      return `y = ${source}`;
  }
}

function trim(v: number, digits = 6): string {
  if (!Number.isFinite(v)) return String(v);
  return String(Number(v.toPrecision(digits)));
}
