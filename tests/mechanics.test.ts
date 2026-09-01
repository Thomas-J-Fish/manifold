import { describe, expect, it } from 'vitest';
import {
  advance,
  createTrajectory,
  prepare,
  readMeasurement,
  sampleAt,
  type Body,
  type Link,
  type MechanicsWorld,
  type Measurement,
  type Pulley,
  type Surface,
} from '../src/core/physics/mechanics';

/* Every expectation here is a closed form from a textbook, not a number this
 * engine once produced. That distinction is the whole value of the file: a
 * test written against recorded output passes just as happily when the physics
 * is wrong, and the entire point of the mechanics sandbox is that a student
 * can trust what it shows them. Where no closed form exists — the double
 * pendulum — the test checks a conservation law instead. */

const G = 9.81;

function body(id: string, x: number, y: number, over: Partial<Body> = {}): Body {
  return {
    id,
    kind: 'mass',
    x,
    y,
    vx: 0,
    vy: 0,
    mass: 1,
    radius: 0.1,
    label: id,
    colour: '#8b7cf6',
    ...over,
  };
}

const anchor = (id: string, x: number, y: number): Body => body(id, x, y, { kind: 'anchor', mass: 0 });

function link(id: string, kind: Link['kind'], a: string, b: string, over: Partial<Link> = {}): Link {
  return { id, kind, a, b, length: null, stiffness: 0, damping: 0, label: id, colour: '#38bdf8', ...over };
}

function surface(id: string, x0: number, y0: number, x1: number, y1: number, over: Partial<Surface> = {}): Surface {
  return { id, x0, y0, x1, y1, muK: 0, muS: 0, restitution: 0, flip: false, label: id, colour: '#94a3b8', ...over };
}

function world(over: Partial<MechanicsWorld> = {}): MechanicsWorld {
  return {
    gravity: G,
    dragMode: 'none',
    dragCoefficient: 0,
    bodies: [],
    links: [],
    surfaces: [],
    pulleys: [],
    ...over,
  };
}

function run(w: MechanicsWorld, until: number, dt?: number) {
  const prep = prepare(w);
  const traj = createTrajectory(prep, dt);
  advance(traj, until, 10_000_000);
  return { prep, traj };
}

const measure = (kind: Measurement['kind'], target: string): Measurement => ({
  id: 'm',
  kind,
  target,
  colour: '#fff',
  visible: true,
});

/** Complete elliptic integral of the first kind, by the AGM. */
function ellipticK(k: number): number {
  let a = 1;
  let b = Math.sqrt(1 - k * k);
  for (let i = 0; i < 60 && Math.abs(a - b) > 1e-15; i++) {
    const nextA = (a + b) / 2;
    b = Math.sqrt(a * b);
    a = nextA;
  }
  return Math.PI / (2 * a);
}

/**
 * The interval between successive upward zero crossings.
 *
 * Deliberately not "time until the signal next comes back positive" — a
 * pendulum released from a positive angle reads *negative* on the
 * angle-from-vertical convention, so that shortcut measures a quarter period
 * and every period assertion in this file passes at four times the truth.
 */
function period(times: number[], values: number[]): number {
  const crossings: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] <= 0 && values[i] > 0) {
      const f = -values[i - 1] / (values[i] - values[i - 1]);
      crossings.push(times[i - 1] + f * (times[i] - times[i - 1]));
      if (crossings.length === 2) return crossings[1] - crossings[0];
    }
  }
  return NaN;
}

function series(traj: ReturnType<typeof run>['traj'], m: Measurement) {
  const times: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < traj.count; k++) {
    times.push(traj.time[k]);
    values.push(readMeasurement(traj, m, k));
  }
  return { times, values };
}

// ------------------------------------------------------------------ free fall

