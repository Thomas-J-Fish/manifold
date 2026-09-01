import { describe, expect, it } from 'vitest';
import { analyseCircuit, analyseMechanics } from '../src/core/physics/analytic';
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
} from '../src/core/physics/mechanics';
import {
  advanceCircuit,
  buildNetlist,
  circuitSampleAt,
  createCircuitTrajectory,
  defaultValues,
  readCircuit,
  type CircuitElement,
  type CircuitWorld,
  type ElementKind,
  type Reading,
} from '../src/core/physics/circuit';

/* The detectors have two jobs and this file checks both.
 *
 * The first is recognition: a pendulum should be called a pendulum, and — more
 * importantly — an arrangement that is *nearly* a pendulum should not be,
 * because a formula printed beside a set-up it does not describe is worse than
 * no formula at all.
 *
 * The second is that the closed forms are right. Those are checked against the
 * simulator, which is itself checked against textbook results in
 * mechanics.test.ts and circuit.test.ts. Two independent implementations of
 * the same physics agreeing to five figures is a much stronger statement than
 * either one matching a number I typed in.
 */

const G = 9.81;

function body(id: string, x: number, y: number, over: Partial<Body> = {}): Body {
  return { id, kind: 'mass', x, y, vx: 0, vy: 0, mass: 1, radius: 0.1, label: id, colour: '#8b7cf6', ...over };
}
const anchor = (id: string, x: number, y: number): Body => body(id, x, y, { kind: 'anchor', mass: 0 });
function link(id: string, kind: Link['kind'], a: string, b: string, over: Partial<Link> = {}): Link {
  return { id, kind, a, b, length: null, stiffness: 0, damping: 0, label: id, colour: '#38bdf8', ...over };
}
function mworld(over: Partial<MechanicsWorld> = {}): MechanicsWorld {
  return { gravity: G, dragMode: 'none', dragCoefficient: 0, bodies: [], links: [], surfaces: [], pulleys: [], ...over };
}
const measure = (kind: Measurement['kind'], target: string): Measurement => ({
  id: 'm', kind, target, colour: '#fff', visible: true,
});

let counter = 0;
function element(kind: ElementKind, x: number, y: number, over: Partial<CircuitElement> = {}): CircuitElement {
  counter += 1;
  return {
    id: `${kind}${counter}`,
    kind,
    x,
    y,
    orientation: 'h',
    reversed: false,
    label: `${kind}${counter}`,
    ...over,
    values: { ...defaultValues(kind), ...(over.values ?? {}) },
  };
}
function loop(parts: CircuitElement[]): CircuitElement[] {
  const placed = parts.map((p, i) => ({ ...p, x: i, y: 0, orientation: 'h' as const }));
  const n = parts.length;
  const wires: CircuitElement[] = [element('wire', n, 0, { orientation: 'v' })];
  for (let i = n; i > 0; i--) wires.push(element('wire', i - 1, 1, { orientation: 'h' }));
  wires.push(element('wire', 0, 0, { orientation: 'v' }));
  return [...placed, ...wires];
}
const cworld = (elements: CircuitElement[], over: Partial<CircuitWorld> = {}): CircuitWorld => ({
  elements,
  temperature: 25,
  timestep: 0,
  ...over,
});
const reading = (kind: Reading['kind'], target: string): Reading => ({
  id: 'r', kind, target, colour: '#fff', visible: true,
});

// ------------------------------------------------------------------ mechanics

