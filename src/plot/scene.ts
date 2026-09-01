/* The 2D plotting scene: a declarative description of what a plot contains,
 * and the renderer that paints it onto a canvas.
 *
 * Every mode in the app produces one of these and hands it to <Plot2D>. Keeping
 * the description declarative — rather than letting each mode draw into a
 * context directly — means panning, zooming, hit-testing, PNG export, high-DPI
 * handling and the crosshair readout are all written once and behave the same
 * everywhere.
 */

import type { Segment } from '../core/math/sampling';

export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type PointShape = 'circle' | 'square' | 'cross' | 'ring';

export type Layer =
  /** One or more polylines in world coordinates. */
  | { type: 'curve'; segments: Segment[]; colour: string; width?: number; style?: LineStyle; alpha?: number }
  /** A curve with the region between it and a baseline filled. */
  | { type: 'area'; segments: Segment[]; baseline: number; colour: string; alpha?: number }
  /** The region between two aligned curves — quantile bands, confidence bands. */
  | { type: 'band'; xs: ArrayLike<number>; lower: ArrayLike<number>; upper: ArrayLike<number>; colour: string; alpha?: number }
  | { type: 'polyline'; xs: ArrayLike<number>; ys: ArrayLike<number>; colour: string; width?: number; style?: LineStyle; alpha?: number; closed?: boolean; fill?: string }
  | { type: 'points'; xs: ArrayLike<number>; ys: ArrayLike<number>; colour: string; radius?: number; shape?: PointShape; alpha?: number; stroke?: string }
  /** Histogram or bar chart: `edges` has one more entry than `heights`. */
  | { type: 'bars'; edges: ArrayLike<number>; heights: ArrayLike<number>; colour: string; alpha?: number; stroke?: string; baseline?: number }
  /** Discrete probability mass: a stem with a dot on top. */
  | { type: 'stems'; xs: ArrayLike<number>; ys: ArrayLike<number>; colour: string; width?: number; radius?: number; alpha?: number }
  /** Flat quads of (x0,y0,x1,y1) — marching-squares output, nullclines, grids. */
  | { type: 'segments'; data: Float64Array; colour: string; width?: number; alpha?: number; style?: LineStyle }
  | { type: 'arrows'; arrows: { x: number; y: number; dx: number; dy: number; speed: number }[]; colour: string | ((speed: number) => string); width?: number; headSize?: number; alpha?: number }
  /** A pre-rendered raster placed in world coordinates (fractals, heatmaps). */
  | { type: 'image'; image: ImageData | HTMLCanvasElement; x0: number; y0: number; x1: number; y1: number; alpha?: number; smooth?: boolean }
  | { type: 'vline'; x: number; colour: string; style?: LineStyle; width?: number; label?: string; alpha?: number }
  | { type: 'hline'; y: number; colour: string; style?: LineStyle; width?: number; label?: string; alpha?: number }
  | { type: 'rect'; x0: number; y0: number; x1: number; y1: number; fill?: string; stroke?: string; alpha?: number; dash?: boolean }
  | { type: 'text'; x: number; y: number; text: string; colour: string; align?: CanvasTextAlign; baseline?: CanvasTextBaseline; size?: number; background?: string; bold?: boolean }
  /** A label anchored to a pixel offset from a world point — for callouts. */
  | { type: 'marker'; x: number; y: number; label: string; colour: string; radius?: number; offset?: [number, number] };

export interface PlotScene {
  viewport: Viewport;
  layers: Layer[];
  showGrid: boolean;
  showMinorGrid: boolean;
  showAxes: boolean;
  xLabel?: string;
  yLabel?: string;
  /** Overrides the default tick formatting, e.g. to show multiples of π. */
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  /** Tick positions supplied by the caller instead of being generated. */
  ticksX?: number[];
  ticksY?: number[];
  /** Draw the y axis as a log scale. Ticks and mapping change accordingly. */
  logY?: boolean;
  /** Legend entries drawn in the top-right corner. */
  legend?: { label: string; colour: string; dashed?: boolean }[];
  /** Extra text drawn unobtrusively in a corner. */
  caption?: string;
}

