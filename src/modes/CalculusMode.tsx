import { useMemo } from 'react';
import { derivative as numericDerivative } from '../core/math/numeric';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import type { CalculusConfig, TabState } from '../core/types';
import { SERIES_COLOURS } from '../core/types';
import {
  dopri5,
  findExtrema,
  findRoots,
  integrate,
  riemann,
  rk4,
  type OdeStep,
} from '../core/math/numeric';
import { marchingSquares, sampleFunction } from '../core/math/sampling';
import { EvalScope } from '../core/math/scope';
import { factorial } from '../core/math/specfun';
import { useScope } from '../hooks/useScope';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { ParameterPanel } from '../components/panels/ParameterPanel';
import { ViewPanel } from '../components/panels/ViewPanel';
import { MathField, analyseExpression } from '../components/inputs/MathField';
import {
  Button,
  Callout,
  Collapsible,
  Field,
  IconButton,
  NumberField,
  Row,
  SegmentedControl,
  Select,
  Slider,
  Stat,
  StatList,
  Toggle,
  fmt,
} from '../components/ui/controls';
import { IconPlus, IconTrash } from '../components/ui/Icons';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';

const CURVE = '#8b7cf6';
const DERIV = '#38bdf8';
const SECOND = '#f472b6';
const AREA = '#34d399';
const TAYLOR = '#fbbf24';

const KNOWN = new Set(['x', 'y', 't', 'time']);

/* ------------------------------------------------------------------ panel */

export function CalculusPanel({ tab }: { tab: TabState }) {
  const setCalculus = useStore((s) => s.setCalculus);
  const cfg = tab.calculus;

  return (
    <>
      <Collapsible title="Mode">
        <SegmentedControl
          value={cfg.view}
          onChange={(view) => setCalculus({ view })}
          options={[
            { value: 'analysis', label: 'Analyse', title: 'Derivatives, integrals and critical points' },
            { value: 'riemann', label: 'Riemann', title: 'Riemann and Newton–Cotes sums' },
            { value: 'taylor', label: 'Taylor', title: 'Taylor series approximation' },
            { value: 'slopefield', label: 'Slope', title: 'Slope fields and one ODE' },
            { value: 'phase', label: 'Phase', title: 'Planar systems and phase portraits' },
          ]}
        />
      </Collapsible>

      {(cfg.view === 'analysis' || cfg.view === 'riemann' || cfg.view === 'taylor') && (
        <FunctionPanel tab={tab} cfg={cfg} />
      )}
      {cfg.view === 'slopefield' && <SlopeFieldPanel cfg={cfg} />}
      {cfg.view === 'phase' && <PhasePanel cfg={cfg} />}

      <ParameterPanel parameters={tab.parameters} />
      <ViewPanel tab={tab} />
    </>
  );
}

