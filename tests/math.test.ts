/* Numerical correctness tests.
 *
 * Every expected value here comes from an independent source — a closed form, a
 * published table, or an identity that must hold exactly — never from running
 * this code and recording what it printed. A test that only asserts "it still
 * does what it did yesterday" cannot catch a routine that was wrong from the
 * start, and these routines are the ones every displayed number depends on.
 */

import { describe, expect, it } from 'vitest';
import {
  betaI,
  choose,
  erf,
  erfc,
  factorial,
  gammaFn,
  gammaP,
  invBetaI,
  invGammaP,
  invNormCdf,
  logGamma,
  normCdf,
} from '../src/core/math/specfun';
import { compileSource, SlotTable, normaliseInput, freeSymbols, parseExpression } from '../src/core/math/compile';
import { brent, derivative, findExtrema, findRoots, integrate, riemann, rk4, dopri5 } from '../src/core/math/numeric';
import { getDistribution } from '../src/core/math/distributions';
import { Rng } from '../src/core/math/random';
import {
  determinant,
  eigen,
  identity,
  intersectPlanes,
  intersectThreePlanes,
  inverse,
  multiply,
  rank,
  rref,
} from '../src/core/math/linalg';
import { andersonDarlingNormal, correlation, histogram, oneSampleT, summarise, twoSampleT } from '../src/core/math/stats';
import { levenbergMarquardt, linearFit, parseDelimited, polynomialFit } from '../src/core/math/fitting';
import { quantileBands, simulate, terminalValues } from '../src/core/math/simulate';
import { lyapunovExponent, detectPeriod, orbit, MAP_BY_ID } from '../src/core/math/fractals';
import { solvePde1d, divergence, curl } from '../src/core/math/fields';
import { sampleFunction, marchingSquares } from '../src/core/math/sampling';

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);
// Mixed absolute/relative tolerance: a purely relative check is meaningless
// when the expected value is exactly zero, which several of these are.
const relClose = (a: number, b: number, tol = 1e-8) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));

// ------------------------------------------------------------------ special functions

describe('special functions', () => {
  it('gamma matches known exact values', () => {
    close(gammaFn(1), 1, 1e-12);
    close(gammaFn(5), 24, 1e-9);
    close(gammaFn(0.5), Math.sqrt(Math.PI), 1e-12);
    close(gammaFn(1.5), Math.sqrt(Math.PI) / 2, 1e-12);
    // Γ(n) = (n−1)! must hold for every integer we can represent exactly.
    for (let n = 1; n <= 15; n++) relClose(gammaFn(n), factorial(n - 1), 1e-11);
  });

  it('logGamma satisfies the duplication formula', () => {
    // Γ(z)Γ(z+½) = 2^(1−2z)√π Γ(2z) — an identity, so any violation is a bug.
    for (const z of [0.3, 0.75, 1.4, 3.2, 9.9]) {
      const lhs = logGamma(z) + logGamma(z + 0.5);
      const rhs = (1 - 2 * z) * Math.LN2 + 0.5 * Math.log(Math.PI) + logGamma(2 * z);
      close(lhs, rhs, 1e-10);
    }
  });

  it('erf and erfc agree and hit published values', () => {
    close(erf(0), 0, 1e-15);
    close(erf(1), 0.842700792949715, 1e-12);
    close(erf(2), 0.995322265018953, 1e-12);
    close(erf(0.5), 0.5204998778130465, 1e-12);
    for (const x of [-3, -0.4, 0.1, 1.7, 4]) close(erf(x) + erfc(x), 1, 1e-12);
  });

  it('normal cdf matches the classical table to 12 digits', () => {
    close(normCdf(0), 0.5, 1e-15);
    close(normCdf(1), 0.8413447460685429, 1e-12);
    close(normCdf(-1.96), 0.024997895148220435, 1e-12);
    close(normCdf(2.5), 0.9937903346742238, 1e-12);
  });

  it('invNormCdf inverts normCdf across the whole range', () => {
    for (const p of [1e-12, 1e-6, 0.01, 0.025, 0.3, 0.5, 0.975, 0.999, 1 - 1e-9]) {
      relClose(normCdf(invNormCdf(p)), p, 1e-9);
    }
    close(invNormCdf(0.975), 1.959963984540054, 1e-11);
    close(invNormCdf(0.995), 2.5758293035489004, 1e-11);
  });

  it('incomplete gamma and beta invert correctly', () => {
    for (const a of [0.5, 1, 3.7, 20]) {
      for (const p of [0.01, 0.25, 0.5, 0.9, 0.999]) {
        relClose(gammaP(a, invGammaP(a, p)), p, 1e-8);
      }
    }
    for (const [a, b] of [
      [0.5, 0.5],
      [2, 5],
      [10, 3],
    ]) {
      for (const p of [0.02, 0.4, 0.95]) relClose(betaI(a, b, invBetaI(a, b, p)), p, 1e-8);
    }
  });

  it('binomial coefficients are exact', () => {
    expect(choose(5, 2)).toBe(10);
    expect(choose(52, 5)).toBe(2598960);
    expect(choose(10, 0)).toBe(1);
    expect(choose(10, 11)).toBe(0);
  });
});