describe('free fall', () => {
  it('follows y = y₀ − ½gt² and v = −gt', () => {
    const w = world({ bodies: [body('b', 0, 10)] });
    const { traj } = run(w, 1.2);
    const k = sampleAt(traj, 1);
    const t = traj.time[k];
    expect(readMeasurement(traj, measure('y', 'b'), k)).toBeCloseTo(10 - 0.5 * G * t * t, 9);
    expect(readMeasurement(traj, measure('vy', 'b'), k)).toBeCloseTo(-G * t, 9);
  });

  it('gives a projectile the textbook range v²sin2θ/g', () => {
    const speed = 12;
    const angle = Math.PI / 5;
    const w = world({
      bodies: [body('b', 0, 0, { vx: speed * Math.cos(angle), vy: speed * Math.sin(angle), radius: 0 })],
    });
    const { traj } = run(w, 3, 1 / 4000);
    const { times, values } = series(traj, measure('y', 'b'));
    // Landing time: the second zero of the parabola.
    let landed = NaN;
    for (let i = 2; i < values.length; i++) {
      if (values[i - 1] > 0 && values[i] <= 0) {
        const f = values[i - 1] / (values[i - 1] - values[i]);
        landed = times[i - 1] + f * (times[i] - times[i - 1]);
        break;
      }
    }
    const range = speed * Math.cos(angle) * landed;
    expect(range).toBeCloseTo((speed * speed * Math.sin(2 * angle)) / G, 6);
  });
});

// ------------------------------------------------------------------ pendulum

describe('simple pendulum', () => {
  const L = 1.5;

  it('keeps the rod exactly rigid', () => {
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', L * Math.sin(0.9), -L * Math.cos(0.9))],
      links: [link('r', 'rod', 'p', 'm')],
    });
    const { traj } = run(w, 20);
    let worst = 0;
    for (let k = 0; k < traj.count; k++) {
      const x = traj.pos[k * 2];
      const y = traj.pos[k * 2 + 1];
      worst = Math.max(worst, Math.abs(Math.hypot(x, y) - L));
    }
    // The projection step is what earns this bound; Baumgarte alone drifts by
    // several parts in 10⁶ over this many swings.
    expect(worst).toBeLessThan(1e-12);
  });

  it('has period 2π√(L/g) at small amplitude, with the θ₀²/16 correction', () => {
    const theta = 0.02;
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', L * Math.sin(theta), -L * Math.cos(theta))],
      links: [link('r', 'rod', 'p', 'm')],
    });
    const { traj } = run(w, 8);
    const { times, values } = series(traj, measure('angle', 'r'));
    const measured = period(times, values);
    const small = 2 * Math.PI * Math.sqrt(L / G);

    // Written against the small-angle formula alone this assertion fails by
    // 6.1e-5 s — which is not solver error but the first term of the real
    // series, T = T₀(1 + θ₀²/16 + …), at 2.5 parts in 10⁵. Asserting the
    // exact period and then separately checking the deviation *is* that
    // correction turns an annoyance into the more informative test.
    const exact = 4 * Math.sqrt(L / G) * ellipticK(Math.sin(theta / 2));
    expect(measured).toBeCloseTo(exact, 6);
    expect((measured - small) / small).toBeCloseTo((theta * theta) / 16, 8);
  });

  it('matches the exact large-amplitude period 4√(L/g)·K(sin(θ₀/2))', () => {
    // 100° — far outside the small-angle regime, where the naive formula is
    // wrong by about 18%. This is the test that would catch an engine that
    // linearises the sine somewhere it should not.
    const theta = (100 * Math.PI) / 180;
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', L * Math.sin(theta), -L * Math.cos(theta))],
      links: [link('r', 'rod', 'p', 'm')],
    });
    const { traj } = run(w, 12);
    const { times, values } = series(traj, measure('angle', 'r'));
    const measured = period(times, values);
    const exact = 4 * Math.sqrt(L / G) * ellipticK(Math.sin(theta / 2));
    expect(measured).toBeCloseTo(exact, 3);
    expect(exact / (2 * Math.PI * Math.sqrt(L / G))).toBeGreaterThan(1.15);
  });

  it('conserves energy', () => {
    const theta = 1.2;
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', L * Math.sin(theta), -L * Math.cos(theta))],
      links: [link('r', 'rod', 'p', 'm')],
    });
    const { traj } = run(w, 30);
    const e0 = traj.kinetic[0] + traj.potential[0];
    let worst = 0;
    let scale = 0;
    for (let k = 0; k < traj.count; k++) {
      worst = Math.max(worst, Math.abs(traj.kinetic[k] + traj.potential[k] - e0));
      scale = Math.max(scale, traj.kinetic[k], Math.abs(traj.potential[k]));
    }
    // Fourth-order truncation at 240 Hz over ~12 swings. The number to watch
    // is that this is drift-free noise, not a trend: a solver leaking energy
    // through its constraints fails this by orders of magnitude, not by two.
    expect(worst / scale).toBeLessThan(1e-6);
  });

  it('reads the tension at the lowest point as mg(3 − 2cos θ₀)', () => {
    const theta = 0.8;
    const m = 2.5;
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', L * Math.sin(theta), -L * Math.cos(theta), { mass: m })],
      links: [link('r', 'rod', 'p', 'm')],
    });
    const { traj } = run(w, 3);
    const { values } = series(traj, measure('angle', 'r'));
    const forces = series(traj, measure('force', 'r')).values;
    // The bottom of the swing is where the angle first changes sign.
    let bottom = 0;
    for (let i = 1; i < values.length; i++) {
      if (Math.abs(values[i]) < Math.abs(values[bottom])) bottom = i;
      if (values[i] * values[0] < 0) break;
    }
    expect(forces[bottom]).toBeCloseTo(m * G * (3 - 2 * Math.cos(theta)), 2);
  });

  it('holds a hanging mass with tension mg', () => {
    const m = 3.2;
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', 0, -L, { mass: m })],
      links: [link('r', 'rod', 'p', 'm')],
    });
    const { traj } = run(w, 1);
    expect(readMeasurement(traj, measure('force', 'r'), traj.count - 1)).toBeCloseTo(m * G, 9);
  });
});

