import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/core/examples';
import { MODES } from '../src/core/types';
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
import {
  advanceWaveField,
  createWaveField,
  diffractionPattern,
  reflectionCoefficient,
  traceRays,
} from '../src/core/physics/waves';
import { aliasFrequency, applyFilter, designFilter, satisfiesNyquist, spectrum } from '../src/core/math/signal';
import { EvalScope } from '../src/core/math/scope';
import { Rng } from '../src/core/math/random';
import { levenbergMarquardt, NONLINEAR_MODELS, polynomialFit } from '../src/core/math/fitting';
import { constrainedExtrema, feasibleRegion, gradientDescent, solveLinearProgram } from '../src/core/math/optimise';
import {
  buildNetwork,
  equilibriumConstant,
  reactionQuotient,
  runKinetics,
  titrationCurve,
} from '../src/core/chemistry/reactions';
import {
  advanceGas,
  boxArea,
  carnotEfficiency,
  createGas,
  kineticEnergy,
  speeds as speedsOf,
  temperatureOf,
  traceCycle,
  type GasWorld,
} from '../src/core/physics/thermo';
import type { ThermoConfig } from '../src/core/types';

/** The gas the thermodynamics mode builds from a tab's settings. */
const gasWorld = (cfg: ThermoConfig): GasWorld => ({
  count: cfg.count,
  width: cfg.boxWidth,
  height: cfg.boxHeight,
  radius: cfg.radius,
  mass: cfg.particleMass,
  temperature: cfg.temperature,
  thermostat: cfg.thermostat,
  seed: cfg.seed,
  gravity: cfg.gravity,
});

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

describe('the example catalogue', () => {
  it('declares the mode each example actually builds', () => {
    // The dialog groups by the declared mode without building anything, so a
    // wrong declaration would file an example under a heading it does not
    // belong to and there would be nothing on screen to say so.
    for (const ex of EXAMPLES) {
      expect(`${ex.id}: ${ex.build().mode}`).toBe(`${ex.id}: ${ex.mode}`);
    }
  });

  it('gives every mode at least three examples', () => {
    const counts = new Map<string, number>();
    for (const ex of EXAMPLES) counts.set(ex.mode, (counts.get(ex.mode) ?? 0) + 1);
    for (const mode of MODES) {
      expect(`${mode.id}: ${counts.get(mode.id) ?? 0}`).toBe(`${mode.id}: ${Math.max(3, counts.get(mode.id) ?? 0)}`);
    }
  });

  it('has a unique id and a blurb worth reading for each', () => {
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    for (const ex of EXAMPLES) {
      expect(ex.title.length).toBeGreaterThan(6);
      expect(ex.blurb.length).toBeGreaterThan(30);
    }
  });

  it('survives a round trip through the project file', () => {
    /* Every example is a plausible thing for a user to save, and the loader
     * repairs each mode's config on the way back in. An example whose config
     * the sanitiser quietly rewrites would open differently from the way it
     * was built, and the dialog would be lying about what it showed. */
    for (const ex of EXAMPLES) {
      const project = makeProject();
      const tab = ex.build();
      project.tabs = [tab];
      project.activeTabId = tab.id;

      const { project: loaded, warnings } = deserialiseProject(serialiseProject(project));
      expect(`${ex.id}: ${warnings.join('; ')}`).toBe(`${ex.id}: `);
      const back = loaded.tabs[0];
      expect(`${ex.id}: ${back.mode}`).toBe(`${ex.id}: ${tab.mode}`);
      // Compared as JSON because these configs are plain data by construction,
      // and a deep equality that ignored an added field would defeat the point.
      const key = tab.mode === 'linear-algebra' ? 'linalg' : tab.mode === 'monte-carlo' ? 'monteCarlo' : tab.mode;
      if (key in tab) {
        expect(`${ex.id}: ${JSON.stringify(back[key as 'waves'])}`).toBe(
          `${ex.id}: ${JSON.stringify(tab[key as 'waves'])}`,
        );
      }
    }
  });
});

