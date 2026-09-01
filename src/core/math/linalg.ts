/* Dense linear algebra for small matrices.
 *
 * Sizes here are 2×2 to 6×6 — a transformation sandbox, not a solver library —
 * so the implementations favour clarity and numerical care over asymptotics.
 * Partial pivoting is used everywhere it matters, because a shear matrix with a
 * zero on the diagonal is a completely ordinary thing for a user to type.
 */

export type Matrix = number[][];
export type Vector = number[];

export const identity = (n: number): Matrix =>
  Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

export const zeros = (rows: number, cols: number): Matrix =>
  Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

export const clone = (m: Matrix): Matrix => m.map((r) => [...r]);

export function transpose(m: Matrix): Matrix {
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  const out = zeros(cols, rows);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out[j][i] = m[i][j];
  return out;
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const k = b.length;
  const p = b[0]?.length ?? 0;
  const out = zeros(n, p);
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < k; t++) {
      const av = a[i][t];
      if (av === 0) continue;
      for (let j = 0; j < p; j++) out[i][j] += av * b[t][j];
    }
  }
  return out;
}

export function apply(m: Matrix, v: Vector): Vector {
  return m.map((row) => row.reduce((s, x, j) => s + x * (v[j] ?? 0), 0));
}

export function add(a: Matrix, b: Matrix): Matrix {
  return a.map((r, i) => r.map((x, j) => x + b[i][j]));
}

export function scale(a: Matrix, k: number): Matrix {
  return a.map((r) => r.map((x) => x * k));
}

export function trace(m: Matrix): number {
  return m.reduce((s, r, i) => s + (r[i] ?? 0), 0);
}

export function frobenius(m: Matrix): number {
  return Math.sqrt(m.reduce((s, r) => s + r.reduce((t, x) => t + x * x, 0), 0));
}

/** LU decomposition with partial pivoting. `sign` tracks row swaps for det. */
export interface LU {
  lu: Matrix;
  pivot: number[];
  sign: number;
  singular: boolean;
}

export function lu(a: Matrix): LU {
  const n = a.length;
  const m = clone(a);
  const pivot = Array.from({ length: n }, (_, i) => i);
  let sign = 1;
  let singular = false;
  for (let k = 0; k < n; k++) {
    let p = k;
    let best = Math.abs(m[k][k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(m[i][k]);
      if (v > best) {
        best = v;
        p = i;
      }
    }
    if (best < 1e-14) {
      singular = true;
      continue;
    }
    if (p !== k) {
      [m[p], m[k]] = [m[k], m[p]];
      [pivot[p], pivot[k]] = [pivot[k], pivot[p]];
      sign = -sign;
    }
    for (let i = k + 1; i < n; i++) {
      m[i][k] /= m[k][k];
      const f = m[i][k];
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) m[i][j] -= f * m[k][j];
    }
  }
  return { lu: m, pivot, sign, singular };
}

export function determinant(a: Matrix): number {
  const n = a.length;
  if (n === 0) return 1;
  if (n === 1) return a[0][0];
  if (n === 2) return a[0][0] * a[1][1] - a[0][1] * a[1][0];
  if (n === 3) {
    return (
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
      a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
      a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
    );
  }
  const d = lu(a);
  if (d.singular) return 0;
  let det = d.sign;
  for (let i = 0; i < n; i++) det *= d.lu[i][i];
  return det;
}

export function inverse(a: Matrix): Matrix | null {
  const n = a.length;
  const aug = a.map((row, i) => [...row, ...identity(n)[i]]);
  const r = rref(aug);
  // The augmented matrix always has full row rank because of the identity
  // block, so rank alone proves nothing: what matters is that every pivot
  // landed on the diagonal of the *left* block, which is exactly the condition
  // for that block having reduced to the identity.
  if (r.rank < n || r.pivots.some((p, i) => p !== i)) return null;
  return r.matrix.map((row) => row.slice(n));
}

export function solve(a: Matrix, b: Vector): Vector | null {
  const inv = inverse(a);
  return inv ? apply(inv, b) : null;
}

export interface RrefResult {
  matrix: Matrix;
  rank: number;
  pivots: number[];
  /** The elementary row operations performed, for the step-by-step display. */
  steps: string[];
}

