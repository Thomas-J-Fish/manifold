/* Descriptive statistics, histograms, kernel density estimation and the
 * classical hypothesis tests. Sample-based, as opposed to distributions.ts,
 * which is about the theoretical laws. */

import { getDistribution } from './distributions';
import { invNormCdf, normCdf } from './specfun';

export interface Summary {
  n: number;
  mean: number;
  /** Sample standard deviation, with the n−1 denominator. */
  sd: number;
  variance: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  iqr: number;
  skewness: number;
  /** Excess kurtosis: 0 for a normal distribution. */
  kurtosis: number;
  sum: number;
  /** Standard error of the mean. */
  sem: number;
}

export function summarise(data: readonly number[]): Summary {
  const xs = data.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) {
    return {
      n: 0, mean: NaN, sd: NaN, variance: NaN, min: NaN, q1: NaN, median: NaN,
      q3: NaN, max: NaN, iqr: NaN, skewness: NaN, kurtosis: NaN, sum: 0, sem: NaN,
    };
  }
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const variance = n > 1 ? m2 / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const popSd = Math.sqrt(m2 / n);
  return {
    n,
    mean,
    sd,
    variance,
    min: xs[0],
    q1: quantileOf(xs, 0.25),
    median: quantileOf(xs, 0.5),
    q3: quantileOf(xs, 0.75),
    max: xs[n - 1],
    iqr: quantileOf(xs, 0.75) - quantileOf(xs, 0.25),
    skewness: popSd > 0 ? m3 / n / popSd ** 3 : NaN,
    kurtosis: popSd > 0 ? m4 / n / popSd ** 4 - 3 : NaN,
    sum,
    sem: n > 0 ? sd / Math.sqrt(n) : NaN,
  };
}

/**
 * The smallest and largest finite values in a series.
 *
 * `Math.min(...xs)` is the obvious way to write this and it throws
 * `RangeError: Maximum call stack size exceeded` somewhere around 125 000
 * arguments — which a pasted or imported dataset reaches easily, and which
 * surfaces as the whole window going blank rather than as anything diagnosable.
 * Every extent over user data goes through here instead.
 */
export function extentOf(values: ArrayLike<number>): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 1 };
}

/** The largest |value| in a series, with the same overflow safety. */
export function maxAbs(values: ArrayLike<number>): number {
  let best = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.abs(values[i]);
    if (Number.isFinite(v) && v > best) best = v;
  }
  return best;
}

/** Linear-interpolated quantile (the "type 7" definition used by R and NumPy). */
export function quantileOf(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function quantiles(data: readonly number[], qs: readonly number[]): number[] {
  const sorted = data.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return qs.map((q) => quantileOf(sorted, q));
}

// ------------------------------------------------------------------ histogram

export type BinRule = 'auto' | 'sturges' | 'scott' | 'freedman' | 'sqrt' | 'fixed';

export interface Histogram {
  edges: number[];
  counts: number[];
  /** counts normalised so the total area is 1 — comparable with a density. */
  density: number[];
  binWidth: number;
}

/**
 * Chooses a bin count and builds the histogram.
 *
 * The default is Freedman–Diaconis, which uses the IQR rather than the standard
 * deviation and so is not dragged around by a handful of outliers — exactly the
 * failure mode you hit when binning simulated financial returns.
 */
export function histogram(
  data: readonly number[],
  rule: BinRule = 'auto',
  fixedBins = 30,
  range?: [number, number],
): Histogram {
  const xs = data.filter(Number.isFinite);
  const n = xs.length;
  if (n === 0) return { edges: [0, 1], counts: [0], density: [0], binWidth: 1 };
  const bounds = extentOf(xs);
  const lo = range ? range[0] : bounds.min;
  const hi = range ? range[1] : bounds.max;
  if (hi === lo) {
    return { edges: [lo - 0.5, lo + 0.5], counts: [n], density: [n], binWidth: 1 };
  }

  let bins: number;
  const s = summarise(xs);
  switch (rule) {
    case 'fixed':
      bins = Math.max(1, Math.round(fixedBins));
      break;
    case 'sturges':
      bins = Math.ceil(Math.log2(n) + 1);
      break;
    case 'sqrt':
      bins = Math.ceil(Math.sqrt(n));
      break;
    case 'scott': {
      const w = (3.49 * s.sd) / Math.cbrt(n);
      bins = w > 0 ? Math.ceil((hi - lo) / w) : 10;
      break;
    }
    case 'freedman':
    case 'auto':
    default: {
      const w = (2 * s.iqr) / Math.cbrt(n);
      // A degenerate IQR (heavily tied data) makes the FD width zero; Sturges
      // is the standard fallback and never degenerates.
      bins = w > 0 ? Math.ceil((hi - lo) / w) : Math.ceil(Math.log2(n) + 1);
      break;
    }
  }
  bins = Math.max(1, Math.min(bins, 500));

  const width = (hi - lo) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + i * width);
  const counts = new Array<number>(bins).fill(0);
  for (const x of xs) {
    if (x < lo || x > hi) continue;
    let idx = Math.floor((x - lo) / width);
    if (idx >= bins) idx = bins - 1; // the top edge belongs to the last bin
    if (idx >= 0) counts[idx]++;
  }
  const density = counts.map((c) => c / (n * width));
  return { edges, counts, density, binWidth: width };
}

