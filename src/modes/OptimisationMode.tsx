import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import type { TabState } from '../core/types';
import {
  constrainedExtrema,
  feasibleRegion,
  gradientDescent,
  solveLinearProgram,
  traceZeroLevel,
  type Constraint,
  type DescentMethod,
  type Relation,
} from '../core/math/optimise';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { useSquareScales } from '../components/sandbox/useSquareScales';
import { AnalyticCard } from '../components/sandbox/AnalyticCard';
import { ViewPanel } from '../components/panels/ViewPanel';
import {
  Callout,
  Collapsible,
  Field,
  IconButton,
  NumberField,
  Panel,
  Row,
  SegmentedControl,
  Select,
  Slider,
  Stat,
  StatList,
  Toggle,
  fmt,
} from '../components/ui/controls';
import { IconTrash } from '../components/ui/Icons';
import { useScope } from '../hooks/useScope';
import { EvalScope } from '../core/math/scope';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* Optimisation and operations research.
 *
 * One question — where is the best point of a set — asked three ways, and the
 * differences between the three are geometric, so they are drawn rather than
 * described.
 *
 *   Linear — the set is a polygon and the answer is at a corner. The simplex
 *     path is drawn *on* the region it walks, one pivot at a time, because
 *     "the method moves from corner to corner improving the objective" is a
 *     sentence that means nothing until you have watched it happen.
 *   Descent — the set is the plane. Watching the same surface under different
 *     methods and step sizes is the fastest way to understand why anyone
 *     bothered inventing momentum.
 *   Lagrange — the set is a curve, and the multiplier condition is that two
 *     arrows point along the same line. Drawn as two arrows.
 */

const VIEWS = [
  { value: 'linear' as const, label: 'Linear', title: 'A linear program, its feasible region and the simplex path.' },
  { value: 'descent' as const, label: 'Descent', title: 'Gradient descent on a surface you type.' },
  { value: 'lagrange' as const, label: 'Lagrange', title: 'Optimise along a constraint curve, with the multiplier.' },
];

const METHODS: { value: DescentMethod; label: string; hint: string }[] = [
  { value: 'gradient', label: 'Gradient descent', hint: 'Straight downhill, every step. Simple, and slow in a valley.' },
  { value: 'momentum', label: 'Momentum', hint: 'Remembers the last step. Runs along a valley instead of across it.' },
  { value: 'nesterov', label: 'Nesterov', hint: 'Momentum, but measures the slope where it is about to be.' },
  { value: 'adam', label: 'Adam', hint: 'Rescales each axis by its own recent gradients.' },
  { value: 'newton', label: 'Newton', hint: 'Uses the curvature. One step on a quadratic — and it finds saddles.' },
];

const RELATIONS: { value: Relation; label: string }[] = [
  { value: '<=', label: '≤' },
  { value: '>=', label: '≥' },
  { value: '=', label: '=' },
];

const REGION = '#38bdf8';
const PATH = '#f472b6';
const OPTIMUM = '#fbbf24';

// ------------------------------------------------------------------ scenes

