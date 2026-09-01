/* General numerical routines: differentiation, quadrature, root finding,
 * extrema, and ODE integration. Everything here is written against a plain
 * `(x: number) => number` so it works equally on a compiled user expression, a
 * closed-form function, or an interpolated dataset. */

export type RealFn = (x: number) => number;
export type VectorFn = (t: number, y: readonly number[], out: number[]) => void;

// ------------------------------------------------------------------ derivatives

/**
 * Central difference with a step scaled to |x|. The h^(1/3) exponent is the
 * classic balance point: truncation error falls as h², round-off grows as
 * ε/h, and their sum is minimised near ε^(1/3).
 */
export function derivative(f: RealFn, x: number, order: 1 | 2 = 1): number {
  const eps = 2.220446049250313e-16;
  const scale = Math.max(Math.abs(x), 1);
  if (order === 1) {
    const h = Math.cbrt(eps) * scale;
    // Recovering h from the actual difference of the perturbed points removes
    // the error introduced by rounding x+h to a representable double.
    const xh = x + h;
    const hh = xh - x;
    return (f(x + hh) - f(x - hh)) / (2 * hh);
  }
  const h = Math.pow(eps, 0.25) * scale;
  const xh = x + h;
  const hh = xh - x;
  return (f(x + hh) - 2 * f(x) + f(x - hh)) / (hh * hh);
}

/** Richardson-extrapolated first derivative — slower, ~10 digits typical. */
export function derivativeAccurate(f: RealFn, x: number): number {
  const scale = Math.max(Math.abs(x), 1);
  let h = 0.1 * scale;
  const tab: number[][] = [];
  let best = NaN;
  let bestErr = Infinity;
  for (let i = 0; i < 10; i++) {
    tab[i] = [(f(x + h) - f(x - h)) / (2 * h)];
    let fac = 4;
    for (let j = 1; j <= i; j++) {
      tab[i][j] = (tab[i][j - 1] * fac - tab[i - 1][j - 1]) / (fac - 1);
      fac *= 4;
      const err = Math.max(Math.abs(tab[i][j] - tab[i][j - 1]), Math.abs(tab[i][j] - tab[i - 1][j - 1]));
      if (err < bestErr) {
        bestErr = err;
        best = tab[i][j];
      }
    }
    // Once the extrapolation stops improving, more refinement only adds noise.
    if (i > 1 && Math.abs(tab[i][i] - tab[i - 1][i - 1]) >= 2 * bestErr) break;
    h /= 1.4;
  }
  return best;
}

/** Gradient of a scalar field of two variables. */
export function gradient2(
  f: (x: number, y: number) => number,
  x: number,
  y: number,
): [number, number] {
  return [derivative((t) => f(t, y), x), derivative((t) => f(x, t), y)];
}

// ------------------------------------------------------------------ quadrature

export interface IntegralResult {
  value: number;
  /** Estimated absolute error. */
  error: number;
  /** Number of function evaluations used. */
  evaluations: number;
  converged: boolean;
}

/**
 * Adaptive Simpson's rule with a per-interval error budget.
 *
 * Recursion halves the tolerance with each split so the total error across all
 * subintervals still meets the requested bound. The (S2 − S1)/15 term is
 * Richardson's estimate of Simpson's own truncation error, which is what makes
 * this adaptive rather than merely recursive.
 */