/** Gauss–Jordan elimination to reduced row echelon form, recording each step. */
export function rref(input: Matrix, tol = 1e-10): RrefResult {
  const m = clone(input);
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  const pivots: number[] = [];
  const steps: string[] = [];
  let r = 0;
  for (let c = 0; c < cols && r < rows; c++) {
    let p = r;
    let best = Math.abs(m[r][c]);
    for (let i = r + 1; i < rows; i++) {
      if (Math.abs(m[i][c]) > best) {
        best = Math.abs(m[i][c]);
        p = i;
      }
    }
    if (best < tol) continue;
    if (p !== r) {
      [m[p], m[r]] = [m[r], m[p]];
      steps.push(`R${r + 1} ↔ R${p + 1}`);
    }
    const lead = m[r][c];
    if (Math.abs(lead - 1) > tol) {
      for (let j = 0; j < cols; j++) m[r][j] /= lead;
      steps.push(`R${r + 1} → R${r + 1} / ${round(lead)}`);
    }
    for (let i = 0; i < rows; i++) {
      if (i === r) continue;
      const f = m[i][c];
      if (Math.abs(f) < tol) continue;
      for (let j = 0; j < cols; j++) m[i][j] -= f * m[r][j];
      steps.push(`R${i + 1} → R${i + 1} − ${round(f)}·R${r + 1}`);
    }
    pivots.push(c);
    r++;
  }
  // Clean up the −0 and 1e-17 debris that elimination leaves behind, so the
  // displayed matrix reads as the exact answer it almost always is.
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) if (Math.abs(m[i][j]) < tol) m[i][j] = 0;
  }
  return { matrix: m, rank: pivots.length, pivots, steps };
}

export function rank(a: Matrix): number {
  return rref(a).rank;
}

/** Gram–Schmidt QR with reorthogonalisation. */
export function qr(a: Matrix): { q: Matrix; r: Matrix } {
  const n = a.length;
  const m = a[0]?.length ?? 0;
  const q = zeros(n, m);
  const r = zeros(m, m);
  for (let j = 0; j < m; j++) {
    let v = a.map((row) => row[j]);
    for (let pass = 0; pass < 2; pass++) {
      // The second pass is not redundant: classical Gram–Schmidt loses
      // orthogonality on ill-conditioned columns, and one reorthogonalisation
      // restores it to machine precision.
      for (let i = 0; i < j; i++) {
        let dot = 0;
        for (let k = 0; k < n; k++) dot += q[k][i] * v[k];
        if (pass === 0) r[i][j] = dot;
        else r[i][j] += dot;
        v = v.map((x, k) => x - dot * q[k][i]);
      }
    }
    const norm = Math.hypot(...v);
    r[j][j] = norm;
    for (let k = 0; k < n; k++) q[k][j] = norm > 1e-14 ? v[k] / norm : 0;
  }
  return { q, r };
}

export interface Eigen {
  values: { re: number; im: number }[];
  /** Real eigenvectors, aligned with `values`; null where the pair is complex. */
  vectors: (Vector | null)[];
}

/** Eigenvalues and eigenvectors.
 *
 *  2×2 and 3×3 symmetric cases are solved in closed form because those are the
 *  ones a user watches change as they drag a slider, and a closed form is both
 *  exact and continuous under small perturbations. Everything else goes through
 *  the unshifted QR iteration, which is slower but general.
 */
export function eigen(a: Matrix): Eigen {
  const n = a.length;
  if (n === 2) {
    const [[p, q], [r, s]] = a;
    const tr = p + s;
    const det = p * s - q * r;
    const disc = tr * tr - 4 * det;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      const l1 = (tr + root) / 2;
      const l2 = (tr - root) / 2;
      return {
        values: [
          { re: l1, im: 0 },
          { re: l2, im: 0 },
        ],
        vectors: [eigenvector2(a, l1), eigenvector2(a, l2)],
      };
    }
    const root = Math.sqrt(-disc) / 2;
    return {
      values: [
        { re: tr / 2, im: root },
        { re: tr / 2, im: -root },
      ],
      vectors: [null, null],
    };
  }

  // QR iteration on a working copy. Convergence is to (quasi-)upper-triangular
  // form; 2×2 blocks left on the diagonal are complex conjugate pairs.
  let m = clone(a);
  for (let iter = 0; iter < 500; iter++) {
    const { q, r } = qr(m);
    m = multiply(r, q);
    let off = 0;
    for (let i = 1; i < n; i++) for (let j = 0; j < i; j++) off += Math.abs(m[i][j]);
    if (off < 1e-12) break;
  }
  const values: { re: number; im: number }[] = [];
  let i = 0;
  while (i < n) {
    if (i + 1 < n && Math.abs(m[i + 1][i]) > 1e-8 * (Math.abs(m[i][i]) + Math.abs(m[i + 1][i + 1]) + 1e-30)) {
      const p = m[i][i];
      const q2 = m[i][i + 1];
      const r2 = m[i + 1][i];
      const s = m[i + 1][i + 1];
      const tr = p + s;
      const det = p * s - q2 * r2;
      const disc = tr * tr - 4 * det;
      if (disc < 0) {
        const root = Math.sqrt(-disc) / 2;
        values.push({ re: tr / 2, im: root }, { re: tr / 2, im: -root });
      } else {
        const root = Math.sqrt(disc);
        values.push({ re: (tr + root) / 2, im: 0 }, { re: (tr - root) / 2, im: 0 });
      }
      i += 2;
    } else {
      values.push({ re: m[i][i], im: 0 });
      i++;
    }
  }
  const vectors = values.map((v) => (Math.abs(v.im) < 1e-12 ? nullspaceVector(subtractScaledIdentity(a, v.re)) : null));
  return { values, vectors };
}

