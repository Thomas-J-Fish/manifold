/* Thermodynamics and kinetic theory.
 *
 * The point of this mode is that the gas laws are not assumed anywhere. There
 * is a box of hard discs with positions and velocities, they collide with each
 * other and with the walls elastically, and pressure is *measured* by adding up
 * the momentum the walls receive. Then:
 *
 *   the speed histogram settles onto Maxwell–Boltzmann without ever being told
 *     what that distribution is,
 *   PV/NkT comes out as one because it has to, not because anything divided by
 *     it,
 *   and compressing the box adiabatically raises the temperature by exactly the
 *     work done on the gas.
 *
 * Two dimensions rather than three, because a picture of it is the whole point
 * and a 3D box of discs draws as a fog. Everything below is therefore the 2D
 * result: ½mv² averages to kT per particle rather than (3/2)kT, the speed
 * distribution is the 2D Maxwell (Rayleigh) rather than the 3D one, and the
 * ideal gas law reads PA = NkT with A an area. Those are the correct
 * statements in two dimensions, and quietly using the 3D ones over a 2D
 * simulation is the mistake this comment exists to prevent.
 */

/** Boltzmann's constant, in the units this simulation actually works in. */
export const BOLTZMANN = 1;

export interface GasParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GasWorld {
  count: number;
  /** Box half-width and half-height, in the simulation's own length unit. */
  width: number;
  height: number;
  radius: number;
  mass: number;
  /** Temperature the particles are seeded at, and the target of the thermostat. */
  temperature: number;
  /** Rate the walls give or take energy, 0 for a perfectly insulated box. */
  thermostat: number;
  seed: string;
  /** Gravity, to make the barometric distribution appear. */
  gravity: number;
}

export interface GasState {
  world: GasWorld;
  particles: GasParticle[];
  time: number;
  /**
   * Momentum delivered to the walls since `resetPressureSample` was last
   * called — cumulative, not per frame. `measurePressure` uses it to take an
   * honest reading over a stated window; the smoothed `pressure` below is what
   * the UI displays and is computed from each step's own share instead.
   */
  impulse: number;
  /** How long that impulse has been accumulating over. */
  impulseWindow: number;
  /** Running pressure estimate, smoothed over PRESSURE_TAU. */
  pressure: number;
  collisions: number;
  /** Wall collisions only — what the pressure is actually made of. */
  wallHits: number;
  /**
   * Rate the box's half-width and half-height are currently changing. This is
   * the piston: a wall that moves does work on the gas, which is the whole
   * mechanism behind adiabatic heating, so the reflection below uses the
   * moving-wall rule rather than simply flipping the velocity.
   */
  wallVx: number;
  wallVy: number;
  /** Work the moving walls have done on the gas since the state was created. */
  wallWork: number;
}

/** How quickly the displayed pressure follows a change, in simulation time. */
const PRESSURE_TAU = 0.5;

/* A small xorshift, kept local so a gas is reproducible from its seed without
 * depending on anything outside this file. */
function makeRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/**
 * Fills the box.
 *
 * Positions on a jittered lattice rather than uniformly at random, because at
 * any interesting density uniform placement overlaps discs, and two discs that
 * start inside each other fly apart at whatever speed the overlap implies —
 * which shows up later as a gas that mysteriously heated itself.
 *
 * Speeds are seeded from a Maxwell–Boltzmann distribution, but that is a
 * convenience rather than the point: `randomiseSpeeds` can start every particle
 * at the *same* speed instead, and the distribution still forms, which is the
 * demonstration worth watching.
 */