describe('fitting examples', () => {
  it('recovers the parameters the enzyme data was generated from', () => {
    /* The blurb quotes numbers, so the numbers have to be true — and they are
     * a genuine test of the solver, because the data was built from Vmax = 2.4
     * and Km = 0.8 and then had noise put on it. A fit that came back with
     * anything else would mean the example is teaching the wrong lesson. */
    const cfg = EXAMPLES.find((e) => e.id === 'michaelis')!.build().fitting;
    const xs = cfg.rows.map((r) => Number(r[0]));
    const ys = cfg.rows.map((r) => Number(r[1]));
    const model = NONLINEAR_MODELS.find((m) => m.id === 'michaelis')!;
    const fit = levenbergMarquardt(xs, ys, model.f, model.initial(xs, ys), model.paramNames);

    expect(fit.params[0]).toBeCloseTo(2.35, 2);
    expect(fit.params[1]).toBeCloseTo(0.77, 2);
    expect(fit.r2).toBeGreaterThan(0.99);
  });

  it('needs the degree the calibration example asks for, and no more', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'cubic-calibration')!.build().fitting;
    const xs = cfg.rows.map((r) => Number(r[0]));
    const ys = cfg.rows.map((r) => Number(r[1]));
    expect(cfg.degree).toBe(3);

    /* Tested through `predict` rather than through the coefficients, because
     * the fit is done in a rescaled variable and its parameters are not the
     * coefficients of x. What matters is that the curve it draws is the curve
     * the data came from. */
    const truth = (x: number) => 0.42 * x ** 3 - 1.1 * x ** 2 - 2 * x + 9;
    const cubic = polynomialFit(xs, ys, 3);
    for (const x of [-2.5, -1, 0, 1.5, 3]) {
      expect(Math.abs(cubic.predict(x) - truth(x))).toBeLessThan(0.7);
    }
    expect(cubic.r2).toBeGreaterThan(0.97);

    // A straight line does not, which is the arch the blurb promises …
    const line = polynomialFit(xs, ys, 1);
    expect(line.r2).toBeLessThan(0.8);
    expect(Math.max(...xs.map((x) => Math.abs(line.predict(x) - truth(x))))).toBeGreaterThan(4);

    // … and a quartic buys almost nothing, which is why the example stops at
    // three rather than at whatever fits best.
    expect(polynomialFit(xs, ys, 4).r2 - cubic.r2).toBeLessThan(0.01);
  });
});

describe('waves examples', () => {
  const wavesExamples = EXAMPLES.filter((e) => e.mode === 'waves');

  it('cover all three views', () => {
    const views = new Set(wavesExamples.map((e) => e.build().waves.world.view));
    expect([...views].sort()).toEqual(['diffract', 'propagate', 'rays']);
  });

  for (const example of wavesExamples) {
    it(`${example.title} produces something finite and on screen`, () => {
      const world = example.build().waves.world;

      if (world.view === 'propagate') {
        const field = createWaveField(world);
        advanceWaveField(field, world.duration);
        expect(field.failed).toBe(false);
        expect(field.count).toBeGreaterThan(10);
        let peak = 0;
        for (let i = 0; i < field.now.length; i++) {
          expect(Number.isFinite(field.now[i])).toBe(true);
          peak = Math.max(peak, Math.abs(field.now[i]));
        }
        // Something is still visible when the clock runs out: an example whose
        // last frame is an empty string looks broken however correct it is.
        expect(peak).toBeGreaterThan(0.02);
      } else if (world.view === 'diffract') {
        const pattern = diffractionPattern(world);
        let peak = 0;
        for (const v of pattern.intensity) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, v);
        }
        expect(peak).toBeCloseTo(1, 6);
        // The screen is wide enough to hold at least one dark fringe, or there
        // is no pattern to look at.
        let minimum = Infinity;
        for (const v of pattern.intensity) minimum = Math.min(minimum, v);
        expect(minimum).toBeLessThan(0.05);
      } else {
        const rays = traceRays(world);
        expect(rays.length).toBe(world.rayCount);
        for (const ray of rays) {
          expect(ray.points.length).toBeGreaterThan(1);
          for (const p of ray.points) {
            expect(Number.isFinite(p.z)).toBe(true);
            expect(Number.isFinite(p.y)).toBe(true);
          }
        }
        // Every ray either bends, stops or turns: a fan that goes straight
        // through has missed the optics entirely.
        expect(rays.some((r) => r.totalInternal || r.stopped !== null || r.points.length > 2)).toBe(true);
      }
    });
  }

  it('reflects a third of the pulse back, inverted, at the junction', () => {
    // The claim the junction example's blurb makes, checked against the
    // simulation rather than against the formula it came from.
    const world = EXAMPLES.find((e) => e.id === 'wave-junction')!.build().waves.world;
    expect(reflectionCoefficient(1, world.speedRatio)).toBeCloseTo(-1 / 3, 12);

    const field = createWaveField(world);
    advanceWaveField(field, world.duration);
    let reflected = 0;
    let transmitted = 0;
    for (let i = 0; i < field.n; i++) {
      const at = field.x[i] / world.length;
      if (at < world.junction) reflected = Math.min(reflected, field.now[i]);
      else transmitted = Math.max(transmitted, field.now[i]);
    }
    /* A pulse released at rest splits into two halves of amplitude ½, so the
     * incident wave is ½ and the two coefficients scale that: −1/6 back and
     * +1/3 on. Both signs matter — the reflection off a *slower* medium is
     * inverted, and off a faster one is not. */
    expect(transmitted).toBeCloseTo(1 / 3, 2);
    expect(reflected).toBeCloseTo(-1 / 6, 2);
  });
});

