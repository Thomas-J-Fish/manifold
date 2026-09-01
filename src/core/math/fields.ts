/* Vector fields and partial differential equations.
 *
 * Two families of thing live here. The first turns a pair of expressions
 * P(x,y), Q(x,y) into something you can look at: arrow grids, streamlines,
 * advected particles, and the derived scalar fields (divergence, curl,
 * magnitude). The second integrates the heat and wave equations on a line and
 * on a rectangle so that the animation scrubber has real physics behind it.
 */

import { derivative } from './numeric';

export interface FieldFn {
  (x: number, y: number): [number, number];
}

export interface ArrowGridOptions {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  /** Arrows across the width; the height count is derived from the aspect. */
  columns: number;
  rows: number;
  /** 'uniform' draws every arrow the same length and encodes speed as colour;
   *  'scaled' makes length proportional to speed, clipped at the cell size. */
  lengthMode: 'uniform' | 'scaled';
}

export interface Arrow {
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
}

export function arrowGrid(f: FieldFn, opts: ArrowGridOptions): { arrows: Arrow[]; maxSpeed: number } {
  const arrows: Arrow[] = [];
  const dx = (opts.xMax - opts.xMin) / opts.columns;
  const dy = (opts.yMax - opts.yMin) / opts.rows;
  let maxSpeed = 0;
  for (let i = 0; i < opts.columns; i++) {
    for (let j = 0; j < opts.rows; j++) {
      const x = opts.xMin + (i + 0.5) * dx;
      const y = opts.yMin + (j + 0.5) * dy;
      const [u, v] = f(x, y);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const speed = Math.hypot(u, v);
      if (speed > maxSpeed) maxSpeed = speed;
      arrows.push({ x, y, dx: u, dy: v, speed });
    }
  }
  // The arrow length unit is 85% of a cell, so a full-speed arrow reaches its
  // neighbour without overlapping it — the density stays readable at any zoom.
  const cell = Math.min(dx, dy) * 0.85;
  for (const a of arrows) {
    if (opts.lengthMode === 'uniform') {
      const s = a.speed > 1e-12 ? cell / a.speed : 0;
      a.dx *= s;
      a.dy *= s;
    } else {
      const s = maxSpeed > 1e-12 ? cell / maxSpeed : 0;
      a.dx *= s;
      a.dy *= s;
    }
  }
  return { arrows, maxSpeed };
}

