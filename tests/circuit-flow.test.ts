import { describe, expect, it } from 'vitest';
import {
  advanceCircuit,
  buildNetlist,
  createCircuitTrajectory,
  defaultValues,
  flowPoint,
  operatingPoint,
  wireFlow,
  type CircuitElement,
  type CircuitWorld,
  type ElementKind,
} from '../src/core/physics/circuit';

/* The animation is the part of this mode a student reads without thinking, so
 * it is the part most able to teach them something false. These tests pin the
 * two things it has to get right: which way round the loop the charge goes,
 * and how far along it has got.
 */

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
    label: '',
    ...over,
    values: { ...defaultValues(kind), ...(over.values ?? {}) },
  };
}

/* A square loop, drawn explicitly rather than by a helper, because the whole
 * question here is which way round it goes:
 *
 *        (0,1) ── top wire ── (1,1)
 *          │                    │
 *        cell                resistor
 *          │                    │
 *        (0,0) ── bottom  ── (1,0)
 *
 * The cell runs (0,0) → (0,1), so terminal a is at (0,0) and, unreversed, that
 * is its positive terminal. Conventional current therefore leaves (0,0), runs
 * along the bottom to (1,0), up through the resistor to (1,1), back along the
 * top and into the negative terminal at (0,1).
 */
function squareLoop(over: Partial<CircuitElement> = {}, emf = 6, resistance = 3) {
  const cell = element('cell', 0, 0, { orientation: 'v', values: { emf, internal: 0 }, ...over });
  const resistor = element('resistor', 1, 0, { orientation: 'v', values: { resistance } });
  const bottom = element('wire', 0, 0, { orientation: 'h' });
  const top = element('wire', 0, 1, { orientation: 'h' });
  const world: CircuitWorld = { elements: [cell, resistor, bottom, top], temperature: 25, timestep: 0 };
  return { world, cell, resistor, bottom, top };
}

function indexOf(netlist: ReturnType<typeof buildNetlist>, id: string): number {
  return netlist.active.findIndex((e) => e.id === id);
}
function wireIndexOf(netlist: ReturnType<typeof buildNetlist>, id: string): number {
  return netlist.wires.findIndex((e) => e.id === id);
}