describe('signals examples', () => {
  const signalsExamples = EXAMPLES.filter((e) => e.mode === 'signals');

  it('cover all four views', () => {
    const views = new Set(signalsExamples.map((e) => e.build().signals.view));
    expect([...views].sort()).toEqual(['filter', 'sampling', 'spectrogram', 'spectrum']);
  });

  for (const example of signalsExamples) {
    it(`${example.title} designs a stable filter and samples cleanly`, () => {
      const cfg = example.build().signals;
      const filter = designFilter({ ...cfg.filter, sampleRate: cfg.sampleRate });
      expect(filter.stable).toBe(true);

      // The expression the example ships must actually compile, or the mode
      // opens showing a warning instead of a signal.
      const scope = new EvalScope();
      const { fn, error } = scope.compile1(cfg.expression, 't');
      expect(`${example.id}: ${error ?? 'ok'}`).toBe(`${example.id}: ok`);

      const count = Math.round(cfg.sampleRate * cfg.duration);
      expect(count).toBeGreaterThan(64);
      const y = new Float64Array(count);
      for (let i = 0; i < count; i++) {
        y[i] = fn(i / cfg.sampleRate);
        expect(Number.isFinite(y[i])).toBe(true);
      }

      // The signal is not silence, and the analysis of it is finite.
      let peak = 0;
      for (const v of y) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(1e-3);
      for (const v of spectrum(y, cfg.sampleRate, cfg.window).magnitude) expect(Number.isFinite(v)).toBe(true);
      for (const v of applyFilter(filter, y)) expect(Number.isFinite(v)).toBe(true);
    });
  }

  it('puts the buried tone above the noise it is buried in', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'buried-tone')!.build().signals;
    const count = Math.round(cfg.sampleRate * cfg.duration);
    const random = new Rng(`${cfg.seed}|${cfg.noise}`);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) y[i] = 0.15 * Math.sin(2 * Math.PI * 77 * (i / cfg.sampleRate)) + random.normal() * cfg.noise;

    // In the time domain the tone is hopeless: the noise is nearly seven times
    // its amplitude. In the frequency domain it is not, because the tone lands
    // in one bin and the noise spreads over all of them — and that difference
    // is the whole reason the mode exists.
    const spec = spectrum(y, cfg.sampleRate, cfg.window);
    let at = 0;
    for (let i = 1; i < spec.frequency.length; i++) if (spec.magnitude[i] > spec.magnitude[at]) at = i;
    expect(spec.frequency[at]).toBeCloseTo(77, 0);

    // Above the RMS floor by 20 dB, and above the *worst* noise bin — the one
    // the eye actually competes with — by 10.
    let power = 0;
    let worst = 0;
    let n = 0;
    for (let i = 0; i < spec.frequency.length; i++) {
      if (Math.abs(spec.frequency[i] - 77) < 5) continue;
      power += spec.magnitude[i] ** 2;
      worst = Math.max(worst, spec.magnitude[i]);
      n++;
    }
    const rms = Math.sqrt(power / n);
    expect(20 * Math.log10(spec.magnitude[at] / rms)).toBeGreaterThan(20);
    expect(20 * Math.log10(spec.magnitude[at] / worst)).toBeGreaterThan(10);
  });

  it('turns 900 Hz into 100 Hz at a kilohertz', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'aliasing')!.build().signals;
    expect(aliasFrequency(cfg.toneFrequency, cfg.sampleFrequency)).toBeCloseTo(100, 12);
    expect(satisfiesNyquist(cfg.toneFrequency, cfg.sampleFrequency)).toBe(false);
  });
});