export function createGas(input: GasWorld, identicalSpeeds = false): GasState {
  // The box's dimensions change when the piston moves, so the state gets its
  // own copy rather than quietly editing whatever the caller passed in.
  const world: GasWorld = { ...input };
  const random = makeRandom(world.seed);
  const n = Math.max(1, Math.min(4000, Math.round(world.count)));
  const particles: GasParticle[] = [];

  const columns = Math.ceil(Math.sqrt((n * world.width) / world.height));
  const rows = Math.ceil(n / columns);
  const cellW = (2 * world.width) / columns;
  const cellH = (2 * world.height) / rows;
  const jitter = Math.max(0, Math.min(cellW, cellH) / 2 - world.radius) * 0.8;

  // In two dimensions ⟨½mv²⟩ = kT, so the speed that carries the mean energy
  // is √(2kT/m) and each component has variance kT/m.
  const sigma = Math.sqrt((BOLTZMANN * world.temperature) / world.mass);
  const speed = Math.sqrt((2 * BOLTZMANN * world.temperature) / world.mass);

  // For the identical-speed start the directions are spread evenly round the
  // circle and then shuffled onto the lattice. Evenly spaced unit vectors sum
  // to zero, so the gas has no net drift *without* anything being subtracted
  // afterwards — and subtracting a drift is exactly what would spoil the one
  // property this start exists to have, that every speed is the same.
  const directions: number[] = [];
  if (identicalSpeeds) {
    const offset = random();
    for (let i = 0; i < n; i++) directions.push((2 * Math.PI * (i + offset)) / n);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [directions[i], directions[j]] = [directions[j], directions[i]];
    }
  }

  for (let i = 0; i < n; i++) {
    const c = i % columns;
    const r = Math.floor(i / columns);
    const x = -world.width + cellW * (c + 0.5) + (random() - 0.5) * 2 * jitter;
    const y = -world.height + cellH * (r + 0.5) + (random() - 0.5) * 2 * jitter;

    let vx: number;
    let vy: number;
    if (identicalSpeeds) {
      // Same speed, spread of directions: the state that makes the histogram's
      // relaxation onto Maxwell–Boltzmann obvious rather than assumed.
      vx = speed * Math.cos(directions[i]);
      vy = speed * Math.sin(directions[i]);
    } else {
      // Box–Muller, twice, for two independent Gaussian components.
      const u1 = Math.max(1e-12, random());
      const u2 = random();
      const mag = sigma * Math.sqrt(-2 * Math.log(u1));
      vx = mag * Math.cos(2 * Math.PI * u2);
      vy = mag * Math.sin(2 * Math.PI * u2);
    }
    particles.push({ x: clamp(x, world), y: clampY(y, world), vx, vy });
  }

  if (!identicalSpeeds) {
    // Remove any net drift: a box of gas that is also travelling sideways has
    // a higher measured "temperature" than it should, because the drift energy
    // is not thermal.
    let mx = 0;
    let my = 0;
    for (const p of particles) {
      mx += p.vx;
      my += p.vy;
    }
    mx /= particles.length;
    my /= particles.length;
    for (const p of particles) {
      p.vx -= mx;
      p.vy -= my;
    }

    /* And then scale the whole set so the measured temperature is exactly the
     * one that was asked for.
     *
     * A few hundred samples from a Gaussian have a sample variance several per
     * cent away from the true one, so without this the gas opens reading 1.09
     * when the slider says 1 — and since the box is insulated, it stays at
     * 1.09 for ever. The shape of the distribution is untouched; only its
     * width is set to the requested value. */
    let sum = 0;
    for (const p of particles) sum += p.vx * p.vx + p.vy * p.vy;
    const measured = (world.mass * sum) / (2 * BOLTZMANN * particles.length);
    if (measured > 0) {
      const scale = Math.sqrt(world.temperature / measured);
      for (const p of particles) {
        p.vx *= scale;
        p.vy *= scale;
      }
    }
  }

  return {
    world,
    particles,
    time: 0,
    impulse: 0,
    impulseWindow: 0,
    pressure: 0,
    collisions: 0,
    wallHits: 0,
    wallVx: 0,
    wallVy: 0,
    wallWork: 0,
  };
}

const clamp = (x: number, w: GasWorld) => Math.max(-w.width + w.radius, Math.min(w.width - w.radius, x));
const clampY = (y: number, w: GasWorld) => Math.max(-w.height + w.radius, Math.min(w.height - w.radius, y));

/**
 * Advances the gas by `dt`, in sub-steps small enough that a particle cannot
 * cross another one in a single step.
 *
 * Collisions are resolved pairwise on overlap by exchanging the velocity
 * components along the line of centres — the exact elastic result for equal
 * masses — and the pair is pushed apart to remove the overlap so the same
 * collision is not detected again on the next step and the pair does not stick
 * together. A uniform grid keeps the pair search linear rather than quadratic,
 * which is what makes a thousand particles interactive.
 */