// ------------------------------------------------------------------ distributions

describe('distributions', () => {
  it('every continuous density integrates to one over its window', () => {
    for (const d of ['normal', 't', 'chisq', 'exponential', 'gamma', 'beta', 'lognormal', 'weibull', 'logistic']) {
      const dist = getDistribution(d);
      const params = Object.fromEntries(dist.params.map((p) => [p.key, p.default]));
      const [lo, hi] = dist.window(params);
      const mass = integrate((x) => dist.pdf(x, params), lo, hi, 1e-10);
      // The window is only the central 99.9%-ish, so a little mass is outside.
      expect(mass.value).toBeGreaterThan(0.99);
      expect(mass.value).toBeLessThan(1.0001);
    }
  });

  it('every discrete pmf sums to one', () => {
    for (const d of ['binomial', 'poisson', 'geometric', 'negbinomial', 'hypergeometric', 'bernoulli']) {
      const dist = getDistribution(d);
      const params = Object.fromEntries(dist.params.map((p) => [p.key, p.default]));
      let sum = 0;
      for (let k = 0; k <= 2000; k++) sum += dist.pdf(k, params);
      close(sum, 1, 1e-8);
    }
  });

  it('cdf is the running sum of the pmf for discrete laws', () => {
    const binom = getDistribution('binomial');
    const p = { n: 20, p: 0.35 };
    let running = 0;
    for (let k = 0; k <= 20; k++) {
      running += binom.pdf(k, p);
      relClose(binom.cdf(k, p), running, 1e-9);
    }
  });

  it('quantile inverts cdf for continuous laws', () => {
    for (const d of ['normal', 't', 'chisq', 'f', 'exponential', 'gamma', 'beta', 'lognormal']) {
      const dist = getDistribution(d);
      const params = Object.fromEntries(dist.params.map((x) => [x.key, x.default]));
      for (const q of [0.001, 0.05, 0.5, 0.95, 0.999]) {
        relClose(dist.cdf(dist.quantile(q, params), params), q, 1e-6);
      }
    }
  });

  it('reproduces textbook critical values', () => {
    // t(0.975, 10) = 2.228, χ²(0.95, 5) = 11.070, F(0.95, 5, 10) = 3.326
    close(getDistribution('t').quantile(0.975, { df: 10 }), 2.2281388519649385, 1e-9);
    close(getDistribution('chisq').quantile(0.95, { df: 5 }), 11.070497693516351, 1e-8);
    close(getDistribution('f').quantile(0.95, { d1: 5, d2: 10 }), 3.325834530064746, 1e-7);
  });

  it('closed-form moments agree with numerical integration', () => {
    for (const d of ['normal', 'exponential', 'gamma', 'beta', 'weibull', 'logistic']) {
      const dist = getDistribution(d);
      const params = Object.fromEntries(dist.params.map((p) => [p.key, p.default]));
      const [lo, hi] = dist.support(params);
      const a = Number.isFinite(lo) ? lo : dist.window(params)[0] - 6;
      const b = Number.isFinite(hi) ? hi : dist.window(params)[1] + 6;
      const mean = integrate((x) => x * dist.pdf(x, params), a, b, 1e-11).value;
      relClose(mean, dist.mean(params), 2e-5);
    }
  });
});

