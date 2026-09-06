/* Waves and optics.
 *
 * Three calculations that are usually taught as three unrelated chapters, and
 * are here because they are the same physics looked at from three distances:
 *
 *   Propagation — the wave equation on a medium, integrated directly, with
 *     real boundary conditions and real reflections at a change of medium.
 *   Diffraction — the Rayleigh–Sommerfeld integral over whatever aperture you
 *     draw. Not the single-slit formula with the numbers filled in: the actual
 *     sum over the aperture, so an aperture nobody has a formula for still
 *     gives the right pattern, and the textbook results appear as the limits
 *     they are.
 *   Rays — Snell's law applied exactly at each surface. Not the paraxial
 *     matrix, so total internal reflection happens because the arithmetic says
 *     so, and spherical aberration is visible rather than assumed away.
 *
 * Everything is SI internally. The interface talks in nanometres and
 * millimetres where those are the units a person would say out loud, and
 * converts at the boundary.
 */

export const SPEED_OF_LIGHT = 299792458;
export const GRAVITY = 9.80665;

// ------------------------------------------------------------------ media

export type MediumId = 'string' | 'spring' | 'sound' | 'water' | 'em';

export interface MediumParam {
  key: string;
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface Medium {
  id: MediumId;
  label: string;
  blurb: string;
  params: MediumParam[];
  /** Phase speed at long wavelength, in m/s. */
  speed: (p: Record<string, number>) => number;
  /** The honest dispersion relation, ω(k) in rad/s. */
  omega: (k: number, p: Record<string, number>) => number;
  /** Displayed units for the wave itself. */
  spaceUnit: string;
  /** A sensible domain length, in metres. */
  extent: number;
  dispersive: boolean;
}

const param = (key: string, label: string, unit: string, def: number, min: number, max: number, step: number): MediumParam => ({
  key,
  label,
  unit,
  default: def,
  min,
  max,
  step,
});

export const MEDIA: Medium[] = [
  {
    id: 'string',
    label: 'Wave on a string',
    blurb: 'v = √(T/μ). Non-dispersive: every wavelength travels at the same speed, so a pulse keeps its shape.',
    params: [param('tension', 'Tension', 'N', 40, 0.5, 500, 0.5), param('density', 'Mass per metre', 'kg/m', 0.01, 0.0005, 1, 0.0005)],
    speed: (p) => Math.sqrt(Math.max(1e-9, p.tension) / Math.max(1e-9, p.density)),
    omega: (k, p) => Math.abs(k) * Math.sqrt(Math.max(1e-9, p.tension) / Math.max(1e-9, p.density)),
    spaceUnit: 'm',
    extent: 1,
    dispersive: false,
  },
  {
    id: 'spring',
    label: 'Mass–spring chain',
    blurb:
      'ω = 2√(k/m)|sin(qa/2)|. Dispersive, and with a hard ceiling: above 2√(k/m) nothing propagates at all, which is where a phonon band gap comes from.',
    params: [
      param('stiffness', 'Spring constant', 'N/m', 200, 1, 5000, 1),
      param('mass', 'Mass per bead', 'kg', 0.02, 0.001, 2, 0.001),
      param('spacing', 'Spacing', 'm', 0.02, 0.002, 0.2, 0.001),
    ],
    speed: (p) => Math.sqrt(Math.max(1e-9, p.stiffness) / Math.max(1e-9, p.mass)) * Math.max(1e-6, p.spacing),
    omega: (k, p) => {
      const a = Math.max(1e-6, p.spacing);
      return 2 * Math.sqrt(Math.max(1e-9, p.stiffness) / Math.max(1e-9, p.mass)) * Math.abs(Math.sin((k * a) / 2));
    },
    spaceUnit: 'm',
    extent: 1,
    dispersive: true,
  },
  {
    id: 'sound',
    label: 'Sound in air',
    blurb: 'v = 331.3√(1 + θ/273.15) m/s. Non-dispersive to a very good approximation, which is why music arrives in order.',
    params: [param('temperature', 'Temperature', '°C', 20, -60, 60, 1)],
    speed: (p) => 331.3 * Math.sqrt(Math.max(0.01, 1 + p.temperature / 273.15)),
    omega: (k, p) => Math.abs(k) * 331.3 * Math.sqrt(Math.max(0.01, 1 + p.temperature / 273.15)),
    spaceUnit: 'm',
    extent: 4,
    dispersive: false,
  },
  {
    id: 'water',
    label: 'Water waves',
    blurb:
      'ω = √(gk tanh kh). Strongly dispersive: long waves outrun short ones, which is why swell arrives sorted by wavelength and a ship leaves a wake with a fixed angle.',
    params: [param('depth', 'Depth', 'm', 0.5, 0.01, 50, 0.01)],
    speed: (p) => Math.sqrt(GRAVITY * Math.max(0.001, p.depth)),
    omega: (k, p) => Math.sqrt(GRAVITY * Math.abs(k) * Math.tanh(Math.abs(k) * Math.max(0.001, p.depth))),
    spaceUnit: 'm',
    extent: 6,
    dispersive: true,
  },
  {
    id: 'em',
    label: 'Light in a medium',
    blurb: 'v = c/n. Non-dispersive here unless you make n depend on wavelength, which is exactly what a prism does.',
    params: [param('index', 'Refractive index', '', 1.5, 1, 4, 0.01)],
    speed: (p) => SPEED_OF_LIGHT / Math.max(1, p.index),
    omega: (k, p) => (Math.abs(k) * SPEED_OF_LIGHT) / Math.max(1, p.index),
    spaceUnit: 'm',
    extent: 1e-5,
    dispersive: false,
  },
];

export const MEDIUM_BY_ID = new Map(MEDIA.map((m) => [m.id, m]));

/** Group velocity dω/dk, by central difference on the medium's own relation. */
export function groupVelocity(medium: Medium, k: number, p: Record<string, number>): number {
  const h = Math.max(1e-6, Math.abs(k) * 1e-4);
  return (medium.omega(k + h, p) - medium.omega(k - h, p)) / (2 * h);
}

// ------------------------------------------------------------- propagation

export type Boundary = 'fixed' | 'free' | 'absorbing';

export interface WaveWorld {
  view: 'propagate' | 'diffract' | 'rays';
  medium: MediumId;
  params: Record<string, number>;
  /** Length of the medium, in metres. */
  length: number;
  points: number;
  left: Boundary;
  right: Boundary;
  /** Fractional position along the medium where the speed changes, or 0 for
   * a uniform medium. */
  junction: number;
  /** Speed on the far side, as a multiple of the near side's. */
  speedRatio: number;
  source: {
    kind: 'pulse' | 'driven' | 'mode';
    /** Starting centre as a fraction of the length. */
    centre: number;
    /** Pulse width as a fraction of the length. */
    width: number;
    /** Driving frequency in Hz, or the mode number for 'mode'. */
    frequency: number;
    amplitude: number;
  };
  duration: number;
  // ---- diffraction
  wavelength: number;
  slits: Slit[];
  /** Distance to the screen, in metres. */
  screenDistance: number;
  /** Half-width of the screen, in metres. */
  screenWidth: number;
  /** Treat the incoming wave as a plane wave, or as coming from a point. */
  sourceDistance: number;
  // ---- rays
  surfaces: Surface[];
  rayCount: number;
  /** Height of the ray fan at the object, in mm. */
  rayHeight: number;
  /** Object distance in mm; 0 or less means parallel light. */
  objectDistance: number;
  rayAngle: number;
}

export interface Slit {
  id: string;
  /** Centre and width in millimetres. */
  centre: number;
  width: number;
  /** Amplitude transmission, 0–1. */
  transmission: number;
  /** Extra phase in radians — a step of glass over this slit. */
  phase: number;
}

export interface WaveField {
  world: WaveWorld;
  x: Float64Array;
  c: Float64Array;
  dx: number;
  dt: number;
  n: number;
  frames: Float64Array;
  time: Float64Array;
  count: number;
  /** u at the two most recent steps. */
  now: Float64Array;
  before: Float64Array;
  liveTime: number;
  stepsTaken: number;
  decimation: number;
  energy: Float64Array;
  failed: boolean;
  failure: string | null;
}

const MAX_WAVE_FRAMES = 1200;

/**
 * Sets up the string (or air column, or channel) and its initial state.
 *
 * The step is chosen from the Courant condition with a little to spare. At
 * exactly Courant number 1 the leapfrog scheme is *exact* for a uniform
 * medium — the numerical solution is the analytic one to rounding — but a
 * medium with a junction has two speeds and only one of them can be at the
 * magic number, so 0.9 is used and the small dispersion that introduces is the
 * price of the junction being right.
 */
export function createWaveField(world: WaveWorld): WaveField {
  const medium = MEDIUM_BY_ID.get(world.medium) ?? MEDIA[0];
  const n = Math.max(64, Math.min(4000, Math.round(world.points)));
  const length = Math.max(1e-9, world.length);
  const dx = length / (n - 1);
  const base = medium.speed(world.params);
  const x = new Float64Array(n);
  const c = new Float64Array(n);
  const junction = world.junction > 0 ? world.junction * length : Infinity;
  for (let i = 0; i < n; i++) {
    x[i] = i * dx;
    c[i] = x[i] >= junction ? base * Math.max(0.05, world.speedRatio) : base;
  }
  let fastest = 0;
  for (const v of c) fastest = Math.max(fastest, v);
  const dt = (0.9 * dx) / Math.max(1e-9, fastest);

  const now = new Float64Array(n);
  const before = new Float64Array(n);
  const src = world.source;
  if (src.kind === 'pulse') {
    const centre = src.centre * length;
    const width = Math.max(dx * 2, src.width * length);
    for (let i = 0; i < n; i++) {
      now[i] = src.amplitude * Math.exp(-((x[i] - centre) ** 2) / (2 * width * width));
      /* One step back in time for a pulse that is *standing still* at t = 0:
       * it then splits into two halves running opposite ways, which is the
       * demonstration everybody wants. Setting `before` equal to `now` is what
       * makes the initial velocity zero. */
      before[i] = now[i];
    }
  } else if (src.kind === 'mode') {
    const mode = Math.max(1, Math.round(src.frequency));
    for (let i = 0; i < n; i++) {
      // A normal mode of the fixed–fixed string, which should then stand
      // still in shape and simply oscillate.
      now[i] = src.amplitude * Math.sin((mode * Math.PI * x[i]) / length);
      before[i] = now[i];
    }
  }

  const steps = Math.ceil(Math.max(1e-6, world.duration) / dt);
  const decimation = Math.max(1, Math.ceil(steps / MAX_WAVE_FRAMES));
  const frames = Math.floor(steps / decimation) + 2;

  const field: WaveField = {
    world,
    x,
    c,
    dx,
    dt,
    n,
    frames: new Float64Array(frames * n),
    time: new Float64Array(frames),
    energy: new Float64Array(frames),
    count: 0,
    now,
    before,
    liveTime: 0,
    stepsTaken: 0,
    decimation,
    failed: false,
    failure: null,
  };
  pushWaveFrame(field);
  return field;
}

function pushWaveFrame(field: WaveField): void {
  const k = field.count;
  if (k >= field.time.length) return;
  field.frames.set(field.now, k * field.n);
  field.time[k] = field.liveTime;
  // Kinetic plus potential, in the units the scheme works in: enough to show
  // that a fixed end conserves it and an absorbing end does not.
  let energy = 0;
  for (let i = 1; i < field.n - 1; i++) {
    const velocity = (field.now[i] - field.before[i]) / field.dt;
    const slope = (field.now[i + 1] - field.now[i - 1]) / (2 * field.dx);
    energy += 0.5 * (velocity * velocity + field.c[i] * field.c[i] * slope * slope) * field.dx;
  }
  field.energy[k] = energy;
  field.count = k + 1;
}

/** Runs the wave out to `until` seconds. */
export function advanceWaveField(field: WaveField, until: number, budget = 40000): boolean {
  if (field.failed) return true;
  const { n, dx, dt, c } = field;
  const world = field.world;
  const next = new Float64Array(n);
  let done = 0;

  while (field.liveTime < Math.min(until, world.duration) - 1e-15) {
    if (done >= budget) return false;
    if (field.count >= field.time.length - 1) return true;

    for (let i = 1; i < n - 1; i++) {
      const courant = (c[i] * dt) / dx;
      next[i] =
        2 * field.now[i] -
        field.before[i] +
        courant * courant * (field.now[i + 1] - 2 * field.now[i] + field.now[i - 1]);
    }

    applyBoundary(field, next, 0, world.left);
    applyBoundary(field, next, n - 1, world.right);

    if (world.source.kind === 'driven') {
      // The driven end overrides whatever the boundary condition did there.
      next[0] = world.source.amplitude * Math.sin(2 * Math.PI * world.source.frequency * (field.liveTime + dt));
    }

    field.before.set(field.now);
    field.now.set(next);
    field.liveTime += dt;
    field.stepsTaken++;
    if (field.stepsTaken % field.decimation === 0) pushWaveFrame(field);
    done++;
  }
  return true;
}

/**
 * The end of the medium.
 *
 * Fixed is a wall: the wave comes back upside down. Free is a ring on a
 * frictionless pole: it comes back the same way up. Absorbing is neither — a
 * first-order Mur condition that lets the wave leave, so a long medium can be
 * studied without the reflection coming back to confuse it.
 */
function applyBoundary(field: WaveField, next: Float64Array, index: number, kind: Boundary): void {
  const n = field.n;
  const inward = index === 0 ? 1 : n - 2;
  switch (kind) {
    case 'fixed':
      next[index] = 0;
      break;
    case 'free':
      // du/dx = 0 at the end.
      next[index] = next[inward];
      break;
    case 'absorbing': {
      const courant = (field.c[index] * field.dt) / field.dx;
      next[index] =
        field.now[inward] + ((courant - 1) / (courant + 1)) * (next[inward] - field.now[index]);
      break;
    }
    default:
      next[index] = 0;
  }
}

/**
 * Amplitude reflected at a change of wave speed.
 *
 * Matching displacement and slope across the join gives r = (c₂−c₁)/(c₂+c₁):
 * into a slower medium the reflection is inverted, into a faster one it is
 * not, and the two are equal and opposite for the same ratio either way. The
 * simulation is not told this — it comes out of the integration — which is
 * what makes it worth checking.
 */
export const reflectionCoefficient = (c1: number, c2: number): number => (c2 - c1) / (c2 + c1);
export const transmissionCoefficient = (c1: number, c2: number): number => (2 * c2) / (c1 + c2);

/**
 * Normal-mode frequencies of a length of medium, in Hz.
 *
 * Empty when either end absorbs. A standing wave is what is left when a
 * travelling one comes back and interferes with itself; an end that reflects
 * nothing sends it away for good, and there is no resonance at any frequency.
 * Printing a ladder there — as this did, quietly handing back the clarinet's
 * odd harmonics because "absorbing" was neither fixed nor free — describes a
 * string that is not the one on screen.
 */
export function modeFrequencies(speed: number, length: number, left: Boundary, right: Boundary, count = 6): number[] {
  if (left === 'absorbing' || right === 'absorbing') return [];
  const out: number[] = [];
  const bothSame = left === right;
  for (let n = 1; n <= count; n++) {
    // Fixed–fixed and free–free both give nv/2L; one of each gives the odd
    // harmonics of v/4L, which is why a clarinet sounds hollow.
    out.push(bothSame ? (n * speed) / (2 * length) : ((2 * n - 1) * speed) / (4 * length));
  }
  return out;
}

// ------------------------------------------------------------- diffraction

export interface DiffractionResult {
  /** Positions on the screen, in metres. */
  x: Float64Array;
  /** Intensity, normalised so the maximum is 1. */
  intensity: Float64Array;
  /** Angle from the axis, in radians. */
  angle: Float64Array;
  /** Where the far-field approximation would put the first minimum, if the
   * aperture is a single slit. */
  firstMinimum: number | null;
  fringeSpacing: number | null;
  fresnelNumber: number;
}

/**
 * The pattern on the screen, by summing over the aperture.
 *
 * This is the Rayleigh–Sommerfeld integral done as a sum: every point of every
 * open slit is a source, each contributes e^{ikr}/√r at the observation point,
 * and the intensity is the squared modulus of the total. Nothing about slit
 * widths or spacings is built in.
 *
 * That matters more than it might seem. A single-slit formula gives a single
 * slit; this gives the right answer for three unequal slits with a phase step
 * over one of them, and it gives the *near field* correctly, where the
 * textbook formulae are simply wrong. Fraunhofer's sinc² and Young's fringes
 * then appear as the far-field limit of this rather than as separate rules,
 * which is what they are.
 */
export function diffractionPattern(world: WaveWorld, samples = 800): DiffractionResult {
  const lambda = Math.max(1e-12, world.wavelength * 1e-9);
  const k = (2 * Math.PI) / lambda;
  const D = Math.max(1e-6, world.screenDistance);
  const half = Math.max(1e-9, world.screenWidth);
  const slits = world.slits.filter((s) => s.width > 0 && s.transmission > 0);

  // Sample the aperture finely enough that the phase never jumps more than a
  // fraction of a cycle between neighbouring points; too coarse and the sum
  // becomes an aliased mess that still looks plausible.
  const widest = slits.reduce((m, s) => Math.max(m, s.width * 1e-3), 1e-9);
  const totalWidth = slits.reduce((sum, s) => sum + s.width * 1e-3, 0);
  const perSlit = Math.max(24, Math.min(4000, Math.ceil((widest / lambda) * 8)));

  const x = new Float64Array(samples);
  const angle = new Float64Array(samples);
  const intensity = new Float64Array(samples);
  let peak = 0;

  const sourceD = world.sourceDistance;
  for (let s = 0; s < samples; s++) {
    const xs = -half + (2 * half * s) / (samples - 1);
    x[s] = xs;
    angle[s] = Math.atan2(xs, D);
    let re = 0;
    let im = 0;
    for (const slit of slits) {
      const centre = slit.centre * 1e-3;
      const width = slit.width * 1e-3;
      const step = width / perSlit;
      for (let j = 0; j < perSlit; j++) {
        const xa = centre - width / 2 + step * (j + 0.5);
        const r = Math.hypot(D, xs - xa);
        // An incoming spherical wave adds its own path from the source to the
        // aperture; a plane wave (sourceDistance ≤ 0) adds nothing.
        const incoming = sourceD > 0 ? Math.hypot(sourceD, xa) : 0;
        const phase = k * (r + incoming) + slit.phase;
        const amplitude = (slit.transmission * step) / Math.sqrt(r);
        re += amplitude * Math.cos(phase);
        im += amplitude * Math.sin(phase);
      }
    }
    const value = re * re + im * im;
    intensity[s] = value;
    if (value > peak) peak = value;
  }
  if (peak > 0) for (let s = 0; s < samples; s++) intensity[s] /= peak;

  // The textbook landmarks, for comparison — reported, never used.
  const single = slits.length === 1 ? slits[0] : null;
  const firstMinimum = single ? Math.asin(Math.min(1, lambda / (single.width * 1e-3))) : null;
  let fringeSpacing: number | null = null;
  if (slits.length >= 2) {
    const spacing = Math.abs(slits[1].centre - slits[0].centre) * 1e-3;
    if (spacing > 0) fringeSpacing = (lambda * D) / spacing;
  }
  const fresnelNumber = (totalWidth / 2) ** 2 / (lambda * D);

  return { x, intensity, angle, firstMinimum, fringeSpacing, fresnelNumber };
}

/** Fraunhofer intensity for N identical slits, for drawing beside the real one. */
export function fraunhoferPattern(
  angle: number,
  wavelengthNm: number,
  slitWidthMm: number,
  spacingMm: number,
  count: number,
): number {
  const lambda = wavelengthNm * 1e-9;
  const a = slitWidthMm * 1e-3;
  const d = spacingMm * 1e-3;
  const beta = (Math.PI * a * Math.sin(angle)) / lambda;
  const gamma = (Math.PI * d * Math.sin(angle)) / lambda;
  const envelope = Math.abs(beta) < 1e-12 ? 1 : (Math.sin(beta) / beta) ** 2;
  if (count <= 1) return envelope;
  const interference =
    Math.abs(Math.sin(gamma)) < 1e-12
      ? count * count
      : (Math.sin(count * gamma) / Math.sin(gamma)) ** 2;
  return (envelope * interference) / (count * count);
}

// -------------------------------------------------------------------- rays

export interface Surface {
  id: string;
  /** Vertex position along the axis, in millimetres. */
  z: number;
  /** Radius of curvature in mm; positive means the centre is to the right.
   * Zero is flat. */
  radius: number;
  /** Rotation of a flat surface about its vertex, in degrees. Curved surfaces
   * ignore it: a tilted sphere is a great deal more arithmetic for one more
   * demonstration, whereas a tilted *plane* is three lines and gives prisms,
   * and with them dispersion and total internal reflection. */
  tilt: number;
  /** Half-height of the surface, in mm. */
  aperture: number;
  /** Refractive index *after* the surface. */
  index: number;
  /** A mirror reflects rather than refracts. */
  mirror: boolean;
  label: string;
}

export interface RaySegment {
  points: { z: number; y: number }[];
  /** Where it stopped, if it did. */
  stopped: 'aperture' | 'reflected' | null;
  /** Whether it was ever totally internally reflected. */
  totalInternal: boolean;
}

/**
 * Traces rays through a stack of surfaces, exactly.
 *
 * Each ray is intersected with the actual spherical surface and refracted by
 * Snell's law in the plane, rather than pushed through a paraxial matrix. That
 * costs a square root per surface and buys the two things the paraxial model
 * throws away: total internal reflection, which is a *failure* of Snell's law
 * to have a solution and simply cannot appear in a linear model, and spherical
 * aberration, which is the difference between where the edge of a lens sends a
 * ray and where the middle does.
 */
export function traceRays(world: WaveWorld): RaySegment[] {
  const surfaces = [...world.surfaces].sort((a, b) => a.z - b.z);
  const rays: RaySegment[] = [];
  const count = Math.max(1, Math.min(64, Math.round(world.rayCount)));
  const far = surfaces.length ? surfaces[surfaces.length - 1].z + 120 : 200;

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (2 * i) / (count - 1) - 1;
    let y = t * world.rayHeight;
    let z = surfaces.length ? Math.min(0, surfaces[0].z - 40) : 0;
    // Direction as a unit vector in the (z, y) plane.
    let dz = 1;
    let dy = Math.tan((world.rayAngle * Math.PI) / 180);

    if (world.objectDistance > 0) {
      // A point object on the axis at −objectDistance: the fan diverges from
      // it, which is what makes the image-forming demonstrations work.
      z = (surfaces[0]?.z ?? 0) - world.objectDistance;
      y = 0;
      const spread = Math.atan2(t * world.rayHeight, world.objectDistance);
      dy = Math.tan(spread + (world.rayAngle * Math.PI) / 180);
    }
    const norm = Math.hypot(dz, dy);
    dz /= norm;
    dy /= norm;

    const points = [{ z, y }];
    let index = 1;
    let stopped: RaySegment['stopped'] = null;
    let totalInternal = false;

    for (const surface of surfaces) {
      const hit = intersect(z, y, dz, dy, surface);
      if (!hit) {
        stopped = 'aperture';
        break;
      }
      z = hit.z;
      y = hit.y;
      points.push({ z, y });
      if (Math.abs(y) > surface.aperture) {
        stopped = 'aperture';
        break;
      }

      // Surface normal, pointing back along the axis.
      let nz: number;
      let ny: number;
      if (surface.radius === 0) {
        ({ nz, ny } = flatNormal(surface));
      } else {
        const centre = surface.z + surface.radius;
        const len = Math.hypot(z - centre, y);
        nz = (z - centre) / len;
        ny = y / len;
        if (surface.radius > 0) {
          nz = -nz;
          ny = -ny;
        }
      }

      if (surface.mirror) {
        const dot = dz * nz + dy * ny;
        dz -= 2 * dot * nz;
        dy -= 2 * dot * ny;
        stopped = 'reflected';
        // A mirror sends the ray back; the loop's remaining surfaces are
        // behind it now, so stop rather than pretend to trace on.
        const back = { z: z + dz * 120, y: y + dy * 120 };
        points.push(back);
        break;
      }

      const refracted = refract(dz, dy, nz, ny, index, surface.index);
      if (!refracted) {
        totalInternal = true;
        const dot = dz * nz + dy * ny;
        dz -= 2 * dot * nz;
        dy -= 2 * dot * ny;
      } else {
        dz = refracted.dz;
        dy = refracted.dy;
        index = surface.index;
      }
    }

    if (stopped !== 'reflected') {
      const run = far - z;
      points.push({ z: far, y: y + (dy / (dz || 1e-9)) * run });
    }
    rays.push({ points, stopped, totalInternal });
  }
  return rays;
}

