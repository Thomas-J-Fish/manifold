/* Dynamic geometry: constructions that hold together when you move them.
 *
 * The whole subject rests on one idea. A construction is not a picture of some
 * points and lines; it is a *dependency graph*. A free point carries
 * coordinates, and everything else — a midpoint, a circle through a point, the
 * intersection of two circles — is a rule for computing a position from its
 * parents. Drag a free point and the rest follows, because the rest was never
 * stored in the first place.
 *
 * That is also why this file contains no drawing and no interaction: the graph
 * and its evaluation are the thing worth testing, and they can be tested
 * against theorems. If the perpendicular bisectors of a triangle's three sides
 * are concurrent for every triangle the tests throw at them, the construction
 * is right; if the circle through that point passes through all three vertices,
 * it is right for the right reason.
 *
 * One subtlety runs through the whole file: **branch stability**. Two circles
 * meet at two points, and a construction that silently swaps which one it means
 * halfway through a drag looks like the figure tearing itself apart. Every
 * intersection here orders its solutions deterministically — by parameter along
 * a line, or by angle about a centre — so "the first intersection" keeps
 * meaning the same one as the figure moves.
 */

export interface Pt {
  x: number;
  y: number;
}

export type Span = 'line' | 'ray' | 'segment';

/** What an object evaluates to. */
export type Value =
  | { kind: 'point'; p: Pt }
  | { kind: 'line'; a: Pt; b: Pt; span: Span }
  | { kind: 'circle'; c: Pt; r: number }
  | { kind: 'conic'; focus: Pt; foot: Pt; normal: Pt; distance: number; e: number }
  | { kind: 'polygon'; points: Pt[] }
  | { kind: 'invalid'; why: string };

export type GeoKind =
  // sources
  | 'point'
  | 'pointOn'
  | 'intersection'
  // straightedge
  | 'line'
  | 'ray'
  | 'segment'
  | 'parallel'
  | 'perpendicular'
  // compass
  | 'circle'
  | 'circleRadius'
  // classical constructions
  | 'midpoint'
  | 'bisector'
  | 'angleBisector'
  // transformations
  | 'reflect'
  | 'rotate'
  | 'translate'
  | 'dilate'
  // curves and regions
  | 'conic'
  | 'polygon';

export interface GeoObject {
  id: string;
  kind: GeoKind;
  /** Ids this object is built from, in the order the rule expects. */
  parents: string[];
  /** Free points: their position. Nothing else uses these. */
  x?: number;
  y?: number;
  /**
   * The one number some rules need: the parameter of a point on a path, a
   * rotation angle in degrees, a dilation factor, a radius, an eccentricity.
   */
  value?: number;
  /** Which of two intersections, ordered stably. */
  branch?: 0 | 1;
  label: string;
  colour: string;
  visible: boolean;
}

export interface Construction {
  objects: GeoObject[];
}

export interface EvalResult {
  values: Map<string, Value>;
  /** Ids that could not be computed, with the reason. */
  problems: { id: string; why: string }[];
  /** Evaluation order, which is also a topological sort of the graph. */
  order: string[];
}

// ------------------------------------------------------------------- vectors

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
/** The 2D cross product, which is the signed area of the parallelogram. */
const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
const len = (a: Pt): number => Math.hypot(a.x, a.y);

export const distance = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

const norm = (a: Pt): Pt => {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};

/** Rotates a vector a quarter turn anticlockwise. */
const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });

const finite = (p: Pt): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

// ----------------------------------------------------------------- primitives

/** Where a point sits along a line, as a multiple of (b − a) from a. */
export function parameterOn(line: { a: Pt; b: Pt }, p: Pt): number {
  const d = sub(line.b, line.a);
  const dd = dot(d, d);
  return dd > 1e-24 ? dot(sub(p, line.a), d) / dd : 0;
}

/** Whether a parameter lies within the line's span. */
const inSpan = (span: Span, t: number): boolean =>
  span === 'line' ? true : span === 'ray' ? t >= -1e-9 : t >= -1e-9 && t <= 1 + 1e-9;

