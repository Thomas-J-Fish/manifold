/* Probability distributions.
 *
 * Each entry supplies density, cumulative probability and quantile as three
 * independent implementations rather than deriving the last two by numerical
 * integration and root-finding. That costs more code and buys accuracy: a tail
 * probability of 1e-12 comes out right, which is precisely the regime a
 * p-value lives in and precisely where a quadrature-based CDF falls apart.
 */

import {
  betaI,
  choose,
  erf,
  gammaP,
  gammaQ,
  invBetaI,
  invGammaP,
  invNormCdf,
  logBeta,
  logChoose,
  logFactorial,
  logGamma,
  normCdf,
  normPdf,
} from './specfun';
import type { Rng } from './random';

export type DistKind = 'continuous' | 'discrete';

export interface DistParam {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
}

export interface Distribution {
  id: string;
  name: string;
  kind: DistKind;
  /** Short description shown under the selector. */
  blurb: string;
  params: DistParam[];
  /** Density (continuous) or mass (discrete). */
  pdf(x: number, p: Record<string, number>): number;
  cdf(x: number, p: Record<string, number>): number;
  quantile(q: number, p: Record<string, number>): number;
  mean(p: Record<string, number>): number;
  variance(p: Record<string, number>): number;
  support(p: Record<string, number>): [number, number];
  /** A sensible default plotting range: roughly the central 99.99%. */
  window(p: Record<string, number>): [number, number];
  sample(rng: Rng, p: Record<string, number>): number;
  /** Optional closed-form skewness/kurtosis for the summary panel. */
  skewness?(p: Record<string, number>): number;
}

const num = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback);

/** Quantile by bisection on the CDF — the fallback where no closed form exists. */
function bisectQuantile(
  cdf: (x: number) => number,
  q: number,
  lo: number,
  hi: number,
  iterations = 200,
): number {
  if (q <= 0) return lo;
  if (q >= 1) return hi;
  let a = lo;
  let b = hi;
  // Expand an unbounded end until it actually brackets the target.
  if (!Number.isFinite(a)) {
    a = -1;
    while (cdf(a) > q && a > -1e12) a *= 2;
  }
  if (!Number.isFinite(b)) {
    b = 1;
    while (cdf(b) < q && b < 1e12) b *= 2;
  }
  for (let i = 0; i < iterations; i++) {
    const m = 0.5 * (a + b);
    if (cdf(m) < q) a = m;
    else b = m;
    if (b - a < 1e-14 * Math.max(1, Math.abs(a))) break;
  }
  return 0.5 * (a + b);
}

/** Discrete quantile: smallest k with F(k) ≥ q, found by search from the mean. */
function discreteQuantile(
  cdf: (k: number) => number,
  q: number,
  lo: number,
  hi: number,
  start: number,
): number {
  if (q <= 0) return lo;
  if (q >= 1) return hi;
  let k = Math.max(lo, Math.min(hi, Math.round(start)));
  if (cdf(k) >= q) {
    while (k > lo && cdf(k - 1) >= q) k--;
  } else {
    while (k < hi && cdf(k) < q) k++;
  }
  return k;
}

// ------------------------------------------------------------------ continuous

const normal: Distribution = {
  id: 'normal',
  name: 'Normal',
  kind: 'continuous',
  blurb: 'The limit of sums of independent effects; the reference distribution for most inference.',
  params: [
    { key: 'mu', label: 'μ (mean)', default: 0, min: -50, max: 50, step: 0.1 },
    { key: 'sigma', label: 'σ (std. dev.)', default: 1, min: 0.01, max: 20, step: 0.05 },
  ],
  pdf: (x, p) => normPdf(x, num(p.mu, 0), num(p.sigma, 1)),
  cdf: (x, p) => normCdf(x, num(p.mu, 0), num(p.sigma, 1)),
  quantile: (q, p) => num(p.mu, 0) + num(p.sigma, 1) * invNormCdf(q),
  mean: (p) => num(p.mu, 0),
  variance: (p) => num(p.sigma, 1) ** 2,
  support: () => [-Infinity, Infinity],
  window: (p) => [num(p.mu, 0) - 4.2 * num(p.sigma, 1), num(p.mu, 0) + 4.2 * num(p.sigma, 1)],
  sample: (r, p) => r.normal(num(p.mu, 0), num(p.sigma, 1)),
  skewness: () => 0,
};

