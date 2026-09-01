/* Stochastic process simulation.
 *
 * Every process here is discretised on a uniform time grid and driven by an
 * explicitly seeded generator, so a run is reproducible from the project file
 * alone. Where an exact discretisation exists — geometric Brownian motion and
 * the Ornstein–Uhlenbeck process both have one — it is used in preference to
 * Euler–Maruyama, since the exact scheme has no discretisation bias at any step
 * size and costs the same per step.
 */

import { Rng } from './random';
import { quantileOf } from './stats';

export type ProcessId = 'gbm' | 'ou' | 'jump' | 'walk' | 'heston' | 'custom';

export interface ProcessParam {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  /** Units or a short note shown beside the slider. */
  hint?: string;
}

export interface ProcessSpec {
  id: ProcessId;
  name: string;
  blurb: string;
  params: ProcessParam[];
  /** Latex for the governing SDE, rendered above the controls. */
  sde: string;
  /** True when the process can go negative, which changes the default axis. */
  signed: boolean;
}

export const PROCESSES: ProcessSpec[] = [
  {
    id: 'gbm',
    name: 'Geometric Brownian motion',
    blurb: 'The Black–Scholes price process: proportional returns, log-normal at every horizon.',
    sde: 'dS_t = \\mu S_t\\,dt + \\sigma S_t\\,dW_t',
    signed: false,
    params: [
      { key: 's0', label: 'S₀ — initial price', default: 100, min: 1, max: 1000, step: 1 },
      { key: 'mu', label: 'μ — drift', default: 0.08, min: -0.5, max: 0.5, step: 0.005, hint: 'per year' },
      { key: 'sigma', label: 'σ — volatility', default: 0.2, min: 0.001, max: 1.5, step: 0.005, hint: 'per √year' },
      { key: 'T', label: 'T — horizon', default: 1, min: 0.05, max: 30, step: 0.05, hint: 'years' },
    ],
  },
  {
    id: 'ou',
    name: 'Ornstein–Uhlenbeck',
    blurb: 'Mean reversion: the process is pulled back towards θ at rate κ. Interest rates, spreads, temperature.',
    sde: 'dX_t = \\kappa(\\theta - X_t)\\,dt + \\sigma\\,dW_t',
    signed: true,
    params: [
      { key: 'x0', label: 'X₀ — initial level', default: 1, min: -50, max: 50, step: 0.1 },
      { key: 'theta', label: 'θ — long-run mean', default: 0, min: -50, max: 50, step: 0.1 },
      { key: 'kappa', label: 'κ — reversion speed', default: 2, min: 0.01, max: 20, step: 0.01 },
      { key: 'sigma', label: 'σ — volatility', default: 0.5, min: 0.001, max: 10, step: 0.005 },
      { key: 'T', label: 'T — horizon', default: 3, min: 0.05, max: 50, step: 0.05 },
    ],
  },
  {
    id: 'jump',
    name: 'Merton jump diffusion',
    blurb: 'GBM plus Poisson-timed jumps — the standard way to put fat tails and crashes into a price path.',
    sde: 'dS_t = \\mu S_t\\,dt + \\sigma S_t\\,dW_t + S_{t^-}(e^{J}-1)\\,dN_t',
    signed: false,
    params: [
      { key: 's0', label: 'S₀ — initial price', default: 100, min: 1, max: 1000, step: 1 },
      { key: 'mu', label: 'μ — drift', default: 0.08, min: -0.5, max: 0.5, step: 0.005 },
      { key: 'sigma', label: 'σ — diffusive volatility', default: 0.18, min: 0.001, max: 1.5, step: 0.005 },
      { key: 'lambda', label: 'λ — jump intensity', default: 1, min: 0, max: 20, step: 0.05, hint: 'jumps per year' },
      { key: 'jumpMean', label: 'μ_J — mean log jump', default: -0.05, min: -1, max: 1, step: 0.005 },
      { key: 'jumpSd', label: 'σ_J — jump volatility', default: 0.12, min: 0.001, max: 1, step: 0.005 },
      { key: 'T', label: 'T — horizon', default: 1, min: 0.05, max: 30, step: 0.05 },
    ],
  },
  {
    id: 'heston',
    name: 'Heston stochastic volatility',
    blurb: 'Volatility itself follows a mean-reverting square-root process, correlated with the price.',
    sde: 'dS_t = \\mu S_t dt + \\sqrt{v_t}S_t dW^1_t,\\quad dv_t = \\kappa(\\theta - v_t)dt + \\xi\\sqrt{v_t}dW^2_t',
    signed: false,
    params: [
      { key: 's0', label: 'S₀ — initial price', default: 100, min: 1, max: 1000, step: 1 },
      { key: 'v0', label: 'v₀ — initial variance', default: 0.04, min: 0.0001, max: 1, step: 0.001 },
      { key: 'mu', label: 'μ — drift', default: 0.06, min: -0.5, max: 0.5, step: 0.005 },
      { key: 'kappa', label: 'κ — variance reversion', default: 2, min: 0.01, max: 20, step: 0.01 },
      { key: 'theta', label: 'θ — long-run variance', default: 0.04, min: 0.0001, max: 1, step: 0.001 },
      { key: 'xi', label: 'ξ — vol of vol', default: 0.4, min: 0.001, max: 3, step: 0.005 },
      { key: 'rho', label: 'ρ — correlation', default: -0.7, min: -0.99, max: 0.99, step: 0.01 },
      { key: 'T', label: 'T — horizon', default: 1, min: 0.05, max: 30, step: 0.05 },
    ],
  },
  {
    id: 'walk',
    name: 'Random walk',
    blurb: 'The discrete ancestor of Brownian motion: independent steps of fixed size.',
    sde: 'X_{k+1} = X_k + \\sigma\\,\\varepsilon_k',
    signed: true,
    params: [
      { key: 'x0', label: 'X₀ — start', default: 0, min: -100, max: 100, step: 1 },
      { key: 'drift', label: 'per-step drift', default: 0, min: -2, max: 2, step: 0.01 },
      { key: 'sigma', label: 'step size', default: 1, min: 0.01, max: 20, step: 0.01 },
      { key: 'T', label: 'T — horizon', default: 1, min: 0.05, max: 30, step: 0.05 },
    ],
  },
];