/** The foot of the perpendicular from p to the infinite line through a and b. */
export function footOfPerpendicular(a: Pt, b: Pt, p: Pt): Pt {
  return add(a, mul(sub(b, a), parameterOn({ a, b }, p)));
}

/** Signed distance from p to the line, positive on the left of a → b. */
export function signedDistanceToLine(a: Pt, b: Pt, p: Pt): number {
  const d = sub(b, a);
  const l = len(d);
  return l > 1e-12 ? cross(d, sub(p, a)) / l : distance(a, p);
}

/**
 * Where two lines meet.
 *
 * Returns null when they are parallel, and — importantly — when the meeting
 * point falls outside either object's span, so that intersecting two segments
 * that do not actually cross is an *invalid* construction rather than a point
 * hovering out in space where neither segment goes.
 */
export function intersectLines(
  l1: { a: Pt; b: Pt; span: Span },
  l2: { a: Pt; b: Pt; span: Span },
): Pt | null {
  const d1 = sub(l1.b, l1.a);
  const d2 = sub(l2.b, l2.a);
  const denominator = cross(d1, d2);
  // Parallel, or one of them degenerate.
  if (Math.abs(denominator) < 1e-12) return null;
  const t = cross(sub(l2.a, l1.a), d2) / denominator;
  const u = cross(sub(l2.a, l1.a), d1) / denominator;
  if (!inSpan(l1.span, t) || !inSpan(l2.span, u)) return null;
  const p = add(l1.a, mul(d1, t));
  return finite(p) ? p : null;
}

/**
 * Where a line meets a circle.
 *
 * The two solutions are returned in increasing order of the parameter along
 * a → b, which is what keeps "the second intersection" from becoming the first
 * one when the figure is dragged past a symmetric position.
 */
export function intersectLineCircle(
  line: { a: Pt; b: Pt; span: Span },
  circle: { c: Pt; r: number },
): Pt[] {
  const d = sub(line.b, line.a);
  const f = sub(line.a, circle.c);
  const a = dot(d, d);
  if (a < 1e-24 || !(circle.r > 0)) return [];
  const b = 2 * dot(f, d);
  const c = dot(f, f) - circle.r * circle.r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  // Ordered by parameter, smallest first.
  const ts = [(-b - root) / (2 * a), (-b + root) / (2 * a)].sort((p, q) => p - q);
  return ts
    .filter((t) => inSpan(line.span, t))
    .map((t) => add(line.a, mul(d, t)))
    .filter(finite);
}

/**
 * Where two circles meet.
 *
 * Ordered so that the first solution is the one to the left of the line from
 * the first centre to the second — a rule that does not depend on which way
 * round the circles happen to be, so it survives dragging.
 */
export function intersectCircles(
  c1: { c: Pt; r: number },
  c2: { c: Pt; r: number },
): Pt[] {
  const d = sub(c2.c, c1.c);
  const dist = len(d);
  if (dist < 1e-12 || !(c1.r > 0) || !(c2.r > 0)) return [];
  // Separate, or one entirely inside the other.
  if (dist > c1.r + c2.r + 1e-12) return [];
  if (dist < Math.abs(c1.r - c2.r) - 1e-12) return [];

  const a = (c1.r * c1.r - c2.r * c2.r + dist * dist) / (2 * dist);
  const hSquared = c1.r * c1.r - a * a;
  const h = Math.sqrt(Math.max(0, hSquared));
  const base = add(c1.c, mul(d, a / dist));
  const offset = mul(perp(norm(d)), h);
  const left = add(base, offset);
  const right = sub(base, offset);
  if (h < 1e-12) return finite(left) ? [left] : [];
  return [left, right].filter(finite);
}

// ------------------------------------------------------------------- conics

export type ConicKind = 'ellipse' | 'parabola' | 'hyperbola' | 'circle';

export function conicKind(e: number): ConicKind {
  if (Math.abs(e - 1) < 1e-9) return 'parabola';
  return e < 1 ? (e < 1e-9 ? 'circle' : 'ellipse') : 'hyperbola';
}