function FunctionPanel({ tab, cfg }: { tab: TabState; cfg: CalculusConfig }) {
  const setCalculus = useStore((s) => s.setCalculus);
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);
  const known = useMemo(() => new Set([...KNOWN, ...tab.parameters.map((p) => p.name)]), [tab.parameters]);

  const analysis = useMemo(() => {
    const { fn, error } = scope.compile1(cfg.f || '0', 'x');
    if (error) return { error, integral: null, roots: [], extrema: [], riemannSum: null };
    const integral = integrate(fn, cfg.a, cfg.b, 1e-11);
    const roots = findRoots(fn, cfg.a, cfg.b, 1500);
    const extrema = findExtrema(fn, cfg.a, cfg.b, 900);
    const sum = riemann(fn, cfg.a, cfg.b, Math.max(1, Math.round(cfg.riemannN)), cfg.riemannRule);
    return { error: null, integral, roots, extrema, riemannSum: sum.sum };
  }, [scope, cfg.f, cfg.a, cfg.b, cfg.riemannN, cfg.riemannRule]);

  return (
    <>
      <Collapsible title="Function">
        <MathField
          value={cfg.f}
          onChange={(f) => setCalculus({ f })}
          prefix="f(x) ="
          status={analyseExpression(cfg.f, known)}
        />
        <Row>
          <div className="flex-1">
            <span className="field-label">a</span>
            <NumberField value={cfg.a} step={0.25} onChange={(a) => setCalculus({ a })} />
          </div>
          <div className="flex-1">
            <span className="field-label">b</span>
            <NumberField value={cfg.b} step={0.25} onChange={(b) => setCalculus({ b })} />
          </div>
        </Row>
      </Collapsible>

      {cfg.view === 'riemann' && (
        <Collapsible title="Riemann sum">
          <Field label="Rule">
            <Select
              value={cfg.riemannRule}
              onChange={(riemannRule) => setCalculus({ riemannRule })}
              options={[
                { value: 'left', label: 'Left endpoints' },
                { value: 'right', label: 'Right endpoints' },
                { value: 'midpoint', label: 'Midpoints' },
                { value: 'trapezoid', label: 'Trapezoidal' },
                { value: 'simpson', label: "Simpson's rule" },
              ]}
            />
          </Field>
          <div>
            <div className="flex items-baseline justify-between">
              <span className="field-label">Subdivisions n</span>
              <span className="font-mono text-2xs text-ink">{Math.round(cfg.riemannN)}</span>
            </div>
            <Slider
              value={cfg.riemannN}
              min={1}
              max={200}
              step={1}
              onChange={(riemannN) => setCalculus({ riemannN: Math.round(riemannN) })}
            />
          </div>
          {analysis.integral && analysis.riemannSum !== null && (
            <>
              <StatList>
                <Stat label="Sum" value={fmt(analysis.riemannSum, 8)} emphasis />
                <Stat label="Exact integral" value={fmt(analysis.integral.value, 8)} />
                <Stat label="Error" value={fmt(analysis.riemannSum - analysis.integral.value, 4)} />
                <Stat
                  label="Relative error"
                  value={
                    Math.abs(analysis.integral.value) > 1e-12
                      ? `${(((analysis.riemannSum - analysis.integral.value) / analysis.integral.value) * 100).toFixed(4)}%`
                      : '—'
                  }
                />
              </StatList>
              <Callout>
                {cfg.riemannRule === 'left' || cfg.riemannRule === 'right'
                  ? 'The endpoint rules converge as O(1/n): doubling n halves the error.'
                  : cfg.riemannRule === 'midpoint' || cfg.riemannRule === 'trapezoid'
                    ? 'Midpoint and trapezoid converge as O(1/n²) — doubling n quarters the error.'
                    : "Simpson's rule converges as O(1/n⁴), which is why it reaches machine precision so quickly."}
              </Callout>
            </>
          )}
        </Collapsible>
      )}

      {cfg.view === 'taylor' && (
        <Collapsible title="Taylor series">
          <Row>
            <div className="flex-1">
              <span className="field-label">Centre</span>
              <NumberField value={cfg.taylorCentre} step={0.25} onChange={(taylorCentre) => setCalculus({ taylorCentre })} />
            </div>
            <div className="flex-1">
              <span className="field-label">Order</span>
              <NumberField
                value={cfg.taylorOrder}
                min={0}
                max={20}
                step={1}
                onChange={(taylorOrder) => setCalculus({ taylorOrder: Math.round(taylorOrder) })}
              />
            </div>
          </Row>
          <Slider
            value={cfg.taylorOrder}
            min={0}
            max={20}
            step={1}
            onChange={(taylorOrder) => setCalculus({ taylorOrder: Math.round(taylorOrder) })}
          />
          <Callout>
            Coefficients are computed by repeated central differences, so they lose a little accuracy above
            order 8 or so. Watch the approximation diverge outside the radius of convergence — that is the
            point of the picture.
          </Callout>
        </Collapsible>
      )}

      {cfg.view === 'analysis' && (
        <Collapsible title="Analysis">
          {analysis.error && <Callout kind="error">{analysis.error}</Callout>}
          {analysis.integral && (
            <StatList>
              <Stat label={`∫ from ${fmt(cfg.a, 4)} to ${fmt(cfg.b, 4)}`} value={fmt(analysis.integral.value, 10)} emphasis />
              <Stat label="Estimated error" value={fmt(analysis.integral.error, 3)} />
              <Stat label="Evaluations" value={String(analysis.integral.evaluations)} />
              <Stat label="Mean value" value={fmt(analysis.integral.value / (cfg.b - cfg.a), 8)} />
            </StatList>
          )}
          {analysis.roots.length > 0 && (
            <div>
              <p className="field-label mb-1">Roots in [a, b]</p>
              <div className="space-y-0.5 font-mono text-xs text-ink">
                {analysis.roots.slice(0, 12).map((r, i) => (
                  <p key={i}>x = {fmt(r, 10)}</p>
                ))}
                {analysis.roots.length > 12 && (
                  <p className="text-ink-faint">…and {analysis.roots.length - 12} more</p>
                )}
              </div>
            </div>
          )}
          {analysis.extrema.length > 0 && (
            <div>
              <p className="field-label mb-1">Turning points</p>
              <div className="space-y-0.5 font-mono text-xs text-ink">
                {analysis.extrema.slice(0, 10).map((e, i) => (
                  <p key={i}>
                    <span className="text-ink-faint">{e.kind}</span> ({fmt(e.x, 7)}, {fmt(e.y, 7)})
                  </p>
                ))}
              </div>
            </div>
          )}
        </Collapsible>
      )}
    </>
  );
}

