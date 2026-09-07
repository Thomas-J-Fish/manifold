import { describe, expect, it } from 'vitest';
import {
  advanceCircuit,
  buildNetlist,
  createCircuitTrajectory,
  circuitSampleAt,
  defaultValues,
  operatingPoint,
  readCircuit,
  readingValue,
  thermistorResistance,
  type CircuitElement,
  type CircuitWorld,
  type ElementKind,
  type Reading,
} from '../src/core/physics/circuit';

/* As with the mechanics tests, every expectation is a closed form or a
 * hand-solved network, never a number the simulator once produced. */

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
    // After the spread, so an `over` that supplies only some values still gets
    // the defaults for the rest. Written twice once, which meant the first
    // copy was dead and an edit to it would have changed nothing.
    values: { ...defaultValues(kind), ...(over.values ?? {}) },
  };
}

/**
 * Lays a list of parts along the top row and wires the return path underneath,
 * so `loop([cell, resistor])` is a complete circuit.
 *
 * The cell is placed reversed, which puts its positive terminal on the right —
 * the end the rest of the row hangs off. Conventional current then runs left to
 * right through the row, so a resistor's current comes out positive, which is
 * the sign a student would write down.
 */
function loop(parts: CircuitElement[]): CircuitElement[] {
  const placed = parts.map((p, i) => ({ ...p, x: i, y: 0, orientation: 'h' as const }));
  const n = parts.length;
  const wires: CircuitElement[] = [element('wire', n - 1 + 1, 0, { orientation: 'v' })];
  for (let i = n; i > 0; i--) wires.push(element('wire', i - 1, 1, { orientation: 'h' }));
  wires.push(element('wire', 0, 0, { orientation: 'v' }));
  return [...placed, ...wires];
}

function world(elements: CircuitElement[], over: Partial<CircuitWorld> = {}): CircuitWorld {
  return { elements, temperature: 25, timestep: 0, ...over };
}

const reading = (kind: Reading['kind'], target: string): Reading => ({
  id: 'r',
  kind,
  target,
  colour: '#fff',
  visible: true,
});

function dc(w: CircuitWorld) {
  const netlist = buildNetlist(w);
  const state = operatingPoint(w, netlist);
  const value = (id: string, what: 'v' | 'i') => {
    const i = netlist.active.findIndex((e) => e.id === id);
    if (i < 0) return NaN;
    return what === 'v' ? state.elementVoltage[i] : state.elementCurrent[i];
  };
  return { netlist, state, value };
}

function transient(w: CircuitWorld, duration: number, timestep: number) {
  const traj = createCircuitTrajectory({ ...w, timestep }, duration);
  advanceCircuit(traj, duration, 1e9);
  return traj;
}

// ------------------------------------------------------------------ resistor networks