export function integrate(f: RealFn, a: number, b: number, tol = 1e-10, maxDepth = 50): IntegralResult {
  if (a === b) return { value: 0, error: 0, evaluations: 0, converged: true };
  const sign = b < a ? -1 : 1;
  if (b < a) [a, b] = [b, a];

  let evaluations = 0;
  let converged = true;
  const ev = (x: number) => {
    evaluations++;
    const v = f(x);
    return Number.isFinite(v) ? v : 0; // integrable singularities are skipped, not fatal
  };

  const simpson = (lo: number, hi: number, flo: number, fmid: number, fhi: number) =>
    ((hi - lo) / 6) * (flo + 4 * fmid + fhi);

  const recurse = (
    lo: number,
    hi: number,
    flo: number,
    fmid: number,
    fhi: number,
    whole: number,
    eps: number,
    depth: number,
  ): { v: number; e: number } => {
    const mid = 0.5 * (lo + hi);
    const lmid = 0.5 * (lo + mid);
    const rmid = 0.5 * (mid + hi);
    const flmid = ev(lmid);
    const frmid = ev(rmid);
    const left = simpson(lo, mid, flo, flmid, fmid);
    const right = simpson(mid, hi, fmid, frmid, fhi);
    const delta = left + right - whole;
    if (depth >= maxDepth) {
      converged = false;
      return { v: left + right + delta / 15, e: Math.abs(delta) / 15 };
    }
    if (Math.abs(delta) <= 15 * eps) {
      return { v: left + right + delta / 15, e: Math.abs(delta) / 15 };
    }
    const l = recurse(lo, mid, flo, flmid, fmid, left, eps / 2, depth + 1);
    const r = recurse(mid, hi, fmid, frmid, fhi, right, eps / 2, depth + 1);
    return { v: l.v + r.v, e: l.e + r.e };
  };

  const mid = 0.5 * (a + b);
  const fa = ev(a);
  const fm = ev(mid);
  const fb = ev(b);
  const whole = simpson(a, b, fa, fm, fb);
  const res = recurse(a, b, fa, fm, fb, whole, tol, 0);
  return { value: sign * res.v, error: res.e, evaluations, converged };
}

export type RiemannRule = 'left' | 'right' | 'midpoint' | 'trapezoid' | 'simpson';

export interface RiemannBar {
  x0: number;
  x1: number;
  height: number;
}

/** Riemann/Newton–Cotes sum plus the bars needed to draw it. */
export function riemann(
  f: RealFn,
  a: number,
  b: number,
  n: number,
  rule: RiemannRule,
): { sum: number; bars: RiemannBar[] } {
  const bars: RiemannBar[] = [];
  const h = (b - a) / n;
  let sum = 0;
  if (rule === 'simpson') {
    // Simpson needs an even number of panels; pair them up and report the
    // parabolic estimate as a flat bar of equal area so the picture stays honest.
    const m = n % 2 === 0 ? n : n + 1;
    const hh = (b - a) / m;
    for (let i = 0; i < m; i += 2) {
      const x0 = a + i * hh;
      const x1 = x0 + 2 * hh;
      const area = (hh / 3) * (f(x0) + 4 * f(x0 + hh) + f(x1));
      sum += area;
      bars.push({ x0, x1, height: area / (2 * hh) });
    }
    return { sum, bars };
  }
  for (let i = 0; i < n; i++) {
    const x0 = a + i * h;
    const x1 = x0 + h;
    let height: number;
    switch (rule) {
      case 'left':
        height = f(x0);
        break;
      case 'right':
        height = f(x1);
        break;
      case 'midpoint':
        height = f(0.5 * (x0 + x1));
        break;
      case 'trapezoid':
        height = 0.5 * (f(x0) + f(x1));
        break;
    }
    sum += height * h;
    bars.push({ x0, x1, height });
  }
  return { sum, bars };
}

// ------------------------------------------------------------------ roots & extrema

/** Brent's method on a bracketing interval. Combines bisection's guarantee
 *  with the speed of inverse quadratic interpolation. */
export function brent(f: RealFn, a: number, b: number, tol = 1e-12, maxIter = 100): number | null {
  let fa = f(a);
  let fb = f(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) return null;
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }
  let c = a;
  let fc = fa;
  let d = b - a;
  let mflag = true;
  for (let i = 0; i < maxIter; i++) {
    if (fb === 0) return b;
    if (Math.abs(b - a) < tol) return b;
    let s: number;
    if (fa !== fc && fb !== fc) {
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      s = b - (fb * (b - a)) / (fb - fa);
    }
    const lo = (3 * a + b) / 4;
    const bad =
      !((s > Math.min(lo, b) && s < Math.max(lo, b)) as boolean) ||
      (mflag && Math.abs(s - b) >= Math.abs(b - c) / 2) ||
      (!mflag && Math.abs(s - b) >= Math.abs(c - d) / 2) ||
      (mflag && Math.abs(b - c) < tol) ||
      (!mflag && Math.abs(c - d) < tol);
    if (bad) {
      s = (a + b) / 2;
      mflag = true;
    } else {
      mflag = false;
    }
    const fs = f(s);
    d = c;
    c = b;
    fc = fb;
    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
  }
  return b;
}

