/* Special functions.
 *
 * Everything statistical in Manifold — every CDF, every quantile, every
 * p-value — bottoms out here. The implementations are the classical ones
 * (Lanczos for the gamma function, the series/continued-fraction pair for the
 * incomplete gamma, Lentz's method for the incomplete beta, Wichura's AS 241
 * for the normal quantile) chosen because their error behaviour is known and
 * documented rather than because they are short. Each is accurate to close to
 * double precision across its stated domain, which is what makes a shaded tail
 * area in the Statistics tab an answer rather than a picture.
 *
 * All functions take and return plain numbers, are pure, and never throw for
 * in-domain input: out-of-domain input returns NaN so it propagates visibly
 * into a plot instead of silently becoming zero.
 */

export const LN_PI = Math.log(Math.PI);
export const LN_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
export const SQRT_2 = Math.SQRT2;
export const SQRT_2PI = Math.sqrt(2 * Math.PI);
export const EPS = 2.220446049250313e-16;
const FPMIN = 1e-300;

// ---------------------------------------------------------------- gamma

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** log Γ(x) for x > 0, and the reflected branch for x < 0. */
export function logGamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x <= 0) {
    // Reflection: Γ(x)Γ(1−x) = π / sin(πx). Poles at the non-positive integers.
    if (Number.isInteger(x)) return Infinity;
    const sinpx = Math.sin(Math.PI * x);
    return LN_PI - Math.log(Math.abs(sinpx)) - logGamma(1 - x);
  }
  let g = LANCZOS[0];
  const z = x - 1;
  for (let i = 1; i < 9; i++) g += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return LN_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(g);
}

/** Γ(x). Overflows to Infinity beyond ~171.61, as the double range demands. */
export function gammaFn(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 171.61447887182298) return Infinity;
  if (x <= 0 && Number.isInteger(x)) return NaN; // pole
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  const lg = logGamma(x);
  // Recover the sign the log threw away: Γ is negative on (−1,0), (−3,−2), …
  let sign = 1;
  if (x < 0) {
    const k = Math.floor(x);
    if (k % 2 === 0) sign = -1;
  }
  return sign * Math.exp(lg);
}

/** n! for n ≥ 0. Exact for n ≤ 22, then via logGamma. */
const FACT_TABLE: number[] = (() => {
  const t = [1];
  for (let i = 1; i <= 22; i++) t.push(t[i - 1] * i);
  return t;
})();

export function factorial(n: number): number {
  if (n < 0) return Number.isInteger(n) ? NaN : gammaFn(n + 1);
  if (Number.isInteger(n) && n <= 22) return FACT_TABLE[n];
  return gammaFn(n + 1);
}

export function logFactorial(n: number): number {
  return n <= 22 && Number.isInteger(n) && n >= 0 ? Math.log(FACT_TABLE[n]) : logGamma(n + 1);
}

export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

export function betaFn(a: number, b: number): number {
  return Math.exp(logBeta(a, b));
}

/** log C(n, k) — stable for large n where the product form overflows. */
export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

export function choose(n: number, k: number): number {
  if (k < 0 || k > n || !Number.isInteger(k) || !Number.isInteger(n)) {
    if (!Number.isInteger(n) || !Number.isInteger(k)) {
      return Math.exp(logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1));
    }
    return 0;
  }
  // Exact multiplicative form while it fits; falls back to logs past 2^53.
  const kk = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < kk; i++) {
    r = (r * (n - i)) / (i + 1);
    if (!Number.isFinite(r)) return Math.exp(logChoose(n, k));
  }
  return Math.round(r) === r ? r : Math.round(r);
}

export function permutations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  return Math.exp(logFactorial(n) - logFactorial(n - k));
}

// ---------------------------------------------------------------- incomplete gamma

const ITMAX = 300;