export interface ConicGeometry {
  kind: ConicKind;
  /** Semi-latus rectum: the half-chord through the focus, perpendicular to the axis. */
  semiLatus: number;
  /** Semi-major axis. Infinite for a parabola. */
  a: number;
  /** Semi-minor axis. Not meaningful for a parabola. */
  b: number;
  /** Focus-to-centre distance. */
  c: number;
  /** The second focus, where there is one. */
  otherFocus: Pt | null;
  centre: Pt | null;
}

/**
 * The classical parameters of a conic given as focus, directrix and eccentricity.
 *
 * Nothing here is used to *draw* the curve — `conicPoints` works straight from
 * the focus-directrix definition. These are computed separately so the readout
 * can state a, b, c and the second focus, and so the tests can check that the
 * curve drawn from the definition really does have the properties the algebra
 * says it should. Two independent routes to the same object is the only way to
 * be sure either is right.
 */
export function conicGeometry(focus: Pt, foot: Pt, e: number): ConicGeometry {
  const d0 = distance(focus, foot);
  const kind = conicKind(e);
  const n = norm(sub(focus, foot));
  const semiLatus = e * d0;

  if (kind === 'parabola' || d0 < 1e-12) {
    return { kind, semiLatus, a: Infinity, b: Infinity, c: Infinity, otherFocus: null, centre: null };
  }
  // r = e·d₀/(1 − e cos θ), so the two vertices along the axis are at
  // θ = 0 and θ = π, and everything else follows from them.
  const a = semiLatus / Math.abs(1 - e * e);
  const b = semiLatus / Math.sqrt(Math.abs(1 - e * e));
  const c = a * e;
  // The centre lies along the axis, away from the directrix for an ellipse and
  // on the far side of the focus for a hyperbola.
  const centre = add(focus, mul(n, e < 1 ? c : -c));
  const otherFocus = add(focus, mul(n, e < 1 ? 2 * c : -2 * c));
  return { kind, semiLatus, a, b, c, otherFocus, centre };
}

/**
 * Samples a conic from its focus-directrix definition alone.
 *
 * The definition is that |PF| = e·dist(P, directrix). Putting polar coordinates
 * at the focus with θ measured from the direction pointing away from the
 * directrix gives r(1 − e cos θ) = e·d₀ directly, and sweeping θ traces the
 * curve. An ellipse closes; a parabola runs to infinity in one direction; a
 * hyperbola has a denominator that changes sign, which is exactly where its
 * two branches part company and its asymptotes are.
 *
 * Returned as separate branches so a hyperbola is not drawn with a line joining
 * one arm to the other across the gap.
 */
export function conicPoints(
  focus: Pt,
  foot: Pt,
  e: number,
  reach: number,
  samples = 480,
): Pt[][] {
  const d0 = distance(focus, foot);
  if (!(d0 > 1e-12) || !(e > 0) || !Number.isFinite(e)) return [];
  const n = norm(sub(focus, foot));
  const t = perp(n);
  const count = Math.max(24, Math.min(4000, Math.round(samples)));

  const branches: Pt[][] = [];
  let current: Pt[] = [];
  const flush = () => {
    if (current.length > 1) branches.push(current);
    current = [];
  };

  for (let i = 0; i <= count; i++) {
    const theta = (2 * Math.PI * i) / count;
    const denominator = 1 - e * Math.cos(theta);
    // Close to an asymptote the radius runs away; break the branch there
    // rather than drawing a spike across the plot.
    if (Math.abs(denominator) < 1e-6) {
      flush();
      continue;
    }
    const r = (e * d0) / denominator;
    if (!Number.isFinite(r) || Math.abs(r) > reach) {
      flush();
      continue;
    }
    const p = add(focus, add(mul(n, r * Math.cos(theta)), mul(t, r * Math.sin(theta))));
    if (!finite(p)) {
      flush();
      continue;
    }
    current.push(p);
  }
  flush();

  // An ellipse comes back as one arc that should be closed; a parabola and a
  // hyperbola genuinely end.
  if (e < 1 - 1e-9 && branches.length === 1) branches[0].push(branches[0][0]);
  return branches;
}

