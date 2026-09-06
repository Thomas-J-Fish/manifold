import { describe, expect, it } from 'vitest';
import {
  GAS_CONSTANT,
  arrhenius,
  buildNetwork,
  equilibriumConstant,
  parseReaction,
  reactionQuotient,
  runKinetics,
  steepestPoint,
  titrationCurve,
  type Reaction,
} from '../src/core/chemistry/reactions';

/* Kinetics has closed forms for the simple cases and conservation laws for all
 * of them, so nothing here is checked against recorded output. A first-order
 * decay has to be an exponential with the right half-life; a reversible pair
 * has to settle at kf/kr; atoms have to be conserved to rounding; and a
 * titration curve has to pass through pH = pKa at half-equivalence, which is
 * the one point on it that has an exact answer.
 */

let counter = 0;
const rx = (equation: string, over: Partial<Reaction> = {}): Reaction => ({
  id: `r${counter++}`,
  equation,
  forward: 1,
  reverse: 0,
  activationForward: 50,
  activationReverse: 50,
  enabled: true,
  ...over,
});

const finalOf = (result: ReturnType<typeof runKinetics>, species: string): number => {
  const i = result.species.indexOf(species);
  return i < 0 ? NaN : result.concentrations[i][result.concentrations[i].length - 1];
};

describe('reading an equation', () => {
  it('reads coefficients, arrows and both directions', () => {
    const a = parseReaction('A + 2B -> 3C');
    expect(a.error).toBe(null);
    expect(a.reversible).toBe(false);
    expect(a.reactants).toEqual([
      { species: 'A', coefficient: 1 },
      { species: 'B', coefficient: 2 },
    ]);
    expect(a.products).toEqual([{ species: 'C', coefficient: 3 }]);

    const b = parseReaction('N2 + 3H2 <-> 2NH3');
    expect(b.error).toBe(null);
    expect(b.reversible).toBe(true);
    expect(b.products).toEqual([{ species: 'NH3', coefficient: 2 }]);

    // Spacing is not meaningful, and neither is which arrow you happen to type.
    expect(parseReaction('A+B->C').error).toBe(null);
    expect(parseReaction('  A   +   B   ⇌   C  ').reversible).toBe(true);
    expect(parseReaction('A => B').error).toBe(null);
  });

  it('allows an empty side, which is how inflow and outflow are written', () => {
    const inflow = parseReaction('-> A');
    expect(inflow.error).toBe(null);
    expect(inflow.reactants).toEqual([]);
    expect(inflow.products).toEqual([{ species: 'A', coefficient: 1 }]);

    const outflow = parseReaction('B ->');
    expect(outflow.error).toBe(null);
    expect(outflow.products).toEqual([]);
  });

  it('complains about what it cannot read rather than guessing', () => {
    expect(parseReaction('A B C').error).not.toBe(null);
    expect(parseReaction('A -> B -> C').error).not.toBe(null);
    expect(parseReaction('A + -> B').error).not.toBe(null);
    expect(parseReaction('0A -> B').error).not.toBe(null);
    expect(parseReaction('').error).not.toBe(null);
  });

  it('lists species in the order they first appear', () => {
    const net = buildNetwork([rx('B -> C'), rx('A -> B')]);
    expect(net.species).toEqual(['B', 'C', 'A']);
    expect(net.problems).toEqual([]);
  });
});

