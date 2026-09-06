import { describe, expect, it } from 'vitest';
import {
  constrainedExtrema,
  feasibleRegion,
  gradientDescent,
  numericGradient,
  numericHessian,
  solveLinearProgram,
  traceZeroLevel,
  type Constraint,
  type LinearProgram,
  type Relation,
} from '../src/core/math/optimise';

/* Optimisation is the easiest subject in this app to get plausibly wrong: a
 * solver that stops one pivot early still returns a feasible point, and a
 * descent that never converges still draws a path. Every test here is against
 * a problem whose answer is known by hand or by duality, never against what
 * the code produced last time.
 */

let counter = 0;
const con = (coefficients: number[], relation: Relation, rhs: number): Constraint => ({
  id: `c${counter++}`,
  coefficients,
  relation,
  rhs,
  label: '',
});

const lp = (over: Partial<LinearProgram> = {}): LinearProgram => ({
  objective: [1, 1],
  maximise: true,
  constraints: [],
  nonNegative: true,
  ...over,
});

describe('the simplex method', () => {
  it('solves the textbook carpenter problem', () => {
    /* Maximise 5x + 4y subject to 6x + 4y ≤ 24, x + 2y ≤ 6, x, y ≥ 0.
     * By hand: the binding pair is 6x + 4y = 24 and x + 2y = 6, giving
     * (3, 1.5) and an objective of 21. */
    const result = solveLinearProgram(
      lp({
        objective: [5, 4],
        constraints: [con([6, 4], '<=', 24), con([1, 2], '<=', 6)],
      }),
    );
    expect(result.status).toBe('optimal');
    expect(result.point![0]).toBeCloseTo(3, 9);
    expect(result.point![1]).toBeCloseTo(1.5, 9);
    expect(result.value).toBeCloseTo(21, 9);
  });

  it('walks corners, and every corner it visits is feasible and no worse than the last', () => {
    const program = lp({
      objective: [5, 4],
      constraints: [con([6, 4], '<=', 24), con([1, 2], '<=', 6)],
    });
    const result = solveLinearProgram(program);
    expect(result.path.length).toBeGreaterThan(1);

    let previous = -Infinity;
    for (const step of result.path) {
      const [x, y] = step.point;
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(6 * x + 4 * y).toBeLessThanOrEqual(24 + 1e-9);
      expect(x + 2 * y).toBeLessThanOrEqual(6 + 1e-9);
      // Phase two never goes downhill — that is what makes it terminate.
      if (step.phase === 2) {
        expect(step.value).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = step.value;
      }
    }
    // And it ends where the optimum is.
    expect(result.path[result.path.length - 1].value).toBeCloseTo(21, 9);
  });

  it('minimises as readily as it maximises', () => {
    // Minimise 2x + 3y subject to x + y ≥ 4, x ≥ 1. The cheapest way to make
    // four units is all of it from the cheaper variable: (4, 0), value 8.
    const result = solveLinearProgram(
      lp({
        objective: [2, 3],
        maximise: false,
        constraints: [con([1, 1], '>=', 4), con([1, 0], '>=', 1)],
      }),
    );
    expect(result.status).toBe('optimal');
    expect(result.value).toBeCloseTo(8, 9);
    expect(result.point![0]).toBeCloseTo(4, 9);
    expect(result.point![1]).toBeCloseTo(0, 9);
  });

  it('handles equalities, which need an artificial variable to start from', () => {
    // Maximise x + y with x + y = 5 and x − y = 1: a single feasible point.
    const result = solveLinearProgram(
      lp({
        objective: [1, 1],
        constraints: [con([1, 1], '=', 5), con([1, -1], '=', 1)],
      }),
    );
    expect(result.status).toBe('optimal');
    expect(result.point![0]).toBeCloseTo(3, 8);
    expect(result.point![1]).toBeCloseTo(2, 8);
    expect(result.value).toBeCloseTo(5, 8);
    expect(result.path.some((s) => s.phase === 1)).toBe(true);
  });

  it('says infeasible rather than returning a point that breaks a constraint', () => {
    const result = solveLinearProgram(
      lp({ objective: [1, 1], constraints: [con([1, 1], '<=', 2), con([1, 1], '>=', 5)] }),
    );
    expect(result.status).toBe('infeasible');
    expect(result.point).toBe(null);
  });

  it('says unbounded rather than stopping somewhere arbitrary', () => {
    // Nothing stops x growing, so the objective has no maximum.
    const result = solveLinearProgram(lp({ objective: [1, 0], constraints: [con([-1, 1], '<=', 1)] }));
    expect(result.status).toBe('unbounded');
    expect(result.value).toBe(null);
  });

  it('does not cycle on a degenerate problem', () => {
    /* Three constraints through one corner: the classic way to make a simplex
     * implementation pivot for ever between bases that all describe the same
     * point. Bland's rule is what stops it, and the guard in `run` is not what
     * should be catching this. */
    const result = solveLinearProgram(
      lp({
        objective: [1, 1],
        constraints: [con([1, 1], '<=', 4), con([1, 0], '<=', 2), con([0, 1], '<=', 2), con([1, 1], '<=', 4)],
      }),
    );
    expect(result.status).toBe('optimal');
    expect(result.value).toBeCloseTo(4, 9);
    expect(result.path.length).toBeLessThan(40);
  });

  it('prices the constraints by what slackening them is worth', () => {
    /* Maximise 5x + 4y with 6x + 4y ≤ 24 and x + 2y ≤ 6. Solving the pair with
     * the right-hand sides as symbols gives ∂z/∂b₁ = 0.75 and ∂z/∂b₂ = 0.5,
     * and the shadow prices have to be those numbers. Checked here by actually
     * re-solving with a nudged right-hand side, so the test does not depend on
     * the same algebra the implementation uses. */
    const build = (b1: number, b2: number) =>
      solveLinearProgram(lp({ objective: [5, 4], constraints: [con([6, 4], '<=', b1), con([1, 2], '<=', b2)] }));

    const base = build(24, 6);
    expect(base.shadowPrices[0]).toBeCloseTo(0.75, 6);
    expect(base.shadowPrices[1]).toBeCloseTo(0.5, 6);

    const h = 1e-4;
    expect((build(24 + h, 6).value! - base.value!) / h).toBeCloseTo(base.shadowPrices[0], 5);
    expect((build(24, 6 + h).value! - base.value!) / h).toBeCloseTo(base.shadowPrices[1], 5);
  });

  it('prices a slack constraint at nothing', () => {
    // The second constraint is nowhere near binding, so relaxing it is worth
    // exactly zero — which is the whole content of complementary slackness.
    const result = solveLinearProgram(
      lp({ objective: [1, 1], constraints: [con([1, 1], '<=', 3), con([1, 1], '<=', 100)] }),
    );
    expect(result.value).toBeCloseTo(3, 9);
    expect(result.shadowPrices[0]).toBeCloseTo(1, 6);
    expect(result.shadowPrices[1]).toBe(0);
  });

  it('agrees with the dual', () => {
    /* Strong duality: max cᵀx subject to Ax ≤ b equals min bᵀy subject to
     * Aᵀy ≥ c. Two different programs, two different paths through the
     * tableau, one number — which is about as independent a check on a
     * simplex implementation as exists. */
    const A = [
      [2, 1],
      [1, 3],
      [1, 1],
    ];
    const b = [10, 15, 6];
    const c = [4, 5];

    const primal = solveLinearProgram(
      lp({ objective: c, constraints: A.map((row, i) => con(row, '<=', b[i])) }),
    );
    const dual = solveLinearProgram({
      objective: b,
      maximise: false,
      nonNegative: true,
      constraints: [con([A[0][0], A[1][0], A[2][0]], '>=', c[0]), con([A[0][1], A[1][1], A[2][1]], '>=', c[1])],
    });

    expect(primal.status).toBe('optimal');
    expect(dual.status).toBe('optimal');
    expect(primal.value!).toBeCloseTo(dual.value!, 6);
  });
});