// -------------------------------------------------------------- evaluation

const invalid = (why: string): Value => ({ kind: 'invalid', why });

const asPoint = (v: Value | undefined): Pt | null => (v && v.kind === 'point' ? v.p : null);
const asLine = (v: Value | undefined): { a: Pt; b: Pt; span: Span } | null =>
  v && v.kind === 'line' ? v : null;
/** A line-like or circle-like parent, for the things that accept either. */
const asPath = (v: Value | undefined) =>
  v && (v.kind === 'line' || v.kind === 'circle' || v.kind === 'conic') ? v : null;

/**
 * Evaluates the whole construction.
 *
 * Depth-first with an explicit colour marking, so a cycle — which a user can
 * create by pointing an object at something built from it — is reported rather
 * than overflowing the stack.
 */
export function evaluate(construction: Construction): EvalResult {
  const byId = new Map(construction.objects.map((o) => [o.id, o]));
  const values = new Map<string, Value>();
  const problems: { id: string; why: string }[] = [];
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  /* Nodes found to be part of a cycle.
   *
   * Marking the value at the moment the cycle is detected is not enough: the
   * outer visit of the same node is still on the stack, and when it unwinds it
   * computes the node normally and overwrites the diagnosis with whatever its
   * now-invalid parents produced — so a genuine loop reported itself as "needs
   * two points", which sends the user looking in the wrong place entirely.
   */
  const cyclic = new Set<string>();
  /* The chain currently being visited, so that when a loop is found *every*
   * object in it can be named. Marking only the node where the loop was
   * noticed leaves its partners reporting whatever their now-missing parents
   * produced, and the user is told two different stories about one problem. */
  const stack: string[] = [];

  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      for (let i = stack.lastIndexOf(id); i >= 0 && i < stack.length; i++) cyclic.add(stack[i]);
      cyclic.add(id);
      return;
    }
    const object = byId.get(id);
    if (!object) return;
    state.set(id, 'visiting');
    stack.push(id);
    for (const parent of object.parents) visit(parent);
    stack.pop();
    const value = cyclic.has(id)
      ? invalid('This depends on itself, directly or through a chain of objects.')
      : compute(object, (pid) => values.get(pid));
    values.set(id, value);
    if (value.kind === 'invalid') problems.push({ id, why: value.why });
    state.set(id, 'done');
    order.push(id);
  };

  for (const object of construction.objects) visit(object.id);
  return { values, problems, order };
}

