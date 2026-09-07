import { describe, expect, it } from 'vitest';
import {
  angleAt,
  circlePoints,
  clipToBox,
  collinear,
  concurrent,
  conicGeometry,
  conicKind,
  conicPoints,
  distance,
  evaluate,
  footOfPerpendicular,
  intersectCircles,
  intersectLineCircle,
  intersectLines,
  locus,
  nearest,
  polygonArea,
  polygonPerimeter,
  signedDistanceToLine,
  type Construction,
  type GeoObject,
  type Pt,
} from '../src/core/math/geometry';

/* Geometry is the one subject in this app where the answers were settled two
 * thousand years ago, so nothing here is checked against what the code
 * produced last time. Every test asserts a theorem: the perpendicular
 * bisectors of a triangle meet at a point, that point is equidistant from the
 * vertices, an ellipse drawn from its focus and directrix has the sum of
 * distances to its two foci constant, and so on. A construction that gets a
 * theorem right for a hundred random triangles is right.
 */

let counter = 0;
const obj = (over: Partial<GeoObject> & Pick<GeoObject, 'kind'>): GeoObject => ({
  id: `o${counter++}`,
  parents: [],
  label: '',
  colour: '#fff',
  visible: true,
  ...over,
});

const free = (x: number, y: number, id?: string): GeoObject =>
  obj({ kind: 'point', x, y, ...(id ? { id } : {}) });

const build = (...objects: GeoObject[]): Construction => ({ objects });

const pointAt = (c: Construction, id: string): Pt => {
  const v = evaluate(c).values.get(id);
  if (!v || v.kind !== 'point') throw new Error(`${id} is not a point: ${v?.kind ?? 'missing'}`);
  return v.p;
};

/* A deterministic spread of awkward triangles, so the theorems below are
 * checked against a hundred shapes rather than one comfortable one. */
function* triangles(count = 60): Generator<[Pt, Pt, Pt]> {
  let seed = 20260906;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed % 100000) / 100000;
  };
  for (let i = 0; i < count; i++) {
    const a = { x: next() * 10 - 5, y: next() * 10 - 5 };
    const b = { x: next() * 10 - 5, y: next() * 10 - 5 };
    const c = { x: next() * 10 - 5, y: next() * 10 - 5 };
    // Skip anything too close to degenerate: the theorems still hold, but the
    // conditioning does not, and a test should not be a study of round-off.
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    if (area < 1.5) continue;
    yield [a, b, c];
  }
}

