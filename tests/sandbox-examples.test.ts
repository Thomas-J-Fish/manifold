import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/core/examples';
import { makeProject, makeTab } from '../src/core/defaults';
import { deserialiseProject, serialiseProject } from '../src/core/serialize';
import { advance, createTrajectory, prepare, readMeasurement } from '../src/core/physics/mechanics';
import {
  advanceCircuit,
  buildNetlist,
  createCircuitTrajectory,
  operatingPoint,
  readCircuit,
} from '../src/core/physics/circuit';
import { analyseCircuit, analyseMechanics } from '../src/core/physics/analytic';

/* An example that does not run is worse than no example: it is the first thing
 * a new user opens, and a warning triangle there says the whole app is
 * unreliable. These tests build every one and actually simulate it. */

const mechanicsExamples = EXAMPLES.filter((e) => e.build().mode === 'mechanics');
const circuitExamples = EXAMPLES.filter((e) => e.build().mode === 'circuits');

describe('mechanics examples', () => {
  it('there are some', () => {
    expect(mechanicsExamples.length).toBeGreaterThanOrEqual(4);
  });

  for (const example of mechanicsExamples) {
    it(`${example.title} builds, runs and stays finite`, () => {
      const tab = example.build();
      const cfg = tab.mechanics;
      const prep = prepare(cfg.world);
      expect(prep.problems).toEqual([]);

      const traj = createTrajectory(prep);
      advance(traj, Math.min(6, tab.timeline.tMax), 1e7);
      expect(traj.failed).toBe(false);
      expect(traj.count).toBeGreaterThan(10);

      for (let k = 0; k < traj.count; k += Math.max(1, Math.floor(traj.count / 40))) {
        for (const m of cfg.measurements) {
          const v = readMeasurement(traj, m, k);
          expect(Number.isFinite(v)).toBe(true);
        }
      }

      // Every measurement must point at something that still exists.
      const ids = new Set([
        ...cfg.world.bodies.map((b) => b.id),
        ...cfg.world.links.map((l) => l.id),
        ...cfg.world.pulleys.map((p) => p.id),
      ]);
      for (const m of cfg.measurements) {
        if (m.target) expect(ids.has(m.target)).toBe(true);
      }

      expect(() => analyseMechanics(cfg.world, prep)).not.toThrow();
    });
  }

  it('the double pendulum really is chaotic', () => {
    const build = EXAMPLES.find((e) => e.id === 'double-pendulum')!.build();
    const nudge = EXAMPLES.find((e) => e.id === 'double-pendulum')!.build();
    nudge.mechanics.world.bodies = nudge.mechanics.world.bodies.map((b) =>
      b.id === 'm2' ? { ...b, x: b.x + 1e-6 } : b,
    );

    const runs = [build, nudge].map((tab) => {
      const prep = prepare(tab.mechanics.world);
      const traj = createTrajectory(prep);
      advance(traj, 25, 1e7);
      return { prep, traj };
    });

    const angleAt = (r: (typeof runs)[number], t: number) =>
      readMeasurement(r.traj, { id: 'x', kind: 'angle', target: 'r2', colour: '#fff', visible: true }, Math.min(r.traj.count - 1, Math.round(t / r.traj.dt)));

    /* A millionth of a metre apart, indistinguishable at first, and nothing
     * like each other by the end of the example's own thirty-second timeline.
     *
     * The separation grows by roughly e^0.9t, so at twelve seconds the two runs
     * differ by less than two degrees — visible on a chart, but not the
     * demonstration this example exists to give. Twenty-five seconds is where
     * they have genuinely parted company, which is why the example's timeline
     * is as long as it is. */
    expect(Math.abs(angleAt(runs[0], 0.5) - angleAt(runs[1], 0.5))).toBeLessThan(0.01);
    expect(Math.abs(angleAt(runs[0], 12) - angleAt(runs[1], 12))).toBeGreaterThan(0.5);
    expect(Math.abs(angleAt(runs[0], 25) - angleAt(runs[1], 25))).toBeGreaterThan(20);
  });
});