export function advanceGas(state: GasState, dt: number, substeps = 0): void {
  const w = state.world;
  const fastest = state.particles.reduce((m, p) => Math.max(m, Math.hypot(p.vx, p.vy)), 1e-9);
  const safe = Math.max(1, Math.ceil((fastest * dt) / (w.radius * 0.5)));
  const steps = Math.max(1, Math.min(200, substeps || safe));
  const h = dt / steps;
  const delivered0 = state.impulse;

  for (let s = 0; s < steps; s++) {
    // The piston moves first, so a particle that the wall has just swept past
    // is caught by the reflection below in the same sub-step.
    if (state.wallVx !== 0) w.width = Math.max(w.radius * 2, w.width + state.wallVx * h);
    if (state.wallVy !== 0) w.height = Math.max(w.radius * 2, w.height + state.wallVy * h);

    for (const p of state.particles) {
      if (w.gravity !== 0) p.vy -= w.gravity * h;
      p.x += p.vx * h;
      p.y += p.vy * h;
    }
    bounceWalls(state, h);
    collide(state);
    state.time += h;
  }

  if (w.thermostat > 0) applyThermostat(state, dt);

  // Pressure is force per unit length of wall in two dimensions: the momentum
  // this step delivered, divided by the time it took and by the perimeter.
  const perimeter = 4 * (w.width + w.height);
  if (dt > 0 && perimeter > 0) {
    const instant = (state.impulse - delivered0) / (dt * perimeter);
    // Exponential smoothing over a fixed time constant, because a raw reading
    // over one frame is nearly all shot noise at these particle counts, and
    // because a smoother tied to the frame rate would report a different
    // pressure at a different frame rate.
    const alpha = 1 - Math.exp(-dt / PRESSURE_TAU);
    state.pressure = state.pressure === 0 ? instant : state.pressure + alpha * (instant - state.pressure);
  }
}

/**
 * Reflects everything that has left the box.
 *
 * A stationary wall simply reverses the normal velocity. A *moving* wall sends
 * v to 2u − v, where u is the wall's own velocity — which is where the work
 * done in a compression enters the gas, and the reason a squeezed box gets
 * hotter here without anybody applying the adiabatic formula to it.
 */
function bounceWalls(state: GasState, h: number): void {
  const w = state.world;
  const m = w.mass;
  // The right wall sits at +width and so travels at +wallVx; the left wall
  // sits at −width and travels at −wallVx.
  const ux = state.wallVx;
  const uy = state.wallVy;
  const xLimit = w.width - w.radius;
  const yLimit = w.height - w.radius;

  for (const p of state.particles) {
    if (p.x < -xLimit) {
      p.x = -xLimit + (-xLimit - p.x);
      const was = p.vx;
      p.vx = -2 * ux - p.vx;
      state.impulse += m * Math.abs(p.vx - was);
      state.wallWork += 0.5 * m * (p.vx * p.vx - was * was);
      state.wallHits++;
    } else if (p.x > xLimit) {
      p.x = xLimit - (p.x - xLimit);
      const was = p.vx;
      p.vx = 2 * ux - p.vx;
      state.impulse += m * Math.abs(p.vx - was);
      state.wallWork += 0.5 * m * (p.vx * p.vx - was * was);
      state.wallHits++;
    }
    if (p.y < -yLimit) {
      p.y = -yLimit + (-yLimit - p.y);
      const was = p.vy;
      p.vy = -2 * uy - p.vy;
      state.impulse += m * Math.abs(p.vy - was);
      state.wallWork += 0.5 * m * (p.vy * p.vy - was * was);
      state.wallHits++;
    } else if (p.y > yLimit) {
      p.y = yLimit - (p.y - yLimit);
      const was = p.vy;
      p.vy = 2 * uy - p.vy;
      state.impulse += m * Math.abs(p.vy - was);
      state.wallWork += 0.5 * m * (p.vy * p.vy - was * was);
      state.wallHits++;
    }
  }
  state.impulseWindow += h;
}

