import { describe, expect, it } from 'vitest';
import { buildGraphScene, parsePoints, unboundSymbols } from '../src/modes/graphing';
import { makeExpression } from '../src/core/defaults';
import { EvalScope } from '../src/core/math/scope';
import type { Layer } from '../src/plot/scene';
import type { ExpressionItem } from '../src/core/types';

/* Plotting the wrong curve is the worst class of bug this app can have: it
 * produces something that looks like an answer, so nobody checks it. A polar
 * cardioid written `2(1 + cos(theta))` drew a circle of radius 4 for exactly
 * that reason — the sampler bound the angle to θ, `theta` was silently given a
 * slot of its own that nothing ever wrote to, and cos(0) = 1 made the radius
 * a constant 4. Every assertion below is against a closed form, never against
 * recorded output, so a curve that is merely *plausible* still fails.
 */

const VIEW = { xMin: -10, xMax: 10, yMin: -8, yMax: 8, width: 900, height: 700 };

function scene(expressions: ExpressionItem[], scope = new EvalScope()) {
  return buildGraphScene({ expressions, scope, view: VIEW, detailed: false });
}

/** Every sampled point of the curve layers, in plot coordinates. */
function points(layers: Layer[]): [number, number][] {
  const out: [number, number][] = [];
  for (const layer of layers) {
    if (layer.type !== 'curve') continue;
    for (const seg of layer.segments) {
      for (let i = 0; i < seg.length; i += 1) out.push([seg.xs[i], seg.ys[i]]);
    }
  }
  return out;
}