describe('kinetics', () => {
  it('makes a first-order decay an exponential with the right half-life', () => {
    /* A → B with k = 0.4: [A] = [A]₀e^{−kt} exactly, and the half-life is
     * ln2/k = 1.733 s regardless of the starting amount. */
    const k = 0.4;
    const net = buildNetwork([rx('A -> B', { forward: k })]);
    const result = runKinetics(net, { A: 1 }, 10, 400);
    const a = result.concentrations[result.species.indexOf('A')];

    for (let i = 0; i < result.times.length; i += 40) {
      expect(a[i]).toBeCloseTo(Math.exp(-k * result.times[i]), 6);
    }
    // Half-life, read off the curve.
    let half = 0;
    for (let i = 1; i < a.length; i++) {
      if (a[i] <= 0.5) {
        half = result.times[i - 1] + ((result.times[i] - result.times[i - 1]) * (a[i - 1] - 0.5)) / (a[i - 1] - a[i]);
        break;
      }
    }
    expect(half).toBeCloseTo(Math.LN2 / k, 3);
  });

  it('makes a second-order decay a reciprocal, which is a different shape', () => {
    // 2A → B with rate k[A]²: 1/[A] = 1/[A]₀ + 2kt, the factor of two coming
    // from the stoichiometry rather than from the rate law.
    const k = 0.5;
    const net = buildNetwork([rx('2A -> B', { forward: k })]);
    const result = runKinetics(net, { A: 1 }, 8, 300);
    const a = result.concentrations[result.species.indexOf('A')];
    for (let i = 0; i < result.times.length; i += 30) {
      expect(1 / a[i]).toBeCloseTo(1 + 2 * k * result.times[i], 4);
    }
  });

  it('conserves atoms through a whole network', () => {
    /* A ⇌ B → C, with everything starting as A. Nothing is created or
     * destroyed, so the total is one for ever — which a wrong sign in the
     * stoichiometry would break immediately. */
    const net = buildNetwork([rx('A <-> B', { forward: 1.2, reverse: 0.4 }), rx('B -> C', { forward: 0.3 })]);
    const result = runKinetics(net, { A: 1 }, 20, 200);
    for (let i = 0; i < result.times.length; i++) {
      const total = result.concentrations.reduce((sum, row) => sum + row[i], 0);
      expect(total).toBeCloseTo(1, 8);
    }
    /* And everything ends up at C, because that step has no way back. The
     * pre-equilibrium approximation puts the effective rate at k₂K/(1+K) =
     * 0.225, so after twenty seconds 1 − e^{−4.5} ≈ 0.989 of it should have
     * arrived; the exact answer is a shade under that because the
     * approximation assumes A ⇌ B is always equilibrated and early on it is
     * not. */
    expect(finalOf(result, 'C')).toBeGreaterThan(0.98);
    expect(finalOf(result, 'C')).toBeLessThan(0.99);
  });

  it('never lets a concentration go negative', () => {
    const net = buildNetwork([rx('A -> B', { forward: 30 }), rx('B -> C', { forward: 30 })]);
    const result = runKinetics(net, { A: 1 }, 5, 300);
    for (const row of result.concentrations) for (const v of row) expect(v).toBeGreaterThan(-1e-9);
  });

  it('settles at the equilibrium its own rate constants imply', () => {
    /* A ⇌ B: at equilibrium kf[A] = kr[B], so [B]/[A] = kf/kr = K. The
     * constant is never handed to the integrator — it comes out. */
    const kf = 2;
    const kr = 0.5;
    const spec = rx('A <-> B', { forward: kf, reverse: kr });
    const net = buildNetwork([spec]);
    const result = runKinetics(net, { A: 1 }, 30, 200);
    const ratio = finalOf(result, 'B') / finalOf(result, 'A');
    expect(ratio).toBeCloseTo(kf / kr, 5);
    expect(equilibriumConstant(spec, false, 298)).toBeCloseTo(4, 12);
  });

  it('reaches the same equilibrium from either side', () => {
    // The defining property of an equilibrium, and a real test of the solver:
    // start from all-A or all-B and the ratio has to come out the same.
    const spec = rx('A <-> B', { forward: 1.5, reverse: 0.6 });
    const net = buildNetwork([spec]);
    const fromA = runKinetics(net, { A: 1, B: 0 }, 40, 150);
    const fromB = runKinetics(net, { A: 0, B: 1 }, 40, 150);
    expect(finalOf(fromA, 'A')).toBeCloseTo(finalOf(fromB, 'A'), 6);
    expect(finalOf(fromA, 'B')).toBeCloseTo(finalOf(fromB, 'B'), 6);
  });

  it('obeys Le Chatelier when it is kicked', () => {
    /* Run to equilibrium, then add more A. The system consumes some of it to
     * make more B — so B ends higher than it was — while the *ratio* comes
     * back to the same K. That is the principle, stated quantitatively. */
    const spec = rx('A <-> B', { forward: 2, reverse: 0.5 });
    const net = buildNetwork([spec]);
    const quiet = runKinetics(net, { A: 1 }, 40, 200);
    const kicked = runKinetics(net, { A: 1 }, 40, 200, {
      useArrhenius: false,
      temperature: 298,
      perturbation: { at: 20, species: 'A', amount: 1, enabled: true },
    });

    expect(finalOf(kicked, 'B')).toBeGreaterThan(finalOf(quiet, 'B') * 1.5);
    expect(finalOf(kicked, 'A')).toBeGreaterThan(finalOf(quiet, 'A') * 1.5);
    // Same K, different amounts.
    const ratio = finalOf(kicked, 'B') / finalOf(kicked, 'A');
    expect(ratio).toBeCloseTo(4, 4);
    // Total went up by exactly what was added.
    const before = finalOf(quiet, 'A') + finalOf(quiet, 'B');
    expect(finalOf(kicked, 'A') + finalOf(kicked, 'B')).toBeCloseTo(before + 1, 5);
  });

  it('computes a reaction quotient that equals K at equilibrium and not before', () => {
    const spec = rx('A <-> 2B', { forward: 1, reverse: 0.25 });
    const net = buildNetwork([spec]);
    const parsed = net.reactions[0].parsed;
    const result = runKinetics(net, { A: 1 }, 60, 200);

    const at = (i: number) =>
      reactionQuotient(parsed, Object.fromEntries(result.species.map((s, j) => [s, result.concentrations[j][i]])))!;
    const K = equilibriumConstant(spec, false, 298)!;
    expect(at(result.times.length - 1)).toBeCloseTo(K, 3);
    // Early on there is barely any B, so Q is far below K and the reaction
    // still has somewhere to go.
    expect(at(2)).toBeLessThan(K);
  });
});

