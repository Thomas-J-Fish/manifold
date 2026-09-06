/* Optimisation and operations research.
 *
 * Three methods that are taught apart and are the same subject: find the best
 * point in a set. What differs is what the set is and what "best" is allowed to
 * look like, and each of the three is drawn here rather than described.
 *
 *   Linear programming — the feasible region is a polygon, the objective is a
 *     plane, and the optimum is at a corner. The simplex method walks corners,
 *     so its path is a sequence of vertices and can be drawn on the region it
 *     is walking. Implemented as a real two-phase tableau rather than by
 *     enumerating vertices and picking the best, because the point of the mode
 *     is the *path*, and enumeration has no path.
 *
 *   Gradient descent — the set is the whole plane and the objective is any
 *     surface you type. The interesting content is that the method's behaviour
 *     depends on the step size and the conditioning in ways you can watch.
 *
 *   Lagrange multipliers — the set is a curve. At the optimum the objective's
 *     gradient is parallel to the constraint's, and λ is the ratio. That is a
 *     geometric statement and it is drawn as one: two arrows, pointing along
 *     the same line.
 *
 * Everything here is plain numbers in and plain numbers out, so it is all
 * testable against problems with known answers.
 */

// ------------------------------------------------------------------- linear

export type Relation = '<=' | '>=' | '=';

export interface Constraint {
  id: string;
  /** Coefficients, one per decision variable. */
  coefficients: number[];
  relation: Relation;
  /** Right-hand side. */
  rhs: number;
  label: string;
}

export interface LinearProgram {
  /** Objective coefficients, one per decision variable. */
  objective: number[];
  maximise: boolean;
  constraints: Constraint[];
  /** Whether every variable is required to be non-negative, as in standard form. */
  nonNegative: boolean;
}

export type LpStatus = 'optimal' | 'unbounded' | 'infeasible';

export interface SimplexStep {
  /** The decision variables at this basic feasible solution. */
  point: number[];
  /** Objective value there. */
  value: number;
  /** Which variable entered the basis to get here, and which left. */
  entering: string | null;
  leaving: string | null;
  /** Phase one is finding a feasible corner at all; phase two is improving. */
  phase: 1 | 2;
}

export interface LpResult {
  status: LpStatus;
  /** The optimal decision variables, when there is an optimum. */
  point: number[] | null;
  value: number | null;
  /** Every basic feasible solution the method visited, in order. */
  path: SimplexStep[];
  /** Shadow price per constraint: how much the optimum moves per unit of rhs. */
  shadowPrices: number[];
  message: string;
}

interface Tableau {
  /** rows × columns, the last column being the right-hand side. */
  a: number[][];
  /** Column index of the basic variable in each row. */
  basis: number[];
  names: string[];
  rows: number;
  columns: number;
}

const EPS = 1e-9;

/**
 * Two-phase simplex.
 *
 * Phase one drives a set of artificial variables to zero to find *a* corner;
 * phase two walks corners uphill from there. Bland's rule — always the
 * lowest-numbered eligible column — is used for the entering variable rather
 * than steepest ascent, because Bland's rule cannot cycle and a degenerate
 * problem that spins for ever is a much worse failure in a teaching tool than
 * a couple of extra pivots.
 */
