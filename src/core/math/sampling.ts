/* Turning a function into a polyline.
 *
 * Uniform sampling is the obvious approach and it is wrong in both directions:
 * it wastes points on the flat parts of a curve and still misses the corner of
 * a cusp. It also cannot tell the difference between a very steep segment and a
 * vertical asymptote, so tan(x) comes out joined across its poles.
 *
 * What follows samples in *screen* space — the only space in which "this curve
 * looks smooth" is a meaningful statement — refines where the polyline visibly
 * bends, and cuts the line into separate segments at genuine discontinuities.
 */

export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  width: number;
  height: number;
}

export interface Segment {
  xs: Float64Array;
  ys: Float64Array;
  length: number;
}

export interface SampleOptions {
  /** Base samples per pixel before refinement. */
  density?: number;
  /** Maximum bisection depth per interval. */
  maxDepth?: number;
  /** Bend, in screen radians, above which an interval is refined. */
  angleTolerance?: number;
  /** Hard cap on total points, so a pathological function cannot hang the UI. */
  maxPoints?: number;
}

const DEFAULTS: Required<SampleOptions> = {
  density: 1,
  maxDepth: 8,
  angleTolerance: 0.06,
  maxPoints: 60000,
};

/**
 * Samples `f` across the viewport's x range, returning one or more polyline
 * segments. A new segment begins wherever the function is undefined or jumps.
 */
export function sampleFunction(f: (x: number) => number, view: Viewport, options: SampleOptions = {}): Segment[] {
  const opt = { ...DEFAULTS, ...options };
  const { xMin, xMax, yMin, yMax, width, height } = view;
  const spanX = xMax - xMin;
  const spanY = yMax - yMin || 1;
  const sx = width / spanX;
  const sy = height / spanY;

  const base = Math.max(64, Math.min(Math.round(width * opt.density), 4096));
  const dx = spanX / base;

  const px: number[] = [];
  const py: number[] = [];
  let count = 0;

  // Screen-space coordinates; comparisons below are all in pixels, which is
  // what makes one tolerance work at every zoom level.
  const toPx = (x: number) => (x - xMin) * sx;
  const toPy = (y: number) => (yMax - y) * sy;

  /**
   * True when two consecutive values cannot plausibly be joined by a line.
   *
   * Distinguishing a pole from a merely steep segment is the hard part of
   * plotting, and no single test does it: comparing the midpoint against the
   * endpoints fails when one sample happens to land within 1e-4 of the
   * asymptote, and a pure magnitude threshold rejects perfectly good steep
   * lines. So the interval is probed at three interior points and three
   * independent signatures are checked against them.
   */
  const isBreak = (x0: number, y0: number, x1: number, y1: number): boolean => {
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return true;
    const dyPx = Math.abs(toPy(y1) - toPy(y0));
    // Anything spanning less than one screen height is drawable as a line.
    if (dyPx < height) return false;

    const p1 = f(x0 + 0.25 * (x1 - x0));
    const p2 = f(0.5 * (x0 + x1));
    const p3 = f(x0 + 0.75 * (x1 - x0));
    if (!Number.isFinite(p1) || !Number.isFinite(p2) || !Number.isFinite(p3)) return true;

    const endMag = Math.max(Math.abs(y0), Math.abs(y1));
    const interiorMag = Math.max(Math.abs(p1), Math.abs(p2), Math.abs(p3));
    // (a) The function runs away between the samples: an asymptote sitting
    //     between two points that both happened to land at modest values.
    if (interiorMag > 8 * endMag) return true;

    // (b) A sign change where nothing involved is anywhere near the screen.
    //     A steep line crossing zero passes through small values; a pole does
    //     not, because it goes out one side and comes back from the other.
    const signChange = y0 > 0 !== y1 > 0;
    const minMag = Math.min(Math.abs(y0), Math.abs(p1), Math.abs(p2), Math.abs(p3), Math.abs(y1));
    if (signChange && minMag > 4 * spanY) return true;

    // (c) A step: every interior probe sits on one of the two levels rather
    //     than in between, which is what a jump discontinuity looks like and a
    //     continuous ramp never does.
    if (dyPx > 2 * height) {
      const jump = Math.abs(y1 - y0);
      const onALevel = (v: number) =>
        Math.abs(v - y0) < 0.01 * jump || Math.abs(v - y1) < 0.01 * jump;
      if (onALevel(p1) && onALevel(p2) && onALevel(p3)) return true;
    }
    return false;
  };

  const push = (x: number, y: number) => {
    px.push(x);
    py.push(y);
    count++;
  };

  const segments: Segment[] = [];
  const flush = () => {
    if (px.length >= 2) {
      segments.push({ xs: Float64Array.from(px), ys: Float64Array.from(py), length: px.length });
    }
    px.length = 0;
    py.length = 0;
  };

  /** Recursively bisect [x0,x1] while the polyline visibly bends there. */
  const refine = (x0: number, y0: number, x1: number, y1: number, depth: number) => {
    if (depth >= opt.maxDepth || count > opt.maxPoints) return;
    const xm = 0.5 * (x0 + x1);
    const ym = f(xm);
    if (!Number.isFinite(ym)) return;
    const ax = toPx(x0) - toPx(xm);
    const ay = toPy(y0) - toPy(ym);
    const bx = toPx(x1) - toPx(xm);
    const by = toPy(y1) - toPy(ym);
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 0.35 && lb < 0.35) return; // already inside a pixel; nothing to gain
    // The angle at the middle vertex: π means perfectly straight. Deviation
    // from π is exactly the visible kink we are trying to remove.
    const cos = (ax * bx + ay * by) / (la * lb || 1);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (Math.PI - angle < opt.angleTolerance) return;
    refine(x0, y0, xm, ym, depth + 1);
    push(xm, ym);
    refine(xm, ym, x1, y1, depth + 1);
  };

  let xPrev = xMin;
  let yPrev = f(xMin);
  if (Number.isFinite(yPrev)) push(xPrev, yPrev);

  for (let i = 1; i <= base; i++) {
    const x = i === base ? xMax : xMin + i * dx;
    const y = f(x);
    if (isBreak(xPrev, yPrev, x, y)) {
      // Walk a little way into the gap from both sides so the curve visibly
      // runs off the top of the plot instead of stopping short of it.
      if (Number.isFinite(yPrev)) approachEdge(f, xPrev, x, 1, push, yMin, yMax);
      flush();
      if (Number.isFinite(y)) {
        approachEdge(f, x, xPrev, -1, push, yMin, yMax);
        push(x, y);
      }
    } else {
      refine(xPrev, yPrev, x, y, 0);
      push(x, y);
    }
    xPrev = x;
    yPrev = y;
    if (count > opt.maxPoints) break;
  }
  flush();
  return segments;
}