describe('double pendulum', () => {
  it('conserves energy even though the motion is chaotic', () => {
    const w = world({
      bodies: [anchor('p', 0, 0), body('a', 1, 0), body('b', 2, 0)],
      links: [link('r1', 'rod', 'p', 'a'), link('r2', 'rod', 'a', 'b')],
    });
    const { traj } = run(w, 20);
    const e0 = traj.kinetic[0] + traj.potential[0];
    let worst = 0;
    let scale = 0;
    for (let k = 0; k < traj.count; k++) {
      worst = Math.max(worst, Math.abs(traj.kinetic[k] + traj.potential[k] - e0));
      scale = Math.max(scale, traj.kinetic[k], Math.abs(traj.potential[k]));
    }
    expect(worst / scale).toBeLessThan(1e-6);
  });
});

// ------------------------------------------------------------------ springs

describe('mass on a spring', () => {
  it('oscillates at 2π√(m/k) about the stretched equilibrium', () => {
    const k = 40;
    const m = 1.4;
    const rest = 1;
    const stretch = (m * G) / k;
    const amplitude = 0.15;
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', 0, -(rest + stretch + amplitude), { mass: m })],
      links: [link('s', 'spring', 'p', 'm', { length: rest, stiffness: k })],
    });
    const { traj } = run(w, 6);
    const { times, values } = series(traj, measure('y', 'm'));
    const centred = values.map((y) => y + rest + stretch);
    const measured = period(times, centred);
    expect(measured).toBeCloseTo(2 * Math.PI * Math.sqrt(m / k), 4);
    // The mean position is the equilibrium, not the natural length.
    const mean = centred.reduce((a, b) => a + b, 0) / centred.length;
    expect(mean).toBeCloseTo(0, 2);
  });

  it('decays as e^(−γt) with the damped frequency √(ω₀²−γ²)', () => {
    const k = 60;
    const m = 1;
    const c = 3;
    const rest = 1;
    const amplitude = 0.2;
    const stretch = (m * G) / k;
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', 0, -(rest + stretch + amplitude), { mass: m })],
      links: [link('s', 'spring', 'p', 'm', { length: rest, stiffness: k, damping: c })],
    });
    const { traj } = run(w, 4);
    const { times, values } = series(traj, measure('y', 'm'));
    const centred = values.map((y) => y + rest + stretch);
    const gamma = c / (2 * m);
    const omega = Math.sqrt(k / m - gamma * gamma);
    const measured = period(times, centred);
    expect(measured).toBeCloseTo((2 * Math.PI) / omega, 4);
    // Compare against the full analytic solution, not just the envelope.
    for (let i = 0; i < times.length; i += 37) {
      const t = times[i];
      // Released from below the equilibrium, so the displacement starts at
      // −amplitude: x(t) = −A e^(−γt)[cos ω t + (γ/ω) sin ω t].
      const predicted =
        -amplitude * Math.exp(-gamma * t) * (Math.cos(omega * t) + (gamma / omega) * Math.sin(omega * t));
      expect(centred[i]).toBeCloseTo(predicted, 5);
    }
  });
});