function collide(state: GasState): void {
  const w = state.world;
  const d = 2 * w.radius;
  const cell = Math.max(d, 1e-6);
  const columns = Math.max(1, Math.ceil((2 * w.width) / cell));
  const rows = Math.max(1, Math.ceil((2 * w.height) / cell));
  const buckets = new Map<number, number[]>();

  const key = (cx: number, cy: number) => cy * columns + cx;
  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    const cx = Math.max(0, Math.min(columns - 1, Math.floor((p.x + w.width) / cell)));
    const cy = Math.max(0, Math.min(rows - 1, Math.floor((p.y + w.height) / cell)));
    const k = key(cx, cy);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(i);
    else buckets.set(k, [i]);
  }

  for (let i = 0; i < state.particles.length; i++) {
    const a = state.particles[i];
    const cx = Math.max(0, Math.min(columns - 1, Math.floor((a.x + w.width) / cell)));
    const cy = Math.max(0, Math.min(rows - 1, Math.floor((a.y + w.height) / cell)));
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const nx = cx + ox;
        const ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
        const bucket = buckets.get(key(nx, ny));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const b = state.particles[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 >= d * d || dist2 < 1e-18) continue;

          const dist = Math.sqrt(dist2);
          const nxu = dx / dist;
          const nyu = dy / dist;
          // Relative velocity along the line of centres. A negative value
          // means they are approaching; a pair already separating is left
          // alone, which is what stops a jammed cluster from exploding.
          const rel = (b.vx - a.vx) * nxu + (b.vy - a.vy) * nyu;
          if (rel > 0) continue;

          // Equal masses: the pair simply swaps the component along the line.
          a.vx += rel * nxu;
          a.vy += rel * nyu;
          b.vx -= rel * nxu;
          b.vy -= rel * nyu;

          const overlap = (d - dist) / 2;
          a.x -= nxu * overlap;
          a.y -= nyu * overlap;
          b.x += nxu * overlap;
          b.y += nyu * overlap;
          state.collisions++;
        }
      }
    }
  }
}

/** Nudges the kinetic energy towards the set temperature, gently. */
function applyThermostat(state: GasState, dt: number): void {
  const w = state.world;
  const current = temperatureOf(state);
  if (!(current > 0)) return;
  const target = w.temperature;
  const rate = Math.min(1, w.thermostat * dt);
  const scale = Math.sqrt(1 + rate * (target / current - 1));
  for (const p of state.particles) {
    p.vx *= scale;
    p.vy *= scale;
  }
}

/**
 * Temperature from the particles themselves.
 *
 * In two dimensions equipartition gives ½kT per degree of freedom and there
 * are two, so ⟨½mv²⟩ = kT and T = ⟨mv²⟩/2k. This is a *measurement* of the
 * state, not the `temperature` field of the world — the two agree only when
 * the gas has been left alone long enough, and watching them disagree during
 * a compression is the point of the adiabatic demonstration.
 */
export function temperatureOf(state: GasState): number {
  if (!state.particles.length) return 0;
  let sum = 0;
  for (const p of state.particles) sum += p.vx * p.vx + p.vy * p.vy;
  return (state.world.mass * sum) / (2 * BOLTZMANN * state.particles.length);
}

export function kineticEnergy(state: GasState): number {
  let sum = 0;
  for (const p of state.particles) sum += p.vx * p.vx + p.vy * p.vy;
  return 0.5 * state.world.mass * sum;
}

/** Area of the box, which is the "volume" of a two-dimensional gas. */
export const boxArea = (state: GasState): number => 4 * state.world.width * state.world.height;

/** Starts a fresh pressure measurement window. */
export function resetPressureSample(state: GasState): void {
  state.impulse = 0;
  state.impulseWindow = 0;
}

/**
 * Runs the gas for a stated length of time and returns the pressure it
 * actually exerted over that window — total wall momentum per unit time per
 * unit length of wall, with no smoothing and nothing assumed.
 *
 * This is the measurement the ideal gas law is *checked against*: nowhere in
 * getting this number does anything divide by NkT. Hold the box still while
 * measuring, since a moving wall changes the perimeter underneath the reading.
 */
export function measurePressure(state: GasState, duration: number, dt = 0.02): number {
  resetPressureSample(state);
  let elapsed = 0;
  while (elapsed < duration - 1e-12) {
    const step = Math.min(dt, duration - elapsed);
    advanceGas(state, step);
    elapsed += step;
  }
  const perimeter = 4 * (state.world.width + state.world.height);
  return state.impulseWindow > 0 && perimeter > 0 ? state.impulse / (state.impulseWindow * perimeter) : 0;
}