describe('resistor networks', () => {
  it('adds resistances in series and divides the voltage between them', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 12, internal: 0 } });
    const r1 = element('resistor', 0, 0, { values: { resistance: 300 } });
    const r2 = element('resistor', 0, 0, { values: { resistance: 600 } });
    const { value } = dc(world(loop([cell, r1, r2])));

    const expected = 12 / 900;
    expect(value(r1.id, 'i')).toBeCloseTo(expected, 9);
    expect(value(r2.id, 'i')).toBeCloseTo(expected, 9);
    expect(value(r1.id, 'v')).toBeCloseTo(12 * (300 / 900), 7);
    expect(value(r2.id, 'v')).toBeCloseTo(12 * (600 / 900), 7);
    // Kirchhoff's voltage law around the loop.
    expect(value(r1.id, 'v') + value(r2.id, 'v')).toBeCloseTo(12, 7);
  });

  it('combines two resistors in parallel as the product over the sum', () => {
    // Two branches between the same pair of nodes.
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 9, internal: 0 } });
    const ra = element('resistor', 1, 0, { values: { resistance: 200 } });
    const rb = element('resistor', 1, 2, { values: { resistance: 300 } });
    const elements = [
      { ...cell, x: 0, y: 0, orientation: 'h' as const },
      { ...ra, x: 1, y: 0, orientation: 'h' as const },
      { ...rb, x: 1, y: 2, orientation: 'h' as const },
      // Left rail from the cell's right-hand terminal down to the second branch.
      element('wire', 1, 0, { orientation: 'v' }),
      element('wire', 1, 1, { orientation: 'v' }),
      // Right rail joining both branch outputs.
      element('wire', 2, 0, { orientation: 'v' }),
      element('wire', 2, 1, { orientation: 'v' }),
      // Return path back to the cell.
      element('wire', 2, 2, { orientation: 'v' }),
      element('wire', 1, 3, { orientation: 'h' }),
      element('wire', 0, 3, { orientation: 'h' }),
      element('wire', 0, 2, { orientation: 'v' }),
      element('wire', 0, 1, { orientation: 'v' }),
      element('wire', 0, 0, { orientation: 'v' }),
    ];
    const { value } = dc(world(elements));

    const parallel = (200 * 300) / 500;
    expect(value(ra.id, 'v')).toBeCloseTo(9, 9);
    expect(value(rb.id, 'v')).toBeCloseTo(9, 9);
    expect(value(ra.id, 'i')).toBeCloseTo(9 / 200, 9);
    expect(value(rb.id, 'i')).toBeCloseTo(9 / 300, 9);
    expect(value(ra.id, 'i') + value(rb.id, 'i')).toBeCloseTo(9 / parallel, 9);
  });

  it('drops the terminal voltage of a cell by Ir', () => {
    const emf = 6;
    const r = 4;
    const internal = 2;
    const cell = element('cell', 0, 0, { reversed: true, values: { emf, internal } });
    const load = element('resistor', 0, 0, { values: { resistance: r } });
    const { value } = dc(world(loop([cell, load])));

    const current = emf / (r + internal);
    expect(value(load.id, 'i')).toBeCloseTo(current, 9);
    // The cell's terminal voltage is what appears across the load.
    expect(value(load.id, 'v')).toBeCloseTo(emf - current * internal, 9);
    expect(Math.abs(value(cell.id, 'v'))).toBeCloseTo(emf - current * internal, 9);
  });

  it('delivers maximum power to the load when R equals the internal resistance', () => {
    const emf = 12;
    const internal = 3;
    const powerFor = (r: number) => {
      const cell = element('cell', 0, 0, { reversed: true, values: { emf, internal } });
      const load = element('resistor', 0, 0, { values: { resistance: r } });
      const { value } = dc(world(loop([cell, load])));
      return value(load.id, 'v') * value(load.id, 'i');
    };
    const matched = powerFor(internal);
    expect(matched).toBeCloseTo((emf * emf) / (4 * internal), 8);
    expect(powerFor(internal / 3)).toBeLessThan(matched);
    expect(powerFor(internal * 3)).toBeLessThan(matched);
  });

  it('conserves power: what the cell delivers, the resistors dissipate', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 10, internal: 1 } });
    const r1 = element('resistor', 0, 0, { values: { resistance: 47 } });
    const r2 = element('resistor', 0, 0, { values: { resistance: 33 } });
    const { netlist, state } = dc(world(loop([cell, r1, r2])));
    let total = 0;
    netlist.active.forEach((_, i) => {
      total += state.elementVoltage[i] * state.elementCurrent[i];
    });
    // Passive sign convention, so the sum over every element is exactly zero.
    expect(total).toBeCloseTo(0, 9);
  });

  it('solves a Wheatstone bridge that is not series-parallel', () => {
    /* A ladder on the grid:
     *
     *      (0,0)══(1,0)══(2,0)══(3,0)      ← node A, the top rail
     *        │                     │
     *       R1                    cell     A–B: 100 Ω
     *        │                     │       A–C: 200 Ω
     *      (0,1)──R5──(1,1)══(2,1) │       B–D: 300 Ω
     *        ║                  ║  │       C–D: 400 Ω
     *      (0,2)              (2,2)│       B–C: 500 Ω (the bridge arm)
     *        │                  │  │
     *       R3                 R4  │
     *        │                  │  │
     *      (0,3)══(1,3)══(2,3)══(3,3)      ← node D, the bottom rail
     *
     * Every part sits on a single grid edge, which is the only shape the
     * editor can produce, so the test exercises the same netlist path the app
     * does rather than a hand-built graph. */
    const supply = 10;
    const parts: CircuitElement[] = [
      element('resistor', 0, 0, { orientation: 'v', values: { resistance: 100 }, label: 'R1' }),
      element('resistor', 2, 0, { orientation: 'v', values: { resistance: 200 }, label: 'R2' }),
      element('resistor', 0, 2, { orientation: 'v', values: { resistance: 300 }, label: 'R3' }),
      element('resistor', 2, 2, { orientation: 'v', values: { resistance: 400 }, label: 'R4' }),
      element('resistor', 0, 1, { orientation: 'h', values: { resistance: 500 }, label: 'R5' }),
      element('cell', 3, 1, { orientation: 'v', values: { emf: supply, internal: 0 }, label: 'source' }),
      element('ground', 3, 3, {}),
    ];
    const wires = [
      // Top rail.
      element('wire', 0, 0, { orientation: 'h' }),
      element('wire', 1, 0, { orientation: 'h' }),
      element('wire', 2, 0, { orientation: 'h' }),
      // Bottom rail.
      element('wire', 0, 3, { orientation: 'h' }),
      element('wire', 1, 3, { orientation: 'h' }),
      element('wire', 2, 3, { orientation: 'h' }),
      // Node B joins the foot of R1, the head of R3 and the left of R5.
      element('wire', 0, 1, { orientation: 'v' }),
      // Node C joins the right of R5, the foot of R2 and the head of R4.
      element('wire', 1, 1, { orientation: 'h' }),
      element('wire', 2, 1, { orientation: 'v' }),
      // Right rail, carrying the source between the two rails.
      element('wire', 3, 0, { orientation: 'v' }),
      element('wire', 3, 2, { orientation: 'v' }),
    ];

    const w = world([...parts, ...wires]);
    const { netlist, state } = dc(w);
    const at = (label: string, what: 'v' | 'i') => {
      const i = netlist.active.findIndex((e) => e.label === label);
      return what === 'v' ? state.elementVoltage[i] : state.elementCurrent[i];
    };

    /* Nodal analysis with node 1 held at 10 V and node 0 at 0 V:
     *   (v2−10)/100 + v2/300 + (v2−v3)/500 = 0
     *   (v3−10)/200 + v3/400 + (v3−v2)/500 = 0
     * → v2 = 6.7515923566878985, v3 = 6.220806794055202 (exact rationals below). */
    const a11 = 1 / 100 + 1 / 300 + 1 / 500;
    const a12 = -1 / 500;
    const a22 = 1 / 200 + 1 / 400 + 1 / 500;
    const b1 = 10 / 100;
    const b2 = 10 / 200;
    const det = a11 * a22 - a12 * a12;
    const v2 = (b1 * a22 - a12 * b2) / det;
    const v3 = (a11 * b2 - a12 * b1) / det;

    expect(Math.abs(at('R3', 'v'))).toBeCloseTo(v2, 7);
    expect(Math.abs(at('R4', 'v'))).toBeCloseTo(v3, 7);
    expect(Math.abs(at('R5', 'i'))).toBeCloseTo(Math.abs(v2 - v3) / 500, 9);
    // Not balanced: 100/300 ≠ 200/400, so current really does cross the bridge.
    expect(Math.abs(at('R5', 'i'))).toBeGreaterThan(1e-4);
  });

  it('carries no current across a balanced bridge', () => {
    // R1/R3 = R2/R4 ⇒ B and C sit at the same potential.
    const parts: CircuitElement[] = [
      element('resistor', 0, 0, { orientation: 'v', values: { resistance: 100 }, label: 'R1' }),
      element('resistor', 2, 0, { orientation: 'v', values: { resistance: 200 }, label: 'R2' }),
      element('resistor', 0, 2, { orientation: 'v', values: { resistance: 300 }, label: 'R3' }),
      element('resistor', 2, 2, { orientation: 'v', values: { resistance: 600 }, label: 'R4' }),
      element('resistor', 0, 1, { orientation: 'h', values: { resistance: 500 }, label: 'R5' }),
      element('cell', 3, 1, { orientation: 'v', values: { emf: 10, internal: 0 }, label: 'source' }),
      element('ground', 3, 3, {}),
    ];
    const wires = [
      element('wire', 0, 0, { orientation: 'h' }),
      element('wire', 1, 0, { orientation: 'h' }),
      element('wire', 2, 0, { orientation: 'h' }),
      element('wire', 0, 3, { orientation: 'h' }),
      element('wire', 1, 3, { orientation: 'h' }),
      element('wire', 2, 3, { orientation: 'h' }),
      element('wire', 0, 1, { orientation: 'v' }),
      element('wire', 1, 1, { orientation: 'h' }),
      element('wire', 2, 1, { orientation: 'v' }),
      element('wire', 3, 0, { orientation: 'v' }),
      element('wire', 3, 2, { orientation: 'v' }),
    ];
    const { netlist, state } = dc(world([...parts, ...wires]));
    const i = netlist.active.findIndex((e) => e.label === 'R5');
    expect(Math.abs(state.elementCurrent[i])).toBeLessThan(1e-11);
  });

  it('pins down the sign convention: current enters terminal a', () => {
    const cell = element('cell', 0, 0, { values: { emf: 5, internal: 0 } });
    const load = element('resistor', 0, 0, { values: { resistance: 10 } });
    const { value } = dc(world(loop([cell, load])));
    // Cell placed unreversed: terminal a is +, current leaves it, so the
    // current *into* a is negative and the power is negative — it is a source.
    expect(value(cell.id, 'v')).toBeCloseTo(5, 9);
    expect(value(cell.id, 'i')).toBeCloseTo(-0.5, 9);
    expect(value(cell.id, 'v') * value(cell.id, 'i')).toBeCloseTo(-2.5, 9);
    expect(value(load.id, 'v') * value(load.id, 'i')).toBeCloseTo(2.5, 9);
  });
});

