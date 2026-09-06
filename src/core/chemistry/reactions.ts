/* Chemical reactions.
 *
 * A reaction network is an ODE system with a particular shape, and the whole
 * mode rests on getting the translation from one to the other right: parse the
 * equations, build the stoichiometric matrix, apply mass action, integrate.
 * Nothing is special-cased per reaction type, so a mechanism nobody has a
 * closed form for behaves exactly as correctly as A → B does.
 *
 * The three things that make it chemistry rather than arithmetic:
 *
 *   Equilibrium is not imposed. A reversible step is two rates, forward and
 *     back, and the equilibrium constant is their ratio — so K comes out of
 *     the kinetics rather than being asserted alongside them, and Le
 *     Chatelier's principle is something you can watch the integrator do.
 *   Titration curves are solved from the equilibrium constants at every point,
 *     by charge balance, rather than sketched from the shape everyone knows.
 *     The buffer region and the half-equivalence point are then consequences.
 *   Temperature enters through Arrhenius, on the rate constants, which is the
 *     only place it can enter — which is why an endothermic equilibrium shifts
 *     one way on heating and an exothermic one the other.
 */

import { dopri5, type OdeStep, type VectorFn } from '../math/numeric';

/** The gas constant in kJ mol⁻¹ K⁻¹, which is the unit activation energies are quoted in. */
export const GAS_CONSTANT = 8.31446261815324e-3;

export interface Term {
  species: string;
  coefficient: number;
}

export interface Reaction {
  id: string;
  /** As typed: "A + 2B -> C" or "N2 + 3H2 <-> 2NH3". */
  equation: string;
  /** Forward rate constant, or the pre-exponential factor when Arrhenius is on. */
  forward: number;
  reverse: number;
  /** Activation energies in kJ/mol, used only when Arrhenius is on. */
  activationForward: number;
  activationReverse: number;
  enabled: boolean;
}

export interface ParsedReaction {
  reactants: Term[];
  products: Term[];
  reversible: boolean;
  error: string | null;
}

/**
 * Reads one equation.
 *
 * Deliberately forgiving about spacing and about which arrow is used, because
 * the alternative is a mode where the first thing a user does is get an error
 * for typing `->` instead of `→`.
 */
export function parseReaction(equation: string): ParsedReaction {
  const text = equation.trim();
  if (!text) return { reactants: [], products: [], reversible: false, error: 'Empty.' };

  const reversibleArrows = ['<->', '<=>', '⇌', '<>'];
  const forwardArrows = ['->', '=>', '→', '='];
  let arrow: string | null = null;
  let reversible = false;
  for (const a of reversibleArrows) {
    if (text.includes(a)) {
      arrow = a;
      reversible = true;
      break;
    }
  }
  if (!arrow) {
    for (const a of forwardArrows) {
      if (text.includes(a)) {
        arrow = a;
        break;
      }
    }
  }
  if (!arrow) {
    return { reactants: [], products: [], reversible: false, error: 'No arrow — use -> or <->.' };
  }

  const [left, right, ...rest] = text.split(arrow);
  if (rest.length) return { reactants: [], products: [], reversible, error: 'More than one arrow.' };

  const side = (part: string): { terms: Term[]; error: string | null } => {
    const trimmed = part.trim();
    // An empty side is legal and means exactly what it says: a source or a
    // sink, which is how inflow and outflow are written.
    if (!trimmed) return { terms: [], error: null };
    const terms: Term[] = [];
    for (const piece of trimmed.split('+')) {
      const token = piece.trim();
      if (!token) return { terms: [], error: 'A stray + with nothing after it.' };
      const match = /^(\d*(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9_]*)$/.exec(token);
      if (!match) return { terms: [], error: `Could not read "${token}".` };
      const coefficient = match[1] === '' ? 1 : Number(match[1]);
      if (!(coefficient > 0)) return { terms: [], error: `"${token}" has a coefficient of zero.` };
      terms.push({ species: match[2], coefficient });
    }
    return { terms, error: null };
  };

  const a = side(left);
  const b = side(right);
  const error = a.error ?? b.error ?? (a.terms.length === 0 && b.terms.length === 0 ? 'Nothing on either side.' : null);
  return { reactants: a.terms, products: b.terms, reversible, error };
}

export interface Network {
  species: string[];
  reactions: { parsed: ParsedReaction; spec: Reaction }[];
  problems: string[];
}

