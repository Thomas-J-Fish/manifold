/* Curve fitting.
 *
 * Linear-in-parameters models (polynomials, and any basis expansion) are solved
 * by normal equations on a well-conditioned basis; genuinely nonlinear models go
 * through Levenberg–Marquardt. Both report the same diagnostics, so a user can
 * compare a quadratic against a logistic on equal terms.
 */

import { getDistribution } from './distributions';
import { inverse, multiply, transpose, type Matrix } from './linalg';
import { extentOf } from './stats';

export interface FitDiagnostics {
  /** Fitted parameter values, in the order the model declares them. */
  params: number[];
  paramNames: string[];
  /** Standard errors from the covariance matrix; NaN where unavailable. */
  standardErrors: number[];
  /** Two-sided p-values for H₀: parameter = 0. */
  pValues: number[];
  residuals: number[];
  /** Sum of squared residuals. */
  sse: number;
  /** Total sum of squares about the mean. */
  sst: number;
  r2: number;
  adjustedR2: number;
  rmse: number;
  /** Akaike and Bayesian information criteria, for model comparison. */
  aic: number;
  bic: number;
  dof: number;
  iterations?: number;
  converged: boolean;
  /** Parameter covariance, kept for the confidence-band computation. */
  covariance: Matrix | null;
}

function diagnostics(
  y: readonly number[],
  fitted: readonly number[],
  params: number[],
  paramNames: string[],
  jacobian: Matrix | null,
  converged: boolean,
  iterations?: number,
): FitDiagnostics {
  const n = y.length;
  const k = params.length;
  const residuals = y.map((yi, i) => yi - fitted[i]);
  const sse = residuals.reduce((s, r) => s + r * r, 0);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const dof = Math.max(1, n - k);
  const sigma2 = sse / dof;

  let covariance: Matrix | null = null;
  let standardErrors = new Array<number>(k).fill(NaN);
  let pValues = new Array<number>(k).fill(NaN);
  if (jacobian) {
    // (JᵀJ)⁻¹σ² is the asymptotic covariance; it is only meaningful when JᵀJ
    // is invertible, which fails exactly when the model is unidentifiable.
    const jtj = multiply(transpose(jacobian), jacobian);
    const inv = inverse(jtj);
    if (inv) {
      covariance = inv.map((row) => row.map((v) => v * sigma2));
      standardErrors = covariance.map((row, i) => Math.sqrt(Math.max(0, row[i])));
      const tDist = getDistribution('t');
      pValues = params.map((p, i) => {
        const se = standardErrors[i];
        if (!Number.isFinite(se) || se === 0) return NaN;
        const t = p / se;
        const cdf = tDist.cdf(Math.abs(t), { df: dof });
        return 2 * (1 - cdf);
      });
    }
  }

  const logLik = -0.5 * n * (Math.log(2 * Math.PI) + Math.log(sse / n) + 1);
  return {
    params,
    paramNames,
    standardErrors,
    pValues,
    residuals,
    sse,
    sst,
    r2: sst > 0 ? 1 - sse / sst : NaN,
    adjustedR2: sst > 0 && n > k ? 1 - (sse / dof) / (sst / (n - 1)) : NaN,
    rmse: Math.sqrt(sse / n),
    aic: 2 * k - 2 * logLik,
    bic: k * Math.log(n) - 2 * logLik,
    dof,
    converged,
    ...(iterations !== undefined ? { iterations } : {}),
    covariance,
  };
}

/**
 * Least squares for a model linear in its parameters, given a basis.
 *
 * The design matrix is built from the caller's basis functions and solved
 * through the normal equations. For a polynomial that is adequate up to about
 * degree 8; beyond that the Vandermonde condition number exceeds 1e12 and the
 * fit is centred and scaled first (see `polynomialFit`) to keep it honest.
 */