function compute(o: GeoObject, get: (id: string) => Value | undefined): Value {
  const p = o.parents.map(get);
  const missing = (n: number) => p.length < n || p.slice(0, n).some((v) => !v || v.kind === 'invalid');

  switch (o.kind) {
    case 'point': {
      const x = o.x ?? 0;
      const y = o.y ?? 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return invalid('This point has no position.');
      return { kind: 'point', p: { x, y } };
    }

    case 'pointOn': {
      if (missing(1)) return invalid('Needs a path to sit on.');
      const path = asPath(p[0]);
      if (!path) return invalid('Needs a line, circle or conic to sit on.');
      return { kind: 'point', p: pointAlong(path, o.value ?? 0.5) };
    }

    case 'intersection': {
      if (missing(2)) return invalid('Needs two objects to cross.');
      const branch = o.branch ?? 0;
      const hits = intersectionsOf(p[0]!, p[1]!);
      if (!hits.length) return invalid('These do not meet.');
      return { kind: 'point', p: hits[Math.min(branch, hits.length - 1)] };
    }

    case 'line':
    case 'ray':
    case 'segment': {
      if (missing(2)) return invalid('Needs two points.');
      const a = asPoint(p[0]);
      const b = asPoint(p[1]);
      if (!a || !b) return invalid('Needs two points.');
      if (distance(a, b) < 1e-12) return invalid('Both points are in the same place.');
      return { kind: 'line', a, b, span: o.kind };
    }

    case 'parallel':
    case 'perpendicular': {
      if (missing(2)) return invalid('Needs a point and a line.');
      const through = asPoint(p[0]);
      const line = asLine(p[1]);
      if (!through || !line) return invalid('Needs a point and a line.');
      const d = sub(line.b, line.a);
      const dir = o.kind === 'parallel' ? d : perp(d);
      return { kind: 'line', a: through, b: add(through, dir), span: 'line' };
    }

    case 'circle': {
      if (missing(2)) return invalid('Needs a centre and a point on the rim.');
      const c = asPoint(p[0]);
      const rim = asPoint(p[1]);
      if (!c || !rim) return invalid('Needs a centre and a point on the rim.');
      const r = distance(c, rim);
      if (!(r > 1e-12)) return invalid('The rim point is at the centre.');
      return { kind: 'circle', c, r };
    }

    case 'circleRadius': {
      if (missing(1)) return invalid('Needs a centre.');
      const c = asPoint(p[0]);
      const r = o.value ?? 1;
      if (!c) return invalid('Needs a centre.');
      if (!(r > 1e-12)) return invalid('A circle needs a positive radius.');
      return { kind: 'circle', c, r };
    }

    case 'midpoint': {
      if (missing(2)) return invalid('Needs two points.');
      const a = asPoint(p[0]);
      const b = asPoint(p[1]);
      if (!a || !b) return invalid('Needs two points.');
      return { kind: 'point', p: mul(add(a, b), 0.5) };
    }

    case 'bisector': {
      // The perpendicular bisector: the locus of points equidistant from two,
      // and the single most useful line in classical construction.
      if (missing(2)) return invalid('Needs two points.');
      const a = asPoint(p[0]);
      const b = asPoint(p[1]);
      if (!a || !b) return invalid('Needs two points.');
      if (distance(a, b) < 1e-12) return invalid('Both points are in the same place.');
      const mid = mul(add(a, b), 0.5);
      return { kind: 'line', a: mid, b: add(mid, perp(sub(b, a))), span: 'line' };
    }

    case 'angleBisector': {
      if (missing(3)) return invalid('Needs three points: two arms and the vertex between them.');
      const a = asPoint(p[0]);
      const vertex = asPoint(p[1]);
      const b = asPoint(p[2]);
      if (!a || !vertex || !b) return invalid('Needs three points.');
      const u = norm(sub(a, vertex));
      const v = norm(sub(b, vertex));
      const sum = add(u, v);
      // The arms point opposite ways: the bisector is the perpendicular.
      const dir = len(sum) < 1e-9 ? perp(u) : sum;
      if (len(dir) < 1e-12) return invalid('The arms are on top of each other.');
      return { kind: 'line', a: vertex, b: add(vertex, dir), span: 'line' };
    }

    case 'reflect': {
      if (missing(2)) return invalid('Needs something to reflect and a mirror line.');
      const mirror = asLine(p[1]);
      if (!mirror) return invalid('The mirror must be a line.');
      return mapValue(p[0]!, (q) => {
        const foot = footOfPerpendicular(mirror.a, mirror.b, q);
        return sub(mul(foot, 2), q);
      });
    }

    case 'rotate': {
      if (missing(2)) return invalid('Needs something to rotate and a centre.');
      const centre = asPoint(p[1]);
      if (!centre) return invalid('The centre must be a point.');
      const angle = ((o.value ?? 90) * Math.PI) / 180;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      return mapValue(p[0]!, (q) => {
        const d = sub(q, centre);
        return add(centre, { x: d.x * cosA - d.y * sinA, y: d.x * sinA + d.y * cosA });
      });
    }

    case 'translate': {
      if (missing(3)) return invalid('Needs something to move and two points giving the vector.');
      const from = asPoint(p[1]);
      const to = asPoint(p[2]);
      if (!from || !to) return invalid('The vector must be given by two points.');
      const v = sub(to, from);
      return mapValue(p[0]!, (q) => add(q, v));
    }

    case 'dilate': {
      if (missing(2)) return invalid('Needs something to scale and a centre.');
      const centre = asPoint(p[1]);
      if (!centre) return invalid('The centre must be a point.');
      const k = o.value ?? 2;
      if (!Number.isFinite(k) || Math.abs(k) < 1e-12) return invalid('The scale factor cannot be zero.');
      return mapValue(p[0]!, (q) => add(centre, mul(sub(q, centre), k)));
    }

    case 'conic': {
      if (missing(2)) return invalid('Needs a focus and a directrix.');
      const focus = asPoint(p[0]);
      const directrix = asLine(p[1]);
      if (!focus || !directrix) return invalid('Needs a focus point and a directrix line.');
      const foot = footOfPerpendicular(directrix.a, directrix.b, focus);
      const d0 = distance(focus, foot);
      if (!(d0 > 1e-9)) return invalid('The focus is on the directrix, which defines no conic.');
      const e = o.value ?? 0.6;
      if (!(e > 0) || !Number.isFinite(e)) return invalid('The eccentricity must be positive.');
      return { kind: 'conic', focus, foot, normal: norm(sub(focus, foot)), distance: d0, e };
    }

    case 'polygon': {
      if (o.parents.length < 3) return invalid('A polygon needs at least three vertices.');
      const points: Pt[] = [];
      for (const v of p) {
        const q = asPoint(v);
        if (!q) return invalid('Every vertex must be a point.');
        points.push(q);
      }
      return { kind: 'polygon', points };
    }

    default:
      return invalid('Unknown construction.');
  }
}