export const PROCESS_BY_ID = new Map(PROCESSES.map((p) => [p.id, p]));

export interface EnsembleOptions {
  process: ProcessId;
  params: Record<string, number>;
  steps: number;
  paths: number;
  seed: number | string;
  /** Antithetic variates halve the variance of the mean estimator for free. */
  antithetic?: boolean;
  /** Expression pair for the custom process: drift and diffusion in x and t. */
  custom?: { drift: (x: number, t: number) => number; diffusion: (x: number, t: number) => number; x0: number; T: number };
}

export interface Ensemble {
  /** Uniform time grid, length steps+1. */
  times: Float64Array;
  /** Row-major paths: path p, step k is at p*(steps+1)+k. */
  values: Float64Array;
  paths: number;
  steps: number;
  /** Any secondary state worth plotting (Heston's variance path). */
  auxiliary?: { label: string; values: Float64Array };
}

/**
 * Runs the ensemble. This is a tight numeric loop over a flat Float64Array
 * rather than an array of path objects: at 2000 paths × 500 steps that is one
 * million numbers, and the boxed-object version spends more time in the garbage
 * collector than in the arithmetic.
 */
export function simulate(opts: EnsembleOptions): Ensemble {
  const { steps, paths } = opts;
  const rng = new Rng(opts.seed);
  const p = opts.params;
  const T = opts.custom?.T ?? p.T ?? 1;
  const dt = T / steps;
  const sqrtDt = Math.sqrt(dt);
  const stride = steps + 1;
  const values = new Float64Array(paths * stride);
  const times = new Float64Array(stride);
  for (let k = 0; k <= steps; k++) times[k] = k * dt;

  // Antithetic pairing reuses each normal draw with its sign flipped, which
  // cancels the odd-order error terms in the mean without extra work.
  const anti = opts.antithetic ?? false;
  let bufferedNormals: Float64Array | null = null;

  const drawNormals = (n: number, pathIndex: number): Float64Array => {
    if (!anti) {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = rng.normal();
      return out;
    }
    if (pathIndex % 2 === 0 || !bufferedNormals) {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = rng.normal();
      bufferedNormals = out;
      return out;
    }
    const mirrored = new Float64Array(n);
    for (let i = 0; i < n; i++) mirrored[i] = -bufferedNormals[i];
    bufferedNormals = null;
    return mirrored;
  };

  switch (opts.process) {
    case 'gbm': {
      const s0 = p.s0 ?? 100;
      const mu = p.mu ?? 0;
      const sigma = p.sigma ?? 0.2;
      // Exact solution of the SDE, so there is no Euler discretisation bias:
      // S_{k+1} = S_k · exp((μ − σ²/2)dt + σ√dt·Z).
      const drift = (mu - 0.5 * sigma * sigma) * dt;
      const vol = sigma * sqrtDt;
      for (let i = 0; i < paths; i++) {
        const z = drawNormals(steps, i);
        let logS = Math.log(s0);
        values[i * stride] = s0;
        for (let k = 0; k < steps; k++) {
          logS += drift + vol * z[k];
          values[i * stride + k + 1] = Math.exp(logS);
        }
      }
      break;
    }

    case 'ou': {
      const x0 = p.x0 ?? 0;
      const theta = p.theta ?? 0;
      const kappa = p.kappa ?? 1;
      const sigma = p.sigma ?? 1;
      // Exact transition density: X_{k+1} | X_k is normal with mean
      // θ + (X_k − θ)e^{−κ dt} and variance σ²(1 − e^{−2κ dt})/(2κ).
      const decay = Math.exp(-kappa * dt);
      const sd = kappa > 0 ? sigma * Math.sqrt((1 - decay * decay) / (2 * kappa)) : sigma * sqrtDt;
      for (let i = 0; i < paths; i++) {
        const z = drawNormals(steps, i);
        let x = x0;
        values[i * stride] = x;
        for (let k = 0; k < steps; k++) {
          x = theta + (x - theta) * decay + sd * z[k];
          values[i * stride + k + 1] = x;
        }
      }
      break;
    }

    case 'jump': {
      const s0 = p.s0 ?? 100;
      const mu = p.mu ?? 0;
      const sigma = p.sigma ?? 0.2;
      const lambda = p.lambda ?? 1;
      const jm = p.jumpMean ?? 0;
      const js = p.jumpSd ?? 0.1;
      // The compensator keeps E[S_T] equal to the pure-drift case, so changing
      // the jump intensity does not silently change the expected return.
      const kappaJ = Math.exp(jm + 0.5 * js * js) - 1;
      const drift = (mu - lambda * kappaJ - 0.5 * sigma * sigma) * dt;
      const vol = sigma * sqrtDt;
      for (let i = 0; i < paths; i++) {
        const z = drawNormals(steps, i);
        let logS = Math.log(s0);
        values[i * stride] = s0;
        for (let k = 0; k < steps; k++) {
          logS += drift + vol * z[k];
          const jumps = rng.poisson(lambda * dt);
          for (let j = 0; j < jumps; j++) logS += rng.normal(jm, js);
          values[i * stride + k + 1] = Math.exp(logS);
        }
      }
      break;
    }

    case 'heston': {
      const s0 = p.s0 ?? 100;
      const v0 = p.v0 ?? 0.04;
      const mu = p.mu ?? 0;
      const kappa = p.kappa ?? 2;
      const theta = p.theta ?? 0.04;
      const xi = p.xi ?? 0.4;
      const rho = Math.max(-0.999, Math.min(0.999, p.rho ?? -0.7));
      const rhoBar = Math.sqrt(1 - rho * rho);
      const variance = new Float64Array(paths * stride);
      for (let i = 0; i < paths; i++) {
        let s = s0;
        let v = v0;
        values[i * stride] = s;
        variance[i * stride] = v;
        for (let k = 0; k < steps; k++) {
          const z1 = rng.normal();
          const z2 = rho * z1 + rhoBar * rng.normal();
          // Full-truncation Euler: variance is floored at zero before use,
          // which is the scheme with the smallest bias among the simple fixes
          // for the square-root process going negative.
          const vPos = Math.max(v, 0);
          const sqrtV = Math.sqrt(vPos);
          s *= Math.exp((mu - 0.5 * vPos) * dt + sqrtV * sqrtDt * z1);
          v = v + kappa * (theta - vPos) * dt + xi * sqrtV * sqrtDt * z2;
          values[i * stride + k + 1] = s;
          variance[i * stride + k + 1] = Math.max(v, 0);
        }
      }
      return {
        times,
        values,
        paths,
        steps,
        auxiliary: { label: 'Instantaneous variance', values: variance },
      };
    }

    case 'walk': {
      const x0 = p.x0 ?? 0;
      const drift = p.drift ?? 0;
      const sigma = p.sigma ?? 1;
      for (let i = 0; i < paths; i++) {
        const z = drawNormals(steps, i);
        let x = x0;
        values[i * stride] = x;
        for (let k = 0; k < steps; k++) {
          x += drift + sigma * z[k];
          values[i * stride + k + 1] = x;
        }
      }
      break;
    }

    case 'custom': {
      const c = opts.custom;
      if (!c) break;
      // Euler–Maruyama, the only general scheme available when the drift and
      // diffusion are arbitrary user expressions.
      for (let i = 0; i < paths; i++) {
        const z = drawNormals(steps, i);
        let x = c.x0;
        values[i * stride] = x;
        for (let k = 0; k < steps; k++) {
          const t = k * dt;
          const a = c.drift(x, t);
          const b = c.diffusion(x, t);
          x += (Number.isFinite(a) ? a : 0) * dt + (Number.isFinite(b) ? b : 0) * sqrtDt * z[k];
          if (!Number.isFinite(x)) x = 0;
          values[i * stride + k + 1] = x;
        }
      }
      break;
    }
  }

  return { times, values, paths, steps };
}