// ------------------------------------------------------------------ expression compiler

describe('expression compiler', () => {
  const evalAt = (src: string, vars: Record<string, number> = {}) => {
    const slots = new SlotTable(Object.keys(vars));
    const fn = compileSource(src, { slots });
    const frame = slots.frame();
    for (const [k, v] of Object.entries(vars)) frame[slots.slot(k)] = v;
    return fn(frame);
  };

  it('evaluates arithmetic with correct precedence', () => {
    close(evalAt('2 + 3 * 4'), 14);
    close(evalAt('(2 + 3) * 4'), 20);
    close(evalAt('2^3^2'), 512); // right associative
    close(evalAt('-2^2'), -4);
    close(evalAt('10 % 3'), 1);
  });

  it('resolves variables through slots', () => {
    close(evalAt('a*x^2 + b*x + c', { a: 2, b: -3, c: 1, x: 4 }), 2 * 16 - 12 + 1);
  });

  it('handles the function library', () => {
    close(evalAt('sin(pi/2)'), 1, 1e-15);
    close(evalAt('log(8, 2)'), 3, 1e-12);
    close(evalAt('nCr(6,2)'), 15);
    close(evalAt('hypot(3,4)'), 5, 1e-12);
    close(evalAt('clamp(9, 0, 5)'), 5);
    close(evalAt('erf(1)'), 0.842700792949715, 1e-12);
  });

  it('supports conditionals both ways', () => {
    close(evalAt('x > 0 ? x : -x', { x: -7 }), 7);
    close(evalAt('if(x < 3, 10, 20)', { x: 1 }), 10);
  });

  it('normalises LaTeX input', () => {
    expect(normaliseInput('\\frac{a}{b}')).toBe('((a)/(b))');
    expect(normaliseInput('\\sqrt{x}')).toBe('sqrt(x)');
    expect(normaliseInput('\\sin\\left(x\\right)')).toBe('sin(x)');
    close(evalAt('\\frac{1}{2} + \\sqrt{16}'), 4.5, 1e-12);
  });

  it('reports free symbols for slider discovery', () => {
    const syms = freeSymbols(parseExpression('a*sin(k*x) + pi')).sort();
    expect(syms).toEqual(['a', 'k', 'x']);
  });

  it('rejects unknown functions rather than silently returning NaN', () => {
    expect(() => evalAt('frobnicate(2)')).toThrow(/Unknown function/);
  });

  it('is fast enough for interactive plotting', () => {
    const slots = new SlotTable(['x']);
    const fn = compileSource('sin(3*x)*exp(-x^2/8) + x^3/40', { slots });
    const frame = slots.frame();
    const xi = slots.slot('x');
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 200000; i++) {
      frame[xi] = i * 1e-4;
      acc += fn(frame);
    }
    const elapsed = performance.now() - t0;
    expect(Number.isFinite(acc)).toBe(true);
    // 200k evaluations of a five-call expression. mathjs's own evaluator needs
    // roughly a second for this; the closure tree should be far under 250ms
    // even on a slow machine.
    expect(elapsed).toBeLessThan(250);
  });
});

// ------------------------------------------------------------------ numerics