function subtractScaledIdentity(a: Matrix, lambda: number): Matrix {
  return a.map((row, i) => row.map((x, j) => (i === j ? x - lambda : x)));
}

function eigenvector2(a: Matrix, lambda: number): Vector | null {
  const [[p, q], [r, s]] = a;
  // Either row of (A − λI) gives the eigenvector direction; pick the row with
  // the larger entries, since the other may be numerically zero.
  const row1: Vector = [q, lambda - p];
  const row2: Vector = [lambda - s, r];
  const n1 = Math.hypot(row1[0], row1[1]);
  const n2 = Math.hypot(row2[0], row2[1]);
  const v = n1 >= n2 ? row1 : row2;
  const n = Math.hypot(v[0], v[1]);
  return n > 1e-12 ? [v[0] / n, v[1] / n] : null;
}

/** A unit vector spanning the null space of a (nearly) singular matrix. */
function nullspaceVector(a: Matrix): Vector | null {
  const n = a.length;
  const r = rref(a);
  const free: number[] = [];
  for (let c = 0; c < n; c++) if (!r.pivots.includes(c)) free.push(c);
  if (!free.length) return null;
  const v = new Array<number>(n).fill(0);
  v[free[0]] = 1;
  for (let i = r.pivots.length - 1; i >= 0; i--) {
    const pc = r.pivots[i];
    let acc = 0;
    for (let c = pc + 1; c < n; c++) acc += r.matrix[i][c] * v[c];
    v[pc] = -acc;
  }
  const norm = Math.hypot(...v);
  return norm > 1e-12 ? v.map((x) => x / norm) : null;
}

/** Singular values via the eigenvalues of AᵀA. Sufficient for the 2×2 and 3×3
 *  condition-number and ellipse displays; not a general SVD. */
export function singularValues(a: Matrix): number[] {
  const ata = multiply(transpose(a), a);
  const e = eigen(ata);
  return e.values
    .map((v) => Math.sqrt(Math.max(0, v.re)))
    .sort((x, y) => y - x);
}

export function conditionNumber(a: Matrix): number {
  const s = singularValues(a);
  const min = s[s.length - 1];
  return min > 1e-15 ? s[0] / min : Infinity;
}

// ------------------------------------------------------------------ 2D transform helpers

export const rotation2 = (theta: number): Matrix => [
  [Math.cos(theta), -Math.sin(theta)],
  [Math.sin(theta), Math.cos(theta)],
];

export const scaling2 = (sx: number, sy: number): Matrix => [
  [sx, 0],
  [0, sy],
];

export const shear2 = (kx: number, ky: number): Matrix => [
  [1, kx],
  [ky, 1],
];

export const reflection2 = (theta: number): Matrix => [
  [Math.cos(2 * theta), Math.sin(2 * theta)],
  [Math.sin(2 * theta), -Math.cos(2 * theta)],
];

export const rotationX = (t: number): Matrix => [
  [1, 0, 0],
  [0, Math.cos(t), -Math.sin(t)],
  [0, Math.sin(t), Math.cos(t)],
];
export const rotationY = (t: number): Matrix => [
  [Math.cos(t), 0, Math.sin(t)],
  [0, 1, 0],
  [-Math.sin(t), 0, Math.cos(t)],
];
export const rotationZ = (t: number): Matrix => [
  [Math.cos(t), -Math.sin(t), 0],
  [Math.sin(t), Math.cos(t), 0],
  [0, 0, 1],
];

/**
 * Interpolates from the identity towards `m`.
 *
 * Straight entrywise interpolation (1−t)I + tM is what makes the animation
 * readable: it is the path Grant Sanderson's linear-algebra animations use, and
 * it keeps the grid lines straight throughout. It is *not* a geodesic in the
 * space of matrices, and it can pass through a singular matrix on the way — the
 * caller is told when that happens rather than it being hidden.
 */
export function interpolateFromIdentity(m: Matrix, t: number): Matrix {
  const n = m.length;
  const id = identity(n);
  return m.map((row, i) => row.map((x, j) => id[i][j] * (1 - t) + x * t));
}

// ------------------------------------------------------------------ planes

export interface Plane {
  /** Coefficients of ax + by + cz = d. */
  a: number;
  b: number;
  c: number;
  d: number;
}

export const planeNormal = (p: Plane): Vector => [p.a, p.b, p.c];

