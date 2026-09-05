/* One-dimensional (and, where it earns its keep, two-dimensional) quantum
 * mechanics.
 *
 * Everything here works in nanometres and electronvolts, with time in
 * femtoseconds and mass in electron masses. That is not an aesthetic choice:
 * it is the only unit system in which a student can type "a 0.5 nm well, 5 eV
 * deep" and read an answer back in the units of the textbook, and in which the
 * numbers stay near 1 so that double precision is never the limiting factor.
 * Working in SI here would put ħ² / 2m at 6e-39 and lose four significant
 * figures to underflow before the first eigenvalue came out.
 *
 * Three solvers, because "solve the Schrödinger equation" means three
 * different calculations depending on what is being asked:
 *
 *   - Bound states: the time-independent equation as a symmetric tridiagonal
 *     eigenvalue problem, solved exactly (to rounding) by implicit-shift QL.
 *     This is the energy ladder — the thing that is quantised.
 *   - Evolution: the time-dependent equation by Crank–Nicolson, which is
 *     unitary by construction, so probability is conserved to rounding rather
 *     than slowly leaking the way an explicit scheme's would.
 *   - Scattering: transmission against energy by transfer matrix, which is
 *     exact for a piecewise-constant potential and so can be checked against
 *     the closed form for a rectangular barrier rather than against itself.
 */

// ------------------------------------------------------------------ units

/** ħ²/2mₑ in eV·nm² — the coefficient of the kinetic term. */
export const KINETIC = 0.03809982;
/** ħ in eV·fs, which is what turns an energy into a rate of phase change. */
export const HBAR = 0.6582119569;

/** Energy of a free electron of wavenumber k (nm⁻¹), in eV. */
export const freeEnergy = (k: number, mass = 1): number => (KINETIC / mass) * k * k;
/** Wavenumber (nm⁻¹) of a free electron of energy E (eV). */
export const freeWavenumber = (energy: number, mass = 1): number =>
  Math.sqrt(Math.max(0, energy) / (KINETIC / mass));

// ------------------------------------------------------------------ potential

export type FeatureKind = 'barrier' | 'well' | 'step' | 'harmonic' | 'gaussian' | 'linear' | 'coulomb';

export interface PotentialFeature {
  id: string;
  kind: FeatureKind;
  /** Centre in nm — the left edge for a step, the origin for a field. */
  centre: number;
  /** Full width in nm. The softening length for a Coulomb well. */
  width: number;
  /** Height in eV: the depth for a well, the slope in eV/nm for a field. */
  height: number;
}

export interface QuantumWorld {
  /** Which equation is on screen. They share the potential and the mass. */
  view: 'bound' | 'evolve' | 'scatter' | 'plane';
  xMin: number;
  xMax: number;
  /** Interior grid points; the walls at either end are infinite. */
  points: number;
  /** Particle mass in electron masses. */
  mass: number;
  features: PotentialFeature[];
  /** Extra V(x) in eV, as an expression in x. Compiled by the caller, because
   * the expression engine lives a layer up from the physics. */
  expression: string;
  /** How many bound states to look for. */
  levels: number;
  packet: {
    /** Starting centre (nm) and standard deviation of |ψ|² (nm). */
    centre: number;
    width: number;
    /** Mean wavenumber in nm⁻¹; positive moves right. */
    momentum: number;
  };
  /** Length of the evolution in femtoseconds. */
  duration: number;
  /** Soak the packet up at the edges rather than bouncing it off the walls. */
  absorbing: boolean;
  /** Energy range for the transmission curve, in eV. */
  scatterMin: number;
  scatterMax: number;
  /** The two-dimensional problem, which has its own shape rather than sharing
   * the feature list, because a circular well is not a sum of intervals. */
  plane: {
    shape: 'box' | 'circle' | 'harmonic' | 'separable';
    /** Half-width of the box, radius of the circle, or the length at which the
     * oscillator reaches `depth`. */
    size: number;
    depth: number;
    /** Aspect ratio of the box: 1 is square. Degeneracy is the point. */
    aspect: number;
    points: number;
    levels: number;
  };
}

export interface PotentialSample {
  x: Float64Array;
  v: Float64Array;
  dx: number;
}

const clampPoints = (n: number, lo = 32, hi = 2000): number =>
  Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));

/**
 * The potential on the grid.
 *
 * Interior points only. The wall on each side is not a large number in the
 * array — it is the absence of a point, which is what makes the boundary
 * condition exactly ψ = 0 rather than approximately so.
 */
export function samplePotential(world: QuantumWorld, extra?: (x: number) => number): PotentialSample {
  const n = clampPoints(world.points);
  const lo = Math.min(world.xMin, world.xMax);
  const hi = Math.max(world.xMin, world.xMax);
  const span = Math.max(1e-6, hi - lo);
  const dx = span / (n + 1);
  const x = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const xi = lo + dx * (i + 1);
    x[i] = xi;
    v[i] = potentialAt(world.features, xi) + (extra ? finite(extra(xi)) : 0);
  }
  return { x, v, dx };
}

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/** The features, summed, at one point. */
export function potentialAt(features: PotentialFeature[], x: number): number {
  let v = 0;
  for (const f of features) {
    const half = Math.max(1e-9, f.width) / 2;
    const d = x - f.centre;
    switch (f.kind) {
      case 'barrier':
        if (Math.abs(d) <= half) v += f.height;
        break;
      case 'well':
        if (Math.abs(d) <= half) v -= f.height;
        break;
      case 'step':
        if (d >= 0) v += f.height;
        break;
      case 'harmonic':
        // Parameterised by where it gets to rather than by a spring constant:
        // "reaches `height` eV at half a width from the centre" is a shape a
        // student can see on the axes in front of them.
        v += f.height * (d / half) * (d / half);
        break;
      case 'gaussian':
        v += f.height * Math.exp((-2 * d * d) / (half * half));
        break;
      case 'linear':
        // A uniform field. `height` is the slope in eV/nm.
        v += f.height * d;
        break;
      case 'coulomb':
        // Softened, because 1/|x| is not square-integrable in one dimension
        // and the grid would simply report whatever the nearest point felt.
        v -= f.height / Math.sqrt(d * d + half * half);
        break;
      default:
        break;
    }
  }
  return v;
}