describe('numerical routines', () => {
  it('differentiates accurately', () => {
    close(derivative((x) => x * x * x, 2), 12, 1e-6);
    close(derivative(Math.sin, 1), Math.cos(1), 1e-8);
    close(derivative((x) => Math.exp(x), 0, 2), 1, 1e-5);
  });

  it('integrates to near machine precision', () => {
    relClose(integrate(Math.sin, 0, Math.PI).value, 2, 1e-11);
    relClose(integrate((x) => Math.exp(-x * x), -6, 6).value, Math.sqrt(Math.PI), 1e-10);
    relClose(integrate((x) => 1 / x, 1, Math.E).value, 1, 1e-11);
    // A function with a kink: adaptivity should still find it.
    relClose(integrate((x) => Math.abs(x), -1, 1).value, 1, 1e-8);
  });

  it('Riemann sums converge to the integral', () => {
    for (const rule of ['left', 'right', 'midpoint', 'trapezoid', 'simpson'] as const) {
      const s = riemann((x) => x * x, 0, 3, 20000, rule).sum;
      relClose(s, 9, rule === 'left' || rule === 'right' ? 1e-3 : 1e-7);
    }
  });

  it('finds roots and extrema', () => {
    const roots = findRoots((x) => Math.sin(x), -7, 7);
    expect(roots.length).toBe(5); // −2π, −π, 0, π, 2π
    close(roots[2], 0, 1e-9);
    close(brent((x) => x * x - 2, 0, 3)!, Math.SQRT2, 1e-11);

    const ex = findExtrema((x) => Math.sin(x), 0, 2 * Math.PI);
    const max = ex.find((e) => e.kind === 'max')!;
    close(max.x, Math.PI / 2, 1e-5);
  });

  it('does not mistake a pole for a root', () => {
    // tan has a sign change at π/2 but no root there.
    const roots = findRoots((x) => Math.tan(x), 1, 2);
    expect(roots.length).toBe(0);
  });

  it('RK4 integrates a known solution', () => {
    // y' = y, y(0) = 1 → y(1) = e
    const steps = rk4((_t, y, out) => { out[0] = y[0]; }, [1], 0, 1, 2000);
    relClose(steps[steps.length - 1].y[0], Math.E, 1e-10);
  });

  it('adaptive DOPRI5 handles a stiff-ish oscillator', () => {
    // Harmonic oscillator: energy must be conserved to the requested tolerance.
    const steps = dopri5(
      (_t, y, out) => {
        out[0] = y[1];
        out[1] = -y[0];
      },
      [1, 0],
      0,
      20,
      { rtol: 1e-10, atol: 1e-12 },
    );
    const last = steps[steps.length - 1];
    close(last.y[0], Math.cos(20), 1e-6);
    close(last.y[0] ** 2 + last.y[1] ** 2, 1, 1e-7);
  });
});

// ------------------------------------------------------------------ sampling

describe('plot sampling', () => {
  const view = { xMin: -10, xMax: 10, yMin: -5, yMax: 5, width: 800, height: 400 };

  it('produces one continuous segment for a smooth function', () => {
    const segs = sampleFunction(Math.sin, view);
    expect(segs.length).toBe(1);
    expect(segs[0].length).toBeGreaterThan(400);
  });

  it('breaks a curve at its poles', () => {
    const segs = sampleFunction(Math.tan, { ...view, xMin: -5, xMax: 5 });
    // tan has poles at ±π/2 and ±3π/2 inside [−5,5]: four breaks, five pieces.
    expect(segs.length).toBeGreaterThanOrEqual(4);
  });

  it('skips regions where the function is undefined', () => {
    const segs = sampleFunction((x) => Math.sqrt(x), view);
    expect(segs.length).toBe(1);
    // Nothing should be emitted to the left of zero.
    expect(segs[0].xs[0]).toBeGreaterThan(-0.2);
  });

  it('marching squares finds the unit circle', () => {
    const pts = marchingSquares((x, y) => x * x + y * y - 1, { ...view, xMin: -2, xMax: 2, yMin: -2, yMax: 2 }, 0, 300);
    expect(pts.length).toBeGreaterThan(100);
    for (let i = 0; i < pts.length; i += 2) {
      const r = Math.hypot(pts[i], pts[i + 1]);
      expect(Math.abs(r - 1)).toBeLessThan(0.02);
    }
  });
});

// ------------------------------------------------------------------ linear algebra