function linearScene(tab: TabState): PlotScene {
  const cfg = tab.optimisation;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];
  const result = solveLinearProgram(cfg.program);
  const region = feasibleRegion(cfg.program);

  if (cfg.showRegion && region.length >= 3) {
    layers.push({
      type: 'polyline',
      closed: true,
      xs: Float64Array.from(region.map((p) => p.x)),
      ys: Float64Array.from(region.map((p) => p.y)),
      fill: withAlpha(REGION, 0.16),
      colour: withAlpha(REGION, 0.75),
      width: 1.8,
    });
    legend.push({ label: 'feasible', colour: REGION });
  }

  // Each constraint as the line it is, so a binding one can be seen to be
  // binding rather than inferred from the shape of the polygon.
  for (const c of cfg.program.constraints) {
    const [a, b] = c.coefficients;
    if (Math.abs(a) < 1e-12 && Math.abs(b) < 1e-12) continue;
    const view = tab.viewport;
    const pts: { x: number; y: number }[] = [];
    if (Math.abs(b) > 1e-12) {
      pts.push({ x: view.xMin, y: (c.rhs - a * view.xMin) / b });
      pts.push({ x: view.xMax, y: (c.rhs - a * view.xMax) / b });
    } else {
      pts.push({ x: c.rhs / a, y: view.yMin });
      pts.push({ x: c.rhs / a, y: view.yMax });
    }
    layers.push({
      type: 'polyline',
      xs: Float64Array.from(pts.map((p) => p.x)),
      ys: Float64Array.from(pts.map((p) => p.y)),
      colour: 'rgba(148,163,184,0.55)',
      width: 1.2,
      style: 'dashed',
    });
  }

  /* The simplex path. Stepping is by *pivot*, and the whole point is that each
   * one lands on a corner of the polygon drawn underneath. */
  const path = result.path;
  const upTo = cfg.simplexStep < 0 ? path.length : Math.min(path.length, cfg.simplexStep + 1);
  const walked = path.slice(0, upTo);
  if (walked.length > 0) {
    layers.push({
      type: 'polyline',
      xs: Float64Array.from(walked.map((s) => s.point[0] ?? 0)),
      ys: Float64Array.from(walked.map((s) => s.point[1] ?? 0)),
      colour: PATH,
      width: 2.4,
    });
    layers.push({
      type: 'points',
      xs: walked.map((s) => s.point[0] ?? 0),
      ys: walked.map((s) => s.point[1] ?? 0),
      colour: PATH,
      radius: 4,
    });
    legend.push({ label: 'simplex path', colour: PATH });

    // The objective's level line through wherever the walk has reached: the
    // line the method is pushing outwards, and the reason the corner it stops
    // at is the corner it stops at.
    const here = walked[walked.length - 1];
    if (cfg.showObjectiveLine) {
      const [p, q] = cfg.program.objective;
      const level = p * (here.point[0] ?? 0) + q * (here.point[1] ?? 0);
      const view = tab.viewport;
      const pts =
        Math.abs(q) > 1e-12
          ? [
              { x: view.xMin, y: (level - p * view.xMin) / q },
              { x: view.xMax, y: (level - p * view.xMax) / q },
            ]
          : [
              { x: level / p, y: view.yMin },
              { x: level / p, y: view.yMax },
            ];
      layers.push({
        type: 'polyline',
        xs: Float64Array.from(pts.map((v) => v.x)),
        ys: Float64Array.from(pts.map((v) => v.y)),
        colour: OPTIMUM,
        width: 1.6,
        style: 'dotted',
      });
      legend.push({ label: `objective = ${fmt(level, 4)}`, colour: OPTIMUM, dashed: true });
    }
  }

  if (result.status === 'optimal' && result.point && cfg.simplexStep < 0) {
    layers.push({
      type: 'points',
      xs: [result.point[0]],
      ys: [result.point[1]],
      colour: OPTIMUM,
      radius: 6,
      shape: 'ring',
    });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'x₁',
    yLabel: 'x₂',
    legend,
  };
}

/** Contours of f, by tracing the level set at each of several heights. */
function contourLayers(
  f: (x: number, y: number) => number,
  view: { xMin: number; xMax: number; yMin: number; yMax: number },
  count: number,
  colour: string,
): Layer[] {
  const out: Layer[] = [];
  // Sample to find the range, then space the levels *geometrically* where the
  // surface spans orders of magnitude — a Rosenbrock banana drawn on linearly
  // spaced contours is one blob and thirteen invisible lines.
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j <= 40; j++) {
    for (let i = 0; i <= 40; i++) {
      const v = f(view.xMin + ((view.xMax - view.xMin) * i) / 40, view.yMin + ((view.yMax - view.yMin) * j) / 40);
      if (!Number.isFinite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return out;

  const n = Math.max(2, Math.min(40, Math.round(count)));
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1);
    const level = lo >= 0 ? lo + (hi - lo) * t ** 2.2 : lo + (hi - lo) * t;
    const branches = traceZeroLevel((x, y) => f(x, y) - level, view, 150);
    for (const branch of branches) {
      out.push({
        type: 'polyline',
        xs: Float64Array.from(branch.map((p) => p.x)),
        ys: Float64Array.from(branch.map((p) => p.y)),
        colour: withAlpha(colour, 0.3),
        width: 1,
      });
    }
  }
  return out;
}

function descentScene(tab: TabState, f: ((x: number, y: number) => number) | null): PlotScene {
  const cfg = tab.optimisation;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];
  if (!f) {
    return {
      viewport: tab.viewport,
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: tab.showMinorGrid,
      showAxes: tab.showAxes,
      xLabel: 'x',
      yLabel: 'y',
      legend,
    };
  }

  if (cfg.showContours) layers.push(...contourLayers(f, tab.viewport, cfg.contourCount, REGION));

  const result = gradientDescent(f, {
    method: cfg.method,
    rate: cfg.rate,
    momentum: cfg.momentum,
    steps: cfg.descentSteps,
    start: [cfg.startX, cfg.startY],
    tolerance: 1e-10,
  });

  if (result.path.length) {
    layers.push({
      type: 'polyline',
      xs: Float64Array.from(result.path.map((p) => p.x)),
      ys: Float64Array.from(result.path.map((p) => p.y)),
      colour: PATH,
      width: 1.6,
    });
    legend.push({ label: `${result.path.length} steps`, colour: PATH });
    layers.push({ type: 'points', xs: [cfg.startX], ys: [cfg.startY], colour: '#94a3b8', radius: 4 });
    if (result.final) {
      layers.push({
        type: 'points',
        xs: [result.final.x],
        ys: [result.final.y],
        colour: OPTIMUM,
        radius: 5,
        shape: 'ring',
      });
    }
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'x',
    yLabel: 'y',
    legend,
  };
}