// ------------------------------------------------------------------ switches, fuses, meters

describe('switches, meters and fuses', () => {
  it('passes nothing when the switch is open', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 9, internal: 0 } });
    const sw = element('switch', 0, 0, { values: { closed: 0 } });
    const load = element('resistor', 0, 0, { values: { resistance: 100 } });
    const open = dc(world(loop([cell, sw, load])));
    expect(Math.abs(open.value(load.id, 'i'))).toBeLessThan(1e-7);

    const sw2 = { ...sw, values: { closed: 1 } };
    const closed = dc(world(loop([cell, sw2, load])));
    expect(closed.value(load.id, 'i')).toBeCloseTo(0.09, 8);
  });

  it('reads the loop current on an ammeter and the load voltage on a voltmeter', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 12, internal: 0 } });
    const meter = element('ammeter', 0, 0, {});
    const load = element('resistor', 0, 0, { values: { resistance: 240 } });
    const { value } = dc(world(loop([cell, meter, load])));
    expect(value(meter.id, 'i')).toBeCloseTo(0.05, 9);
    // An ideal ammeter drops nothing.
    expect(value(meter.id, 'v')).toBeCloseTo(0, 12);
  });

  it('barely disturbs the circuit when a voltmeter is placed across a divider', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 10, internal: 0 } });
    const r1 = element('resistor', 0, 0, { values: { resistance: 1000 } });
    const r2 = element('resistor', 0, 0, { values: { resistance: 1000 } });
    const parts = loop([cell, r1, r2]);
    /* Across r2, which spans (2,0)–(3,0). The meter goes *above* the row: the
     * loop helper already runs its return path along y = 1, so a meter placed
     * there would be laid straight across a piece of wire and would read zero
     * no matter how good the model was. */
    const meter = element('voltmeter', 2, -1, { orientation: 'h', values: { resistance: 1e7 } });
    const extra = [
      meter,
      element('wire', 2, -1, { orientation: 'v' }),
      element('wire', 3, -1, { orientation: 'v' }),
    ];
    const { value } = dc(world([...parts, ...extra]));
    // Loading error is R₂/(R₂+Rᵥ) ≈ 10⁻⁴, so 5 V reads 4.99975 V.
    expect(value(meter.id, 'v')).toBeCloseTo(5, 3);
    expect(Math.abs(value(meter.id, 'v') - 5)).toBeGreaterThan(1e-6);
  });

  it('blows a fuse once its rating is exceeded and leaves it open', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 12, internal: 0 } });
    const fuse = element('fuse', 0, 0, { values: { resistance: 0.05, rating: 1 } });
    const load = element('resistor', 0, 0, { values: { resistance: 4 } });
    const w = world(loop([cell, fuse, load]));
    const traj = transient(w, 0.05, 1e-4);
    const i = traj.netlist.active.findIndex((e) => e.id === load.id);

    // 12 V across ~4 Ω is 3 A, well past the 1 A rating.
    expect(Math.abs(traj.current[i])).toBeGreaterThan(2.9);
    const last = traj.count - 1;
    expect(Math.abs(traj.current[last * traj.netlist.active.length + i])).toBeLessThan(1e-6);
    expect(traj.state.blown.some(Boolean)).toBe(true);
  });

  it('uses the B-parameter equation for a thermistor', () => {
    expect(thermistorResistance(10000, 3950, 25)).toBeCloseTo(10000, 9);
    // Standard 10 kΩ/B3950 part: about 3.6 kΩ at 50 °C.
    const hot = thermistorResistance(10000, 3950, 50);
    expect(hot).toBeCloseTo(10000 * Math.exp(3950 * (1 / 323.15 - 1 / 298.15)), 9);
    expect(hot).toBeLessThan(4200);
    expect(hot).toBeGreaterThan(3400);

    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 5, internal: 0 } });
    const th = element('thermistor', 0, 0, { values: { r25: 10000, beta: 3950 } });
    const cold = dc(world(loop([cell, th]), { temperature: 0 }));
    const warm = dc(world(loop([cell, th]), { temperature: 60 }));
    expect(Math.abs(warm.value(th.id, 'i'))).toBeGreaterThan(Math.abs(cold.value(th.id, 'i')) * 8);
  });
});