/** Gaussian kernel density estimate on a uniform grid. */
export function kde(
  data: readonly number[],
  gridMin: number,
  gridMax: number,
  points = 256,
  bandwidth?: number,
): { xs: number[]; ys: number[]; bandwidth: number } {
  const xs = data.filter(Number.isFinite);
  const n = xs.length;
  const s = summarise(xs);
  // Silverman's rule of thumb, with the IQR-based spread that resists outliers.
  const spread = Math.min(s.sd, s.iqr > 0 ? s.iqr / 1.349 : s.sd);
  const h = bandwidth && bandwidth > 0 ? bandwidth : 0.9 * spread * Math.pow(n, -0.2) || 1;
  const gx: number[] = [];
  const gy: number[] = [];
  const norm = 1 / (n * h * Math.sqrt(2 * Math.PI));
  for (let i = 0; i < points; i++) {
    const x = gridMin + ((gridMax - gridMin) * i) / (points - 1);
    let acc = 0;
    for (const xi of xs) {
      const z = (x - xi) / h;
      // Beyond 5 bandwidths the Gaussian contributes less than 1e-6; skipping
      // those turns an O(n·m) loop into something interactive for large n.
      if (z > -5 && z < 5) acc += Math.exp(-0.5 * z * z);
    }
    gx.push(x);
    gy.push(acc * norm);
  }
  return { xs: gx, ys: gy, bandwidth: h };
}

/** Points for a normal Q–Q plot: theoretical quantile against observed. */
export function qqPoints(data: readonly number[]): { x: number; y: number }[] {
  const xs = data.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = xs.length;
  // Blom's plotting positions (i − 3/8)/(n + 1/4): the standard choice for
  // normal probability plots, unbiased for the extremes in a way i/(n+1) is not.
  return xs.map((y, i) => ({ x: invNormCdf((i + 1 - 0.375) / (n + 0.25)), y }));
}

// ------------------------------------------------------------------ tests

export interface TestResult {
  name: string;
  statistic: number;
  /** The statistic's null distribution, for drawing the reference curve. */
  distribution: { id: string; params: Record<string, number> };
  df?: number;
  pValue: number;
  tail: 'two' | 'left' | 'right';
  /** Confidence interval on the estimated quantity, where one is defined. */
  interval?: [number, number];
  estimate?: number;
  /** Human-readable summary lines for the results panel. */
  notes: string[];
}

export type Tail = 'two' | 'left' | 'right';

function pFromT(t: number, df: number, tail: Tail): number {
  const dist = getDistribution('t');
  const p = dist.cdf(t, { df });
  if (tail === 'left') return p;
  if (tail === 'right') return 1 - p;
  return 2 * Math.min(p, 1 - p);
}

/** One-sample t-test on a mean. */
export function oneSampleT(data: readonly number[], mu0 = 0, tail: Tail = 'two', conf = 0.95): TestResult {
  const s = summarise(data);
  const df = s.n - 1;
  const t = (s.mean - mu0) / s.sem;
  const tCrit = getDistribution('t').quantile(1 - (1 - conf) / 2, { df });
  return {
    name: 'One-sample t-test',
    statistic: t,
    distribution: { id: 't', params: { df } },
    df,
    pValue: pFromT(t, df, tail),
    tail,
    estimate: s.mean,
    interval: [s.mean - tCrit * s.sem, s.mean + tCrit * s.sem],
    notes: [
      `n = ${s.n}, x̄ = ${fmt(s.mean)}, s = ${fmt(s.sd)}`,
      `Standard error ${fmt(s.sem)} on ${df} degrees of freedom`,
    ],
  };
}