function lagrangeScene(
  tab: TabState,
  f: ((x: number, y: number) => number) | null,
  g: ((x: number, y: number) => number) | null,
): PlotScene {
  const cfg = tab.optimisation;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];
  if (!f || !g) {
    return {
      viewport: tab.viewport,
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: tab.showMinorGrid,
      showAxes: tab.showAxes,
      xLabel: 'x',
      yLabel: 'y',
      legend,
    };
  }

  if (cfg.showContours) layers.push(...contourLayers(f, tab.viewport, cfg.contourCount, REGION));

  const result = constrainedExtrema(f, g, tab.viewport, 260);
  for (const branch of result.curve) {
    layers.push({
      type: 'polyline',
      xs: Float64Array.from(branch.map((p) => p.x)),
      ys: Float64Array.from(branch.map((p) => p.y)),
      colour: PATH,
      width: 2.4,
    });
  }
  if (result.curve.length) legend.push({ label: 'g = 0', colour: PATH });

  /* The two gradients, drawn to the same visual scale so "parallel" is
   * something the eye checks and "λ" is the ratio of the lengths. Scaled to
   * the window rather than to the numbers, because ∇f and ∇g routinely differ
   * by a factor of a hundred and one of them would be a dot. */
  const span = Math.min(tab.viewport.xMax - tab.viewport.xMin, tab.viewport.yMax - tab.viewport.yMin);
  for (const p of [result.best, result.worst]) {
    if (!p) continue;
    layers.push({
      type: 'points',
      xs: [p.x],
      ys: [p.y],
      colour: OPTIMUM,
      radius: p.kind === 'maximum' ? 6 : 5,
      shape: p.kind === 'maximum' ? 'ring' : 'circle',
    });
    if (!cfg.showGradients) continue;
    const draw = (v: [number, number], colour: string, scale: number) => {
      const len = Math.hypot(v[0], v[1]);
      if (!(len > 1e-12)) return;
      // The arrows layer centres each arrow on its anchor, so the tail has to
      // be offset by half the length to make it start at the point.
      const reach = span * 0.16 * scale;
      const dx = (v[0] / len) * reach;
      const dy = (v[1] / len) * reach;
      layers.push({
        type: 'arrows',
        arrows: [{ x: p.x + dx / 2, y: p.y + dy / 2, dx, dy, speed: len }],
        colour,
        width: 2,
        headSize: 7,
      });
    };
    draw(p.gradF, '#f59e0b', 1);
    // ∇g drawn a little shorter so the two are distinguishable where they lie
    // exactly on top of each other, which at the answer they do.
    draw(p.gradG, '#4ade80', 0.7);
  }
  if (cfg.showGradients && result.best) {
    legend.push({ label: '∇f', colour: '#f59e0b' });
    legend.push({ label: '∇g', colour: '#4ade80' });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'x',
    yLabel: 'y',
    legend,
  };
}

// ------------------------------------------------------------------- panel