export function linearLeastSquares(
  x: readonly number[],
  y: readonly number[],
  basis: ((x: number) => number)[],
  paramNames: string[],
): FitDiagnostics {
  const n = x.length;
  const k = basis.length;
  const design: Matrix = Array.from({ length: n }, (_, i) => basis.map((b) => b(x[i])));
  const xt = transpose(design);
  const xtx = multiply(xt, design);
  const xty = xt.map((row) => row.reduce((s, v, i) => s + v * y[i], 0));
  const inv = inverse(xtx);
  if (!inv) {
    return diagnostics(y, new Array(n).fill(NaN), new Array(k).fill(NaN), paramNames, null, false);
  }
  const params = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const fitted = design.map((row) => row.reduce((s, v, j) => s + v * params[j], 0));
  return diagnostics(y, fitted, params, paramNames, design, true);
}

/**
 * Polynomial fit of the requested degree.
 *
 * x is centred and scaled to [−1,1] before building the Vandermonde matrix and
 * the coefficients are then mapped back. Without that step a degree-6 fit to
 * data on [1000, 2000] is numerically meaningless.
 */
export function polynomialFit(
  x: readonly number[],
  y: readonly number[],
  degree: number,
): FitDiagnostics & { predict: (x: number) => number } {
  const { min: xMin, max: xMax } = extentOf(x);
  const mid = (xMin + xMax) / 2;
  const half = (xMax - xMin) / 2 || 1;
  const u = x.map((v) => (v - mid) / half);
  const basis = Array.from({ length: degree + 1 }, (_, p) => (t: number) => Math.pow(t, p));
  const names = Array.from({ length: degree + 1 }, (_, p) => (p === 0 ? 'c₀' : `c${subscript(p)}`));
  const fit = linearLeastSquares(u, y, basis, names);
  const predict = (xv: number) => {
    const t = (xv - mid) / half;
    let acc = 0;
    for (let p = degree; p >= 0; p--) acc = acc * t + fit.params[p];
    return acc;
  };
  return { ...fit, predict };
}

/** Ordinary least squares line, with the slope's confidence interval. */
export function linearFit(
  x: readonly number[],
  y: readonly number[],
): FitDiagnostics & { slope: number; intercept: number; predict: (x: number) => number } {
  const fit = linearLeastSquares(x, y, [() => 1, (t) => t], ['intercept', 'slope']);
  const [intercept, slope] = fit.params;
  return { ...fit, slope, intercept, predict: (v) => intercept + slope * v };
}

// ------------------------------------------------------------------ nonlinear

export interface NonlinearModel {
  id: string;
  name: string;
  /** LaTeX form shown in the panel. */
  latex: string;
  paramNames: string[];
  /** Initial guess derived from the data — a bad start is the usual reason LM
   *  fails, so each model supplies its own. */
  initial: (x: readonly number[], y: readonly number[]) => number[];
  f: (x: number, p: readonly number[]) => number;
}

