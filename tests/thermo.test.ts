import { describe, expect, it } from 'vitest';
import {
  BOLTZMANN,
  advanceGas,
  boxArea,
  carnotEfficiency,
  createGas,
  kineticEnergy,
  maxwellBoltzmann2D,
  measureIsotherm,
  measurePressure,
  speedHistogram,
  speedMoments,
  speeds,
  temperatureOf,
  traceCycle,
  type CycleLeg,
  type GasWorld,
} from '../src/core/physics/thermo';

/* Kinetic theory is a subject where a wrong simulation still looks completely
 * convincing: particles bounce, a histogram forms, a curve is drawn over it.
 * So nothing here is checked against what the code produced last time. Every
 * assertion is against something known independently — a conservation law, a
 * closed-form distribution, or the gas laws that the simulation is deliberately
 * never told about.
 *
 * Everything is two-dimensional, so the targets are the 2D ones: ⟨½mv²⟩ = kT
 * rather than (3/2)kT, a Rayleigh speed distribution rather than the 3D one,
 * and γ = 2 for a monatomic gas with two degrees of freedom.
 */

const world = (over: Partial<GasWorld> = {}): GasWorld => ({
  count: 200,
  width: 1,
  height: 1,
  radius: 0.015,
  mass: 1,
  temperature: 1,
  thermostat: 0,
  seed: 'thermo-test',
  gravity: 0,
  ...over,
});

const run = (state: ReturnType<typeof createGas>, duration: number, dt = 0.02) => {
  let t = 0;
  while (t < duration - 1e-12) {
    const step = Math.min(dt, duration - t);
    advanceGas(state, step);
    t += step;
  }
};

describe('the gas itself', () => {
  it('seeds particles inside the box and without net drift', () => {
    const state = createGas(world());
    expect(state.particles).toHaveLength(200);
    for (const p of state.particles) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1 - 0.015 + 1e-12);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1 - 0.015 + 1e-12);
    }
    // A box of gas that is also travelling sideways would read as hotter than
    // it is, so the seeding removes the drift.
    const px = state.particles.reduce((s, p) => s + p.vx, 0);
    const py = state.particles.reduce((s, p) => s + p.vy, 0);
    expect(Math.abs(px)).toBeLessThan(1e-9);
    expect(Math.abs(py)).toBeLessThan(1e-9);
  });

  it('starts no two discs overlapping', () => {
    const state = createGas(world({ count: 400, radius: 0.02 }));
    let worst = Infinity;
    for (let i = 0; i < state.particles.length; i++) {
      for (let j = i + 1; j < state.particles.length; j++) {
        const a = state.particles[i];
        const b = state.particles[j];
        worst = Math.min(worst, Math.hypot(b.x - a.x, b.y - a.y));
      }
    }
    // Two discs started inside each other fly apart at whatever speed the
    // overlap implies, which shows up later as a gas that heated itself.
    expect(worst).toBeGreaterThanOrEqual(0.04);
  });

  it('does not depend on the caller keeping the world object still', () => {
    const input = world();
    const state = createGas(input);
    state.wallVx = -0.1;
    advanceGas(state, 0.5);
    expect(state.world.width).toBeLessThan(1);
    expect(input.width).toBe(1);
  });

  it('reproduces exactly from its seed, and differs when the seed changes', () => {
    const a = createGas(world({ seed: 'alpha' }));
    const b = createGas(world({ seed: 'alpha' }));
    const c = createGas(world({ seed: 'beta' }));
    expect(a.particles[7].vx).toBe(b.particles[7].vx);
    expect(a.particles[7].vx).not.toBe(c.particles[7].vx);
  });

  it('measures the temperature it was seeded at', () => {
    // In two dimensions T = ⟨mv²⟩/2k, and 2000 particles is enough for the
    // sample mean to land within a couple of percent.
    const state = createGas(world({ count: 2000, temperature: 2.5, mass: 1.5 }));
    expect(temperatureOf(state)).toBeCloseTo(2.5, 1);
  });

  it('reads a temperature that scales with mass at fixed speed', () => {
    const light = createGas(world({ count: 1000, mass: 1, seed: 'm' }));
    const heavy = createGas(world({ count: 1000, mass: 1, seed: 'm' }));
    heavy.world.mass = 3;
    // Same velocities, three times the mass: three times the temperature.
    expect(temperatureOf(heavy) / temperatureOf(light)).toBeCloseTo(3, 9);
  });
});