describe('primitives', () => {
  it('crosses two lines where algebra says', () => {
    const hit = intersectLines(
      { a: { x: 0, y: 0 }, b: { x: 4, y: 4 }, span: 'line' },
      { a: { x: 0, y: 4 }, b: { x: 4, y: 0 }, span: 'line' },
    );
    expect(hit!.x).toBeCloseTo(2, 12);
    expect(hit!.y).toBeCloseTo(2, 12);
  });

  it('refuses parallel lines', () => {
    expect(
      intersectLines(
        { a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, span: 'line' },
        { a: { x: 0, y: 1 }, b: { x: 1, y: 2 }, span: 'line' },
      ),
    ).toBeNull();
  });

  it('respects the span, so two segments that miss do not meet', () => {
    const crossing = { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } };
    const other = { a: { x: 3, y: 4 }, b: { x: 4, y: 3 } };
    // As infinite lines they meet at (3.5, 3.5); as segments they do not.
    expect(intersectLines({ ...crossing, span: 'line' }, { ...other, span: 'line' })).not.toBeNull();
    expect(intersectLines({ ...crossing, span: 'segment' }, { ...other, span: 'segment' })).toBeNull();
    // A ray from the origin does reach it, and (3.5, 3.5) is the midpoint of
    // the other segment, so as a ray-versus-segment the crossing is real.
    expect(intersectLines({ ...crossing, span: 'ray' }, { ...other, span: 'segment' })).not.toBeNull();
    // Shorten that segment so it stops short of the crossing and it is gone
    // again — the span is doing the work, not the direction.
    const stub = { a: { x: 3, y: 4 }, b: { x: 3.2, y: 3.8 } };
    expect(intersectLines({ ...crossing, span: 'ray' }, { ...stub, span: 'segment' })).toBeNull();
    expect(intersectLines({ ...crossing, span: 'ray' }, { ...stub, span: 'line' })).not.toBeNull();
  });

  it('cuts a circle at two points, ordered along the line', () => {
    const hits = intersectLineCircle(
      { a: { x: -5, y: 0 }, b: { x: 5, y: 0 }, span: 'line' },
      { c: { x: 0, y: 0 }, r: 3 },
    );
    expect(hits).toHaveLength(2);
    expect(hits[0].x).toBeCloseTo(-3, 12);
    expect(hits[1].x).toBeCloseTo(3, 12);
    // Ordering by parameter is what keeps a construction from swapping its two
    // intersections halfway through a drag.
    const reversed = intersectLineCircle(
      { a: { x: 5, y: 0 }, b: { x: -5, y: 0 }, span: 'line' },
      { c: { x: 0, y: 0 }, r: 3 },
    );
    expect(reversed[0].x).toBeCloseTo(3, 12);
  });

  it('finds a tangent as a single point', () => {
    const hits = intersectLineCircle(
      { a: { x: -5, y: 3 }, b: { x: 5, y: 3 }, span: 'line' },
      { c: { x: 0, y: 0 }, r: 3 },
    );
    expect(hits).toHaveLength(2);
    expect(hits[0].y).toBeCloseTo(3, 9);
    expect(distance(hits[0], hits[1])).toBeLessThan(1e-6);
  });

  it('misses a circle it does not reach', () => {
    expect(
      intersectLineCircle({ a: { x: -5, y: 9 }, b: { x: 5, y: 9 }, span: 'line' }, { c: { x: 0, y: 0 }, r: 3 }),
    ).toHaveLength(0);
  });

  it('crosses two circles at the classical points', () => {
    // Unit circles at 0 and 1 meet at (0.5, ±√3/2).
    const hits = intersectCircles({ c: { x: 0, y: 0 }, r: 1 }, { c: { x: 1, y: 0 }, r: 1 });
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h.x).toBeCloseTo(0.5, 12);
      expect(Math.abs(h.y)).toBeCloseTo(Math.sqrt(3) / 2, 12);
      // On both circles, which is the definition.
      expect(distance(h, { x: 0, y: 0 })).toBeCloseTo(1, 12);
      expect(distance(h, { x: 1, y: 0 })).toBeCloseTo(1, 12);
    }
    // The first is on the left of the line joining the centres, always.
    expect(hits[0].y).toBeGreaterThan(0);
  });

  it('refuses circles that are separate or nested', () => {
    expect(intersectCircles({ c: { x: 0, y: 0 }, r: 1 }, { c: { x: 9, y: 0 }, r: 1 })).toHaveLength(0);
    expect(intersectCircles({ c: { x: 0, y: 0 }, r: 5 }, { c: { x: 0.1, y: 0 }, r: 1 })).toHaveLength(0);
  });

  it('drops a perpendicular to the right foot', () => {
    const foot = footOfPerpendicular({ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 2, y: 5 });
    expect(foot.x).toBeCloseTo(2, 12);
    expect(foot.y).toBeCloseTo(0, 12);
    expect(signedDistanceToLine({ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 2, y: 5 })).toBeCloseTo(5, 12);
    // Signed: the other side is negative.
    expect(signedDistanceToLine({ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 2, y: -5 })).toBeCloseTo(-5, 12);
  });

  it('measures angles and areas', () => {
    expect(angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 12);
    expect(angleAt({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(180, 12);
    // A 3-4-5 triangle: area 6, perimeter 12.
    const t = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 0, y: 4 },
    ];
    expect(polygonArea(t)).toBeCloseTo(6, 12);
    expect(polygonPerimeter(t)).toBeCloseTo(12, 12);
    // The sign follows the winding, so reversing the vertices flips it.
    expect(polygonArea([...t].reverse())).toBeCloseTo(-6, 12);
  });

  it('clips an infinite line to the drawing box', () => {
    const clipped = clipToBox(
      { a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, span: 'line' },
      { xMin: -2, xMax: 2, yMin: -2, yMax: 2 },
    );
    expect(clipped![0].x).toBeCloseTo(-2, 12);
    expect(clipped![1].x).toBeCloseTo(2, 12);
    // A ray starts where it starts and is not extended backwards.
    const ray = clipToBox(
      { a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, span: 'ray' },
      { xMin: -2, xMax: 2, yMin: -2, yMax: 2 },
    );
    expect(ray![0].x).toBeCloseTo(0, 12);
    expect(ray![1].x).toBeCloseTo(2, 12);
    // And a line that misses the box entirely draws nothing.
    expect(
      clipToBox({ a: { x: 0, y: 9 }, b: { x: 1, y: 9 }, span: 'line' }, { xMin: -2, xMax: 2, yMin: -2, yMax: 2 }),
    ).toBeNull();
  });
});