/** Unit normal of a flat surface, pointing back along the axis when untilted. */
function flatNormal(surface: Surface): { nz: number; ny: number } {
  const t = ((surface.tilt || 0) * Math.PI) / 180;
  return { nz: -Math.cos(t), ny: Math.sin(t) };
}

/** Where a ray meets a surface, or null if it misses. */
function intersect(
  z: number,
  y: number,
  dz: number,
  dy: number,
  surface: Surface,
): { z: number; y: number } | null {
  if (surface.radius === 0) {
    const { nz, ny } = flatNormal(surface);
    const denominator = dz * nz + dy * ny;
    if (Math.abs(denominator) < 1e-12) return null;
    const t = ((surface.z - z) * nz + (0 - y) * ny) / denominator;
    if (t < 1e-9) return null;
    return { z: z + dz * t, y: y + dy * t };
  }
  const centreZ = surface.z + surface.radius;
  const ox = z - centreZ;
  const oy = y;
  const b = 2 * (ox * dz + oy * dy);
  const cc = ox * ox + oy * oy - surface.radius * surface.radius;
  const disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t1 = (-b - root) / 2;
  const t2 = (-b + root) / 2;
  // The vertex is the near side of the sphere, so take the intersection
  // closest to it among those in front of the ray.
  let best: number | null = null;
  for (const t of [t1, t2]) {
    if (t < 1e-9) continue;
    const hitZ = z + dz * t;
    if (Math.abs(hitZ - surface.z) > Math.abs(surface.radius) * 1.5) continue;
    if (best === null || t < best) best = t;
  }
  if (best === null) return null;
  return { z: z + dz * best, y: y + dy * best };
}