describe('mechanics detection', () => {
  const pendulum = (theta: number, L = 1.2) =>
    mworld({
      bodies: [anchor('p', 0, 0), body('m', L * Math.sin(theta), -L * Math.cos(theta))],
      links: [link('rod', 'rod', 'p', 'm')],
    });

  it('names a simple pendulum and quotes both periods', () => {
    const w = pendulum(0.3);
    const result = analyseMechanics(w, prepare(w));
    expect(result.title).toBe('Simple pendulum');
    const small = result.quantities.find((q) => q.label.includes('Small-angle'))!;
    const exact = result.quantities.find((q) => q.label.startsWith('Exact'))!;
    expect(small.value).toBeCloseTo(2 * Math.PI * Math.sqrt(1.2 / G), 12);
    expect(exact.value).toBeGreaterThan(small.value);
    expect(result.overlay?.kind).toBe('angle');
  });

  it('agrees with the simulation at small amplitude and visibly departs at large', () => {
    const compare = (theta: number) => {
      const w = pendulum(theta);
      const prep = prepare(w);
      const traj = createTrajectory(prep);
      advance(traj, 4, 1e7);
      const overlay = analyseMechanics(w, prep).overlay!;
      let worst = 0;
      for (let k = 0; k < traj.count; k++) {
        const simulated = readMeasurement(traj, measure('angle', 'rod'), k);
        worst = Math.max(worst, Math.abs(simulated - overlay.fn(traj.time[k])));
      }
      // As a fraction of the release angle.
      return worst / ((theta * 180) / Math.PI);
    };

    expect(compare(0.02)).toBeLessThan(0.01);
    // At 70° the small-angle curve is a whole different function by four
    // seconds in — which is exactly the lesson the overlay exists to teach.
    expect(compare(1.22)).toBeGreaterThan(0.5);
  });

  it('predicts the Atwood acceleration the simulator produces', () => {
    const w = mworld({
      bodies: [body('l', 0, -2, { mass: 5 }), body('r', 0, -3, { mass: 3 })],
      pulleys: [{ id: 'p', x: 0, y: 0, a: 'l', b: 'r', length: null, radius: 0.2, label: 'peg', colour: '#94a3b8' }],
    });
    const prep = prepare(w);
    const traj = createTrajectory(prep);
    advance(traj, 0.6, 1e7);
    const result = analyseMechanics(w, prep);
    expect(result.title).toBe('Atwood machine');

    const overlay = result.overlay!;
    const k = sampleAt(traj, 0.5);
    expect(readMeasurement(traj, measure('vy', 'l'), k)).toBeCloseTo(overlay.fn(traj.time[k]), 8);
    expect(result.quantities.find((q) => q.label === 'Rope tension')!.value).toBeCloseTo(
      readMeasurement(traj, measure('force', 'p'), k),
      6,
    );
  });

  it('refuses the Atwood formulas when the rope runs are well off vertical', () => {
    const angled = mworld({
      bodies: [body('l', -0.8, -2, { mass: 5 }), body('r', 0.8, -2, { mass: 3 })],
      pulleys: [{ id: 'p', x: 0, y: 0, a: 'l', b: 'r', length: null, radius: 0.2, label: 'peg', colour: '#94a3b8' }],
    });
    const result = analyseMechanics(angled, prepare(angled));
    expect(result.title).toBe('Atwood machine');
    expect(result.overlay).toBeNull();
    expect(result.caveat).toMatch(/rope over a peg/i);
    expect(result.caveat).toMatch(/2[0-9]° from vertical/);
  });

  it('allows a slight tilt but says how far off it is', () => {
    // Masses exactly under a point peg are drawn on top of each other, so the
    // examples offset them a little. The panel has to own that rather than
    // quietly presenting the vertical formulas as exact.
    const nudged = mworld({
      bodies: [body('l', -0.32, -1.2, { mass: 3 }), body('r', 0.32, -3.2, { mass: 2 })],
      pulleys: [{ id: 'p', x: 0, y: 2.4, a: 'l', b: 'r', length: null, radius: 0.24, label: 'peg', colour: '#94a3b8' }],
    });
    const result = analyseMechanics(nudged, prepare(nudged));
    expect(result.overlay).not.toBeNull();
    expect(result.caveat).toMatch(/from vertical/);
    expect(result.caveat).toMatch(/% away from the vertical formulas/);

    // And the prediction is genuinely close to what the simulation does.
    const prep = prepare(nudged);
    const traj = createTrajectory(prep);
    advance(traj, 1.2, 1e7);
    const k = sampleAt(traj, 1);
    const simulated = readMeasurement(traj, measure('vy', 'l'), k);
    expect(Math.abs(simulated - result.overlay!.fn(traj.time[k]))).toBeLessThan(0.05);
  });

  it('tells a held block from a sliding one', () => {
    const ramp = (muS: number) =>
      mworld({
        bodies: [body('b', -2, 1.1, { mass: 2 })],
        surfaces: [
          { id: 's', x0: -4, y0: 2, x1: 0, y1: 0, muK: muS, muS, restitution: 0, flip: false, label: 'ramp', colour: '#94a3b8' },
        ],
      });
    const held = analyseMechanics(ramp(0.9), prepare(ramp(0.9)));
    expect(held.title).toMatch(/held by friction/i);
    expect(held.overlay).toBeNull();

    const sliding = analyseMechanics(ramp(0.1), prepare(ramp(0.1)));
    expect(sliding.title).toMatch(/sliding/i);
    expect(sliding.overlay?.kind).toBe('speed');
  });

  it('refuses to name an arrangement it does not recognise', () => {
    const w = mworld({
      bodies: [anchor('p', 0, 0), body('a', 1, 0), body('b', 2, 0), body('c', 3, 0)],
      links: [link('r1', 'rod', 'p', 'a'), link('r2', 'rod', 'a', 'b'), link('r3', 'rod', 'b', 'c')],
    });
    const result = analyseMechanics(w, prepare(w));
    expect(result.title).toMatch(/no standard form/i);
    expect(result.overlay).toBeNull();
  });

  it('describes a double pendulum without pretending it has a solution', () => {
    const w = mworld({
      bodies: [anchor('p', 0, 0), body('a', 1, 0), body('b', 2, 0)],
      links: [link('r1', 'rod', 'p', 'a'), link('r2', 'rod', 'a', 'b')],
    });
    const result = analyseMechanics(w, prepare(w));
    expect(result.title).toBe('Double pendulum');
    expect(result.overlay).toBeNull();
    expect(result.caveat).toMatch(/chaotic/i);
    expect(result.quantities).toHaveLength(2);
  });

  it('gets the spring frequency and static extension right', () => {
    const k = 50;
    const m = 2;
    const w = mworld({
      bodies: [anchor('p', 0, 0), body('m', 0, -1.6, { mass: m })],
      links: [link('s', 'spring', 'p', 'm', { length: 1, stiffness: k })],
    });
    const result = analyseMechanics(w, prepare(w));
    expect(result.title).toMatch(/undamped/i);
    expect(result.quantities.find((q) => q.label === 'Natural frequency')!.value).toBeCloseTo(
      Math.sqrt(k / m) / (2 * Math.PI),
      12,
    );
    expect(result.quantities.find((q) => q.label.includes('mg/k'))!.value).toBeCloseTo((m * G) / k, 12);
  });

  it('matches the simulated damped spring point for point', () => {
    const w = mworld({
      bodies: [anchor('p', 0, 0), body('m', 0, -1.7, { mass: 1.5 })],
      links: [link('s', 'spring', 'p', 'm', { length: 1, stiffness: 80, damping: 4 })],
    });
    const prep = prepare(w);
    const traj = createTrajectory(prep);
    advance(traj, 3, 1e7);
    const overlay = analyseMechanics(w, prep).overlay!;
    expect(overlay.kind).toBe('y');
    for (let k = 0; k < traj.count; k += 29) {
      expect(readMeasurement(traj, measure('y', 'm'), k)).toBeCloseTo(overlay.fn(traj.time[k]), 5);
    }
  });
});

