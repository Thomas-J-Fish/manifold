import { describe, expect, it } from 'vitest';
import {
  HBAR,
  KINETIC,
  advanceWave,
  boxLevels,
  createWaveTrajectory,
  makePacket,
  rectangularTransmission,
  samplePotential,
  scatterCurve,
  solveBoundStates,
  solvePlaneStates,
  transmission,
  type PotentialFeature,
  type QuantumWorld,
} from '../src/core/physics/quantum';

/* Quantum mechanics is unusually well supplied with exact answers, so there is
 * no excuse for testing this against anything else. Every number below is a
 * closed form, a transcendental root solved independently here in the test, or
 * a conservation law — never a value the solver once produced.
 */

let counter = 0;
function feature(kind: PotentialFeature['kind'], centre: number, width: number, height: number): PotentialFeature {
  counter += 1;
  return { id: `f${counter}`, kind, centre, width, height };
}

function world(over: Partial<QuantumWorld> = {}): QuantumWorld {
  return {
    view: 'bound',
    xMin: -5,
    xMax: 5,
    points: 600,
    mass: 1,
    features: [],
    expression: '',
    levels: 8,
    packet: { centre: -3, width: 0.4, momentum: 10 },
    duration: 5,
    absorbing: false,
    scatterMin: 0.05,
    scatterMax: 5,
    plane: { shape: 'box', size: 1, depth: 50, aspect: 1, points: 48, levels: 6 },
    ...over,
  };
}

describe('the particle in a box', () => {
  it('reproduces n²π²ħ²/2mL²', () => {
    // The grid's walls are the box, so an empty potential is the textbook one.
    const L = 2;
    const states = solveBoundStates(world({ xMin: 0, xMax: L, features: [], levels: 6, points: 800 }));
    for (let n = 1; n <= 6; n++) {
      const exact = (KINETIC * n * n * Math.PI * Math.PI) / (L * L);
      expect(states.energies[n - 1] / exact).toBeCloseTo(1, 4);
    }
  });

  it('matches the discretised eigenvalue to rounding, not just to the continuum', () => {
    /* A three-point stencil has its own exact spectrum,
     *   Eₙ = (4c/h²) sin²(nπ/2(N+1)),
     * and agreement with *that* separates an error in the eigensolver from the
     * O(h²) truncation of the derivative, which is not an error at all. */
    const points = 200;
    const L = 1;
    const states = solveBoundStates(world({ xMin: 0, xMax: L, points, levels: 5 }));
    const h = L / (points + 1);
    for (let n = 1; n <= 5; n++) {
      const discrete = ((4 * KINETIC) / (h * h)) * Math.sin((n * Math.PI) / (2 * (points + 1))) ** 2;
      expect(states.energies[n - 1]).toBeCloseTo(discrete, 9);
    }
  });

  it('normalises its states and keeps them orthogonal', () => {
    const states = solveBoundStates(world({ xMin: 0, xMax: 2, levels: 5, points: 400 }));
    const { n, dx, psi } = states;
    for (let a = 0; a < 5; a++) {
      for (let b = 0; b < 5; b++) {
        let overlap = 0;
        for (let i = 0; i < n; i++) overlap += psi[a * n + i] * psi[b * n + i];
        expect(overlap * dx).toBeCloseTo(a === b ? 1 : 0, 8);
      }
    }
  });

  it('gives the nth state n−1 nodes', () => {
    const states = solveBoundStates(world({ xMin: 0, xMax: 2, levels: 5, points: 600 }));
    for (let s = 0; s < 5; s++) {
      let crossings = 0;
      for (let i = 1; i < states.n; i++) {
        const a = states.psi[s * states.n + i - 1];
        const b = states.psi[s * states.n + i];
        // Ignore the exponentially small tails, which cross zero on rounding.
        if (Math.abs(a) > 1e-6 && Math.abs(b) > 1e-6 && a * b < 0) crossings++;
      }
      expect(crossings).toBe(s);
    }
  });
});