describe('linear algebra', () => {
  it('computes determinants', () => {
    close(determinant([[1, 2], [3, 4]]), -2, 1e-12);
    close(determinant([[2, 0, 1], [1, 3, 2], [1, 1, 1]]), 2 * (3 - 2) - 0 + 1 * (1 - 3), 1e-12);
    close(determinant(identity(5)), 1, 1e-12);
  });

  it('inverts and round-trips', () => {
    const a = [[4, 7, 2], [3, 6, 1], [2, 5, 3]];
    const inv = inverse(a)!;
    const prod = multiply(a, inv);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(prod[i][j], i === j ? 1 : 0, 1e-10);
  });

  it('detects singularity through rank', () => {
    expect(inverse([[1, 2], [2, 4]])).toBeNull();
    expect(rank([[1, 2], [2, 4]])).toBe(1);
    expect(rank([[1, 0, 0], [0, 1, 0], [0, 0, 0]])).toBe(2);
  });

  it('reduces to RREF', () => {
    const r = rref([[1, 2, -1, -4], [2, 3, -1, -11], [-2, 0, -3, 22]]);
    expect(r.rank).toBe(3);
    // The unique solution of this classic system is (−8, 1, −2).
    close(r.matrix[0][3], -8, 1e-10);
    close(r.matrix[1][3], 1, 1e-10);
    close(r.matrix[2][3], -2, 1e-10);
  });

  it('finds eigenvalues of a symmetric matrix', () => {
    const e = eigen([[2, 1], [1, 2]]);
    const vals = e.values.map((v) => v.re).sort((a, b) => a - b);
    close(vals[0], 1, 1e-10);
    close(vals[1], 3, 1e-10);
  });

  it('reports complex eigenvalues for a rotation', () => {
    const e = eigen([[0, -1], [1, 0]]);
    expect(Math.abs(e.values[0].im)).toBeGreaterThan(0.5);
    close(e.values[0].re, 0, 1e-12);
  });

  it('Av = λv holds for the returned eigenvectors', () => {
    const a = [[4, 1], [2, 3]];
    const e = eigen(a);
    e.values.forEach((lam, i) => {
      const v = e.vectors[i];
      if (!v || Math.abs(lam.im) > 1e-12) return;
      const av = [a[0][0] * v[0] + a[0][1] * v[1], a[1][0] * v[0] + a[1][1] * v[1]];
      close(av[0], lam.re * v[0], 1e-8);
      close(av[1], lam.re * v[1], 1e-8);
    });
  });

  it('intersects two planes in a line', () => {
    // x + y + z = 1 and x − y = 0 meet in a line through (0.5, 0.5, 0).
    const r = intersectPlanes({ a: 1, b: 1, c: 1, d: 1 }, { a: 1, b: -1, c: 0, d: 0 });
    expect(r.kind).toBe('line');
    if (r.kind === 'line') {
      // The point must satisfy both equations.
      close(r.point[0] + r.point[1] + r.point[2], 1, 1e-10);
      close(r.point[0] - r.point[1], 0, 1e-10);
      // The direction must be orthogonal to both normals.
      close(r.direction[0] + r.direction[1] + r.direction[2], 0, 1e-10);
      close(r.direction[0] - r.direction[1], 0, 1e-10);
    }
  });

  it('classifies parallel and coincident planes', () => {
    expect(intersectPlanes({ a: 1, b: 0, c: 0, d: 1 }, { a: 2, b: 0, c: 0, d: 5 }).kind).toBe('parallel');
    expect(intersectPlanes({ a: 1, b: 0, c: 0, d: 1 }, { a: 2, b: 0, c: 0, d: 2 }).kind).toBe('coincident');
  });

  it('intersects three planes in a point, a line, or nothing', () => {
    const pt = intersectThreePlanes(
      { a: 1, b: 0, c: 0, d: 2 },
      { a: 0, b: 1, c: 0, d: 3 },
      { a: 0, b: 0, c: 1, d: 4 },
    );
    expect(pt.kind).toBe('point');
    if (pt.kind === 'point') {
      close(pt.point[0], 2, 1e-10);
      close(pt.point[1], 3, 1e-10);
      close(pt.point[2], 4, 1e-10);
    }
    // A triangular prism: pairwise intersections exist but no common point.
    const prism = intersectThreePlanes(
      { a: 1, b: 0, c: 0, d: 0 },
      { a: 0, b: 1, c: 0, d: 0 },
      { a: 1, b: 1, c: 0, d: 1 },
    );
    expect(prism.kind).toBe('none');
  });
});