// ------------------------------------------------------------------ circuits

describe('circuit detection', () => {
  it('names an RC circuit and its overlay tracks the simulation', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 9, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: 2200 } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: 4.7e-6, initial: 0 } });
    const w = cworld(loop([cell, res, cap]), { timestep: 1e-6 });
    const netlist = buildNetlist(w);
    const result = analyseCircuit(w, netlist);

    expect(result.title).toBe('RC charging');
    expect(result.quantities.find((q) => q.label.startsWith('Time constant'))!.value).toBeCloseTo(
      2200 * 4.7e-6,
      12,
    );

    const traj = createCircuitTrajectory(w, 0.1);
    advanceCircuit(traj, 0.1, 1e9);
    const overlay = result.overlay!;
    for (const t of [0.002, 0.01, 0.03, 0.08]) {
      const k = circuitSampleAt(traj, t);
      expect(Math.abs(readCircuit(traj, reading('voltage', cap.id), k))).toBeCloseTo(overlay.fn(traj.time[k]), 5);
    }
  });

  it('folds the internal resistance of the cell into τ', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 9, internal: 300 } });
    const res = element('resistor', 0, 0, { values: { resistance: 700 } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: 1e-5, initial: 0 } });
    const w = cworld(loop([cell, res, cap]));
    const result = analyseCircuit(w, buildNetlist(w));
    // 700 Ω of resistor plus 300 Ω inside the cell: τ is 10 ms, not 7.
    expect(result.quantities.find((q) => q.label.startsWith('Time constant'))!.value).toBeCloseTo(0.01, 12);
  });

  it('names a series RLC and gets its damping regime right', () => {
    const build = (r: number) => {
      const cell = element('cell', 0, 0, { reversed: true, values: { emf: 4, internal: 0 } });
      const res = element('resistor', 0, 0, { values: { resistance: r } });
      const ind = element('inductor', 0, 0, { values: { inductance: 0.02, initial: 0 } });
      const cap = element('capacitor', 0, 0, { values: { capacitance: 2e-6, initial: 0 } });
      const w = cworld(loop([cell, res, ind, cap]), { timestep: 2e-8 });
      return { w, result: analyseCircuit(w, buildNetlist(w)), cap };
    };
    const critical = 2 * Math.sqrt(0.02 / 2e-6);

    const under = build(critical / 4);
    expect(under.result.title).toMatch(/underdamped/i);
    const over = build(critical * 4);
    expect(over.result.title).toMatch(/overdamped/i);
    expect(over.result.overlay).toBeNull();

    const traj = createCircuitTrajectory(under.w, 0.01);
    advanceCircuit(traj, 0.01, 1e9);
    const overlay = under.result.overlay!;
    for (const t of [0.0003, 0.001, 0.003]) {
      const k = circuitSampleAt(traj, t);
      expect(Math.abs(readCircuit(traj, reading('voltage', under.cap.id), k))).toBeCloseTo(
        overlay.fn(traj.time[k]),
        4,
      );
    }
  });

  it('still recognises a divider when a voltmeter is measuring it', () => {
    /* A voltmeter is a branch in the graph but not in the circuit: its whole
     * design is to draw no current. Letting it veto the divider formula meant
     * the formula disappeared exactly when someone attached the instrument
     * they were being taught to attach. */
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 5, internal: 0 } });
    const r1 = element('resistor', 0, 0, { values: { resistance: 10000 } });
    const r2 = element('resistor', 0, 0, { values: { resistance: 10000 } });
    const parts = loop([cell, r1, r2]);
    const meter = element('voltmeter', 2, -1, { orientation: 'h', values: { resistance: 1e7 } });
    const w = cworld([
      ...parts,
      meter,
      element('wire', 2, -1, { orientation: 'v' }),
      element('wire', 3, -1, { orientation: 'v' }),
    ]);
    const result = analyseCircuit(w, buildNetlist(w));
    expect(result.title).toBe('Potential divider');
    expect(result.quantities.find((q) => q.label === 'Total resistance')!.value).toBeCloseTo(20000, 3);
  });

  it('recognises a potential divider and computes the terminal voltage', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 12, internal: 2 } });
    const r1 = element('resistor', 0, 0, { values: { resistance: 40 } });
    const r2 = element('resistor', 0, 0, { values: { resistance: 60 } });
    const w = cworld(loop([cell, r1, r2]));
    const result = analyseCircuit(w, buildNetlist(w));
    expect(result.title).toBe('Potential divider');
    const current = 12 / 102;
    expect(result.quantities.find((q) => q.label === 'Current')!.value).toBeCloseTo(current, 12);
    expect(result.quantities.find((q) => q.label === 'Terminal voltage')!.value).toBeCloseTo(
      12 - current * 2,
      12,
    );
  });

  it('declines to name a branching network', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 9, internal: 0 } });
    const ra = element('resistor', 1, 0, {});
    const rb = element('resistor', 1, 2, {});
    const elements = [
      { ...cell, x: 0, y: 0, orientation: 'h' as const },
      { ...ra, x: 1, y: 0, orientation: 'h' as const },
      { ...rb, x: 1, y: 2, orientation: 'h' as const },
      element('wire', 1, 0, { orientation: 'v' }),
      element('wire', 1, 1, { orientation: 'v' }),
      element('wire', 2, 0, { orientation: 'v' }),
      element('wire', 2, 1, { orientation: 'v' }),
      element('wire', 2, 2, { orientation: 'v' }),
      element('wire', 1, 3, { orientation: 'h' }),
      element('wire', 0, 3, { orientation: 'h' }),
      element('wire', 0, 2, { orientation: 'v' }),
      element('wire', 0, 1, { orientation: 'v' }),
      element('wire', 0, 0, { orientation: 'v' }),
    ];
    const w = cworld(elements);
    const result = analyseCircuit(w, buildNetlist(w));
    expect(result.title).toBe('Resistor network');
    expect(result.overlay).toBeNull();
  });

  it('sizes the series resistor for an LED', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 9, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: 470 } });
    const led = element('led', 0, 0, { values: { forward: 2.1, ideality: 2, rating: 0.02 } });
    const w = cworld(loop([cell, res, led]));
    const result = analyseCircuit(w, buildNetlist(w));
    expect(result.title).toMatch(/LED/);
    expect(result.quantities.find((q) => q.label.includes('rated current'))!.value).toBeCloseTo(
      (9 - 2.1) / 0.02,
      9,
    );
  });
});