describe('the harmonic oscillator', () => {
  // V = H(x/(W/2))² is ½kx² with k = 8H/W². Then ħω = √(2·(ħ²/2m)·k).
  const H = 1;
  const W = 2;
  const k = (8 * H) / (W * W);
  const hbarOmega = Math.sqrt(2 * KINETIC * k);

  it('gives the ladder (n + ½)ħω, evenly spaced', () => {
    const states = solveBoundStates(
      world({ xMin: -6, xMax: 6, points: 900, levels: 6, features: [feature('harmonic', 0, W, H)] }),
    );
    for (let n = 0; n < 6; n++) {
      expect(states.energies[n] / ((n + 0.5) * hbarOmega)).toBeCloseTo(1, 3);
    }
    for (let n = 1; n < 6; n++) {
      expect(states.energies[n] - states.energies[n - 1]).toBeCloseTo(hbarOmega, 3);
    }
  });

  it('puts the ground state at the width the uncertainty principle demands', () => {
    // σ = √(ħ/2mω), which in these units is √(ħ²/2m / ½ħω) / √2 … more simply
    // σ² = (ħ²/2m)/(½ħω) ÷ 2 = KINETIC/ħω.
    const states = solveBoundStates(
      world({ xMin: -6, xMax: 6, points: 900, levels: 1, features: [feature('harmonic', 0, W, H)] }),
    );
    let mean = 0;
    let square = 0;
    for (let i = 0; i < states.n; i++) {
      const density = states.psi[i] * states.psi[i];
      mean += density * states.x[i];
      square += density * states.x[i] * states.x[i];
    }
    const sigma = Math.sqrt(square * states.dx - (mean * states.dx) ** 2);
    expect(sigma).toBeCloseTo(Math.sqrt(KINETIC / hbarOmega), 3);
  });
});

describe('the finite well', () => {
  const depth = 5;
  const width = 1;

  /** Even and odd roots of the symmetric well, found here by bisection. */
  function transcendentalLevels(): number[] {
    const a = width / 2;
    const out: number[] = [];
    const even = (E: number) => {
      const k = Math.sqrt((E + depth) / KINETIC);
      const kappa = Math.sqrt(-E / KINETIC);
      return k * Math.tan(k * a) - kappa;
    };
    const odd = (E: number) => {
      const k = Math.sqrt((E + depth) / KINETIC);
      const kappa = Math.sqrt(-E / KINETIC);
      return k / Math.tan(k * a) + kappa;
    };
    for (const f of [even, odd]) {
      // Sweep finely and bisect each sign change that is not a pole.
      const steps = 4000;
      let previous = f(-depth + 1e-9);
      for (let i = 1; i <= steps; i++) {
        const E = -depth + 1e-9 + ((depth - 2e-9) * i) / steps;
        const value = f(E);
        if (Number.isFinite(previous) && Number.isFinite(value) && previous * value < 0 && Math.abs(value - previous) < 50) {
          let lo = -depth + 1e-9 + ((depth - 2e-9) * (i - 1)) / steps;
          let hi = E;
          for (let it = 0; it < 200; it++) {
            const mid = (lo + hi) / 2;
            if (f(lo) * f(mid) <= 0) hi = mid;
            else lo = mid;
          }
          out.push((lo + hi) / 2);
        }
        previous = value;
      }
    }
    return out.sort((p, q) => p - q);
  }

  /** A domain on which the well's edges fall midway between samples. */
  function aligned(dx: number) {
    const edge = width / 2;
    const k = Math.round((edge + 6) / dx - 0.5);
    const lo = edge - dx * (k + 0.5);
    const points = Math.round(12 / dx) - 1;
    return world({
      xMin: lo,
      xMax: lo + dx * (points + 1),
      points,
      levels: 8,
      features: [feature('well', 0, width, depth)],
    });
  }

  it('finds exactly the levels the transcendental equations have', () => {
    const roots = transcendentalLevels();
    // ⌈(a/π)√(V₀/(ħ²/2m))⌉ bound states — four, for this well.
    expect(roots).toHaveLength(Math.ceil((width / Math.PI) * Math.sqrt(depth / KINETIC)));

    /* The domain is aligned on purpose. The well's edges have to fall
     * *between* grid points for the simulated well to be exactly one nanometre
     * wide; land them on points instead and the width is out by up to one
     * spacing, which moves the ground state by nearly a per cent and looks
     * exactly like solver error. */
    const states = solveBoundStates(aligned(0.02));
    expect(states.bound).toBe(roots.length);
    /* Judged against the depth of the well rather than against each level.
     * The topmost bound state sits a tenth of an electronvolt below the rim,
     * so a thousandth of an electronvolt is a fraction of a per cent of the
     * physics and several per cent of that one number — dividing by it would
     * be measuring how close to escaping the state is, not how good the
     * solver is. Twenty millielectronvolts on a five-electronvolt well is
     * the three-point stencil's truncation at this spacing, and the test below
     * shows it falling away as the square of it. */
    roots.forEach((E, i) => {
      expect(Math.abs(states.energies[i] - E)).toBeLessThan(depth * 4e-3);
    });
  });

  it('converges on those levels at second order in the grid spacing', () => {
    // What is left after the alignment above is the three-point stencil's own
    // truncation, which is O(h²) — halve the spacing and the error quarters.
    const roots = transcendentalLevels();
    const errorAt = (dx: number) => {
      const states = solveBoundStates(aligned(dx));
      return Math.abs(states.energies[0] / roots[0] - 1);
    };
    const coarse = errorAt(0.04);
    const fine = errorAt(0.02);
    expect(fine).toBeLessThan(coarse / 3.5);
  });

  it('does not mistake the box\'s own standing waves for bound states', () => {
    const states = solveBoundStates(
      world({ xMin: -6, xMax: 6, points: 800, levels: 8, features: [feature('well', 0, width, depth)] }),
    );
    // Everything past `bound` sits above the potential at the walls, so it is
    // held in by the simulation's box rather than by the physics.
    for (let s = states.bound; s < states.energies.length; s++) {
      expect(states.energies[s]).toBeGreaterThan(0);
    }
    for (let s = 0; s < states.bound; s++) {
      expect(states.energies[s]).toBeLessThan(0);
    }
  });
});

