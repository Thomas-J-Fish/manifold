/* Seeded pseudo-random number generation.
 *
 * Monte Carlo results that cannot be reproduced are not results, so nothing in
 * this app ever calls Math.random. Every stochastic path is generated from an
 * explicit seed that is saved with the project; reopening a project and
 * pressing play gives back the identical ensemble.
 *
 * The generator is xoshiro128**, chosen over the more obvious LCG or
 * `Math.random` because it passes BigCrush, has a 2^128 period, and produces
 * good low-order bits — which matters here since the Box–Muller transform
 * feeds them straight into a logarithm.
 */

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  /** Cached second normal deviate from the last Box–Muller pair. */
  private spare: number | null = null;

  constructor(seed: number | string = 1) {
    this.reseed(seed);
  }

  reseed(seed: number | string): void {
    // splitmix64-style scrambling of a single seed into four words; seeding all
    // four from the same small integer directly would correlate early output.
    let h = typeof seed === 'string' ? hashString(seed) : Math.trunc(seed) || 1;
    const next = () => {
      h = (h + 0x9e3779b9) | 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    this.spare = null;
  }

  /** Raw 32-bit output — the xoshiro128** step, transcribed exactly. */
  nextUint32(): number {
    const scaled = Math.imul(this.s1, 5) >>> 0;
    const rotated = ((scaled << 7) | (scaled >>> 25)) >>> 0;
    const result = Math.imul(rotated, 9) >>> 0;

    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return result;
  }

  /** Uniform on [0,1). 53 bits of entropy, as a double deserves. */
  next(): number {
    const hi = this.nextUint32() >>> 5; // 27 bits
    const lo = this.nextUint32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  /** Uniform on (0,1) — excludes the endpoints, for use inside logs. */
  nextOpen(): number {
    let u = this.next();
    while (u === 0) u = this.next();
    return u;
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Standard normal by the polar Box–Muller method, which avoids the two
   *  trigonometric calls of the basic form and caches the second deviate. */
  normal(mu = 0, sigma = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mu + sigma * v;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = 2 * this.next() - 1;
      v = 2 * this.next() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * f;
    return mu + sigma * u * f;
  }

  exponential(rate = 1): number {
    return -Math.log(this.nextOpen()) / rate;
  }

  /** Marsaglia–Tsang rejection sampler; the standard modern choice. */
  gamma(shape: number, scale = 1): number {
    if (shape < 1) {
      // Boost a sub-unit shape into the valid range and correct afterwards.
      return this.gamma(shape + 1, scale) * Math.pow(this.nextOpen(), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.nextOpen();
      const x2 = x * x;
      if (u < 1 - 0.0331 * x2 * x2) return d * v * scale;
      if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x / (x + y);
  }

  chiSquared(df: number): number {
    return this.gamma(df / 2, 2);
  }

  studentT(df: number): number {
    return this.normal() / Math.sqrt(this.chiSquared(df) / df);
  }

  /** Knuth for small means, Poisson-by-inversion via PTRS-style rejection for
   *  large ones — Knuth alone is O(λ) and stalls badly past λ ≈ 50. */
  poisson(lambda: number): number {
    if (lambda < 30) {
      const L = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.next();
      } while (p > L);
      return k - 1;
    }
    const c = 0.767 - 3.36 / lambda;
    const beta = Math.PI / Math.sqrt(3 * lambda);
    const alpha = beta * lambda;
    const k = Math.log(c) - lambda - Math.log(beta);
    for (;;) {
      const u = this.nextOpen();
      const x = (alpha - Math.log((1 - u) / u)) / beta;
      const n = Math.floor(x + 0.5);
      if (n < 0) continue;
      const v = this.nextOpen();
      const y = alpha - beta * x;
      const t = 1 + Math.exp(y);
      const lhs = y + Math.log(v / (t * t));
      const rhs = k + n * Math.log(lambda) - logFactorialFast(n);
      if (lhs <= rhs) return n;
    }
  }

  bernoulli(p: number): number {
    return this.next() < p ? 1 : 0;
  }

  binomial(n: number, p: number): number {
    if (n * Math.min(p, 1 - p) < 25) {
      let k = 0;
      for (let i = 0; i < n; i++) if (this.next() < p) k++;
      return k;
    }
    // Normal approximation with a continuity correction, clamped to support.
    const mu = n * p;
    const sd = Math.sqrt(n * p * (1 - p));
    const v = Math.round(this.normal(mu, sd));
    return Math.max(0, Math.min(n, v));
  }

  geometric(p: number): number {
    return Math.floor(Math.log(this.nextOpen()) / Math.log(1 - p));
  }

  /** Picks an index according to weights that need not sum to one. */
  categorical(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let u = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      u -= weights[i];
      if (u <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

const LOGFACT_CACHE: number[] = [0, 0];
function logFactorialFast(n: number): number {
  if (n < LOGFACT_CACHE.length) return LOGFACT_CACHE[n];
  let last = LOGFACT_CACHE[LOGFACT_CACHE.length - 1];
  for (let i = LOGFACT_CACHE.length; i <= n; i++) {
    last += Math.log(i);
    LOGFACT_CACHE[i] = last;
  }
  return LOGFACT_CACHE[n];
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A short human-typable seed, so a user can share "try seed 8f3a2c". */
export function randomSeedString(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}