/** Two-sample t-test; Welch's version by default, which does not assume equal
 *  variances and is the better default even when they look equal. */
export function twoSampleT(
  a: readonly number[],
  b: readonly number[],
  opts: { tail?: Tail; conf?: number; pooled?: boolean } = {},
): TestResult {
  const tail = opts.tail ?? 'two';
  const conf = opts.conf ?? 0.95;
  const sa = summarise(a);
  const sb = summarise(b);
  const diff = sa.mean - sb.mean;

  let se: number;
  let df: number;
  if (opts.pooled) {
    const sp2 = ((sa.n - 1) * sa.variance + (sb.n - 1) * sb.variance) / (sa.n + sb.n - 2);
    se = Math.sqrt(sp2 * (1 / sa.n + 1 / sb.n));
    df = sa.n + sb.n - 2;
  } else {
    const va = sa.variance / sa.n;
    const vb = sb.variance / sb.n;
    se = Math.sqrt(va + vb);
    // Welch–Satterthwaite: the effective degrees of freedom of a sum of two
    // independent variance estimates.
    df = (va + vb) ** 2 / (va ** 2 / (sa.n - 1) + vb ** 2 / (sb.n - 1));
  }
  const t = diff / se;
  const tCrit = getDistribution('t').quantile(1 - (1 - conf) / 2, { df });
  return {
    name: opts.pooled ? 'Two-sample t-test (pooled)' : "Welch's two-sample t-test",
    statistic: t,
    distribution: { id: 't', params: { df } },
    df,
    pValue: pFromT(t, df, tail),
    tail,
    estimate: diff,
    interval: [diff - tCrit * se, diff + tCrit * se],
    notes: [
      `Group A: n = ${sa.n}, x̄ = ${fmt(sa.mean)}, s = ${fmt(sa.sd)}`,
      `Group B: n = ${sb.n}, x̄ = ${fmt(sb.mean)}, s = ${fmt(sb.sd)}`,
      `Difference ${fmt(diff)} with standard error ${fmt(se)} on ${fmt(df)} df`,
    ],
  };
}

/** Paired t-test — a one-sample test on the differences. */
export function pairedT(a: readonly number[], b: readonly number[], tail: Tail = 'two', conf = 0.95): TestResult {
  const n = Math.min(a.length, b.length);
  const d: number[] = [];
  for (let i = 0; i < n; i++) d.push(a[i] - b[i]);
  const res = oneSampleT(d, 0, tail, conf);
  return { ...res, name: 'Paired t-test', notes: [`${n} pairs`, ...res.notes.slice(1)] };
}

/** One-sample z-test, for a known population standard deviation. */
export function zTest(data: readonly number[], mu0: number, sigma: number, tail: Tail = 'two', conf = 0.95): TestResult {
  const s = summarise(data);
  const se = sigma / Math.sqrt(s.n);
  const z = (s.mean - mu0) / se;
  const p = normCdf(z);
  const zCrit = invNormCdf(1 - (1 - conf) / 2);
  return {
    name: 'One-sample z-test',
    statistic: z,
    distribution: { id: 'normal', params: { mu: 0, sigma: 1 } },
    pValue: tail === 'left' ? p : tail === 'right' ? 1 - p : 2 * Math.min(p, 1 - p),
    tail,
    estimate: s.mean,
    interval: [s.mean - zCrit * se, s.mean + zCrit * se],
    notes: [`n = ${s.n}, x̄ = ${fmt(s.mean)}, σ known = ${fmt(sigma)}`],
  };
}