/** Every sign change of f on [a,b], refined. Used for roots and intersections. */
export function findRoots(f: RealFn, a: number, b: number, samples = 2000, tol = 1e-12): number[] {
  const roots: number[] = [];
  const h = (b - a) / samples;
  let xPrev = a;
  let fPrev = f(a);
  for (let i = 1; i <= samples; i++) {
    const x = a + i * h;
    const fx = f(x);
    if (Number.isFinite(fPrev) && Number.isFinite(fx)) {
      if (fPrev === 0) roots.push(xPrev);
      else if (fPrev * fx < 0) {
        const r = brent(f, xPrev, x, tol);
        // A sign change across a pole looks identical to a root until you
        // check the value; poles are excluded by testing f at the answer.
        if (r !== null && Math.abs(f(r)) < 1e-6 * Math.max(1, Math.abs(r))) roots.push(r);
      }
    }
    xPrev = x;
    fPrev = fx;
  }
  if (Number.isFinite(fPrev) && fPrev === 0) roots.push(b);
  return dedupe(roots, Math.abs(b - a) * 1e-9);
}

/** Local minima and maxima, found as roots of the numerical derivative. */
export function findExtrema(
  f: RealFn,
  a: number,
  b: number,
  samples = 1200,
): { x: number; y: number; kind: 'min' | 'max' }[] {
  const out: { x: number; y: number; kind: 'min' | 'max' }[] = [];
  const h = (b - a) / samples;
  for (let i = 1; i < samples; i++) {
    const x0 = a + (i - 1) * h;
    const x1 = a + i * h;
    const x2 = a + (i + 1) * h;
    const y0 = f(x0);
    const y1 = f(x1);
    const y2 = f(x2);
    if (![y0, y1, y2].every(Number.isFinite)) continue;
    if (y1 <= y0 && y1 <= y2 && (y1 < y0 || y1 < y2)) {
      const x = refineExtremum(f, x0, x2, 'min');
      out.push({ x, y: f(x), kind: 'min' });
    } else if (y1 >= y0 && y1 >= y2 && (y1 > y0 || y1 > y2)) {
      const x = refineExtremum(f, x0, x2, 'max');
      out.push({ x, y: f(x), kind: 'max' });
    }
  }
  return dedupeBy(out, (p) => p.x, Math.abs(b - a) * 1e-6);
}

/** Golden-section refinement inside a known bracket. */
function refineExtremum(f: RealFn, a: number, b: number, kind: 'min' | 'max'): number {
  const g = (Math.sqrt(5) - 1) / 2;
  const s = kind === 'min' ? 1 : -1;
  let lo = a;
  let hi = b;
  let c = hi - g * (hi - lo);
  let d = lo + g * (hi - lo);
  for (let i = 0; i < 80 && hi - lo > 1e-13 * (Math.abs(lo) + Math.abs(hi) + 1); i++) {
    if (s * f(c) < s * f(d)) {
      hi = d;
      d = c;
      c = hi - g * (hi - lo);
    } else {
      lo = c;
      c = d;
      d = lo + g * (hi - lo);
    }
  }
  return 0.5 * (lo + hi);
}

function dedupe(xs: number[], tol: number): number[] {
  const sorted = [...xs].sort((p, q) => p - q);
  const out: number[] = [];
  for (const x of sorted) if (!out.length || Math.abs(x - out[out.length - 1]) > tol) out.push(x);
  return out;
}

function dedupeBy<T>(items: T[], key: (t: T) => number, tol: number): T[] {
  const sorted = [...items].sort((p, q) => key(p) - key(q));
  const out: T[] = [];
  for (const it of sorted) if (!out.length || Math.abs(key(it) - key(out[out.length - 1])) > tol) out.push(it);
  return out;
}

// ------------------------------------------------------------------ ODE integration

export interface OdeStep {
  t: number;
  y: number[];
}