export function OptimisationPanel({ tab }: { tab: TabState }) {
  const cfg = tab.optimisation;
  const setOptimisation = useStore((s) => s.setOptimisation);
  const commit = useStore((s) => s.commit);

  const setProgram = useCallback(
    (patch: Partial<typeof cfg.program>) => {
      commit();
      setOptimisation({ program: { ...cfg.program, ...patch }, simplexStep: -1 });
    },
    [commit, setOptimisation, cfg.program],
  );

  const patchConstraint = (id: string, patch: Partial<Constraint>) =>
    setProgram({ constraints: cfg.program.constraints.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  return (
    <>
      <Panel title="Problem">
        <SegmentedControl
          size="sm"
          value={cfg.view}
          onChange={(view) => setOptimisation({ view })}
          options={VIEWS}
        />
      </Panel>

      {cfg.view === 'linear' && (
        <>
          <Panel title="Objective">
            <SegmentedControl
              size="sm"
              value={cfg.program.maximise ? 'max' : 'min'}
              onChange={(v) => setProgram({ maximise: v === 'max' })}
              options={[
                { value: 'max', label: 'Maximise' },
                { value: 'min', label: 'Minimise' },
              ]}
            />
            <Row>
              <div className="flex-1">
                <Field label="× x₁">
                  <NumberField
                    value={cfg.program.objective[0]}
                    step={1}
                    onChange={(v) => setProgram({ objective: [v, cfg.program.objective[1]] })}
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="× x₂">
                  <NumberField
                    value={cfg.program.objective[1]}
                    step={1}
                    onChange={(v) => setProgram({ objective: [cfg.program.objective[0], v] })}
                  />
                </Field>
              </div>
            </Row>
            <Toggle
              label="x₁, x₂ ≥ 0"
              hint="Standard form. Turn it off and the region can reach into the other quadrants."
              checked={cfg.program.nonNegative}
              onChange={(nonNegative) => setProgram({ nonNegative })}
            />
          </Panel>

          <Panel title="Constraints">
            <div className="space-y-2">
              {cfg.program.constraints.map((c) => (
                <div key={c.id} className="space-y-1.5 rounded-md border border-edge bg-surface-1 p-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      className="input-base flex-1 text-2xs"
                      value={c.label}
                      placeholder="Name this constraint"
                      onChange={(e) => patchConstraint(c.id, { label: e.target.value })}
                    />
                    <IconButton
                      title="Remove"
                      onClick={() => setProgram({ constraints: cfg.program.constraints.filter((x) => x.id !== c.id) })}
                    >
                      <IconTrash size={13} />
                    </IconButton>
                  </div>
                  <div className="flex items-end gap-1">
                    <NumberField
                      value={c.coefficients[0]}
                      step={1}
                      onChange={(v) => patchConstraint(c.id, { coefficients: [v, c.coefficients[1]] })}
                    />
                    <span className="pb-1.5 text-2xs text-ink-faint">x₁ +</span>
                    <NumberField
                      value={c.coefficients[1]}
                      step={1}
                      onChange={(v) => patchConstraint(c.id, { coefficients: [c.coefficients[0], v] })}
                    />
                    <span className="pb-1.5 text-2xs text-ink-faint">x₂</span>
                    <div className="w-14">
                      <Select
                        value={c.relation}
                        onChange={(relation) => patchConstraint(c.id, { relation: relation as Relation })}
                        options={RELATIONS}
                      />
                    </div>
                    <NumberField value={c.rhs} step={1} onChange={(rhs) => patchConstraint(c.id, { rhs })} />
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setProgram({
                  constraints: [
                    ...cfg.program.constraints,
                    { id: uid('con'), coefficients: [1, 1], relation: '<=', rhs: 10, label: '' },
                  ],
                })
              }
              className="mt-2 w-full rounded-md border border-dashed border-edge px-2 py-1.5 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
            >
              + Constraint
            </button>
          </Panel>
        </>
      )}

      {cfg.view === 'descent' && (
        <>
          <Panel title="Surface">
            <Field label="f(x, y)" hint="Anything you can type. The gradient is measured, not differentiated symbolically.">
              <input
                className="input-base font-mono"
                value={cfg.surface}
                spellCheck={false}
                onChange={(e) => setOptimisation({ surface: e.target.value })}
              />
            </Field>
            <Row>
              {[
                { label: 'Bowl', e: '(x-1)^2 + 3*(y+2)^2' },
                { label: 'Banana', e: '(1 - x)^2 + 100*(y - x^2)^2' },
                { label: 'Saddle', e: 'x^2 - y^2' },
                { label: 'Bumpy', e: 'x^2 + y^2 - 8*cos(x) - 8*cos(y)' },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setOptimisation({ surface: p.e })}
                  className="rounded-md border border-dashed border-edge px-2 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
                >
                  {p.label}
                </button>
              ))}
            </Row>
          </Panel>

          <Panel title="Method">
            <Select
              value={cfg.method}
              onChange={(method) => setOptimisation({ method: method as DescentMethod })}
              options={METHODS.map((m) => ({ value: m.value, label: m.label }))}
            />
            <p className="pt-1 text-2xs text-ink-faint">{METHODS.find((m) => m.value === cfg.method)?.hint}</p>
            <Field
              label="Step size"
              hint="Plain descent on a quadratic is stable only while this is under 2/λ_max. Past it the iterates fly apart."
            >
              {/* Logarithmic by hand: the useful range spans four decades, and
                  a linear slider spends nine tenths of its travel between 0.05
                  and 0.5 where every method simply explodes. */}
              <Slider
                value={Math.log10(Math.max(1e-5, cfg.rate))}
                min={-5}
                max={-0.3}
                step={0.01}
                onChange={(v) => setOptimisation({ rate: Number((10 ** v).toPrecision(3)) })}
              />
            </Field>
            {(cfg.method === 'momentum' || cfg.method === 'nesterov') && (
              <Field label="Momentum">
                <Slider value={cfg.momentum} min={0} max={0.99} step={0.01} onChange={(momentum) => setOptimisation({ momentum })} />
              </Field>
            )}
            <Field label="Steps">
              <NumberField value={cfg.descentSteps} min={1} max={20000} step={100} onChange={(descentSteps) => setOptimisation({ descentSteps })} />
            </Field>
            <Row>
              <div className="flex-1">
                <Field label="Start x">
                  <NumberField value={cfg.startX} step={0.1} onChange={(startX) => setOptimisation({ startX })} />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Start y">
                  <NumberField value={cfg.startY} step={0.1} onChange={(startY) => setOptimisation({ startY })} />
                </Field>
              </div>
            </Row>
          </Panel>
        </>
      )}

      {cfg.view === 'lagrange' && (
        <Panel title="Objective and constraint">
          <Field label="Maximise f(x, y)">
            <input
              className="input-base font-mono"
              value={cfg.objective}
              spellCheck={false}
              onChange={(e) => setOptimisation({ objective: e.target.value })}
            />
          </Field>
          <Field label="Subject to g(x, y) = 0">
            <input
              className="input-base font-mono"
              value={cfg.constraint}
              spellCheck={false}
              onChange={(e) => setOptimisation({ constraint: e.target.value })}
            />
          </Field>
          <Row>
            {[
              { label: 'Circle', f: 'x + y', g: 'x^2 + y^2 - 1' },
              { label: 'Ellipse', f: '3*x + y', g: 'x^2 + 4*y^2 - 4' },
              { label: 'Line', f: 'x^2 + y^2', g: 'x + 2*y - 5' },
              { label: 'Cubic', f: 'x*y', g: 'x^3 + y^3 - 3*x*y' },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setOptimisation({ objective: p.f, constraint: p.g })}
                className="rounded-md border border-dashed border-edge px-2 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
              >
                {p.label}
              </button>
            ))}
          </Row>
          <Toggle label="Draw the gradients" checked={cfg.showGradients} onChange={(showGradients) => setOptimisation({ showGradients })} />
        </Panel>
      )}

      <Panel title="Display">
        {cfg.view === 'linear' ? (
          <>
            <Toggle label="Shade the feasible region" checked={cfg.showRegion} onChange={(showRegion) => setOptimisation({ showRegion })} />
            <Toggle
              label="Objective level line"
              hint="The line being pushed outwards. Where it last touches the region is the answer."
              checked={cfg.showObjectiveLine}
              onChange={(showObjectiveLine) => setOptimisation({ showObjectiveLine })}
            />
          </>
        ) : (
          <>
            <Toggle label="Contours of f" checked={cfg.showContours} onChange={(showContours) => setOptimisation({ showContours })} />
            {cfg.showContours && (
              <Field label="How many">
                <Slider value={cfg.contourCount} min={2} max={30} step={1} onChange={(contourCount) => setOptimisation({ contourCount })} />
              </Field>
            )}
          </>
        )}
        <Toggle label="Governing equations" checked={cfg.showEquations} onChange={(showEquations) => setOptimisation({ showEquations })} />
      </Panel>

      <ViewPanel tab={tab} />
    </>
  );
}