const studentT: Distribution = {
  id: 't',
  name: "Student's t",
  kind: 'continuous',
  blurb: 'Normal-like but heavier-tailed; what a sample mean follows when σ is estimated from the data.',
  params: [{ key: 'df', label: 'ν (degrees of freedom)', default: 10, min: 1, max: 500, step: 1 }],
  pdf: (x, p) => {
    const v = num(p.df, 1);
    return Math.exp(logGamma((v + 1) / 2) - logGamma(v / 2)) / Math.sqrt(v * Math.PI) *
      Math.pow(1 + (x * x) / v, -(v + 1) / 2);
  },
  cdf: (x, p) => {
    const v = num(p.df, 1);
    const t = betaI(v / 2, 0.5, v / (v + x * x)) / 2;
    return x > 0 ? 1 - t : t;
  },
  quantile: (q, p) => {
    const v = num(p.df, 1);
    if (q === 0.5) return 0;
    // Invert through the beta rather than by bisecting the CDF: this keeps
    // full precision at q = 1e-10, which bisection on a flat tail does not.
    const twoTail = q < 0.5 ? 2 * q : 2 * (1 - q);
    const x = invBetaI(v / 2, 0.5, twoTail);
    const t = Math.sqrt((v * (1 - x)) / x);
    return q < 0.5 ? -t : t;
  },
  mean: (p) => (num(p.df, 1) > 1 ? 0 : NaN),
  variance: (p) => {
    const v = num(p.df, 1);
    return v > 2 ? v / (v - 2) : v > 1 ? Infinity : NaN;
  },
  support: () => [-Infinity, Infinity],
  window: (p) => {
    const v = num(p.df, 1);
    const s = v > 2 ? Math.sqrt(v / (v - 2)) : 3;
    return [-4.5 * s, 4.5 * s];
  },
  sample: (r, p) => r.studentT(num(p.df, 1)),
  skewness: (p) => (num(p.df, 1) > 3 ? 0 : NaN),
};

const chiSquared: Distribution = {
  id: 'chisq',
  name: 'Chi-squared',
  kind: 'continuous',
  blurb: 'Sum of ν squared standard normals; the distribution behind variance and goodness-of-fit tests.',
  params: [{ key: 'df', label: 'ν (degrees of freedom)', default: 4, min: 1, max: 200, step: 1 }],
  pdf: (x, p) => {
    const k = num(p.df, 1);
    if (x <= 0) return 0;
    return Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.LN2 - logGamma(k / 2));
  },
  cdf: (x, p) => (x <= 0 ? 0 : gammaP(num(p.df, 1) / 2, x / 2)),
  quantile: (q, p) => 2 * invGammaP(num(p.df, 1) / 2, q),
  mean: (p) => num(p.df, 1),
  variance: (p) => 2 * num(p.df, 1),
  support: () => [0, Infinity],
  window: (p) => [0, num(p.df, 1) + 5 * Math.sqrt(2 * num(p.df, 1)) + 6],
  sample: (r, p) => r.chiSquared(num(p.df, 1)),
  skewness: (p) => Math.sqrt(8 / num(p.df, 1)),
};

const fDist: Distribution = {
  id: 'f',
  name: 'F',
  kind: 'continuous',
  blurb: 'Ratio of two scaled chi-squares; the test statistic of ANOVA and regression significance.',
  params: [
    { key: 'd1', label: 'd₁ (numerator df)', default: 5, min: 1, max: 200, step: 1 },
    { key: 'd2', label: 'd₂ (denominator df)', default: 10, min: 1, max: 200, step: 1 },
  ],
  pdf: (x, p) => {
    const d1 = num(p.d1, 1);
    const d2 = num(p.d2, 1);
    if (x <= 0) return 0;
    const lg =
      (d1 / 2) * Math.log(d1) +
      (d2 / 2) * Math.log(d2) +
      (d1 / 2 - 1) * Math.log(x) -
      ((d1 + d2) / 2) * Math.log(d2 + d1 * x) -
      logBeta(d1 / 2, d2 / 2);
    return Math.exp(lg);
  },
  cdf: (x, p) => {
    const d1 = num(p.d1, 1);
    const d2 = num(p.d2, 1);
    if (x <= 0) return 0;
    return betaI(d1 / 2, d2 / 2, (d1 * x) / (d1 * x + d2));
  },
  quantile: (q, p) => {
    const d1 = num(p.d1, 1);
    const d2 = num(p.d2, 1);
    const y = invBetaI(d1 / 2, d2 / 2, q);
    return (d2 * y) / (d1 * (1 - y));
  },
  mean: (p) => (num(p.d2, 1) > 2 ? num(p.d2, 1) / (num(p.d2, 1) - 2) : NaN),
  variance: (p) => {
    const d1 = num(p.d1, 1);
    const d2 = num(p.d2, 1);
    if (d2 <= 4) return NaN;
    return (2 * d2 * d2 * (d1 + d2 - 2)) / (d1 * (d2 - 2) * (d2 - 2) * (d2 - 4));
  },
  support: () => [0, Infinity],
  window: (p) => [0, Math.max(4, fDist.quantile(0.9995, p))],
  sample: (r, p) => {
    const d1 = num(p.d1, 1);
    const d2 = num(p.d2, 1);
    return r.chiSquared(d1) / d1 / (r.chiSquared(d2) / d2);
  },
};