export const NONLINEAR_MODELS: NonlinearModel[] = [
  {
    id: 'exponential',
    name: 'Exponential growth / decay',
    latex: 'y = a\\,e^{bx} + c',
    paramNames: ['a', 'b', 'c'],
    initial: (_x, y) => {
      const { min: yMin, max: yMax } = extentOf(y);
      const rising = y[y.length - 1] >= y[0];
      return [rising ? yMax - yMin : yMin - yMax, rising ? 0.5 : -0.5, rising ? yMin : yMax];
    },
    f: (x, p) => p[0] * Math.exp(p[1] * x) + p[2],
  },
  {
    id: 'logistic',
    name: 'Logistic (sigmoid)',
    latex: 'y = \\dfrac{L}{1 + e^{-k(x - x_0)}}',
    paramNames: ['L', 'k', 'x₀'],
    initial: (x, y) => {
      const xs = extentOf(x);
      return [extentOf(y).max * 1.05, 1, (xs.min + xs.max) / 2];
    },
    f: (x, p) => p[0] / (1 + Math.exp(-p[1] * (x - p[2]))),
  },
  {
    id: 'gaussian',
    name: 'Gaussian peak',
    latex: 'y = A\\,e^{-(x-\\mu)^2 / 2\\sigma^2} + c',
    paramNames: ['A', 'μ', 'σ', 'c'],
    initial: (x, y) => {
      let peak = 0;
      for (let i = 1; i < y.length; i++) if (y[i] > y[peak]) peak = i;
      const xs = extentOf(x);
      const ys = extentOf(y);
      const spread = (xs.max - xs.min) / 6 || 1;
      return [y[peak] - ys.min, x[peak], spread, ys.min];
    },
    f: (x, p) => p[0] * Math.exp(-((x - p[1]) ** 2) / (2 * p[2] * p[2])) + p[3],
  },
  {
    id: 'power',
    name: 'Power law',
    latex: 'y = a\\,x^{b}',
    paramNames: ['a', 'b'],
    initial: (_x, y) => [Math.max(1e-6, y[0] || 1), 1],
    f: (x, p) => p[0] * Math.pow(Math.max(x, 1e-12), p[1]),
  },
  {
    id: 'sinusoid',
    name: 'Sinusoid',
    latex: 'y = A\\sin(\\omega x + \\varphi) + c',
    paramNames: ['A', 'ω', 'φ', 'c'],
    initial: (x, y) => {
      const { min: yMin, max: yMax } = extentOf(y);
      const xs = extentOf(x);
      const span = xs.max - xs.min || 1;
      // Assume roughly two cycles across the data unless told otherwise; ω is
      // the parameter LM struggles with most, so the guess matters.
      return [(yMax - yMin) / 2, (4 * Math.PI) / span, 0, (yMax + yMin) / 2];
    },
    f: (x, p) => p[0] * Math.sin(p[1] * x + p[2]) + p[3],
  },
  {
    id: 'michaelis',
    name: 'Michaelis–Menten',
    latex: 'y = \\dfrac{V_{max}\\,x}{K_m + x}',
    paramNames: ['Vmax', 'Km'],
    initial: (x, y) => {
      const xs = extentOf(x);
      return [extentOf(y).max * 1.1, (xs.max - xs.min) / 3 || 1];
    },
    f: (x, p) => (p[0] * x) / (p[1] + x),
  },
];

export interface LmOptions {
  maxIterations?: number;
  tolerance?: number;
  /** Starting damping; larger means the first steps are more gradient-descent-like. */
  lambda0?: number;
}

/**
 * Levenberg–Marquardt.
 *
 * The damping parameter λ interpolates between Gauss–Newton (λ→0, fast near the
 * optimum) and gradient descent (λ→∞, reliable far from it). λ is decreased
 * after every accepted step and increased after every rejected one, which is
 * what makes the method robust to a mediocre starting guess.
 */
export function levenbergMarquardt(
  x: readonly number[],
  y: readonly number[],
  model: (x: number, p: readonly number[]) => number,
  initial: readonly number[],
  paramNames: string[],
  options: LmOptions = {},
): FitDiagnostics & { predict: (x: number) => number } {
  const maxIter = options.maxIterations ?? 200;
  const tol = options.tolerance ?? 1e-12;
  let lambda = options.lambda0 ?? 1e-3;
  const n = x.length;
  const k = initial.length;
  let p = [...initial];

  const residualsOf = (params: readonly number[]) => x.map((xi, i) => y[i] - model(xi, params));
  const sseOf = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

  let r = residualsOf(p);
  let sse = sseOf(r);
  let converged = false;
  let iterations = 0;
  let jacobian: Matrix = [];

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    // Forward differences on each parameter. The step is scaled to the
    // parameter's own magnitude so a parameter of order 1e6 and one of order
    // 1e-6 both get a meaningful perturbation.
    jacobian = Array.from({ length: n }, () => new Array<number>(k).fill(0));
    for (let j = 0; j < k; j++) {
      const h = 1e-7 * Math.max(Math.abs(p[j]), 1e-6);
      const pp = [...p];
      pp[j] += h;
      for (let i = 0; i < n; i++) jacobian[i][j] = (model(x[i], pp) - model(x[i], p)) / h;
    }

    const jt = transpose(jacobian);
    const jtj = multiply(jt, jacobian);
    const jtr = jt.map((row) => row.reduce((s, v, i) => s + v * r[i], 0));

    let accepted = false;
    for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
      // Marquardt's scaling: damp by λ·diag(JᵀJ) rather than λ·I, so the
      // damping respects each parameter's natural scale.
      const damped = jtj.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
      const inv = inverse(damped);
      if (!inv) {
        lambda *= 10;
        continue;
      }
      const delta = inv.map((row) => row.reduce((s, v, j) => s + v * jtr[j], 0));
      const candidate = p.map((v, i) => v + delta[i]);
      if (!candidate.every(Number.isFinite)) {
        lambda *= 10;
        continue;
      }
      const rc = residualsOf(candidate);
      const sc = sseOf(rc);
      if (Number.isFinite(sc) && sc < sse) {
        const improvement = sse - sc;
        p = candidate;
        r = rc;
        sse = sc;
        lambda = Math.max(lambda / 10, 1e-12);
        accepted = true;
        if (improvement < tol * Math.max(1, sse)) converged = true;
      } else {
        lambda *= 10;
      }
    }
    if (!accepted || converged) {
      converged = converged || !accepted;
      break;
    }
  }

  const fitted = x.map((xi) => model(xi, p));
  const diag = diagnostics(y, fitted, p, paramNames, jacobian, converged, iterations);
  return { ...diag, predict: (v: number) => model(v, p) };
}