/** Integrates one streamline forwards and backwards from a seed point. */
export function streamline(
  f: FieldFn,
  x0: number,
  y0: number,
  step: number,
  maxSteps: number,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
): Float64Array {
  const forward: number[] = [];
  const backward: number[] = [];

  const trace = (dir: 1 | -1, into: number[]) => {
    let x = x0;
    let y = y0;
    for (let i = 0; i < maxSteps; i++) {
      // RK4 on the normalised field: normalising makes the arc-length step
      // constant, so the sampled points are evenly spaced along the curve
      // regardless of how fast the flow is there.
      const k1 = unit(f(x, y));
      const k2 = unit(f(x + (dir * step * k1[0]) / 2, y + (dir * step * k1[1]) / 2));
      const k3 = unit(f(x + (dir * step * k2[0]) / 2, y + (dir * step * k2[1]) / 2));
      const k4 = unit(f(x + dir * step * k3[0], y + dir * step * k3[1]));
      const nx = x + ((dir * step) / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      const ny = y + ((dir * step) / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;
      if (nx < bounds.xMin || nx > bounds.xMax || ny < bounds.yMin || ny > bounds.yMax) break;
      // A stagnation point: the line has stopped moving and further steps
      // would just pile points on top of each other.
      if (Math.hypot(nx - x, ny - y) < step * 1e-3) break;
      x = nx;
      y = ny;
      into.push(x, y);
    }
  };

  trace(1, forward);
  trace(-1, backward);

  const out = new Float64Array(backward.length + 2 + forward.length);
  for (let i = 0; i < backward.length; i += 2) {
    const src = backward.length - 2 - i;
    out[i] = backward[src];
    out[i + 1] = backward[src + 1];
  }
  out[backward.length] = x0;
  out[backward.length + 1] = y0;
  out.set(forward, backward.length + 2);
  return out;
}

function unit([u, v]: [number, number]): [number, number] {
  const m = Math.hypot(u, v);
  return m > 1e-12 && Number.isFinite(m) ? [u / m, v / m] : [0, 0];
}

/**
 * Seeds streamlines on a jittered grid and drops any that start too close to
 * an existing line, which is what stops a flow from being drawn forty times
 * along the same path.
 */
export function streamlineSet(
  f: FieldFn,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  count: number,
  seedJitter = 0.35,
): Float64Array[] {
  const lines: Float64Array[] = [];
  const cells = Math.ceil(Math.sqrt(count));
  const dx = (bounds.xMax - bounds.xMin) / cells;
  const dy = (bounds.yMax - bounds.yMin) / cells;
  const step = Math.min(dx, dy) * 0.25;
  const minSeparation = Math.min(dx, dy) * 0.5;
  const placed: [number, number][] = [];

  // A deterministic jitter: the pattern must not change between two renders of
  // the same field, or the picture would shimmer while a slider moves.
  const jitter = (i: number, j: number) => {
    const h = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return (h - Math.floor(h) - 0.5) * 2 * seedJitter;
  };

  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const x = bounds.xMin + (i + 0.5 + jitter(i, j)) * dx;
      const y = bounds.yMin + (j + 0.5 + jitter(j, i)) * dy;
      if (placed.some(([px, py]) => Math.hypot(px - x, py - y) < minSeparation)) continue;
      const line = streamline(f, x, y, step, 400, bounds);
      if (line.length >= 8) {
        lines.push(line);
        for (let k = 0; k < line.length; k += 16) placed.push([line[k], line[k + 1]]);
      }
      if (lines.length >= count) return lines;
    }
  }
  return lines;
}

export interface Particle {
  x: number;
  y: number;
  /** Remaining life in seconds; particles are respawned when it runs out so
   *  the animation never thins out at attractors. */
  life: number;
  trail: number[];
}

export function seedParticles(
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  count: number,
  rand: () => number,
): Particle[] {
  return Array.from({ length: count }, () => ({
    x: bounds.xMin + rand() * (bounds.xMax - bounds.xMin),
    y: bounds.yMin + rand() * (bounds.yMax - bounds.yMin),
    life: 1 + rand() * 3,
    trail: [],
  }));
}

/** Advances every particle by dt, respawning the exhausted and the escaped. */
export function advectParticles(
  particles: Particle[],
  f: FieldFn,
  dt: number,
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
  rand: () => number,
  trailLength = 12,
): void {
  for (const p of particles) {
    const [u, v] = f(p.x, p.y);
    if (Number.isFinite(u) && Number.isFinite(v)) {
      p.x += u * dt;
      p.y += v * dt;
    }
    p.life -= dt;
    p.trail.push(p.x, p.y);
    if (p.trail.length > trailLength * 2) p.trail.splice(0, p.trail.length - trailLength * 2);
    const escaped = p.x < bounds.xMin || p.x > bounds.xMax || p.y < bounds.yMin || p.y > bounds.yMax;
    if (escaped || p.life <= 0 || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      p.x = bounds.xMin + rand() * (bounds.xMax - bounds.xMin);
      p.y = bounds.yMin + rand() * (bounds.yMax - bounds.yMin);
      p.life = 1 + rand() * 3;
      p.trail.length = 0;
    }
  }
}

/** ∂P/∂x + ∂Q/∂y — sources are positive, sinks negative. */
export function divergence(f: FieldFn, x: number, y: number): number {
  return derivative((t) => f(t, y)[0], x) + derivative((t) => f(x, t)[1], y);
}