describe('which way the current goes', () => {
  it('runs out of the positive terminal and back into the negative one', () => {
    const { world, cell, resistor, bottom, top } = squareLoop();
    const netlist = buildNetlist(world);
    const state = operatingPoint(world);
    const loopCurrent = 6 / 3;

    // Through the resistor, a → b is upwards, the direction the current runs.
    expect(state.elementCurrent[indexOf(netlist, resistor.id)]).toBeCloseTo(loopCurrent, 9);

    /* Inside the cell the current runs from − back to +, which is b → a, so
     * its element current is negative. That is not a quirk of the sign
     * convention to be papered over — it is what makes the animation continuous
     * round the loop, and a cell whose dots ran the same way as the resistor's
     * would be showing charge arriving at the positive plate from both sides. */
    expect(state.elementCurrent[indexOf(netlist, cell.id)]).toBeCloseTo(-loopCurrent, 9);

    const flow = wireFlow(netlist, state.elementCurrent);
    // Bottom wire: drawn left to right, and that is the way the charge goes.
    expect(flow[wireIndexOf(netlist, bottom.id)]).toBeCloseTo(loopCurrent, 9);
    // Top wire: also drawn left to right, but the return path runs the other
    // way, so its flow is negative and the dots travel right to left.
    expect(flow[wireIndexOf(netlist, top.id)]).toBeCloseTo(-loopCurrent, 9);
  });

  it('reverses the flow through the circuit when the cell is turned round', () => {
    const forward = squareLoop();
    const backward = squareLoop({ reversed: true });
    const nf = buildNetlist(forward.world);
    const nb = buildNetlist(backward.world);
    const sf = operatingPoint(forward.world);
    const sb = operatingPoint(backward.world);

    // The resistor has not moved, so its current simply flips.
    expect(sb.elementCurrent[indexOf(nb, backward.resistor.id)]).toBeCloseTo(
      -sf.elementCurrent[indexOf(nf, forward.resistor.id)],
      8,
    );

    /* The cell's own current does *not* flip, and that is not a bug: current
     * is measured from terminal a to terminal b, and reversing the cell is
     * precisely a relabelling of which end is a. What changes is where those
     * terminals are in space — which is why the animation has to follow
     * `terminals`, not the axis the symbol is drawn along. */
    expect(sb.elementCurrent[indexOf(nb, backward.cell.id)]).toBeCloseTo(
      sf.elementCurrent[indexOf(nf, forward.cell.id)],
      8,
    );

    // The wires are the honest witness: the whole loop runs the other way.
    const ff = wireFlow(nf, sf.elementCurrent);
    const fb = wireFlow(nb, sb.elementCurrent);
    for (const [f, b] of [
      [forward.bottom, backward.bottom],
      [forward.top, backward.top],
    ]) {
      expect(fb[wireIndexOf(nb, b.id)]).toBeCloseTo(-ff[wireIndexOf(nf, f.id)], 8);
    }
  });

  it('animates a reversed component along its terminals, not its symbol', () => {
    /* Both cells occupy the grid square (0,0)–(0,1) and are drawn there. The
     * reversed one carries its positive current from (0,1) down to (0,0), so a
     * quarter of the way along its flow is *near the top*, not the bottom. Send
     * the dots along the drawing axis instead and every reversed component in
     * the circuit animates backwards. */
    const upright = element('cell', 0, 0, { orientation: 'v' });
    const turned = element('cell', 0, 0, { orientation: 'v', reversed: true });

    expect(flowPoint(upright, 0.25)).toEqual([0, 0.25]);
    expect(flowPoint(turned, 0.25)).toEqual([0, 0.75]);

    // And the phase wraps, so a dot never leaves the component it belongs to.
    expect(flowPoint(upright, 1.25)).toEqual([0, 0.25]);
    expect(flowPoint(upright, -0.25)).toEqual([0, 0.75]);
  });

  it('carries the branch current through the wires of a parallel pair', () => {
    /* Two resistors side by side across one cell. The wires along each branch
     * must carry that branch's own current, and the shared return must carry
     * the sum — which is the check that the least-norm solution is not simply
     * splitting things evenly wherever it is unsure.
     *
     *   (0,1) ─ (1,1) ─ (2,1)      top rail
     *     │       │       │
     *   cell     6Ω      12Ω
     *     │       │       │
     *   (0,0) ─ (1,0) ─ (2,0)      bottom rail
     */
    const cell = element('cell', 0, 0, { orientation: 'v', values: { emf: 12, internal: 0 } });
    const r1 = element('resistor', 1, 0, { orientation: 'v', values: { resistance: 6 } });
    const r2 = element('resistor', 2, 0, { orientation: 'v', values: { resistance: 12 } });
    const b1 = element('wire', 0, 0, { orientation: 'h' });
    const b2 = element('wire', 1, 0, { orientation: 'h' });
    const t1 = element('wire', 0, 1, { orientation: 'h' });
    const t2 = element('wire', 1, 1, { orientation: 'h' });
    const world: CircuitWorld = {
      elements: [cell, r1, r2, b1, b2, t1, t2],
      temperature: 25,
      timestep: 0,
    };
    const netlist = buildNetlist(world);
    const state = operatingPoint(world);
    const flow = wireFlow(netlist, state.elementCurrent);

    const i1 = 12 / 6;
    const i2 = 12 / 12;
    expect(state.elementCurrent[indexOf(netlist, r1.id)]).toBeCloseTo(i1, 9);
    expect(state.elementCurrent[indexOf(netlist, r2.id)]).toBeCloseTo(i2, 9);

    // The first bottom wire feeds both branches; the second feeds only the far one.
    expect(flow[wireIndexOf(netlist, b1.id)]).toBeCloseTo(i1 + i2, 6);
    expect(flow[wireIndexOf(netlist, b2.id)]).toBeCloseTo(i2, 6);
    expect(flow[wireIndexOf(netlist, t1.id)]).toBeCloseTo(-(i1 + i2), 6);
    expect(flow[wireIndexOf(netlist, t2.id)]).toBeCloseTo(-i2, 6);
  });

  it('is linear, so the same solve works for charge as for current', () => {
    // The animation feeds accumulated charge through wireFlow rather than
    // current. That is only legitimate because the map is linear.
    const { world } = squareLoop();
    const netlist = buildNetlist(world);
    const state = operatingPoint(world);
    const once = wireFlow(netlist, state.elementCurrent);
    const doubled = wireFlow(netlist, Array.from(state.elementCurrent, (v) => v * 2.5));
    once.forEach((v, j) => expect(doubled[j]).toBeCloseTo(v * 2.5, 9));
  });
});