/**
 * Bisects towards a discontinuity from one side, emitting the few points that
 * carry the curve off the edge of the viewport. `dir` is +1 when `from` is the
 * defined side and `to` the undefined one.
 */
function approachEdge(
  f: (x: number) => number,
  from: number,
  to: number,
  dir: 1 | -1,
  push: (x: number, y: number) => void,
  yMin: number,
  yMax: number,
): void {
  let lo = from;
  let hi = to;
  const emitted: [number, number][] = [];
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    const y = f(mid);
    if (Number.isFinite(y)) {
      lo = mid;
      // Only points that are still on screen (or just off it) are worth having;
      // beyond that the line is clipped anyway.
      if (y > yMin - (yMax - yMin) && y < yMax + (yMax - yMin)) emitted.push([mid, y]);
      if (y < yMin - 4 * (yMax - yMin) || y > yMax + 4 * (yMax - yMin)) break;
    } else {
      hi = mid;
    }
  }
  if (dir === 1) for (const [x, y] of emitted) push(x, y);
  else for (let i = emitted.length - 1; i >= 0; i--) push(emitted[i][0], emitted[i][1]);
}

/** Samples a parametric curve (x(t), y(t)) with the same screen-space criterion. */
export function sampleParametric(
  fx: (t: number) => number,
  fy: (t: number) => number,
  tMin: number,
  tMax: number,
  view: Viewport,
  options: SampleOptions = {},
): Segment[] {
  const opt = { ...DEFAULTS, ...options, maxDepth: options.maxDepth ?? 9 };
  const sx = view.width / (view.xMax - view.xMin);
  const sy = view.height / (view.yMax - view.yMin || 1);
  const base = Math.max(200, Math.min(Math.round(view.width * 1.5), 3000));
  const dt = (tMax - tMin) / base;
  const px: number[] = [];
  const py: number[] = [];
  const segments: Segment[] = [];
  let count = 0;

  const flush = () => {
    if (px.length >= 2) segments.push({ xs: Float64Array.from(px), ys: Float64Array.from(py), length: px.length });
    px.length = 0;
    py.length = 0;
  };
  const push = (x: number, y: number) => {
    px.push(x);
    py.push(y);
    count++;
  };

  const refine = (t0: number, x0: number, y0: number, t1: number, x1: number, y1: number, depth: number) => {
    if (depth >= opt.maxDepth || count > opt.maxPoints) return;
    const tm = 0.5 * (t0 + t1);
    const xm = fx(tm);
    const ym = fy(tm);
    if (!Number.isFinite(xm) || !Number.isFinite(ym)) return;
    const ax = (x0 - xm) * sx;
    const ay = (y0 - ym) * sy;
    const bx = (x1 - xm) * sx;
    const by = (y1 - ym) * sy;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 0.4 && lb < 0.4) return;
    const cos = (ax * bx + ay * by) / (la * lb || 1);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (Math.PI - angle < opt.angleTolerance) return;
    refine(t0, x0, y0, tm, xm, ym, depth + 1);
    push(xm, ym);
    refine(tm, xm, ym, t1, x1, y1, depth + 1);
  };

  let tPrev = tMin;
  let xPrev = fx(tMin);
  let yPrev = fy(tMin);
  if (Number.isFinite(xPrev) && Number.isFinite(yPrev)) push(xPrev, yPrev);
  for (let i = 1; i <= base; i++) {
    const t = tMin + i * dt;
    const x = fx(t);
    const y = fy(t);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      flush();
    } else {
      if (Number.isFinite(xPrev) && Number.isFinite(yPrev)) refine(tPrev, xPrev, yPrev, t, x, y, 0);
      push(x, y);
    }
    tPrev = t;
    xPrev = x;
    yPrev = y;
    if (count > opt.maxPoints) break;
  }
  flush();
  return segments;
}