export interface Bands {
  times: Float64Array;
  /** One row per requested quantile, each of length steps+1. */
  levels: number[];
  curves: Float64Array[];
  mean: Float64Array;
}

/** Cross-sectional quantiles at each time step — the fan chart. */
export function quantileBands(e: Ensemble, levels: number[]): Bands {
  const stride = e.steps + 1;
  const curves = levels.map(() => new Float64Array(stride));
  const mean = new Float64Array(stride);
  const column = new Float64Array(e.paths);
  for (let k = 0; k < stride; k++) {
    let sum = 0;
    for (let i = 0; i < e.paths; i++) {
      const v = e.values[i * stride + k];
      column[i] = v;
      sum += v;
    }
    mean[k] = sum / e.paths;
    const sorted = Array.from(column).sort((a, b) => a - b);
    levels.forEach((q, li) => {
      curves[li][k] = quantileOf(sorted, q);
    });
  }
  return { times: e.times, levels, curves, mean };
}

export function terminalValues(e: Ensemble): Float64Array {
  const stride = e.steps + 1;
  const out = new Float64Array(e.paths);
  for (let i = 0; i < e.paths; i++) out[i] = e.values[i * stride + e.steps];
  return out;
}

export interface RiskSummary {
  mean: number;
  median: number;
  sd: number;
  min: number;
  max: number;
  /** Value at Risk at the given level, as a loss relative to the start. */
  var95: number;
  var99: number;
  /** Expected shortfall: the mean loss conditional on breaching VaR. */
  es95: number;
  probOfLoss: number;
  /** Fraction of paths finishing above the barrier, if one is set. */
  probAboveBarrier?: number;
  /** Fraction of paths that touched the barrier at any time. */
  probTouchedBarrier?: number;
}