describe('the feasible region', () => {
  it('is the polygon the constraints cut out', () => {
    /* 6x + 4y ≤ 24, x + 2y ≤ 6, x, y ≥ 0: corners at (0,0), (4,0), (3,1.5),
     * (0,3). Split along the diagonal from the origin, the two triangles have
     * areas ½|4·1.5| = 3 and ½|3·3| = 4.5, so the quadrilateral is 7.5. */
    const region = feasibleRegion(
      lp({ objective: [5, 4], constraints: [con([6, 4], '<=', 24), con([1, 2], '<=', 6)] }),
    );
    expect(region.length).toBe(4);

    let area = 0;
    for (let i = 0; i < region.length; i++) {
      const p = region[i];
      const q = region[(i + 1) % region.length];
      area += p.x * q.y - q.x * p.y;
    }
    expect(Math.abs(area) / 2).toBeCloseTo(7.5, 6);

    const has = (x: number, y: number) => region.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-7);
    expect(has(0, 0)).toBe(true);
    expect(has(4, 0)).toBe(true);
    expect(has(3, 1.5)).toBe(true);
    expect(has(0, 3)).toBe(true);
  });

  it('contains the optimum the simplex found', () => {
    const program = lp({
      objective: [3, 2],
      constraints: [con([1, 1], '<=', 4), con([1, 3], '<=', 6), con([2, 1], '<=', 6)],
    });
    const result = solveLinearProgram(program);
    const region = feasibleRegion(program);
    const inside = region.some((p) => Math.hypot(p.x - result.point![0], p.y - result.point![1]) < 1e-6);
    expect(inside).toBe(true);
  });

  it('collapses to nothing when the constraints contradict', () => {
    expect(feasibleRegion(lp({ constraints: [con([1, 1], '<=', 1), con([1, 1], '>=', 5)] })).length).toBeLessThan(3);
  });
});