function SlopeFieldPanel({ cfg }: { cfg: CalculusConfig }) {
  const setCalculus = useStore((s) => s.setCalculus);
  return (
    <>
      <Collapsible title="Differential equation">
        <MathField
          value={cfg.slopeExpr}
          onChange={(slopeExpr) => setCalculus({ slopeExpr })}
          prefix="dy/dx ="
          status={analyseExpression(cfg.slopeExpr, KNOWN)}
        />
        <div className="grid grid-cols-2 gap-1">
          {[
            { label: 'Logistic', e: 'y*(1 - y)' },
            { label: 'Linear', e: 'x - y' },
            { label: 'Separable', e: 'x*y' },
            { label: 'Cooling', e: '-0.5*(y - 2)' },
            { label: 'Riccati', e: 'y^2 - x' },
            { label: 'Oscillating', e: 'sin(x) - 0.3*y' },
          ].map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setCalculus({ slopeExpr: p.e })}
              className="rounded border border-edge px-1 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
            >
              {p.label}
            </button>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Initial conditions">
        <p className="text-2xs leading-relaxed text-ink-faint">
          Click anywhere on the plot to drop a new starting point.
        </p>
        {cfg.slopeSeeds.map((s) => (
          <div key={s.id} className="flex items-end gap-1.5">
            <span className="mb-2 h-3 w-3 shrink-0 rounded-full" style={{ background: s.colour }} />
            <div className="flex-1">
              <span className="field-label">x₀</span>
              <NumberField
                value={s.x}
                step={0.5}
                onChange={(x) => setCalculus({ slopeSeeds: cfg.slopeSeeds.map((q) => (q.id === s.id ? { ...q, x } : q)) })}
              />
            </div>
            <div className="flex-1">
              <span className="field-label">y₀</span>
              <NumberField
                value={s.y}
                step={0.5}
                onChange={(y) => setCalculus({ slopeSeeds: cfg.slopeSeeds.map((q) => (q.id === s.id ? { ...q, y } : q)) })}
              />
            </div>
            <IconButton
              title="Remove"
              className="mb-1"
              onClick={() => setCalculus({ slopeSeeds: cfg.slopeSeeds.filter((q) => q.id !== s.id) })}
            >
              <IconTrash size={13} />
            </IconButton>
          </div>
        ))}
        <Row>
          <Button
            className="flex-1"
            onClick={() =>
              setCalculus({
                slopeSeeds: [
                  ...cfg.slopeSeeds,
                  { id: uid('seed'), x: 0, y: 0, colour: SERIES_COLOURS[(cfg.slopeSeeds.length + 1) % SERIES_COLOURS.length] },
                ],
              })
            }
          >
            <IconPlus size={13} /> Add
          </Button>
          <Button className="flex-1" onClick={() => setCalculus({ slopeSeeds: [] })}>
            Clear all
          </Button>
        </Row>
      </Collapsible>

      <SolverPanel cfg={cfg} />
    </>
  );
}