describe('collisions', () => {
  it('conserves energy and momentum in a head-on pair', () => {
    const state = createGas(world({ count: 2, radius: 0.05 }));
    state.particles[0] = { x: -0.3, y: 0, vx: 0.7, vy: 0 };
    state.particles[1] = { x: 0.3, y: 0, vx: -0.2, vy: 0 };
    const e0 = kineticEnergy(state);
    const p0 = state.particles.reduce((s, p) => s + p.vx, 0);

    run(state, 1.0, 0.005);
    expect(state.collisions).toBeGreaterThan(0);
    expect(kineticEnergy(state)).toBeCloseTo(e0, 9);
    // Only wall hits can change the momentum, and over this window in a wide
    // box there are none, so the collision must have conserved it.
    expect(state.wallHits).toBe(0);
    expect(state.particles.reduce((s, p) => s + p.vx, 0)).toBeCloseTo(p0, 9);
  });

  it('swaps the velocities of equal discs meeting head-on', () => {
    const state = createGas(world({ count: 2, radius: 0.05 }));
    state.particles[0] = { x: -0.2, y: 0, vx: 0.5, vy: 0 };
    state.particles[1] = { x: 0.2, y: 0, vx: -0.5, vy: 0 };
    run(state, 0.6, 0.002);
    // The exact elastic result for equal masses along the line of centres.
    expect(state.particles[0].vx).toBeCloseTo(-0.5, 9);
    expect(state.particles[1].vx).toBeCloseTo(0.5, 9);
  });

  it('leaves a glancing pair with its energy intact', () => {
    const state = createGas(world({ count: 2, radius: 0.05 }));
    state.particles[0] = { x: -0.3, y: -0.04, vx: 0.6, vy: 0.1 };
    state.particles[1] = { x: 0.3, y: 0.04, vx: -0.6, vy: -0.1 };
    const e0 = kineticEnergy(state);
    run(state, 1.0, 0.002);
    expect(state.collisions).toBeGreaterThan(0);
    expect(kineticEnergy(state)).toBeCloseTo(e0, 9);
    // A glancing hit must deflect them, not just reverse them.
    expect(Math.abs(state.particles[0].vy)).not.toBeCloseTo(0.1, 3);
  });

  it('does not let a pair that is already separating collide again', () => {
    const state = createGas(world({ count: 2, radius: 0.05 }));
    // Overlapping and flying apart: a naive overlap test would "collide" them
    // and stick them together.
    state.particles[0] = { x: -0.02, y: 0, vx: -0.4, vy: 0 };
    state.particles[1] = { x: 0.02, y: 0, vx: 0.4, vy: 0 };
    advanceGas(state, 0.01);
    expect(state.collisions).toBe(0);
    expect(state.particles[0].vx).toBeCloseTo(-0.4, 9);
    expect(state.particles[1].vx).toBeCloseTo(0.4, 9);
  });

  it('conserves energy across a crowded box over a long run', () => {
    const state = createGas(world({ count: 400, radius: 0.02 }));
    const e0 = kineticEnergy(state);
    run(state, 4);
    expect(state.collisions).toBeGreaterThan(1000);
    // Elastic collisions and stationary walls: energy is exact, not merely
    // close. Anything drifting here means a collision is doing work.
    expect(kineticEnergy(state) / e0).toBeCloseTo(1, 9);
  });

  it('keeps every particle inside the box however long it runs', () => {
    const state = createGas(world({ count: 300, radius: 0.02, temperature: 4 }));
    run(state, 5);
    for (const p of state.particles) {
      expect(Math.abs(p.x)).toBeLessThan(1);
      expect(Math.abs(p.y)).toBeLessThan(1);
    }
  });
});