const exponential: Distribution = {
  id: 'exponential',
  name: 'Exponential',
  kind: 'continuous',
  blurb: 'Waiting time to the next event in a memoryless process.',
  params: [{ key: 'rate', label: 'λ (rate)', default: 1, min: 0.01, max: 20, step: 0.05 }],
  pdf: (x, p) => (x < 0 ? 0 : num(p.rate, 1) * Math.exp(-num(p.rate, 1) * x)),
  cdf: (x, p) => (x < 0 ? 0 : 1 - Math.exp(-num(p.rate, 1) * x)),
  quantile: (q, p) => -Math.log(1 - q) / num(p.rate, 1),
  mean: (p) => 1 / num(p.rate, 1),
  variance: (p) => 1 / num(p.rate, 1) ** 2,
  support: () => [0, Infinity],
  window: (p) => [0, 8 / num(p.rate, 1)],
  sample: (r, p) => r.exponential(num(p.rate, 1)),
  skewness: () => 2,
};

const uniform: Distribution = {
  id: 'uniform',
  name: 'Uniform',
  kind: 'continuous',
  blurb: 'Equal density across an interval; the maximum-entropy choice given only bounds.',
  params: [
    { key: 'a', label: 'a (lower)', default: 0, min: -50, max: 50, step: 0.1 },
    { key: 'b', label: 'b (upper)', default: 1, min: -50, max: 50, step: 0.1 },
  ],
  pdf: (x, p) => {
    const a = num(p.a, 0);
    const b = num(p.b, 1);
    return x >= Math.min(a, b) && x <= Math.max(a, b) ? 1 / Math.abs(b - a) : 0;
  },
  cdf: (x, p) => {
    const a = Math.min(num(p.a, 0), num(p.b, 1));
    const b = Math.max(num(p.a, 0), num(p.b, 1));
    return x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  },
  quantile: (q, p) => {
    const a = Math.min(num(p.a, 0), num(p.b, 1));
    const b = Math.max(num(p.a, 0), num(p.b, 1));
    return a + q * (b - a);
  },
  mean: (p) => (num(p.a, 0) + num(p.b, 1)) / 2,
  variance: (p) => (num(p.b, 1) - num(p.a, 0)) ** 2 / 12,
  support: (p) => [Math.min(num(p.a, 0), num(p.b, 1)), Math.max(num(p.a, 0), num(p.b, 1))],
  window: (p) => {
    const a = Math.min(num(p.a, 0), num(p.b, 1));
    const b = Math.max(num(p.a, 0), num(p.b, 1));
    const pad = 0.25 * (b - a) + 0.1;
    return [a - pad, b + pad];
  },
  sample: (r, p) => r.uniform(num(p.a, 0), num(p.b, 1)),
  skewness: () => 0,
};

const gammaDist: Distribution = {
  id: 'gamma',
  name: 'Gamma',
  kind: 'continuous',
  blurb: 'Waiting time until the kth event; generalises the exponential and chi-squared.',
  params: [
    { key: 'shape', label: 'k (shape)', default: 2, min: 0.05, max: 50, step: 0.05 },
    { key: 'scale', label: 'θ (scale)', default: 1, min: 0.05, max: 20, step: 0.05 },
  ],
  pdf: (x, p) => {
    const k = num(p.shape, 1);
    const th = num(p.scale, 1);
    if (x <= 0) return 0;
    return Math.exp((k - 1) * Math.log(x) - x / th - k * Math.log(th) - logGamma(k));
  },
  cdf: (x, p) => (x <= 0 ? 0 : gammaP(num(p.shape, 1), x / num(p.scale, 1))),
  quantile: (q, p) => num(p.scale, 1) * invGammaP(num(p.shape, 1), q),
  mean: (p) => num(p.shape, 1) * num(p.scale, 1),
  variance: (p) => num(p.shape, 1) * num(p.scale, 1) ** 2,
  support: () => [0, Infinity],
  window: (p) => [0, gammaDist.quantile(0.9995, p) * 1.05],
  sample: (r, p) => r.gamma(num(p.shape, 1), num(p.scale, 1)),
  skewness: (p) => 2 / Math.sqrt(num(p.shape, 1)),
};