function PhasePanel({ cfg }: { cfg: CalculusConfig }) {
  const setCalculus = useStore((s) => s.setCalculus);
  return (
    <>
      <Collapsible title="Planar system">
        <MathField
          value={cfg.systemP}
          onChange={(systemP) => setCalculus({ systemP })}
          prefix="x′ ="
          status={analyseExpression(cfg.systemP, KNOWN)}
        />
        <MathField
          value={cfg.systemQ}
          onChange={(systemQ) => setCalculus({ systemQ })}
          prefix="y′ ="
          status={analyseExpression(cfg.systemQ, KNOWN)}
        />
        <div className="grid grid-cols-2 gap-1">
          {[
            { label: 'Pendulum', p: 'y', q: '-sin(x) - 0.25*y' },
            { label: 'Van der Pol', p: 'y', q: '2*(1 - x^2)*y - x' },
            { label: 'Predator–prey', p: '1.1*x - 0.4*x*y', q: '0.1*x*y - 0.4*y' },
            { label: 'Saddle', p: 'x', q: '-y' },
            { label: 'Spiral sink', p: '-x - 2*y', q: '2*x - y' },
            { label: 'Centre', p: 'y', q: '-x' },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setCalculus({ systemP: preset.p, systemQ: preset.q })}
              className="rounded border border-edge px-1 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <Toggle
          label="Nullclines"
          hint="Where x′ = 0 and y′ = 0. Their crossings are the equilibria."
          checked={cfg.showNullclines}
          onChange={(showNullclines) => setCalculus({ showNullclines })}
        />
        <Toggle
          label="Mark equilibria"
          checked={cfg.showEquilibria}
          onChange={(showEquilibria) => setCalculus({ showEquilibria })}
        />
      </Collapsible>

      <Collapsible title="Trajectories">
        <p className="text-2xs leading-relaxed text-ink-faint">Click the plot to launch a trajectory from that point.</p>
        {cfg.phaseSeeds.map((s) => (
          <div key={s.id} className="flex items-end gap-1.5">
            <span className="mb-2 h-3 w-3 shrink-0 rounded-full" style={{ background: s.colour }} />
            <div className="flex-1">
              <span className="field-label">x₀</span>
              <NumberField
                value={s.x}
                step={0.25}
                onChange={(x) => setCalculus({ phaseSeeds: cfg.phaseSeeds.map((q) => (q.id === s.id ? { ...q, x } : q)) })}
              />
            </div>
            <div className="flex-1">
              <span className="field-label">y₀</span>
              <NumberField
                value={s.y}
                step={0.25}
                onChange={(y) => setCalculus({ phaseSeeds: cfg.phaseSeeds.map((q) => (q.id === s.id ? { ...q, y } : q)) })}
              />
            </div>
            <IconButton
              title="Remove"
              className="mb-1"
              onClick={() => setCalculus({ phaseSeeds: cfg.phaseSeeds.filter((q) => q.id !== s.id) })}
            >
              <IconTrash size={13} />
            </IconButton>
          </div>
        ))}
        <Row>
          <Button
            className="flex-1"
            onClick={() =>
              setCalculus({
                phaseSeeds: [
                  ...cfg.phaseSeeds,
                  { id: uid('seed'), x: 1, y: 1, colour: SERIES_COLOURS[(cfg.phaseSeeds.length + 1) % SERIES_COLOURS.length] },
                ],
              })
            }
          >
            <IconPlus size={13} /> Add
          </Button>
          <Button className="flex-1" onClick={() => setCalculus({ phaseSeeds: [] })}>
            Clear all
          </Button>
        </Row>
      </Collapsible>

      <SolverPanel cfg={cfg} />
    </>
  );
}

function SolverPanel({ cfg }: { cfg: CalculusConfig }) {
  const setCalculus = useStore((s) => s.setCalculus);
  return (
    <Collapsible title="Solver" defaultOpen={false}>
      <Field label="Method">
        <Select
          value={cfg.solver}
          onChange={(solver) => setCalculus({ solver })}
          options={[
            { value: 'dopri5', label: 'Dormand–Prince 5(4), adaptive' },
            { value: 'rk4', label: 'Runge–Kutta 4, fixed step' },
          ]}
        />
      </Field>
      <Row>
        <div className="flex-1">
          <span className="field-label">Duration</span>
          <NumberField
            value={cfg.odeDuration}
            min={0.1}
            step={5}
            onChange={(odeDuration) => setCalculus({ odeDuration })}
          />
        </div>
        <div className="flex-1">
          <span className="field-label">Steps</span>
          <NumberField
            value={cfg.odeSteps}
            min={10}
            max={200000}
            step={500}
            onChange={(odeSteps) => setCalculus({ odeSteps: Math.round(odeSteps) })}
          />
        </div>
      </Row>
      <Callout>
        The adaptive method chooses its own step size from a local error estimate and is the right default.
        The fixed-step method is here because seeing it fail on a stiff system is instructive.
      </Callout>
    </Collapsible>
  );
}

/* ------------------------------------------------------------------ surface */

export function CalculusSurface({ tab }: { tab: TabState }) {
  const setViewport = useStore((s) => s.setViewport);
  const setCalculus = useStore((s) => s.setCalculus);
  const plotRef = usePlot2DRef();
  const cfg = tab.calculus;
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);

  const scene = useMemo<PlotScene>(() => {
    const view = { ...tab.viewport, width: 1200, height: 700 };
    const base = {
      viewport: tab.viewport,
      showGrid: tab.showGrid,
      showMinorGrid: tab.showMinorGrid,
      showAxes: tab.showAxes,
    };

    switch (cfg.view) {
      case 'analysis':
        return { ...base, ...analysisScene(cfg, scope, view) };
      case 'riemann':
        return { ...base, ...riemannScene(cfg, scope, view, tab) };
      case 'taylor':
        return { ...base, ...taylorScene(cfg, scope, view, tab) };
      case 'slopefield':
        return { ...base, ...slopeFieldScene(cfg, scope, view) };
      case 'phase':
      default:
        return { ...base, ...phaseScene(cfg, scope, view) };
    }
    // `playing` and `tMax` are read by the Riemann and Taylor scenes to sweep
    // their parameter; without them here, pausing left the plot stuck on the
    // swept value instead of returning to the slider's.
  }, [
    cfg,
    scope,
    tab.viewport,
    tab.showGrid,
    tab.showMinorGrid,
    tab.showAxes,
    tab.timeline.t,
    tab.timeline.tMax,
    tab.timeline.playing,
  ]);

  return (
    <Plot2D
      ref={plotRef}
      scene={scene}
      onViewportChange={setViewport}
      showCrosshair={tab.showCrosshair}
      onDoubleClick={(e) => {
        // Double-click is the fastest way to seed a trajectory, and it does not
        // collide with the drag-to-pan gesture the way a single click would.
        if (cfg.view === 'slopefield') {
          setCalculus({
            slopeSeeds: [
              ...cfg.slopeSeeds,
              { id: uid('seed'), x: e.x, y: e.y, colour: SERIES_COLOURS[cfg.slopeSeeds.length % SERIES_COLOURS.length] },
            ],
          });
        } else if (cfg.view === 'phase') {
          setCalculus({
            phaseSeeds: [
              ...cfg.phaseSeeds,
              { id: uid('seed'), x: e.x, y: e.y, colour: SERIES_COLOURS[cfg.phaseSeeds.length % SERIES_COLOURS.length] },
            ],
          });
        }
      }}
      readout={(x, y) => {
        if (cfg.view === 'phase' || cfg.view === 'slopefield') return `x ${fmt(x, 5)}   y ${fmt(y, 5)}`;
        const { fn, error } = scope.compile1(cfg.f || '0', 'x');
        if (error) return `x ${fmt(x, 5)}`;
        return `x ${fmt(x, 5)}\nf(x) ${fmt(fn(x), 6)}\nf′(x) ${fmt(numericDerivative(fn, x), 6)}`;
      }}
    />
  );
}

type ScenePart = Pick<PlotScene, 'layers' | 'legend' | 'xLabel' | 'yLabel' | 'caption'>;