// ------------------------------------------------------------------ statistics

describe('statistics', () => {
  const data = [2, 4, 4, 4, 5, 5, 7, 9];

  it('summarises correctly', () => {
    const s = summarise(data);
    close(s.mean, 5, 1e-12);
    close(s.sd, Math.sqrt(32 / 7), 1e-12); // sample sd with n−1
    close(s.median, 4.5, 1e-12);
    expect(s.n).toBe(8);
  });

  it('builds histograms whose counts sum to n', () => {
    const h = histogram(data, 'sturges');
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(8);
    const area = h.density.reduce((a, b) => a + b * h.binWidth, 0);
    close(area, 1, 1e-12);
  });

  it('reproduces a textbook one-sample t-test', () => {
    // n = 8, x̄ = 5, s = √(32/7) ≈ 2.138, μ₀ = 4 → t = 1/(s/√8) ≈ 1.3229
    const r = oneSampleT(data, 4);
    close(r.statistic, 1 / (Math.sqrt(32 / 7) / Math.sqrt(8)), 1e-10);
    expect(r.pValue).toBeGreaterThan(0.2);
    expect(r.pValue).toBeLessThan(0.3);
  });

  it("Welch's t-test recovers a known difference", () => {
    const a = [27, 20, 21, 26, 27, 31, 24, 21, 20, 19];
    const b = [17, 12, 13, 12, 20, 16, 18, 17, 14, 12];
    const r = twoSampleT(a, b);
    expect(r.statistic).toBeGreaterThan(4);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.interval![0]).toBeGreaterThan(0);
  });

  it('correlation is exactly 1 for a perfect line', () => {
    const x = [1, 2, 3, 4, 5];
    const r = correlation(x, x.map((v) => 3 * v + 1));
    close(r.r, 1, 1e-12);
  });

  it('Anderson–Darling accepts normal data and rejects a uniform sample', () => {
    const rng = new Rng(42);
    const normals = Array.from({ length: 400 }, () => rng.normal());
    const uniforms = Array.from({ length: 400 }, () => rng.uniform(-2, 2));
    expect(andersonDarlingNormal(normals).pValue).toBeGreaterThan(0.05);
    expect(andersonDarlingNormal(uniforms).pValue).toBeLessThan(0.05);
  });
});

// ------------------------------------------------------------------ random