// ------------------------------------------------------------------ transients

describe('RC circuits', () => {
  it('charges as V(1 − e^(−t/RC))', () => {
    const emf = 10;
    const r = 1000;
    const c = 1e-5; // τ = 10 ms
    const cell = element('cell', 0, 0, { reversed: true, values: { emf, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: r } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: c, initial: 0 } });
    const traj = transient(world(loop([cell, res, cap])), 0.05, 1e-6);
    const tau = r * c;

    for (const t of [0.002, 0.005, 0.01, 0.02, 0.04]) {
      const k = circuitSampleAt(traj, t);
      const v = readCircuit(traj, reading('voltage', cap.id), k);
      expect(Math.abs(v)).toBeCloseTo(emf * (1 - Math.exp(-traj.time[k] / tau)), 4);
    }
    // At one time constant, 63.2% — the number every textbook quotes.
    const k = circuitSampleAt(traj, tau);
    expect(Math.abs(readCircuit(traj, reading('voltage', cap.id), k)) / emf).toBeCloseTo(1 - Math.exp(-1), 4);
  });

  it('stores Q = CV and ½CV² of energy', () => {
    const emf = 8;
    const c = 2e-4;
    const cell = element('cell', 0, 0, { reversed: true, values: { emf, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: 50 } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: c, initial: 0 } });
    const traj = transient(world(loop([cell, res, cap])), 0.2, 1e-6);
    const k = traj.count - 1;
    const v = Math.abs(readCircuit(traj, reading('voltage', cap.id), k));
    expect(v).toBeCloseTo(emf, 4);
    expect(Math.abs(readCircuit(traj, reading('charge', cap.id), k))).toBeCloseTo(c * emf, 6);
    expect(readCircuit(traj, reading('stored', cap.id), k)).toBeCloseTo(0.5 * c * emf * emf, 6);
  });

  it('discharges a pre-charged capacitor as V₀e^(−t/RC)', () => {
    const v0 = 6;
    const r = 2000;
    const c = 5e-6; // τ = 10 ms
    const res = element('resistor', 0, 0, { values: { resistance: r } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: c, initial: v0 } });
    const traj = transient(world(loop([res, cap])), 0.05, 1e-6);
    const tau = r * c;
    for (const t of [0.003, 0.01, 0.025]) {
      const k = circuitSampleAt(traj, t);
      expect(Math.abs(readCircuit(traj, reading('voltage', cap.id), k))).toBeCloseTo(
        v0 * Math.exp(-traj.time[k] / tau),
        4,
      );
    }
  });
});