const betaDist: Distribution = {
  id: 'beta',
  name: 'Beta',
  kind: 'continuous',
  blurb: 'Density on [0,1]; the conjugate prior for a probability.',
  params: [
    { key: 'a', label: 'α', default: 2, min: 0.05, max: 30, step: 0.05 },
    { key: 'b', label: 'β', default: 5, min: 0.05, max: 30, step: 0.05 },
  ],
  pdf: (x, p) => {
    const a = num(p.a, 1);
    const b = num(p.b, 1);
    if (x <= 0 || x >= 1) return 0;
    return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logBeta(a, b));
  },
  cdf: (x, p) => betaI(num(p.a, 1), num(p.b, 1), Math.max(0, Math.min(1, x))),
  quantile: (q, p) => invBetaI(num(p.a, 1), num(p.b, 1), q),
  mean: (p) => num(p.a, 1) / (num(p.a, 1) + num(p.b, 1)),
  variance: (p) => {
    const a = num(p.a, 1);
    const b = num(p.b, 1);
    return (a * b) / ((a + b) ** 2 * (a + b + 1));
  },
  support: () => [0, 1],
  window: () => [-0.05, 1.05],
  sample: (r, p) => r.beta(num(p.a, 1), num(p.b, 1)),
};

const logNormal: Distribution = {
  id: 'lognormal',
  name: 'Log-normal',
  kind: 'continuous',
  blurb: 'A variable whose logarithm is normal; the stationary shape behind multiplicative growth.',
  params: [
    { key: 'mu', label: 'μ (log-mean)', default: 0, min: -5, max: 5, step: 0.05 },
    { key: 'sigma', label: 'σ (log-sd)', default: 0.5, min: 0.01, max: 5, step: 0.01 },
  ],
  pdf: (x, p) => {
    if (x <= 0) return 0;
    const s = num(p.sigma, 1);
    const z = (Math.log(x) - num(p.mu, 0)) / s;
    return Math.exp(-0.5 * z * z) / (x * s * Math.sqrt(2 * Math.PI));
  },
  cdf: (x, p) => (x <= 0 ? 0 : normCdf(Math.log(x), num(p.mu, 0), num(p.sigma, 1))),
  quantile: (q, p) => Math.exp(num(p.mu, 0) + num(p.sigma, 1) * invNormCdf(q)),
  mean: (p) => Math.exp(num(p.mu, 0) + num(p.sigma, 1) ** 2 / 2),
  variance: (p) => {
    const s2 = num(p.sigma, 1) ** 2;
    return (Math.exp(s2) - 1) * Math.exp(2 * num(p.mu, 0) + s2);
  },
  support: () => [0, Infinity],
  window: (p) => [0, logNormal.quantile(0.995, p)],
  sample: (r, p) => Math.exp(r.normal(num(p.mu, 0), num(p.sigma, 1))),
};

const cauchy: Distribution = {
  id: 'cauchy',
  name: 'Cauchy',
  kind: 'continuous',
  blurb: 'Heavy enough tails that the mean does not exist — a standing counterexample to the CLT.',
  params: [
    { key: 'x0', label: 'x₀ (location)', default: 0, min: -20, max: 20, step: 0.1 },
    { key: 'gamma', label: 'γ (scale)', default: 1, min: 0.05, max: 10, step: 0.05 },
  ],
  pdf: (x, p) => {
    const g = num(p.gamma, 1);
    const z = (x - num(p.x0, 0)) / g;
    return 1 / (Math.PI * g * (1 + z * z));
  },
  cdf: (x, p) => 0.5 + Math.atan((x - num(p.x0, 0)) / num(p.gamma, 1)) / Math.PI,
  quantile: (q, p) => num(p.x0, 0) + num(p.gamma, 1) * Math.tan(Math.PI * (q - 0.5)),
  mean: () => NaN,
  variance: () => NaN,
  support: () => [-Infinity, Infinity],
  window: (p) => [num(p.x0, 0) - 12 * num(p.gamma, 1), num(p.x0, 0) + 12 * num(p.gamma, 1)],
  sample: (r, p) => num(p.x0, 0) + num(p.gamma, 1) * Math.tan(Math.PI * (r.next() - 0.5)),
};