// ------------------------------------------------- symmetric tridiagonal QL

/**
 * Eigenvalues and eigenvectors of a symmetric tridiagonal matrix.
 *
 * Implicit-shift QL with Wilkinson shifts — the standard algorithm, chosen
 * because the discretised Hamiltonian is already tridiagonal and so needs no
 * reduction step, and because it returns *every* state rather than the lowest
 * few. Seeing that the ladder continues, and that it stops being a ladder
 * above the well, is most of what the bound-state picture is for.
 *
 * `d` is the diagonal and `e` the subdiagonal; both are overwritten. Returns
 * eigenvalues in ascending order with the matching eigenvectors as columns of
 * a row-major n×n array.
 */
export function tridiagonalEigen(
  d: Float64Array,
  e: Float64Array,
): { values: Float64Array; vectors: Float64Array } {
  const n = d.length;
  const z = new Float64Array(n * n);
  for (let i = 0; i < n; i++) z[i * n + i] = 1;
  // e[0] is unused; shift so e[i] couples i-1 and i.
  const off = new Float64Array(n);
  for (let i = 1; i < n; i++) off[i - 1] = e[i];
  off[n - 1] = 0;

  for (let l = 0; l < n; l++) {
    let iter = 0;
    for (;;) {
      let m = l;
      for (; m < n - 1; m++) {
        const dd = Math.abs(d[m]) + Math.abs(d[m + 1]);
        if (Math.abs(off[m]) <= Number.EPSILON * dd) break;
      }
      if (m === l) break;
      if (iter++ === 50) break; // Give up rather than spin; 50 is generous.
      let g = (d[l + 1] - d[l]) / (2 * off[l]);
      let r = Math.hypot(g, 1);
      g = d[m] - d[l] + off[l] / (g + (g >= 0 ? Math.abs(r) : -Math.abs(r)));
      let s = 1;
      let c = 1;
      let p = 0;
      let i = m - 1;
      for (; i >= l; i--) {
        let f = s * off[i];
        const b = c * off[i];
        r = Math.hypot(f, g);
        off[i + 1] = r;
        if (r === 0) {
          d[i + 1] -= p;
          off[m] = 0;
          break;
        }
        s = f / r;
        c = g / r;
        g = d[i + 1] - p;
        r = (d[i] - g) * s + 2 * c * b;
        p = s * r;
        d[i + 1] = g + p;
        g = c * r - b;
        for (let k = 0; k < n; k++) {
          f = z[k * n + i + 1];
          z[k * n + i + 1] = s * z[k * n + i] + c * f;
          z[k * n + i] = c * z[k * n + i] - s * f;
        }
      }
      if (r === 0 && i >= l) continue;
      d[l] -= p;
      off[l] = g;
      off[m] = 0;
    }
  }

  // Sort ascending, carrying the columns with the values.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d[a] - d[b]);
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  order.forEach((src, col) => {
    values[col] = d[src];
    for (let k = 0; k < n; k++) vectors[k * n + col] = z[k * n + src];
  });
  return { values, vectors };
}

// ------------------------------------------------------------- bound states

export interface BoundStates extends PotentialSample {
  /** Ascending energies in eV. */
  energies: Float64Array;
  /** Row-major: state `s` at grid point `i` is psi[s * n + i]. */
  psi: Float64Array;
  /** How many of the returned states sit below the potential at the walls,
   * and so are genuinely bound rather than a box artefact. */
  bound: number;
  n: number;
}

/**
 * The energy ladder and its wavefunctions.
 *
 * The states above the top of the well are kept and flagged rather than
 * discarded: on a finite grid they are the box's own standing waves, and a
 * student who has just drawn a well 3 eV deep should be able to see for
 * themselves that the fourth level at 5 eV is an artefact of the walls the
 * simulation put there, not a fourth bound state.
 */
/**
 * The lowest `wanted` states of a one-dimensional grid Hamiltonian.
 *
 * Split out from `solveBoundStates` because the two-dimensional problems are
 * built from it: a separable potential is two of these, and a circular one is
 * a family of radial ones. One tridiagonal eigensolver, tested once, does all
 * the work in this file.
 *
 * `extraDiagonal` adds a per-point term to the diagonal, which is how the
 * centrifugal barrier of the radial equation gets in.
 */
export function solveGrid(
  v: Float64Array,
  dx: number,
  mass: number,
  wanted: number,
): { energies: Float64Array; psi: Float64Array; n: number } {
  const n = v.length;
  const coefficient = KINETIC / Math.max(1e-6, mass);
  const kinetic = coefficient / (dx * dx);
  const diagonal = new Float64Array(n);
  const sub = new Float64Array(n);
  for (let i = 0; i < n; i++) diagonal[i] = 2 * kinetic + v[i];
  for (let i = 1; i < n; i++) sub[i] = -kinetic;
  return solveTridiagonal(diagonal, sub, dx, wanted);
}