/** Series expansion of P(a,x); converges quickly for x < a+1. */
function gserSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < ITMAX; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Continued fraction for Q(a,x) by modified Lentz; used for x ≥ a+1. */
function gcfFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularised lower incomplete gamma P(a,x) = γ(a,x)/Γ(a). */
export function gammaP(a: number, x: number): number {
  if (Number.isNaN(a) || Number.isNaN(x) || x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  return x < a + 1 ? gserSeries(a, x) : 1 - gcfFraction(a, x);
}

/** Regularised upper incomplete gamma Q(a,x) = 1 − P(a,x), computed directly
 *  in the branch where it is the accurate one. */
export function gammaQ(a: number, x: number): number {
  if (Number.isNaN(a) || Number.isNaN(x) || x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  return x < a + 1 ? 1 - gserSeries(a, x) : gcfFraction(a, x);
}

/** Inverse of P(a,·): the x with P(a,x) = p. Halley steps from a good seed. */
export function invGammaP(a: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  const gln = logGamma(a);
  const a1 = a - 1;
  const lna1 = a1 > 0 ? Math.log(a1) : 0;
  const afac = a1 > 0 ? Math.exp(a1 * (lna1 - 1) - gln) : 0;
  let x: number;
  if (a > 1) {
    // Wilson–Hilferty-style start, which is already within a few percent.
    const pp = p < 0.5 ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(pp));
    x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) x = -x;
    x = Math.max(1e-3, a * Math.pow(1 - 1 / (9 * a) - x / (3 * Math.sqrt(a)), 3));
  } else {
    const t = 1 - a * (0.253 + a * 0.12);
    x = p < t ? Math.pow(p / t, 1 / a) : 1 - Math.log(1 - (p - t) / (1 - t));
  }
  for (let j = 0; j < 24; j++) {
    if (x <= 0) return 0;
    const err = gammaP(a, x) - p;
    let t: number;
    if (a > 1) t = afac * Math.exp(-(x - a1) + a1 * (Math.log(x) - lna1));
    else t = Math.exp(-x + a1 * Math.log(x) - gln);
    const u = err / t;
    // The second-order term is what keeps this from overshooting near x = 0.
    const step = u / (1 - 0.5 * Math.min(1, u * (a1 / x - 1)));
    x -= step;
    if (x <= 0) x = 0.5 * (x + step);
    if (Math.abs(step) < 1e-12 * x) break;
  }
  return x;
}

// ---------------------------------------------------------------- incomplete beta

function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= ITMAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a,b). */
export function betaI(a: number, b: number, x: number): number {
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(x)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  // The continued fraction only converges fast on one side of the symmetry
  // point; the reflection I_x(a,b) = 1 − I_{1−x}(b,a) covers the other.
  return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Inverse of I_x(a,b) in x. Newton with a bisection safety net. */
export function invBetaI(a: number, b: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const a1 = a - 1;
  const b1 = b - 1;
  let x: number;
  if (a >= 1 && b >= 1) {
    const pp = p < 0.5 ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(pp));
    let xx = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) xx = -xx;
    const al = (xx * xx - 3) / 6;
    const h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1));
    const w = (xx * Math.sqrt(al + h)) / h - (1 / (2 * b - 1) - 1 / (2 * a - 1)) * (al + 5 / 6 - 2 / (3 * h));
    x = a / (a + b * Math.exp(2 * w));
  } else {
    const lna = Math.log(a / (a + b));
    const lnb = Math.log(b / (a + b));
    const t = Math.exp(a * lna) / a;
    const u = Math.exp(b * lnb) / b;
    const w = t + u;
    x = p < t / w ? Math.pow(a * w * p, 1 / a) : 1 - Math.pow(b * w * (1 - p), 1 / b);
  }
  const afac = -logGamma(a) - logGamma(b) + logGamma(a + b);
  let lo = 0;
  let hi = 1;
  for (let j = 0; j < 60; j++) {
    if (x <= 0) x = 1e-12;
    if (x >= 1) x = 1 - 1e-12;
    const err = betaI(a, b, x) - p;
    if (err > 0) hi = x;
    else lo = x;
    const t = Math.exp(a1 * Math.log(x) + b1 * Math.log(1 - x) + afac);
    let step = t === 0 ? 0 : err / t;
    let nx = x - step;
    // Newton can leave (lo,hi) when the density is nearly flat; when it does,
    // fall back to the bracketing midpoint so convergence is still guaranteed.
    if (!(nx > lo && nx < hi)) {
      nx = 0.5 * (lo + hi);
      step = x - nx;
    }
    x = nx;
    if (Math.abs(step) < 1e-14 * Math.max(x, 1e-14)) break;
  }
  return x;
}