function analysisScene(cfg: CalculusConfig, scope: EvalScope, view: { xMin: number; xMax: number; yMin: number; yMax: number; width: number; height: number }): ScenePart {
  const { fn, error } = scope.compile1(cfg.f || '0', 'x');
  if (error) return { layers: [], xLabel: 'x', yLabel: 'y', caption: error };

  const layers: Layer[] = [];
  const shaded = sampleFunction(fn, { ...view, xMin: Math.min(cfg.a, cfg.b), xMax: Math.max(cfg.a, cfg.b) });
  layers.push({ type: 'area', segments: shaded, baseline: 0, colour: withAlpha(AREA, 0.22) });
  layers.push({ type: 'curve', segments: sampleFunction(fn, view), colour: CURVE, width: 2.4 });
  layers.push({
    type: 'curve',
    segments: sampleFunction((x) => numericDerivative(fn, x), view),
    colour: DERIV,
    width: 1.6,
    style: 'dashed',
  });
  layers.push({
    type: 'curve',
    segments: sampleFunction((x) => numericDerivative(fn, x, 2), view),
    colour: SECOND,
    width: 1.3,
    style: 'dotted',
    alpha: 0.8,
  });

  for (const r of findRoots(fn, view.xMin, view.xMax, 1200)) {
    layers.push({ type: 'marker', x: r, y: 0, label: `root ${fmt(r, 6)}`, colour: CURVE, radius: 3.5 });
  }
  for (const e of findExtrema(fn, view.xMin, view.xMax, 800)) {
    layers.push({
      type: 'marker',
      x: e.x,
      y: e.y,
      label: `${e.kind} ${fmt(e.y, 5)}`,
      colour: TAYLOR,
      radius: 3.5,
      offset: [8, e.kind === 'max' ? -10 : 12],
    });
  }
  // Inflection points: roots of the second derivative, where the curve changes
  // which way it bends. These are what the dotted curve is for. They are drawn
  // unlabelled — a periodic function has dozens of them across the window and
  // labelling every one buries the plot under its own annotations.
  const inflections = findRoots((x) => numericDerivative(fn, x, 2), view.xMin, view.xMax, 600);
  const inflectionXs: number[] = [];
  const inflectionYs: number[] = [];
  for (const p of inflections.slice(0, 40)) {
    const y = fn(p);
    if (!Number.isFinite(y) || y < view.yMin || y > view.yMax) continue;
    inflectionXs.push(p);
    inflectionYs.push(y);
  }
  if (inflectionXs.length) {
    layers.push({
      type: 'points',
      xs: inflectionXs,
      ys: inflectionYs,
      colour: SECOND,
      radius: 3,
      shape: 'ring',
      stroke: SECOND,
    });
  }

  layers.push({ type: 'vline', x: cfg.a, colour: withAlpha(AREA, 0.7), style: 'dotted', width: 1.2 });
  layers.push({ type: 'vline', x: cfg.b, colour: withAlpha(AREA, 0.7), style: 'dotted', width: 1.2 });

  const result = integrate(fn, cfg.a, cfg.b, 1e-11);
  return {
    layers,
    legend: [
      { label: 'f', colour: CURVE },
      { label: 'f′', colour: DERIV, dashed: true },
      { label: 'f″', colour: SECOND, dashed: true },
    ],
    xLabel: 'x',
    yLabel: 'y',
    caption: `∫ from ${fmt(cfg.a, 4)} to ${fmt(cfg.b, 4)} = ${fmt(result.value, 9)}`,
  };
}

function riemannScene(cfg: CalculusConfig, scope: EvalScope, view: { xMin: number; xMax: number; yMin: number; yMax: number; width: number; height: number }, tab: TabState): ScenePart {
  const { fn, error } = scope.compile1(cfg.f || '0', 'x');
  if (error) return { layers: [], xLabel: 'x', yLabel: 'y', caption: error };

  // The clock sweeps the subdivision count from 1 up to the slider value, so
  // pressing play shows the sum converging.
  const n = tab.timeline.playing
    ? Math.max(1, Math.round(1 + (cfg.riemannN - 1) * ((tab.timeline.t / Math.max(tab.timeline.tMax, 1e-9)) % 1)))
    : Math.max(1, Math.round(cfg.riemannN));

  const { sum, bars } = riemann(fn, cfg.a, cfg.b, n, cfg.riemannRule);
  const layers: Layer[] = [];

  for (const bar of bars) {
    layers.push({
      type: 'rect',
      x0: bar.x0,
      y0: 0,
      x1: bar.x1,
      y1: bar.height,
      fill: withAlpha(AREA, bar.height >= 0 ? 0.22 : 0.14),
      stroke: withAlpha(AREA, 0.75),
    });
  }
  layers.push({ type: 'curve', segments: sampleFunction(fn, view), colour: CURVE, width: 2.4 });
  layers.push({ type: 'vline', x: cfg.a, colour: 'rgba(148,163,184,0.5)', style: 'dotted', width: 1 });
  layers.push({ type: 'vline', x: cfg.b, colour: 'rgba(148,163,184,0.5)', style: 'dotted', width: 1 });

  const exact = integrate(fn, cfg.a, cfg.b, 1e-11).value;
  return {
    layers,
    xLabel: 'x',
    yLabel: 'y',
    caption: `n = ${n}  ·  sum ${fmt(sum, 9)}  ·  exact ${fmt(exact, 9)}  ·  error ${fmt(sum - exact, 4)}`,
  };
}