/** Collects the reactions into a network, in the order the species first appear. */
export function buildNetwork(reactions: Reaction[]): Network {
  const species: string[] = [];
  const seen = new Set<string>();
  const out: Network['reactions'] = [];
  const problems: string[] = [];

  for (const spec of reactions) {
    if (!spec.enabled) continue;
    const parsed = parseReaction(spec.equation);
    if (parsed.error) {
      problems.push(`${spec.equation || '(blank)'}: ${parsed.error}`);
      continue;
    }
    for (const t of [...parsed.reactants, ...parsed.products]) {
      if (seen.has(t.species)) continue;
      seen.add(t.species);
      species.push(t.species);
    }
    out.push({ parsed, spec });
  }
  return { species, reactions: out, problems };
}

/** k = A e^(−Ea/RT). With Arrhenius off, A is the rate constant itself. */
export function arrhenius(preExponential: number, activationKJ: number, temperature: number): number {
  const T = Math.max(1, temperature);
  return preExponential * Math.exp(-activationKJ / (GAS_CONSTANT * T));
}

export interface RateConstants {
  forward: number;
  reverse: number;
}

export function rateConstants(spec: Reaction, useArrhenius: boolean, temperature: number): RateConstants {
  if (!useArrhenius) return { forward: spec.forward, reverse: spec.reverse };
  return {
    forward: arrhenius(spec.forward, spec.activationForward, temperature),
    reverse: arrhenius(spec.reverse, spec.activationReverse, temperature),
  };
}

/**
 * The right-hand side of the kinetics, by mass action.
 *
 * Rate of a step is k times the concentration of each reactant raised to its
 * stoichiometric coefficient — the elementary-step law — and each species
 * changes by (products − reactants) times that rate. Concentrations are
 * floored at zero inside the rate law only: letting a species go slightly
 * negative from integrator error and then raising it to a fractional power
 * produces NaN and takes the whole trajectory with it.
 *
 * Written in the integrator's own out-parameter form — `(t, y, out) => void`,
 * filling `out` rather than returning — because that is the contract `dopri5`
 * has. A version that returned the array instead type-checked perfectly well,
 * since a function returning a value is assignable where one returning void is
 * expected, and then quietly integrated the zero vector: every concentration
 * came back as a flat line at its starting value.
 */
export function makeDerivative(
  network: Network,
  useArrhenius: boolean,
  temperature: number,
): VectorFn {
  const index = new Map(network.species.map((s, i) => [s, i]));
  const steps = network.reactions.map(({ parsed, spec }) => {
    const k = rateConstants(spec, useArrhenius, temperature);
    return {
      reactants: parsed.reactants.map((t) => ({ i: index.get(t.species)!, n: t.coefficient })),
      products: parsed.products.map((t) => ({ i: index.get(t.species)!, n: t.coefficient })),
      reversible: parsed.reversible,
      kf: k.forward,
      kr: k.reverse,
    };
  });

  return (_t, y, out) => {
    const dy = out;
    dy.fill(0);
    for (const step of steps) {
      let forward = step.kf;
      for (const r of step.reactants) forward *= Math.max(0, y[r.i]) ** r.n;
      let reverse = 0;
      if (step.reversible) {
        reverse = step.kr;
        for (const p of step.products) reverse *= Math.max(0, y[p.i]) ** p.n;
      }
      const net = forward - reverse;
      for (const r of step.reactants) dy[r.i] -= r.n * net;
      for (const p of step.products) dy[p.i] += p.n * net;
    }
  };
}

export interface KineticsResult {
  species: string[];
  times: number[];
  /** One array per species, sampled at `times`. */
  concentrations: number[][];
  problems: string[];
}

export interface Perturbation {
  /** When to apply it, in the same time units as the run. */
  at: number;
  /** Species to add (or remove, if negative), in concentration units. */
  species: string;
  amount: number;
  enabled: boolean;
}

/**
 * Integrates the network, optionally kicking it partway through.
 *
 * The kick is what makes Le Chatelier's principle demonstrable rather than
 * quotable: run to equilibrium, add more of one species, and the system moves
 * to consume it and settles at a *different* set of concentrations with the
 * same ratio. Restarting the integration at the perturbation is deliberate —
 * a discontinuity in the state is not something an adaptive step should be
 * asked to integrate through.
 */