describe('RL circuits', () => {
  it('builds current as (V/R)(1 − e^(−Rt/L))', () => {
    const emf = 12;
    const r = 20;
    const l = 0.1; // τ = 5 ms
    const cell = element('cell', 0, 0, { reversed: true, values: { emf, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: r } });
    const ind = element('inductor', 0, 0, { values: { inductance: l, initial: 0 } });
    const traj = transient(world(loop([cell, res, ind])), 0.04, 1e-6);
    const tau = l / r;
    for (const t of [0.001, 0.005, 0.012, 0.03]) {
      const k = circuitSampleAt(traj, t);
      expect(Math.abs(readCircuit(traj, reading('current', ind.id), k))).toBeCloseTo(
        (emf / r) * (1 - Math.exp(-traj.time[k] / tau)),
        5,
      );
    }
  });
});

describe('series RLC', () => {
  it('rings at √(ω₀² − α²) and decays as e^(−αt)', () => {
    const emf = 5;
    const r = 20;
    const l = 0.01;
    const c = 1e-6;
    const cell = element('cell', 0, 0, { reversed: true, values: { emf, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: r } });
    const ind = element('inductor', 0, 0, { values: { inductance: l, initial: 0 } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: c, initial: 0 } });
    const traj = transient(world(loop([cell, res, ind, cap])), 0.01, 2e-8);

    const alpha = r / (2 * l);
    const omega0 = 1 / Math.sqrt(l * c);
    const omegaD = Math.sqrt(omega0 * omega0 - alpha * alpha);
    expect(alpha).toBeLessThan(omega0); // genuinely underdamped

    // v_C(t) = V[1 − e^(−αt)(cos ω_d t + (α/ω_d) sin ω_d t)]
    for (const t of [0.0002, 0.0006, 0.0015, 0.004]) {
      const k = circuitSampleAt(traj, t);
      const tt = traj.time[k];
      const predicted =
        emf *
        (1 - Math.exp(-alpha * tt) * (Math.cos(omegaD * tt) + (alpha / omegaD) * Math.sin(omegaD * tt)));
      expect(Math.abs(readCircuit(traj, reading('voltage', cap.id), k))).toBeCloseTo(predicted, 3);
    }
  });

  it('does not overshoot when critically damped', () => {
    const l = 0.01;
    const c = 1e-6;
    const critical = 2 * Math.sqrt(l / c);
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 5, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: critical * 1.2 } });
    const ind = element('inductor', 0, 0, { values: { inductance: l, initial: 0 } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: c, initial: 0 } });
    const traj = transient(world(loop([cell, res, ind, cap])), 0.01, 2e-8);
    let peak = 0;
    for (let k = 0; k < traj.count; k++) {
      peak = Math.max(peak, Math.abs(readCircuit(traj, reading('voltage', cap.id), k)));
    }
    expect(peak).toBeLessThan(5 + 1e-3);
  });
});