export function solveLinearProgram(lp: LinearProgram): LpResult {
  const n = lp.objective.length;
  const constraints = lp.constraints.filter((c) => c.coefficients.length === n);
  const m = constraints.length;
  if (n === 0) {
    return { status: 'optimal', point: [], value: 0, path: [], shadowPrices: [], message: 'Nothing to optimise.' };
  }

  /* Every constraint is written with a non-negative right-hand side, which is
   * what lets the slack basis be read off directly. Negating a row flips its
   * relation, so this has to happen before slacks are chosen. */
  const rows = constraints.map((c) => {
    let coefficients = [...c.coefficients];
    let relation = c.relation;
    let rhs = c.rhs;
    if (rhs < 0) {
      coefficients = coefficients.map((v) => -v);
      rhs = -rhs;
      relation = relation === '<=' ? '>=' : relation === '>=' ? '<=' : '=';
    }
    return { coefficients, relation, rhs };
  });

  const names: string[] = [];
  for (let i = 0; i < n; i++) names.push(`x${i + 1}`);
  const slackOf: number[] = [];
  const artificialOf: number[] = [];
  for (let i = 0; i < m; i++) {
    slackOf.push(rows[i].relation === '=' ? -1 : names.push(`s${i + 1}`) - 1);
  }
  for (let i = 0; i < m; i++) {
    // A '<=' row already has a basic slack; the others need an artificial.
    artificialOf.push(rows[i].relation === '<=' ? -1 : names.push(`a${i + 1}`) - 1);
  }

  const columns = names.length + 1;
  const a: number[][] = [];
  const basis: number[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Array<number>(columns).fill(0);
    for (let j = 0; j < n; j++) row[j] = rows[i].coefficients[j];
    if (slackOf[i] >= 0) row[slackOf[i]] = rows[i].relation === '<=' ? 1 : -1;
    if (artificialOf[i] >= 0) row[artificialOf[i]] = 1;
    row[columns - 1] = rows[i].rhs;
    a.push(row);
    basis.push(artificialOf[i] >= 0 ? artificialOf[i] : slackOf[i]);
  }

  const tableau: Tableau = { a, basis, names, rows: m, columns };
  const path: SimplexStep[] = [];
  const record = (phase: 1 | 2, entering: string | null, leaving: string | null) => {
    const point = decisionPoint(tableau, n);
    path.push({ point, value: dot(lp.objective, point), entering, leaving, phase });
  };

  const needsPhaseOne = artificialOf.some((v) => v >= 0);
  if (needsPhaseOne) {
    // Minimise the sum of the artificials, which is the same as maximising its
    // negation; feasible exactly when that reaches zero.
    const cost = new Array<number>(columns).fill(0);
    for (const col of artificialOf) if (col >= 0) cost[col] = -1;
    const outcome = run(tableau, cost, record, 1);
    if (outcome === 'unbounded') {
      return { status: 'infeasible', point: null, value: null, path, shadowPrices: [], message: 'Phase one did not terminate.' };
    }
    const residual = artificialOf.reduce((sum, col, i) => (col >= 0 && tableau.basis[i] === col ? sum + tableau.a[i][columns - 1] : sum), 0);
    if (residual > 1e-7) {
      return {
        status: 'infeasible',
        point: null,
        value: null,
        path,
        shadowPrices: [],
        message: 'No point satisfies every constraint at once — the feasible region is empty.',
      };
    }
    /* Drive any artificial still sitting in the basis at value zero out of it,
     * so phase two never pivots on a column that is about to be deleted. If a
     * row has no non-artificial column to pivot on it is a redundant
     * constraint, and dropping it is exactly right. */
    for (let i = 0; i < tableau.rows; i++) {
      if (!artificialOf.includes(tableau.basis[i])) continue;
      let pivot = -1;
      for (let j = 0; j < names.length; j++) {
        if (artificialOf.includes(j)) continue;
        if (Math.abs(tableau.a[i][j]) > EPS) {
          pivot = j;
          break;
        }
      }
      if (pivot >= 0) pivotOn(tableau, i, pivot);
    }
  }

  // Phase two maximises; a minimisation is the same walk on the negated
  // objective, and only the reported value is flipped back.
  const sign = lp.maximise ? 1 : -1;
  const cost = new Array<number>(columns).fill(0);
  for (let j = 0; j < n; j++) cost[j] = sign * lp.objective[j];
  // Artificials are pinned out of the basis for good.
  for (const col of artificialOf) if (col >= 0) cost[col] = -Infinity;

  if (!needsPhaseOne) record(2, null, null);
  const outcome = run(tableau, cost, record, 2);
  if (outcome === 'unbounded') {
    return {
      status: 'unbounded',
      point: null,
      value: null,
      path,
      shadowPrices: [],
      message: 'The objective improves for ever — the feasible region is open in the direction that helps.',
    };
  }

  const point = decisionPoint(tableau, n);
  const value = dot(lp.objective, point);

  /* Shadow prices are the phase-two reduced costs of the slack columns: the
   * rate the optimum changes per unit of right-hand side. A constraint with a
   * price of zero is not binding, and slackening it buys nothing. */
  const shadowPrices = constraints.map((_, i) => {
    const col = slackOf[i];
    if (col < 0) return 0;
    const reduced = reducedCost(tableau, cost, col);
    const price = -reduced * sign;
    return Math.abs(price) < 1e-9 ? 0 : price;
  });

  return { status: 'optimal', point, value, path, shadowPrices, message: 'Optimal.' };
}