describe('the Maxwell–Boltzmann distribution', () => {
  it('is normalised', () => {
    let total = 0;
    const dv = 0.001;
    for (let v = dv / 2; v < 12; v += dv) total += maxwellBoltzmann2D(v, 1.3, 0.8) * dv;
    expect(total).toBeCloseTo(1, 4);
  });

  it('peaks at √(kT/m), which is the 2D result and not the 3D one', () => {
    const t = 1.7;
    const m = 0.9;
    const expected = Math.sqrt((BOLTZMANN * t) / m);
    let best = 0;
    let peak = 0;
    for (let v = 0; v < 6; v += 0.0005) {
      const f = maxwellBoltzmann2D(v, t, m);
      if (f > best) {
        best = f;
        peak = v;
      }
    }
    expect(peak).toBeCloseTo(expected, 3);
    // The 3D distribution peaks at √(2kT/m); using it here would be the
    // easiest way to make this mode quietly wrong.
    expect(peak).not.toBeCloseTo(Math.sqrt((2 * BOLTZMANN * t) / m), 2);
  });

  it('has the moments the analytic formulas claim', () => {
    const t = 2.2;
    const m = 1.4;
    const moments = speedMoments(t, m);
    const dv = 0.0005;
    let mean = 0;
    let square = 0;
    for (let v = dv / 2; v < 20; v += dv) {
      const f = maxwellBoltzmann2D(v, t, m) * dv;
      mean += v * f;
      square += v * v * f;
    }
    expect(mean).toBeCloseTo(moments.mean, 4);
    expect(Math.sqrt(square)).toBeCloseTo(moments.rms, 4);
    // And the rms speed is the one that reproduces the temperature.
    expect((m * square) / (2 * BOLTZMANN)).toBeCloseTo(t, 4);
    expect(moments.mode).toBeLessThan(moments.mean);
    expect(moments.mean).toBeLessThan(moments.rms);
  });

  it('emerges from a gas that started with every particle at the same speed', () => {
    // This is the demonstration the mode exists for, so it is worth testing
    // rather than trusting: nothing in the simulation knows what Maxwell–
    // Boltzmann is, and the histogram has to find it anyway.
    const w = world({ count: 900, radius: 0.02, width: 1.5, height: 1.5, temperature: 1 });
    const state = createGas(w, true);

    const start = speeds(state);
    const spread = Math.max(...start) - Math.min(...start);
    expect(spread).toBeLessThan(1e-9);

    const t = temperatureOf(state);

    /* The 2D Maxwell distribution is a Rayleigh, so its CDF is the closed form
     * 1 − exp(−mv²/2kT) and the largest gap between that and the empirical CDF
     * is a Kolmogorov–Smirnov statistic. That is a far better measure than the
     * histogram's own bar heights, which at 900 particles carry roughly 0.13
     * of sampling noise however well the gas has equilibrated — a threshold
     * below the noise floor would be a test that can only be passed by luck.
     */
    const ks = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const n = sorted.length;
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const model = 1 - Math.exp((-w.mass * sorted[i] * sorted[i]) / (2 * BOLTZMANN * t));
        worst = Math.max(worst, Math.abs(model - i / n), Math.abs((i + 1) / n - model));
      }
      return worst;
    };

    // Every particle at one speed is a step function: about as far from the
    // Rayleigh curve as a distribution can get.
    expect(ks(start)).toBeGreaterThan(0.55);

    run(state, 8);
    const settled = ks(speeds(state));
    // The 1% critical value for 900 independent samples is 1.63/√900 ≈ 0.054.
    expect(settled).toBeLessThan(0.06);

    // And the histogram the mode actually draws sits on the analytic curve to
    // within what a genuine sample of this size would manage: the reference is
    // 900 speeds drawn from the Rayleigh distribution directly.
    const top = 4 * Math.sqrt((BOLTZMANN * t) / w.mass);
    const bins = 40;
    const width = top / bins;
    const l1 = (values: number[]) => {
      const h = speedHistogram(values, bins, top);
      let total = 0;
      for (let i = 0; i < bins; i++) {
        const centre = (h.edges[i] + h.edges[i + 1]) / 2;
        total += Math.abs(h.density[i] - maxwellBoltzmann2D(centre, t, w.mass)) * width;
      }
      return total;
    };
    const sigma = Math.sqrt((BOLTZMANN * t) / w.mass);
    let seed = 12345;
    const uniform = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed % 1000000) / 1000000 || 1e-9;
    };
    const reference = Array.from({ length: state.particles.length }, () => sigma * Math.sqrt(-2 * Math.log(uniform())));
    expect(l1(speeds(state))).toBeLessThan(l1(reference) * 1.6);

    // The energy never moved, so the temperature the curve is drawn at is the
    // one it started with.
    expect(temperatureOf(state)).toBeCloseTo(t, 6);

    // And the sample moments land on the analytic ones.
    const moments = speedMoments(t, w.mass);
    const mean = speeds(state).reduce((s, v) => s + v, 0) / state.particles.length;
    expect(mean).toBeCloseTo(moments.mean, 1);
  });

  it('builds a histogram that integrates to one', () => {
    const values = [0.2, 0.4, 0.4, 0.9, 1.2, 1.25, 2.0];
    const h = speedHistogram(values, 10, 2.5);
    expect(h.edges).toHaveLength(11);
    expect(h.density).toHaveLength(10);
    const width = 2.5 / 10;
    const area = h.density.reduce((s, d) => s + d * width, 0);
    expect(area).toBeCloseTo(1, 9);
    // Two values fall in the 0.25–0.5 bin out of seven, so that bin's density
    // is (2/7)/0.25.
    expect(h.density[1]).toBeCloseTo(2 / 7 / width, 9);
  });

  it('drops values above the top of the range rather than piling them in the last bin', () => {
    const h = speedHistogram([0.5, 9], 4, 2);
    const area = h.density.reduce((s, d) => s + d * 0.5, 0);
    expect(area).toBeCloseTo(0.5, 9);
    expect(h.density[3]).toBe(0);
  });
});