/** Chi-squared goodness of fit against expected counts. */
export function chiSquareGof(observed: readonly number[], expected: readonly number[]): TestResult {
  const k = Math.min(observed.length, expected.length);
  let chi = 0;
  const small: number[] = [];
  for (let i = 0; i < k; i++) {
    if (expected[i] <= 0) continue;
    if (expected[i] < 5) small.push(i + 1);
    chi += (observed[i] - expected[i]) ** 2 / expected[i];
  }
  const df = k - 1;
  const notes = [`${k} categories, ${df} degrees of freedom`];
  if (small.length) {
    notes.push(
      `Expected count below 5 in ${small.length} categor${small.length === 1 ? 'y' : 'ies'} — the χ² approximation is unreliable here.`,
    );
  }
  return {
    name: 'Chi-squared goodness of fit',
    statistic: chi,
    distribution: { id: 'chisq', params: { df } },
    df,
    pValue: 1 - getDistribution('chisq').cdf(chi, { df }),
    tail: 'right',
    notes,
  };
}

/** Pearson correlation with a t-based test of ρ = 0. */
export function correlation(x: readonly number[], y: readonly number[]): TestResult & { r: number } {
  const n = Math.min(x.length, y.length);
  const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const df = n - 2;
  const t = (r * Math.sqrt(df)) / Math.sqrt(1 - r * r);
  // Fisher's z transform: atanh(r) is approximately normal with sd 1/√(n−3),
  // which is what makes an interval on r possible at all.
  const z = Math.atanh(r);
  const se = 1 / Math.sqrt(n - 3);
  const zc = invNormCdf(0.975);
  return {
    name: 'Pearson correlation',
    statistic: t,
    distribution: { id: 't', params: { df } },
    df,
    pValue: pFromT(t, df, 'two'),
    tail: 'two',
    estimate: r,
    r,
    interval: [Math.tanh(z - zc * se), Math.tanh(z + zc * se)],
    notes: [`r = ${fmt(r)} over ${n} pairs`, `r² = ${fmt(r * r)}`],
  };
}

/** Shapiro-style normality screen via the Anderson–Darling statistic, which
 *  is more sensitive in the tails than Kolmogorov–Smirnov. */
export function andersonDarlingNormal(data: readonly number[]): TestResult {
  const xs = data.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = xs.length;
  const s = summarise(xs);
  let a2 = 0;
  for (let i = 0; i < n; i++) {
    const z1 = normCdf((xs[i] - s.mean) / s.sd);
    const z2 = normCdf((xs[n - 1 - i] - s.mean) / s.sd);
    const l1 = Math.log(Math.max(z1, 1e-300));
    const l2 = Math.log(Math.max(1 - z2, 1e-300));
    a2 += (2 * i + 1) * (l1 + l2);
  }
  a2 = -n - a2 / n;
  // D'Agostino's small-sample correction, then the standard p-value pieces.
  const aStar = a2 * (1 + 0.75 / n + 2.25 / (n * n));
  let p: number;
  if (aStar < 0.2) p = 1 - Math.exp(-13.436 + 101.14 * aStar - 223.73 * aStar * aStar);
  else if (aStar < 0.34) p = 1 - Math.exp(-8.318 + 42.796 * aStar - 59.938 * aStar * aStar);
  else if (aStar < 0.6) p = Math.exp(0.9177 - 4.279 * aStar - 1.38 * aStar * aStar);
  else p = Math.exp(1.2937 - 5.709 * aStar + 0.0186 * aStar * aStar);
  return {
    name: 'Anderson–Darling normality test',
    statistic: aStar,
    distribution: { id: 'normal', params: { mu: 0, sigma: 1 } },
    pValue: Math.max(0, Math.min(1, p)),
    tail: 'right',
    notes: [
      `A*² = ${fmt(aStar)} for n = ${n}`,
      'A small p-value is evidence against normality, not proof of any particular alternative.',
    ],
  };
}

/** Confidence interval for a proportion — Wilson score, which behaves near 0
 *  and 1 where the textbook normal interval produces impossible bounds. */
export function proportionInterval(successes: number, n: number, conf = 0.95): [number, number] {
  const z = invNormCdf(1 - (1 - conf) / 2);
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = phat + (z * z) / (2 * n);
  const half = z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n));
  return [(centre - half) / denom, (centre + half) / denom];
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return x.toExponential(4);
  return String(Math.round(x * 1e6) / 1e6);
}

/** Parses whitespace-, comma- or newline-separated numbers out of pasted text. */
export function parseNumberList(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map(Number)
    .filter(Number.isFinite);
}