function run(
  t: Tableau,
  cost: number[],
  record: (phase: 1 | 2, entering: string | null, leaving: string | null) => void,
  phase: 1 | 2,
): 'optimal' | 'unbounded' {
  for (let guard = 0; guard < 500; guard++) {
    // Bland's rule: the lowest-index column with a positive reduced cost.
    let entering = -1;
    for (let j = 0; j < t.columns - 1; j++) {
      if (!Number.isFinite(cost[j])) continue;
      if (t.basis.includes(j)) continue;
      if (reducedCost(t, cost, j) > 1e-10) {
        entering = j;
        break;
      }
    }
    if (entering < 0) return 'optimal';

    // Minimum ratio, ties broken by the lowest basic-variable index — the
    // other half of Bland's rule, and the half that stops the cycling.
    let leaving = -1;
    let best = Infinity;
    for (let i = 0; i < t.rows; i++) {
      const d = t.a[i][entering];
      if (d <= EPS) continue;
      const ratio = t.a[i][t.columns - 1] / d;
      if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && (leaving < 0 || t.basis[i] < t.basis[leaving]))) {
        best = ratio;
        leaving = i;
      }
    }
    if (leaving < 0) return 'unbounded';

    const leavingName = t.names[t.basis[leaving]];
    pivotOn(t, leaving, entering);
    record(phase, t.names[entering], leavingName);
  }
  return 'optimal';
}

/** c_j − c_B B⁻¹ A_j, computed directly from the current tableau. */
function reducedCost(t: Tableau, cost: number[], column: number): number {
  let z = 0;
  for (let i = 0; i < t.rows; i++) {
    const basic = cost[t.basis[i]];
    if (!Number.isFinite(basic)) continue;
    z += basic * t.a[i][column];
  }
  return cost[column] - z;
}

function pivotOn(t: Tableau, row: number, column: number): void {
  const p = t.a[row][column];
  for (let j = 0; j < t.columns; j++) t.a[row][j] /= p;
  for (let i = 0; i < t.rows; i++) {
    if (i === row) continue;
    const factor = t.a[i][column];
    if (Math.abs(factor) < 1e-15) continue;
    for (let j = 0; j < t.columns; j++) t.a[i][j] -= factor * t.a[row][j];
  }
  t.basis[row] = column;
}

function decisionPoint(t: Tableau, n: number): number[] {
  const point = new Array<number>(n).fill(0);
  for (let i = 0; i < t.rows; i++) {
    const b = t.basis[i];
    if (b < n) point[b] = t.a[i][t.columns - 1];
  }
  return point.map((v) => (Math.abs(v) < 1e-10 ? 0 : v));
}

const dot = (a: number[], b: number[]): number => a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);

/**
 * The feasible region of a two-variable program, as a convex polygon.
 *
 * Every pair of constraint lines is intersected and the intersections that
 * satisfy all the other constraints are kept — the vertices of the region are
 * exactly those points. Sorting them by angle about their own centroid gives
 * the boundary in order, which is valid because the region is convex, being an
 * intersection of half-planes.
 */