export function riskSummary(e: Ensemble, start: number, barrier?: number): RiskSummary {
  const terminal = Array.from(terminalValues(e)).sort((a, b) => a - b);
  const n = terminal.length;
  const mean = terminal.reduce((s, x) => s + x, 0) / n;
  const variance = terminal.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1);
  const q = (p: number) => quantileOf(terminal, p);

  const var95 = start - q(0.05);
  const var99 = start - q(0.01);
  const tailCount = Math.max(1, Math.floor(n * 0.05));
  const es95 = start - terminal.slice(0, tailCount).reduce((s, x) => s + x, 0) / tailCount;

  const out: RiskSummary = {
    mean,
    median: q(0.5),
    sd: Math.sqrt(variance),
    min: terminal[0],
    max: terminal[n - 1],
    var95,
    var99,
    es95,
    probOfLoss: terminal.filter((x) => x < start).length / n,
  };

  if (barrier !== undefined && Number.isFinite(barrier)) {
    out.probAboveBarrier = terminal.filter((x) => x >= barrier).length / n;
    const stride = e.steps + 1;
    let touched = 0;
    const above = barrier >= start;
    for (let i = 0; i < e.paths; i++) {
      for (let k = 0; k <= e.steps; k++) {
        const v = e.values[i * stride + k];
        if (above ? v >= barrier : v <= barrier) {
          touched++;
          break;
        }
      }
    }
    out.probTouchedBarrier = touched / e.paths;
  }
  return out;
}