/**
 * The lowest states of an arbitrary symmetric tridiagonal Hamiltonian.
 *
 * `sub[i]` couples points i−1 and i; `spacing` is the measure each point
 * carries, so that ∑ψ² · spacing = 1. Separated from `solveGrid` because the
 * radial equation's matrix is not a constant off-diagonal — see
 * `radialStates`.
 */
export function solveTridiagonal(
  diagonal: Float64Array,
  sub: Float64Array,
  spacing: number,
  wanted: number,
): { energies: Float64Array; psi: Float64Array; n: number } {
  const n = diagonal.length;
  const dx = spacing;
  const { values, vectors } = tridiagonalEigen(diagonal, sub);
  const count = Math.max(1, Math.min(Math.round(wanted) || 1, n));
  const psi = new Float64Array(count * n);
  for (let s = 0; s < count; s++) {
    let sum = 0;
    let peak = 0;
    let sign = 1;
    for (let i = 0; i < n; i++) {
      const a = vectors[i * n + s];
      sum += a * a;
      if (Math.abs(a) > peak) {
        peak = Math.abs(a);
        sign = a >= 0 ? 1 : -1;
      }
    }
    // The sign is arbitrary; fixing it so the largest lobe points up stops the
    // whole plot flipping when a slider moves by a thousandth.
    const scale = sign / Math.sqrt(Math.max(1e-300, sum * dx));
    for (let i = 0; i < n; i++) psi[s * n + i] = vectors[i * n + s] * scale;
  }
  return { energies: values.slice(0, count), psi, n };
}

export function solveBoundStates(world: QuantumWorld, extra?: (x: number) => number): BoundStates {
  const { x, v, dx } = samplePotential(world, extra);
  const n = x.length;
  const wanted = Math.max(1, Math.min(Math.round(world.levels) || 6, n));
  const { energies: values, psi } = solveGrid(v, dx, world.mass, wanted);

  /* "Bound" means below the potential at the edges of the box. Anything above
   * that would, in an unbounded world, have escaped. */
  const escape = Math.min(v[0], v[n - 1]);
  let bound = 0;
  while (bound < wanted && values[bound] < escape) bound++;

  return { x, v, dx, n, energies: values, psi, bound };
}

/** ⟨x⟩ for one state, in nm. */
export function expectationX(psi: Float64Array, x: Float64Array, dx: number, offset = 0): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const a = psi[offset + i];
    sum += a * a * x[i];
  }
  return sum * dx;
}

/** The width of a state: √(⟨x²⟩ − ⟨x⟩²), in nm. */
export function spreadX(psi: Float64Array, x: Float64Array, dx: number, offset = 0): number {
  const mean = expectationX(psi, x, dx, offset);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const a = psi[offset + i];
    sum += a * a * (x[i] - mean) * (x[i] - mean);
  }
  return Math.sqrt(Math.max(0, sum * dx));
}

// --------------------------------------------------------------- evolution

export interface WaveTrajectory {
  world: QuantumWorld;
  x: Float64Array;
  v: Float64Array;
  dx: number;
  dt: number;
  n: number;
  /** Stored frames, each 2n long: all the real parts then all the imaginary. */
  frames: Float64Array;
  count: number;
  time: Float64Array;
  /** Diagnostics per frame. */
  norm: Float64Array;
  energy: Float64Array;
  meanX: Float64Array;
  spread: Float64Array;
  /** Probability either side of `split`, for the tunnelling story. */
  left: Float64Array;
  right: Float64Array;
  split: number;
  live: { re: Float64Array; im: Float64Array };
  liveTime: number;
  stepsTaken: number;
  decimation: number;
  failed: boolean;
  failure: string | null;
}

const MAX_FRAMES = 1200;

/** A normalised Gaussian wavepacket, ψ ∝ exp(−(x−x₀)²/4σ²) e^{ikx}. */
export function makePacket(
  x: Float64Array,
  dx: number,
  centre: number,
  width: number,
  momentum: number,
): { re: Float64Array; im: Float64Array } {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const sigma = Math.max(1e-4, width);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - centre;
    const envelope = Math.exp((-d * d) / (4 * sigma * sigma));
    const phase = momentum * x[i];
    re[i] = envelope * Math.cos(phase);
    im[i] = envelope * Math.sin(phase);
    sum += envelope * envelope;
  }
  const scale = 1 / Math.sqrt(Math.max(1e-300, sum * dx));
  for (let i = 0; i < n; i++) {
    re[i] *= scale;
    im[i] *= scale;
  }
  return { re, im };
}

/* Crank–Nicolson, factored once.
 *
 * (1 + iθH)ψⁿ⁺¹ = (1 − iθH)ψⁿ with θ = dt/2ħ. The matrix on the left does not
 * change from step to step, so its Thomas factorisation is computed once and
 * every step is two sweeps of a tridiagonal solve. That is what makes a
 * thousand-step evolution of a four-hundred-point grid something that happens
 * while a slider is being dragged.
 *
 * The scheme is unitary for a real potential: ‖ψ‖ is conserved to rounding,
 * not approximately. An explicit scheme would lose norm steadily and a student
 * watching probability drain away would have no way of telling that from
 * physics.
 */