export function feasibleRegion(lp: LinearProgram, bound = 1e4): { x: number; y: number }[] {
  if (lp.objective.length !== 2) return [];
  const lines = lp.constraints
    .filter((c) => c.coefficients.length === 2)
    .map((c) => ({ a: c.coefficients[0], b: c.coefficients[1], c: c.rhs, relation: c.relation }));
  if (lp.nonNegative) {
    lines.push({ a: -1, b: 0, c: 0, relation: '<=' as Relation });
    lines.push({ a: 0, b: -1, c: 0, relation: '<=' as Relation });
  }
  // A box, so an unbounded region still draws as something rather than as
  // nothing. It is far enough out to be obviously not part of the problem.
  lines.push({ a: 1, b: 0, c: bound, relation: '<=' as Relation });
  lines.push({ a: -1, b: 0, c: bound, relation: '<=' as Relation });
  lines.push({ a: 0, b: 1, c: bound, relation: '<=' as Relation });
  lines.push({ a: 0, b: -1, c: bound, relation: '<=' as Relation });

  const satisfies = (x: number, y: number) =>
    lines.every((l) => {
      const v = l.a * x + l.b * y;
      const tol = 1e-7 * (1 + Math.abs(l.c));
      if (l.relation === '<=') return v <= l.c + tol;
      if (l.relation === '>=') return v >= l.c - tol;
      return Math.abs(v - l.c) <= tol;
    });

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = lines[i];
      const q = lines[j];
      const det = p.a * q.b - q.a * p.b;
      if (Math.abs(det) < 1e-12) continue;
      const x = (p.c * q.b - q.c * p.b) / det;
      const y = (p.a * q.c - q.a * p.c) / det;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (satisfies(x, y)) points.push({ x, y });
    }
  }
  if (points.length < 3) return points;

  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const ordered = [...points].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));

  // Duplicates arise wherever three constraints meet at one corner.
  const out: { x: number; y: number }[] = [];
  for (const p of ordered) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-7) continue;
    out.push(p);
  }
  if (out.length > 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-7) out.pop();
  }
  return out;
}

// ------------------------------------------------------------------ descent

export type DescentMethod = 'gradient' | 'momentum' | 'nesterov' | 'adam' | 'newton';

export interface DescentOptions {
  method: DescentMethod;
  /** Learning rate. */
  rate: number;
  /** Momentum coefficient, for the methods that have one. */
  momentum: number;
  steps: number;
  start: [number, number];
  /** Stop once the gradient is smaller than this. */
  tolerance: number;
}

export interface DescentResult {
  path: { x: number; y: number; f: number; gradient: number }[];
  converged: boolean;
  /** True when the iterates ran away rather than settling. */
  diverged: boolean;
  final: { x: number; y: number; f: number } | null;
}

/** Central-difference gradient, with a step scaled to the point's own size. */
export function numericGradient(f: (x: number, y: number) => number, x: number, y: number): [number, number] {
  const hx = 1e-5 * (1 + Math.abs(x));
  const hy = 1e-5 * (1 + Math.abs(y));
  return [(f(x + hx, y) - f(x - hx, y)) / (2 * hx), (f(x, y + hy) - f(x, y - hy)) / (2 * hy)];
}

/** Central-difference Hessian, for the Newton step. */
export function numericHessian(
  f: (x: number, y: number) => number,
  x: number,
  y: number,
): [[number, number], [number, number]] {
  const h = 1e-4 * (1 + Math.max(Math.abs(x), Math.abs(y)));
  const fxx = (f(x + h, y) - 2 * f(x, y) + f(x - h, y)) / (h * h);
  const fyy = (f(x, y + h) - 2 * f(x, y) + f(x, y - h)) / (h * h);
  const fxy = (f(x + h, y + h) - f(x + h, y - h) - f(x - h, y + h) + f(x - h, y - h)) / (4 * h * h);
  return [
    [fxx, fxy],
    [fxy, fyy],
  ];
}

/**
 * Walks downhill and records every step.
 *
 * The point of drawing the path rather than only the answer is that the path
 * is where the differences between the methods live: plain descent crawls
 * along a valley floor and zig-zags across it, momentum overshoots and comes
 * back, Adam rescales each axis and goes almost straight, and Newton — which
 * uses the curvature rather than only the slope — arrives in one step on a
 * quadratic and can walk *uphill* on anything with a saddle in it.
 */