// ------------------------------------------------------------------ nonlinear

describe('diodes and LEDs', () => {
  /** Solves I = Is(e^(V/nVt) − 1) with V = supply − IR, by bisection. */
  function junctionOperatingPoint(supply: number, r: number, forward: number, ideality: number, rated: number) {
    const vt = 0.025852;
    const is = rated / (Math.exp(forward / (ideality * vt)) - 1);
    let lo = 0;
    let hi = supply;
    for (let i = 0; i < 200; i++) {
      const v = (lo + hi) / 2;
      const diode = is * (Math.exp(v / (ideality * vt)) - 1);
      const throughR = (supply - v) / r;
      if (diode > throughR) hi = v;
      else lo = v;
    }
    const v = (lo + hi) / 2;
    return { v, i: (supply - v) / r };
  }

  it('finds the operating point of an LED with a series resistor', () => {
    const supply = 5;
    const r = 220;
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: supply, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: r } });
    const led = element('led', 0, 0, { values: { forward: 2, ideality: 2, rating: 0.02 } });
    const { value } = dc(world(loop([cell, res, led])));

    const exact = junctionOperatingPoint(supply, r, 2, 2, 0.02);
    expect(Math.abs(value(led.id, 'v'))).toBeCloseTo(exact.v, 6);
    expect(Math.abs(value(led.id, 'i'))).toBeCloseTo(exact.i, 8);
    // Sanity: a 5 V supply, 220 Ω and a 2 V LED is the canonical ~13 mA.
    expect(Math.abs(value(led.id, 'i'))).toBeGreaterThan(0.009);
    expect(Math.abs(value(led.id, 'i'))).toBeLessThan(0.016);
  });

  it('blocks current when reversed', () => {
    const supply = 5;
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: supply, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: 220 } });
    const forward = element('diode', 0, 0, { values: { forward: 0.7, ideality: 1.6 } });
    const backward = element('diode', 0, 0, { reversed: true, values: { forward: 0.7, ideality: 1.6 } });

    const on = dc(world(loop([cell, res, forward])));
    const off = dc(world(loop([cell, res, backward])));
    expect(Math.abs(on.value(forward.id, 'i'))).toBeGreaterThan(0.015);
    expect(Math.abs(off.value(backward.id, 'i'))).toBeLessThan(1e-6);
  });

  it('converges for a diode driven far into conduction', () => {
    // 100 V through 1 Ω is the kind of step that makes an unlimited Newton
    // iteration overflow on the first pass.
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 100, internal: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: 1 } });
    const d = element('diode', 0, 0, { values: { forward: 0.7, ideality: 1.6 } });
    const { state, value } = dc(world(loop([cell, res, d])));
    expect(state.converged).toBe(true);
    expect(Math.abs(value(d.id, 'i'))).toBeGreaterThan(90);
    expect(Math.abs(value(d.id, 'v'))).toBeLessThan(2);
  });
});