describe('optimisation examples', () => {
  const examples = EXAMPLES.filter((e) => e.mode === 'optimisation');

  it('cover all three views', () => {
    const views = new Set(examples.map((e) => e.build().optimisation.view));
    expect([...views].sort()).toEqual(['descent', 'lagrange', 'linear']);
  });

  it('solves the feed-mix problem at the corner arithmetic puts it', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'transport-plan')!.build().optimisation;
    const result = solveLinearProgram(cfg.program);
    /* Minimise 3x + 5y with 2x + y ≥ 8 and x + 3y ≥ 9. The two constraints
     * meet at (3, 2): from 2x + y = 8 and x + 3y = 9, x = 3 and y = 2, giving
     * 9 + 10 = 19. Solved by hand, not by running this and writing down what
     * came out. */
    expect(result.status).toBe('optimal');
    expect(result.point![0]).toBeCloseTo(3, 9);
    expect(result.point![1]).toBeCloseTo(2, 9);
    expect(result.value).toBeCloseTo(19, 9);
    // The origin is infeasible here, so phase one had work to do.
    expect(result.path.some((s) => s.phase === 1)).toBe(true);
    // And the region it walked is a genuine polygon.
    expect(feasibleRegion(cfg.program).length).toBeGreaterThanOrEqual(3);
  });

  it('gets the descent example down the valley', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'descent-methods')!.build().optimisation;
    const scope = new EvalScope();
    const { fn, error } = scope.compile2(cfg.surface, 'x', 'y');
    expect(error).toBeNull();
    const result = gradientDescent(fn, {
      method: cfg.method,
      rate: cfg.rate,
      momentum: cfg.momentum,
      steps: cfg.descentSteps,
      start: [cfg.startX, cfg.startY],
      tolerance: 1e-10,
    });
    // Rosenbrock's minimum is at (1, 1) with f = 0, which is where the example
    // has to arrive for it to be showing what it claims to show.
    const last = result.path[result.path.length - 1];
    expect(last.f).toBeLessThan(1e-3);
    expect(last.x).toBeCloseTo(1, 1);
    expect(last.y).toBeCloseTo(1, 1);
    for (const p of result.path) expect(Number.isFinite(p.f)).toBe(true);
  });

  it('finds the largest rectangle in the ellipse, with the multipliers agreeing', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'lagrange-box')!.build().optimisation;
    const scope = new EvalScope();
    const f = scope.compile2(cfg.objective, 'x', 'y');
    const g = scope.compile2(cfg.constraint, 'x', 'y');
    expect(f.error).toBeNull();
    expect(g.error).toBeNull();

    const result = constrainedExtrema(f.fn, g.fn, { xMin: -2.6, xMax: 2.6, yMin: -1.6, yMax: 1.6 }, 300);
    const best = result.best!;
    /* Maximising xy on x²/4 + y² = 1 gives x = √2, y = 1/√2 and xy = 1 —
     * Lagrange by hand: (y, x) = λ(x/2, 2y) forces x² = 4y², and the
     * constraint then fixes both. */
    expect(best.f).toBeCloseTo(1, 2);
    expect(Math.abs(best.x)).toBeCloseTo(Math.SQRT2, 1);
    expect(Math.abs(best.y)).toBeCloseTo(1 / Math.SQRT2, 1);
    // On the curve, and with the two gradients parallel — the cross product
    // of ∇f and ∇g is what the whole method asserts is zero.
    expect(Math.abs(g.fn(best.x, best.y))).toBeLessThan(1e-6);
    const cross = best.gradF[0] * best.gradG[1] - best.gradF[1] * best.gradG[0];
    expect(Math.abs(cross)).toBeLessThan(1e-4);
  });
});