describe('how far the charge has got', () => {
  function run(elements: CircuitElement[], duration: number) {
    const world: CircuitWorld = { elements, temperature: 25, timestep: 0 };
    const traj = createCircuitTrajectory(world, duration);
    advanceCircuit(traj, duration, 400000);
    expect(traj.failed).toBe(false);
    const n = traj.netlist.active.length;
    const at = (id: string) => traj.netlist.active.findIndex((e) => e.id === id);
    const series = (id: string, arr: Float64Array) => {
      const i = at(id);
      return Array.from({ length: traj.count }, (_, k) => arr[k * n + i]);
    };
    return { traj, series, times: Array.from(traj.time.subarray(0, traj.count)) };
  }

  it('delivers CV of charge into a capacitor, and never runs backwards', () => {
    const emf = 5;
    const resistance = 1000;
    const capacitance = 1e-4; // τ = 0.1 s
    /* Series, which needs the resistor laid along the bottom rail rather than
     * across it — three vertical parts between the same two rails would be
     * three things in parallel.
     *
     *   (0,1) ─────── (1,1) ─────── (2,1)
     *     │                           │
     *   cell                     capacitor
     *     │                           │
     *   (0,0) ── (1,0) ──[R]── (2,0)
     */
    const cell = element('cell', 0, 0, { orientation: 'v', values: { emf, internal: 0 } });
    const r = element('resistor', 1, 0, { orientation: 'h', values: { resistance } });
    const c = element('capacitor', 2, 0, { orientation: 'v', values: { capacitance, initial: 0 } });
    const parts = [
      cell,
      r,
      c,
      element('wire', 0, 0, { orientation: 'h' }),
      element('wire', 0, 1, { orientation: 'h' }),
      element('wire', 1, 1, { orientation: 'h' }),
    ];
    const { traj, series } = run(parts, 1);

    const charge = series(r.id, traj.charge);
    const current = series(r.id, traj.current);

    // ∫I dt over five time constants is CV to better than a percent.
    expect(charge[charge.length - 1]).toBeCloseTo(capacitance * emf, 6);

    /* Monotonic, because the current never reverses. This is the assertion the
     * old animation could not satisfy: it placed the dots at t·I(t), and
     * t·e^(−t/τ) turns over at t = τ, so the dots slowed, stopped and ran
     * backwards through a resistor whose current was still flowing forwards. */
    for (let k = 1; k < charge.length; k++) expect(charge[k]).toBeGreaterThanOrEqual(charge[k - 1] - 1e-15);

    // And the old expression really was non-monotonic here, so the test above
    // is testing something rather than restating an arithmetic identity.
    const old = current.map((i, k) => i * traj.time[k]);
    const fell = old.some((v, k) => k > 0 && v < old[k - 1] - 1e-12);
    expect(fell).toBe(true);
  });

  it('oscillates about zero on AC instead of sweeping away', () => {
    const frequency = 50;
    const amplitude = 10;
    const resistance = 100;
    const ac = element('ac', 0, 0, {
      orientation: 'v',
      values: { amplitude, frequency, phase: 0, offset: 0, internal: 0 },
    });
    const r = element('resistor', 1, 0, { orientation: 'v', values: { resistance } });
    const { traj, series } = run(
      [ac, r, element('wire', 0, 0, { orientation: 'h' }), element('wire', 0, 1, { orientation: 'h' })],
      0.1,
    );

    const charge = series(r.id, traj.charge);
    // q(t) = ∫ (A/R) sin(ωt) dt = (A/ωR)(1 − cos ωt): between 0 and 2A/ωR,
    // for ever, rather than growing with t as t·sin(ωt) does.
    const bound = (2 * amplitude) / (2 * Math.PI * frequency * resistance);
    expect(Math.max(...charge)).toBeCloseTo(bound, 5);
    expect(Math.min(...charge)).toBeGreaterThanOrEqual(-1e-9);
    expect(charge.some((q, k) => k > 0 && q < charge[k - 1])).toBe(true);
  });

  it('scales the animation by the largest current of the whole run', () => {
    /* Not the largest at this instant. On AC everything passes through zero
     * together, so an instantaneous maximum makes every branch's *ratio* to it
     * meaningless and the dots sprint precisely when nothing is flowing. */
    const frequency = 50;
    const amplitude = 10;
    const resistance = 100;
    const ac = element('ac', 0, 0, {
      orientation: 'v',
      values: { amplitude, frequency, phase: 0, offset: 0, internal: 0 },
    });
    const r = element('resistor', 1, 0, { orientation: 'v', values: { resistance } });
    const { traj, series } = run(
      [ac, r, element('wire', 0, 0, { orientation: 'h' }), element('wire', 0, 1, { orientation: 'h' })],
      0.1,
    );

    expect(traj.peakCurrent).toBeCloseTo(amplitude / resistance, 3);
    const current = series(r.id, traj.current);
    const quietest = Math.min(...current.map(Math.abs));
    expect(quietest).toBeLessThan(traj.peakCurrent * 0.05);
  });

  it('starts every element at zero charge', () => {
    const { world } = squareLoop();
    const traj = createCircuitTrajectory(world, 1);
    const n = traj.netlist.active.length;
    for (let i = 0; i < n; i++) expect(traj.charge[i]).toBe(0);
  });
});

describe('closed switches carry the flow too', () => {
  it('treats a closed switch as a conductor and an open one as a break', () => {
    const closed = element('switch', 0, 0, { orientation: 'h', values: { closed: 1 } });
    const open = element('switch', 0, 0, { orientation: 'h', values: { closed: 0 } });
    const rest = (sw: CircuitElement) => [
      element('cell', 0, 0, { orientation: 'v', values: { emf: 6, internal: 0 } }),
      element('resistor', 1, 0, { orientation: 'v', values: { resistance: 3 } }),
      { ...sw, x: 0, y: 0, orientation: 'h' as const },
      element('wire', 0, 1, { orientation: 'h' }),
    ];

    const shut = buildNetlist({ elements: rest(closed), temperature: 25, timestep: 0 });
    expect(shut.wires.some((w) => w.kind === 'switch')).toBe(true);
    // A closed switch is a short, so it is not one of the solved elements.
    expect(shut.active.some((e) => e.kind === 'switch')).toBe(false);

    const ajar = buildNetlist({ elements: rest(open), temperature: 25, timestep: 0 });
    expect(ajar.wires.some((w) => w.kind === 'switch')).toBe(false);
    expect(ajar.active.some((e) => e.kind === 'switch')).toBe(true);
  });
});