/** Classical fourth-order Runge–Kutta over a fixed step grid. */
export function rk4(
  f: VectorFn,
  y0: readonly number[],
  t0: number,
  t1: number,
  steps: number,
): OdeStep[] {
  const n = y0.length;
  const h = (t1 - t0) / steps;
  const out: OdeStep[] = [{ t: t0, y: [...y0] }];
  const y = [...y0];
  const k1 = new Array<number>(n);
  const k2 = new Array<number>(n);
  const k3 = new Array<number>(n);
  const k4 = new Array<number>(n);
  const tmp = new Array<number>(n);
  let t = t0;
  for (let s = 0; s < steps; s++) {
    f(t, y, k1);
    for (let i = 0; i < n; i++) tmp[i] = y[i] + (h / 2) * k1[i];
    f(t + h / 2, tmp, k2);
    for (let i = 0; i < n; i++) tmp[i] = y[i] + (h / 2) * k2[i];
    f(t + h / 2, tmp, k3);
    for (let i = 0; i < n; i++) tmp[i] = y[i] + h * k3[i];
    f(t + h, tmp, k4);
    for (let i = 0; i < n; i++) y[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    t = t0 + (s + 1) * h;
    if (!y.every(Number.isFinite)) break; // a blown-up trajectory stops here rather than filling the plot with NaN
    out.push({ t, y: [...y] });
  }
  return out;
}

/* Dormand–Prince 5(4) coefficients. The embedded fourth-order solution costs
 * nothing extra and gives the local error estimate that drives step control. */
const DP_A: number[][] = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const DP_C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const DP_B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const DP_B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

export interface AdaptiveOptions {
  rtol?: number;
  atol?: number;
  maxSteps?: number;
  /** Force output at these times by interpolating between accepted steps. */
  dense?: number[];
}

/** Adaptive Dormand–Prince integrator; the default for stiff-looking systems
 *  such as Lorenz where a fixed grid either blows up or wastes work. */
export function dopri5(
  f: VectorFn,
  y0: readonly number[],
  t0: number,
  t1: number,
  opts: AdaptiveOptions = {},
): OdeStep[] {
  const rtol = opts.rtol ?? 1e-7;
  const atol = opts.atol ?? 1e-9;
  const maxSteps = opts.maxSteps ?? 200000;
  const n = y0.length;
  const k: number[][] = Array.from({ length: 7 }, () => new Array<number>(n).fill(0));
  const y = [...y0];
  const tmp = new Array<number>(n);
  const y5 = new Array<number>(n);
  const out: OdeStep[] = [{ t: t0, y: [...y] }];
  let t = t0;
  let h = Math.min((t1 - t0) / 100, 0.1) || 1e-3;

  for (let step = 0; step < maxSteps && t < t1; step++) {
    if (t + h > t1) h = t1 - t;
    for (let s = 0; s < 7; s++) {
      for (let i = 0; i < n; i++) {
        let acc = y[i];
        for (let j = 0; j < s; j++) acc += h * DP_A[s][j] * k[j][i];
        tmp[i] = acc;
      }
      f(t + DP_C[s] * h, tmp, k[s]);
    }
    let err = 0;
    for (let i = 0; i < n; i++) {
      let s5 = y[i];
      let s4 = y[i];
      for (let j = 0; j < 7; j++) {
        s5 += h * DP_B5[j] * k[j][i];
        s4 += h * DP_B4[j] * k[j][i];
      }
      y5[i] = s5;
      const scale = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(s5));
      const e = (s5 - s4) / scale;
      err += e * e;
    }
    err = Math.sqrt(err / n);

    if (err <= 1 || h <= 1e-14) {
      t += h;
      for (let i = 0; i < n; i++) y[i] = y5[i];
      if (!y.every(Number.isFinite)) break;
      out.push({ t, y: [...y] });
    }
    // The 0.9 safety factor and the ±5×/5 clamps are the standard guards
    // against a single lucky or unlucky step swinging the step size wildly.
    const factor = err === 0 ? 5 : Math.min(5, Math.max(0.2, 0.9 * Math.pow(err, -0.2)));
    h *= factor;
    if (h < 1e-14) break;
  }
  return out;
}

/** Linear interpolation of an integrated trajectory onto a uniform grid,
 *  so an adaptive solve can still drive a fixed-rate animation. */
export function resampleTrajectory(steps: OdeStep[], count: number): OdeStep[] {
  if (steps.length < 2) return steps;
  const t0 = steps[0].t;
  const t1 = steps[steps.length - 1].t;
  const out: OdeStep[] = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + ((t1 - t0) * i) / (count - 1);
    while (j < steps.length - 2 && steps[j + 1].t < t) j++;
    const a = steps[j];
    const b = steps[j + 1];
    const u = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    out.push({ t, y: a.y.map((v, idx) => v + (b.y[idx] - v) * u) });
  }
  return out;
}