describe('pressure and the ideal gas law', () => {
  it('matches the closed form for a single particle bouncing in a square box', () => {
    // One disc, moving only in x, in a square box. Each round trip covers
    // 2(w−r) and delivers 2m|vx| at each end, so the force on the x walls is
    // mvx²/(w−r) and the pressure is that over the perimeter. The ideal gas
    // law says NkT/A with T = mvx²/2k, and in a square box the two agree
    // exactly as r → 0.
    const w = world({ count: 1, radius: 0.001, width: 1, height: 1, mass: 2 });
    const state = createGas(w);
    state.particles[0] = { x: 0, y: 0, vx: 0.8, vy: 0 };

    const measured = measurePressure(state, 400, 0.01);
    const ideal = (BOLTZMANN * temperatureOf(state)) / boxArea(state);
    expect(measured / ideal).toBeCloseTo(1, 2);
  });

  it('measures PA = NkT for a dilute gas without being told the gas law', { timeout: 60_000 }, () => {
    const w = world({ count: 300, radius: 0.005, width: 1, height: 1, temperature: 1.5 });
    const state = createGas(w);
    run(state, 2);
    const measured = measurePressure(state, 20, 0.02);
    const ideal = (state.particles.length * BOLTZMANN * temperatureOf(state)) / boxArea(state);
    // Hard discs are not quite ideal — the excluded area pushes the pressure
    // up — but at an area fraction of 0.6% the correction is a bit over a
    // percent, and the shot noise over this window is about as big again.
    expect(measured / ideal).toBeGreaterThan(0.95);
    expect(measured / ideal).toBeLessThan(1.08);
  });

  it('doubles the pressure when the temperature doubles at fixed area', { timeout: 60_000 }, () => {
    const base = world({ count: 200, radius: 0.008, temperature: 1 });
    const cold = createGas(base);
    const hot = createGas({ ...base, temperature: 2 });
    run(cold, 2);
    run(hot, 2);
    const pc = measurePressure(cold, 15, 0.02);
    const ph = measurePressure(hot, 15, 0.02);
    expect(ph / pc).toBeGreaterThan(1.85);
    expect(ph / pc).toBeLessThan(2.15);
  });

  it('traces an isotherm whose pressure falls as one over the area', { timeout: 120_000 }, () => {
    const points = measureIsotherm(
      world({ count: 200, radius: 0.006, temperature: 1, thermostat: 2 }),
      [1, 1.25, 1.6],
      2,
      12,
    );
    expect(points).toHaveLength(3);
    for (const point of points) {
      expect(point.compressibility).toBeGreaterThan(0.9);
      expect(point.compressibility).toBeLessThan(1.15);
    }
    // P·A is the quantity that stays put along an isotherm, not P.
    const products = points.map((p) => p.pressure * p.area);
    expect(products[1] / products[0]).toBeGreaterThan(0.88);
    expect(products[1] / products[0]).toBeLessThan(1.12);
    expect(products[2] / products[0]).toBeGreaterThan(0.88);
    expect(products[2] / products[0]).toBeLessThan(1.12);
    // And the pressure genuinely falls as the box grows.
    expect(points[2].pressure).toBeLessThan(points[0].pressure);
  });

  it('reports a compressibility above one when the discs are large enough to notice', { timeout: 60_000 }, () => {
    const dilute = measureIsotherm(world({ count: 200, radius: 0.004, thermostat: 2 }), [1], 2, 10)[0];
    const dense = measureIsotherm(world({ count: 200, radius: 0.05, thermostat: 2 }), [1], 2, 10)[0];
    // The discs' own area is unavailable to the rest of them, so the gas
    // behaves as if the box were smaller and the pressure comes out high.
    expect(dense.compressibility).toBeGreaterThan(dilute.compressibility + 0.1);
  });
});