/** Snell's law as a vector operation; null when it has no solution. */
function refract(
  dz: number,
  dy: number,
  nz: number,
  ny: number,
  n1: number,
  n2: number,
): { dz: number; dy: number } | null {
  const eta = n1 / n2;
  let cosI = -(dz * nz + dy * ny);
  let normalZ = nz;
  let normalY = ny;
  if (cosI < 0) {
    cosI = -cosI;
    normalZ = -nz;
    normalY = -ny;
  }
  const sinT2 = eta * eta * (1 - cosI * cosI);
  // sin θ₂ > 1 has no answer: the light cannot get out, and that is total
  // internal reflection rather than an error to clamp away.
  if (sinT2 > 1) return null;
  const cosT = Math.sqrt(1 - sinT2);
  return {
    dz: eta * dz + (eta * cosI - cosT) * normalZ,
    dy: eta * dy + (eta * cosI - cosT) * normalY,
  };
}

/** Focal length of a thin lens from the lensmaker's equation, in mm. */
export function lensmaker(index: number, r1: number, r2: number): number {
  const power = (index - 1) * (1 / r1 - 1 / r2);
  return Math.abs(power) < 1e-12 ? Infinity : 1 / power;
}

/** Where the image is, from 1/v = 1/f − 1/u. Distances in mm. */
export function thinLensImage(focal: number, object: number): number {
  const inverse = 1 / focal - 1 / object;
  return Math.abs(inverse) < 1e-12 ? Infinity : 1 / inverse;
}

/** The angle past which light cannot leave, in degrees, or null if it always can. */
export function criticalAngle(n1: number, n2: number): number | null {
  if (n2 >= n1) return null;
  return (Math.asin(n2 / n1) * 180) / Math.PI;
}

/** Brewster's angle, where the reflection is completely polarised. */
export const brewsterAngle = (n1: number, n2: number): number => (Math.atan2(n2, n1) * 180) / Math.PI;

/**
 * Where a fan of rays crosses the axis after the last surface.
 *
 * Reported per ray rather than as one number, because for a real spherical
 * lens they are not the same: that spread *is* spherical aberration, and
 * averaging it away would hide the thing worth seeing.
 */
export function axisCrossings(rays: RaySegment[]): number[] {
  const out: number[] = [];
  for (const ray of rays) {
    const pts = ray.points;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.y === 0 || b.y === 0 || a.y * b.y > 0) continue;
      const t = a.y / (a.y - b.y);
      out.push(a.z + t * (b.z - a.z));
      break;
    }
  }
  return out;
}
