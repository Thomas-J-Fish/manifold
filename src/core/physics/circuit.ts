/* Circuit simulation by modified nodal analysis.
 *
 * This is the same method SPICE uses, for the same reason: it needs no
 * assumptions about the topology. Series, parallel, bridge, ladder and
 * whatever a student happens to draw are all just a matrix. Kirchhoff's
 * current law is written at every node, elements that force a voltage rather
 * than a current get an extra unknown and an extra row, and the whole thing is
 * one dense solve.
 *
 *     ⎡ G  B ⎤ ⎡ v ⎤   ⎡ i ⎤
 *     ⎣ C  D ⎦ ⎣ j ⎦ = ⎣ e ⎦
 *
 * where v is the node voltages, j the currents through voltage-defined
 * branches, G the conductances, and B/C/D the incidence of those branches.
 *
 * Capacitors and inductors become companion models: at each timestep a
 * capacitor is a conductance in parallel with a current source, an inductor a
 * branch whose equation carries its history. The discretisation is
 * trapezoidal, which is second-order accurate and — importantly for a teaching
 * tool — A-stable, so a fast RC in a slow circuit cannot make the simulation
 * blow up, it just resolves it coarsely. Backward Euler is used for the very
 * first step to damp the switch-on discontinuity, which is the standard trick
 * for stopping trapezoidal ringing on a step input.
 *
 * Diodes and LEDs are genuinely nonlinear, so each timestep runs
 * Newton–Raphson with SPICE's junction limiting: without it, one iteration
 * that overshoots by a volt puts exp(40) into the Jacobian and the solve never
 * recovers.
 */

import { DenseSolver } from './linsolve';

// ------------------------------------------------------------------ elements

export type ElementKind =
  | 'wire'
  | 'cell'
  | 'battery'
  | 'ac'
  | 'resistor'
  | 'bulb'
  | 'switch'
  | 'capacitor'
  | 'inductor'
  | 'diode'
  | 'led'
  | 'fuse'
  | 'thermistor'
  | 'ammeter'
  | 'voltmeter'
  | 'ground';

export interface CircuitElement {
  id: string;
  kind: ElementKind;
  /** Grid coordinates of the first terminal. */
  x: number;
  y: number;
  /** The second terminal is one grid step right ('h') or down ('v'). */
  orientation: 'h' | 'v';
  /** Swaps the two terminals, for polarised parts. */
  reversed: boolean;
  /** Named component values; see `ELEMENT_SPECS` for what each kind uses. */
  values: Record<string, number>;
  label: string;
}

export interface CircuitWorld {
  elements: CircuitElement[];
  /** Ambient temperature in °C — thermistors read it. */
  temperature: number;
  /** Simulation timestep in seconds; 0 asks for one to be chosen. */
  timestep: number;
}

export interface ValueSpec {
  key: string;
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
  /** Slider/number-field increment. */
  step: number;
  /** Present the field on a log scale — capacitance spans nine decades. */
  log?: boolean;
}

export interface ElementSpec {
  kind: ElementKind;
  name: string;
  blurb: string;
  /** One terminal (ground) or two. */
  terminals: 1 | 2;
  polarised: boolean;
  values: ValueSpec[];
}

const R = (over: Partial<ValueSpec> = {}): ValueSpec => ({
  key: 'resistance',
  label: 'Resistance',
  unit: 'Ω',
  default: 100,
  min: 0.001,
  max: 1e7,
  step: 10,
  log: true,
  ...over,
});