const laplace: Distribution = {
  id: 'laplace',
  name: 'Laplace',
  kind: 'continuous',
  blurb: 'Two exponentials back to back; the error model behind least-absolute-deviation fitting.',
  params: [
    { key: 'mu', label: 'μ (location)', default: 0, min: -20, max: 20, step: 0.1 },
    { key: 'b', label: 'b (scale)', default: 1, min: 0.05, max: 10, step: 0.05 },
  ],
  pdf: (x, p) => Math.exp(-Math.abs(x - num(p.mu, 0)) / num(p.b, 1)) / (2 * num(p.b, 1)),
  cdf: (x, p) => {
    const m = num(p.mu, 0);
    const b = num(p.b, 1);
    return x < m ? 0.5 * Math.exp((x - m) / b) : 1 - 0.5 * Math.exp(-(x - m) / b);
  },
  quantile: (q, p) => {
    const m = num(p.mu, 0);
    const b = num(p.b, 1);
    return q < 0.5 ? m + b * Math.log(2 * q) : m - b * Math.log(2 * (1 - q));
  },
  mean: (p) => num(p.mu, 0),
  variance: (p) => 2 * num(p.b, 1) ** 2,
  support: () => [-Infinity, Infinity],
  window: (p) => [num(p.mu, 0) - 9 * num(p.b, 1), num(p.mu, 0) + 9 * num(p.b, 1)],
  sample: (r, p) => {
    const u = r.next() - 0.5;
    return num(p.mu, 0) - num(p.b, 1) * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
  },
};

const weibull: Distribution = {
  id: 'weibull',
  name: 'Weibull',
  kind: 'continuous',
  blurb: 'Time to failure with a hazard rate that rises or falls with age.',
  params: [
    { key: 'k', label: 'k (shape)', default: 1.5, min: 0.1, max: 15, step: 0.05 },
    { key: 'lambda', label: 'λ (scale)', default: 1, min: 0.05, max: 20, step: 0.05 },
  ],
  pdf: (x, p) => {
    const k = num(p.k, 1);
    const l = num(p.lambda, 1);
    if (x < 0) return 0;
    return (k / l) * Math.pow(x / l, k - 1) * Math.exp(-Math.pow(x / l, k));
  },
  cdf: (x, p) => (x < 0 ? 0 : 1 - Math.exp(-Math.pow(x / num(p.lambda, 1), num(p.k, 1)))),
  quantile: (q, p) => num(p.lambda, 1) * Math.pow(-Math.log(1 - q), 1 / num(p.k, 1)),
  mean: (p) => num(p.lambda, 1) * Math.exp(logGamma(1 + 1 / num(p.k, 1))),
  variance: (p) => {
    const k = num(p.k, 1);
    const l = num(p.lambda, 1);
    const g1 = Math.exp(logGamma(1 + 1 / k));
    const g2 = Math.exp(logGamma(1 + 2 / k));
    return l * l * (g2 - g1 * g1);
  },
  support: () => [0, Infinity],
  window: (p) => [0, weibull.quantile(0.999, p) * 1.1],
  sample: (r, p) => num(p.lambda, 1) * Math.pow(-Math.log(r.nextOpen()), 1 / num(p.k, 1)),
};

const logistic: Distribution = {
  id: 'logistic',
  name: 'Logistic',
  kind: 'continuous',
  blurb: 'Normal-shaped with slightly heavier tails; the link function of logistic regression.',
  params: [
    { key: 'mu', label: 'μ (location)', default: 0, min: -20, max: 20, step: 0.1 },
    { key: 's', label: 's (scale)', default: 1, min: 0.05, max: 10, step: 0.05 },
  ],
  pdf: (x, p) => {
    const s = num(p.s, 1);
    const z = Math.exp(-(x - num(p.mu, 0)) / s);
    return z / (s * (1 + z) ** 2);
  },
  cdf: (x, p) => 1 / (1 + Math.exp(-(x - num(p.mu, 0)) / num(p.s, 1))),
  quantile: (q, p) => num(p.mu, 0) + num(p.s, 1) * Math.log(q / (1 - q)),
  mean: (p) => num(p.mu, 0),
  variance: (p) => (Math.PI ** 2 / 3) * num(p.s, 1) ** 2,
  support: () => [-Infinity, Infinity],
  window: (p) => [num(p.mu, 0) - 9 * num(p.s, 1), num(p.mu, 0) + 9 * num(p.s, 1)],
  sample: (r, p) => {
    const u = r.nextOpen();
    return num(p.mu, 0) + num(p.s, 1) * Math.log(u / (1 - u));
  },
};