describe('gradient descent', () => {
  const bowl = (x: number, y: number) => (x - 3) ** 2 + 2 * (y + 1) ** 2;
  const rosenbrock = (x: number, y: number) => (1 - x) ** 2 + 100 * (y - x * x) ** 2;

  it('measures a gradient and a curvature correctly', () => {
    const [gx, gy] = numericGradient(bowl, 1, 2);
    expect(gx).toBeCloseTo(2 * (1 - 3), 6);
    expect(gy).toBeCloseTo(4 * (2 + 1), 6);
    const h = numericHessian(bowl, 1, 2);
    expect(h[0][0]).toBeCloseTo(2, 4);
    expect(h[1][1]).toBeCloseTo(4, 4);
    expect(h[0][1]).toBeCloseTo(0, 4);
  });

  it('finds the bottom of a bowl', () => {
    const result = gradientDescent(bowl, {
      method: 'gradient',
      rate: 0.1,
      momentum: 0.9,
      steps: 500,
      start: [-2, 4],
      tolerance: 1e-8,
    });
    expect(result.converged).toBe(true);
    expect(result.final!.x).toBeCloseTo(3, 5);
    expect(result.final!.y).toBeCloseTo(-1, 5);
    // Every step goes downhill on a convex function at this rate.
    for (let i = 1; i < result.path.length; i++) {
      expect(result.path[i].f).toBeLessThanOrEqual(result.path[i - 1].f + 1e-12);
    }
  });

  it('diverges when the step is too big for the curvature', () => {
    /* Plain descent on a quadratic is stable exactly while the rate is under
     * 2/λ_max. Here λ_max = 4, so 0.5 is the boundary and 0.8 is past it —
     * and the mode is worth having partly because that is watchable. */
    const stable = gradientDescent(bowl, {
      method: 'gradient', rate: 0.4, momentum: 0, steps: 200, start: [0, 0], tolerance: 1e-9,
    });
    const unstable = gradientDescent(bowl, {
      method: 'gradient', rate: 0.8, momentum: 0, steps: 200, start: [0, 0], tolerance: 1e-9,
    });
    expect(stable.converged).toBe(true);
    expect(unstable.diverged).toBe(true);
  });

  it('lands on a quadratic in one Newton step', () => {
    // Newton uses the curvature, and a quadratic is entirely curvature: from
    // anywhere, the first step is the answer.
    const result = gradientDescent(bowl, {
      method: 'newton', rate: 1, momentum: 0, steps: 40, start: [-8, 9], tolerance: 1e-10,
    });
    expect(result.converged).toBe(true);
    expect(result.path.length).toBeLessThanOrEqual(3);
    expect(result.final!.x).toBeCloseTo(3, 8);
    expect(result.final!.y).toBeCloseTo(-1, 8);
  });

  it('gets further down Rosenbrock with momentum than without, step for step', () => {
    /* The banana valley is the standard demonstration that plain descent is
     * slow: it crosses the valley floor rather than running along it. Same
     * rate, same start, same number of steps — the only difference is whether
     * the previous step is remembered. */
    const opts = { rate: 0.001, momentum: 0.9, steps: 4000, start: [-1.2, 1] as [number, number], tolerance: 1e-10 };
    const plain = gradientDescent(rosenbrock, { ...opts, method: 'gradient' });
    const fast = gradientDescent(rosenbrock, { ...opts, method: 'momentum' });
    expect(fast.final!.f).toBeLessThan(plain.final!.f);
    // And both are still heading for (1, 1), which is where the minimum is.
    expect(fast.final!.f).toBeLessThan(rosenbrock(-1.2, 1));
  });

  it('records a path that starts where it was told to', () => {
    const result = gradientDescent(bowl, {
      method: 'adam', rate: 0.1, momentum: 0.9, steps: 50, start: [5, 5], tolerance: 1e-12,
    });
    expect(result.path[0].x).toBe(5);
    expect(result.path[0].y).toBe(5);
    expect(result.path[0].f).toBeCloseTo(bowl(5, 5), 12);
    expect(result.path.length).toBeGreaterThan(10);
  });
});