describe('reactions examples', () => {
  const examples = EXAMPLES.filter((e) => e.mode === 'reactions');

  it('cover three different views', () => {
    const views = new Set(examples.map((e) => e.build().reactions.view));
    expect(views.size).toBeGreaterThanOrEqual(3);
  });

  for (const example of examples) {
    it(`${example.title} parses and integrates to something finite`, () => {
      const tab = example.build();
      const cfg = tab.reactions;
      const network = buildNetwork(cfg.reactions);
      expect(`${example.id}: ${network.problems.join(' ') || 'ok'}`).toBe(`${example.id}: ok`);

      const result = runKinetics(network, cfg.initial, cfg.duration, cfg.samples, {
        useArrhenius: cfg.useArrhenius,
        temperature: cfg.temperature,
        perturbation: cfg.perturbation.enabled ? cfg.perturbation : null,
      });
      for (const row of result.concentrations) {
        for (const v of row) {
          expect(Number.isFinite(v)).toBe(true);
          // A concentration below zero means the integrator has overshot, and
          // it is the failure mode stiff kinetics actually has.
          expect(v).toBeGreaterThan(-1e-6);
        }
      }
    });
  }

  it('puts the intermediate’s maximum where the rate constants say', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'consecutive-reaction')!.build().reactions;
    const network = buildNetwork(cfg.reactions);
    const result = runKinetics(network, cfg.initial, cfg.duration, 2000, {
      useArrhenius: false,
      temperature: 298,
    });
    const b = result.concentrations[result.species.indexOf('B')];
    let peak = 0;
    let at = 0;
    b.forEach((v, i) => {
      if (v > peak) {
        peak = v;
        at = result.times[i];
      }
    });
    /* For A → B → C the closed solution puts B's maximum at
     * t = ln(k₁/k₂)/(k₁ − k₂) and its height at (k₂/k₁)^(k₂/(k₁−k₂)). With
     * k₁ = 0.8 and k₂ = 0.15 that is t = 2.577 and B = 0.712 — neither number
     * is anywhere in the code being tested. */
    const k1 = cfg.reactions[0].forward;
    const k2 = cfg.reactions[1].forward;
    expect(at).toBeCloseTo(Math.log(k1 / k2) / (k1 - k2), 1);
    expect(peak).toBeCloseTo((k2 / k1) ** (k2 / (k1 - k2)), 2);
    // And the example has to actually show the hump it is named for: with the
    // constants the other way round B never accumulates and the point is lost.
    expect(peak).toBeGreaterThan(0.4);

    // And mass is conserved: nothing enters or leaves this network.
    const total = result.species.map((_, i) => result.concentrations[i]);
    for (let j = 0; j < result.times.length; j += 50) {
      expect(total.reduce((s, row) => s + row[j], 0)).toBeCloseTo(1, 6);
    }
  });

  it('moves the Haber equilibrium without moving its constant', () => {
    const tab = EXAMPLES.find((e) => e.id === 'le-chatelier')!.build();
    const cfg = tab.reactions;
    const network = buildNetwork(cfg.reactions);
    const spec = cfg.reactions[0];
    const k = equilibriumConstant(spec, false, cfg.temperature)!;
    expect(k).toBeCloseTo(spec.forward / spec.reverse, 12);

    const kicked = runKinetics(network, cfg.initial, cfg.duration, 1200, {
      useArrhenius: false,
      temperature: cfg.temperature,
      perturbation: cfg.perturbation,
    });
    const at = (name: string, index: number) => kicked.concentrations[kicked.species.indexOf(name)][index];
    const beforeKick = Math.round((cfg.perturbation.at / cfg.duration) * 1199) - 8;
    const end = kicked.times.length - 1;

    // The disturbance moves every concentration...
    expect(at('NH3', end)).toBeGreaterThan(at('NH3', beforeKick) + 0.05);
    expect(at('H2', end)).toBeLessThan(at('H2', beforeKick) - 0.05);
    // ...and leaves Q back at K, which is the point of the demonstration.
    const parsed = network.reactions[0].parsed;
    const q = reactionQuotient(parsed, {
      N2: at('N2', end),
      H2: at('H2', end),
      NH3: at('NH3', end),
    })!;
    expect(q / k).toBeCloseTo(1, 1);
  });

  it('gives the diprotic titration two equivalence points in the right places', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'diprotic-titration')!.build().reactions;
    const result = titrationCurve({
      acidConcentration: cfg.acidConcentration,
      acidVolume: cfg.acidVolume,
      baseConcentration: cfg.baseConcentration,
      ka: cfg.ka,
      acidInFlask: cfg.acidInFlask,
      maxVolume: cfg.titrantVolume,
      points: 900,
    });
    // Equal concentrations, so each proton takes one flask-volume of titrant.
    expect(result.equivalenceVolumes).toHaveLength(2);
    expect(result.equivalenceVolumes[0]).toBeCloseTo(25, 6);
    expect(result.equivalenceVolumes[1]).toBeCloseTo(50, 6);
    // Half-equivalence is where pH = pKa, which is how a titration measures one.
    expect(result.halfEquivalenceVolumes[0]).toBeCloseTo(12.5, 6);
    expect(result.pKa[0]).toBeCloseTo(-Math.log10(cfg.ka[0]), 6);
    const half = result.points.reduce((best, p) =>
      Math.abs(p.volume - 12.5) < Math.abs(best.volume - 12.5) ? p : best,
    );
    expect(half.ph).toBeCloseTo(result.pKa[0], 1);
    // The curve rises the whole way: adding base can never lower the pH.
    for (let i = 1; i < result.points.length; i++) {
      expect(result.points[i].ph).toBeGreaterThan(result.points[i - 1].ph - 1e-9);
    }
  });
});