interface Propagator {
  n: number;
  /** Diagonal and constant off-diagonal of iθH. */
  dRe: Float64Array;
  dIm: Float64Array;
  oRe: number;
  oIm: number;
  cRe: Float64Array;
  cIm: Float64Array;
  invRe: Float64Array;
  invIm: Float64Array;
}

function buildPropagator(v: Float64Array, vAbsorb: Float64Array | null, dx: number, mass: number, dt: number): Propagator {
  const n = v.length;
  const coefficient = KINETIC / Math.max(1e-6, mass);
  const kinetic = coefficient / (dx * dx);
  const theta = dt / (2 * HBAR);
  // A = 1 + iθH. H's diagonal is 2k + V (− i W if absorbing), off-diagonal −k.
  const dRe = new Float64Array(n);
  const dIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hRe = 2 * kinetic + v[i];
    const hIm = vAbsorb ? -vAbsorb[i] : 0;
    dRe[i] = 1 - theta * hIm;
    dIm[i] = theta * hRe;
  }
  const oRe = 0;
  const oIm = -theta * kinetic;

  const cRe = new Float64Array(n);
  const cIm = new Float64Array(n);
  const invRe = new Float64Array(n);
  const invIm = new Float64Array(n);
  let denRe = dRe[0];
  let denIm = dIm[0];
  let inv = 1 / (denRe * denRe + denIm * denIm);
  invRe[0] = denRe * inv;
  invIm[0] = -denIm * inv;
  cRe[0] = oRe * invRe[0] - oIm * invIm[0];
  cIm[0] = oRe * invIm[0] + oIm * invRe[0];
  for (let i = 1; i < n; i++) {
    denRe = dRe[i] - (oRe * cRe[i - 1] - oIm * cIm[i - 1]);
    denIm = dIm[i] - (oRe * cIm[i - 1] + oIm * cRe[i - 1]);
    inv = 1 / (denRe * denRe + denIm * denIm);
    invRe[i] = denRe * inv;
    invIm[i] = -denIm * inv;
    cRe[i] = oRe * invRe[i] - oIm * invIm[i];
    cIm[i] = oRe * invIm[i] + oIm * invRe[i];
  }
  return { n, dRe, dIm, oRe, oIm, cRe, cIm, invRe, invIm };
}

function propagate(p: Propagator, re: Float64Array, im: Float64Array, v: Float64Array, vAbsorb: Float64Array | null, dx: number, mass: number, dt: number): void {
  const n = p.n;
  const coefficient = KINETIC / Math.max(1e-6, mass);
  const kinetic = coefficient / (dx * dx);
  const theta = dt / (2 * HBAR);

  // b = (1 − iθH)ψ, computed in place into scratch arrays.
  const bRe = new Float64Array(n);
  const bIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const left = i > 0 ? -kinetic : 0;
    const right = i < n - 1 ? -kinetic : 0;
    const hRe = (2 * kinetic + v[i]) * re[i] + (i > 0 ? left * re[i - 1] : 0) + (i < n - 1 ? right * re[i + 1] : 0);
    const hIm = (2 * kinetic + v[i]) * im[i] + (i > 0 ? left * im[i - 1] : 0) + (i < n - 1 ? right * im[i + 1] : 0);
    const wRe = vAbsorb ? vAbsorb[i] * im[i] : 0;
    const wIm = vAbsorb ? -vAbsorb[i] * re[i] : 0;
    // (1 − iθH)ψ = ψ − iθ(Hψ); −i(a+bi) = b − ai.
    bRe[i] = re[i] + theta * hIm + theta * wRe;
    bIm[i] = im[i] - theta * hRe + theta * wIm;
  }

  // Forward sweep.
  const yRe = new Float64Array(n);
  const yIm = new Float64Array(n);
  yRe[0] = bRe[0] * p.invRe[0] - bIm[0] * p.invIm[0];
  yIm[0] = bRe[0] * p.invIm[0] + bIm[0] * p.invRe[0];
  for (let i = 1; i < n; i++) {
    const tRe = bRe[i] - (p.oRe * yRe[i - 1] - p.oIm * yIm[i - 1]);
    const tIm = bIm[i] - (p.oRe * yIm[i - 1] + p.oIm * yRe[i - 1]);
    yRe[i] = tRe * p.invRe[i] - tIm * p.invIm[i];
    yIm[i] = tRe * p.invIm[i] + tIm * p.invRe[i];
  }
  // Back substitution.
  re[n - 1] = yRe[n - 1];
  im[n - 1] = yIm[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    re[i] = yRe[i] - (p.cRe[i] * re[i + 1] - p.cIm[i] * im[i + 1]);
    im[i] = yIm[i] - (p.cRe[i] * im[i + 1] + p.cIm[i] * re[i + 1]);
  }
}

/** A smooth absorbing layer in the outer tenth of the box, in eV. */
function absorbingProfile(x: Float64Array, strength: number): Float64Array {
  const n = x.length;
  const w = new Float64Array(n);
  const lo = x[0];
  const hi = x[n - 1];
  const skin = (hi - lo) * 0.1;
  for (let i = 0; i < n; i++) {
    const dLeft = (lo + skin - x[i]) / skin;
    const dRight = (x[i] - (hi - skin)) / skin;
    const t = Math.max(dLeft, dRight, 0);
    w[i] = strength * t * t;
  }
  return w;
}