export interface Theme {
  background: string;
  panel: string;
  gridMinor: string;
  gridMajor: string;
  axis: string;
  axisText: string;
  label: string;
  crosshair: string;
  legendBackground: string;
  legendBorder: string;
}

export const DARK_THEME: Theme = {
  background: '#11141b',
  panel: '#171b24',
  gridMinor: 'rgba(148, 163, 184, 0.055)',
  gridMajor: 'rgba(148, 163, 184, 0.13)',
  axis: 'rgba(203, 213, 225, 0.55)',
  axisText: 'rgba(154, 163, 184, 0.95)',
  label: '#e6e9f2',
  crosshair: 'rgba(139, 124, 246, 0.75)',
  legendBackground: 'rgba(15, 18, 26, 0.86)',
  legendBorder: 'rgba(148, 163, 184, 0.22)',
};

// ------------------------------------------------------------------ ticks

/**
 * Chooses "nice" tick values: 1, 2, 2.5 or 5 times a power of ten.
 *
 * The 2.5 step is unusual but earns its place — without it the jump from a
 * 2-step to a 5-step doubles the label density in one zoom notch, which reads
 * as the axis stuttering while the user scrolls.
 */
export function niceTicks(min: number, max: number, target = 8): { major: number[]; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { major: [], step: 1 };
  const raw = (max - min) / Math.max(2, target);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalised = raw / magnitude;
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) * magnitude;
  const first = Math.ceil(min / step) * step;
  const major: number[] = [];
  for (let v = first; v <= max + step * 1e-9; v += step) {
    // Re-round each value: accumulating `+= step` drifts and produces labels
    // like 0.30000000000000004 after a dozen additions.
    major.push(Math.round(v / step) * step);
  }
  return { major, step };
}

/** Powers of ten (plus 2× and 5× when the range is narrow) for a log axis. */
export function logTicks(min: number, max: number): number[] {
  const lo = Math.max(min, 1e-12);
  const out: number[] = [];
  const startExp = Math.floor(Math.log10(lo));
  const endExp = Math.ceil(Math.log10(max));
  const decades = endExp - startExp;
  for (let e = startExp; e <= endExp; e++) {
    const base = Math.pow(10, e);
    out.push(base);
    if (decades <= 3) out.push(2 * base, 5 * base);
  }
  return out.filter((v) => v >= min && v <= max).sort((a, b) => a - b);
}

/** Formats an axis value with the precision the tick spacing warrants. */
export function formatTick(v: number, step: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-4) {
    return v.toExponential(1).replace('e+', 'e').replace(/\.0e/, 'e');
  }
  const decimals = decimalsFor(step);
  const text = v.toFixed(decimals);
  // Trailing zeros are only ever noise *after* a decimal point. Stripping them
  // unconditionally turns 10 into 1, which is the kind of bug that survives
  // every unit test and is obvious the moment you look at an axis.
  return decimals > 0 ? text.replace(/\.?0+$/, '') || '0' : text;
}

/**
 * How many decimal places a tick step needs to render exactly.
 *
 * Deriving this from log10(step) is the obvious approach and it is wrong for
 * the 2.5-family of steps: log10(0.25) rounds to one decimal, so a 0.25 step
 * would label its ticks 0.3, 0.5, 0.8, 1.0. Asking instead for the shortest
 * representation that reproduces the step gets every family right.
 */
function decimalsFor(step: number): number {
  const abs = Math.abs(step);
  if (!Number.isFinite(abs) || abs === 0) return 0;
  for (let d = 0; d <= 8; d++) {
    if (Math.abs(Number(abs.toFixed(d)) - abs) <= abs * 1e-10) return d;
  }
  return 8;
}