function taylorScene(cfg: CalculusConfig, scope: EvalScope, view: { xMin: number; xMax: number; yMin: number; yMax: number; width: number; height: number }, tab: TabState): ScenePart {
  const { fn, error } = scope.compile1(cfg.f || '0', 'x');
  if (error) return { layers: [], xLabel: 'x', yLabel: 'y', caption: error };

  const order = tab.timeline.playing
    ? Math.round((tab.timeline.t / Math.max(tab.timeline.tMax, 1e-9)) * cfg.taylorOrder) % (cfg.taylorOrder + 1)
    : Math.round(cfg.taylorOrder);

  /* Derivatives by repeated central differences.
   *
   * Each order costs an extra factor of about ε^(1/(k+2)) in accuracy, so the
   * step has to grow with the order or the whole thing drowns in round-off.
   * This is the honest limitation of a numerical Taylor series and it is why
   * the panel warns about high orders rather than pretending they are exact. */
  const coefficients: number[] = [];
  const c = cfg.taylorCentre;
  for (let k = 0; k <= order; k++) {
    coefficients.push(nthDerivative(fn, c, k) / factorial(k));
  }
  const taylor = (x: number) => {
    let acc = 0;
    const d = x - c;
    for (let k = order; k >= 0; k--) acc = acc * d + coefficients[k];
    return acc;
  };

  const layers: Layer[] = [
    { type: 'curve', segments: sampleFunction(fn, view), colour: CURVE, width: 2.4 },
    { type: 'curve', segments: sampleFunction(taylor, view), colour: TAYLOR, width: 2, style: 'dashed' },
    {
      type: 'curve',
      segments: sampleFunction((x) => Math.abs(fn(x) - taylor(x)), view),
      colour: SECOND,
      width: 1.2,
      alpha: 0.6,
      style: 'dotted',
    },
    { type: 'vline', x: c, colour: withAlpha(TAYLOR, 0.6), style: 'dotted', width: 1.2 },
    { type: 'marker', x: c, y: fn(c), label: `centre ${fmt(c, 4)}`, colour: TAYLOR },
  ];

  return {
    layers,
    legend: [
      { label: 'f', colour: CURVE },
      { label: `Taylor, order ${order}`, colour: TAYLOR, dashed: true },
      { label: '|error|', colour: SECOND, dashed: true },
    ],
    xLabel: 'x',
    yLabel: 'y',
    caption: coefficients
      .slice(0, 6)
      .map((v, k) => `c${k}=${fmt(v, 4)}`)
      .join('  '),
  };
}

/** kth derivative by repeated central differencing, with a step that grows
 *  with the order to keep round-off from dominating. */
function nthDerivative(f: (x: number) => number, x: number, k: number): number {
  if (k === 0) return f(x);
  if (k === 1) return numericDerivative(f, x, 1);
  if (k === 2) return numericDerivative(f, x, 2);
  const h = Math.pow(2.2e-16, 1 / (k + 2)) * Math.max(Math.abs(x), 1);
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    const coefficient = (i % 2 === 0 ? 1 : -1) * binomial(k, i);
    sum += coefficient * f(x + (k / 2 - i) * h);
  }
  return sum / Math.pow(h, k);
}

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

function slopeFieldScene(cfg: CalculusConfig, scope: EvalScope, view: { xMin: number; xMax: number; yMin: number; yMax: number; width: number; height: number }): ScenePart {
  const { fn, error } = scope.compile2(cfg.slopeExpr || '0', 'x', 'y');
  if (error) return { layers: [], xLabel: 'x', yLabel: 'y', caption: error };

  const layers: Layer[] = [];
  const cols = 26;
  const rows = 18;
  const dx = (view.xMax - view.xMin) / cols;
  const dy = (view.yMax - view.yMin) / rows;
  const length = Math.min(dx, dy) * 0.78;
  const data: number[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = view.xMin + (i + 0.5) * dx;
      const y = view.yMin + (j + 0.5) * dy;
      const slope = fn(x, y);
      if (!Number.isFinite(slope)) continue;
      // The tick is drawn as a unit vector along (1, slope): normalising means
      // a slope of 1000 is a near-vertical tick rather than a line off screen.
      const norm = Math.hypot(1, slope);
      const ux = (length / 2) / norm;
      const uy = ((length / 2) * slope) / norm;
      data.push(x - ux, y - uy, x + ux, y + uy);
    }
  }
  layers.push({ type: 'segments', data: Float64Array.from(data), colour: 'rgba(139,124,246,0.55)', width: 1.3 });

  const legend: { label: string; colour: string }[] = [];
  for (const seed of cfg.slopeSeeds) {
    // Integrated forwards and backwards so the curve passes through the seed
    // rather than starting there, which is what an integral curve means.
    const forward = solveOde(
      (x, yv, out) => {
        out[0] = fn(x, yv[0]);
      },
      [seed.y],
      seed.x,
      view.xMax,
      cfg,
    );
    const backward = solveOde(
      (x, yv, out) => {
        out[0] = fn(x, yv[0]);
      },
      [seed.y],
      seed.x,
      view.xMin,
      cfg,
    );
    const xs = [...backward.map((s) => s.t).reverse(), ...forward.map((s) => s.t)];
    const ys = [...backward.map((s) => s.y[0]).reverse(), ...forward.map((s) => s.y[0])];
    layers.push({ type: 'polyline', xs, ys, colour: seed.colour, width: 2 });
    layers.push({ type: 'points', xs: [seed.x], ys: [seed.y], colour: seed.colour, radius: 4, shape: 'ring', stroke: seed.colour });
    legend.push({ label: `(${fmt(seed.x, 3)}, ${fmt(seed.y, 3)})`, colour: seed.colour });
  }

  return {
    layers,
    legend: legend.length ? legend : undefined,
    xLabel: 'x',
    yLabel: 'y',
    caption: 'Double-click to add a starting point',
  };
}