export function createWaveTrajectory(world: QuantumWorld, extra?: (x: number) => number): WaveTrajectory {
  const { x, v, dx } = samplePotential(world, extra);
  const n = x.length;
  const duration = Math.max(1e-3, world.duration);
  /* The step is set by the fastest phase in the problem: the largest energy
   * the grid can represent is about ħ²π²/2m dx², and a step that turns that
   * phase by more than a fraction of a radian will alias however stable the
   * scheme is. */
  const coefficient = KINETIC / Math.max(1e-6, world.mass);
  const eMax = (coefficient * Math.PI * Math.PI) / (dx * dx) + maxAbs(v);
  const dt = Math.min(duration / 200, (0.35 * HBAR) / Math.max(1e-6, eMax));
  const steps = Math.ceil(duration / dt);
  const decimation = Math.max(1, Math.ceil(steps / MAX_FRAMES));
  const frames = Math.floor(steps / decimation) + 2;

  const packet = makePacket(x, dx, world.packet.centre, world.packet.width, world.packet.momentum);
  const traj: WaveTrajectory = {
    world,
    x,
    v,
    dx,
    dt,
    n,
    frames: new Float64Array(frames * 2 * n),
    count: 0,
    time: new Float64Array(frames),
    norm: new Float64Array(frames),
    energy: new Float64Array(frames),
    meanX: new Float64Array(frames),
    spread: new Float64Array(frames),
    left: new Float64Array(frames),
    right: new Float64Array(frames),
    split: splitPoint(world),
    live: packet,
    liveTime: 0,
    stepsTaken: 0,
    decimation,
    failed: n < 8,
    failure: n < 8 ? 'The grid is too coarse to represent a wavefunction.' : null,
  };
  if (!traj.failed) pushFrame(traj);
  return traj;
}

const maxAbs = (a: Float64Array): number => {
  let m = 0;
  for (const value of a) m = Math.max(m, Math.abs(value));
  return m;
};

/** Where "transmitted" starts: the far edge of the rightmost obstacle. */
function splitPoint(world: QuantumWorld): number {
  let edge = Number.NEGATIVE_INFINITY;
  for (const f of world.features) {
    if (f.kind === 'barrier' || f.kind === 'gaussian' || f.kind === 'well') {
      edge = Math.max(edge, f.centre + Math.max(1e-9, f.width) / 2);
    } else if (f.kind === 'step') {
      edge = Math.max(edge, f.centre);
    }
  }
  return Number.isFinite(edge) ? edge : 0;
}

function pushFrame(traj: WaveTrajectory): void {
  const k = traj.count;
  if (k >= traj.time.length) return;
  const n = traj.n;
  traj.frames.set(traj.live.re, k * 2 * n);
  traj.frames.set(traj.live.im, k * 2 * n + n);
  traj.time[k] = traj.liveTime;

  const { re, im } = traj.live;
  const coefficient = KINETIC / Math.max(1e-6, traj.world.mass);
  const kinetic = coefficient / (traj.dx * traj.dx);
  let norm = 0;
  let energy = 0;
  let mean = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < n; i++) {
    const density = re[i] * re[i] + im[i] * im[i];
    norm += density;
    mean += density * traj.x[i];
    if (traj.x[i] < traj.split) left += density;
    else right += density;
    // ⟨ψ|H|ψ⟩ with the same three-point stencil the propagator uses, so the
    // reported energy is the energy of the thing actually being evolved.
    const hRe =
      (2 * kinetic + traj.v[i]) * re[i] -
      kinetic * ((i > 0 ? re[i - 1] : 0) + (i < n - 1 ? re[i + 1] : 0));
    const hIm =
      (2 * kinetic + traj.v[i]) * im[i] -
      kinetic * ((i > 0 ? im[i - 1] : 0) + (i < n - 1 ? im[i + 1] : 0));
    energy += re[i] * hRe + im[i] * hIm;
  }
  const total = Math.max(1e-300, norm);
  traj.norm[k] = norm * traj.dx;
  traj.energy[k] = energy / total;
  traj.meanX[k] = mean / total;
  traj.left[k] = (left / total);
  traj.right[k] = (right / total);

  let variance = 0;
  const centre = traj.meanX[k];
  for (let i = 0; i < n; i++) {
    const density = re[i] * re[i] + im[i] * im[i];
    variance += density * (traj.x[i] - centre) * (traj.x[i] - centre);
  }
  traj.spread[k] = Math.sqrt(Math.max(0, variance / total));
  traj.count = k + 1;
}

/** Runs the evolution out to `until` femtoseconds, within a step budget. */
export function advanceWave(traj: WaveTrajectory, until: number, budget = 20000): boolean {
  if (traj.failed) return true;
  const world = traj.world;
  const absorb = world.absorbing ? absorbingProfile(traj.x, 30) : null;
  const propagator = buildPropagator(traj.v, absorb, traj.dx, world.mass, traj.dt);
  let done = 0;
  while (traj.liveTime < Math.min(until, world.duration) - 1e-12) {
    if (done >= budget) return false;
    if (traj.count >= traj.time.length - 1) return true;
    propagate(propagator, traj.live.re, traj.live.im, traj.v, absorb, traj.dx, world.mass, traj.dt);
    traj.liveTime += traj.dt;
    traj.stepsTaken++;
    if (traj.stepsTaken % traj.decimation === 0) pushFrame(traj);
    done++;
  }
  return true;
}

export function waveFrameAt(traj: WaveTrajectory, t: number): number {
  if (traj.count === 0) return 0;
  const spacing = traj.dt * traj.decimation;
  return Math.min(traj.count - 1, Math.max(0, Math.round(t / spacing)));
}