describe('Lagrange multipliers', () => {
  const view = { xMin: -3, xMax: 3, yMin: -3, yMax: 3 };

  it('traces a circle as a closed curve of the right radius', () => {
    const curve = traceZeroLevel((x, y) => x * x + y * y - 4, view, 200);
    expect(curve.length).toBe(1);
    for (const p of curve[0]) expect(Math.hypot(p.x, p.y)).toBeCloseTo(2, 2);
  });

  it('keeps two branches of a hyperbola apart', () => {
    const curve = traceZeroLevel((x, y) => x * x - y * y - 1, view, 200);
    expect(curve.length).toBe(2);
    // One branch on each side, never joined across the gap.
    const sides = curve.map((branch) => Math.sign(branch[0].x));
    expect(sides.includes(1)).toBe(true);
    expect(sides.includes(-1)).toBe(true);
  });

  it('maximises x + y on the unit circle at the point calculus says', () => {
    /* The first Lagrange problem in every textbook: the answer is
     * (1/√2, 1/√2) with f = √2 and λ = 1/√2, and all three are checked. */
    const result = constrainedExtrema(
      (x, y) => x + y,
      (x, y) => x * x + y * y - 1,
      { xMin: -2, xMax: 2, yMin: -2, yMax: 2 },
      300,
    );
    const best = result.best!;
    expect(best.x).toBeCloseTo(Math.SQRT1_2, 4);
    expect(best.y).toBeCloseTo(Math.SQRT1_2, 4);
    expect(best.f).toBeCloseTo(Math.SQRT2, 4);
    expect(best.lambda!).toBeCloseTo(Math.SQRT1_2, 3);

    const worst = result.worst!;
    expect(worst.x).toBeCloseTo(-Math.SQRT1_2, 4);
    expect(worst.f).toBeCloseTo(-Math.SQRT2, 4);
  });

  it('puts the gradients parallel at the answer, which is the whole theorem', () => {
    // ∇f × ∇g = 0 at a constrained extremum. Tested on a problem whose
    // answer is not symmetric, so parallelism is not true by accident.
    const result = constrainedExtrema(
      (x, y) => 3 * x + y,
      (x, y) => x * x + 4 * y * y - 4,
      { xMin: -3, xMax: 3, yMin: -2, yMax: 2 },
      320,
    );
    for (const p of [result.best!, result.worst!]) {
      const cross = p.gradF[0] * p.gradG[1] - p.gradF[1] * p.gradG[0];
      const scale = Math.hypot(...p.gradF) * Math.hypot(...p.gradG);
      expect(Math.abs(cross) / scale).toBeLessThan(2e-3);
      // And ∇f = λ∇g componentwise, which is the statement λ actually makes.
      expect(p.gradF[0]).toBeCloseTo(p.lambda! * p.gradG[0], 2);
      expect(p.gradF[1]).toBeCloseTo(p.lambda! * p.gradG[1], 2);
    }
  });

  it('finds the closest point on a line to the origin', () => {
    /* Minimise x² + y² on x + 2y = 5. The foot of the perpendicular is at
     * (1, 2), distance √5, and the multiplier is 2·1/1 = 2. */
    const result = constrainedExtrema(
      (x, y) => x * x + y * y,
      (x, y) => x + 2 * y - 5,
      { xMin: -6, xMax: 6, yMin: -6, yMax: 6 },
      400,
    );
    const p = result.worst!;
    expect(p.x).toBeCloseTo(1, 3);
    expect(p.y).toBeCloseTo(2, 3);
    expect(p.f).toBeCloseTo(5, 3);
    expect(p.lambda!).toBeCloseTo(2, 2);
  });

  it('says so when the constraint is nowhere in the window', () => {
    const result = constrainedExtrema(
      (x, y) => x + y,
      (x, y) => x * x + y * y - 400,
      view,
      120,
    );
    expect(result.curve.length).toBe(0);
    expect(result.best).toBe(null);
  });
});