export function gradientDescent(f: (x: number, y: number) => number, opts: DescentOptions): DescentResult {
  const path: DescentResult['path'] = [];
  let [x, y] = opts.start;
  let vx = 0;
  let vy = 0;
  let mx = 0;
  let my = 0;
  let sx = 0;
  let sy = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const steps = Math.max(1, Math.min(20000, Math.round(opts.steps)));
  let converged = false;
  let diverged = false;

  for (let k = 0; k < steps; k++) {
    const value = f(x, y);
    if (!Number.isFinite(value) || Math.abs(x) > 1e8 || Math.abs(y) > 1e8) {
      diverged = true;
      break;
    }
    // Nesterov looks ahead along the momentum before measuring the slope,
    // which is the whole of the difference between it and plain momentum.
    const gx0 = opts.method === 'nesterov' ? x + opts.momentum * vx : x;
    const gy0 = opts.method === 'nesterov' ? y + opts.momentum * vy : y;
    const [gx, gy] = numericGradient(f, gx0, gy0);
    const norm = Math.hypot(gx, gy);
    path.push({ x, y, f: value, gradient: norm });
    if (!Number.isFinite(norm)) {
      diverged = true;
      break;
    }
    if (norm < opts.tolerance) {
      converged = true;
      break;
    }

    switch (opts.method) {
      case 'momentum':
      case 'nesterov': {
        vx = opts.momentum * vx - opts.rate * gx;
        vy = opts.momentum * vy - opts.rate * gy;
        x += vx;
        y += vy;
        break;
      }
      case 'adam': {
        mx = beta1 * mx + (1 - beta1) * gx;
        my = beta1 * my + (1 - beta1) * gy;
        sx = beta2 * sx + (1 - beta2) * gx * gx;
        sy = beta2 * sy + (1 - beta2) * gy * gy;
        const t = k + 1;
        const mhx = mx / (1 - beta1 ** t);
        const mhy = my / (1 - beta1 ** t);
        const shx = sx / (1 - beta2 ** t);
        const shy = sy / (1 - beta2 ** t);
        x -= (opts.rate * mhx) / (Math.sqrt(shx) + 1e-8);
        y -= (opts.rate * mhy) / (Math.sqrt(shy) + 1e-8);
        break;
      }
      case 'newton': {
        const [[hxx, hxy], [, hyy]] = numericHessian(f, x, y);
        const det = hxx * hyy - hxy * hxy;
        if (Math.abs(det) < 1e-12) {
          x -= opts.rate * gx;
          y -= opts.rate * gy;
        } else {
          // H⁻¹∇f. No damping and no positive-definiteness check: on a saddle
          // this walks to the saddle, which is the honest behaviour of the
          // method and worth being able to see.
          x -= opts.rate * ((hyy * gx - hxy * gy) / det);
          y -= opts.rate * ((hxx * gy - hxy * gx) / det);
        }
        break;
      }
      default: {
        x -= opts.rate * gx;
        y -= opts.rate * gy;
      }
    }
  }

  const last = path[path.length - 1];
  return {
    path,
    converged,
    diverged,
    final: diverged || !last ? null : { x, y, f: f(x, y) },
  };
}

// ----------------------------------------------------------------- Lagrange

export interface ConstrainedPoint {
  x: number;
  y: number;
  f: number;
  /** ∇f and ∇g there, which the picture draws as arrows. */
  gradF: [number, number];
  gradG: [number, number];
  /** The multiplier: ∇f = λ∇g. Null where ∇g vanishes and the method fails. */
  lambda: number | null;
  kind: 'maximum' | 'minimum';
}

export interface ConstrainedResult {
  /** The constraint curve g = 0, as polylines. */
  curve: { x: number; y: number }[][];
  best: ConstrainedPoint | null;
  worst: ConstrainedPoint | null;
  message: string;
}

/**
 * Maximises and minimises f along the curve g = 0.
 *
 * The curve is traced first — by marching squares on g, so a constraint with
 * two branches or a hole in it still works — and then f is evaluated along it
 * and refined around the best sample by golden-section search on the arc.
 *
 * Solving ∇f = λ∇g as a system directly would need a starting guess and would
 * converge to whichever stationary point it happened to be near, including
 * minima when asked for maxima. Searching the curve finds the actual extremum,
 * and the multiplier condition is then something to *check* and display rather
 * than something the answer depends on — which is the right way round for a
 * mode whose job is to show why the condition is true.
 */