// --------------------------------------------------------------- scattering

/**
 * Transmission against energy, by transfer matrix.
 *
 * Each slab of constant potential propagates (ψ, ψ′) by a real 2×2 matrix —
 * trigonometric above the barrier, hyperbolic below it — and the plane waves
 * outside turn the product into a reflection amplitude. Exact for a
 * piecewise-constant potential, which means the rectangular barrier can be
 * checked against its closed form rather than against a finer version of
 * itself.
 */
export function transmission(world: QuantumWorld, energy: number, extra?: (x: number) => number): number {
  const { x, v, dx } = samplePotential(world, extra);
  const n = x.length;
  if (n < 2 || energy <= 0) return 0;
  const coefficient = KINETIC / Math.max(1e-6, world.mass);
  const kLeft = Math.sqrt(energy / coefficient);
  const kRight = Math.sqrt(Math.max(1e-12, energy - v[n - 1]) / coefficient);
  if (energy <= v[n - 1]) return 0;

  // Row-major 2×2, real.
  let m00 = 1;
  let m01 = 0;
  let m10 = 0;
  let m11 = 1;
  for (let i = 0; i < n; i++) {
    const q2 = (energy - v[i]) / coefficient;
    let a: number;
    let b: number;
    let c: number;
    if (q2 > 0) {
      const k = Math.sqrt(q2);
      a = Math.cos(k * dx);
      b = Math.sin(k * dx) / k;
      c = -k * Math.sin(k * dx);
    } else if (q2 < 0) {
      const k = Math.sqrt(-q2);
      a = Math.cosh(k * dx);
      b = Math.sinh(k * dx) / k;
      c = k * Math.sinh(k * dx);
    } else {
      a = 1;
      b = dx;
      c = 0;
    }
    // [a b; c a] · M
    const n00 = a * m00 + b * m10;
    const n01 = a * m01 + b * m11;
    const n10 = c * m00 + a * m10;
    const n11 = c * m01 + a * m11;
    m00 = n00;
    m01 = n01;
    m10 = n10;
    m11 = n11;
  }

  /* ψ(0) = 1 + r, ψ′(0) = i k_L (1 − r); ψ(L) = t e^{i k_R L} and
   * ψ′(L) = i k_R ψ(L). Eliminating gives r, and T = (k_R/k_L)|t|². */
  const sRe = m11;
  const sIm = -kRight * m01;
  const tRe = -m10;
  const tIm = kRight * m00;
  // s / t, complex.
  const den = tRe * tRe + tIm * tIm;
  if (den === 0) return 0;
  const ratioRe = (sRe * tRe + sIm * tIm) / den;
  const ratioIm = (sIm * tRe - sRe * tIm) / den;
  // r = (i k_L·ratio − 1)/(1 + i k_L·ratio)
  const pRe = -kLeft * ratioIm - 1;
  const pIm = kLeft * ratioRe;
  const qRe = 1 - kLeft * ratioIm;
  const qIm = kLeft * ratioRe;
  const qq = qRe * qRe + qIm * qIm;
  if (qq === 0) return 0;
  const rRe = (pRe * qRe + pIm * qIm) / qq;
  const rIm = (pIm * qRe - pRe * qIm) / qq;
  const reflected = rRe * rRe + rIm * rIm;
  return Math.max(0, Math.min(1, 1 - reflected));
}

export interface ScatterCurve {
  energy: Float64Array;
  transmitted: Float64Array;
  /** The closed form, where one exists for this potential. */
  analytic: Float64Array | null;
  analyticLabel: string | null;
}

/** Transmission over a range of energies, with the closed form beside it. */
export function scatterCurve(world: QuantumWorld, samples = 240, extra?: (x: number) => number): ScatterCurve {
  const lo = Math.max(1e-4, Math.min(world.scatterMin, world.scatterMax));
  const hi = Math.max(lo + 1e-3, Math.max(world.scatterMin, world.scatterMax));
  const energy = new Float64Array(samples);
  const transmitted = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    energy[i] = lo + ((hi - lo) * i) / (samples - 1);
    transmitted[i] = transmission(world, energy[i], extra);
  }

  // A lone rectangular barrier or well is the one case with a closed form
  // simple enough to be worth putting on the same axes.
  let analytic: Float64Array | null = null;
  let analyticLabel: string | null = null;
  const solitary = world.features.length === 1 ? world.features[0] : null;
  if (!world.expression.trim() && solitary && (solitary.kind === 'barrier' || solitary.kind === 'well')) {
    const height = solitary.kind === 'barrier' ? solitary.height : -solitary.height;
    analytic = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
      analytic[i] = rectangularTransmission(energy[i], height, solitary.width, world.mass);
    }
    analyticLabel = solitary.kind === 'barrier' ? 'Rectangular barrier' : 'Rectangular well';
  }
  return { energy, transmitted, analytic, analyticLabel };
}

/**
 * The textbook result for a rectangular step of height V₀ and width a.
 *
 * T = [1 + V₀² sinh²(κa) / 4E(V₀−E)]⁻¹ under the barrier, with sinh → sin and
 * the sign of (V₀−E) flipped above it — the same expression continued, which
 * is why the resonances above the barrier come out of it for free.
 */