describe('Arrhenius', () => {
  it('is the exponential it says it is', () => {
    const A = 1e10;
    const Ea = 60;
    for (const T of [250, 298, 350, 500]) {
      expect(arrhenius(A, Ea, T)).toBeCloseTo(A * Math.exp(-Ea / (GAS_CONSTANT * T)), 6);
    }
  });

  it('gives a straight line of the right slope on a log plot', () => {
    /* ln k = ln A − Ea/RT, so the slope of ln k against 1/T is −Ea/R. Reading
     * the activation energy off that slope is how it is measured in a lab. */
    const Ea = 75;
    const points = [280, 300, 320, 340, 360].map((T) => ({ x: 1 / T, y: Math.log(arrhenius(1e12, Ea, T)) }));
    const n = points.length;
    const sx = points.reduce((s, p) => s + p.x, 0);
    const sy = points.reduce((s, p) => s + p.y, 0);
    const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
    const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    expect(slope).toBeCloseTo(-Ea / GAS_CONSTANT, 6);
  });

  it('shifts an equilibrium the way the enthalpy says', () => {
    /* K = (Af/Ar)·e^{−(Ea_f − Ea_r)/RT}, and Ea_f − Ea_r is ΔH. Endothermic
     * forward (Ea_f > Ea_r) means K rises with temperature; exothermic means
     * it falls. That is van 't Hoff, and it is the reason heating an
     * exothermic equilibrium pushes it backwards. */
    const endothermic = rx('A <-> B', { forward: 1e8, reverse: 1e8, activationForward: 80, activationReverse: 40 });
    const exothermic = rx('A <-> B', { forward: 1e8, reverse: 1e8, activationForward: 40, activationReverse: 80 });

    const cold = equilibriumConstant(endothermic, true, 280)!;
    const hot = equilibriumConstant(endothermic, true, 380)!;
    expect(hot).toBeGreaterThan(cold);

    expect(equilibriumConstant(exothermic, true, 380)!).toBeLessThan(equilibriumConstant(exothermic, true, 280)!);
  });

  it('speeds a reaction up when it is heated', () => {
    const net = (T: number) =>
      runKinetics(
        buildNetwork([rx('A -> B', { forward: 1e9, activationForward: 60 })]),
        { A: 1 },
        5,
        200,
        { useArrhenius: true, temperature: T },
      );
    expect(finalOf(net(320), 'B')).toBeGreaterThan(finalOf(net(280), 'B'));
  });
});