function phaseScene(cfg: CalculusConfig, scope: EvalScope, view: { xMin: number; xMax: number; yMin: number; yMax: number; width: number; height: number }): ScenePart {
  const p = scope.compile2(cfg.systemP || '0', 'x', 'y');
  const q = scope.compile2(cfg.systemQ || '0', 'x', 'y');
  if (p.error || q.error) {
    return { layers: [], xLabel: 'x', yLabel: 'y', caption: p.error ?? q.error ?? '' };
  }

  const layers: Layer[] = [];

  // ---- direction field
  const cols = 24;
  const rows = 17;
  const dx = (view.xMax - view.xMin) / cols;
  const dy = (view.yMax - view.yMin) / rows;
  const cell = Math.min(dx, dy) * 0.7;
  const arrows: { x: number; y: number; dx: number; dy: number; speed: number }[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = view.xMin + (i + 0.5) * dx;
      const y = view.yMin + (j + 0.5) * dy;
      const u = p.fn(x, y);
      const v = q.fn(x, y);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const speed = Math.hypot(u, v);
      if (speed < 1e-12) continue;
      arrows.push({ x, y, dx: (u / speed) * cell, dy: (v / speed) * cell, speed });
    }
  }
  const maxSpeed = Math.max(...arrows.map((a) => a.speed), 1e-9);
  layers.push({
    type: 'arrows',
    arrows,
    colour: (speed: number) => `rgba(139,124,246,${(0.25 + 0.55 * Math.min(1, speed / maxSpeed)).toFixed(3)})`,
    width: 1.2,
    headSize: 3.4,
  });

  if (cfg.showNullclines) {
    layers.push({
      type: 'segments',
      data: marchingSquares(p.fn, view, 0, 220),
      colour: withAlpha(DERIV, 0.8),
      width: 1.4,
      style: 'dashed',
    });
    layers.push({
      type: 'segments',
      data: marchingSquares(q.fn, view, 0, 220),
      colour: withAlpha(SECOND, 0.8),
      width: 1.4,
      style: 'dashed',
    });
  }

  if (cfg.showEquilibria) {
    for (const eq of findEquilibria(p.fn, q.fn, view)) {
      layers.push({
        type: 'marker',
        x: eq.x,
        y: eq.y,
        label: `${eq.kind} (${fmt(eq.x, 4)}, ${fmt(eq.y, 4)})`,
        colour: '#fbbf24',
        radius: 4.5,
      });
    }
  }

  for (const seed of cfg.phaseSeeds) {
    const steps = solveOde(
      (_t, yv, out) => {
        out[0] = p.fn(yv[0], yv[1]);
        out[1] = q.fn(yv[0], yv[1]);
      },
      [seed.x, seed.y],
      0,
      cfg.odeDuration,
      cfg,
    );
    layers.push({
      type: 'polyline',
      xs: steps.map((s) => s.y[0]),
      ys: steps.map((s) => s.y[1]),
      colour: seed.colour,
      width: 1.9,
    });
    layers.push({ type: 'points', xs: [seed.x], ys: [seed.y], colour: seed.colour, radius: 4, shape: 'ring', stroke: seed.colour });
  }

  return {
    layers,
    legend: cfg.showNullclines
      ? [
          { label: "x′ = 0", colour: DERIV, dashed: true },
          { label: "y′ = 0", colour: SECOND, dashed: true },
        ]
      : undefined,
    xLabel: 'x',
    yLabel: 'y',
    caption: 'Double-click to launch a trajectory',
  };
}

function solveOde(
  f: (t: number, y: readonly number[], out: number[]) => void,
  y0: number[],
  t0: number,
  t1: number,
  cfg: CalculusConfig,
): OdeStep[] {
  if (t1 === t0) return [{ t: t0, y: [...y0] }];
  if (cfg.solver === 'rk4') {
    return rk4(f, y0, t0, t1, Math.max(10, Math.min(cfg.odeSteps, 200000)));
  }
  // dopri5 only integrates forwards, so a backward solve is done by reversing
  // time and negating the field — the standard trick, and exact.
  if (t1 < t0) {
    const reversed = dopri5(
      (t, y, out) => {
        f(t0 - (t - t0), y, out);
        for (let i = 0; i < out.length; i++) out[i] = -out[i];
      },
      y0,
      t0,
      t0 + (t0 - t1),
      { maxSteps: 40000 },
    );
    return reversed.map((s) => ({ t: t0 - (s.t - t0), y: s.y }));
  }
  return dopri5(f, y0, t0, t1, { maxSteps: 40000 });
}