/**
 * Applies a point map to a whole object.
 *
 * Every transformation here is affine or a similarity, so a line maps to a line
 * and a circle to a circle — moving the two defining points is enough and the
 * result is exact. A conic under a non-uniform map would not survive this, and
 * there is no non-uniform map in the list.
 */
function mapValue(v: Value, f: (p: Pt) => Pt): Value {
  switch (v.kind) {
    case 'point':
      return { kind: 'point', p: f(v.p) };
    case 'line':
      return { kind: 'line', a: f(v.a), b: f(v.b), span: v.span };
    case 'circle': {
      // The radius is measured after mapping, so a dilation scales it and a
      // reflection or rotation leaves it alone — without any special cases.
      const c = f(v.c);
      const rim = f(add(v.c, { x: v.r, y: 0 }));
      return { kind: 'circle', c, r: distance(c, rim) };
    }
    case 'polygon':
      return { kind: 'polygon', points: v.points.map(f) };
    case 'conic': {
      const focus = f(v.focus);
      const foot = f(v.foot);
      return {
        kind: 'conic',
        focus,
        foot,
        normal: norm(sub(focus, foot)),
        distance: distance(focus, foot),
        e: v.e,
      };
    }
    default:
      return v;
  }
}

/** A point at parameter t along a path, with t running 0…1 over the visible part. */
export function pointAlong(path: Value, t: number): Pt {
  const u = Number.isFinite(t) ? t : 0;
  if (path.kind === 'circle') {
    const angle = 2 * Math.PI * u;
    return { x: path.c.x + path.r * Math.cos(angle), y: path.c.y + path.r * Math.sin(angle) };
  }
  if (path.kind === 'conic') {
    const theta = 2 * Math.PI * u;
    const denominator = 1 - path.e * Math.cos(theta);
    // On an asymptote there is no point at this parameter; the nearest usable
    // one is a long way out, and clamping keeps the handle on the curve.
    const safe = Math.abs(denominator) < 1e-4 ? Math.sign(denominator || 1) * 1e-4 : denominator;
    const r = (path.e * path.distance) / safe;
    const tangent = perp(path.normal);
    return add(path.focus, add(mul(path.normal, r * Math.cos(theta)), mul(tangent, r * Math.sin(theta))));
  }
  if (path.kind === 'line') {
    // A segment is parameterised over itself; a ray and a line get a range
    // around their two defining points so the handle has somewhere to go.
    const d = sub(path.b, path.a);
    if (path.span === 'segment') return add(path.a, mul(d, u));
    if (path.span === 'ray') return add(path.a, mul(d, u * 2));
    return add(path.a, mul(d, (u - 0.5) * 4));
  }
  if (path.kind === 'polygon' && path.points.length) {
    const n = path.points.length;
    const s = ((u % 1) + 1) % 1;
    const i = Math.min(n - 1, Math.floor(s * n));
    const local = s * n - i;
    return add(path.points[i], mul(sub(path.points[(i + 1) % n], path.points[i]), local));
  }
  return { x: 0, y: 0 };
}