// ------------------------------------------------------------------ AC

describe('AC source', () => {
  it('drives a resistor with the right amplitude and phase', () => {
    const amplitude = 10;
    const frequency = 50;
    const r = 100;
    const src = element('ac', 0, 0, {
      reversed: true,
      values: { amplitude, frequency, phase: 0, offset: 0 },
    });
    const res = element('resistor', 0, 0, { values: { resistance: r } });
    const traj = transient(world(loop([src, res])), 0.04, 1e-6);
    for (const t of [0.003, 0.0075, 0.012]) {
      const k = circuitSampleAt(traj, t);
      const expected = (amplitude * Math.sin(2 * Math.PI * frequency * traj.time[k])) / r;
      expect(Math.abs(readCircuit(traj, reading('current', res.id), k))).toBeCloseTo(Math.abs(expected), 8);
    }
  });

  it('attenuates a high frequency through an RC low-pass by 1/√(1+(ωRC)²)', () => {
    const r = 1000;
    const c = 1e-6;
    const frequency = 1000; // ωRC ≈ 6.28
    const src = element('ac', 0, 0, { reversed: true, values: { amplitude: 5, frequency, phase: 0, offset: 0 } });
    const res = element('resistor', 0, 0, { values: { resistance: r } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: c, initial: 0 } });
    const traj = transient(world(loop([src, res, cap])), 0.02, 5e-8);

    // Measure the steady-state amplitude over the last few cycles.
    let peak = 0;
    const start = circuitSampleAt(traj, 0.015);
    for (let k = start; k < traj.count; k++) {
      peak = Math.max(peak, Math.abs(readCircuit(traj, reading('voltage', cap.id), k)));
    }
    const omega = 2 * Math.PI * frequency;
    const gain = 1 / Math.sqrt(1 + (omega * r * c) ** 2);
    expect(peak).toBeCloseTo(5 * gain, 2);
  });
});