const pareto: Distribution = {
  id: 'pareto',
  name: 'Pareto',
  kind: 'continuous',
  blurb: 'A power law: the 80/20 shape of wealth, city sizes and file lengths.',
  params: [
    { key: 'xm', label: 'xₘ (minimum)', default: 1, min: 0.05, max: 20, step: 0.05 },
    { key: 'alpha', label: 'α (tail index)', default: 2, min: 0.1, max: 20, step: 0.05 },
  ],
  pdf: (x, p) => {
    const xm = num(p.xm, 1);
    const a = num(p.alpha, 1);
    return x < xm ? 0 : (a * Math.pow(xm, a)) / Math.pow(x, a + 1);
  },
  cdf: (x, p) => (x < num(p.xm, 1) ? 0 : 1 - Math.pow(num(p.xm, 1) / x, num(p.alpha, 1))),
  quantile: (q, p) => num(p.xm, 1) / Math.pow(1 - q, 1 / num(p.alpha, 1)),
  mean: (p) => (num(p.alpha, 1) > 1 ? (num(p.alpha, 1) * num(p.xm, 1)) / (num(p.alpha, 1) - 1) : Infinity),
  variance: (p) => {
    const a = num(p.alpha, 1);
    const xm = num(p.xm, 1);
    return a > 2 ? (xm * xm * a) / ((a - 1) ** 2 * (a - 2)) : Infinity;
  },
  support: (p) => [num(p.xm, 1), Infinity],
  window: (p) => [0, pareto.quantile(0.99, p) * 1.2],
  sample: (r, p) => num(p.xm, 1) / Math.pow(r.nextOpen(), 1 / num(p.alpha, 1)),
};

// ------------------------------------------------------------------ discrete