describe('titration', () => {
  const weakAcid = {
    acidConcentration: 0.1,
    acidVolume: 25,
    baseConcentration: 0.1,
    ka: [1.8e-5], // ethanoic acid
    acidInFlask: true,
    maxVolume: 50,
    points: 1200,
  };

  it('starts at the pH a weak acid actually has', () => {
    /* The usual approximation is [H⁺] ≈ √(Ka·C) = 1.342e-3, giving pH 2.8724.
     * Solving the charge balance exactly gives 2.8753 — the two differ in the
     * third decimal because the approximation neglects the acid it has already
     * given up. Both numbers are asserted: the exact one because that is what
     * is being computed, and the gap because it has to stay small or the
     * solver is doing something other than chemistry. */
    const curve = titrationCurve(weakAcid);
    const approximate = -Math.log10(Math.sqrt(1.8e-5 * 0.1));
    expect(curve.points[0].ph).toBeCloseTo(2.8753, 3);
    expect(Math.abs(curve.points[0].ph - approximate)).toBeLessThan(0.01);
  });

  it('passes through pH = pKa at half-equivalence', () => {
    /* The one point on the curve with an exact answer: half the acid has been
     * converted, so [HA] = [A⁻] and the Henderson–Hasselbalch equation gives
     * pH = pKa exactly. If the solver were sketching a shape rather than
     * solving the equilibrium, this is what would be wrong. */
    const curve = titrationCurve(weakAcid);
    const half = curve.halfEquivalenceVolumes[0];
    expect(half).toBeCloseTo(12.5, 9);
    let nearest = curve.points[0];
    for (const p of curve.points) if (Math.abs(p.volume - half) < Math.abs(nearest.volume - half)) nearest = p;
    expect(nearest.ph).toBeCloseTo(curve.pKa[0], 2);
    expect(curve.pKa[0]).toBeCloseTo(4.74, 2);
  });

  it('is basic at the equivalence point of a weak acid, not neutral', () => {
    /* The classic exam trap. At equivalence the flask holds the conjugate
     * base, which hydrolyses: pH ≈ 7 + ½pKa + ½log C = 8.72 here, well above
     * seven. A curve drawn from the usual shape would put it at 7. */
    const curve = titrationCurve(weakAcid);
    expect(curve.equivalenceVolumes[0]).toBeCloseTo(25, 9);
    expect(curve.equivalencePh[0]).toBeGreaterThan(8);
    expect(curve.equivalencePh[0]).toBeCloseTo(8.72, 1);
  });

  it('puts a strong acid at exactly seven when it is neutralised', () => {
    const curve = titrationCurve({ ...weakAcid, ka: [1e6] });
    expect(curve.equivalencePh[0]).toBeCloseTo(7, 1);
    // And it starts at pH 1, which is what 0.1 M of a strong acid is.
    expect(curve.points[0].ph).toBeCloseTo(1, 1);
  });

  it('gives a diprotic acid two equivalence points', () => {
    // Carbonic-like: two dissociations, two jumps, and the second equivalence
    // at twice the volume of the first.
    const curve = titrationCurve({ ...weakAcid, ka: [1e-3, 1e-7], maxVolume: 80 });
    expect(curve.equivalenceVolumes.length).toBe(2);
    expect(curve.equivalenceVolumes[0]).toBeCloseTo(25, 9);
    expect(curve.equivalenceVolumes[1]).toBeCloseTo(50, 9);
    expect(curve.pKa.map((v) => Math.round(v))).toEqual([3, 7]);

    // pH rises all the way along — a titration curve is monotone.
    for (let i = 1; i < curve.points.length; i++) {
      expect(curve.points[i].ph).toBeGreaterThanOrEqual(curve.points[i - 1].ph - 1e-9);
    }
  });

  it('finds the jump where the equivalence point is', () => {
    const curve = titrationCurve(weakAcid);
    const steep = steepestPoint(curve.points)!;
    expect(steep.volume).toBeCloseTo(25, 0);
  });

  it('is the same curve upside down when the base is in the flask', () => {
    const acid = titrationCurve(weakAcid);
    const base = titrationCurve({ ...weakAcid, acidInFlask: false });
    for (let i = 0; i < acid.points.length; i += 50) {
      expect(base.points[i].ph).toBeCloseTo(14 - acid.points[i].ph, 9);
    }
  });
});