/** Equilibria found by scanning for cells where both components change sign,
 *  then refined by a short Newton iteration on the 2×2 system. */
function findEquilibria(
  p: (x: number, y: number) => number,
  q: (x: number, y: number) => number,
  view: { xMin: number; xMax: number; yMin: number; yMax: number },
): { x: number; y: number; kind: string }[] {
  const out: { x: number; y: number; kind: string }[] = [];
  const n = 40;
  const dx = (view.xMax - view.xMin) / n;
  const dy = (view.yMax - view.yMin) / n;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x0 = view.xMin + i * dx;
      const y0 = view.yMin + j * dy;
      const corners = [
        [x0, y0],
        [x0 + dx, y0],
        [x0, y0 + dy],
        [x0 + dx, y0 + dy],
      ];
      const ps = corners.map(([x, y]) => p(x, y));
      const qs = corners.map(([x, y]) => q(x, y));
      if (!ps.every(Number.isFinite) || !qs.every(Number.isFinite)) continue;
      const pSign = ps.some((v) => v > 0) && ps.some((v) => v < 0);
      const qSign = qs.some((v) => v > 0) && qs.some((v) => v < 0);
      if (!pSign || !qSign) continue;

      let x = x0 + dx / 2;
      let y = y0 + dy / 2;
      let converged = false;
      for (let k = 0; k < 40; k++) {
        const h = 1e-6;
        const px = (p(x + h, y) - p(x - h, y)) / (2 * h);
        const py = (p(x, y + h) - p(x, y - h)) / (2 * h);
        const qx = (q(x + h, y) - q(x - h, y)) / (2 * h);
        const qy = (q(x, y + h) - q(x, y - h)) / (2 * h);
        const det = px * qy - py * qx;
        if (Math.abs(det) < 1e-14) break;
        const fx = p(x, y);
        const fy = q(x, y);
        const stepX = (fx * qy - fy * py) / det;
        const stepY = (fy * px - fx * qx) / det;
        x -= stepX;
        y -= stepY;
        if (Math.hypot(stepX, stepY) < 1e-12) {
          converged = true;
          break;
        }
      }
      if (!converged) continue;
      if (x < view.xMin || x > view.xMax || y < view.yMin || y > view.yMax) continue;
      if (out.some((e) => Math.hypot(e.x - x, e.y - y) < Math.min(dx, dy) * 0.5)) continue;

      // Classify from the Jacobian's eigenvalues: trace and determinant are
      // enough to name every generic planar equilibrium.
      const h = 1e-6;
      const a11 = (p(x + h, y) - p(x - h, y)) / (2 * h);
      const a12 = (p(x, y + h) - p(x, y - h)) / (2 * h);
      const a21 = (q(x + h, y) - q(x - h, y)) / (2 * h);
      const a22 = (q(x, y + h) - q(x, y - h)) / (2 * h);
      const tr = a11 + a22;
      const det = a11 * a22 - a12 * a21;
      const disc = tr * tr - 4 * det;
      let kind: string;
      if (det < 0) kind = 'saddle';
      else if (disc < 0) kind = Math.abs(tr) < 1e-8 ? 'centre' : tr < 0 ? 'stable spiral' : 'unstable spiral';
      else kind = tr < 0 ? 'stable node' : 'unstable node';
      out.push({ x, y, kind });
    }
  }
  return out.slice(0, 12);
}

export function calculusCsv(tab: TabState): string | null {
  const cfg = tab.calculus;
  const scope = new EvalScope();
  for (const p of tab.parameters) scope.set(p.name, p.value);
  scope.set('time', tab.timeline.t);

  if (cfg.view === 'phase') {
    const p = scope.compile2(cfg.systemP, 'x', 'y');
    const q = scope.compile2(cfg.systemQ, 'x', 'y');
    if (p.error || q.error) return null;
    const rows = ['seed,t,x,y'];
    cfg.phaseSeeds.forEach((seed, i) => {
      const steps = solveOde(
        (_t, yv, out) => {
          out[0] = p.fn(yv[0], yv[1]);
          out[1] = q.fn(yv[0], yv[1]);
        },
        [seed.x, seed.y],
        0,
        cfg.odeDuration,
        cfg,
      );
      for (const s of steps) rows.push(`${i + 1},${s.t},${s.y[0]},${s.y[1]}`);
    });
    return rows.join('\n');
  }

  const { fn, error } = scope.compile1(cfg.f || '0', 'x');
  if (error) return null;
  const rows = ['x,f(x),f′(x),f″(x)'];
  const n = 1000;
  for (let i = 0; i <= n; i++) {
    const x = tab.viewport.xMin + ((tab.viewport.xMax - tab.viewport.xMin) * i) / n;
    rows.push(`${x},${fn(x)},${numericDerivative(fn, x)},${numericDerivative(fn, x, 2)}`);
  }
  return rows.join('\n');
}