describe('the construction graph', () => {
  it('evaluates parents before children however they are ordered', () => {
    // Deliberately listed child-first, which is what happens after an undo or
    // a reordered paste.
    const c = build(
      obj({ id: 'mid', kind: 'midpoint', parents: ['a', 'b'] }),
      free(0, 0, 'a'),
      free(4, 2, 'b'),
    );
    const mid = pointAt(c, 'mid');
    expect(mid.x).toBeCloseTo(2, 12);
    expect(mid.y).toBeCloseTo(1, 12);
  });

  it('reports a cycle instead of overflowing', () => {
    const c = build(
      obj({ id: 'x', kind: 'midpoint', parents: ['y', 'y'] }),
      obj({ id: 'y', kind: 'midpoint', parents: ['x', 'x'] }),
    );
    const result = evaluate(c);
    // Both members of the loop are named, not just the one where it happened
    // to be noticed — otherwise the other reports a misleading downstream
    // error and the user goes looking in the wrong place.
    expect(result.problems).toHaveLength(2);
    for (const problem of result.problems) expect(problem.why).toContain('depends on itself');
    expect(result.values.get('x')!.kind).toBe('invalid');
    expect(result.values.get('y')!.kind).toBe('invalid');
  });

  it('marks a child invalid when its parent is', () => {
    const c = build(
      free(0, 0, 'a'),
      free(0, 0, 'b'),
      // Both points in the same place: no line through them.
      obj({ id: 'l', kind: 'line', parents: ['a', 'b'] }),
      obj({ id: 'm', kind: 'perpendicular', parents: ['a', 'l'] }),
    );
    const values = evaluate(c).values;
    expect(values.get('l')!.kind).toBe('invalid');
    expect(values.get('m')!.kind).toBe('invalid');
  });

  it('moves the whole construction when a free point moves', () => {
    const c = build(
      free(0, 0, 'a'),
      free(4, 0, 'b'),
      obj({ id: 'mid', kind: 'midpoint', parents: ['a', 'b'] }),
      obj({ id: 'circ', kind: 'circle', parents: ['mid', 'b'] }),
    );
    expect(pointAt(c, 'mid').x).toBeCloseTo(2, 12);

    // Nothing is stored for the midpoint or the circle, so dragging b is all
    // it takes — which is the whole idea of dynamic geometry.
    const moved: Construction = {
      objects: c.objects.map((o) => (o.id === 'b' ? { ...o, x: 10, y: 6 } : o)),
    };
    expect(pointAt(moved, 'mid').x).toBeCloseTo(5, 12);
    expect(pointAt(moved, 'mid').y).toBeCloseTo(3, 12);
    const circle = evaluate(moved).values.get('circ')!;
    expect(circle.kind).toBe('circle');
    if (circle.kind === 'circle') expect(circle.r).toBeCloseTo(distance({ x: 5, y: 3 }, { x: 10, y: 6 }), 12);
  });
});