export const ELEMENT_SPECS: ElementSpec[] = [
  {
    kind: 'wire',
    name: 'Wire',
    blurb: 'An ideal connection with no resistance.',
    terminals: 2,
    polarised: false,
    values: [],
  },
  {
    kind: 'cell',
    name: 'Cell',
    blurb: 'An EMF with internal resistance. Terminal marked + is the long line.',
    terminals: 2,
    polarised: true,
    values: [
      { key: 'emf', label: 'EMF', unit: 'V', default: 6, min: -100, max: 100, step: 0.5 },
      { key: 'internal', label: 'Internal resistance', unit: 'Ω', default: 0.5, min: 0, max: 100, step: 0.1 },
    ],
  },
  {
    kind: 'battery',
    name: 'Battery',
    blurb: 'Several cells in series.',
    terminals: 2,
    polarised: true,
    values: [
      { key: 'emf', label: 'EMF per cell', unit: 'V', default: 1.5, min: -20, max: 20, step: 0.1 },
      { key: 'cells', label: 'Cells', unit: '', default: 4, min: 1, max: 12, step: 1 },
      { key: 'internal', label: 'Internal resistance', unit: 'Ω', default: 0.3, min: 0, max: 100, step: 0.1 },
    ],
  },
  {
    kind: 'ac',
    name: 'AC source',
    blurb: 'A sinusoidal supply.',
    terminals: 2,
    polarised: true,
    values: [
      { key: 'amplitude', label: 'Peak voltage', unit: 'V', default: 5, min: 0, max: 100, step: 0.5 },
      { key: 'frequency', label: 'Frequency', unit: 'Hz', default: 50, min: 0.01, max: 1e6, step: 10, log: true },
      { key: 'phase', label: 'Phase', unit: '°', default: 0, min: -180, max: 180, step: 15 },
      { key: 'offset', label: 'DC offset', unit: 'V', default: 0, min: -50, max: 50, step: 0.5 },
    ],
  },
  {
    kind: 'resistor',
    name: 'Resistor',
    blurb: 'Ohm’s law, V = IR.',
    terminals: 2,
    polarised: false,
    values: [R()],
  },
  {
    kind: 'bulb',
    name: 'Bulb',
    blurb: 'A resistor that lights up. Brightness is the fraction of its rated power.',
    terminals: 2,
    polarised: false,
    values: [
      R({ default: 12, max: 1e4 }),
      { key: 'rating', label: 'Rated power', unit: 'W', default: 3, min: 0.01, max: 500, step: 0.5 },
    ],
  },
  {
    kind: 'switch',
    name: 'Switch',
    blurb: 'Open or closed.',
    terminals: 2,
    polarised: false,
    values: [{ key: 'closed', label: 'Closed', unit: '', default: 1, min: 0, max: 1, step: 1 }],
  },
  {
    kind: 'capacitor',
    name: 'Capacitor',
    blurb: 'Stores charge: Q = CV, and I = C dV/dt.',
    terminals: 2,
    polarised: false,
    values: [
      { key: 'capacitance', label: 'Capacitance', unit: 'F', default: 1e-3, min: 1e-12, max: 1, step: 1e-4, log: true },
      { key: 'initial', label: 'Initial voltage', unit: 'V', default: 0, min: -100, max: 100, step: 0.5 },
    ],
  },
  {
    kind: 'inductor',
    name: 'Inductor',
    blurb: 'Opposes change in current: V = L dI/dt.',
    terminals: 2,
    polarised: false,
    values: [
      { key: 'inductance', label: 'Inductance', unit: 'H', default: 0.1, min: 1e-9, max: 100, step: 0.01, log: true },
      { key: 'initial', label: 'Initial current', unit: 'A', default: 0, min: -50, max: 50, step: 0.1 },
    ],
  },
  {
    kind: 'diode',
    name: 'Diode',
    blurb: 'Conducts one way. Shockley equation with an ideality factor.',
    terminals: 2,
    polarised: true,
    values: [
      { key: 'forward', label: 'Forward voltage', unit: 'V', default: 0.7, min: 0.1, max: 5, step: 0.05 },
      { key: 'ideality', label: 'Ideality factor', unit: '', default: 1.6, min: 1, max: 4, step: 0.1 },
    ],
  },
  {
    kind: 'led',
    name: 'LED',
    blurb: 'A diode that emits light above its forward voltage.',
    terminals: 2,
    polarised: true,
    values: [
      { key: 'forward', label: 'Forward voltage', unit: 'V', default: 2, min: 1, max: 4, step: 0.05 },
      { key: 'ideality', label: 'Ideality factor', unit: '', default: 2, min: 1, max: 6, step: 0.1 },
      { key: 'rating', label: 'Rated current', unit: 'A', default: 0.02, min: 0.001, max: 1, step: 0.005 },
    ],
  },
  {
    kind: 'fuse',
    name: 'Fuse',
    blurb: 'Breaks the circuit for good once its rated current is exceeded.',
    terminals: 2,
    polarised: false,
    values: [
      R({ default: 0.05, max: 100 }),
      { key: 'rating', label: 'Rated current', unit: 'A', default: 1, min: 0.001, max: 100, step: 0.1 },
    ],
  },
  {
    kind: 'thermistor',
    name: 'Thermistor',
    blurb: 'An NTC thermistor: resistance falls as the temperature rises.',
    terminals: 2,
    polarised: false,
    values: [
      { key: 'r25', label: 'Resistance at 25 °C', unit: 'Ω', default: 10000, min: 1, max: 1e7, step: 100, log: true },
      { key: 'beta', label: 'B constant', unit: 'K', default: 3950, min: 500, max: 8000, step: 50 },
    ],
  },
  {
    kind: 'ammeter',
    name: 'Ammeter',
    blurb: 'Ideal: zero resistance, reads the current through it.',
    terminals: 2,
    polarised: true,
    values: [],
  },
  {
    kind: 'voltmeter',
    name: 'Voltmeter',
    blurb: 'Near-ideal: reads the voltage across itself.',
    terminals: 2,
    polarised: true,
    values: [
      { key: 'resistance', label: 'Resistance', unit: 'Ω', default: 1e7, min: 1e3, max: 1e12, step: 1e6, log: true },
    ],
  },
  {
    kind: 'ground',
    name: 'Ground',
    blurb: 'The 0 V reference. Every circuit needs one, and gets one automatically if you do not place it.',
    terminals: 1,
    polarised: false,
    values: [],
  },
];

export const SPEC_BY_KIND = new Map(ELEMENT_SPECS.map((s) => [s.kind, s]));

export function defaultValues(kind: ElementKind): Record<string, number> {
  const spec = SPEC_BY_KIND.get(kind);
  if (!spec) return {};
  const out: Record<string, number> = {};
  for (const v of spec.values) out[v.key] = v.default;
  return out;
}

/** Terminal grid coordinates, in the order the simulator treats as (a, b). */
export function terminals(e: CircuitElement): [[number, number], [number, number]] {
  const a: [number, number] = [e.x, e.y];
  const b: [number, number] = e.orientation === 'h' ? [e.x + 1, e.y] : [e.x, e.y + 1];
  return e.reversed ? [b, a] : [a, b];
}

// ------------------------------------------------------------------ netlist

const key = (x: number, y: number) => `${x},${y}`;

class UnionFind {
  private parent = new Map<string, string>();