// ------------------------------------------------------------------ validation

describe('netlist', () => {
  it('collapses wires into a single node', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 5, internal: 0 } });
    const load = element('resistor', 0, 0, { values: { resistance: 10 } });
    const netlist = buildNetlist(world(loop([cell, load])));
    // Two elements, and only one non-reference node between them.
    expect(netlist.active).toHaveLength(2);
    expect(netlist.nodeCount).toBe(1);
  });

  it('reports an empty canvas rather than solving nothing', () => {
    expect(buildNetlist(world([])).problems.length).toBeGreaterThan(0);
  });

  it('warns when there is no source', () => {
    const r1 = element('resistor', 0, 0, {});
    const r2 = element('resistor', 0, 0, {});
    expect(buildNetlist(world(loop([r1, r2]))).warnings.join(' ')).toMatch(/no source/i);
  });
});

describe('readings are computed the same way everywhere', () => {
  it('gives a thermistor its resistance, not a dash', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 5, internal: 0 } });
    const th = element('thermistor', 0, 0, { values: { r25: 10000, beta: 3950 } });
    const r = element('resistor', 0, 0, { values: { resistance: 10000 } });
    const w = world(loop([cell, th, r]), { temperature: 25 });
    const { netlist, state } = dc(w);
    const i = netlist.active.findIndex((e) => e.id === th.id);

    // The steady-state panel takes this path; the over-time chart takes
    // readCircuit. They must not be able to disagree.
    expect(
      readingValue(netlist.active[i], state.elementVoltage[i], state.elementCurrent[i], 'resistance', 25),
    ).toBeCloseTo(10000, 6);
    expect(
      readingValue(netlist.active[i], state.elementVoltage[i], state.elementCurrent[i], 'power', 25),
    ).toBeCloseTo(state.elementVoltage[i] * state.elementCurrent[i], 12);

    const traj = transient(w, 0.01, 1e-4);
    expect(readCircuit(traj, reading('resistance', th.id), 0)).toBeCloseTo(10000, 6);
  });

  it('reports the charge and stored energy of a capacitor from either path', () => {
    const cell = element('cell', 0, 0, { reversed: true, values: { emf: 4, internal: 0 } });
    const r = element('resistor', 0, 0, { values: { resistance: 100 } });
    const cap = element('capacitor', 0, 0, { values: { capacitance: 1e-4, initial: 0 } });
    const w = world(loop([cell, r, cap]));
    const traj = transient(w, 0.2, 1e-6);
    const k = traj.count - 1;
    const q = readCircuit(traj, reading('charge', cap.id), k);
    const u = readCircuit(traj, reading('stored', cap.id), k);
    const v = readCircuit(traj, reading('voltage', cap.id), k);
    expect(Math.abs(q)).toBeCloseTo(1e-4 * Math.abs(v), 12);
    expect(u).toBeCloseTo(0.5 * 1e-4 * v * v, 12);
  });
});