describe('a wavepacket', () => {
  const free = world({
    view: 'evolve',
    xMin: -20,
    xMax: 20,
    points: 700,
    features: [],
    packet: { centre: -5, width: 1, momentum: 6 },
    duration: 8,
  });

  it('conserves probability, because Crank–Nicolson is unitary', () => {
    const traj = createWaveTrajectory(free);
    advanceWave(traj, free.duration, 500000);
    expect(traj.count).toBeGreaterThan(50);
    for (let k = 0; k < traj.count; k++) expect(traj.norm[k]).toBeCloseTo(1, 9);
  });

  it('conserves energy', () => {
    const traj = createWaveTrajectory(free);
    advanceWave(traj, free.duration, 500000);
    for (let k = 1; k < traj.count; k++) {
      expect(traj.energy[k] / traj.energy[0]).toBeCloseTo(1, 6);
    }
  });

  it('travels at the group velocity of the lattice it is on', () => {
    /* A grid has its own dispersion relation, E(k) = (2c/h²)(1 − cos kh), and
     * the packet obeys that one rather than ħ²k²/2m — it runs about two per
     * cent slow here. Asserting the continuum answer would be asserting
     * something the simulation is not doing; the convergence test below is
     * what shows the difference is the grid and not a mistake. */
    const traj = createWaveTrajectory(free);
    advanceWave(traj, free.duration, 500000);
    const k = free.packet.momentum;
    const h = traj.dx;
    const lattice = (2 * KINETIC * Math.sin(k * h)) / (HBAR * h);
    const last = traj.count - 1;
    expect(traj.meanX[last]).toBeCloseTo(free.packet.centre + lattice * traj.time[last], 2);
  });

  it('approaches ħk/m as the grid is refined', () => {
    const k = free.packet.momentum;
    const exact = (2 * KINETIC * k) / HBAR;
    const speedAt = (points: number) => {
      const w = { ...free, points };
      const traj = createWaveTrajectory(w);
      advanceWave(traj, 4, 500000);
      const last = traj.count - 1;
      return (traj.meanX[last] - w.packet.centre) / traj.time[last];
    };
    const coarse = Math.abs(speedAt(400) / exact - 1);
    const fine = Math.abs(speedAt(1600) / exact - 1);
    expect(coarse).toBeLessThan(0.07);
    // Second order in the spacing: four times the points, a sixteenth the error.
    expect(fine).toBeLessThan(coarse / 8);
  });

  it('spreads at exactly the rate free-particle dispersion says', () => {
    // Stationary, so every wavenumber in the packet is small and the grid's
    // dispersion is indistinguishable from the continuum's.
    const still = { ...free, packet: { centre: 0, width: 1, momentum: 0 } };
    const traj = createWaveTrajectory(still);
    advanceWave(traj, still.duration, 500000);
    const sigma0 = still.packet.width;
    const last = traj.count - 1;
    const t = traj.time[last];
    // σ(t) = σ₀√(1 + (ħt/2mσ₀²)²), and ħ/2m = (ħ²/2m)/ħ.
    const expected = sigma0 * Math.sqrt(1 + ((KINETIC * t) / (HBAR * sigma0 * sigma0)) ** 2);
    expect(traj.spread[last] / expected).toBeCloseTo(1, 2);
  });

  it('starts as a normalised Gaussian of the requested width', () => {
    const { x, dx } = samplePotential(free);
    const { re, im } = makePacket(x, dx, 0, 0.5, 3);
    let total = 0;
    let square = 0;
    for (let i = 0; i < x.length; i++) {
      const density = re[i] * re[i] + im[i] * im[i];
      total += density;
      square += density * x[i] * x[i];
    }
    expect(total * dx).toBeCloseTo(1, 10);
    expect(Math.sqrt(square * dx)).toBeCloseTo(0.5, 3);
  });

  it('loses probability to an absorbing edge, and only there', () => {
    // 0.69 nm/fs from x = −5 to the absorbing skin at x = 16: about 30 fs to
    // arrive, so 60 gives it time to leave.
    const soaked = { ...free, absorbing: true, duration: 60 };
    const traj = createWaveTrajectory(soaked);
    advanceWave(traj, soaked.duration, 2000000);
    // It starts intact and leaves.
    expect(traj.norm[0]).toBeCloseTo(1, 9);
    expect(traj.norm[traj.count - 1]).toBeLessThan(0.2);
    // Monotonically: an absorber removes probability and never adds any.
    for (let k = 1; k < traj.count; k++) expect(traj.norm[k]).toBeLessThanOrEqual(traj.norm[k - 1] + 1e-9);
  });
});