/** Every point where two objects cross, ordered stably. */
export function intersectionsOf(v1: Value, v2: Value): Pt[] {
  if (v1.kind === 'line' && v2.kind === 'line') {
    const hit = intersectLines(v1, v2);
    return hit ? [hit] : [];
  }
  if (v1.kind === 'line' && v2.kind === 'circle') return intersectLineCircle(v1, v2);
  if (v1.kind === 'circle' && v2.kind === 'line') return intersectLineCircle(v2, v1);
  if (v1.kind === 'circle' && v2.kind === 'circle') return intersectCircles(v1, v2);
  return [];
}

// ------------------------------------------------------------------- locus

/**
 * The path one point sweeps out as another is driven along its own.
 *
 * This is the payoff of keeping the construction as a graph. The driver is any
 * point that sits on a path, the tracer is any point at all, and the locus is
 * found by moving the one and evaluating the whole graph again — so it works
 * for constructions nobody anticipated, and it is a *measurement* of the
 * figure rather than a formula for a curve.
 */
export function locus(
  construction: Construction,
  driverId: string,
  tracerId: string,
  samples = 240,
): Pt[][] {
  const driver = construction.objects.find((o) => o.id === driverId);
  if (!driver || driver.kind !== 'pointOn') return [];
  const count = Math.max(8, Math.min(2000, Math.round(samples)));

  const branches: Pt[][] = [];
  let current: Pt[] = [];
  let previous: Pt | null = null;

  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const moved: Construction = {
      objects: construction.objects.map((o) => (o.id === driverId ? { ...o, value: t } : o)),
    };
    const traced = evaluate(moved).values.get(tracerId);
    if (!traced || traced.kind !== 'point' || !finite(traced.p)) {
      if (current.length > 1) branches.push(current);
      current = [];
      previous = null;
      continue;
    }
    /* A jump means the construction has changed branch — an intersection that
     * stopped existing and came back on the other side, say. Joining across it
     * would draw a chord that is not part of the locus. */
    if (previous && distance(previous, traced.p) > 1e6) {
      if (current.length > 1) branches.push(current);
      current = [];
    }
    current.push(traced.p);
    previous = traced.p;
  }
  if (current.length > 1) branches.push(current);
  return branches;
}

// ------------------------------------------------------------ measurements

/** The angle at b, in degrees, between the arms b → a and b → c. */
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  const u = sub(a, b);
  const v = sub(c, b);
  const lu = len(u);
  const lv = len(v);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const cosine = Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** The shoelace area of a polygon; positive when the vertices go anticlockwise. */
export function polygonArea(points: Pt[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += cross(a, b);
  }
  return total / 2;
}

export const polygonPerimeter = (points: Pt[]): number => {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) total += distance(points[i], points[(i + 1) % points.length]);
  return total;
};

/** Whether three points lie on one line, to a tolerance scaled by their spread. */
export function collinear(a: Pt, b: Pt, c: Pt, tolerance = 1e-9): boolean {
  const scale = Math.max(distance(a, b), distance(b, c), distance(a, c), 1);
  return Math.abs(cross(sub(b, a), sub(c, a))) / (scale * scale) < tolerance;
}