/** The scalar curl in 2D: ∂Q/∂x − ∂P/∂y. */
export function curl(f: FieldFn, x: number, y: number): number {
  return derivative((t) => f(t, y)[1], x) - derivative((t) => f(x, t)[0], y);
}

// ------------------------------------------------------------------ PDEs

export type PdeKind = 'heat1d' | 'wave1d' | 'heat2d' | 'wave2d';
export type BoundaryKind = 'dirichlet' | 'neumann' | 'periodic';

export interface Pde1dOptions {
  kind: 'heat1d' | 'wave1d';
  /** Diffusivity for heat, wave speed for the wave equation. */
  coefficient: number;
  length: number;
  nodes: number;
  frames: number;
  duration: number;
  boundary: BoundaryKind;
  initial: (x: number) => number;
  /** Initial velocity, wave equation only. */
  initialVelocity?: (x: number) => number;
}

export interface Pde1dResult {
  x: Float64Array;
  /** frames × nodes, row-major. */
  frames: Float64Array;
  frameCount: number;
  nodeCount: number;
  times: Float64Array;
  /** True when the requested time step had to be reduced for stability. */
  substepped: boolean;
  substeps: number;
}

/**
 * Explicit finite differences on a uniform grid.
 *
 * Both equations are conditionally stable, and the app lets the user choose a
 * frame rate freely, so the internal time step is chosen from the CFL condition
 * and the solver takes as many substeps per output frame as that requires:
 * r = αΔt/Δx² ≤ ½ for heat, c·Δt/Δx ≤ 1 for the wave equation. Ignoring this
 * does not give a slightly wrong answer — it gives an exponential blow-up
 * within a dozen frames, which is worth avoiding by construction.
 */
export function solvePde1d(opts: Pde1dOptions): Pde1dResult {
  const n = Math.max(8, Math.round(opts.nodes));
  const dx = opts.length / (n - 1);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = i * dx;

  const frameDt = opts.duration / Math.max(1, opts.frames - 1);
  const stableDt =
    opts.kind === 'heat1d'
      ? (0.4 * dx * dx) / Math.max(opts.coefficient, 1e-9)
      : (0.9 * dx) / Math.max(opts.coefficient, 1e-9);
  const substeps = Math.max(1, Math.ceil(frameDt / stableDt));
  const dt = frameDt / substeps;

  const frames = new Float64Array(opts.frames * n);
  const times = new Float64Array(opts.frames);

  let u = new Float64Array(n);
  for (let i = 0; i < n; i++) u[i] = opts.initial(x[i]);
  let uPrev = new Float64Array(n);
  let uNext = new Float64Array(n);

  if (opts.kind === 'wave1d') {
    // The first backward step comes from the Taylor expansion including the
    // initial velocity, so a plucked string starts moving correctly.
    const c2 = (opts.coefficient * dt / dx) ** 2;
    for (let i = 1; i < n - 1; i++) {
      const v0 = opts.initialVelocity ? opts.initialVelocity(x[i]) : 0;
      uPrev[i] = u[i] - dt * v0 + 0.5 * c2 * (u[i + 1] - 2 * u[i] + u[i - 1]);
    }
    uPrev[0] = u[0];
    uPrev[n - 1] = u[n - 1];
  }

  const applyBoundary = (arr: Float64Array) => {
    switch (opts.boundary) {
      case 'dirichlet':
        arr[0] = 0;
        arr[n - 1] = 0;
        break;
      case 'neumann':
        // Zero gradient: mirror the neighbour into the ghost node.
        arr[0] = arr[1];
        arr[n - 1] = arr[n - 2];
        break;
      case 'periodic':
        arr[0] = arr[n - 2];
        arr[n - 1] = arr[1];
        break;
    }
  };

  applyBoundary(u);
  frames.set(u, 0);
  times[0] = 0;

  for (let frame = 1; frame < opts.frames; frame++) {
    for (let s = 0; s < substeps; s++) {
      if (opts.kind === 'heat1d') {
        const r = (opts.coefficient * dt) / (dx * dx);
        for (let i = 1; i < n - 1; i++) uNext[i] = u[i] + r * (u[i + 1] - 2 * u[i] + u[i - 1]);
        applyBoundary(uNext);
        const swap = u;
        u = uNext;
        uNext = swap;
      } else {
        const c2 = (opts.coefficient * dt / dx) ** 2;
        for (let i = 1; i < n - 1; i++) {
          uNext[i] = 2 * u[i] - uPrev[i] + c2 * (u[i + 1] - 2 * u[i] + u[i - 1]);
        }
        applyBoundary(uNext);
        const oldPrev = uPrev;
        uPrev = u;
        u = uNext;
        uNext = oldPrev;
      }
    }
    frames.set(u, frame * n);
    times[frame] = frame * frameDt;
  }

  return {
    x,
    frames,
    frameCount: opts.frames,
    nodeCount: n,
    times,
    substepped: substeps > 1,
    substeps,
  };
}