/** Formats as a multiple of π, for trigonometric axes. */
export function formatPi(v: number, step: number): string {
  const k = v / Math.PI;
  if (Math.abs(k) < 1e-9) return '0';
  const rounded = Math.round(k * 12) / 12;
  if (Math.abs(k - rounded) > 1e-6) return formatTick(v, step);
  const sign = rounded < 0 ? '−' : '';
  const a = Math.abs(rounded);
  const denominators = [1, 2, 3, 4, 6, 12];
  for (const d of denominators) {
    const n = a * d;
    if (Math.abs(n - Math.round(n)) < 1e-9) {
      const num = Math.round(n);
      if (d === 1) return `${sign}${num === 1 ? '' : num}π`;
      return `${sign}${num === 1 ? '' : num}π/${d}`;
    }
  }
  return formatTick(v, step);
}

// ------------------------------------------------------------------ transform

export interface PlotBox {
  /** Pixel offsets of the plotting area inside the canvas. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export class Transform {
  readonly sx: number;
  readonly sy: number;

  constructor(
    readonly view: Viewport,
    readonly box: PlotBox,
    readonly logY = false,
  ) {
    this.sx = box.width / (view.xMax - view.xMin || 1);
    this.sy = box.height / (this.tY(view.yMax) - this.tY(view.yMin) || 1);
  }

  /** Applies the y-axis scale transform (identity, or log10). */
  private tY(y: number): number {
    return this.logY ? Math.log10(Math.max(y, 1e-12)) : y;
  }

  private tYInv(y: number): number {
    return this.logY ? Math.pow(10, y) : y;
  }

  px(x: number): number {
    return this.box.left + (x - this.view.xMin) * this.sx;
  }

  py(y: number): number {
    return this.box.top + (this.tY(this.view.yMax) - this.tY(y)) * this.sy;
  }

  x(px: number): number {
    return this.view.xMin + (px - this.box.left) / this.sx;
  }

  y(py: number): number {
    return this.tYInv(this.tY(this.view.yMax) - (py - this.box.top) / this.sy);
  }

  /** Pixels per world unit on the x axis — used to size hit tolerances. */
  get scaleX(): number {
    return this.sx;
  }

  get scaleY(): number {
    return this.sy;
  }
}

// ------------------------------------------------------------------ rendering

const AXIS_FONT = '11px -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif';
const LABEL_FONT = '12px -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif';

function applyDash(ctx: CanvasRenderingContext2D, style: LineStyle | undefined, width: number): void {
  switch (style) {
    case 'dashed':
      ctx.setLineDash([width * 3.2, width * 2.4]);
      break;
    case 'dotted':
      ctx.setLineDash([width * 0.1, width * 2.2]);
      ctx.lineCap = 'round';
      break;
    default:
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';
  }
}

/** Measures the gutters the axis labels need, so the plot area can be inset. */
export function measureGutters(
  ctx: CanvasRenderingContext2D,
  scene: PlotScene,
  width: number,
  height: number,
): PlotBox {
  ctx.font = AXIS_FONT;
  const yTicks = scene.ticksY ?? (scene.logY ? logTicks(scene.viewport.yMin, scene.viewport.yMax) : niceTicks(scene.viewport.yMin, scene.viewport.yMax, Math.max(3, Math.round(height / 64))).major);
  const stepY = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;
  let widest = 0;
  for (const t of yTicks) {
    const label = scene.formatY ? scene.formatY(t) : formatTick(t, stepY);
    widest = Math.max(widest, ctx.measureText(label).width);
  }
  const left = Math.min(96, Math.max(38, widest + 14)) + (scene.yLabel ? 16 : 0);
  const bottom = 30 + (scene.xLabel ? 16 : 0);
  return { left, top: 12, width: Math.max(10, width - left - 16), height: Math.max(10, height - bottom - 12) };
}