/** Enclosed area by the shoelace formula — a shape test the sampling cannot fake. */
function enclosedArea(pts: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function polar(source: string): ExpressionItem {
  const expr = makeExpression(source, 'polar');
  expr.tMin = 0;
  expr.tMax = 2 * Math.PI;
  return expr;
}

describe('polar curves', () => {
  // r = a(1 + cos θ) is a cardioid: it reaches 2a at θ = 0, has a cusp at the
  // origin at θ = π, and encloses 3πa²/2. For a = 2 that is 4, 0 and 6π.
  const CARDIOID_AREA = 6 * Math.PI;

  // All three are the same curve. A student types whichever their keyboard
  // offers, and the one that used to fail is the one most of them can type.
  for (const angle of ['θ', 'theta', 't']) {
    it(`plots the cardioid when the angle is written "${angle}"`, () => {
      const result = scene([polar(`2(1+cos(${angle}))`)]);
      expect(result.errors).toEqual([]);

      const pts = points(result.layers);
      expect(pts.length).toBeGreaterThan(200);

      // Every sampled point satisfies the polar equation it came from.
      for (const [x, y] of pts) {
        const r = Math.hypot(x, y);
        const expected = 2 * (1 + Math.cos(Math.atan2(y, x)));
        expect(Math.abs(r - expected)).toBeLessThan(1e-9);
      }

      // …and the curve as a whole is the right shape and the right size.
      expect(enclosedArea(pts)).toBeCloseTo(CARDIOID_AREA, 1);
      expect(Math.max(...pts.map(([x]) => x))).toBeCloseTo(4, 3);
      expect(Math.min(...pts.map(([x, y]) => Math.hypot(x, y)))).toBeLessThan(0.02);
    });
  }

  it('tells a cardioid apart from the circle it used to draw', () => {
    // The guard on the tests above: a constant radius really is a circle, so
    // the area assertion is discriminating rather than always true.
    const circle = points(scene([polar('4')]).layers);
    expect(enclosedArea(circle)).toBeCloseTo(16 * Math.PI, 1);
    expect(enclosedArea(circle)).not.toBeCloseTo(CARDIOID_AREA, 1);
  });

  it('lets a slider drive the radius without the angle overwriting it', () => {
    // `a` is a parameter and the angle is written `t`; both live in the same
    // frame, so this fails if binding the aliases clobbers a slider's slot.
    const scope = new EvalScope({ a: 3 });
    const result = scene([polar('a*(1+cos(t))')], scope);
    expect(result.errors).toEqual([]);
    const pts = points(result.layers);
    expect(enclosedArea(pts)).toBeCloseTo((3 * Math.PI * 9) / 2, 1);
    expect(Math.max(...pts.map(([x]) => x))).toBeCloseTo(6, 3);
  });

  it('reports a genuinely broken expression instead of drawing nothing', () => {
    const result = scene([polar('2(1+cos(θ)')]);
    expect(result.errors).toHaveLength(1);
    expect(result.layers).toHaveLength(0);
  });

  it('honours a restricted angle range', () => {
    const half = polar('2(1+cos(θ))');
    half.tMax = Math.PI;
    const pts = points(scene([half]).layers);
    // The upper half only: y ≥ 0 throughout, give or take the endpoint.
    expect(Math.min(...pts.map(([, y]) => y))).toBeGreaterThan(-1e-9);
  });
});

describe('the other kinds keep their own variables', () => {
  it('a function of x is sampled in x', () => {
    const pts = points(scene([makeExpression('x^2', 'function')]).layers);
    for (const [x, y] of pts) expect(y).toBeCloseTo(x * x, 9);
  });

  it('a parametric curve is sampled in t', () => {
    const expr = makeExpression('3cos(t)', 'parametric');
    expr.source2 = '3sin(t)';
    expr.tMin = 0;
    expr.tMax = 2 * Math.PI;
    const pts = points(scene([expr]).layers);
    expect(pts.length).toBeGreaterThan(100);
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(3, 9);
    expect(enclosedArea(pts)).toBeCloseTo(9 * Math.PI, 1);
  });

  it('does not let the polar aliases leak into a function of x', () => {
    // `theta` means nothing here, so it is an unbound symbol worth a slider —
    // not something the polar sampler has quietly left lying around.
    expect(unboundSymbols([makeExpression('theta*x', 'function')], new Set())).toEqual(['theta']);
  });
});

describe('unbound symbols', () => {
  const defined = new Set(['time', 'a']);

  it('accepts the variables each kind actually binds', () => {
    expect(unboundSymbols([makeExpression('sin(x)+a', 'function')], defined)).toEqual([]);
    expect(unboundSymbols([makeExpression('cos(t)', 'parametric')], defined)).toEqual([]);
    expect(unboundSymbols([polar('1+cos(θ)'), polar('1+cos(theta)'), polar('1+cos(t)')], defined)).toEqual([]);
    expect(unboundSymbols([makeExpression('x^2+y^2-4', 'implicit')], defined)).toEqual([]);
    expect(unboundSymbols([makeExpression('y-x', 'inequality')], defined)).toEqual([]);
  });

  it('reports a variable that means nothing in this kind of expression', () => {
    // Each of these used to be treated as already defined everywhere, so it
    // evaluated as zero and drew a wrong curve with no complaint at all.
    expect(unboundSymbols([makeExpression('sin(θ)', 'function')], defined)).toEqual(['θ']);
    expect(unboundSymbols([makeExpression('y+1', 'function')], defined)).toEqual(['y']);
    expect(unboundSymbols([polar('x+1')], defined)).toEqual(['x']);
    expect(unboundSymbols([makeExpression('n*x', 'function')], defined)).toEqual(['n']);
  });

  it('ignores built-in functions, constants and hidden expressions', () => {
    expect(unboundSymbols([makeExpression('sin(x)+pi+e', 'function')], defined)).toEqual([]);
    const hidden = makeExpression('k*x', 'function');
    hidden.visible = false;
    expect(unboundSymbols([hidden], defined)).toEqual([]);
  });

  it('contributes nothing from an expression it cannot parse', () => {
    expect(unboundSymbols([makeExpression('sin(', 'function')], defined)).toEqual([]);
  });

  it('counts the second source of a parametric curve', () => {
    const expr = makeExpression('cos(t)', 'parametric');
    expr.source2 = 'b*sin(t)';
    expect(unboundSymbols([expr], defined)).toEqual(['b']);
  });
});

describe('point lists', () => {
  it('reads points separated by commas, semicolons, newlines or spaces', () => {
    expect(parsePoints('-1, 0; 1, 0')).toEqual([
      [-1, 0],
      [1, 0],
    ]);
    expect(parsePoints('-1, 0\n1, 0')).toEqual([
      [-1, 0],
      [1, 0],
    ]);
    expect(parsePoints('0 1\n2 3')).toEqual([
      [0, 1],
      [2, 3],
    ]);
    // Extra columns are ignored rather than rejected: pasted data often has
    // a label or an error bar after the coordinates.
    expect(parsePoints('1, 2, ignored')).toEqual([[1, 2]]);
    // And a line that is not a pair is skipped, not fatal.
    expect(parsePoints('1, 2\nnonsense\n3, 4')).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('is not an expression, and must not be judged as one', () => {
    /* The panel used to run every row through the expression parser to decide
     * whether to show an error. A point list fails on its first comma, so a
     * perfectly good pair of points came with "could not parse this
     * expression" written under it — while the points themselves were on the
     * screen. The two readings have to agree. */
    const result = scene([makeExpression('-1, 0; 1, 0', 'points')]);
    expect(result.errors).toEqual([]);
    const drawn = result.layers.find((l): l is Extract<Layer, { type: 'points' }> => l.type === 'points');
    expect(drawn?.xs).toEqual([-1, 1]);
    expect(drawn?.ys).toEqual([0, 0]);
  });

  it('does report a list with nothing readable in it', () => {
    expect(scene([makeExpression('nothing here', 'points')]).errors.length).toBe(1);
  });
});