describe('every formula the panels can print is well formed', () => {
  /* KaTeX does not throw on a broken formula — it renders the source in red
   * and carries on, so a mangled backslash reaches the user as a scarlet
   * `rac{h}{n}` in the middle of an otherwise polished panel and nothing in
   * the build notices. These checks walk every template and look at what the
   * strings actually contain.
   *
   * This is not hypothetical: an editing pass turned `\frac` into a form feed
   * and `\text` into a tab in three of the strings below, and every other test
   * in this file passed. */
  const worlds: MechanicsWorld[] = [
    mworld({
      bodies: [anchor('p', 0, 0), body('m', 0.6, -1)],
      links: [link('r', 'rod', 'p', 'm')],
    }),
    mworld({
      bodies: [anchor('p', 0, 0), body('a', 1, 0), body('b', 2, 0)],
      links: [link('r1', 'rod', 'p', 'a'), link('r2', 'rod', 'a', 'b')],
    }),
    mworld({
      bodies: [anchor('p', 0, 0), body('m', 0, -1.5)],
      links: [link('s', 'spring', 'p', 'm', { length: 1, stiffness: 40, damping: 2 })],
    }),
    mworld({
      bodies: [body('l', 0, -2, { mass: 3 }), body('r', 0, -3, { mass: 2 })],
      pulleys: [{ id: 'p', x: 0, y: 0, a: 'l', b: 'r', length: null, radius: 0.2, label: 'peg', colour: '#94a3b8' }],
    }),
    // Sloped, level with bounce, level without, projectile, drag, unrecognised.
    mworld({
      bodies: [body('b', -2, 1.2, { mass: 2 })],
      surfaces: [{ id: 's', x0: -4, y0: 2, x1: 0, y1: 0, muK: 0.2, muS: 0.3, restitution: 0, flip: false, label: 'r', colour: '#94a3b8' }],
    }),
    mworld({
      bodies: [body('b', 0, 3, { vx: 1 })],
      surfaces: [{ id: 's', x0: -4, y0: 0, x1: 4, y1: 0, muK: 0.1, muS: 0.1, restitution: 0.6, flip: false, label: 'f', colour: '#94a3b8' }],
    }),
    mworld({
      bodies: [body('b', 0, 0.1, { vx: 3 })],
      surfaces: [{ id: 's', x0: -4, y0: 0, x1: 9, y1: 0, muK: 0.3, muS: 0.3, restitution: 0, flip: false, label: 'f', colour: '#94a3b8' }],
    }),
    mworld({ bodies: [body('b', 0, 0, { vx: 6, vy: 6 })] }),
    mworld({ bodies: [body('b', 0, 20)], dragMode: 'linear', dragCoefficient: 0.4 }),
    mworld({
      bodies: [anchor('p', 0, 0), body('a', 1, 0), body('b', 2, 0), body('c', 3, 0)],
      links: [link('r1', 'rod', 'p', 'a'), link('r2', 'rod', 'a', 'b'), link('r3', 'rod', 'b', 'c')],
    }),
  ];

  const circuits: CircuitWorld[] = (() => {
    const cell = () => element('cell', 0, 0, { reversed: true, values: { emf: 6, internal: 0.5 } });
    return [
      cworld(loop([cell(), element('resistor', 0, 0, {}), element('capacitor', 0, 0, {})])),
      cworld(loop([cell(), element('resistor', 0, 0, {}), element('inductor', 0, 0, {})])),
      cworld(loop([cell(), element('resistor', 0, 0, {}), element('inductor', 0, 0, {}), element('capacitor', 0, 0, {})])),
      cworld(loop([cell(), element('resistor', 0, 0, {}), element('resistor', 0, 0, {})])),
      cworld(loop([cell(), element('resistor', 0, 0, {}), element('led', 0, 0, {})])),
      cworld(loop([element('resistor', 0, 0, {}), element('capacitor', 0, 0, { values: { initial: 5 } })])),
      cworld([]),
    ];
  })();

  const results = [
    ...worlds.map((w) => analyseMechanics(w, prepare(w))),
    ...circuits.map((w) => analyseCircuit(w, buildNetlist(w))),
  ];

  it('covers every template', () => {
    const titles = new Set(results.map((r) => r.title));
    expect(titles.size).toBeGreaterThanOrEqual(10);
  });

  it('contains no stray control characters', () => {
    for (const r of results) {
      for (const eq of r.equations) {
        expect(eq, `${r.title}: ${JSON.stringify(eq)}`).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
      }
      expect(r.title).not.toMatch(/[\x00-\x1f]/);
      if (r.caveat) expect(r.caveat).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
    }
  });

  it('keeps every backslash command intact', () => {
    for (const r of results) {
      for (const eq of r.equations) {
        // A lone brace group with no command in front of it is what a mangled
        // \frac or \sqrt leaves behind.
        expect(eq, `${r.title}: ${eq}`).not.toMatch(/(^|[^\\A-Za-z])rac\{/);
        expect(eq, `${r.title}: ${eq}`).not.toMatch(/(^|[^\\A-Za-z])ext\{/);
        expect(eq, `${r.title}: ${eq}`).not.toMatch(/(^|[^\\A-Za-z])qrt/);
        // Balanced braces.
        let depth = 0;
        for (const ch of eq) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
          expect(depth, `${r.title}: ${eq}`).toBeGreaterThanOrEqual(0);
        }
        expect(depth, `${r.title}: ${eq}`).toBe(0);
      }
    }
  });

  it('gives every derived quantity a finite value and a label', () => {
    for (const r of results) {
      for (const q of r.quantities) {
        expect(q.label.length, r.title).toBeGreaterThan(0);
        // Labels are rendered in a fixed-width column that truncates.
        expect(q.label.length, `${r.title}: "${q.label}" is too long for the panel`).toBeLessThanOrEqual(32);
        expect(Number.isFinite(q.value), `${r.title}: ${q.label} = ${q.value}`).toBe(true);
      }
    }
  });
});