// ------------------------------------------------------------------ MC integration

export interface McIntegrationResult {
  estimate: number;
  standardError: number;
  /** Running estimate after each batch, for the convergence plot. */
  history: { n: number; value: number; lower: number; upper: number }[];
  /** Sample points, capped, for the scatter display. */
  points: { x: number; y: number; inside: boolean }[];
}

/**
 * Monte Carlo estimation of a 2D region's area (or a definite integral written
 * as an indicator). Reports the standard error, because the entire point of
 * this demonstration is that the error falls as 1/√n regardless of dimension.
 */
export function monteCarloArea(
  inside: (x: number, y: number) => boolean,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  samples: number,
  seed: number | string,
  maxPoints = 4000,
): McIntegrationResult {
  const rng = new Rng(seed);
  const boxArea = (bounds.xMax - bounds.xMin) * (bounds.yMax - bounds.yMin);
  let hits = 0;
  const points: McIntegrationResult['points'] = [];
  const history: McIntegrationResult['history'] = [];
  const checkpoints = new Set<number>();
  for (let i = 1; i <= 200; i++) checkpoints.add(Math.max(1, Math.round((samples * i) / 200)));

  for (let i = 1; i <= samples; i++) {
    const x = rng.uniform(bounds.xMin, bounds.xMax);
    const y = rng.uniform(bounds.yMin, bounds.yMax);
    const hit = inside(x, y);
    if (hit) hits++;
    if (points.length < maxPoints) points.push({ x, y, inside: hit });
    if (checkpoints.has(i)) {
      const phat = hits / i;
      const se = Math.sqrt(Math.max(phat * (1 - phat), 1e-12) / i) * boxArea;
      const value = phat * boxArea;
      history.push({ n: i, value, lower: value - 1.96 * se, upper: value + 1.96 * se });
    }
  }
  const phat = hits / samples;
  return {
    estimate: phat * boxArea,
    standardError: Math.sqrt(Math.max(phat * (1 - phat), 1e-12) / samples) * boxArea,
    history,
    points,
  };
}