export function constrainedExtrema(
  f: (x: number, y: number) => number,
  g: (x: number, y: number) => number,
  view: { xMin: number; xMax: number; yMin: number; yMax: number },
  resolution = 220,
): ConstrainedResult {
  const curve = traceZeroLevel(g, view, resolution);
  if (!curve.length) {
    return { curve, best: null, worst: null, message: 'The constraint has no solutions in this window.' };
  }

  let bestPoint: { x: number; y: number } | null = null;
  let worstPoint: { x: number; y: number } | null = null;
  let bestValue = -Infinity;
  let worstValue = Infinity;
  for (const branch of curve) {
    for (const p of branch) {
      const v = f(p.x, p.y);
      if (!Number.isFinite(v)) continue;
      if (v > bestValue) {
        bestValue = v;
        bestPoint = p;
      }
      if (v < worstValue) {
        worstValue = v;
        worstPoint = p;
      }
    }
  }

  const describe = (p: { x: number; y: number } | null, kind: 'maximum' | 'minimum'): ConstrainedPoint | null => {
    if (!p) return null;
    const refined = refineOnCurve(f, g, p, kind);
    const gradF = numericGradient(f, refined.x, refined.y);
    const gradG = numericGradient(g, refined.x, refined.y);
    const gg = gradG[0] * gradG[0] + gradG[1] * gradG[1];
    // λ from the least-squares projection of ∇f onto ∇g, which is the exact
    // multiplier when the two really are parallel and the best available
    // answer when the numerics leave them a hair apart.
    const lambda = gg > 1e-12 ? (gradF[0] * gradG[0] + gradF[1] * gradG[1]) / gg : null;
    return { x: refined.x, y: refined.y, f: f(refined.x, refined.y), gradF, gradG, lambda, kind };
  };

  return {
    curve,
    best: describe(bestPoint, 'maximum'),
    worst: describe(worstPoint, 'minimum'),
    message: 'At each of these ∇f is parallel to ∇g; λ is how many times longer one is than the other.',
  };
}

/**
 * Polishes a point that is on the curve and near the extremum.
 *
 * Two alternating moves: slide along the constraint's tangent to improve f,
 * then step back onto g = 0 along its normal by one Newton correction. That
 * keeps the answer *on* the constraint, which matters — an unconstrained
 * polish would slide off it and report a point that satisfies nothing.
 */
function refineOnCurve(
  f: (x: number, y: number) => number,
  g: (x: number, y: number) => number,
  start: { x: number; y: number },
  kind: 'maximum' | 'minimum',
): { x: number; y: number } {
  let { x, y } = start;
  const sign = kind === 'maximum' ? 1 : -1;
  let step = 0.05 * (1 + Math.hypot(x, y));
  /* Which way the last accepted move went. A pattern search that only shrinks
   * its step when *both* directions fail never shrinks it near an optimum: it
   * overshoots, turns round, overshoots back, and spends its whole budget
   * oscillating a step-length either side of the answer. Halving on a reversal
   * is what makes it converge rather than merely wander. */
  let lastDirection = 0;

  for (let i = 0; i < 160; i++) {
    const gradG = numericGradient(g, x, y);
    const len = Math.hypot(gradG[0], gradG[1]);
    if (!(len > 1e-12)) break;
    const tx = -gradG[1] / len;
    const ty = gradG[0] / len;

    const here = f(x, y);
    const forward = f(x + tx * step, y + ty * step);
    const backward = f(x - tx * step, y - ty * step);
    let nx = x;
    let ny = y;
    let direction = 0;
    /* `sign` flips both comparisons, the tie-break included. Written as
     * `forward >= backward` it silently means "prefer the larger", which is
     * right for a maximum and picks the worse of two improving directions for
     * a minimum — and then the fall-through rejects that one too, so the
     * search stalls a whole grid cell short of the answer. */
    if (sign * forward > sign * here && sign * forward >= sign * backward) {
      direction = 1;
    } else if (sign * backward > sign * here) {
      direction = -1;
    } else {
      step *= 0.5;
      lastDirection = 0;
      if (step < 1e-13) break;
      continue;
    }
    if (lastDirection !== 0 && direction !== lastDirection) step *= 0.5;
    lastDirection = direction;
    if (step < 1e-13) break;
    nx = x + tx * step * direction;
    ny = y + ty * step * direction;

    // One Newton correction back onto g = 0.
    for (let k = 0; k < 4; k++) {
      const value = g(nx, ny);
      const grad = numericGradient(g, nx, ny);
      const norm2 = grad[0] * grad[0] + grad[1] * grad[1];
      if (!(norm2 > 1e-14) || Math.abs(value) < 1e-13) break;
      nx -= (value * grad[0]) / norm2;
      ny -= (value * grad[1]) / norm2;
    }
    x = nx;
    y = ny;
  }
  return { x, y };
}