export interface IsothermPoint {
  area: number;
  /** Measured, from wall impulses. */
  pressure: number;
  /** Measured, from the particle speeds. */
  temperature: number;
  /** What the ideal gas law would predict for the pressure at this area. */
  ideal: number;
  /** Measured PA / NkT — one for an ideal gas, above one for real discs. */
  compressibility: number;
}

/**
 * Squeezes the same gas into a series of box sizes and measures the pressure
 * in each, holding the temperature with the thermostat.
 *
 * The result is a measured isotherm. Plotting P against 1/A and finding a
 * straight line through the origin of slope NkT is the ideal gas law arriving
 * as a *fit to data* — and the slow drift of the compressibility above one as
 * the box shrinks is the discs' own area making itself felt, which is the
 * first correction and worth seeing rather than hiding.
 */
export function measureIsotherm(world: GasWorld, scales: number[], settle = 4, window = 12): IsothermPoint[] {
  const out: IsothermPoint[] = [];
  for (const scale of scales) {
    if (!(scale > 0)) continue;
    const state = createGas({
      ...world,
      width: world.width * scale,
      height: world.height * scale,
      thermostat: Math.max(world.thermostat, 1),
    });
    for (let t = 0; t < settle; t += 0.05) advanceGas(state, 0.05);
    const pressure = measurePressure(state, window, 0.05);
    const temperature = temperatureOf(state);
    const area = boxArea(state);
    const ideal = (state.particles.length * BOLTZMANN * temperature) / area;
    out.push({
      area,
      pressure,
      temperature,
      ideal,
      compressibility: ideal > 0 ? pressure / ideal : 0,
    });
  }
  return out;
}

/** Speeds of every particle, for the histogram. */
export function speeds(state: GasState): number[] {
  return state.particles.map((p) => Math.hypot(p.vx, p.vy));
}

/**
 * The two-dimensional Maxwell–Boltzmann speed distribution.
 *
 * f(v) = (m/kT)·v·exp(−mv²/2kT) — a Rayleigh distribution, not the v² one from
 * three dimensions. Using the 3D form over a 2D simulation is the single
 * easiest way to make this mode subtly wrong, and it would look almost right.
 */
export function maxwellBoltzmann2D(v: number, temperature: number, mass: number): number {
  if (!(temperature > 0) || v < 0) return 0;
  const a = mass / (BOLTZMANN * temperature);
  return a * v * Math.exp((-a * v * v) / 2);
}

/** Most probable, mean and rms speeds in two dimensions. */
export function speedMoments(temperature: number, mass: number): { mode: number; mean: number; rms: number } {
  const kT = BOLTZMANN * temperature;
  return {
    mode: Math.sqrt(kT / mass),
    mean: Math.sqrt((Math.PI * kT) / (2 * mass)),
    rms: Math.sqrt((2 * kT) / mass),
  };
}

export interface Histogram {
  edges: number[];
  /** Normalised so the bars integrate to one, and so comparable with the curve. */
  density: number[];
}

export function speedHistogram(values: number[], bins: number, max: number): Histogram {
  const n = Math.max(4, Math.min(200, Math.round(bins)));
  const top = max > 0 ? max : Math.max(1e-9, ...values) * 1.05;
  const edges: number[] = [];
  for (let i = 0; i <= n; i++) edges.push((top * i) / n);
  const counts = new Array<number>(n).fill(0);
  for (const v of values) {
    const k = Math.floor((v / top) * n);
    if (k >= 0 && k < n) counts[k]++;
  }
  const width = top / n;
  const total = values.length || 1;
  return { edges, density: counts.map((c) => c / (total * width)) };
}

// ------------------------------------------------------------------- cycles

export type ProcessKind = 'isothermal' | 'isobaric' | 'isochoric' | 'adiabatic';

export interface CycleLeg {
  id: string;
  kind: ProcessKind;
  /** Where the leg ends: a volume, or a pressure for an isochoric leg. */
  target: number;
  label: string;
}

export interface CyclePoint {
  v: number;
  p: number;
  t: number;
}

export interface CycleLegResult {
  kind: ProcessKind;
  points: CyclePoint[];
  /** ∫P dV along this leg. */
  work: number;
  /** Heat in, from the first law. */
  heat: number;
  deltaU: number;
}