const binomial: Distribution = {
  id: 'binomial',
  name: 'Binomial',
  kind: 'discrete',
  blurb: 'Successes in n independent trials, each with probability p.',
  params: [
    { key: 'n', label: 'n (trials)', default: 20, min: 1, max: 300, step: 1, integer: true },
    { key: 'p', label: 'p (success probability)', default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  pdf: (k, p) => {
    const n = Math.round(num(p.n, 1));
    const pr = num(p.p, 0.5);
    if (k < 0 || k > n || !Number.isInteger(k)) return 0;
    if (pr <= 0) return k === 0 ? 1 : 0;
    if (pr >= 1) return k === n ? 1 : 0;
    return Math.exp(logChoose(n, k) + k * Math.log(pr) + (n - k) * Math.log(1 - pr));
  },
  cdf: (k, p) => {
    const n = Math.round(num(p.n, 1));
    const pr = num(p.p, 0.5);
    const kk = Math.floor(k);
    if (kk < 0) return 0;
    if (kk >= n) return 1;
    // The regularised incomplete beta gives the exact tail in one call, where
    // summing the pmf loses accuracy (and time) for large n.
    return betaI(n - kk, kk + 1, 1 - pr);
  },
  quantile: (q, p) => {
    const n = Math.round(num(p.n, 1));
    const pr = num(p.p, 0.5);
    return discreteQuantile((k) => binomial.cdf(k, p), q, 0, n, n * pr);
  },
  mean: (p) => Math.round(num(p.n, 1)) * num(p.p, 0.5),
  variance: (p) => Math.round(num(p.n, 1)) * num(p.p, 0.5) * (1 - num(p.p, 0.5)),
  support: (p) => [0, Math.round(num(p.n, 1))],
  window: (p) => [-0.5, Math.round(num(p.n, 1)) + 0.5],
  sample: (r, p) => r.binomial(Math.round(num(p.n, 1)), num(p.p, 0.5)),
  skewness: (p) => {
    const n = Math.round(num(p.n, 1));
    const pr = num(p.p, 0.5);
    return (1 - 2 * pr) / Math.sqrt(n * pr * (1 - pr));
  },
};

const poisson: Distribution = {
  id: 'poisson',
  name: 'Poisson',
  kind: 'discrete',
  blurb: 'Counts of rare independent events in a fixed interval.',
  params: [{ key: 'lambda', label: 'λ (rate)', default: 4, min: 0.01, max: 100, step: 0.1 }],
  pdf: (k, p) => {
    const l = num(p.lambda, 1);
    if (k < 0 || !Number.isInteger(k)) return 0;
    return Math.exp(-l + k * Math.log(l) - logFactorial(k));
  },
  cdf: (k, p) => {
    const kk = Math.floor(k);
    if (kk < 0) return 0;
    return gammaQ(kk + 1, num(p.lambda, 1));
  },
  quantile: (q, p) => discreteQuantile((k) => poisson.cdf(k, p), q, 0, 1e6, num(p.lambda, 1)),
  mean: (p) => num(p.lambda, 1),
  variance: (p) => num(p.lambda, 1),
  support: () => [0, Infinity],
  window: (p) => [-0.5, Math.ceil(num(p.lambda, 1) + 5 * Math.sqrt(num(p.lambda, 1)) + 5)],
  sample: (r, p) => r.poisson(num(p.lambda, 1)),
  skewness: (p) => 1 / Math.sqrt(num(p.lambda, 1)),
};

const geometric: Distribution = {
  id: 'geometric',
  name: 'Geometric',
  kind: 'discrete',
  blurb: 'Failures before the first success. Memoryless, like the exponential.',
  params: [{ key: 'p', label: 'p (success probability)', default: 0.3, min: 0.001, max: 1, step: 0.005 }],
  pdf: (k, p) => {
    const pr = num(p.p, 0.5);
    if (k < 0 || !Number.isInteger(k)) return 0;
    return pr * Math.pow(1 - pr, k);
  },
  cdf: (k, p) => (k < 0 ? 0 : 1 - Math.pow(1 - num(p.p, 0.5), Math.floor(k) + 1)),
  quantile: (q, p) => Math.max(0, Math.ceil(Math.log(1 - q) / Math.log(1 - num(p.p, 0.5)) - 1)),
  mean: (p) => (1 - num(p.p, 0.5)) / num(p.p, 0.5),
  variance: (p) => (1 - num(p.p, 0.5)) / num(p.p, 0.5) ** 2,
  support: () => [0, Infinity],
  window: (p) => [-0.5, Math.ceil(geometric.quantile(0.999, p)) + 1],
  sample: (r, p) => r.geometric(num(p.p, 0.5)),
};

const negBinomial: Distribution = {
  id: 'negbinomial',
  name: 'Negative binomial',
  kind: 'discrete',
  blurb: 'Failures before the rth success; an over-dispersed alternative to the Poisson.',
  params: [
    { key: 'r', label: 'r (successes)', default: 5, min: 1, max: 100, step: 1, integer: true },
    { key: 'p', label: 'p (success probability)', default: 0.5, min: 0.01, max: 1, step: 0.01 },
  ],
  pdf: (k, p) => {
    const r = Math.round(num(p.r, 1));
    const pr = num(p.p, 0.5);
    if (k < 0 || !Number.isInteger(k)) return 0;
    return Math.exp(logChoose(k + r - 1, k) + r * Math.log(pr) + k * Math.log(1 - pr));
  },
  cdf: (k, p) => {
    const r = Math.round(num(p.r, 1));
    const pr = num(p.p, 0.5);
    const kk = Math.floor(k);
    if (kk < 0) return 0;
    return betaI(r, kk + 1, pr);
  },
  quantile: (q, p) =>
    discreteQuantile((k) => negBinomial.cdf(k, p), q, 0, 1e6, (Math.round(num(p.r, 1)) * (1 - num(p.p, 0.5))) / num(p.p, 0.5)),
  mean: (p) => (Math.round(num(p.r, 1)) * (1 - num(p.p, 0.5))) / num(p.p, 0.5),
  variance: (p) => (Math.round(num(p.r, 1)) * (1 - num(p.p, 0.5))) / num(p.p, 0.5) ** 2,
  support: () => [0, Infinity],
  window: (p) => [-0.5, Math.ceil(negBinomial.quantile(0.999, p)) + 1],
  sample: (r, p) => {
    const rr = Math.round(num(p.r, 1));
    let k = 0;
    let s = 0;
    while (s < rr) {
      if (r.next() < num(p.p, 0.5)) s++;
      else k++;
      if (k > 1e6) break;
    }
    return k;
  },
};

const hypergeometric: Distribution = {
  id: 'hypergeometric',
  name: 'Hypergeometric',
  kind: 'discrete',
  blurb: 'Successes when sampling without replacement from a finite population.',
  params: [
    { key: 'N', label: 'N (population)', default: 50, min: 1, max: 500, step: 1, integer: true },
    { key: 'K', label: 'K (successes in population)', default: 15, min: 0, max: 500, step: 1, integer: true },
    { key: 'n', label: 'n (draws)', default: 10, min: 1, max: 500, step: 1, integer: true },
  ],
  pdf: (k, p) => {
    const N = Math.round(num(p.N, 1));
    const K = Math.min(Math.round(num(p.K, 0)), N);
    const n = Math.min(Math.round(num(p.n, 1)), N);
    if (k < Math.max(0, n + K - N) || k > Math.min(n, K) || !Number.isInteger(k)) return 0;
    return (choose(K, k) * choose(N - K, n - k)) / choose(N, n);
  },
  cdf: (k, p) => {
    let s = 0;
    for (let i = 0; i <= Math.floor(k); i++) s += hypergeometric.pdf(i, p);
    return Math.min(1, s);
  },
  quantile: (q, p) => {
    const n = Math.round(num(p.n, 1));
    return discreteQuantile((k) => hypergeometric.cdf(k, p), q, 0, n, hypergeometric.mean(p));
  },
  mean: (p) => (Math.round(num(p.n, 1)) * Math.round(num(p.K, 0))) / Math.round(num(p.N, 1)),
  variance: (p) => {
    const N = Math.round(num(p.N, 1));
    const K = Math.round(num(p.K, 0));
    const n = Math.round(num(p.n, 1));
    return N <= 1 ? 0 : ((n * K) / N) * (1 - K / N) * ((N - n) / (N - 1));
  },
  support: (p) => [
    Math.max(0, Math.round(num(p.n, 1)) + Math.round(num(p.K, 0)) - Math.round(num(p.N, 1))),
    Math.min(Math.round(num(p.n, 1)), Math.round(num(p.K, 0))),
  ],
  window: (p) => {
    const [lo, hi] = hypergeometric.support(p);
    return [lo - 0.5, hi + 0.5];
  },
  sample: (r, p) => {
    // Sequential sampling without replacement, updating the remaining counts.
    let N = Math.round(num(p.N, 1));
    let K = Math.round(num(p.K, 0));
    const n = Math.round(num(p.n, 1));
    let k = 0;
    for (let i = 0; i < n && N > 0; i++) {
      if (r.next() < K / N) {
        k++;
        K--;
      }
      N--;
    }
    return k;
  },
};

const bernoulli: Distribution = {
  id: 'bernoulli',
  name: 'Bernoulli',
  kind: 'discrete',
  blurb: 'A single trial: 1 with probability p, 0 otherwise.',
  params: [{ key: 'p', label: 'p', default: 0.5, min: 0, max: 1, step: 0.01 }],
  pdf: (k, p) => (k === 1 ? num(p.p, 0.5) : k === 0 ? 1 - num(p.p, 0.5) : 0),
  cdf: (k, p) => (k < 0 ? 0 : k < 1 ? 1 - num(p.p, 0.5) : 1),
  quantile: (q, p) => (q <= 1 - num(p.p, 0.5) ? 0 : 1),
  mean: (p) => num(p.p, 0.5),
  variance: (p) => num(p.p, 0.5) * (1 - num(p.p, 0.5)),
  support: () => [0, 1],
  window: () => [-0.6, 1.6],
  sample: (r, p) => r.bernoulli(num(p.p, 0.5)),
};

export const DISTRIBUTIONS: Distribution[] = [
  normal,
  studentT,
  chiSquared,
  fDist,
  exponential,
  uniform,
  gammaDist,
  betaDist,
  logNormal,
  cauchy,
  laplace,
  weibull,
  logistic,
  pareto,
  binomial,
  poisson,
  geometric,
  negBinomial,
  hypergeometric,
  bernoulli,
];

export const DISTRIBUTION_BY_ID = new Map(DISTRIBUTIONS.map((d) => [d.id, d]));

export function getDistribution(id: string): Distribution {
  return DISTRIBUTION_BY_ID.get(id) ?? normal;
}

export function defaultParams(d: Distribution): Record<string, number> {
  return Object.fromEntries(d.params.map((p) => [p.key, p.default]));
}

/** Exposed for the fallback path and for tests of the closed-form quantiles. */
export { bisectQuantile, erf };