export function runKinetics(
  network: Network,
  initial: Record<string, number>,
  duration: number,
  samples: number,
  options: { useArrhenius: boolean; temperature: number; perturbation?: Perturbation | null } = {
    useArrhenius: false,
    temperature: 298,
  },
): KineticsResult {
  const n = network.species.length;
  const count = Math.max(2, Math.min(4000, Math.round(samples)));
  if (n === 0) {
    return { species: [], times: [], concentrations: [], problems: network.problems };
  }

  const f = makeDerivative(network, options.useArrhenius, options.temperature);
  const y0 = network.species.map((s) => Math.max(0, initial[s] ?? 0));
  const kick = options.perturbation;
  const applyAt = kick?.enabled && kick.at > 0 && kick.at < duration ? kick.at : null;

  /* Integrated interval by interval rather than run end-to-end and resampled.
   *
   * The adaptive stepper takes enormous steps across a smooth exponential —
   * which is the right thing for it to do — and interpolating *linearly*
   * between two points a couple of seconds apart on a curve then puts the
   * plotted concentration a part in a thousand off the true one. Restarting at
   * each output time costs a few more stages per interval and makes every
   * point on the curve a value the integrator actually computed. */
  const march = (from: number, to: number, start: number[], k: number) => {
    const out: OdeStep[] = [{ t: from, y: [...start] }];
    let state = [...start];
    for (let i = 1; i < k; i++) {
      const a = from + ((to - from) * (i - 1)) / (k - 1);
      const b = from + ((to - from) * i) / (k - 1);
      const steps = dopri5(f, state, a, b, { rtol: 1e-9, atol: 1e-12 });
      state = [...(steps[steps.length - 1]?.y ?? state)];
      out.push({ t: b, y: [...state] });
    }
    return out;
  };
  const collect = (steps: OdeStep[]) => {
    const rows: number[][] = Array.from({ length: n }, () => []);
    for (const step of steps) for (let i = 0; i < n; i++) rows[i].push(step.y[i]);
    return rows;
  };

  if (applyAt === null) {
    const steps = march(0, duration, y0, count);
    return {
      species: network.species,
      times: steps.map((s) => s.t),
      concentrations: collect(steps),
      problems: network.problems,
    };
  }

  const firstCount = Math.max(2, Math.round((count * applyAt) / duration));
  const first = march(0, applyAt, y0, firstCount);
  const at = first[first.length - 1]?.y ?? y0;

  const bumped = [...at];
  const target = network.species.indexOf(kick!.species);
  if (target >= 0) bumped[target] = Math.max(0, bumped[target] + kick!.amount);

  const second = march(applyAt, duration, bumped, Math.max(2, count - firstCount));
  const steps = [...first, ...second];
  return {
    species: network.species,
    times: steps.map((s) => s.t),
    concentrations: collect(steps),
    problems: network.problems,
  };
}

/**
 * The equilibrium constant of one reversible step, as kf/kr.
 *
 * Not an independent input. A step whose forward and reverse constants are
 * both given has already determined its own K, and quoting a third number
 * would let the three disagree.
 */
export function equilibriumConstant(spec: Reaction, useArrhenius: boolean, temperature: number): number | null {
  const k = rateConstants(spec, useArrhenius, temperature);
  if (!(k.reverse > 0)) return null;
  return k.forward / k.reverse;
}

/**
 * The reaction quotient of a step at a given composition.
 *
 * Q equals K at equilibrium and moves towards it otherwise, which is the
 * quantitative version of "the system shifts to oppose the change".
 */
export function reactionQuotient(parsed: ParsedReaction, concentrations: Record<string, number>): number | null {
  let numerator = 1;
  let denominator = 1;
  for (const p of parsed.products) numerator *= Math.max(0, concentrations[p.species] ?? 0) ** p.coefficient;
  for (const r of parsed.reactants) denominator *= Math.max(0, concentrations[r.species] ?? 0) ** r.coefficient;
  if (!(denominator > 0)) return null;
  return numerator / denominator;
}

// ---------------------------------------------------------------- titration

export interface TitrationOptions {
  /** Analyte concentration and volume. */
  acidConcentration: number;
  acidVolume: number;
  /** Titrant concentration. */
  baseConcentration: number;
  /** Successive acid dissociation constants, strongest first. */
  ka: number[];
  /** Titrating an acid with a base, or a base with an acid. */
  acidInFlask: boolean;
  maxVolume: number;
  points: number;
}

export interface TitrationPoint {
  volume: number;
  ph: number;
}

export interface TitrationResult {
  points: TitrationPoint[];
  /** Where each proton is exactly used up, in mL. */
  equivalenceVolumes: number[];
  /** pH at each equivalence point. */
  equivalencePh: number[];
  /** Half-equivalence volumes, where pH = pKa. */
  halfEquivalenceVolumes: number[];
  pKa: number[];
}

const KW = 1e-14;