/**
 * A pointwise confidence band for a fitted curve.
 *
 * The variance of the prediction at x is gᵀΣg with g the gradient of the model
 * with respect to its parameters — the delta method. It is exact for a linear
 * model and a first-order approximation otherwise, which is the standard
 * caveat and is stated in the UI.
 */
export function confidenceBand(
  fit: FitDiagnostics,
  model: (x: number, p: readonly number[]) => number,
  xs: readonly number[],
  level = 0.95,
): { x: number; lower: number; upper: number; centre: number }[] | null {
  if (!fit.covariance) return null;
  const k = fit.params.length;
  const t = getDistribution('t').quantile(1 - (1 - level) / 2, { df: fit.dof });
  return xs.map((xv) => {
    const g = new Array<number>(k).fill(0);
    for (let j = 0; j < k; j++) {
      const h = 1e-7 * Math.max(Math.abs(fit.params[j]), 1e-6);
      const pp = [...fit.params];
      pp[j] += h;
      g[j] = (model(xv, pp) - model(xv, fit.params)) / h;
    }
    let variance = 0;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) variance += g[i] * fit.covariance![i][j] * g[j];
    const half = t * Math.sqrt(Math.max(0, variance));
    const centre = model(xv, fit.params);
    return { x: xv, centre, lower: centre - half, upper: centre + half };
  });
}

function subscript(n: number): string {
  const digits = '₀₁₂₃₄₅₆₇₈₉';
  return String(n)
    .split('')
    .map((d) => digits[Number(d)] ?? d)
    .join('');
}

// ------------------------------------------------------------------ CSV

export interface ParsedTable {
  columns: string[];
  rows: (number | string)[][];
  /** Indices of columns whose values parsed as numbers throughout. */
  numericColumns: number[];
}

/** A small, forgiving CSV/TSV reader: handles quotes, either delimiter, and a
 *  header row that may or may not be present. */
export function parseDelimited(text: string): ParsedTable {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (!clean) return { columns: [], rows: [], numericColumns: [] };
  const firstLine = clean.slice(0, clean.indexOf('\n') === -1 ? undefined : clean.indexOf('\n'));
  const delimiter = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  rows.push(row);

  if (!rows.length) return { columns: [], rows: [], numericColumns: [] };
  // A header is assumed when the first row has at least one non-numeric cell
  // and the second row is fully numeric — the common real-world case.
  const looksNumeric = (s: string) => s.trim() !== '' && Number.isFinite(Number(s.trim()));
  const hasHeader =
    rows.length > 1 && rows[0].some((c) => !looksNumeric(c)) && rows[1].some((c) => looksNumeric(c));
  const columns = hasHeader
    ? rows[0].map((c, i) => c.trim() || `Column ${i + 1}`)
    : rows[0].map((_, i) => `Column ${i + 1}`);
  const body = hasHeader ? rows.slice(1) : rows;

  const parsed = body
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) =>
      columns.map((_, i) => {
        const cell = (r[i] ?? '').trim();
        return looksNumeric(cell) ? Number(cell) : cell;
      }),
    );

  const numericColumns = columns
    .map((_, i) => i)
    .filter((i) => parsed.length > 0 && parsed.every((r) => typeof r[i] === 'number'));

  return { columns, rows: parsed, numericColumns };
}