describe('thermodynamics examples', () => {
  const examples = EXAMPLES.filter((e) => e.mode === 'thermodynamics');

  it('cover three different views', () => {
    const views = new Set(examples.map((e) => e.build().thermodynamics.view));
    expect(views.size).toBeGreaterThanOrEqual(3);
  });

  it('starts the Maxwell example with every particle at one speed', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'maxwell-emerges')!.build().thermodynamics;
    expect(cfg.identicalSpeeds).toBe(true);
    // Insulated, or the temperature the analytic curve is drawn at would drift
    // while the distribution is still forming.
    expect(cfg.thermostat).toBe(0);
    const state = createGas(gasWorld(cfg), true);
    const values = speedsOf(state);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1e-9);
    expect(temperatureOf(state)).toBeCloseTo(cfg.temperature, 6);
  });

  it('heats the compression example by the adiabatic amount', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'adiabatic-squeeze')!.build().thermodynamics;
    expect(cfg.pistonSpeed).toBeLessThan(0);
    const state = createGas(gasWorld(cfg));
    const step = (dt: number, until: number) => {
      let t = 0;
      while (t < until - 1e-9) {
        advanceGas(state, Math.min(dt, until - t));
        t += Math.min(dt, until - t);
      }
    };

    step(1 / 30, 2);
    const t0 = temperatureOf(state);
    const a0 = boxArea(state);
    const e0 = kineticEnergy(state);

    state.wallVx = cfg.pistonSpeed;
    step(1 / 30, 18);
    state.wallVx = 0;
    step(1 / 30, 2);

    const t1 = temperatureOf(state);
    const a1 = boxArea(state);
    expect(a1).toBeLessThan(a0 * 0.7);
    expect(t1).toBeGreaterThan(t0 * 1.3);
    /* γ = 2 in two dimensions, so TA is the adiabatic invariant. It holds to
     * within the discs' own excluded area, which at this density is a few per
     * cent. */
    expect((t1 * a1) / (t0 * a0)).toBeGreaterThan(0.9);
    expect((t1 * a1) / (t0 * a0)).toBeLessThan(1.12);
    // And the energy went in through the wall, not from nowhere.
    expect(kineticEnergy(state) - e0).toBeCloseTo(state.wallWork, 6);
  });

  it('gets the Otto cycle’s efficiency from work over heat', () => {
    const cfg = EXAMPLES.find((e) => e.id === 'otto-cycle')!.build().thermodynamics;
    const result = traceCycle(
      cfg.cycle,
      { v: cfg.startVolume, t: cfg.startTemperature },
      cfg.moles,
      8.314462618,
      cfg.degreesOfFreedom,
      600,
    );
    expect(result.closed).toBe(true);
    /* η = 1 − r^(1−γ), with the compression ratio read off the cycle's own
     * first leg rather than written out again here: for r = 8 and γ = 7/5 that
     * is 56.47%. The tracer only ever integrates P dV and applies the first
     * law, so this is a closed form it has no access to. */
    const gamma = (cfg.degreesOfFreedom + 2) / cfg.degreesOfFreedom;
    const ratio = cfg.startVolume / cfg.cycle[0].target;
    expect(ratio).toBeCloseTo(8, 9);
    expect(result.efficiency).toBeCloseTo(1 - ratio ** (1 - gamma), 3);
    // No cycle can beat Carnot between the same two temperatures.
    const temps = result.legs.flatMap((l) => l.points.map((p) => p.t));
    expect(result.efficiency).toBeLessThan(carnotEfficiency(Math.min(...temps), Math.max(...temps)));
  });
});