describe('the moving wall', () => {
  it('accounts for every joule it puts into the gas', () => {
    const state = createGas(world({ count: 200, radius: 0.015 }));
    const e0 = kineticEnergy(state);
    state.wallVx = -0.05;
    run(state, 4);
    state.wallVx = 0;
    run(state, 1);
    // The wall is the only thing that can change the energy — collisions are
    // elastic — so the bookkeeping has to close exactly.
    expect(kineticEnergy(state) - e0).toBeCloseTo(state.wallWork, 8);
    expect(state.wallWork).toBeGreaterThan(0);
  });

  it('takes energy back out again when the box expands', () => {
    const state = createGas(world({ count: 200, radius: 0.015 }));
    state.wallVx = 0.05;
    run(state, 4);
    expect(state.wallWork).toBeLessThan(0);
    expect(temperatureOf(state)).toBeLessThan(1);
  });

  it('heats a slowly compressed gas by the adiabatic amount', () => {
    /* Two degrees of freedom means γ = 2, so for an *ideal* gas TV^(γ−1) = TA
     * would be the invariant. These are hard discs, so it is not quite: each
     * disc denies the others an area b = 2πr², and the quantity actually
     * conserved is T(A − Nb). At this density that correction is worth 8.6%
     * over the compression below — small enough to look like sloppiness if you
     * assert TA and set a loose bound, which is exactly what this test used to
     * do. Asserting the corrected invariant instead makes the bound twenty
     * times tighter and says something true.
     *
     * Nothing in the simulation has been told any of this. The heating comes
     * entirely from discs bouncing off a wall that is moving towards them. */
    const w = world({ count: 300, radius: 0.012, width: 1, height: 1, temperature: 1 });
    const excluded = w.count * 2 * Math.PI * w.radius * w.radius;
    const state = createGas(w);
    run(state, 3);
    const t0 = temperatureOf(state);
    const a0 = boxArea(state);

    // Slow compared with the collision rate, so the gas stays thermalised and
    // the two directions keep sharing the energy.
    state.wallVx = -0.02;
    state.wallVy = -0.02;
    run(state, 15);
    state.wallVx = 0;
    state.wallVy = 0;
    run(state, 2);

    const t1 = temperatureOf(state);
    const a1 = boxArea(state);
    expect(a1).toBeLessThan(a0 * 0.6);

    const invariant = (t1 * (a1 - excluded)) / (t0 * (a0 - excluded));
    expect(invariant).toBeGreaterThan(0.985);
    expect(invariant).toBeLessThan(1.02);

    // And the excluded area is not a fudge to make the numbers fit: without it
    // the invariant is measurably, repeatably wrong in one direction.
    expect((t1 * a1) / (t0 * a0)).toBeGreaterThan(1.05);
  });

  it('shares the work between both directions when only one wall moves', () => {
    /* The test this replaces squeezed both axes equally and checked that the
     * gas stayed isotropic. That could never fail: under an equal squeeze the
     * two directions heat equally whether the particles collide or not, so it
     * asserted nothing — and its bound sat below the sampling noise of the
     * ratio it measured, so it failed by chance instead.
     *
     * Moving one wall only is the case that discriminates. Collisions have to
     * carry the work the piston does in x into the y motion as well:
     *
     *   thermalised     T(A − Nb) is conserved, so T rises by (A₀−Nb)/(A₁−Nb)
     *   no sharing      only vx grows, T → (1/λ² + 1)/2 with λ the area ratio
     *
     * Those differ by about 8% here, and the measurement is repeatable to a
     * few tenths of a per cent, because temperature is fixed by the energy the
     * wall put in rather than by which particles happen to be fast.
     */
    const w = world({ count: 500, radius: 0.012, width: 1, height: 1, temperature: 1 });
    const excluded = w.count * 2 * Math.PI * w.radius * w.radius;
    const state = createGas(w);
    run(state, 2);
    const t0 = temperatureOf(state);
    const a0 = boxArea(state);

    state.wallVx = -0.04;
    run(state, 12);
    state.wallVx = 0;
    run(state, 1);

    const t1 = temperatureOf(state);
    const a1 = boxArea(state);
    const lambda = a1 / a0;
    expect(lambda).toBeLessThan(0.6);

    const thermalised = (a0 - excluded) / (a1 - excluded);
    const noSharing = (1 / (lambda * lambda) + 1) / 2;
    // The two predictions have to be far enough apart for this to be a test.
    expect(noSharing / thermalised).toBeGreaterThan(1.05);

    expect(t1 / t0).toBeCloseTo(thermalised, 1);
    expect(t1 / t0).toBeLessThan(noSharing * 0.96);
    expect((t1 * (a1 - excluded)) / (t0 * (a0 - excluded))).toBeCloseTo(1, 2);

    /* And the gas is left isotropic. This one is a weak check by nature: the
     * ratio of the two directions' energies over five hundred particles has a
     * standard deviation of about 10%, so the bound is set at four of those
     * rather than at what one run happened to produce. */
    let sx = 0;
    let sy = 0;
    for (const p of state.particles) {
      sx += p.vx * p.vx;
      sy += p.vy * p.vy;
    }
    expect(sx / sy).toBeGreaterThan(0.6);
    expect(sx / sy).toBeLessThan(1.45);
  });
});