/** Paints the whole scene. `ctx` must already be scaled for device pixels. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: PlotScene,
  width: number,
  height: number,
  theme: Theme = DARK_THEME,
): Transform {
  ctx.save();
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const box = measureGutters(ctx, scene, width, height);
  const tr = new Transform(scene.viewport, box, scene.logY ?? false);

  drawGrid(ctx, scene, tr, theme);

  // Everything data-related is clipped to the plot area: a curve running off
  // the top must not paint over the axis labels.
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.left, box.top, box.width, box.height);
  ctx.clip();
  for (const layer of scene.layers) drawLayer(ctx, layer, tr, theme);
  ctx.restore();

  drawAxes(ctx, scene, tr, theme);
  if (scene.legend?.length) drawLegend(ctx, scene.legend, tr, theme);
  if (scene.caption) {
    ctx.font = AXIS_FONT;
    ctx.fillStyle = theme.axisText;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(scene.caption, box.left + 8, box.top + box.height - 6);
  }

  ctx.restore();
  return tr;
}

function drawGrid(ctx: CanvasRenderingContext2D, scene: PlotScene, tr: Transform, theme: Theme): void {
  const { box, view } = tr;
  const xTicks = scene.ticksX ?? niceTicks(view.xMin, view.xMax, Math.max(3, Math.round(box.width / 90))).major;
  const yTicks =
    scene.ticksY ??
    (scene.logY
      ? logTicks(view.yMin, view.yMax)
      : niceTicks(view.yMin, view.yMax, Math.max(3, Math.round(box.height / 64))).major);

  if (scene.showMinorGrid && !scene.logY) {
    // Minor lines subdivide each major interval into five, which is the
    // convention on graph paper and reads as "half a square" at a glance.
    ctx.strokeStyle = theme.gridMinor;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    const stepX = xTicks.length > 1 ? (xTicks[1] - xTicks[0]) / 5 : 0;
    if (stepX > 0 && (stepX * tr.sx) > 6) {
      for (let v = Math.ceil(view.xMin / stepX) * stepX; v <= view.xMax; v += stepX) {
        const px = Math.round(tr.px(v)) + 0.5;
        ctx.moveTo(px, box.top);
        ctx.lineTo(px, box.top + box.height);
      }
    }
    const stepY = yTicks.length > 1 ? (yTicks[1] - yTicks[0]) / 5 : 0;
    if (stepY > 0 && stepY * tr.sy > 6) {
      for (let v = Math.ceil(view.yMin / stepY) * stepY; v <= view.yMax; v += stepY) {
        const py = Math.round(tr.py(v)) + 0.5;
        ctx.moveTo(box.left, py);
        ctx.lineTo(box.left + box.width, py);
      }
    }
    ctx.stroke();
  }

  if (scene.showGrid) {
    ctx.strokeStyle = theme.gridMajor;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const v of xTicks) {
      const px = Math.round(tr.px(v)) + 0.5;
      ctx.moveTo(px, box.top);
      ctx.lineTo(px, box.top + box.height);
    }
    for (const v of yTicks) {
      const py = Math.round(tr.py(v)) + 0.5;
      ctx.moveTo(box.left, py);
      ctx.lineTo(box.left + box.width, py);
    }
    ctx.stroke();
  }
}

function drawAxes(ctx: CanvasRenderingContext2D, scene: PlotScene, tr: Transform, theme: Theme): void {
  const { box, view } = tr;
  const xTicksInfo = niceTicks(view.xMin, view.xMax, Math.max(3, Math.round(box.width / 90)));
  const xTicks = scene.ticksX ?? xTicksInfo.major;
  const yTicksInfo = niceTicks(view.yMin, view.yMax, Math.max(3, Math.round(box.height / 64)));
  const yTicks = scene.ticksY ?? (scene.logY ? logTicks(view.yMin, view.yMax) : yTicksInfo.major);

  ctx.font = AXIS_FONT;
  ctx.fillStyle = theme.axisText;
  ctx.setLineDash([]);

  // Tick labels sit outside the plot box, against the gutter.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of xTicks) {
    const px = tr.px(v);
    if (px < box.left - 1 || px > box.left + box.width + 1) continue;
    const label = scene.formatX ? scene.formatX(v) : formatTick(v, xTicksInfo.step);
    ctx.fillText(label, px, box.top + box.height + 7);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yTicks) {
    const py = tr.py(v);
    if (py < box.top - 1 || py > box.top + box.height + 1) continue;
    const label = scene.formatY ? scene.formatY(v) : scene.logY ? formatLog(v) : formatTick(v, yTicksInfo.step);
    ctx.fillText(label, box.left - 8, py);
  }

  if (scene.showAxes) {
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    if (view.yMin <= 0 && view.yMax >= 0 && !scene.logY) {
      const py = Math.round(tr.py(0)) + 0.5;
      ctx.moveTo(box.left, py);
      ctx.lineTo(box.left + box.width, py);
    }
    if (view.xMin <= 0 && view.xMax >= 0) {
      const px = Math.round(tr.px(0)) + 0.5;
      ctx.moveTo(px, box.top);
      ctx.lineTo(px, box.top + box.height);
    }
    ctx.stroke();
  }

  // A hairline frame keeps the plot area legible when the axes are off screen.
  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(box.left + 0.5, box.top + 0.5, box.width - 1, box.height - 1);

  ctx.fillStyle = theme.axisText;
  ctx.font = LABEL_FONT;
  if (scene.xLabel) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(scene.xLabel, box.left + box.width / 2, box.top + box.height + 40);
  }
  if (scene.yLabel) {
    ctx.save();
    ctx.translate(12, box.top + box.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(scene.yLabel, 0, 0);
    ctx.restore();
  }
}

function formatLog(v: number): string {
  const e = Math.log10(v);
  if (Math.abs(e - Math.round(e)) < 1e-9) {
    const r = Math.round(e);
    if (r >= -3 && r <= 5) return String(Math.pow(10, r));
    return `1e${r}`;
  }
  return formatTick(v, v / 4);
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  entries: { label: string; colour: string; dashed?: boolean }[],
  tr: Transform,
  theme: Theme,
): void {
  ctx.save();
  ctx.font = AXIS_FONT;
  const padding = 8;
  const lineHeight = 16;
  const swatch = 16;
  const widest = Math.max(...entries.map((e) => ctx.measureText(e.label).width));
  const w = widest + swatch + padding * 3;
  const h = entries.length * lineHeight + padding * 2 - 4;
  const x = tr.box.left + tr.box.width - w - 10;
  const y = tr.box.top + 10;

  ctx.fillStyle = theme.legendBackground;
  ctx.strokeStyle = theme.legendBorder;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();

  entries.forEach((e, i) => {
    const cy = y + padding + i * lineHeight + 5;
    ctx.strokeStyle = e.colour;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(e.dashed ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x + padding, cy);
    ctx.lineTo(x + padding + swatch, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = theme.label;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(e.label, x + padding * 2 + swatch, cy);
  });
  ctx.restore();
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawLayer(ctx: CanvasRenderingContext2D, layer: Layer, tr: Transform, theme: Theme): void {
  ctx.globalAlpha = ('alpha' in layer && layer.alpha !== undefined ? layer.alpha : 1) as number;
  switch (layer.type) {
    case 'curve': {
      const width = layer.width ?? 2;
      ctx.strokeStyle = layer.colour;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      applyDash(ctx, layer.style, width);
      for (const seg of layer.segments) {
        if (seg.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(tr.px(seg.xs[0]), tr.py(seg.ys[0]));
        for (let i = 1; i < seg.length; i++) ctx.lineTo(tr.px(seg.xs[i]), tr.py(seg.ys[i]));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      break;
    }

    case 'area': {
      ctx.fillStyle = layer.colour;
      const baseY = tr.py(layer.baseline);
      for (const seg of layer.segments) {
        if (seg.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(tr.px(seg.xs[0]), baseY);
        for (let i = 0; i < seg.length; i++) ctx.lineTo(tr.px(seg.xs[i]), tr.py(seg.ys[i]));
        ctx.lineTo(tr.px(seg.xs[seg.length - 1]), baseY);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }

    case 'band': {
      const n = Math.min(layer.xs.length, layer.lower.length, layer.upper.length);
      if (n < 2) break;
      ctx.fillStyle = layer.colour;
      ctx.beginPath();
      ctx.moveTo(tr.px(layer.xs[0]), tr.py(layer.upper[0]));
      for (let i = 1; i < n; i++) ctx.lineTo(tr.px(layer.xs[i]), tr.py(layer.upper[i]));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(tr.px(layer.xs[i]), tr.py(layer.lower[i]));
      ctx.closePath();
      ctx.fill();
      break;
    }

    case 'polyline': {
      const n = Math.min(layer.xs.length, layer.ys.length);
      if (n < 2) break;
      ctx.beginPath();
      ctx.moveTo(tr.px(layer.xs[0]), tr.py(layer.ys[0]));
      for (let i = 1; i < n; i++) ctx.lineTo(tr.px(layer.xs[i]), tr.py(layer.ys[i]));
      if (layer.closed) ctx.closePath();
      if (layer.fill) {
        ctx.fillStyle = layer.fill;
        ctx.fill();
      }
      const width = layer.width ?? 2;
      ctx.strokeStyle = layer.colour;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      applyDash(ctx, layer.style, width);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }

    case 'points': {
      const r = layer.radius ?? 3;
      const n = Math.min(layer.xs.length, layer.ys.length);
      ctx.fillStyle = layer.colour;
      ctx.strokeStyle = layer.stroke ?? layer.colour;
      ctx.lineWidth = 1.5;
      const shape = layer.shape ?? 'circle';
      for (let i = 0; i < n; i++) {
        const x = tr.px(layer.xs[i]);
        const y = tr.py(layer.ys[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        switch (shape) {
          case 'circle':
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
            break;
          case 'ring':
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            break;
          case 'square':
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
            break;
          case 'cross':
            ctx.beginPath();
            ctx.moveTo(x - r, y - r);
            ctx.lineTo(x + r, y + r);
            ctx.moveTo(x + r, y - r);
            ctx.lineTo(x - r, y + r);
            ctx.stroke();
            break;
        }
      }
      break;
    }

    case 'bars': {
      const baseline = layer.baseline ?? 0;
      const baseY = tr.py(baseline);
      ctx.fillStyle = layer.colour;
      for (let i = 0; i < layer.heights.length; i++) {
        const x0 = tr.px(layer.edges[i]);
        const x1 = tr.px(layer.edges[i + 1]);
        const y = tr.py(layer.heights[i]);
        // A one-pixel inset stops adjacent bars merging into a solid block,
        // but only when the bars are wide enough for it to be visible.
        const inset = x1 - x0 > 4 ? 0.5 : 0;
        ctx.fillRect(x0 + inset, Math.min(y, baseY), Math.max(0.5, x1 - x0 - inset * 2), Math.abs(baseY - y));
      }
      if (layer.stroke) {
        ctx.strokeStyle = layer.stroke;
        ctx.lineWidth = 1;
        for (let i = 0; i < layer.heights.length; i++) {
          const x0 = tr.px(layer.edges[i]);
          const x1 = tr.px(layer.edges[i + 1]);
          const y = tr.py(layer.heights[i]);
          if (x1 - x0 < 3) continue;
          ctx.strokeRect(x0 + 0.5, Math.min(y, baseY) + 0.5, x1 - x0 - 1, Math.abs(baseY - y) - 1);
        }
      }
      break;
    }

    case 'stems': {
      const r = layer.radius ?? 3.2;
      const baseY = tr.py(0);
      ctx.strokeStyle = layer.colour;
      ctx.fillStyle = layer.colour;
      ctx.lineWidth = layer.width ?? 1.75;
      const n = Math.min(layer.xs.length, layer.ys.length);
      for (let i = 0; i < n; i++) {
        const x = tr.px(layer.xs[i]);
        const y = tr.py(layer.ys[i]);
        ctx.beginPath();
        ctx.moveTo(x, baseY);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    case 'segments': {
      ctx.strokeStyle = layer.colour;
      ctx.lineWidth = layer.width ?? 1.5;
      applyDash(ctx, layer.style, layer.width ?? 1.5);
      ctx.beginPath();
      for (let i = 0; i + 3 < layer.data.length; i += 4) {
        ctx.moveTo(tr.px(layer.data[i]), tr.py(layer.data[i + 1]));
        ctx.lineTo(tr.px(layer.data[i + 2]), tr.py(layer.data[i + 3]));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }

    case 'arrows': {
      const head = layer.headSize ?? 5;
      ctx.lineWidth = layer.width ?? 1.4;
      const constant = typeof layer.colour === 'string' ? layer.colour : null;
      if (constant) ctx.strokeStyle = constant;
      for (const a of layer.arrows) {
        if (!constant) ctx.strokeStyle = (layer.colour as (s: number) => string)(a.speed);
        const x0 = tr.px(a.x - a.dx / 2);
        const y0 = tr.py(a.y - a.dy / 2);
        const x1 = tr.px(a.x + a.dx / 2);
        const y1 = tr.py(a.y + a.dy / 2);
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 0.6) continue;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        // The head is drawn only when the shaft is long enough to carry one;
        // below that it becomes a blob and the field looks like noise.
        if (len > head * 1.35) {
          const ux = (x1 - x0) / len;
          const uy = (y1 - y0) / len;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
          ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
          ctx.closePath();
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fill();
        }
      }
      break;
    }

    case 'image': {
      const x0 = tr.px(layer.x0);
      const y0 = tr.py(layer.y1);
      const x1 = tr.px(layer.x1);
      const y1 = tr.py(layer.y0);
      const source =
        layer.image instanceof ImageData ? imageDataToCanvas(layer.image) : layer.image;
      ctx.imageSmoothingEnabled = layer.smooth ?? true;
      ctx.drawImage(source, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      ctx.imageSmoothingEnabled = true;
      break;
    }

    case 'vline': {
      const px = tr.px(layer.x);
      ctx.strokeStyle = layer.colour;
      ctx.lineWidth = layer.width ?? 1.5;
      applyDash(ctx, layer.style ?? 'dashed', layer.width ?? 1.5);
      ctx.beginPath();
      ctx.moveTo(px, tr.box.top);
      ctx.lineTo(px, tr.box.top + tr.box.height);
      ctx.stroke();
      ctx.setLineDash([]);
      if (layer.label) {
        ctx.font = AXIS_FONT;
        ctx.fillStyle = layer.colour;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(layer.label, px + 5, tr.box.top + 4);
      }
      break;
    }

    case 'hline': {
      const py = tr.py(layer.y);
      ctx.strokeStyle = layer.colour;
      ctx.lineWidth = layer.width ?? 1.5;
      applyDash(ctx, layer.style ?? 'dashed', layer.width ?? 1.5);
      ctx.beginPath();
      ctx.moveTo(tr.box.left, py);
      ctx.lineTo(tr.box.left + tr.box.width, py);
      ctx.stroke();
      ctx.setLineDash([]);
      if (layer.label) {
        ctx.font = AXIS_FONT;
        ctx.fillStyle = layer.colour;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(layer.label, tr.box.left + tr.box.width - 6, py - 4);
      }
      break;
    }

    case 'rect': {
      const x0 = tr.px(Math.min(layer.x0, layer.x1));
      const x1 = tr.px(Math.max(layer.x0, layer.x1));
      const y0 = tr.py(Math.max(layer.y0, layer.y1));
      const y1 = tr.py(Math.min(layer.y0, layer.y1));
      if (layer.fill) {
        ctx.fillStyle = layer.fill;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      if (layer.stroke) {
        ctx.strokeStyle = layer.stroke;
        ctx.lineWidth = 1.5;
        if (layer.dash) ctx.setLineDash([5, 4]);
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
        ctx.setLineDash([]);
      }
      break;
    }

    case 'text': {
      const size = layer.size ?? 12;
      ctx.font = `${layer.bold ? '600 ' : ''}${size}px -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif`;
      ctx.textAlign = layer.align ?? 'left';
      ctx.textBaseline = layer.baseline ?? 'alphabetic';
      const x = tr.px(layer.x);
      const y = tr.py(layer.y);
      if (layer.background) {
        const m = ctx.measureText(layer.text);
        const pad = 4;
        const w = m.width + pad * 2;
        const h = size + pad * 2;
        const bx = layer.align === 'right' ? x - w + pad : layer.align === 'center' ? x - w / 2 : x - pad;
        ctx.fillStyle = layer.background;
        roundRect(ctx, bx, y - h + pad + 2, w, h, 4);
        ctx.fill();
      }
      ctx.fillStyle = layer.colour;
      ctx.fillText(layer.text, x, y);
      break;
    }

    case 'marker': {
      const x = tr.px(layer.x);
      const y = tr.py(layer.y);
      const r = layer.radius ?? 4;
      ctx.fillStyle = layer.colour;
      ctx.strokeStyle = theme.background;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (layer.label) {
        const [ox, oy] = layer.offset ?? [8, -8];
        ctx.font = AXIS_FONT;
        ctx.textAlign = ox < 0 ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        const m = ctx.measureText(layer.label);
        ctx.fillStyle = theme.legendBackground;
        roundRect(ctx, x + ox - (ox < 0 ? m.width + 5 : 3), y + oy - 9, m.width + 8, 18, 4);
        ctx.fill();
        ctx.fillStyle = theme.label;
        ctx.fillText(layer.label, x + ox, y + oy);
      }
      break;
    }
  }
  ctx.globalAlpha = 1;
}

const canvasCache = new WeakMap<ImageData, HTMLCanvasElement>();

/**
 * ImageData cannot be drawn with drawImage, and putImageData ignores the
 * canvas transform, so raster layers go through an offscreen canvas.
 *
 * The canvas is cached per ImageData, but the pixels are copied across every
 * time. Callers — the fractal and bifurcation renderers — fill one buffer
 * progressively and repaint after each slice, so caching the *contents* as
 * well would freeze the picture at whatever the first paint happened to catch.
 * Caching only the canvas still avoids an allocation per frame, which is the
 * part that actually matters.
 */