export interface Pde2dOptions {
  kind: 'heat2d' | 'wave2d';
  coefficient: number;
  size: number;
  nodes: number;
  frames: number;
  duration: number;
  initial: (x: number, y: number) => number;
}

export interface Pde2dResult {
  n: number;
  frames: Float32Array[];
  times: Float64Array;
  min: number;
  max: number;
  substeps: number;
}

/** The same explicit scheme on a square grid; Float32 because these frames go
 *  straight into an ImageData buffer and the extra precision is invisible. */
export function solvePde2d(opts: Pde2dOptions): Pde2dResult {
  const n = Math.max(16, Math.min(Math.round(opts.nodes), 220));
  const dx = opts.size / (n - 1);
  const frameDt = opts.duration / Math.max(1, opts.frames - 1);
  const stableDt =
    opts.kind === 'heat2d'
      ? (0.2 * dx * dx) / Math.max(opts.coefficient, 1e-9)
      : (0.6 * dx) / Math.max(opts.coefficient, 1e-9);
  const substeps = Math.max(1, Math.ceil(frameDt / stableDt));
  const dt = frameDt / substeps;

  let u = new Float32Array(n * n);
  let uPrev = new Float32Array(n * n);
  let uNext = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      u[j * n + i] = opts.initial((i * opts.size) / (n - 1) - opts.size / 2, (j * opts.size) / (n - 1) - opts.size / 2);
    }
  }
  uPrev.set(u);

  const out: Float32Array[] = [new Float32Array(u)];
  const times = new Float64Array(opts.frames);
  let min = Infinity;
  let max = -Infinity;
  for (const v of u) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  for (let frame = 1; frame < opts.frames; frame++) {
    for (let s = 0; s < substeps; s++) {
      if (opts.kind === 'heat2d') {
        const r = (opts.coefficient * dt) / (dx * dx);
        for (let j = 1; j < n - 1; j++) {
          for (let i = 1; i < n - 1; i++) {
            const k = j * n + i;
            uNext[k] = u[k] + r * (u[k + 1] + u[k - 1] + u[k + n] + u[k - n] - 4 * u[k]);
          }
        }
        const swap = u;
        u = uNext;
        uNext = swap;
      } else {
        const c2 = (opts.coefficient * dt / dx) ** 2;
        for (let j = 1; j < n - 1; j++) {
          for (let i = 1; i < n - 1; i++) {
            const k = j * n + i;
            uNext[k] = 2 * u[k] - uPrev[k] + c2 * (u[k + 1] + u[k - 1] + u[k + n] + u[k - n] - 4 * u[k]);
          }
        }
        const oldPrev = uPrev;
        uPrev = u;
        u = uNext;
        uNext = oldPrev;
      }
    }
    const snapshot = new Float32Array(u);
    for (const v of snapshot) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out.push(snapshot);
    times[frame] = frame * frameDt;
  }

  return { n, frames: out, times, min, max, substeps };
}