/** Whether three lines pass through a single point. */
export function concurrent(
  l1: { a: Pt; b: Pt },
  l2: { a: Pt; b: Pt },
  l3: { a: Pt; b: Pt },
  tolerance = 1e-7,
): boolean {
  const hit = intersectLines({ ...l1, span: 'line' }, { ...l2, span: 'line' });
  if (!hit) return false;
  const scale = Math.max(distance(l3.a, l3.b), 1);
  return Math.abs(signedDistanceToLine(l3.a, l3.b, hit)) / scale < tolerance;
}

// --------------------------------------------------------------- clipping

/**
 * Trims a line to a rectangle so it can be drawn.
 *
 * An infinite line has to stop somewhere, and stopping it at its two defining
 * points — which is what happens if you forget — makes every "line" look like a
 * segment and hides the whole point of the distinction.
 */
export function clipToBox(
  line: { a: Pt; b: Pt; span: Span },
  box: { xMin: number; xMax: number; yMin: number; yMax: number },
): [Pt, Pt] | null {
  if (line.span === 'segment') return [line.a, line.b];
  const d = sub(line.b, line.a);
  if (len(d) < 1e-12) return null;

  // Liang–Barsky against the four edges, in the line's own parameter.
  let t0 = line.span === 'ray' ? 0 : -Infinity;
  let t1 = Infinity;
  const edges: [number, number][] = [
    [-d.x, line.a.x - box.xMin],
    [d.x, box.xMax - line.a.x],
    [-d.y, line.a.y - box.yMin],
    [d.y, box.yMax - line.a.y],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      // Parallel to this edge and outside it: nothing to draw.
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
  }
  if (t0 > t1) return null;
  return [add(line.a, mul(d, t0)), add(line.a, mul(d, t1))];
}

/** Points on a circle, for drawing. */
export function circlePoints(c: Pt, r: number, samples = 180): Pt[] {
  const n = Math.max(12, Math.min(1000, Math.round(samples)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const angle = (2 * Math.PI * i) / n;
    out.push({ x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) });
  }
  return out;
}

/** The nearest object to a point, for click-to-select. */
export function nearest(
  values: Map<string, Value>,
  objects: GeoObject[],
  at: Pt,
  tolerance: number,
): string | null {
  let best: string | null = null;
  let bestDistance = tolerance;
  // Points win ties against curves: a point sitting on the line that made it
  // is almost always what the user meant to grab.
  for (const wantPoint of [true, false]) {
    for (const object of objects) {
      if (!object.visible) continue;
      const value = values.get(object.id);
      if (!value || value.kind === 'invalid') continue;
      if ((value.kind === 'point') !== wantPoint) continue;
      const d = distanceToValue(value, at);
      if (d < bestDistance) {
        bestDistance = d;
        best = object.id;
      }
    }
    if (best) return best;
  }
  return best;
}

function distanceToValue(v: Value, at: Pt): number {
  switch (v.kind) {
    case 'point':
      return distance(v.p, at);
    case 'circle':
      return Math.abs(distance(v.c, at) - v.r);
    case 'line': {
      const t = parameterOn(v, at);
      const clamped = v.span === 'line' ? t : v.span === 'ray' ? Math.max(0, t) : Math.max(0, Math.min(1, t));
      return distance(add(v.a, mul(sub(v.b, v.a), clamped)), at);
    }
    case 'polygon': {
      let best = Infinity;
      for (let i = 0; i < v.points.length; i++) {
        const a = v.points[i];
        const b = v.points[(i + 1) % v.points.length];
        const t = Math.max(0, Math.min(1, parameterOn({ a, b }, at)));
        best = Math.min(best, distance(add(a, mul(sub(b, a), t)), at));
      }
      return best;
    }
    case 'conic': {
      // Measured against the sampled curve, which is close enough for picking
      // and avoids solving a quartic for the true foot.
      let best = Infinity;
      for (const branch of conicPoints(v.focus, v.foot, v.e, 400, 240)) {
        for (const p of branch) best = Math.min(best, distance(p, at));
      }
      return best;
    }
    default:
      return Infinity;
  }
}