describe('the thermostat', () => {
  it('pulls a cold gas up to the set temperature and holds it', () => {
    const state = createGas(world({ count: 300, radius: 0.012, temperature: 1 }));
    state.world.temperature = 3;
    state.world.thermostat = 2;
    run(state, 6);
    expect(temperatureOf(state)).toBeCloseTo(3, 1);
  });

  it('leaves an insulated box alone', () => {
    const state = createGas(world({ count: 200, radius: 0.012, thermostat: 0 }));
    const t0 = temperatureOf(state);
    run(state, 3);
    expect(temperatureOf(state)).toBeCloseTo(t0, 9);
  });
});

describe('gravity', () => {
  it('settles the gas towards the floor', () => {
    const flat = createGas(world({ count: 400, radius: 0.012, gravity: 0 }));
    const heavy = createGas(world({ count: 400, radius: 0.012, gravity: 3, thermostat: 1 }));
    run(flat, 4);
    run(heavy, 4);
    const mean = (s: typeof flat) => s.particles.reduce((t, p) => t + p.y, 0) / s.particles.length;
    // The barometric distribution: density falls off with height, so the mean
    // height sits below the middle of the box.
    expect(mean(heavy)).toBeLessThan(mean(flat) - 0.1);
  });
});

// ------------------------------------------------------------------- cycles