// ------------------------------------------------------------------ pulley

/* The pulley is a frictionless peg: the constraint is that the two rope runs
 * sum to a constant length, with each run pointing from the peg to its mass.
 * That is the honest model, and it means an Atwood machine is only an Atwood
 * machine when both runs are vertical — masses hung to either side of the peg
 * swing, because a rope over a nail genuinely does that. The first test builds
 * a real Atwood machine and demands the closed form; the second checks the
 * angled case does what a peg does, so the model is pinned down by test rather
 * than by comment. */
describe('rope over a pulley', () => {
  const peg = (over: Partial<Pulley> = {}): Pulley => ({
    id: 'p',
    x: 0,
    y: 0,
    a: 'l',
    b: 'r',
    length: null,
    radius: 0.2,
    label: 'pulley',
    colour: '#94a3b8',
    ...over,
  });

  it('accelerates at g(m₁−m₂)/(m₁+m₂) with tension 2m₁m₂g/(m₁+m₂)', () => {
    const m1 = 3;
    const m2 = 2;
    const w = world({
      bodies: [body('l', 0, -2, { mass: m1 }), body('r', 0, -3, { mass: m2 })],
      pulleys: [peg()],
    });
    const { traj } = run(w, 0.5);
    const k = traj.count - 1;
    const t = traj.time[k];
    const a = (G * (m1 - m2)) / (m1 + m2);
    expect(readMeasurement(traj, measure('vy', 'l'), k)).toBeCloseTo(-a * t, 8);
    expect(readMeasurement(traj, measure('vy', 'r'), k)).toBeCloseTo(a * t, 8);
    expect(readMeasurement(traj, measure('force', 'p'), k)).toBeCloseTo(
      (2 * m1 * m2 * G) / (m1 + m2),
      8,
    );
  });

  it('balances when the masses are equal, holding 2mg at the peg', () => {
    const w = world({
      bodies: [body('l', 0, -2, { mass: 2 }), body('r', 0, -3, { mass: 2 })],
      pulleys: [peg()],
    });
    const { traj } = run(w, 2);
    const k = traj.count - 1;
    expect(readMeasurement(traj, measure('vy', 'l'), k)).toBeCloseTo(0, 9);
    expect(readMeasurement(traj, measure('force', 'p'), k)).toBeCloseTo(2 * G, 8);
  });

  it('holds the rope taut to machine precision while both masses hang', () => {
    const w = world({
      bodies: [body('l', -0.5, -2, { mass: 3 }), body('r', 0.5, -2, { mass: 2 })],
      pulleys: [peg()],
    });
    const { prep, traj } = run(w, 1);
    const total = prep.pulleys[0].length;
    let worst = 0;
    for (let k = 0; k < traj.count; k++) {
      const used =
        Math.hypot(traj.pos[k * 4], traj.pos[k * 4 + 1]) +
        Math.hypot(traj.pos[k * 4 + 2], traj.pos[k * 4 + 3]);
      worst = Math.max(worst, Math.abs(used - total));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('lets the rope go slack when both masses are thrown upward', () => {
    /* The constraint is unilateral, so this is the case that separates a rope
     * from a rod. Throw both masses at the peg and the two runs shorten faster
     * than the rope can take up: it stops doing anything at all, both masses
     * fly freely, and it catches again on the way down — at exactly its own
     * length, never beyond it.
     *
     * Worth stating why the obvious version of this test is wrong: hung either
     * side of the peg and simply released, the rope stays taut the whole way.
     * An earlier version of this test "observed" slack there, but it was
     * measuring a mass that had passed straight through the peg — which the
     * engine now stops and reports rather than simulating.
     */
    const w = world({
      bodies: [body('l', -0.8, -3, { mass: 2, vy: 5 }), body('r', 0.8, -3, { mass: 2, vy: 5 })],
      pulleys: [peg()],
    });
    const { prep, traj } = run(w, 1.1);
    const total = prep.pulleys[0].length;
    let over = -Infinity;
    let under = Infinity;
    for (let k = 0; k < traj.count; k++) {
      const used =
        Math.hypot(traj.pos[k * 4], traj.pos[k * 4 + 1]) +
        Math.hypot(traj.pos[k * 4 + 2], traj.pos[k * 4 + 3]);
      over = Math.max(over, used - total);
      under = Math.min(under, used - total);
    }
    expect(over).toBeLessThan(1e-12);
    expect(under).toBeLessThan(-0.05);
  });

  it('stops and says so when a mass is hauled up to the peg', () => {
    // The rope run has no length left there, so its direction is undefined and
    // the constraint degenerates. Reporting that beats sailing through the peg.
    const w = world({
      bodies: [body('l', 0, -4, { mass: 6 }), body('r', 0, -0.35, { mass: 1 })],
      pulleys: [peg({ radius: 0.25 })],
    });
    const { prep, traj } = run(w, 3);
    expect(traj.failed).toBe(true);
    expect(prep.problems.join(' ')).toMatch(/reached the pulley/i);
    // Everything computed before it stopped is still good.
    expect(traj.count).toBeGreaterThan(2);
    for (let k = 0; k < traj.count; k++) expect(Number.isFinite(traj.pos[k * 4])).toBe(true);
  });

  it('carries the whole weight when one side is tied to a fixed point', () => {
    const m = 4;
    const w = world({
      bodies: [{ ...body('l', 0, -2, { mass: m }) }, { ...anchor('r', 0, -3) }],
      pulleys: [peg()],
    });
    const { traj } = run(w, 1);
    expect(readMeasurement(traj, measure('force', 'p'), traj.count - 1)).toBeCloseTo(m * G, 8);
  });
});

// ------------------------------------------------------------------ friction

describe('block on an inclined plane', () => {
  const alpha = 0.5; // radians
  const along = 6;

  function incline(muK: number, muS: number) {
    // A ramp descending to the right, with the block a little way down it.
    const sx = -Math.cos(alpha) * along;
    const sy = Math.sin(alpha) * along;
    const s = surface('ramp', sx, sy, 0, 0, { muK, muS });
    const start = 0.35;
    const px = sx * (1 - start);
    const py = sy * (1 - start);
    // Sit the block exactly one radius clear along the outward normal.
    const ux = -sx / along;
    const uy = -sy / along;
    let nx = -uy;
    let ny = ux;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return world({
      bodies: [body('b', px + nx * 0.1, py + ny * 0.1, { mass: 2, radius: 0.1 })],
      surfaces: [s],
    });
  }

  it('slides at g·sinα when the surface is frictionless', () => {
    const { traj } = run(incline(0, 0), 0.8);
    const k = traj.count - 1;
    const t = traj.time[k];
    const speed = readMeasurement(traj, measure('speed', 'b'), k);
    expect(speed).toBeCloseTo(G * Math.sin(alpha) * t, 5);
  });

  it('slides at g(sinα − μcosα) with kinetic friction', () => {
    const mu = 0.25;
    const { traj } = run(incline(mu, mu), 0.8);
    const k = traj.count - 1;
    const t = traj.time[k];
    const speed = readMeasurement(traj, measure('speed', 'b'), k);
    expect(speed).toBeCloseTo((G * Math.sin(alpha) - mu * G * Math.cos(alpha)) * t, 4);
  });

  it('reports the normal force as mg·cosα', () => {
    const { traj } = run(incline(0.2, 0.2), 0.5);
    const k = traj.count - 1;
    expect(readMeasurement(traj, measure('normal', 'b'), k)).toBeCloseTo(2 * G * Math.cos(alpha), 4);
  });

  it('stays put when tanα < μs, and moves when it is not', () => {
    // tan(0.5) ≈ 0.546.
    const stuck = run(incline(0.7, 0.7), 2);
    expect(readMeasurement(stuck.traj, measure('speed', 'b'), stuck.traj.count - 1)).toBeCloseTo(0, 6);

    const sliding = run(incline(0.4, 0.4), 2);
    expect(readMeasurement(sliding.traj, measure('speed', 'b'), sliding.traj.count - 1)).toBeGreaterThan(1);
  });

  it('holds a block on a flat surface against a shove it cannot overcome', () => {
    const w = world({
      bodies: [body('b', 0, 0.1, { mass: 1, vx: 0 })],
      surfaces: [surface('floor', -5, 0, 5, 0, { muK: 0.5, muS: 0.5 })],
    });
    const { traj } = run(w, 1);
    const k = traj.count - 1;
    expect(readMeasurement(traj, measure('y', 'b'), k)).toBeCloseTo(0.1, 6);
    expect(readMeasurement(traj, measure('normal', 'b'), k)).toBeCloseTo(G, 6);
  });

  it('decelerates a sliding block at μg and stops it, rather than reversing', () => {
    const mu = 0.3;
    const v0 = 4;
    const w = world({
      bodies: [body('b', -3, 0.1, { mass: 1, vx: v0 })],
      surfaces: [surface('floor', -5, 0, 15, 0, { muK: mu, muS: mu })],
    });
    const { traj } = run(w, 3);
    const stopTime = v0 / (mu * G);
    const mid = sampleAt(traj, stopTime / 2);
    expect(readMeasurement(traj, measure('vx', 'b'), mid)).toBeCloseTo(v0 - mu * G * traj.time[mid], 4);
    const after = traj.count - 1;
    expect(readMeasurement(traj, measure('vx', 'b'), after)).toBeCloseTo(0, 4);
    // Total distance is v₀²/(2μg).
    expect(readMeasurement(traj, measure('x', 'b'), after)).toBeCloseTo(
      -3 + (v0 * v0) / (2 * mu * G),
      2,
    );
  });
});

// ------------------------------------------------------------------ bouncing

describe('restitution', () => {
  it('returns to e² of the drop height', () => {
    const e = 0.7;
    const h = 2;
    const w = world({
      bodies: [body('b', 0, h, { radius: 0 })],
      surfaces: [surface('floor', -5, 0, 5, 0, { restitution: e })],
    });
    const { traj } = run(w, 2.2, 1 / 4000);
    const { values } = series(traj, measure('y', 'b'));
    // The apex after the first bounce.
    let bounced = false;
    let apex = 0;
    for (let i = 1; i < values.length; i++) {
      if (!bounced && values[i] > values[i - 1]) bounced = true;
      if (bounced) {
        apex = Math.max(apex, values[i]);
        if (values[i] < values[i - 1] && apex > 0.1) break;
      }
    }
    expect(apex).toBeCloseTo(h * e * e, 2);
  });
});

// ------------------------------------------------------------------ ropes

describe('rope', () => {
  it('does nothing while slack and catches exactly at its length', () => {
    const L = 1;
    const w = world({
      bodies: [anchor('p', 0, 0), body('m', 0, -0.4)],
      links: [link('r', 'rope', 'p', 'm', { length: L })],
    });
    const { traj } = run(w, 1.5);
    // Free fall until the rope is taut, then it hangs at exactly L.
    const early = sampleAt(traj, 0.2);
    expect(readMeasurement(traj, measure('y', 'm'), early)).toBeCloseTo(
      -0.4 - 0.5 * G * traj.time[early] ** 2,
      8,
    );
    const late = traj.count - 1;
    expect(readMeasurement(traj, measure('y', 'm'), late)).toBeCloseTo(-L, 6);
    expect(readMeasurement(traj, measure('force', 'r'), late)).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ validation

describe('scene validation', () => {
  it('reports a link with a missing endpoint instead of crashing', () => {
    const w = world({ bodies: [body('a', 0, 0)], links: [link('r', 'rod', 'a', 'ghost')] });
    expect(prepare(w).problems.join(' ')).toMatch(/not attached/i);
  });

  it('reports a zero mass', () => {
    const w = world({ bodies: [body('a', 0, 0, { mass: 0 })] });
    expect(prepare(w).problems.join(' ')).toMatch(/positive mass/i);
  });

  it('reports a scene with nothing that can move', () => {
    expect(prepare(world({ bodies: [anchor('p', 0, 0)] })).problems.join(' ')).toMatch(/at least one mass/i);
  });
});
