/* A dense linear solver on flat arrays.
 *
 * `linalg.ts` already has `solve`, and everywhere else in the app that is the
 * right thing to call. It is not the right thing to call here: the mechanics
 * engine builds and solves a saddle-point system four times per RK4 step at
 * up to a few hundred steps a second, and `number[][]` would spend most of
 * that time in the allocator. This version writes into a caller-owned buffer
 * and allocates nothing per solve.
 *
 * Partial pivoting, no scaling. The systems are small (tens of unknowns) and
 * well scaled by construction — masses and constraint Jacobians are both O(1)
 * in the units the sandbox uses — so the extra robustness of full pivoting or
 * equilibration would cost more than it buys.
 */

export class DenseSolver {
  private readonly a: Float64Array;
  private readonly perm: Int32Array;
  readonly n: number;

  constructor(maxN: number) {
    this.n = maxN;
    this.a = new Float64Array(maxN * maxN);
    this.perm = new Int32Array(maxN);
  }

  /** Zeroes the working matrix so it can be stamped afresh. */
  reset(n: number): void {
    this.a.fill(0, 0, n * n);
  }

  at(n: number, i: number, j: number): number {
    return this.a[i * n + j];
  }

  set(n: number, i: number, j: number, v: number): void {
    this.a[i * n + j] = v;
  }

  add(n: number, i: number, j: number, v: number): void {
    this.a[i * n + j] += v;
  }

  /**
   * Solves A·x = b in place: `b` is overwritten with the solution and the
   * working matrix is destroyed. Returns false when the matrix is singular to
   * working precision, which in this application means the constraints are
   * redundant or contradictory — a rod duplicated between the same two bodies,
   * or a triangle of rigid rods with an inconsistent length. The caller
   * reports that rather than propagating NaNs into the trajectory.
   */
  solveInPlace(n: number, b: Float64Array): boolean {
    const { a, perm } = this;
    for (let i = 0; i < n; i++) perm[i] = i;

    for (let col = 0; col < n; col++) {
      let best = col;
      let bestAbs = Math.abs(a[col * n + col]);
      for (let row = col + 1; row < n; row++) {
        const v = Math.abs(a[row * n + col]);
        if (v > bestAbs) {
          bestAbs = v;
          best = row;
        }
      }
      if (bestAbs < 1e-12) return false;

      if (best !== col) {
        for (let j = 0; j < n; j++) {
          const tmp = a[col * n + j];
          a[col * n + j] = a[best * n + j];
          a[best * n + j] = tmp;
        }
        const tb = b[col];
        b[col] = b[best];
        b[best] = tb;
      }

      const pivot = a[col * n + col];
      for (let row = col + 1; row < n; row++) {
        const factor = a[row * n + col] / pivot;
        if (factor === 0) continue;
        a[row * n + col] = 0;
        for (let j = col + 1; j < n; j++) a[row * n + j] -= factor * a[col * n + j];
        b[row] -= factor * b[col];
      }
    }

    for (let i = n - 1; i >= 0; i--) {
      let sum = b[i];
      for (let j = i + 1; j < n; j++) sum -= a[i * n + j] * b[j];
      b[i] = sum / a[i * n + i];
    }
    for (let i = 0; i < n; i++) if (!Number.isFinite(b[i])) return false;
    return true;
  }
}