const leg = (kind: CycleLeg['kind'], target: number, label = ''): CycleLeg => ({
  id: `${kind}-${target}`,
  kind,
  target,
  label,
});

describe('PV cycles', () => {
  const R = 8.314462618;

  it('gets the isothermal work right', () => {
    // ∫P dV at constant T is nRT ln(V₂/V₁), a closed form the tracer never
    // sees — it integrates the sampled path by trapezium.
    const result = traceCycle([leg('isothermal', 2)], { v: 1, t: 300 }, 1, R, 2, 400);
    expect(result.legs[0].work).toBeCloseTo(R * 300 * Math.log(2), 1);
    // No temperature change, so no internal energy change, so heat in equals
    // work out.
    expect(result.legs[0].deltaU).toBeCloseTo(0, 9);
    expect(result.legs[0].heat).toBeCloseTo(result.legs[0].work, 9);
  });

  it('gets the isobaric work right', () => {
    const result = traceCycle([leg('isobaric', 3)], { v: 1, t: 300 }, 1, R, 3, 200);
    const p = (1 * R * 300) / 1;
    expect(result.legs[0].work).toBeCloseTo(p * (3 - 1), 6);
    // Constant pressure with V tripling means T triples too.
    const last = result.legs[0].points[result.legs[0].points.length - 1];
    expect(last.t).toBeCloseTo(900, 6);
    expect(last.p).toBeCloseTo(p, 6);
  });

  it('does no work on an isochoric leg', () => {
    const result = traceCycle([leg('isochoric', 1247.169)], { v: 1, t: 300 }, 1, R, 3, 100);
    expect(result.legs[0].work).toBeCloseTo(0, 9);
    // All the heat goes into internal energy: Q = Cv ΔT.
    const cv = (3 / 2) * R;
    expect(result.legs[0].heat).toBeCloseTo(cv * (result.legs[0].points[100].t - 300), 6);
  });

  it('follows TV^(γ−1) on an adiabatic leg and exchanges no heat', () => {
    const f = 3;
    const gamma = (f + 2) / f;
    const result = traceCycle([leg('adiabatic', 0.5)], { v: 1, t: 300 }, 1, R, f, 200);
    const last = result.legs[0].points[result.legs[0].points.length - 1];
    expect(last.t).toBeCloseTo(300 * 2 ** (gamma - 1), 6);
    // "Adiabatic" means exactly this: the heat is zero, which here comes out
    // of the first law rather than being asserted.
    expect(Math.abs(result.legs[0].heat)).toBeLessThan(1e-3 * Math.abs(result.legs[0].work));
    // A relative comparison, because these are numbers in the thousands and
    // the trapezium rule leaves a few parts per million on a curved path.
    expect(result.legs[0].work / -result.legs[0].deltaU).toBeCloseTo(1, 4);
    // And PV^γ is constant along it.
    const first = result.legs[0].points[0];
    expect((last.p * last.v ** gamma) / (first.p * first.v ** gamma)).toBeCloseTo(1, 6);
  });

  it('reaches Carnot efficiency on a Carnot cycle without being told the formula', () => {
    const f = 3;
    const gamma = (f + 2) / f;
    const th = 500;
    const tc = 300;
    const v1 = 1;
    const v2 = 2;
    // The two adiabats have to land on the same compression ratio for the
    // cycle to close, which fixes v3 and v4.
    const ratio = (th / tc) ** (1 / (gamma - 1));
    const v3 = v2 * ratio;
    const v4 = v1 * ratio;

    const result = traceCycle(
      [leg('isothermal', v2), leg('adiabatic', v3), leg('isothermal', v4), leg('adiabatic', v1)],
      { v: v1, t: th },
      1,
      R,
      f,
      600,
    );

    expect(result.closed).toBe(true);
    expect(result.efficiency).toBeCloseTo(carnotEfficiency(tc, th), 3);
    expect(result.efficiency).toBeCloseTo(1 - 300 / 500, 3);
    // A closed cycle returns the internal energy to where it started, so the
    // net heat must equal the net work.
    const netHeat = result.legs.reduce((s, l) => s + l.heat, 0);
    expect(netHeat).toBeCloseTo(result.netWork, 6);
    expect(result.netWork).toBeGreaterThan(0);
  });

  it('runs the Carnot cycle backwards as a heat pump', () => {
    const f = 3;
    const gamma = (f + 2) / f;
    const th = 500;
    const tc = 300;
    const ratio = (th / tc) ** (1 / (gamma - 1));
    const v1 = 1;
    const v2 = 2;
    const v3 = v2 * ratio;
    const v4 = v1 * ratio;

    const forward = traceCycle(
      [leg('isothermal', v2), leg('adiabatic', v3), leg('isothermal', v4), leg('adiabatic', v1)],
      { v: v1, t: th },
      1,
      R,
      f,
      600,
    );
    const reverse = traceCycle(
      [leg('adiabatic', v4), leg('isothermal', v3), leg('adiabatic', v2), leg('isothermal', v1)],
      { v: v1, t: th },
      1,
      R,
      f,
      600,
    );
    expect(reverse.closed).toBe(true);
    // The same loop the other way round: the same area, work put in rather
    // than taken out.
    expect(reverse.netWork).toBeCloseTo(-forward.netWork, 6);
  });

  it('gets the Otto cycle efficiency right', () => {
    // η = 1 − r^(1−γ) for compression ratio r, another closed form the tracer
    // has no access to.
    const f = 5;
    const gamma = (f + 2) / f;
    const r = 8;
    const v1 = 1;
    const v2 = v1 / r;
    const t1 = 300;
    const t2 = t1 * r ** (gamma - 1);
    const t3 = 3 * t2;
    const p3 = (1 * R * t3) / v2;
    const t4 = t3 / r ** (gamma - 1);
    const p1 = (1 * R * t1) / v1;

    const result = traceCycle(
      [leg('adiabatic', v2), leg('isochoric', p3), leg('adiabatic', v1), leg('isochoric', p1)],
      { v: v1, t: t1 },
      1,
      R,
      f,
      400,
    );
    expect(result.closed).toBe(true);
    expect(result.efficiency).toBeCloseTo(1 - r ** (1 - gamma), 3);
    expect(t4).toBeGreaterThan(t1);
  });

  it('says so when a path is not a cycle', () => {
    const result = traceCycle([leg('isothermal', 2)], { v: 1, t: 300 }, 1, R, 3, 50);
    expect(result.closed).toBe(false);
    expect(result.message).toContain('not a cycle');
  });

  it('refuses a leg that asks for an impossible state', () => {
    const result = traceCycle([leg('isothermal', -1)], { v: 1, t: 300 }, 1, R, 3, 50);
    expect(result.legs).toHaveLength(0);
    expect(result.message).toContain('below zero');
  });

  it('gives Carnot efficiency zero when the reservoirs are at the same temperature', () => {
    expect(carnotEfficiency(400, 400)).toBe(0);
    expect(carnotEfficiency(0, 400)).toBe(1);
    expect(carnotEfficiency(300, 0)).toBe(0);
  });
});