// ---------------------------------------------------------------- error function

/** erf(x), via the incomplete gamma identity erf(x) = P(½, x²) for x ≥ 0. */
export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === 0) return 0;
  return x < 0 ? -gammaP(0.5, x * x) : gammaP(0.5, x * x);
}

/** erfc(x) = 1 − erf(x), computed so the far tail keeps its relative accuracy. */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return x < 0 ? 1 + gammaP(0.5, x * x) : gammaQ(0.5, x * x);
}

// ---------------------------------------------------------------- normal quantile

/** Φ⁻¹(p): Wichura's AS 241, accurate to about 1e-16 over the whole open unit
 *  interval. This is the workhorse behind every critical value in the app. */
export function invNormCdf(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  const q = p - 0.5;
  let r: number;
  if (Math.abs(q) <= 0.425) {
    r = 0.180625 - q * q;
    return (
      (q *
        (((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r +
          45921.953931549871457) *
          r +
          13731.693765509461125) *
          r +
          1971.5909503065514427) *
          r +
          133.14166789178437745) *
          r +
          3.387132872796366608)) /
      (((((((5226.495278852545925 * r + 28729.085735721942674) * r + 39307.89580009271061) * r +
        21213.794301586595867) *
        r +
        5394.1960214247511077) *
        r +
        687.1870074920579083) *
        r +
        42.313330701600911252) *
        r +
        1)
    );
  }
  r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let val: number;
  if (r <= 5) {
    r -= 1.6;
    val =
      (((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) * r +
        1.27045825245236838258) *
        r +
        3.64784832476320460504) *
        r +
        5.7694972214606914055) *
        r +
        4.6303378461565452959) *
        r +
        1.42343711074968357734) /
      (((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r +
        0.14810397642748007459) *
        r +
        0.68976733498510000455) *
        r +
        1.6763848301838038494) *
        r +
        2.05319162663775882187) *
        r +
        1);
  } else {
    r -= 5;
    val =
      (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) *
        r +
        0.026532189526576123093) *
        r +
        0.29656057182850489123) *
        r +
        1.7848265399172913358) *
        r +
        5.4637849111641143699) *
        r +
        6.6579046435011037772) /
      (((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) *
        r +
        7.868691311456132591e-4) *
        r +
        0.0148753612908506148525) *
        r +
        0.13692988092273580531) *
        r +
        0.59983220655588793769) *
        r +
        1);
  }
  return q < 0 ? -val : val;
}

// ---------------------------------------------------------------- misc

/** Normal pdf, written so the exponent never overflows before scaling. */
export function normPdf(x: number, mu = 0, sigma = 1): number {
  if (sigma <= 0) return NaN;
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * SQRT_2PI);
}

/** Φ(x) via erfc, which keeps ~15 significant figures deep into the left tail. */
export function normCdf(x: number, mu = 0, sigma = 1): number {
  if (sigma <= 0) return NaN;
  return 0.5 * erfc(-(x - mu) / (sigma * SQRT_2));
}

/** log(1+x) accurate for tiny x; used by the discrete log-likelihoods. */
export function log1p(x: number): number {
  return Math.log1p(x);
}

/** Numerically safe log-sum-exp of two logs. */
export function logAddExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}