describe('circuit examples', () => {
  it('there are some', () => {
    expect(circuitExamples.length).toBeGreaterThanOrEqual(3);
  });

  for (const example of circuitExamples) {
    it(`${example.title} builds, solves and stays finite`, () => {
      const tab = example.build();
      const cfg = tab.circuits;
      const netlist = buildNetlist(cfg.world);
      expect(netlist.problems).toEqual([]);
      expect(netlist.warnings).toEqual([]);

      const dc = operatingPoint(cfg.world, netlist);
      expect(dc.converged).toBe(true);
      for (let i = 0; i < netlist.active.length; i++) {
        expect(Number.isFinite(dc.elementVoltage[i])).toBe(true);
        expect(Number.isFinite(dc.elementCurrent[i])).toBe(true);
      }

      const ids = new Set(netlist.active.map((e) => e.id));
      for (const r of cfg.readings) expect(ids.has(r.target)).toBe(true);

      if (cfg.analysis === 'transient') {
        const traj = createCircuitTrajectory(cfg.world, tab.timeline.tMax);
        advanceCircuit(traj, tab.timeline.tMax, 1e7);
        expect(traj.failed).toBe(false);
        expect(traj.count).toBeGreaterThan(10);
        for (let k = 0; k < traj.count; k += Math.max(1, Math.floor(traj.count / 40))) {
          for (const r of cfg.readings) expect(Number.isFinite(readCircuit(traj, r, k))).toBe(true);
        }
      }

      expect(() => analyseCircuit(cfg.world, netlist)).not.toThrow();
    });
  }

  it('the RC example charges to within a percent of the supply', () => {
    const tab = EXAMPLES.find((e) => e.id === 'rc-charging')!.build();
    const traj = createCircuitTrajectory(tab.circuits.world, tab.timeline.tMax);
    advanceCircuit(traj, tab.timeline.tMax, 1e7);
    const cap = tab.circuits.world.elements.find((e) => e.id === 'c')!;
    const final = Math.abs(
      readCircuit(traj, { id: 'r', kind: 'voltage', target: cap.id, colour: '#fff', visible: true }, traj.count - 1),
    );
    // 3 s against τ = 0.47 s: more than six time constants.
    expect(final).toBeGreaterThan(8.9);
    expect(final).toBeLessThan(9.01);
  });

  it('the thermistor divider swings with temperature', () => {
    const tab = EXAMPLES.find((e) => e.id === 'potential-divider')!.build();
    const readAt = (celsius: number) => {
      const world = { ...tab.circuits.world, temperature: celsius };
      const netlist = buildNetlist(world);
      const state = operatingPoint(world, netlist);
      const i = netlist.active.findIndex((e) => e.id === 'vm');
      return Math.abs(state.elementVoltage[i]);
    };
    // The thermistor's resistance falls as it warms, so more of the supply
    // appears across the fixed resistor and less across the meter — or the
    // other way round, depending which half the meter is on. Either way it
    // must move a long way, or the example teaches nothing.
    expect(Math.abs(readAt(60) - readAt(0))).toBeGreaterThan(1);
  });
});

describe('sandbox scenes survive a save and reload', () => {
  it('round-trips a mechanics tab exactly', () => {
    const project = makeProject();
    project.tabs = [EXAMPLES.find((e) => e.id === 'block-on-a-slope')!.build()];
    project.activeTabId = project.tabs[0].id;

    const { project: loaded, warnings } = deserialiseProject(serialiseProject(project));
    expect(warnings).toEqual([]);
    const before = project.tabs[0].mechanics;
    const after = loaded.tabs[0].mechanics;
    expect(after.world).toEqual(before.world);
    expect(after.measurements).toEqual(before.measurements);
  });

  it('round-trips a circuit tab exactly, including component values', () => {
    const project = makeProject();
    project.tabs = [EXAMPLES.find((e) => e.id === 'rlc-ringing')!.build()];
    project.activeTabId = project.tabs[0].id;

    const { project: loaded, warnings } = deserialiseProject(serialiseProject(project));
    expect(warnings).toEqual([]);
    expect(loaded.tabs[0].circuits.world).toEqual(project.tabs[0].circuits.world);
    expect(loaded.tabs[0].circuits.readings).toEqual(project.tabs[0].circuits.readings);
  });

  it('repairs a scene whose pieces have been hand-edited into nonsense', () => {
    const project = makeProject();
    project.tabs = [makeTab('mechanics')];
    project.activeTabId = project.tabs[0].id;
    const text = serialiseProject(project);
    const raw = JSON.parse(text);

    // The kind of damage a text editor does: a missing mass, a link to a body
    // that is not there, a reading pointing at a deleted part.
    raw.tabs[0].mechanics.world.bodies[1].mass = null;
    raw.tabs[0].mechanics.world.links.push({ id: 'ghost', kind: 'rod', a: 'nobody', b: 'bob' });
    raw.tabs[0].mechanics.measurements.push({ id: 'z', kind: 'y', target: 'vanished' });

    const { project: loaded } = deserialiseProject(JSON.stringify(raw));
    const cfg = loaded.tabs[0].mechanics;
    expect(cfg.world.bodies[1].mass).toBeGreaterThan(0);
    expect(cfg.world.links.some((l) => l.id === 'ghost')).toBe(false);
    expect(cfg.measurements.some((m) => m.target === 'vanished')).toBe(false);
    // And the repaired scene still simulates.
    expect(prepare(cfg.world).problems).toEqual([]);
  });

  it('drops a circuit element whose kind no longer exists', () => {
    const project = makeProject();
    project.tabs = [makeTab('circuits')];
    project.activeTabId = project.tabs[0].id;
    const raw = JSON.parse(serialiseProject(project));
    raw.tabs[0].circuits.world.elements.push({ id: 'weird', kind: 'flux-capacitor', x: 9, y: 9, orientation: 'h' });

    const { project: loaded } = deserialiseProject(JSON.stringify(raw));
    expect(loaded.tabs[0].circuits.world.elements.some((e) => e.id === 'weird')).toBe(false);
    expect(buildNetlist(loaded.tabs[0].circuits.world).problems).toEqual([]);
  });
});