describe('tunnelling', () => {
  const barrier = (height: number, width: number) =>
    world({
      view: 'scatter',
      xMin: -4,
      xMax: 4,
      points: 1600,
      features: [feature('barrier', 0, width, height)],
      scatterMin: 0.1,
      scatterMax: 8,
    });

  it('agrees with the closed form for a rectangular barrier', () => {
    const w = barrier(4, 0.6);
    for (const E of [0.5, 1, 2, 3.5, 4, 5, 6.5, 8]) {
      const exact = rectangularTransmission(E, 4, 0.6, 1);
      expect(transmission(w, E)).toBeCloseTo(exact, 3);
    }
  });

  it('is exponentially small well below the barrier and approaches one above it', () => {
    const w = barrier(5, 1);
    expect(transmission(w, 0.5)).toBeLessThan(1e-4);
    expect(transmission(w, 20)).toBeGreaterThan(0.95);
    // And monotonically increasing through the classically forbidden region.
    let previous = 0;
    for (let E = 0.2; E < 5; E += 0.2) {
      const t = transmission(w, E);
      expect(t).toBeGreaterThan(previous);
      previous = t;
    }
  });

  it('is perfectly transparent at the resonances of a well', () => {
    /* A square well transmits everything when ka = nπ across it — the two
     * reflections cancel. This is the Ramsauer–Townsend effect, and it is the
     * clearest thing in the whole mode: a well that is *harder* to cross at
     * some energies than others. */
    const depth = 3;
    const width = 1.2;
    const w = world({
      xMin: -4,
      xMax: 4,
      points: 1600,
      features: [feature('well', 0, width, depth)],
    });
    for (const n of [1, 2, 3]) {
      const inside = (n * Math.PI) / width;
      const E = KINETIC * inside * inside - depth;
      if (E <= 0) continue;
      expect(transmission(w, E)).toBeCloseTo(1, 3);
    }
  });

  it('offers the closed form beside the curve only when one applies', () => {
    const single = scatterCurve(barrier(4, 0.6), 40);
    expect(single.analytic).not.toBeNull();
    single.energy.forEach((E, i) => {
      // Across every energy, not just the convenient ones: the barrier's edges
      // are quantised to the grid, so agreement is to a part in a hundred.
      expect(single.transmitted[i]).toBeCloseTo(single.analytic![i], 2);
      expect(E).toBeGreaterThan(0);
    });

    const double = scatterCurve(
      world({ features: [feature('barrier', -0.5, 0.3, 4), feature('barrier', 0.5, 0.3, 4)] }),
      20,
    );
    expect(double.analytic).toBeNull();
  });

  it('lets a wavepacket tunnel by the amount the scattering solver predicts', () => {
    /* Two entirely separate calculations — a transfer matrix in energy and a
     * Crank–Nicolson evolution in time — have to agree. A wide packet is
     * narrow in momentum, so its transmitted fraction should be the
     * transmission at its own energy. */
    const height = 3;
    const width = 0.4;
    const momentum = 7;
    const w = world({
      view: 'evolve',
      xMin: -30,
      xMax: 30,
      points: 1500,
      features: [feature('barrier', 0, width, height)],
      packet: { centre: -8, width: 2.5, momentum },
      duration: 14,
      absorbing: false,
    });
    const traj = createWaveTrajectory(w);
    advanceWave(traj, w.duration, 4000000);

    const energy = KINETIC * momentum * momentum;
    const predicted = rectangularTransmission(energy, height, width, 1);
    const last = traj.count - 1;
    expect(traj.right[last]).toBeCloseTo(predicted, 1);
    expect(traj.left[last] + traj.right[last]).toBeCloseTo(1, 6);
  });
});