  find(a: string): string {
    let root = this.parent.get(a);
    if (root === undefined) {
      this.parent.set(a, a);
      return a;
    }
    while (root !== this.parent.get(root)) root = this.parent.get(root) as string;
    this.parent.set(a, root);
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export interface Netlist {
  /** Elements that take part in the solve, wires and grounds excluded. */
  active: CircuitElement[];
  /** Zero-resistance segments — wires, and switches that are closed. The
   * solve collapses these into nodes and so knows nothing about the current
   * in them; `wireFlow` recovers it for the animation. */
  wires: CircuitElement[];
  /** Node index per element terminal; −1 is the reference node. */
  nodeA: Int32Array;
  nodeB: Int32Array;
  /** Number of non-reference nodes. */
  nodeCount: number;
  /** Node index for each grid point, so the drawing can colour by potential. */
  nodeOfPoint: Map<string, number>;
  problems: string[];
  warnings: string[];
}

/**
 * Collapses wires, works out which grid points are the same electrical node,
 * and picks a reference.
 *
 * A circuit with no ground is not an error — students very rarely draw one —
 * so one is chosen: the negative terminal of the first source, which is what
 * they would have drawn had they been asked. Sections with no path to the
 * reference at all are a genuine problem and are reported, because a floating
 * subcircuit has no defined voltage and the answer would otherwise be
 * arbitrary.
 */
export function buildNetlist(world: CircuitWorld): Netlist {
  const problems: string[] = [];
  const warnings: string[] = [];
  const uf = new UnionFind();

  const active: CircuitElement[] = [];
  const wires: CircuitElement[] = [];
  const grounds: CircuitElement[] = [];
  for (const e of world.elements) {
    const [a, b] = terminals(e);
    if (e.kind === 'ground') {
      uf.find(key(a[0], a[1]));
      grounds.push(e);
      continue;
    }
    if (e.kind === 'wire') {
      uf.union(key(a[0], a[1]), key(b[0], b[1]));
      wires.push(e);
      continue;
    }
    // A closed switch is a short. Treating it as a 1 mΩ resistor instead would
    // work, but merging the nodes keeps the matrix smaller and better
    // conditioned, and makes "the switch is closed" visible in the node
    // colouring rather than as a millivolt gradient.
    if (e.kind === 'switch' && e.values.closed >= 0.5) {
      uf.union(key(a[0], a[1]), key(b[0], b[1]));
      wires.push(e);
      continue;
    }
    uf.find(key(a[0], a[1]));
    uf.find(key(b[0], b[1]));
    active.push(e);
  }

  // Choose the reference.
  let referenceRoot: string | null = null;
  if (grounds.length) {
    const [a] = terminals(grounds[0]);
    referenceRoot = uf.find(key(a[0], a[1]));
    if (grounds.length > 1) {
      const first = referenceRoot;
      for (const g of grounds.slice(1)) {
        const [p] = terminals(g);
        if (uf.find(key(p[0], p[1])) !== first) {
          // Two grounds in different places is a short circuit through the
          // earth symbol, which is exactly what it means on a real bench.
          uf.union(key(p[0], p[1]), first);
        }
      }
      referenceRoot = uf.find(key((terminals(grounds[0])[0])[0], (terminals(grounds[0])[0])[1]));
    }
  } else {
    const source = active.find((e) => e.kind === 'cell' || e.kind === 'battery' || e.kind === 'ac');
    if (source) {
      const [, b] = terminals(source);
      referenceRoot = uf.find(key(b[0], b[1]));
    } else if (active.length) {
      const [a] = terminals(active[0]);
      referenceRoot = uf.find(key(a[0], a[1]));
    }
  }

  const nodeIndex = new Map<string, number>();
  let nodeCount = 0;
  const indexOf = (root: string): number => {
    if (root === referenceRoot) return -1;
    let i = nodeIndex.get(root);
    if (i === undefined) {
      i = nodeCount++;
      nodeIndex.set(root, i);
    }
    return i;
  };

  const nodeA = new Int32Array(active.length);
  const nodeB = new Int32Array(active.length);
  active.forEach((e, i) => {
    const [a, b] = terminals(e);
    nodeA[i] = indexOf(uf.find(key(a[0], a[1])));
    nodeB[i] = indexOf(uf.find(key(b[0], b[1])));
  });

  const nodeOfPoint = new Map<string, number>();
  for (const e of world.elements) {
    const [a, b] = terminals(e);
    nodeOfPoint.set(key(a[0], a[1]), indexOf(uf.find(key(a[0], a[1]))));
    if (e.kind !== 'ground') nodeOfPoint.set(key(b[0], b[1]), indexOf(uf.find(key(b[0], b[1]))));
  }

  if (!active.length) problems.push('Nothing to solve — add a source and something for it to drive.');
  else if (referenceRoot === null) problems.push('The circuit has no reference point.');
  if (!active.some((e) => e.kind === 'cell' || e.kind === 'battery' || e.kind === 'ac')) {
    if (active.length) warnings.push('There is no source, so every voltage will be zero.');
  }

  return { active, wires, nodeA, nodeB, nodeCount, nodeOfPoint, problems, warnings };
}

// ------------------------------------------------------------------ device models

const VT = 0.025852; // kT/q at 300 K
const R_OPEN = 1e12;
const GMIN = 1e-12;

/** Saturation current chosen so the part reaches its rated current at Vf. */
function saturationCurrent(forward: number, ideality: number, rated: number): number {
  const denominator = Math.exp(forward / (ideality * VT)) - 1;
  return denominator > 0 ? rated / denominator : 1e-14;
}

/**
 * SPICE's `pnjlim`: keeps a Newton step from walking into the exponential's
 * overflow region.
 *
 * Newton on exp(v/nVt) is only well behaved near the solution. One iteration
 * that lands a volt too high raises e^40, the Jacobian is astronomically
 * stiff, and the next step lands somewhere useless — the classic symptom is a
 * simulator that reports "no convergence" on a circuit with a single LED in
 * it. Limiting the step to a logarithmic increment fixes it completely.
 */
function limitJunction(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vnew > 0 ? vt * Math.log(Math.max(vnew / vt, 1e-9)) : vnew;
  }
  return vnew;
}

export function thermistorResistance(r25: number, beta: number, celsius: number): number {
  const t = celsius + 273.15;
  return r25 * Math.exp(beta * (1 / t - 1 / 298.15));
}

/** The resistance an element presents, before any nonlinear or dynamic model. */
export function staticResistance(e: CircuitElement, temperature: number, blown: boolean): number {
  switch (e.kind) {
    case 'resistor':
    case 'bulb':
      return Math.max(1e-9, e.values.resistance);
    case 'fuse':
      return blown ? R_OPEN : Math.max(1e-9, e.values.resistance);
    case 'thermistor':
      return thermistorResistance(e.values.r25, e.values.beta, temperature);
    case 'voltmeter':
      return Math.max(1e3, e.values.resistance);
    case 'switch':
      return e.values.closed >= 0.5 ? 1e-3 : R_OPEN;
    default:
      return NaN;
  }
}

export function sourceVoltage(e: CircuitElement, t: number): number {
  switch (e.kind) {
    case 'cell':
      return e.values.emf;
    case 'battery':
      return e.values.emf * Math.max(1, Math.round(e.values.cells));
    case 'ac':
      return (
        e.values.offset +
        e.values.amplitude * Math.sin(2 * Math.PI * e.values.frequency * t + (e.values.phase * Math.PI) / 180)
      );
    default:
      return 0;
  }
}

/**
 * Current in each wire, which the matrix never solves for.
 *
 * Wires are collapsed into nodes before the solve, so the solver knows the
 * current through every component and nothing whatever about the copper
 * between them. That is fine for the numbers and wrong for the picture: the
 * flow dots stopped dead at each component and reappeared at the next one,
 * which reads as charge piling up in the wires.
 *
 * So every wire segment gets an unknown, Kirchhoff's current law is imposed at
 * every point the wires touch, and the smallest solution satisfying it is
 * taken. Where the answer is determined — a series loop, one branch of a
 * parallel pair — that *is* the physical answer. Where it is not, because two
 * ideal wires run side by side, the minimum-norm solution splits the current
 * evenly and adds no circulating loop current, which is the only defensible
 * choice for conductors with no resistance to tell them apart.
 *
 * The map from component values to wire values is linear, so feeding it
 * accumulated charge rather than current returns accumulated charge in the
 * wires — which is what the animation actually needs.
 */
export function wireFlow(netlist: Netlist, elementValues: ArrayLike<number>): Float64Array {
  const wires = netlist.wires;
  const out = new Float64Array(wires.length);
  if (!wires.length) return out;

  const rowOf = new Map<string, number>();
  const rowFor = (x: number, y: number): number => {
    const k = key(x, y);
    let r = rowOf.get(k);
    if (r === undefined) {
      r = rowOf.size;
      rowOf.set(k, r);
    }
    return r;
  };
  const ends = wires.map((w) => {
    const [a, b] = terminals(w);
    return { u: rowFor(a[0], a[1]), v: rowFor(b[0], b[1]) };
  });
  const p = rowOf.size;

  // What the components push into each of those points. Positive means
  // flowing a → b inside the component: out of the node at a, into b.
  const inject = new Float64Array(p);
  netlist.active.forEach((e, i) => {
    const value = elementValues[i] ?? 0;
    if (!Number.isFinite(value)) return;
    const [a, b] = terminals(e);
    const ra = rowOf.get(key(a[0], a[1]));
    const rb = rowOf.get(key(b[0], b[1]));
    if (ra !== undefined) inject[ra] -= value;
    if (rb !== undefined) inject[rb] += value;
  });

  /* A x = −inject with A the incidence matrix of the wire graph, solved as
   * x = Aᵀ(AAᵀ + λI)⁻¹(−inject), the least-norm solution. The ridge term
   * covers the null space AAᵀ has whenever a group of points is cut off from
   * the rest. Kirchhoff guarantees the right-hand side has no component along
   * that null space — the net current into a disconnected island is zero — so
   * the ridge only has to keep the factorisation from being singular, and can
   * be small enough to leave nine significant figures untouched. */
  const solver = new DenseSolver(p);
  solver.reset(p);
  const rhs = new Float64Array(p);
  for (let r = 0; r < p; r++) {
    rhs[r] = -inject[r];
    solver.add(p, r, r, 1e-12);
  }
  for (const { u, v } of ends) {
    solver.add(p, u, u, 1);
    solver.add(p, v, v, 1);
    solver.add(p, u, v, -1);
    solver.add(p, v, u, -1);
  }
  if (!solver.solveInPlace(p, rhs)) return out;
  ends.forEach(({ u, v }, j) => {
    out[j] = rhs[v] - rhs[u];
  });
  return out;
}

/**
 * Where a flow dot sits along an element, in grid coordinates.
 *
 * `phase` runs 0 → 1 in the direction of positive current, and this is not the
 * same as the direction the symbol is drawn in. A symbol always occupies the
 * grid square from (x, y) to the next point along, whichever way round the
 * component is; but current is defined between `terminals()`, which swaps the
 * two ends for a reversed component. Placing the dots along the drawing axis
 * instead — which is what this replaced — animated every reversed component
 * backwards, so a battery turned round to put its positive terminal on the
 * right showed charge flowing into that terminal from the circuit.
 */
export function flowPoint(e: CircuitElement, phase: number): [number, number] {
  const [a, b] = terminals(e);
  let s = phase % 1;
  if (s < 0) s += 1;
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
}

// ------------------------------------------------------------------ solver

export interface CircuitState {
  /** Node voltages, one per non-reference node. */
  nodeVoltage: Float64Array;
  /** Voltage across each active element, terminal a minus terminal b. */
  elementVoltage: Float64Array;
  /** Conventional current entering terminal a and leaving terminal b. */
  elementCurrent: Float64Array;
  /** Set for a fuse that has blown; latched for the rest of the run. */
  blown: boolean[];
  converged: boolean;
  iterations: number;
}

interface Branch {
  /** Index into `active`, or −1 for the internal branch of a cell. */
  element: number;
  kind: 'source' | 'inductor' | 'ammeter';
  nodeP: number;
  nodeN: number;
}

interface Assembly {
  netlist: Netlist;
  /** Extra internal nodes created for cells with internal resistance. */
  extraNodes: number;
  branches: Branch[];
  size: number;
  solver: DenseSolver;
  rhs: Float64Array;
  /** Per-element internal node index, or −1. */
  internalNode: Int32Array;
}

function assemble(netlist: Netlist): Assembly {
  const branches: Branch[] = [];
  const internalNode = new Int32Array(netlist.active.length).fill(-1);
  let extraNodes = 0;

  netlist.active.forEach((e, i) => {
    if (e.kind === 'cell' || e.kind === 'battery' || e.kind === 'ac') {
      const hasInternal = (e.values.internal ?? 0) > 0;
      let p = netlist.nodeA[i];
      const n = netlist.nodeB[i];
      if (hasInternal) {
        // The EMF is ideal; the internal resistance is a separate resistor
        // between an internal node and terminal a. Splitting it this way keeps
        // the source ideal in the matrix, which is what makes r → 0 work
        // rather than producing a division by zero.
        internalNode[i] = netlist.nodeCount + extraNodes;
        extraNodes++;
        p = internalNode[i];
      }
      branches.push({ element: i, kind: 'source', nodeP: p, nodeN: n });
    } else if (e.kind === 'inductor') {
      branches.push({ element: i, kind: 'inductor', nodeP: netlist.nodeA[i], nodeN: netlist.nodeB[i] });
    } else if (e.kind === 'ammeter') {
      branches.push({ element: i, kind: 'ammeter', nodeP: netlist.nodeA[i], nodeN: netlist.nodeB[i] });
    }
  });

  const nodes = netlist.nodeCount + extraNodes;
  const size = nodes + branches.length;
  return {
    netlist,
    extraNodes,
    branches,
    size,
    solver: new DenseSolver(Math.max(1, size)),
    rhs: new Float64Array(Math.max(1, size)),
    internalNode,
  };
}

interface History {
  /** Previous voltage across each element. */
  voltage: Float64Array;
  /** Previous current through each element. */
  current: Float64Array;
}

const MAX_NEWTON = 60;

/**
 * Solves the circuit at one instant.
 *
 * `history` is null for a DC operating point, in which case capacitors are
 * open and inductors are shorts. Otherwise it holds the previous step, and the
 * reactive elements use their companion models.
 */
function solveInstant(
  asm: Assembly,
  world: CircuitWorld,
  t: number,
  h: number,
  history: History | null,
  previous: CircuitState,
  useBackwardEuler: boolean,
): CircuitState {
  const { netlist, branches, size, solver, rhs, internalNode } = asm;
  const elements = netlist.active;
  const nodes = netlist.nodeCount + asm.extraNodes;

  const voltage = new Float64Array(elements.length);
  const current = new Float64Array(elements.length);
  const nodeVoltage = new Float64Array(netlist.nodeCount);
  const blown = previous.blown.slice();

  /* Newton needs two different "previous" voltages per junction and confusing
   * them is fatal.
   *
   * `raw` is the junction voltage the last *solve* produced — the point to
   * linearise about. `limited` is the value actually used last *iteration*,
   * which is what the junction limiter measures its step against. Passing the
   * previous timestep as the limiter's reference instead pins every iteration
   * back near where the circuit started: an LED asked to turn on is held at
   * zero volts for all sixty iterations, and the solver reports the whole
   * supply across a diode that should be conducting 13 mA.
   */
  const raw = Float64Array.from(previous.elementVoltage.subarray(0, elements.length));
  const limited = Float64Array.from(raw);

  let converged = false;
  let iterations = 0;
  let solved = new Float64Array(size);

  for (let iter = 0; iter < MAX_NEWTON; iter++) {
    iterations = iter + 1;
    solver.reset(size);
    rhs.fill(0);

    const stampConductance = (a: number, b: number, g: number) => {
      if (a >= 0) solver.add(size, a, a, g);
      if (b >= 0) solver.add(size, b, b, g);
      if (a >= 0 && b >= 0) {
        solver.add(size, a, b, -g);
        solver.add(size, b, a, -g);
      }
    };
    const stampCurrent = (a: number, b: number, i: number) => {
      if (a >= 0) rhs[a] -= i;
      if (b >= 0) rhs[b] += i;
    };

    for (let n = 0; n < nodes; n++) solver.add(size, n, n, GMIN);

    elements.forEach((e, i) => {
      const a = netlist.nodeA[i];
      const b = netlist.nodeB[i];
      switch (e.kind) {
        case 'resistor':
        case 'bulb':
        case 'thermistor':
        case 'voltmeter':
        case 'switch':
        case 'fuse':
          stampConductance(a, b, 1 / staticResistance(e, world.temperature, blown[i]));
          break;
        case 'capacitor': {
          if (!history) {
            // DC: an ideal capacitor passes nothing. GMIN alone keeps the node
            // it isolates from floating out of the matrix.
            break;
          }
          const c = Math.max(1e-15, e.values.capacitance);
          const geq = useBackwardEuler ? c / h : (2 * c) / h;
          const ieq = useBackwardEuler
            ? geq * history.voltage[i]
            : geq * history.voltage[i] + history.current[i];
          stampConductance(a, b, geq);
          stampCurrent(a, b, -ieq);
          break;
        }
        case 'diode':
        case 'led': {
          const n = e.values.ideality;
          const rated = e.kind === 'led' ? e.values.rating : 0.02;
          const is = saturationCurrent(e.values.forward, n, rated);
          const vcrit = n * VT * Math.log((n * VT) / (Math.SQRT2 * is));
          const vd = limitJunction(raw[i], limited[i], n * VT, vcrit);
          limited[i] = vd;
          const ex = Math.exp(Math.min(vd / (n * VT), 80));
          const id = is * (ex - 1);
          const gd = (is * ex) / (n * VT) + GMIN;
          stampConductance(a, b, gd);
          stampCurrent(a, b, id - gd * vd);
          break;
        }
        default:
          break;
      }
    });

    branches.forEach((br, k) => {
      const row = nodes + k;
      const e = elements[br.element];
      const p = br.nodeP;
      const n = br.nodeN;
      if (p >= 0) {
        solver.add(size, p, row, 1);
        solver.add(size, row, p, 1);
      }
      if (n >= 0) {
        solver.add(size, n, row, -1);
        solver.add(size, row, n, -1);
      }
      if (br.kind === 'source') {
        rhs[row] = sourceVoltage(e, t);
      } else if (br.kind === 'ammeter') {
        rhs[row] = 0;
      } else {
        const l = Math.max(1e-12, e.values.inductance);
        if (!history) {
          // DC: an inductor is a piece of wire, so the branch equation is
          // simply v = 0 with the current left as the unknown.
          rhs[row] = 0;
        } else {
          const req = useBackwardEuler ? l / h : (2 * l) / h;
          solver.add(size, row, row, -req);
          rhs[row] = useBackwardEuler
            ? -req * history.current[br.element]
            : -req * history.current[br.element] - history.voltage[br.element];
        }
      }
    });

    // The internal resistance of each source, between its internal node and
    // the terminal the netlist thinks of as a.
    elements.forEach((e, i) => {
      if (internalNode[i] < 0) return;
      stampConductance(internalNode[i], netlist.nodeA[i], 1 / Math.max(1e-9, e.values.internal));
    });

    if (!solver.solveInPlace(size, rhs)) {
      return {
        nodeVoltage,
        elementVoltage: voltage,
        elementCurrent: current,
        blown,
        converged: false,
        iterations,
      };
    }
    solved = rhs.slice(0, size);

    // Did the nonlinear devices settle? The residual is between what the
    // solve produced and the point it was linearised about.
    let worst = 0;
    let anyNonlinear = false;
    elements.forEach((e, i) => {
      if (e.kind !== 'diode' && e.kind !== 'led') return;
      anyNonlinear = true;
      const va = netlist.nodeA[i] >= 0 ? solved[netlist.nodeA[i]] : 0;
      const vb = netlist.nodeB[i] >= 0 ? solved[netlist.nodeB[i]] : 0;
      raw[i] = va - vb;
      worst = Math.max(worst, Math.abs(raw[i] - limited[i]));
    });
    if (!anyNonlinear || worst < 1e-10) {
      converged = true;
      break;
    }
  }

  for (let n = 0; n < netlist.nodeCount; n++) nodeVoltage[n] = solved[n];

  // Recover per-element voltages and currents.
  const branchOfElement = new Map(branches.map((b, k) => [b.element, k]));
  elements.forEach((e, i) => {
    const a = netlist.nodeA[i];
    const b = netlist.nodeB[i];
    const va = a >= 0 ? solved[a] : 0;
    const vb = b >= 0 ? solved[b] : 0;
    voltage[i] = va - vb;

    const branchIndex = branchOfElement.get(i);
    if (branchIndex !== undefined) {
      // The branch unknown is the current flowing from nodeP to nodeN inside
      // the element. For a source with internal resistance nodeP is the
      // internal node, but the current is the same either way.
      current[i] = solved[nodes + branchIndex];
      return;
    }
    switch (e.kind) {
      case 'resistor':
      case 'bulb':
      case 'thermistor':
      case 'voltmeter':
      case 'switch':
      case 'fuse':
        current[i] = voltage[i] / staticResistance(e, world.temperature, blown[i]);
        break;
      case 'capacitor': {
        if (!history) {
          current[i] = 0;
        } else {
          const c = Math.max(1e-15, e.values.capacitance);
          const geq = useBackwardEuler ? c / h : (2 * c) / h;
          const ieq = useBackwardEuler
            ? geq * history.voltage[i]
            : geq * history.voltage[i] + history.current[i];
          current[i] = geq * voltage[i] - ieq;
        }
        break;
      }
      case 'diode':
      case 'led': {
        const n = e.values.ideality;
        const rated = e.kind === 'led' ? e.values.rating : 0.02;
        const is = saturationCurrent(e.values.forward, n, rated);
        current[i] = is * (Math.exp(Math.min(voltage[i] / (n * VT), 80)) - 1);
        break;
      }
      default:
        current[i] = 0;
    }
  });

  // Fuses latch open. Checking after the solve rather than during means the
  // step in which the fuse blows still shows the current that blew it, which
  // is the number a student wants to see.
  elements.forEach((e, i) => {
    if (e.kind !== 'fuse' || blown[i]) return;
    if (Math.abs(current[i]) > e.values.rating) blown[i] = true;
  });

  return { nodeVoltage, elementVoltage: voltage, elementCurrent: current, blown, converged, iterations };
}

function emptyState(count: number, nodes: number): CircuitState {
  return {
    nodeVoltage: new Float64Array(nodes),
    elementVoltage: new Float64Array(count),
    elementCurrent: new Float64Array(count),
    blown: new Array(count).fill(false),
    converged: true,
    iterations: 0,
  };
}

/** The steady state: capacitors open, inductors shorted, sources at t = 0. */
export function operatingPoint(world: CircuitWorld, netlist = buildNetlist(world)): CircuitState {
  const asm = assemble(netlist);
  const zero = emptyState(netlist.active.length, netlist.nodeCount);
  if (netlist.problems.length) return zero;
  return solveInstant(asm, world, 0, 1, null, zero, false);
}

// ------------------------------------------------------------------ transient

export interface CircuitTrajectory {
  world: CircuitWorld;
  netlist: Netlist;
  asm: Assembly;
  /** Integration step. */
  h: number;
  /** Only every `decimation`-th step is stored. */
  decimation: number;
  count: number;
  time: Float64Array;
  voltage: Float64Array;
  current: Float64Array;
  /** ∫I dt through each element, from t = 0 to each stored sample.
   *
   * The flow animation needs *where the charge has got to*, not how fast it is
   * moving now. Driving the dots from I(t)·t instead — which is what this
   * replaced — makes them run backwards down a discharging RC circuit, because
   * t·e^(−t/τ) turns over at t = τ while the current has not reversed at all. */
  charge: Float64Array;
  nodeVoltage: Float64Array;
  /** Largest |I| seen anywhere in the circuit over the whole run so far. A
   * per-instant maximum would make every branch race at a zero crossing of an
   * AC supply, where everything is small and their *ratio* is meaningless. */
  peakCurrent: number;
  /** Running ∫I dt, ahead of the last stored sample. */
  accumulated: Float64Array;
  failed: boolean;
  failure: string | null;
  /** Live state, at `liveTime`. */
  state: CircuitState;
  history: History;
  liveTime: number;
  stepsTaken: number;
}

const MAX_CIRCUIT_SAMPLES = 20000;

/**
 * Picks a timestep from the fastest time constant present.
 *
 * Fifty steps per time constant is comfortably enough for trapezoidal
 * integration to draw a visually exact exponential, and the bound below keeps
 * a 1 µF/100 Ω pair from asking for a step so small that a ten-second timeline
 * would need ten million of them.
 */
export function suggestedTimestep(world: CircuitWorld, netlist: Netlist, duration: number): number {
  let smallest = Infinity;
  let resistance = 0;
  let count = 0;
  for (const e of netlist.active) {
    const r = staticResistance(e, world.temperature, false);
    if (Number.isFinite(r) && r < R_OPEN / 2) {
      resistance += r;
      count++;
    }
  }
  const typical = count ? resistance / count : 1000;
  for (const e of netlist.active) {
    if (e.kind === 'capacitor') smallest = Math.min(smallest, typical * Math.max(1e-15, e.values.capacitance));
    if (e.kind === 'inductor') smallest = Math.min(smallest, Math.max(1e-12, e.values.inductance) / Math.max(1e-6, typical));
    if (e.kind === 'ac') smallest = Math.min(smallest, 1 / Math.max(1e-6, e.values.frequency));
  }
  if (!Number.isFinite(smallest)) return Math.max(1e-6, duration / 2000);
  return Math.max(1e-9, Math.min(smallest / 50, duration / 200));
}

export function createCircuitTrajectory(world: CircuitWorld, duration: number): CircuitTrajectory {
  const netlist = buildNetlist(world);
  const asm = assemble(netlist);
  const n = netlist.active.length;
  const h = world.timestep > 0 ? world.timestep : suggestedTimestep(world, netlist, Math.max(0.001, duration));
  const decimation = Math.max(1, Math.ceil(duration / h / MAX_CIRCUIT_SAMPLES));

  const state = emptyState(n, netlist.nodeCount);
  // Capacitors and inductors start where the user said they should, which is
  // what makes "a charged capacitor discharging" a one-field experiment.
  netlist.active.forEach((e, i) => {
    if (e.kind === 'capacitor') state.elementVoltage[i] = e.values.initial ?? 0;
    if (e.kind === 'inductor') state.elementCurrent[i] = e.values.initial ?? 0;
  });

  const cap = 1024;
  const traj: CircuitTrajectory = {
    world,
    netlist,
    asm,
    h,
    decimation,
    count: 0,
    time: new Float64Array(cap),
    voltage: new Float64Array(cap * n),
    current: new Float64Array(cap * n),
    charge: new Float64Array(cap * n),
    nodeVoltage: new Float64Array(cap * netlist.nodeCount),
    peakCurrent: 0,
    accumulated: new Float64Array(n),
    failed: netlist.problems.length > 0,
    failure: netlist.problems[0] ?? null,
    state,
    history: { voltage: Float64Array.from(state.elementVoltage), current: Float64Array.from(state.elementCurrent) },
    liveTime: 0,
    stepsTaken: 0,
  };

  if (!traj.failed) {
    /* The first stored sample must be the circuit *at* t = 0, not one step
     * past it. Solving it with the ordinary companion models advances the
     * state by h while labelling it t = 0, and every subsequent reading is
     * then a step early — an error that hides beautifully, because the curve
     * still has exactly the right shape and time constant and is merely
     * shifted by a step nobody can see.
     *
     * Passing a vanishingly small step instead turns each capacitor's
     * companion conductance C/h into something enormous with a matching
     * current source, which is precisely an ideal voltage source at its
     * initial voltage; the same limit makes an inductor an ideal current
     * source. That is the textbook way to impose initial conditions, and it
     * falls out of the code that is already here.
     */
    const first = solveInstant(asm, world, 0, h * 1e-6, traj.history, state, true);
    traj.state = first;
    for (let i = 0; i < n; i++) {
      traj.peakCurrent = Math.max(traj.peakCurrent, Math.abs(first.elementCurrent[i]));
    }
    pushCircuit(traj, 0);
  }
  return traj;
}

function growCircuit(traj: CircuitTrajectory): void {
  const n = traj.netlist.active.length;
  const nn = traj.netlist.nodeCount;
  const cap = traj.time.length * 2;
  const next = (old: Float64Array, stride: number) => {
    const arr = new Float64Array(cap * stride);
    arr.set(old.subarray(0, traj.count * stride));
    return arr;
  };
  traj.time = next(traj.time, 1);
  traj.voltage = next(traj.voltage, n);
  traj.current = next(traj.current, n);
  traj.charge = next(traj.charge, n);
  traj.nodeVoltage = next(traj.nodeVoltage, nn);
}

function pushCircuit(traj: CircuitTrajectory, t: number): void {
  if (traj.count >= traj.time.length) growCircuit(traj);
  const n = traj.netlist.active.length;
  const nn = traj.netlist.nodeCount;
  const k = traj.count;
  traj.time[k] = t;
  if (n) {
    traj.voltage.set(traj.state.elementVoltage, k * n);
    traj.current.set(traj.state.elementCurrent, k * n);
    traj.charge.set(traj.accumulated, k * n);
  }
  if (nn) traj.nodeVoltage.set(traj.state.nodeVoltage, k * nn);
  traj.count = k + 1;
}

/** Extends the transient to at least `until` seconds, within a step budget. */
export function advanceCircuit(traj: CircuitTrajectory, until: number, budget = 20000): boolean {
  if (traj.failed) return true;
  let done = 0;
  while (traj.liveTime < until - 1e-15) {
    if (done >= budget) return false;
    if (traj.count >= MAX_CIRCUIT_SAMPLES) return true;
    traj.history.voltage.set(traj.state.elementVoltage);
    traj.history.current.set(traj.state.elementCurrent);
    const t = traj.liveTime + traj.h;
    // Backward Euler for the very first step damps the trapezoidal ringing
    // that a step input would otherwise produce; SPICE does the same at every
    // breakpoint.
    const next = solveInstant(traj.asm, traj.world, t, traj.h, traj.history, traj.state, traj.stepsTaken === 0);
    if (!next.converged) {
      traj.failed = true;
      traj.failure =
        'The solver could not converge — check for a source shorted by a wire, or a component with an impossible value.';
      return true;
    }
    // Trapezoidal, to match the integrator the companion models use: over one
    // step the current is taken as a straight line between its two endpoints.
    const n = traj.netlist.active.length;
    for (let i = 0; i < n; i++) {
      const before = traj.history.current[i];
      const after = next.elementCurrent[i];
      traj.accumulated[i] += ((before + after) / 2) * traj.h;
      const size = Math.abs(after);
      if (size > traj.peakCurrent) traj.peakCurrent = size;
    }
    traj.state = next;
    traj.liveTime = t;
    traj.stepsTaken++;
    if (traj.stepsTaken % traj.decimation === 0) pushCircuit(traj, t);
    done++;
  }
  return true;
}

export function circuitSampleAt(traj: CircuitTrajectory, t: number): number {
  if (traj.count === 0) return 0;
  const spacing = traj.h * traj.decimation;
  return Math.min(traj.count - 1, Math.max(0, Math.round(t / spacing)));
}

// ------------------------------------------------------------------ readings

export type ReadingKind =
  | 'voltage'
  | 'current'
  | 'power'
  | 'charge'
  | 'resistance'
  | 'brightness'
  | 'stored';

export interface Reading {
  id: string;
  kind: ReadingKind;
  /** Element id. */
  target: string;
  colour: string;
  visible: boolean;
}

export const READING_INFO: Record<ReadingKind, { label: string; unit: string }> = {
  voltage: { label: 'Voltage across', unit: 'V' },
  current: { label: 'Current through', unit: 'A' },
  power: { label: 'Power', unit: 'W' },
  charge: { label: 'Charge stored', unit: 'C' },
  resistance: { label: 'Resistance', unit: 'Ω' },
  brightness: { label: 'Brightness', unit: '' },
  stored: { label: 'Energy stored', unit: 'J' },
};

/** Which readings make sense for a given part. */
export function availableReadings(kind: ElementKind): ReadingKind[] {
  switch (kind) {
    case 'capacitor':
      return ['voltage', 'current', 'charge', 'stored', 'power'];
    case 'inductor':
      return ['current', 'voltage', 'stored', 'power'];
    case 'bulb':
      return ['power', 'brightness', 'current', 'voltage'];
    case 'led':
      return ['current', 'voltage', 'brightness', 'power'];
    case 'thermistor':
      return ['resistance', 'current', 'voltage', 'power'];
    case 'ammeter':
      return ['current'];
    case 'voltmeter':
      return ['voltage'];
    case 'ground':
    case 'wire':
      return [];
    default:
      return ['voltage', 'current', 'power'];
  }
}

/**
 * Turns one element's voltage and current into whichever quantity was asked
 * for.
 *
 * Kept separate from the trajectory so the steady-state panel and the
 * over-time chart go through exactly the same arithmetic. They did not, once,
 * and the steady-state panel quietly showed a dash for every reading that was
 * not a voltage, a current or a power.
 */
export function readingValue(
  e: CircuitElement,
  voltage: number,
  current: number,
  kind: ReadingKind,
  temperature: number,
  blown = false,
): number {
  switch (kind) {
    case 'voltage':
      return voltage;
    case 'current':
      return current;
    case 'power':
      // Passive sign convention: positive means the part is absorbing power,
      // so a discharging cell reads negative. That is the convention every
      // circuits course uses, and the panel says so beside the number.
      return voltage * current;
    case 'charge':
      return e.kind === 'capacitor' ? e.values.capacitance * voltage : NaN;
    case 'stored':
      if (e.kind === 'capacitor') return 0.5 * e.values.capacitance * voltage * voltage;
      if (e.kind === 'inductor') return 0.5 * e.values.inductance * current * current;
      return NaN;
    case 'resistance': {
      const rr = staticResistance(e, temperature, blown);
      return Number.isFinite(rr) ? rr : NaN;
    }
    case 'brightness': {
      if (e.kind === 'bulb') return Math.min(1, Math.abs(voltage * current) / Math.max(1e-9, e.values.rating));
      if (e.kind === 'led') return Math.min(1, Math.max(0, current) / Math.max(1e-9, e.values.rating));
      return NaN;
    }
    default:
      return NaN;
  }
}

export function readCircuit(traj: CircuitTrajectory, r: Reading, k: number): number {
  const i = traj.netlist.active.findIndex((e) => e.id === r.target);
  if (i < 0 || k < 0 || k >= traj.count) return NaN;
  const n = traj.netlist.active.length;
  return readingValue(
    traj.netlist.active[i],
    traj.voltage[k * n + i],
    traj.current[k * n + i],
    r.kind,
    traj.world.temperature,
    traj.state.blown[i],
  );
}

export function readingLabel(world: CircuitWorld, r: Reading): string {
  const e = world.elements.find((x) => x.id === r.target);
  return `${READING_INFO[r.kind].label} ${e?.label ?? '?'}`;
}