// ----------------------------------------------------------------- surface

export function OptimisationSurface({ tab }: { tab: TabState }) {
  const cfg = tab.optimisation;
  const setViewport = useStore((s) => s.setViewport);
  const fitViewport = useStore((s) => s.fitViewport);
  const plotRef = usePlot2DRef();
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);

  const surface = useMemo(() => scope.compile2(cfg.surface || '0', 'x', 'y'), [scope, cfg.surface]);
  const objective = useMemo(() => scope.compile2(cfg.objective || '0', 'x', 'y'), [scope, cfg.objective]);
  const constraint = useMemo(() => scope.compile2(cfg.constraint || '0', 'x', 'y'), [scope, cfg.constraint]);

  const scene = useMemo(() => {
    if (cfg.view === 'linear') return linearScene(tab);
    if (cfg.view === 'descent') return descentScene(tab, surface.error ? null : surface.fn);
    return lagrangeScene(tab, objective.error ? null : objective.fn, constraint.error ? null : constraint.fn);
  }, [tab, cfg.view, surface, objective, constraint]);

  const error =
    cfg.view === 'descent' ? surface.error : cfg.view === 'lagrange' ? objective.error ?? constraint.error : null;

  /* Each view lives somewhere different: a feasible region sits in the first
   * quadrant at whatever scale the constraints imply, a descent path is wrapped
   * around wherever the surface's minimum happens to be, and a constraint curve
   * is wherever g = 0. Reframing on a view change beats making the user hunt
   * for the picture with the scroll wheel. */
  const frameKey = `${cfg.view}|${JSON.stringify(cfg.program)}|${cfg.surface}|${cfg.constraint}|${cfg.startX},${cfg.startY}`;
  useEffect(() => {
    const pad = (lo: number, hi: number, fraction = 0.15) => {
      const span = hi - lo || 1;
      return [lo - span * fraction, hi + span * fraction] as const;
    };
    if (cfg.view === 'linear') {
      const region = feasibleRegion(cfg.program);
      if (!region.length) return;
      const [x0, x1] = pad(Math.min(0, ...region.map((p) => p.x)), Math.max(...region.map((p) => p.x)), 0.25);
      const [y0, y1] = pad(Math.min(0, ...region.map((p) => p.y)), Math.max(...region.map((p) => p.y)), 0.25);
      fitViewport({ xMin: x0, xMax: x1, yMin: y0, yMax: y1 });
    } else if (cfg.view === 'descent' && !surface.error) {
      const result = gradientDescent(surface.fn, {
        method: cfg.method, rate: cfg.rate, momentum: cfg.momentum,
        steps: cfg.descentSteps, start: [cfg.startX, cfg.startY], tolerance: 1e-10,
      });
      const xs = result.path.map((p) => p.x).filter(Number.isFinite);
      const ys = result.path.map((p) => p.y).filter(Number.isFinite);
      if (!xs.length) return;
      const [x0, x1] = pad(Math.min(...xs), Math.max(...xs), 0.35);
      const [y0, y1] = pad(Math.min(...ys), Math.max(...ys), 0.35);
      fitViewport({ xMin: x0, xMax: x1, yMin: y0, yMax: y1 });
    } else if (cfg.view === 'lagrange' && !constraint.error) {
      // The curve is found by looking in a generous window first, then the
      // window is closed down onto whatever was found.
      const wide = { xMin: -12, xMax: 12, yMin: -12, yMax: 12 };
      const branches = traceZeroLevel(constraint.fn, wide, 200);
      const pts = branches.flat();
      if (!pts.length) return;
      const [x0, x1] = pad(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)), 0.35);
      const [y0, y1] = pad(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)), 0.35);
      fitViewport({ xMin: x0, xMax: x1, yMin: y0, yMax: y1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);

  /* Equal scales on the two views that draw geometry. A constraint circle
   * squashed into an ellipse is a lie about the constraint, and the whole
   * Lagrange picture is an assertion about directions. */
  useSquareScales(plotRef, tab.viewport, cfg.view !== 'linear', 'contain');

  return (
    <SandboxLayout
      storageKey="optimisation"
      canvas={
        <div className="h-full w-full">
          <Plot2D ref={plotRef} scene={scene} onViewportChange={setViewport} />
        </div>
      }
      instruments={
        <>
          {error && (
            <div className="px-3 py-2.5">
              <Callout kind="warn">{error}</Callout>
            </div>
          )}
          {cfg.view === 'linear' && <LinearReadout tab={tab} />}
          {cfg.view === 'descent' && <DescentReadout tab={tab} f={surface.error ? null : surface.fn} />}
          {cfg.view === 'lagrange' && (
            <LagrangeReadout
              tab={tab}
              f={objective.error ? null : objective.fn}
              g={constraint.error ? null : constraint.fn}
            />
          )}
          {cfg.showEquations && <AnalyticCard result={analyseOptimisation(tab)} />}
        </>
      }
    />
  );
}