export function rectangularTransmission(energy: number, height: number, width: number, mass = 1): number {
  const coefficient = KINETIC / Math.max(1e-6, mass);
  if (energy <= 0) return 0;
  const diff = energy - height;
  if (Math.abs(diff) < 1e-12) {
    // The removable singularity at E = V₀, where sinh(κa)/κ → a.
    const a = width / Math.sqrt(coefficient);
    return 1 / (1 + (a * a * height * height) / (4 * energy * height === 0 ? 1 : 4 * energy));
  }
  if (diff < 0) {
    const kappa = Math.sqrt(-diff / coefficient);
    const s = Math.sinh(kappa * width);
    return 1 / (1 + (height * height * s * s) / (4 * energy * (height - energy)));
  }
  const k = Math.sqrt(diff / coefficient);
  const s = Math.sin(k * width);
  return 1 / (1 + (height * height * s * s) / (4 * energy * (energy - height)));
}

// ------------------------------------------------------------- two dimensions

export interface PlaneStates {
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  x: Float64Array;
  y: Float64Array;
  v: Float64Array;
  energies: Float64Array;
  /** Row-major per state: psi[s * nx * ny + iy * nx + ix]. */
  psi: Float64Array;
  count: number;
  /** Quantum numbers, e.g. "nₓ = 1, n_y = 2" or "m = 1, n = 1 (×2)". */
  labels: string[];
}

/** The 2D potential on its grid. */
export function samplePlane(world: QuantumWorld): {
  x: Float64Array;
  y: Float64Array;
  v: Float64Array;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
} {
  const p = world.plane;
  const n = clampPoints(p.points, 16, 160);
  const size = Math.max(0.05, p.size);
  const aspect = Math.max(0.2, Math.min(5, p.aspect));
  const halfX = size;
  const halfY = size / aspect;
  // A margin outside the structure, so a finite well has somewhere to leak.
  const spanX = p.shape === 'box' ? halfX : halfX * 1.6;
  const spanY = p.shape === 'box' ? halfY : halfY * 1.6;
  const nx = n;
  const ny = Math.max(16, Math.round(n / aspect));
  const dx = (2 * spanX) / (nx + 1);
  const dy = (2 * spanY) / (ny + 1);
  const x = new Float64Array(nx);
  const y = new Float64Array(ny);
  for (let i = 0; i < nx; i++) x[i] = -spanX + dx * (i + 1);
  for (let j = 0; j < ny; j++) y[j] = -spanY + dy * (j + 1);

  const v = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const xi = x[i];
      const yj = y[j];
      let value = 0;
      switch (p.shape) {
        case 'box':
          value = 0; // The grid's own walls are the box.
          break;
        case 'circle':
          value = Math.hypot(xi, yj) > halfX ? p.depth : 0;
          break;
        case 'harmonic':
          value = p.depth * ((xi * xi) / (halfX * halfX) + (yj * yj) / (halfY * halfY));
          break;
        case 'separable':
          value = potentialAt(world.features, xi) + potentialAt(world.features, yj);
          break;
        default:
          break;
      }
      v[j * nx + i] = value;
    }
  }
  return { x, y, v, dx, dy, nx, ny };
}

/**
 * The lowest states of the two-dimensional problem.
 *
 * Not by brute force. A 70×47 grid is a 3290×3290 Hamiltonian whose spectrum
 * runs from 0.3 eV to about 190 eV, so the gap between the states anyone cares
 * about is a thousandth of the range — which is precisely the regime where
 * Krylov methods crawl and imaginary-time relaxation needs tens of thousands of
 * steps. The first version of this used Lanczos and reported a ground state
 * nearly twice the true one, with the degeneracies of a square box split.
 *
 * The way out is that every shape offered here has a symmetry:
 *
 *   - box, harmonic and separable potentials are V(x) + V(y), so the states
 *     are products and the energies are sums of two one-dimensional ladders;
 *   - a circular well is V(r), so in polar coordinates each angular momentum m
 *     gives its own one-dimensional radial problem.
 *
 * Either way the answer comes from the same tridiagonal eigensolver as the 1D
 * mode, exactly and in milliseconds, and the degeneracies come out as
 * degeneracies rather than as two nearly-equal numbers.
 */
export function solvePlaneStates(world: QuantumWorld): PlaneStates {
  const grid = samplePlane(world);
  return world.plane.shape === 'circle' ? radialStates(world, grid) : separableStates(world, grid);
}

type PlaneGrid = ReturnType<typeof samplePlane>;

function separableStates(world: QuantumWorld, grid: PlaneGrid): PlaneStates {
  const { x, y, v, dx, dy, nx, ny } = grid;
  const wanted = Math.max(1, Math.min(Math.round(world.plane.levels) || 6, 24));
  // V(x, y) = Vx(x) + Vy(y); read each back off the grid's own edges so this
  // cannot drift from what `samplePlane` actually built.
  const vx = new Float64Array(nx);
  const vy = new Float64Array(ny);
  const corner = v[0];
  for (let i = 0; i < nx; i++) vx[i] = v[i];
  for (let j = 0; j < ny; j++) vy[j] = v[j * nx] - corner;

  const perAxis = Math.min(Math.max(4, wanted), Math.min(nx, ny));
  const xs = solveGrid(vx, dx, world.mass, perAxis);
  const ys = solveGrid(vy, dy, world.mass, perAxis);

  const combos: { energy: number; i: number; j: number }[] = [];
  for (let i = 0; i < perAxis; i++) {
    for (let j = 0; j < perAxis; j++) combos.push({ energy: xs.energies[i] + ys.energies[j], i, j });
  }
  combos.sort((a, b) => a.energy - b.energy);

  const count = Math.min(wanted, combos.length);
  const size = nx * ny;
  const psi = new Float64Array(count * size);
  const energies = new Float64Array(count);
  const labels: string[] = [];
  for (let s = 0; s < count; s++) {
    const { energy, i, j } = combos[s];
    energies[s] = energy;
    labels.push(`nₓ = ${i + 1}, n_y = ${j + 1}`);
    const out = psi.subarray(s * size, (s + 1) * size);
    for (let b = 0; b < ny; b++) {
      const yv = ys.psi[j * ny + b];
      for (let a = 0; a < nx; a++) out[b * nx + a] = xs.psi[i * nx + a] * yv;
    }
  }
  return { nx, ny, dx, dy, x, y, v, energies, psi, count, labels };
}