/**
 * The zero level set of g, by marching squares.
 *
 * Segments rather than ordered curves: they are chained into polylines
 * afterwards so a two-branch constraint like a hyperbola draws as two curves
 * rather than as one with a jump across the middle.
 */
export function traceZeroLevel(
  g: (x: number, y: number) => number,
  view: { xMin: number; xMax: number; yMin: number; yMax: number },
  resolution: number,
): { x: number; y: number }[][] {
  const n = Math.max(8, Math.min(600, Math.round(resolution)));
  const dx = (view.xMax - view.xMin) / n;
  const dy = (view.yMax - view.yMin) / n;
  const values = new Float64Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = g(view.xMin + i * dx, view.yMin + j * dy);
      values[j * (n + 1) + i] = Number.isFinite(v) ? v : NaN;
    }
  }

  const segments: [{ x: number; y: number }, { x: number; y: number }][] = [];
  const cross = (ax: number, ay: number, av: number, bx: number, by: number, bv: number) => {
    const t = av / (av - bv);
    return { x: ax + t * (bx - ax), y: ay + t * (by - ay) };
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = view.xMin + i * dx;
      const y0 = view.yMin + j * dy;
      const x1 = x0 + dx;
      const y1 = y0 + dy;
      const v00 = values[j * (n + 1) + i];
      const v10 = values[j * (n + 1) + i + 1];
      const v01 = values[(j + 1) * (n + 1) + i];
      const v11 = values[(j + 1) * (n + 1) + i + 1];
      if (!Number.isFinite(v00 + v10 + v01 + v11)) continue;

      /* One sign rule for all four edges. An earlier version treated an exact
       * zero as a crossing on the bottom edge only, which made a cell report
       * an odd number of hits and tore the curve into fragments. */
      const bottom = (v00 < 0) !== (v10 < 0) ? cross(x0, y0, v00, x1, y0, v10) : null;
      const right = (v10 < 0) !== (v11 < 0) ? cross(x1, y0, v10, x1, y1, v11) : null;
      const top = (v01 < 0) !== (v11 < 0) ? cross(x0, y1, v01, x1, y1, v11) : null;
      const left = (v00 < 0) !== (v01 < 0) ? cross(x0, y0, v00, x0, y1, v01) : null;
      const hits = [bottom, right, top, left].filter((p): p is { x: number; y: number } => p !== null);

      if (hits.length === 2) {
        segments.push([hits[0], hits[1]]);
      } else if (hits.length === 4) {
        /* A saddle: all four edges cross, and the two ways of pairing them
         * give two completely different pictures. The centre's own sign says
         * which is right — join each edge to the neighbour on the same side of
         * it — and guessing instead is how a hyperbola comes out as an X. */
        const centre = (v00 + v10 + v01 + v11) / 4;
        if ((centre < 0) === (v00 < 0)) {
          segments.push([bottom!, right!]);
          segments.push([left!, top!]);
        } else {
          segments.push([bottom!, left!]);
          segments.push([right!, top!]);
        }
      }
    }
  }

  /* Neighbouring cells compute the crossing on their shared edge from the same
   * two corner values, so the endpoints agree to the last bit. The tolerance
   * only has to absorb rounding — anything looser starts joining across cell
   * diagonals and cutting corners off the curve. */
  return chain(segments, Math.hypot(dx, dy) * 1e-9);
}

/** Joins segments end-to-end into polylines, leaving separate branches apart. */
function chain(
  segments: [{ x: number; y: number }, { x: number; y: number }][],
  tolerance: number,
): { x: number; y: number }[][] {
  const used = new Array<boolean>(segments.length).fill(false);
  const out: { x: number; y: number }[][] = [];
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const line = [segments[i][0], segments[i][1]];
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const [a, b] = segments[j];
        const head = line[0];
        const tail = line[line.length - 1];
        if (near(tail, a)) line.push(b);
        else if (near(tail, b)) line.push(a);
        else if (near(head, a)) line.unshift(b);
        else if (near(head, b)) line.unshift(a);
        else continue;
        used[j] = true;
        grew = true;
      }
    }
    if (line.length >= 2) out.push(line);
  }
  return out;
}