function LinearReadout({ tab }: { tab: TabState }) {
  const cfg = tab.optimisation;
  const setOptimisation = useStore((s) => s.setOptimisation);
  const result = useMemo(() => solveLinearProgram(cfg.program), [cfg.program]);
  const shown = cfg.simplexStep < 0 ? result.path.length - 1 : Math.min(cfg.simplexStep, result.path.length - 1);
  const step = result.path[shown];

  return (
    <>
      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat label="Status" value={result.status} emphasis />
          {result.point && <Stat label="x₁" value={fmt(result.point[0], 6)} />}
          {result.point && <Stat label="x₂" value={fmt(result.point[1], 6)} />}
          {result.value !== null && <Stat label="Objective" value={fmt(result.value, 6)} emphasis />}
          <Stat label="Pivots" value={String(Math.max(0, result.path.length - 1))} />
        </StatList>
        {result.status !== 'optimal' && (
          <div className="pt-2">
            <Callout kind="warn">{result.message}</Callout>
          </div>
        )}
      </div>

      {result.path.length > 1 && (
        <Collapsible title="Simplex path" defaultOpen>
          <div className="space-y-0.5">
            {result.path.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setOptimisation({ simplexStep: i })}
                className={`flex w-full items-baseline justify-between rounded px-2 py-1 text-left font-mono text-2xs transition-colors ${
                  i === shown ? 'bg-accent/15 text-ink' : 'text-ink-dim hover:bg-surface-2'
                }`}
              >
                <span>
                  {i === 0 ? 'start' : `${s.entering ?? '?'} in, ${s.leaving ?? '?'} out`}
                  {s.phase === 1 && <span className="ml-1 text-ink-faint">(phase 1)</span>}
                </span>
                <span>
                  ({fmt(s.point[0] ?? 0, 4)}, {fmt(s.point[1] ?? 0, 4)}) → {fmt(s.value, 4)}
                </span>
              </button>
            ))}
          </div>
          <Row>
            <button
              type="button"
              onClick={() => setOptimisation({ simplexStep: Math.max(0, shown - 1) })}
              className="rounded-md border border-edge px-2 py-1 text-2xs text-ink-dim hover:text-ink"
            >
              ◀ Back
            </button>
            <button
              type="button"
              onClick={() => setOptimisation({ simplexStep: Math.min(result.path.length - 1, shown + 1) })}
              className="rounded-md border border-edge px-2 py-1 text-2xs text-ink-dim hover:text-ink"
            >
              Step ▶
            </button>
            <button
              type="button"
              onClick={() => setOptimisation({ simplexStep: -1 })}
              className="rounded-md border border-edge px-2 py-1 text-2xs text-ink-dim hover:text-ink"
            >
              Whole path
            </button>
          </Row>
          {step && (
            <p className="px-1 pt-1.5 text-2xs text-ink-faint">
              Each row is one pivot: a variable enters the basis, another leaves, and the point moves to
              an adjacent corner of the region. The objective never falls, which is why it stops.
            </p>
          )}
        </Collapsible>
      )}

      {result.status === 'optimal' && (
        <Collapsible title="Shadow prices" defaultOpen={false}>
          <div className="space-y-0.5">
            {cfg.program.constraints.map((c, i) => (
              <div key={c.id} className="flex items-baseline justify-between px-2 py-1 font-mono text-2xs text-ink-dim">
                <span>{c.label || `Constraint ${i + 1}`}</span>
                <span>{fmt(result.shadowPrices[i] ?? 0, 5)}</span>
              </div>
            ))}
          </div>
          <p className="px-1 pt-1.5 text-2xs text-ink-faint">
            What one more unit of each right-hand side is worth. A price of zero means that constraint is
            not binding and relaxing it buys nothing at all.
          </p>
        </Collapsible>
      )}
    </>
  );
}