function imageDataToCanvas(data: ImageData): HTMLCanvasElement {
  let canvas = canvasCache.get(data);
  if (!canvas || canvas.width !== data.width || canvas.height !== data.height) {
    canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    canvasCache.set(data, canvas);
  }
  canvas.getContext('2d')!.putImageData(data, 0, 0);
  return canvas;
}

/** Colours a value in [0,1] with a perceptually even diverging ramp. */
export function divergingColour(t: number): string {
  const u = Math.max(0, Math.min(1, t));
  // Blue → slate → amber, matching the app's accent family rather than the
  // usual red/blue, which clashes with the series palette.
  const stops: [number, number, number][] = [
    [56, 132, 232],
    [88, 132, 190],
    [120, 128, 150],
    [200, 150, 90],
    [251, 191, 36],
  ];
  const scaled = u * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/** Colours a value in [0,1] with a sequential ramp for magnitudes. */
export function sequentialColour(t: number): string {
  const u = Math.max(0, Math.min(1, t));
  const stops: [number, number, number][] = [
    [22, 27, 40],
    [46, 62, 118],
    [82, 106, 200],
    [139, 124, 246],
    [196, 181, 253],
  ];
  const scaled = u * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/** Adds an alpha channel to a hex colour, for fills derived from a series colour. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}