export interface CycleResult {
  legs: CycleLegResult[];
  netWork: number;
  heatIn: number;
  heatOut: number;
  efficiency: number;
  /** True when the cycle returns to where it started, to within a part in 1e-6. */
  closed: boolean;
  message: string;
}

/**
 * Traces a cycle on the PV plane and accounts for it by the first law.
 *
 * Each leg is integrated rather than looked up: the work is ∫P dV computed on
 * the sampled path by the trapezium rule, the internal energy change is
 * f/2·nRΔT for the given degrees of freedom, and the heat is whatever the
 * first law then requires. So the efficiency is the *measured* net work over
 * the *measured* heat in, and for a Carnot cycle it comes out at 1 − Tc/Th
 * without that ever being coded.
 */
export function traceCycle(
  legs: CycleLeg[],
  start: { v: number; t: number },
  moles: number,
  gasConstant: number,
  degreesOfFreedom: number,
  samples = 80,
): CycleResult {
  const gamma = (degreesOfFreedom + 2) / degreesOfFreedom;
  const cv = (degreesOfFreedom / 2) * moles * gasConstant;
  const pressureAt = (v: number, t: number) => (moles * gasConstant * t) / v;

  let v = start.v;
  let t = start.t;
  const out: CycleLegResult[] = [];
  const n = Math.max(4, Math.min(2000, Math.round(samples)));
  let message = '';

  for (const leg of legs) {
    const points: CyclePoint[] = [];
    const v0 = v;
    const t0 = t;
    const p0 = pressureAt(v0, t0);

    let v1 = leg.target;
    let t1 = t0;
    switch (leg.kind) {
      case 'isothermal':
        t1 = t0;
        break;
      case 'isobaric':
        // Constant pressure: T scales with V.
        t1 = (t0 * v1) / v0;
        break;
      case 'isochoric': {
        // The target is a pressure here; the volume does not move.
        v1 = v0;
        const p1 = leg.target;
        t1 = (p1 * v0) / (moles * gasConstant);
        break;
      }
      case 'adiabatic':
        // TV^(γ−1) is constant, which is the statement that no heat crosses.
        t1 = t0 * (v0 / v1) ** (gamma - 1);
        break;
    }
    if (!(v1 > 0) || !(t1 > 0)) {
      message = 'A leg asked for a volume or temperature at or below zero, which is not a state the gas can be in.';
      break;
    }

    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const vv = v0 + (v1 - v0) * u;
      let tt: number;
      switch (leg.kind) {
        case 'isothermal':
          tt = t0;
          break;
        case 'isobaric':
          tt = (t0 * vv) / v0;
          break;
        case 'isochoric':
          tt = t0 + (t1 - t0) * u;
          break;
        default:
          tt = t0 * (v0 / vv) ** (gamma - 1);
      }
      points.push({ v: vv, p: leg.kind === 'isochoric' ? p0 + (leg.target - p0) * u : pressureAt(vv, tt), t: tt });
    }

    let work = 0;
    for (let i = 1; i < points.length; i++) {
      work += ((points[i].p + points[i - 1].p) / 2) * (points[i].v - points[i - 1].v);
    }
    const deltaU = cv * (t1 - t0);
    out.push({ kind: leg.kind, points, work, heat: deltaU + work, deltaU });
    v = v1;
    t = t1;
  }

  const netWork = out.reduce((s, l) => s + l.work, 0);
  const heatIn = out.reduce((s, l) => s + Math.max(0, l.heat), 0);
  const heatOut = out.reduce((s, l) => s + Math.min(0, l.heat), 0);
  const closed = Math.abs(v - start.v) < 1e-6 * start.v && Math.abs(t - start.t) < 1e-6 * start.t;

  return {
    legs: out,
    netWork,
    heatIn,
    heatOut,
    efficiency: heatIn > 0 ? netWork / heatIn : 0,
    closed,
    message:
      message ||
      (closed
        ? 'The cycle closes, so the internal energy returns to where it started and the net heat equals the net work.'
        : 'This path does not return to its starting state, so it is not a cycle and the efficiency below is not one.'),
  };
}

/** Carnot's result, for comparison with whatever the traced cycle achieves. */
export const carnotEfficiency = (cold: number, hot: number): number => (hot > 0 ? 1 - cold / hot : 0);