describe('seeded randomness', () => {
  it('is reproducible from a seed', () => {
    const a = new Rng('manifold');
    const b = new Rng('manifold');
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('different seeds diverge immediately', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it('uniforms cover the unit interval evenly', () => {
    const rng = new Rng(7);
    const bins = new Array(10).fill(0);
    const n = 200000;
    for (let i = 0; i < n; i++) bins[Math.floor(rng.next() * 10)]++;
    // Each bin should hold n/10 ± a few standard deviations.
    const sd = Math.sqrt(n * 0.1 * 0.9);
    for (const c of bins) expect(Math.abs(c - n / 10)).toBeLessThan(5 * sd);
  });

  it('normal draws have the right moments', () => {
    const rng = new Rng(11);
    const n = 200000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const z = rng.normal();
      s += z;
      s2 += z * z;
    }
    close(s / n, 0, 0.02);
    close(s2 / n, 1, 0.02);
  });

  it('gamma and poisson draws have the right means', () => {
    const rng = new Rng(3);
    const n = 60000;
    let g = 0;
    let p = 0;
    for (let i = 0; i < n; i++) {
      g += rng.gamma(3, 2);
      p += rng.poisson(40);
    }
    relClose(g / n, 6, 0.03);
    relClose(p / n, 40, 0.02);
  });
});

// ------------------------------------------------------------------ simulation

describe('stochastic simulation', () => {
  it('GBM reproduces its analytic mean and variance', () => {
    const params = { s0: 100, mu: 0.05, sigma: 0.2, T: 1 };
    const e = simulate({ process: 'gbm', params, steps: 250, paths: 40000, seed: 'test' });
    const terminal = Array.from(terminalValues(e));
    const mean = terminal.reduce((a, b) => a + b, 0) / terminal.length;
    // E[S_T] = S₀e^{μT}; the Monte Carlo error at 40k paths is about 0.1%.
    relClose(mean, 100 * Math.exp(0.05), 0.01);

    const logs = terminal.map(Math.log);
    const lm = logs.reduce((a, b) => a + b, 0) / logs.length;
    const lv = logs.reduce((a, b) => a + (b - lm) ** 2, 0) / logs.length;
    close(lm, Math.log(100) + (0.05 - 0.02) * 1, 0.01);
    close(lv, 0.04, 0.002);
  });

  it('is bit-for-bit reproducible', () => {
    const opts = { process: 'gbm' as const, params: { s0: 100, mu: 0.05, sigma: 0.3, T: 2 }, steps: 100, paths: 50, seed: 99 };
    const a = simulate(opts);
    const b = simulate(opts);
    expect(Array.from(a.values)).toEqual(Array.from(b.values));
  });

  it('OU reverts to its long-run mean', () => {
    const e = simulate({
      process: 'ou',
      params: { x0: 10, theta: 2, kappa: 5, sigma: 0.5, T: 5 },
      steps: 500,
      paths: 5000,
      seed: 5,
    });
    const terminal = Array.from(terminalValues(e));
    const mean = terminal.reduce((a, b) => a + b, 0) / terminal.length;
    close(mean, 2, 0.05);
    // Stationary variance is σ²/(2κ) = 0.025.
    const v = terminal.reduce((a, b) => a + (b - mean) ** 2, 0) / terminal.length;
    close(v, 0.025, 0.005);
  });

  it('quantile bands are ordered at every step', () => {
    const e = simulate({ process: 'gbm', params: { s0: 100, mu: 0, sigma: 0.4, T: 1 }, steps: 60, paths: 800, seed: 1 });
    const bands = quantileBands(e, [0.05, 0.25, 0.5, 0.75, 0.95]);
    for (let k = 0; k <= e.steps; k++) {
      for (let i = 1; i < bands.curves.length; i++) {
        expect(bands.curves[i][k]).toBeGreaterThanOrEqual(bands.curves[i - 1][k]);
      }
    }
  });
});

// ------------------------------------------------------------------ fitting

describe('curve fitting', () => {
  it('recovers an exact line', () => {
    const x = [0, 1, 2, 3, 4, 5];
    const y = x.map((v) => 3.5 * v - 2);
    const fit = linearFit(x, y);
    close(fit.slope, 3.5, 1e-10);
    close(fit.intercept, -2, 1e-10);
    close(fit.r2, 1, 1e-12);
  });

  it('recovers polynomial coefficients through the scaled basis', () => {
    const x = Array.from({ length: 40 }, (_, i) => 1000 + i * 25);
    const y = x.map((v) => 2e-6 * v * v - 0.01 * v + 7);
    const fit = polynomialFit(x, y, 2);
    // The coefficients live in the scaled basis, so check predictions instead.
    for (const v of [1050, 1500, 1900]) relClose(fit.predict(v), 2e-6 * v * v - 0.01 * v + 7, 1e-6);
    expect(fit.r2).toBeGreaterThan(0.999999);
  });

  it('Levenberg–Marquardt recovers a logistic curve from noisy data', () => {
    const rng = new Rng(21);
    const truth = [12, 0.8, 5];
    const model = (x: number, p: readonly number[]) => p[0] / (1 + Math.exp(-p[1] * (x - p[2])));
    const x = Array.from({ length: 60 }, (_, i) => i * 0.2);
    const y = x.map((v) => model(v, truth) + rng.normal(0, 0.15));
    const fit = levenbergMarquardt(x, y, model, [10, 1, 4], ['L', 'k', 'x0']);
    relClose(fit.params[0], truth[0], 0.05);
    relClose(fit.params[1], truth[1], 0.15);
    relClose(fit.params[2], truth[2], 0.05);
    expect(fit.r2).toBeGreaterThan(0.99);
  });

  it('parses CSV with a header and quoted fields', () => {
    const t = parseDelimited('x,y,label\n1,2.5,"a, b"\n3,4.5,c\n');
    expect(t.columns).toEqual(['x', 'y', 'label']);
    expect(t.rows.length).toBe(2);
    expect(t.rows[0][2]).toBe('a, b');
    expect(t.numericColumns).toEqual([0, 1]);
  });
});

// ------------------------------------------------------------------ dynamics

describe('dynamical systems', () => {
  it('the logistic map has the expected periods', () => {
    const f = MAP_BY_ID.get('logistic')!.f;
    expect(detectPeriod(orbit(f, 2.8, 0.4, 2000, 200), 1e-8)).toBe(1);
    expect(detectPeriod(orbit(f, 3.2, 0.4, 5000, 200), 1e-8)).toBe(2);
    expect(detectPeriod(orbit(f, 3.5, 0.4, 8000, 200), 1e-8)).toBe(4);
  });

  it('the Lyapunov exponent is negative in the stable window and positive in chaos', () => {
    const f = MAP_BY_ID.get('logistic')!.f;
    expect(lyapunovExponent(f, 2.8, 0.4)).toBeLessThan(0);
    expect(lyapunovExponent(f, 4, 0.4)).toBeGreaterThan(0.6);
    // λ = ln 2 exactly at r = 4, a known closed form.
    close(lyapunovExponent(f, 4, 0.4, 2000, 40000), Math.LN2, 0.02);
  });
});

// ------------------------------------------------------------------ fields & PDE

describe('vector fields and PDEs', () => {
  it('divergence and curl match closed forms', () => {
    // F = (x, y): divergence 2, curl 0.
    close(divergence((x, y) => [x, y], 1, 1), 2, 1e-6);
    close(curl((x, y) => [x, y], 1, 1), 0, 1e-6);
    // F = (−y, x): divergence 0, curl 2.
    close(divergence((x, y) => [-y, x], 2, 3), 0, 1e-6);
    close(curl((x, y) => [-y, x], 2, 3), 2, 1e-6);
  });

  it('the heat equation decays towards zero and conserves nothing but positivity', () => {
    const r = solvePde1d({
      kind: 'heat1d',
      coefficient: 0.5,
      length: 1,
      nodes: 101,
      frames: 40,
      duration: 0.5,
      boundary: 'dirichlet',
      initial: (x) => Math.sin(Math.PI * x),
    });
    // The exact solution is sin(πx)e^{−απ²t}; check the midpoint amplitude.
    const mid = Math.floor(r.nodeCount / 2);
    const last = r.frames[(r.frameCount - 1) * r.nodeCount + mid];
    const expected = Math.exp(-0.5 * Math.PI * Math.PI * 0.5);
    expect(Math.abs(last - expected) / expected).toBeLessThan(0.02);
    expect(last).toBeGreaterThan(0);
  });

  it('the wave equation stays bounded (the CFL substepping works)', () => {
    const r = solvePde1d({
      kind: 'wave1d',
      coefficient: 1,
      length: 1,
      nodes: 201,
      // A frame step far larger than the stable one: without substepping this
      // blows up to infinity within a dozen frames.
      frames: 60,
      duration: 2,
      boundary: 'dirichlet',
      initial: (x) => Math.exp(-200 * (x - 0.5) ** 2),
    });
    expect(r.substepped).toBe(true);
    for (const v of r.frames) expect(Math.abs(v)).toBeLessThan(2);
  });
});