/**
 * A circular well, separated in polar coordinates.
 *
 * With ψ = R(r)e^{imφ} the radial operator is −c(1/r)(r R′)′ + cm²R/r², whose
 * obvious discretisation is not symmetric. The textbook cure is the
 * substitution u = √r R, which symmetrises it at the price of a −c/4r² term —
 * and that term is singular at the origin, converges badly there, and put the
 * ground state of a unit circle eighteen per cent high when this was first
 * written.
 *
 * The finite-volume form has no such term. Integrating over annular cells with
 * their centres at (i + ½)dr puts the innermost cell face exactly at r = 0,
 * where the flux is zero by symmetry, so the boundary condition at the origin
 * is imposed by the geometry rather than by a divergent potential. Scaling by
 * √r afterwards makes the matrix symmetric with no leftovers.
 */
function radialStates(world: QuantumWorld, grid: PlaneGrid): PlaneStates {
  const { x, y, v, dx, dy, nx, ny } = grid;
  const wanted = Math.max(1, Math.min(Math.round(world.plane.levels) || 6, 24));
  const radius = Math.max(0.05, world.plane.size);
  const outer = Math.hypot(x[nx - 1], y[ny - 1]);
  const points = clampPoints(Math.round(nx * 2), 64, 1200);
  const dr = outer / points;
  const r = new Float64Array(points);
  for (let i = 0; i < points; i++) r[i] = (i + 0.5) * dr;

  const coefficient = KINETIC / Math.max(1e-6, world.mass);
  const kinetic = coefficient / (dr * dr);
  const perM = Math.max(2, Math.ceil(wanted / 2));
  const found: { energy: number; m: number; radial: Float64Array; label: string }[] = [];
  for (let m = 0; m <= 6; m++) {
    const diagonal = new Float64Array(points);
    const sub = new Float64Array(points);
    for (let i = 0; i < points; i++) {
      const potential = r[i] > radius ? world.plane.depth : 0;
      diagonal[i] = 2 * kinetic + (coefficient * m * m) / (r[i] * r[i]) + potential;
    }
    for (let i = 1; i < points; i++) {
      // The face between cells i−1 and i sits at r = i·dr.
      sub[i] = -kinetic * (i / Math.sqrt((i - 0.5) * (i + 0.5)));
    }
    const solved = solveTridiagonal(diagonal, sub, dr, perM);
    for (let s = 0; s < perM; s++) {
      found.push({
        energy: solved.energies[s],
        m,
        radial: solved.psi.slice(s * points, (s + 1) * points),
        label: `m = ${m}, n = ${s + 1}`,
      });
    }
  }
  found.sort((a, b) => a.energy - b.energy);

  const count = Math.min(wanted, found.length);
  const size = nx * ny;
  const psi = new Float64Array(count * size);
  const energies = new Float64Array(count);
  const labels: string[] = [];
  for (let s = 0; s < count; s++) {
    const state = found[s];
    energies[s] = state.energy;
    // Every m ≥ 1 is doubly degenerate — cos mφ and sin mφ. Saying so is more
    // use than listing the same picture rotated by a quarter turn.
    labels.push(state.m === 0 ? state.label : `${state.label} (×2)`);
    const out = psi.subarray(s * size, (s + 1) * size);
    // u is normalised as ∫u² dr = 1 and ψ = (u/√r) × angular; the angular part
    // integrates to 2π for m = 0 and to π otherwise.
    const angularNorm = 1 / Math.sqrt(state.m === 0 ? 2 * Math.PI : Math.PI);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const rr = Math.hypot(x[i], y[j]);
        if (rr >= outer || rr < 1e-9) continue;
        const at = rr / dr - 0.5;
        const k = Math.floor(at);
        const frac = at - k;
        const a = k >= 0 && k < points ? state.radial[k] : state.radial[0];
        const b = k + 1 < points ? state.radial[k + 1] : 0;
        const u = a + (b - a) * frac;
        const angle = state.m === 0 ? 1 : Math.cos(state.m * Math.atan2(y[j], x[i]));
        out[j * nx + i] = (u / Math.sqrt(rr)) * angle * angularNorm;
      }
    }
  }
  return { nx, ny, dx, dy, x, y, v, energies, psi, count, labels };
}

/** Levels of an infinite rectangular box, for checking the 2D solver. */
export function boxLevels(width: number, height: number, mass = 1, count = 10): number[] {
  const coefficient = KINETIC / Math.max(1e-6, mass);
  const out: number[] = [];
  for (let nx = 1; nx <= 8; nx++) {
    for (let ny = 1; ny <= 8; ny++) {
      out.push(coefficient * Math.PI * Math.PI * ((nx * nx) / (width * width) + (ny * ny) / (height * height)));
    }
  }
  return out.sort((a, b) => a - b).slice(0, count);
}