function DescentReadout({ tab, f }: { tab: TabState; f: ((x: number, y: number) => number) | null }) {
  const cfg = tab.optimisation;
  const result = useMemo(
    () =>
      f
        ? gradientDescent(f, {
            method: cfg.method,
            rate: cfg.rate,
            momentum: cfg.momentum,
            steps: cfg.descentSteps,
            start: [cfg.startX, cfg.startY],
            tolerance: 1e-10,
          })
        : null,
    [f, cfg.method, cfg.rate, cfg.momentum, cfg.descentSteps, cfg.startX, cfg.startY],
  );
  if (!result) return null;

  const last = result.path[result.path.length - 1];
  return (
    <div className="border-b border-edge px-3 py-2.5">
      <StatList>
        <Stat label="Steps taken" value={String(result.path.length)} />
        <Stat label="f at the start" value={fmt(result.path[0]?.f ?? 0, 6)} />
        <Stat label="f at the end" value={result.final ? fmt(result.final.f, 6) : '—'} emphasis />
        <Stat label="|∇f| at the end" value={last ? fmt(last.gradient, 4) : '—'} />
        <Stat label="Converged" value={result.converged ? 'yes' : result.diverged ? 'diverged' : 'still going'} />
      </StatList>
      {result.diverged && (
        <div className="pt-2">
          <Callout kind="warn">
            The iterates ran away. Plain descent is stable only while the step size is below 2/λ_max — the
            largest curvature of the surface — and past that each step overshoots by more than the last.
          </Callout>
        </div>
      )}
      {!result.converged && !result.diverged && (
        <p className="pt-2 text-2xs text-ink-faint">
          It ran out of steps before the gradient got small. That is the honest answer for this many
          iterations at this rate, not a failure to draw.
        </p>
      )}
    </div>
  );
}