describe('two dimensions', () => {
  it('reproduces the levels of a rectangular box', () => {
    const w = world({ plane: { shape: 'box', size: 1, depth: 0, aspect: 1.5, points: 70, levels: 6 } });
    const states = solvePlaneStates(w);
    const exact = boxLevels(2 * 1, (2 * 1) / 1.5, 1, 6);
    for (let s = 0; s < 6; s++) {
      // Grid-limited now that the problem is separated, not method-limited.
      expect(Math.abs(states.energies[s] / exact[s] - 1)).toBeLessThan(0.005);
    }
  });

  it('finds the degeneracies a square box has', () => {
    const w = world({ plane: { shape: 'box', size: 1, depth: 0, aspect: 1, points: 70, levels: 6 } });
    const states = solvePlaneStates(w);
    /* Exactly equal, not nearly. (1,2) and (2,1) are built from the same two
     * numbers on the same one-dimensional ladder, so separating the problem
     * makes the degeneracy identical rather than merely close — which is what
     * a student is being shown. The Lanczos version this replaced split these
     * two levels by forty per cent. */
    expect(states.energies[2] - states.energies[1]).toBeLessThan(1e-12);
    expect(states.energies[1] / states.energies[0]).toBeCloseTo(2.5, 2);
    expect(states.labels[1]).not.toBe(states.labels[2]);
  });

  it('reproduces the Bessel zeros of a circular well', () => {
    /* The circular problem is not separable in x and y, but it is in r and φ,
     * and the radial equation is another one-dimensional tridiagonal problem.
     * Its levels are (ħ²/2m)(jₘₙ/R)² with jₘₙ the zeros of the Bessel
     * functions — numbers with nothing to do with this code at all. */
    const R = 1;
    const w = world({ plane: { shape: 'circle', size: R, depth: 500, aspect: 1, points: 120, levels: 5 } });
    const states = solvePlaneStates(w);
    const zeros = [2.404826, 3.831706, 5.135622, 5.520078, 6.380162];
    zeros.forEach((j, i) => {
      const exact = KINETIC * (j / R) ** 2;
      expect(states.energies[i] / exact).toBeCloseTo(1, 1);
      // A few per cent: the circle's edge is a step between radial cells, and
      // the well is 500 eV deep rather than infinite, so the state leaks a
      // little way past r = R.
      expect(Math.abs(states.energies[i] / exact - 1)).toBeLessThan(0.03);
    });
    // m ≥ 1 comes in pairs; the label should say so rather than list it twice.
    expect(states.labels[0]).toContain('m = 0');
    expect(states.labels[1]).toContain('×2');
  });

  it('gives the isotropic oscillator ħω(n+1) with degeneracy n+1', () => {
    const size = 2;
    const depth = 4;
    const w = world({
      plane: { shape: 'harmonic', size, depth, aspect: 1, points: 80, levels: 6 },
      xMin: -4,
      xMax: 4,
    });
    const states = solvePlaneStates(w);
    // V = depth·(x² + y²)/size², so ½k = depth/size² and ħω = √(2·KINETIC·k).
    const k = (2 * depth) / (size * size);
    const hbarOmega = Math.sqrt(2 * KINETIC * k);
    expect(states.energies[0] / hbarOmega).toBeCloseTo(1, 2);
    expect(states.energies[1] / (2 * hbarOmega)).toBeCloseTo(1, 2);
    expect(states.energies[2] / (2 * hbarOmega)).toBeCloseTo(1, 2);
    expect(states.energies[3] / (3 * hbarOmega)).toBeCloseTo(1, 2);
  });

  it('normalises its states', () => {
    const w = world({ plane: { shape: 'box', size: 1, depth: 0, aspect: 1, points: 50, levels: 3 } });
    const states = solvePlaneStates(w);
    const size = states.nx * states.ny;
    for (let s = 0; s < states.count; s++) {
      let sum = 0;
      for (let i = 0; i < size; i++) sum += states.psi[s * size + i] ** 2;
      expect(sum * states.dx * states.dy).toBeCloseTo(1, 6);
    }
  });
});