describe('classical constructions', () => {
  it('bisects a segment perpendicularly, equidistant by construction', () => {
    for (const [a, b] of [...triangles(20)].map(([p, q]) => [p, q] as const)) {
      const c = build(
        free(a.x, a.y, 'a'),
        free(b.x, b.y, 'b'),
        obj({ id: 'bis', kind: 'bisector', parents: ['a', 'b'] }),
      );
      const bisector = evaluate(c).values.get('bis')!;
      expect(bisector.kind).toBe('line');
      if (bisector.kind !== 'line') continue;
      // Every point on it is equidistant from the two, which *is* the definition.
      for (const t of [-2, 0, 0.5, 3]) {
        const p = {
          x: bisector.a.x + (bisector.b.x - bisector.a.x) * t,
          y: bisector.a.y + (bisector.b.y - bisector.a.y) * t,
        };
        expect(distance(p, a)).toBeCloseTo(distance(p, b), 9);
      }
    }
  });

  it('puts the circumcentre where the three bisectors meet, equidistant from all three vertices', () => {
    let checked = 0;
    for (const [a, b, c] of triangles()) {
      const construction = build(
        free(a.x, a.y, 'a'),
        free(b.x, b.y, 'b'),
        free(c.x, c.y, 'c'),
        obj({ id: 'ab', kind: 'bisector', parents: ['a', 'b'] }),
        obj({ id: 'bc', kind: 'bisector', parents: ['b', 'c'] }),
        obj({ id: 'ca', kind: 'bisector', parents: ['c', 'a'] }),
        obj({ id: 'o', kind: 'intersection', parents: ['ab', 'bc'] }),
      );
      const values = evaluate(construction).values;
      const ab = values.get('ab')!;
      const bc = values.get('bc')!;
      const ca = values.get('ca')!;
      if (ab.kind !== 'line' || bc.kind !== 'line' || ca.kind !== 'line') continue;

      // Concurrency: the third bisector passes through the other two's crossing.
      expect(concurrent(ab, bc, ca)).toBe(true);

      const o = pointAt(construction, 'o');
      const r = distance(o, a);
      expect(distance(o, b)).toBeCloseTo(r, 6);
      expect(distance(o, c)).toBeCloseTo(r, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('puts the incentre where the angle bisectors meet, equidistant from all three sides', () => {
    let checked = 0;
    for (const [a, b, c] of triangles()) {
      const construction = build(
        free(a.x, a.y, 'a'),
        free(b.x, b.y, 'b'),
        free(c.x, c.y, 'c'),
        obj({ id: 'ba', kind: 'angleBisector', parents: ['b', 'a', 'c'] }),
        obj({ id: 'bb', kind: 'angleBisector', parents: ['a', 'b', 'c'] }),
        obj({ id: 'i', kind: 'intersection', parents: ['ba', 'bb'] }),
      );
      const values = evaluate(construction).values;
      if (values.get('i')!.kind !== 'point') continue;
      const i = pointAt(construction, 'i');
      // Equidistant from the three sides, which is what makes it the incentre.
      const da = Math.abs(signedDistanceToLine(a, b, i));
      const db = Math.abs(signedDistanceToLine(b, c, i));
      const dc = Math.abs(signedDistanceToLine(c, a, i));
      expect(db).toBeCloseTo(da, 6);
      expect(dc).toBeCloseTo(da, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('makes an equilateral triangle the way Euclid does', () => {
    /* Elements I.1: two circles of radius AB centred at A and B, and either
     * crossing point completes an equilateral triangle. Checked as three equal
     * sides and three 60° angles. */
    const c = build(
      free(0, 0, 'a'),
      free(3.7, 1.1, 'b'),
      obj({ id: 'c1', kind: 'circle', parents: ['a', 'b'] }),
      obj({ id: 'c2', kind: 'circle', parents: ['b', 'a'] }),
      obj({ id: 'apex', kind: 'intersection', parents: ['c1', 'c2'], branch: 0 }),
    );
    const a = pointAt(c, 'a');
    const b = pointAt(c, 'b');
    const apex = pointAt(c, 'apex');
    const side = distance(a, b);
    expect(distance(a, apex)).toBeCloseTo(side, 9);
    expect(distance(b, apex)).toBeCloseTo(side, 9);
    expect(angleAt(a, apex, b)).toBeCloseTo(60, 6);
    expect(angleAt(apex, a, b)).toBeCloseTo(60, 6);
  });

  it('keeps the two circle intersections from swapping as the figure is dragged', () => {
    /* The classic dynamic-geometry failure: drag through a symmetric position
     * and the construction jumps to the other branch, tearing the figure. The
     * ordering rule says branch 0 is on the left of centre-to-centre, so it
     * has to stay on the left the whole way round. */
    let previous: Pt | null = null;
    for (let i = 0; i <= 40; i++) {
      const angle = (Math.PI * 2 * i) / 40;
      const c = build(
        free(0, 0, 'a'),
        free(2 * Math.cos(angle), 2 * Math.sin(angle), 'b'),
        obj({ id: 'c1', kind: 'circleRadius', parents: ['a'], value: 1.6 }),
        obj({ id: 'c2', kind: 'circleRadius', parents: ['b'], value: 1.6 }),
        obj({ id: 'p', kind: 'intersection', parents: ['c1', 'c2'], branch: 0 }),
      );
      const p = pointAt(c, 'p');
      const b = pointAt(c, 'b');
      // Always to the left of a → b.
      expect(signedDistanceToLine({ x: 0, y: 0 }, b, p)).toBeGreaterThan(0);
      // And moving continuously: a swap would show as a jump of about 2h.
      if (previous) expect(distance(previous, p)).toBeLessThan(0.6);
      previous = p;
    }
  });

  it('parallels stay parallel and perpendiculars stay square', () => {
    const c = build(
      free(-1, 2, 'p'),
      free(0, 0, 'a'),
      free(3, 1, 'b'),
      obj({ id: 'l', kind: 'line', parents: ['a', 'b'] }),
      obj({ id: 'par', kind: 'parallel', parents: ['p', 'l'] }),
      obj({ id: 'perp', kind: 'perpendicular', parents: ['p', 'l'] }),
    );
    const values = evaluate(c).values;
    const l = values.get('l')!;
    const par = values.get('par')!;
    const perp = values.get('perp')!;
    if (l.kind !== 'line' || par.kind !== 'line' || perp.kind !== 'line') throw new Error('not lines');

    const dl = { x: l.b.x - l.a.x, y: l.b.y - l.a.y };
    const dpar = { x: par.b.x - par.a.x, y: par.b.y - par.a.y };
    const dperp = { x: perp.b.x - perp.a.x, y: perp.b.y - perp.a.y };
    // Parallel: zero cross product. Perpendicular: zero dot product.
    expect(dl.x * dpar.y - dl.y * dpar.x).toBeCloseTo(0, 12);
    expect(dl.x * dperp.x + dl.y * dperp.y).toBeCloseTo(0, 12);
    // Both pass through the point they were told to.
    expect(distance(par.a, { x: -1, y: 2 })).toBeCloseTo(0, 12);
    // A parallel never meets the line it is parallel to.
    expect(intersectLines(l, par)).toBeNull();
  });

  it('proves Thales: an angle in a semicircle is right', () => {
    for (let i = 1; i < 20; i++) {
      const c = build(
        free(-2, 0, 'a'),
        free(2, 0, 'b'),
        obj({ id: 'mid', kind: 'midpoint', parents: ['a', 'b'] }),
        obj({ id: 'circ', kind: 'circle', parents: ['mid', 'b'] }),
        obj({ id: 'p', kind: 'pointOn', parents: ['circ'], value: i / 20 }),
      );
      const a = pointAt(c, 'a');
      const b = pointAt(c, 'b');
      const p = pointAt(c, 'p');
      if (distance(p, a) < 1e-6 || distance(p, b) < 1e-6) continue;
      expect(angleAt(a, p, b)).toBeCloseTo(90, 6);
    }
  });
});

describe('transformations', () => {
  it('reflects a point to the other side, the same distance away', () => {
    const c = build(
      free(0, 0, 'a'),
      free(1, 0, 'b'),
      obj({ id: 'mirror', kind: 'line', parents: ['a', 'b'] }),
      free(2, 3, 'p'),
      obj({ id: 'q', kind: 'reflect', parents: ['p', 'mirror'] }),
    );
    const q = pointAt(c, 'q');
    expect(q.x).toBeCloseTo(2, 12);
    expect(q.y).toBeCloseTo(-3, 12);
    // Reflecting twice is the identity, for any mirror.
    const twice = build(
      ...c.objects,
      obj({ id: 'r', kind: 'reflect', parents: ['q', 'mirror'] }),
    );
    const r = pointAt(twice, 'r');
    expect(r.x).toBeCloseTo(2, 12);
    expect(r.y).toBeCloseTo(3, 12);
  });

  it('rotates by the angle asked for, preserving distance to the centre', () => {
    const c = build(
      free(0, 0, 'o'),
      free(2, 0, 'p'),
      obj({ id: 'q', kind: 'rotate', parents: ['p', 'o'], value: 90 }),
    );
    const q = pointAt(c, 'q');
    expect(q.x).toBeCloseTo(0, 12);
    expect(q.y).toBeCloseTo(2, 12);
    expect(distance(q, { x: 0, y: 0 })).toBeCloseTo(2, 12);
  });

  it('rotates a circle without changing its radius, and dilates it by exactly the factor', () => {
    const c = build(
      free(0, 0, 'o'),
      free(3, 0, 'centre'),
      free(4, 0, 'rim'),
      obj({ id: 'circ', kind: 'circle', parents: ['centre', 'rim'] }),
      obj({ id: 'turned', kind: 'rotate', parents: ['circ', 'o'], value: 37 }),
      obj({ id: 'bigger', kind: 'dilate', parents: ['circ', 'o'], value: 2.5 }),
    );
    const values = evaluate(c).values;
    const original = values.get('circ')!;
    const turned = values.get('turned')!;
    const bigger = values.get('bigger')!;
    if (original.kind !== 'circle' || turned.kind !== 'circle' || bigger.kind !== 'circle') {
      throw new Error('expected circles');
    }
    expect(turned.r).toBeCloseTo(original.r, 12);
    expect(distance(turned.c, { x: 0, y: 0 })).toBeCloseTo(3, 12);
    expect(bigger.r).toBeCloseTo(original.r * 2.5, 12);
    expect(bigger.c.x).toBeCloseTo(7.5, 12);
  });

  it('translates by the vector between two points', () => {
    const c = build(
      free(1, 1, 'from'),
      free(4, 5, 'to'),
      free(0, 0, 'p'),
      obj({ id: 'q', kind: 'translate', parents: ['p', 'from', 'to'] }),
    );
    const q = pointAt(c, 'q');
    expect(q.x).toBeCloseTo(3, 12);
    expect(q.y).toBeCloseTo(4, 12);
  });

  it('preserves area under an isometry and scales it by k² under a dilation', () => {
    const c = build(
      free(0, 0, 'o'),
      free(0, 0, 'a'),
      free(4, 0, 'b'),
      free(0, 3, 'cc'),
      obj({ id: 'tri', kind: 'polygon', parents: ['a', 'b', 'cc'] }),
      obj({ id: 'turned', kind: 'rotate', parents: ['tri', 'o'], value: 41 }),
      obj({ id: 'scaled', kind: 'dilate', parents: ['tri', 'o'], value: 3 }),
    );
    const values = evaluate(c).values;
    const original = values.get('tri')!;
    const turned = values.get('turned')!;
    const scaled = values.get('scaled')!;
    if (original.kind !== 'polygon' || turned.kind !== 'polygon' || scaled.kind !== 'polygon') {
      throw new Error('expected polygons');
    }
    expect(Math.abs(polygonArea(original.points))).toBeCloseTo(6, 12);
    expect(Math.abs(polygonArea(turned.points))).toBeCloseTo(6, 9);
    // Area goes as the square of the scale factor, which is the fact this
    // transformation most often gets used to demonstrate.
    expect(Math.abs(polygonArea(scaled.points))).toBeCloseTo(6 * 9, 9);
  });
});

describe('conics from focus and directrix', () => {
  const directrixAt = (x: number) => ({ a: { x, y: -1 }, b: { x, y: 1 }, span: 'line' as const });

  const conic = (focusX: number, directrixX: number, e: number) =>
    build(
      free(focusX, 0, 'f'),
      free(directrixX, -1, 'd1'),
      free(directrixX, 1, 'd2'),
      obj({ id: 'dir', kind: 'line', parents: ['d1', 'd2'] }),
      obj({ id: 'k', kind: 'conic', parents: ['f', 'dir'], value: e }),
    );

  it('names the three kinds by eccentricity', () => {
    expect(conicKind(0.5)).toBe('ellipse');
    expect(conicKind(1)).toBe('parabola');
    expect(conicKind(2.4)).toBe('hyperbola');
  });

  it('satisfies the defining property at every sampled point', () => {
    for (const e of [0.35, 0.7, 1, 1.6, 3]) {
      const focus = { x: 0, y: 0 };
      const foot = { x: -2, y: 0 };
      const branches = conicPoints(focus, foot, e, 60, 400);
      expect(branches.length).toBeGreaterThan(0);
      let checked = 0;
      for (const branch of branches) {
        for (const p of branch) {
          // |PF| = e · dist(P, directrix). Nothing else is being asserted here,
          // because nothing else is the definition.
          const toFocus = distance(p, focus);
          const toDirectrix = Math.abs(signedDistanceToLine(directrixAt(-2).a, directrixAt(-2).b, p));
          expect(toFocus).toBeCloseTo(e * toDirectrix, 6);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(100);
    }
  });

  it('closes an ellipse and gives it the right axes and second focus', () => {
    const e = 0.6;
    const focus = { x: 0, y: 0 };
    const foot = { x: -2.5, y: 0 };
    const g = conicGeometry(focus, foot, e);
    expect(g.kind).toBe('ellipse');

    // l = e·d₀, a = l/(1−e²), b = l/√(1−e²), c = ae — all standard, and none
    // of them used by the sampler that drew the curve.
    const l = e * 2.5;
    expect(g.semiLatus).toBeCloseTo(l, 12);
    expect(g.a).toBeCloseTo(l / (1 - e * e), 12);
    expect(g.b).toBeCloseTo(l / Math.sqrt(1 - e * e), 12);
    expect(g.c).toBeCloseTo(g.a * e, 12);
    expect(g.b).toBeCloseTo(Math.sqrt(g.a * g.a - g.c * g.c), 9);

    const branches = conicPoints(focus, foot, e, 200, 600);
    expect(branches).toHaveLength(1);
    // Closed: the last point returns to the first.
    const arc = branches[0];
    expect(distance(arc[0], arc[arc.length - 1])).toBeLessThan(1e-9);

    // The string property: the sum of the distances to the two foci is 2a at
    // every point. This is the classical definition, and it comes out of a
    // curve that was drawn from the *other* one.
    for (const p of arc) {
      expect(distance(p, focus) + distance(p, g.otherFocus!)).toBeCloseTo(2 * g.a, 6);
    }
  });

  it('gives a hyperbola two branches whose distance difference is constant', () => {
    const e = 1.8;
    const focus = { x: 0, y: 0 };
    const foot = { x: -1.5, y: 0 };
    const g = conicGeometry(focus, foot, e);
    expect(g.kind).toBe('hyperbola');
    const branches = conicPoints(focus, foot, e, 120, 900);
    // Two arms, drawn separately rather than joined across the asymptotes.
    expect(branches.length).toBeGreaterThanOrEqual(2);
    for (const branch of branches) {
      for (const p of branch) {
        expect(Math.abs(distance(p, focus) - distance(p, g.otherFocus!))).toBeCloseTo(2 * g.a, 5);
      }
    }
  });

  it('gives a parabola points equidistant from focus and directrix, and no second focus', () => {
    const g = conicGeometry({ x: 0, y: 0 }, { x: -2, y: 0 }, 1);
    expect(g.kind).toBe('parabola');
    expect(g.otherFocus).toBeNull();
    expect(g.semiLatus).toBeCloseTo(2, 12);
    const branches = conicPoints({ x: 0, y: 0 }, { x: -2, y: 0 }, 1, 80, 600);
    let checked = 0;
    for (const branch of branches) {
      for (const p of branch) {
        const d = Math.abs(signedDistanceToLine({ x: -2, y: -1 }, { x: -2, y: 1 }, p));
        expect(distance(p, { x: 0, y: 0 })).toBeCloseTo(d, 6);
        // y² = 2·l·x measured from the vertex, with the vertex midway between
        // focus and directrix at x = −1.
        expect(p.y * p.y).toBeCloseTo(2 * g.semiLatus * (p.x + 1), 5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('builds a conic through the graph and moves it when the focus moves', () => {
    const c = conic(0, -2, 0.5);
    const value = evaluate(c).values.get('k')!;
    expect(value.kind).toBe('conic');
    if (value.kind !== 'conic') return;
    expect(value.distance).toBeCloseTo(2, 12);

    const moved: Construction = {
      objects: c.objects.map((o) => (o.id === 'f' ? { ...o, x: 3 } : o)),
    };
    const after = evaluate(moved).values.get('k')!;
    if (after.kind !== 'conic') throw new Error('expected a conic');
    expect(after.distance).toBeCloseTo(5, 12);
  });

  it('refuses a focus sitting on its own directrix', () => {
    const c = conic(-2, -2, 0.5);
    const value = evaluate(c).values.get('k')!;
    expect(value.kind).toBe('invalid');
    if (value.kind === 'invalid') expect(value.why).toContain('directrix');
  });
});

describe('loci', () => {
  it('traces the circle a midpoint sweeps out', () => {
    /* The midpoint of a fixed point and a point running round a circle traces
     * another circle, of half the radius, centred midway. Known in advance,
     * which is what makes it a test rather than a demonstration. */
    const c = build(
      free(0, 0, 'centre'),
      free(4, 0, 'rim'),
      obj({ id: 'circ', kind: 'circle', parents: ['centre', 'rim'] }),
      obj({ id: 'driver', kind: 'pointOn', parents: ['circ'], value: 0 }),
      free(6, 0, 'fixed'),
      obj({ id: 'mid', kind: 'midpoint', parents: ['driver', 'fixed'] }),
    );
    const branches = locus(c, 'driver', 'mid', 200);
    expect(branches).toHaveLength(1);
    const path = branches[0];
    expect(path.length).toBeGreaterThan(150);
    for (const p of path) {
      expect(distance(p, { x: 3, y: 0 })).toBeCloseTo(2, 9);
    }
  });

  it('traces an ellipse from the classical two-circle construction', () => {
    /* A point on a circle, projected onto a chord: the locus is an ellipse.
     * Here, more simply: take P on a circle of radius a about the origin and
     * halve its y coordinate by reflecting-and-dilating. The result should
     * satisfy x²/a² + y²/(a/2)² = 1. */
    const c = build(
      free(0, 0, 'o'),
      free(4, 0, 'rim'),
      obj({ id: 'circ', kind: 'circle', parents: ['o', 'rim'] }),
      obj({ id: 'p', kind: 'pointOn', parents: ['circ'], value: 0 }),
      free(0, 0, 'axisA'),
      free(1, 0, 'axisB'),
      obj({ id: 'xaxis', kind: 'line', parents: ['axisA', 'axisB'] }),
      obj({ id: 'foot', kind: 'reflect', parents: ['p', 'xaxis'] }),
      obj({ id: 'mid', kind: 'midpoint', parents: ['p', 'foot'] }),
      // Midway between P and its reflection is the foot on the axis; halving
      // instead needs the midpoint of P and that foot.
      obj({ id: 'half', kind: 'midpoint', parents: ['p', 'mid'] }),
    );
    const branches = locus(c, 'p', 'half', 240);
    expect(branches).toHaveLength(1);
    for (const q of branches[0]) {
      expect((q.x * q.x) / 16 + (q.y * q.y) / 4).toBeCloseTo(1, 6);
    }
  });

  it('breaks the locus where the construction stops existing', () => {
    /* The driver runs along a line; a circle about it meets a fixed circle only
     * for part of that run. The locus must come back in pieces rather than as
     * one curve joined across the gap. */
    const c = build(
      free(-8, 0, 'a'),
      free(8, 0, 'b'),
      obj({ id: 'track', kind: 'segment', parents: ['a', 'b'] }),
      obj({ id: 'driver', kind: 'pointOn', parents: ['track'], value: 0 }),
      obj({ id: 'moving', kind: 'circleRadius', parents: ['driver'], value: 1 }),
      free(0, 0, 'o'),
      obj({ id: 'fixed', kind: 'circleRadius', parents: ['o'], value: 2 }),
      obj({ id: 'hit', kind: 'intersection', parents: ['moving', 'fixed'], branch: 0 }),
    );
    const branches = locus(c, 'driver', 'hit', 300);
    expect(branches.length).toBeGreaterThanOrEqual(1);
    // Every traced point is on the fixed circle, wherever it exists at all.
    for (const branch of branches) {
      for (const p of branch) expect(distance(p, { x: 0, y: 0 })).toBeCloseTo(2, 6);
    }
    // And there really is a stretch with no intersection: the driver spends
    // most of the segment too far away for the circles to meet.
    const total = branches.reduce((n, b) => n + b.length, 0);
    expect(total).toBeLessThan(280);
  });

  it('returns nothing when the driver is not a point on a path', () => {
    const c = build(free(0, 0, 'a'), free(1, 1, 'b'), obj({ id: 'mid', kind: 'midpoint', parents: ['a', 'b'] }));
    expect(locus(c, 'a', 'mid', 50)).toEqual([]);
  });
});

describe('picking', () => {
  it('prefers a point to the line it sits on', () => {
    const c = build(
      free(0, 0, 'a'),
      free(4, 0, 'b'),
      obj({ id: 'l', kind: 'segment', parents: ['a', 'b'] }),
      obj({ id: 'mid', kind: 'midpoint', parents: ['a', 'b'] }),
    );
    const values = evaluate(c).values;
    // Right on top of the midpoint, which lies exactly on the segment.
    expect(nearest(values, c.objects, { x: 2, y: 0.01 }, 0.4)).toBe('mid');
    // Away from any point, the segment is the nearest thing.
    expect(nearest(values, c.objects, { x: 3.4, y: 0.05 }, 0.4)).toBe('l');
    // And nothing at all when the click is in empty space.
    expect(nearest(values, c.objects, { x: 3.4, y: 9 }, 0.4)).toBeNull();
  });

  it('ignores hidden objects', () => {
    const c = build(free(0, 0, 'a'), { ...free(1, 1, 'b'), visible: false });
    const values = evaluate(c).values;
    expect(nearest(values, c.objects, { x: 1, y: 1 }, 0.4)).toBeNull();
    expect(nearest(values, c.objects, { x: 0, y: 0 }, 0.4)).toBe('a');
  });
});

describe('drawing helpers', () => {
  it('samples a closed circle', () => {
    const pts = circlePoints({ x: 1, y: 2 }, 3, 64);
    expect(pts).toHaveLength(65);
    for (const p of pts) expect(distance(p, { x: 1, y: 2 })).toBeCloseTo(3, 12);
    expect(distance(pts[0], pts[pts.length - 1])).toBeCloseTo(0, 12);
  });

  it('knows collinear from not', () => {
    expect(collinear({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 })).toBe(true);
    expect(collinear({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5.1 })).toBe(false);
  });
});