export function cross(u: Vector, v: Vector): Vector {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

export function dot(u: Vector, v: Vector): number {
  return u.reduce((s, x, i) => s + x * (v[i] ?? 0), 0);
}

export function norm(v: Vector): number {
  return Math.sqrt(dot(v, v));
}

export function normalise(v: Vector): Vector {
  const n = norm(v);
  return n > 1e-15 ? v.map((x) => x / n) : v.map(() => 0);
}

export type PlanePairResult =
  | { kind: 'line'; point: Vector; direction: Vector; angle: number }
  | { kind: 'parallel'; distance: number }
  | { kind: 'coincident' };

/** Where two planes meet: a line, nothing, or each other. */
export function intersectPlanes(p1: Plane, p2: Plane): PlanePairResult {
  const n1 = planeNormal(p1);
  const n2 = planeNormal(p2);
  const dir = cross(n1, n2);
  const len = norm(dir);
  if (len < 1e-12) {
    // Parallel normals. Rescale one plane's constant to the other's normal
    // length to decide between "same plane" and "two parallel planes".
    const s = norm(n1) > 1e-12 ? norm(n2) / norm(n1) : 1;
    const same = Math.abs(p1.d * s - p2.d) < 1e-9 * Math.max(1, Math.abs(p2.d));
    if (same) return { kind: 'coincident' };
    const distance = Math.abs(p2.d - p1.d * s) / (norm(n2) || 1);
    return { kind: 'parallel', distance };
  }
  // A point on the line: solve the 2×2 system in the plane where the direction
  // vector has its largest component, which is the best-conditioned choice.
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  let point: Vector;
  if (az >= ax && az >= ay) {
    const det = p1.a * p2.b - p2.a * p1.b;
    point = [(p1.d * p2.b - p2.d * p1.b) / det, (p1.a * p2.d - p2.a * p1.d) / det, 0];
  } else if (ay >= ax) {
    const det = p1.a * p2.c - p2.a * p1.c;
    point = [(p1.d * p2.c - p2.d * p1.c) / det, 0, (p1.a * p2.d - p2.a * p1.d) / det];
  } else {
    const det = p1.b * p2.c - p2.b * p1.c;
    point = [0, (p1.d * p2.c - p2.d * p1.c) / det, (p1.b * p2.d - p2.b * p1.d) / det];
  }
  const cosAngle = Math.abs(dot(normalise(n1), normalise(n2)));
  return { kind: 'line', point, direction: normalise(dir), angle: Math.acos(Math.min(1, cosAngle)) };
}

export type PlaneTripleResult =
  | { kind: 'point'; point: Vector }
  | { kind: 'line'; point: Vector; direction: Vector }
  | { kind: 'plane' }
  | { kind: 'none'; reason: string };

/** Classifies the intersection of three planes by the rank of the system. */
export function intersectThreePlanes(p1: Plane, p2: Plane, p3: Plane): PlaneTripleResult {
  const a: Matrix = [
    [p1.a, p1.b, p1.c],
    [p2.a, p2.b, p2.c],
    [p3.a, p3.b, p3.c],
  ];
  const rhs = [p1.d, p2.d, p3.d];
  const coefRank = rank(a);
  const augRank = rank(a.map((row, i) => [...row, rhs[i]]));

  if (coefRank === 3) {
    const x = solve(a, rhs);
    return x ? { kind: 'point', point: x } : { kind: 'none', reason: 'The system is numerically singular.' };
  }
  if (augRank > coefRank) {
    return {
      kind: 'none',
      reason:
        coefRank === 2
          ? 'The planes form a triangular prism — they meet pairwise but share no common point.'
          : 'The planes are parallel with different offsets, so they never meet.',
    };
  }
  if (coefRank === 2) {
    // Consistent and rank 2: the solution set is a line, found from the two
    // independent planes among the three.
    const pairs: [Plane, Plane][] = [
      [p1, p2],
      [p1, p3],
      [p2, p3],
    ];
    for (const [x, y] of pairs) {
      const r = intersectPlanes(x, y);
      if (r.kind === 'line') return { kind: 'line', point: r.point, direction: r.direction };
    }
  }
  return { kind: 'plane' };
}

/** Signed distance from a point to a plane. */
export function pointPlaneDistance(p: Plane, v: Vector): number {
  const n = planeNormal(p);
  return (dot(n, v) - p.d) / (norm(n) || 1);
}

function round(x: number): string {
  const r = Math.round(x * 1e6) / 1e6;
  return String(r);
}

/** Formats a matrix for display, trimming floating-point noise. */
export function formatMatrix(m: Matrix, digits = 4): string[][] {
  return m.map((row) =>
    row.map((x) => {
      if (!Number.isFinite(x)) return String(x);
      if (Math.abs(x) < 1e-12) return '0';
      const r = Number(x.toFixed(digits));
      return Number.isInteger(r) ? String(r) : String(r);
    }),
  );
}