/**
 * Marching squares over a scalar field, used for implicit curves f(x,y)=0 and
 * for contour lines. Returns line segments in world coordinates.
 *
 * The grid resolution is capped rather than tied to the window size: implicit
 * plotting is O(n²) in evaluations and a 4K window would otherwise ask for
 * eight million function calls per frame.
 */
export function marchingSquares(
  f: (x: number, y: number) => number,
  view: Viewport,
  level = 0,
  resolution = 220,
): Float64Array {
  const nx = Math.min(resolution, 400);
  const ny = Math.min(Math.round((resolution * view.height) / view.width) || resolution, 400);
  const dx = (view.xMax - view.xMin) / nx;
  const dy = (view.yMax - view.yMin) / ny;

  // One row of values is reused between iterations; evaluating the field twice
  // per cell instead of four times halves the cost of the whole routine.
  let rowBelow = new Float64Array(nx + 1);
  let rowAbove = new Float64Array(nx + 1);
  for (let i = 0; i <= nx; i++) rowBelow[i] = f(view.xMin + i * dx, view.yMin) - level;

  const out: number[] = [];
  const interp = (a: number, b: number, va: number, vb: number) => a + ((b - a) * (0 - va)) / (vb - va);

  for (let j = 0; j < ny; j++) {
    const y0 = view.yMin + j * dy;
    const y1 = y0 + dy;
    for (let i = 0; i <= nx; i++) rowAbove[i] = f(view.xMin + i * dx, y1) - level;

    for (let i = 0; i < nx; i++) {
      const x0 = view.xMin + i * dx;
      const x1 = x0 + dx;
      const v00 = rowBelow[i];
      const v10 = rowBelow[i + 1];
      const v01 = rowAbove[i];
      const v11 = rowAbove[i + 1];
      if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) continue;

      const code = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;

      const bottom = (): [number, number] => [interp(x0, x1, v00, v10), y0];
      const right = (): [number, number] => [x1, interp(y0, y1, v10, v11)];
      const top = (): [number, number] => [interp(x0, x1, v01, v11), y1];
      const left = (): [number, number] => [x0, interp(y0, y1, v00, v01)];

      const emit = (a: [number, number], b: [number, number]) => out.push(a[0], a[1], b[0], b[1]);

      switch (code) {
        case 1:
        case 14:
          emit(left(), bottom());
          break;
        case 2:
        case 13:
          emit(bottom(), right());
          break;
        case 3:
        case 12:
          emit(left(), right());
          break;
        case 4:
        case 11:
          emit(right(), top());
          break;
        case 6:
        case 9:
          emit(bottom(), top());
          break;
        case 7:
        case 8:
          emit(left(), top());
          break;
        // The two ambiguous saddles: resolved with the centre value, which is
        // the standard fix for marching squares' diagonal ambiguity.
        case 5: {
          const centre = f(0.5 * (x0 + x1), 0.5 * (y0 + y1)) - level;
          if (centre > 0) {
            emit(left(), top());
            emit(bottom(), right());
          } else {
            emit(left(), bottom());
            emit(right(), top());
          }
          break;
        }
        case 10: {
          const centre = f(0.5 * (x0 + x1), 0.5 * (y0 + y1)) - level;
          if (centre > 0) {
            emit(left(), bottom());
            emit(right(), top());
          } else {
            emit(left(), top());
            emit(bottom(), right());
          }
          break;
        }
      }
    }
    const swap = rowBelow;
    rowBelow = rowAbove;
    rowAbove = swap;
  }
  return Float64Array.from(out);
}