/**
 * A titration curve, from the equilibrium constants alone.
 *
 * At every volume the exact charge balance is solved for [H⁺]:
 *
 *   C_base + [H⁺] = C_acid · Σ i·αᵢ + K_w/[H⁺]
 *
 * where αᵢ is the fraction of the acid carrying i fewer protons — the standard
 * alpha fractions, which for n dissociations are the terms of a polynomial in
 * [H⁺]. Solved by bisection in log [H⁺], which is monotone and so cannot miss
 * the root, and which costs about fifty function evaluations per point.
 *
 * Nothing about the *shape* is built in. The buffer plateau, the sharp jump at
 * equivalence and the flattening afterwards are all consequences, and changing
 * Ka moves them the way it should because there is nothing else for it to do.
 */
export function titrationCurve(opts: TitrationOptions): TitrationResult {
  const kas = opts.ka.filter((k) => k > 0);
  const n = Math.max(1, kas.length);
  const points: TitrationPoint[] = [];
  const count = Math.max(10, Math.min(4000, Math.round(opts.points)));

  /* Charge balance as a function of h = [H⁺]. Positive means too much positive
   * charge, which means the guess for h is too high — so the function is
   * monotone decreasing in h and bisection is safe. */
  const balance = (h: number, cAcid: number, cBase: number): number => {
    // Alpha fractions: denominator is h^n + Ka1 h^(n-1) + Ka1Ka2 h^(n-2) + …
    let term = 1;
    const terms: number[] = [1];
    for (let i = 0; i < n; i++) {
      term *= kas[i] ?? 0;
      terms.push(term);
    }
    let denominator = 0;
    let protonsReleased = 0;
    for (let i = 0; i <= n; i++) {
      const contribution = terms[i] * h ** (n - i);
      denominator += contribution;
      protonsReleased += i * contribution;
    }
    if (!(denominator > 0)) return -1;
    const released = (cAcid * protonsReleased) / denominator;
    return cBase + h - released - KW / h;
  };

  const solve = (cAcid: number, cBase: number): number => {
    let lo = -1;
    let hi = 15; // pH from −1 to 15, which brackets anything realistic
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const value = balance(10 ** -mid, cAcid, cBase);
      /* Charge balance is positive when the solution is modelled as more
       * acidic than it is and falls monotonically as the pH guess rises, so a
       * positive value means the guess is too *low*. Getting this the wrong
       * way round gives a curve that is upside down and pinned at the bracket
       * ends, which is what it did. */
      if (value > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const phAt = (volume: number): number => {
    const total = opts.acidVolume + volume;
    if (!(total > 0)) return 7;
    const cAcid = (opts.acidConcentration * opts.acidVolume) / total;
    const cBase = (opts.baseConcentration * volume) / total;
    const ph = solve(cAcid, cBase);
    // Titrating a base with an acid is the same curve read the other way up.
    return opts.acidInFlask ? ph : 14 - ph;
  };

  for (let i = 0; i < count; i++) {
    points.push({ volume: (opts.maxVolume * i) / (count - 1), ph: phAt((opts.maxVolume * i) / (count - 1)) });
  }

  const perProton = (opts.acidConcentration * opts.acidVolume) / Math.max(1e-12, opts.baseConcentration);
  const equivalenceVolumes: number[] = [];
  const halfEquivalenceVolumes: number[] = [];
  for (let i = 1; i <= n; i++) {
    equivalenceVolumes.push(perProton * i);
    halfEquivalenceVolumes.push(perProton * (i - 0.5));
  }
  /* Solved *at* the equivalence volume, not read off the nearest sample. The
   * curve is near-vertical there, so a sample a fortieth of a millilitre away
   * is most of a pH unit out — which turned a weak acid's equivalence point
   * from the 8.7 it should be into a 7.8 that looks like a rounding error and
   * is really the whole lesson of the section being wrong. */
  const equivalencePh = equivalenceVolumes.map(phAt);

  return {
    points,
    equivalenceVolumes,
    equivalencePh,
    halfEquivalenceVolumes,
    pKa: kas.map((k) => -Math.log10(k)),
  };
}

/**
 * Where the curve is steepest, which is what an indicator actually detects.
 *
 * Found from the sampled curve rather than from the algebra, so it is the
 * equivalence point *of the curve being drawn* — if the sampling is too coarse
 * to resolve the jump, this says so by disagreeing with the exact volume
 * instead of quietly reporting the exact one.
 */
export function steepestPoint(points: TitrationPoint[]): TitrationPoint | null {
  let best: TitrationPoint | null = null;
  let slope = 0;
  for (let i = 1; i < points.length; i++) {
    const dv = points[i].volume - points[i - 1].volume;
    if (!(dv > 0)) continue;
    const s = Math.abs((points[i].ph - points[i - 1].ph) / dv);
    if (s > slope) {
      slope = s;
      best = { volume: (points[i].volume + points[i - 1].volume) / 2, ph: (points[i].ph + points[i - 1].ph) / 2 };
    }
  }
  return best;
}