function LagrangeReadout({
  tab,
  f,
  g,
}: {
  tab: TabState;
  f: ((x: number, y: number) => number) | null;
  g: ((x: number, y: number) => number) | null;
}) {
  const result = useMemo(
    () => (f && g ? constrainedExtrema(f, g, tab.viewport, 260) : null),
    [f, g, tab.viewport],
  );
  if (!result) return null;

  const row = (label: string, p: NonNullable<typeof result.best>) => {
    const cross = p.gradF[0] * p.gradG[1] - p.gradF[1] * p.gradG[0];
    const scale = Math.hypot(...p.gradF) * Math.hypot(...p.gradG);
    return (
      <div key={label} className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat label={label} value={`(${fmt(p.x, 5)}, ${fmt(p.y, 5)})`} emphasis />
          <Stat label="f there" value={fmt(p.f, 6)} />
          <Stat label="λ" value={p.lambda === null ? '—' : fmt(p.lambda, 5)} emphasis />
          <Stat label="∇f" value={`(${fmt(p.gradF[0], 4)}, ${fmt(p.gradF[1], 4)})`} />
          <Stat label="λ∇g" value={p.lambda === null ? '—' : `(${fmt(p.lambda * p.gradG[0], 4)}, ${fmt(p.lambda * p.gradG[1], 4)})`} />
          <Stat label="∇f × ∇g" value={scale > 0 ? fmt(cross / scale, 3) : '—'} />
        </StatList>
      </div>
    );
  };

  return (
    <>
      {result.best && row('Maximum at', result.best)}
      {result.worst && row('Minimum at', result.worst)}
      <div className="px-3 py-2.5">
        <Callout kind="info">
          {result.curve.length
            ? 'The two arrows point along the same line, so their cross product is zero and one is λ times the other. That is the whole method: at a constrained extremum you cannot improve f without leaving g = 0, and that happens exactly when ∇f has no component along the constraint.'
            : result.message}
        </Callout>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- analytics

function analyseOptimisation(tab: TabState) {
  const cfg = tab.optimisation;
  if (cfg.view === 'linear') {
    const result = solveLinearProgram(cfg.program);
    return {
      title: cfg.program.maximise ? 'Linear program — maximise' : 'Linear program — minimise',
      equations: [
        String.raw`\text{${cfg.program.maximise ? 'max' : 'min'}}\; c^{T}x \quad \text{s.t.}\; Ax \le b,\; x \ge 0`,
        String.raw`z = ${fmt(cfg.program.objective[0], 4)}x_1 + ${fmt(cfg.program.objective[1], 4)}x_2`,
      ],
      quantities: [
        { label: 'Constraints', value: cfg.program.constraints.length, unit: '' },
        { label: 'Pivots', value: Math.max(0, result.path.length - 1), unit: '' },
        ...(result.value !== null ? [{ label: 'Optimum', value: result.value, unit: '' }] : []),
      ],
      overlay: null,
      caveat: 'The optimum of a linear program is always at a vertex, because the objective is linear and the region is convex — so a method that only ever looks at vertices is not missing anything.',
    };
  }
  if (cfg.view === 'descent') {
    return {
      title: METHODS.find((m) => m.value === cfg.method)?.label ?? 'Descent',
      equations: [
        String.raw`x_{k+1} = x_k - \eta\,\nabla f(x_k)`,
        ...(cfg.method === 'momentum' || cfg.method === 'nesterov'
          ? [String.raw`v_{k+1} = \beta v_k - \eta\,\nabla f, \qquad x_{k+1} = x_k + v_{k+1}`]
          : []),
        ...(cfg.method === 'newton' ? [String.raw`x_{k+1} = x_k - H^{-1}\nabla f`] : []),
      ],
      quantities: [
        { label: 'Step size η', value: cfg.rate, unit: '' },
        { label: 'Steps', value: cfg.descentSteps, unit: '' },
      ],
      overlay: null,
      caveat: 'The gradient is measured by central differences, not by differentiating the expression, so any f you can type is fair game.',
    };
  }
  return {
    title: 'Lagrange multipliers',
    equations: [
      String.raw`\nabla f(x, y) = \lambda\,\nabla g(x, y), \qquad g(x, y) = 0`,
      String.raw`\mathcal{L}(x, y, \lambda) = f - \lambda g`,
    ],
    quantities: [],
    overlay: null,
    caveat: 'The extremum is found by searching along the constraint curve, and the multiplier condition is then checked rather than assumed — which is the right way round for seeing why it is true.',
  };
}

export function optimisationCsv(tab: TabState): string | null {
  const cfg = tab.optimisation;
  if (cfg.view === 'linear') {
    const result = solveLinearProgram(cfg.program);
    if (!result.path.length) return null;
    return toCsv(
      ['step', 'phase', 'entering', 'leaving', 'x1', 'x2', 'objective'],
      result.path.map((s, i) => [i, s.phase, s.entering ?? '', s.leaving ?? '', s.point[0] ?? 0, s.point[1] ?? 0, s.value]),
    );
  }
  if (cfg.view === 'descent') {
    const scope = new EvalScope();
    for (const p of tab.parameters) scope.set(p.name, p.value);
    const { fn, error } = scope.compile2(cfg.surface || '0', 'x', 'y');
    if (error) return null;
    const result = gradientDescent(fn, {
      method: cfg.method,
      rate: cfg.rate,
      momentum: cfg.momentum,
      steps: cfg.descentSteps,
      start: [cfg.startX, cfg.startY],
      tolerance: 1e-10,
    });
    return toCsv(
      ['step', 'x', 'y', 'f', 'gradient'],
      result.path.map((p, i) => [i, p.x, p.y, p.f, p.gradient]),
    );
  }

  const scope = new EvalScope();
  for (const p of tab.parameters) scope.set(p.name, p.value);
  const f = scope.compile2(cfg.objective || '0', 'x', 'y');
  const g = scope.compile2(cfg.constraint || '0', 'x', 'y');
  if (f.error || g.error) return null;
  const result = constrainedExtrema(f.fn, g.fn, tab.viewport, 260);
  const rows: (number | string)[][] = [];
  for (const p of [result.best, result.worst]) {
    if (!p) continue;
    rows.push([p.kind, p.x, p.y, p.f, p.gradF[0], p.gradF[1], p.gradG[0], p.gradG[1], p.lambda ?? '']);
  }
  if (!rows.length) return null;
  return toCsv(['kind', 'x', 'y', 'f', 'dfdx', 'dfdy', 'dgdx', 'dgdy', 'lambda'], rows);
}
