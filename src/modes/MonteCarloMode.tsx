import { useMemo } from 'react';
import { useStore } from '../core/store';
import type { MonteCarloConfig, TabState } from '../core/types';
import {
  PROCESSES,
  PROCESS_BY_ID,
  monteCarloArea,
  quantileBands,
  riskSummary,
  simulate,
  terminalValues,
  type Ensemble,
} from '../core/math/simulate';
import { histogram, kde, maxAbs, summarise } from '../core/math/stats';
import { EvalScope } from '../core/math/scope';
import { randomSeedString } from '../core/math/random';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { ViewPanel } from '../components/panels/ViewPanel';
import { ParameterPanel } from '../components/panels/ParameterPanel';
import {
  Button,
  Callout,
  Collapsible,
  Field,
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
import { Formula } from '../components/inputs/MathField';
import { IconDice } from '../components/ui/Icons';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';

const PATH_COLOUR = '#8b7cf6';
const MEAN_COLOUR = '#fbbf24';
const BAND_COLOUR = '#38bdf8';

/* ------------------------------------------------------------------ compute */

interface Simulation {
  ensemble: Ensemble;
  bands: ReturnType<typeof quantileBands>;
  terminal: Float64Array;
  risk: ReturnType<typeof riskSummary>;
  start: number;
  error: string | null;
}

/**
 * Runs the ensemble for a configuration.
 *
 * Memoised on the configuration alone: identical settings give an identical
 * ensemble because the generator is seeded, so there is never a reason to
 * re-run one. This is also what makes the fan chart stable while the user
 * drags an unrelated slider.
 */
function useSimulation(cfg: MonteCarloConfig, parameters: TabState['parameters']): Simulation {
  // Every input the memo body reads must appear here. `barrier` is easy to
  // forget because it only affects the risk summary, not the paths — and its
  // absence made the barrier statistics silently never appear.
  const key = JSON.stringify([
    cfg.processId,
    cfg.params,
    cfg.steps,
    cfg.paths,
    cfg.seed,
    cfg.antithetic,
    cfg.bandLevels,
    cfg.barrier,
    cfg.customDrift,
    cfg.customDiffusion,
    cfg.customX0,
    cfg.customT,
    parameters.map((p) => [p.name, p.value]),
  ]);

  return useMemo(() => {
    let error: string | null = null;
    let custom: Parameters<typeof simulate>[0]['custom'];

    if (cfg.processId === 'custom') {
      const scope = new EvalScope();
      for (const p of parameters) scope.set(p.name, p.value);
      const drift = scope.compile2(cfg.customDrift || '0', 'x', 't');
      const diffusion = scope.compile2(cfg.customDiffusion || '0', 'x', 't');
      error = drift.error ?? diffusion.error;
      custom = { drift: drift.fn, diffusion: diffusion.fn, x0: cfg.customX0, T: cfg.customT };
    }

    const ensemble = simulate({
      process: cfg.processId as 'gbm',
      params: cfg.params,
      steps: Math.max(2, Math.min(cfg.steps, 5000)),
      paths: Math.max(1, Math.min(cfg.paths, 20000)),
      seed: cfg.seed,
      antithetic: cfg.antithetic,
      ...(custom ? { custom } : {}),
    });

    const levels = [...cfg.bandLevels].sort((a, b) => a - b);
    const bands = quantileBands(ensemble, levels);
    const terminal = terminalValues(ensemble);
    const start = ensemble.values[0] ?? 0;
    const risk = riskSummary(ensemble, start, cfg.barrier ?? undefined);
    return { ensemble, bands, terminal, risk, start, error };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/* ------------------------------------------------------------------ panel */

export function MonteCarloPanel({ tab }: { tab: TabState }) {
  const setMonteCarlo = useStore((s) => s.setMonteCarlo);
  const cfg = tab.monteCarlo;
  const spec = PROCESS_BY_ID.get(cfg.processId as 'gbm');
  const sim = useSimulation(cfg, tab.parameters);
  const terminalSummary = useMemo(() => summarise(Array.from(sim.terminal)), [sim.terminal]);

  return (
    <>
      <Collapsible title="Process">
        <Select
          value={cfg.processId}
          onChange={(processId) => {
            const next = PROCESS_BY_ID.get(processId as 'gbm');
            setMonteCarlo({
              processId,
              params: next ? Object.fromEntries(next.params.map((p) => [p.key, p.default])) : cfg.params,
            });
          }}
          options={[
            ...PROCESSES.map((p) => ({ value: p.id, label: p.name })),
            { value: 'custom', label: 'Custom SDE' },
          ]}
        />

        {spec && (
          <>
            <p className="text-2xs leading-relaxed text-ink-faint">{spec.blurb}</p>
            <div className="overflow-x-auto rounded-md border border-edge bg-surface-1 px-2.5 py-2 text-center">
              <Formula latex={spec.sde} display />
            </div>
            {spec.params.map((p) => (
              <div key={p.key}>
                <div className="flex items-baseline justify-between">
                  <span className="field-label">{p.label}</span>
                  <span className="font-mono text-2xs tabular-nums text-ink">
                    {fmt(cfg.params[p.key] ?? p.default)}
                    {p.hint && <span className="ml-1 text-ink-faint">{p.hint}</span>}
                  </span>
                </div>
                <Slider
                  value={cfg.params[p.key] ?? p.default}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  onChange={(v) => setMonteCarlo({ params: { ...cfg.params, [p.key]: v } })}
                />
              </div>
            ))}
          </>
        )}

        {cfg.processId === 'custom' && (
          <>
            <p className="text-2xs leading-relaxed text-ink-faint">
              Write the drift and diffusion of{' '}
              <span className="font-mono text-ink-dim">dX = a(x,t)dt + b(x,t)dW</span>. Integrated by
              Euler–Maruyama, so keep the step count high if b is large.
            </p>
            <Field label="Drift a(x, t)">
              <input
                className="input-base font-mono"
                value={cfg.customDrift}
                spellCheck={false}
                onChange={(e) => setMonteCarlo({ customDrift: e.target.value })}
              />
            </Field>
            <Field label="Diffusion b(x, t)">
              <input
                className="input-base font-mono"
                value={cfg.customDiffusion}
                spellCheck={false}
                onChange={(e) => setMonteCarlo({ customDiffusion: e.target.value })}
              />
            </Field>
            <Row>
              <div className="flex-1">
                <span className="field-label">X₀</span>
                <NumberField value={cfg.customX0} step={1} onChange={(customX0) => setMonteCarlo({ customX0 })} />
              </div>
              <div className="flex-1">
                <span className="field-label">Horizon T</span>
                <NumberField
                  value={cfg.customT}
                  min={0.01}
                  step={0.5}
                  onChange={(customT) => setMonteCarlo({ customT })}
                />
              </div>
            </Row>
            {sim.error && <Callout kind="error">{sim.error}</Callout>}
          </>
        )}
      </Collapsible>

      <Collapsible title="Sampling">
        <Row>
          <div className="flex-1">
            <span className="field-label">Paths</span>
            <NumberField
              value={cfg.paths}
              min={1}
              max={20000}
              step={100}
              onChange={(paths) => setMonteCarlo({ paths: Math.round(paths) })}
            />
          </div>
          <div className="flex-1">
            <span className="field-label">Steps</span>
            <NumberField
              value={cfg.steps}
              min={2}
              max={5000}
              step={50}
              onChange={(steps) => setMonteCarlo({ steps: Math.round(steps) })}
            />
          </div>
        </Row>

        <Field label="Seed" hint="The same seed always gives the same ensemble, and is saved with the project.">
          <div className="flex gap-1.5">
            <input
              className="input-base flex-1 font-mono"
              value={cfg.seed}
              spellCheck={false}
              onChange={(e) => setMonteCarlo({ seed: e.target.value })}
            />
            <Button title="New random seed" onClick={() => setMonteCarlo({ seed: randomSeedString() })}>
              <IconDice size={14} />
            </Button>
          </div>
        </Field>

        <Toggle
          label="Antithetic variates"
          hint="Pairs each path with its mirror image, which roughly halves the error in the mean for free."
          checked={cfg.antithetic}
          onChange={(antithetic) => setMonteCarlo({ antithetic })}
        />

        <div>
          <div className="flex items-baseline justify-between">
            <span className="field-label">Paths drawn</span>
            <span className="font-mono text-2xs text-ink">{Math.min(cfg.visiblePaths, cfg.paths)}</span>
          </div>
          <Slider
            value={cfg.visiblePaths}
            min={0}
            max={400}
            step={5}
            onChange={(visiblePaths) => setMonteCarlo({ visiblePaths: Math.round(visiblePaths) })}
          />
        </div>

        <Toggle label="Percentile bands" checked={cfg.showBands} onChange={(showBands) => setMonteCarlo({ showBands })} />
        <Toggle label="Mean path" checked={cfg.showMean} onChange={(showMean) => setMonteCarlo({ showMean })} />
        <Toggle
          label="Logarithmic price axis"
          hint="A log scale makes proportional moves look the same size wherever they happen."
          checked={cfg.logScale}
          onChange={(logScale) => setMonteCarlo({ logScale })}
        />

        <Field label="Barrier level" hint="Leave empty for none. Reports the chance of finishing above it and of ever touching it.">
          <div className="flex gap-1.5">
            <NumberField
              className="flex-1"
              value={cfg.barrier ?? 0}
              step={5}
              disabled={cfg.barrier === null}
              onChange={(barrier) => setMonteCarlo({ barrier })}
            />
            <Button
              onClick={() => setMonteCarlo({ barrier: cfg.barrier === null ? Math.round(sim.start * 1.2) : null })}
            >
              {cfg.barrier === null ? 'Set' : 'Clear'}
            </Button>
          </div>
        </Field>
      </Collapsible>

      <Collapsible title="Outcome">
        <StatList>
          <Stat label="Start" value={fmt(sim.start)} />
          <Stat label="Mean" value={fmt(sim.risk.mean)} emphasis />
          <Stat label="Median" value={fmt(sim.risk.median)} />
          <Stat label="Std. dev." value={fmt(sim.risk.sd)} />
          <Stat label="5th percentile" value={fmt(terminalSummary.n ? quantileAt(sim.terminal, 0.05) : NaN)} />
          <Stat label="95th percentile" value={fmt(terminalSummary.n ? quantileAt(sim.terminal, 0.95) : NaN)} />
          <Stat label="Minimum" value={fmt(sim.risk.min)} />
          <Stat label="Maximum" value={fmt(sim.risk.max)} />
        </StatList>

        <div className="border-t border-edge pt-2">
          <StatList>
            <Stat label="P(loss)" value={`${(sim.risk.probOfLoss * 100).toFixed(2)}%`} />
            <Stat label="VaR 95%" value={fmt(sim.risk.var95)} hint="Loss not exceeded 95% of the time" />
            <Stat label="VaR 99%" value={fmt(sim.risk.var99)} />
            <Stat label="Expected shortfall" value={fmt(sim.risk.es95)} hint="Mean loss in the worst 5% of outcomes" />
            {sim.risk.probAboveBarrier !== undefined && (
              <Stat label="P(finish above barrier)" value={`${(sim.risk.probAboveBarrier * 100).toFixed(2)}%`} />
            )}
            {sim.risk.probTouchedBarrier !== undefined && (
              <Stat label="P(ever touches)" value={`${(sim.risk.probTouchedBarrier * 100).toFixed(2)}%`} />
            )}
          </StatList>
        </div>

        <Callout>
          Every figure here is a Monte Carlo estimate from {cfg.paths.toLocaleString()} paths, so it carries a
          standard error of roughly {fmt(sim.risk.sd / Math.sqrt(cfg.paths), 3)} on the mean. Doubling the
          accuracy costs four times the paths.
        </Callout>
      </Collapsible>

      <Collapsible title="Second panel">
        <SegmentedControl
          value={cfg.panel}
          onChange={(panel) => setMonteCarlo({ panel })}
          options={[
            { value: 'terminal', label: 'Terminal' },
            { value: 'convergence', label: 'Convergence' },
            { value: 'integration', label: 'Integration' },
          ]}
        />
        {cfg.panel === 'integration' && (
          <>
            <Field label="Region" hint="An expression in x and y that is positive inside the region.">
              <input
                className="input-base font-mono"
                value={cfg.integrationRegion}
                spellCheck={false}
                onChange={(e) => setMonteCarlo({ integrationRegion: e.target.value })}
              />
            </Field>
            <Field label="Samples">
              <NumberField
                value={cfg.integrationSamples}
                min={100}
                max={500000}
                step={1000}
                onChange={(integrationSamples) => setMonteCarlo({ integrationSamples: Math.round(integrationSamples) })}
              />
            </Field>
          </>
        )}
      </Collapsible>

      {tab.parameters.length > 0 && <ParameterPanel parameters={tab.parameters} />}
      <ViewPanel tab={tab} showAxesOptions={false} />
    </>
  );
}

function quantileAt(values: Float64Array, q: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/* ------------------------------------------------------------------ surface */

export function MonteCarloSurface({ tab }: { tab: TabState }) {
  const plotRef = usePlot2DRef();
  const cfg = tab.monteCarlo;
  const sim = useSimulation(cfg, tab.parameters);

  /* The vertical extent of the whole ensemble, clipped to its central 99.6% so
   * a single runaway path cannot squash the rest of the chart flat.
   *
   * Memoised on the simulation alone. It was originally computed inside the
   * scene memo, which also depends on the clock — so at the default 500 paths
   * × 252 steps it copied, filtered and sorted 126 500 numbers on every frame
   * of playback to recover two bounds that never change.
   */
  const extent = useMemo(() => {
    const all = Array.from(sim.ensemble.values).filter(Number.isFinite).sort((a, b) => a - b);
    const lo = all[Math.floor(all.length * 0.002)] ?? 0;
    const hi = all[Math.floor(all.length * 0.998)] ?? 1;
    return { lo, hi, pad: (hi - lo) * 0.06 + 1e-9 };
  }, [sim]);

  /* The path plot frames itself around the ensemble rather than using the tab's
   * stored viewport: a fan chart whose y range has to be reset by hand every
   * time a parameter moves is unusable. The trade is that this surface does not
   * pan or zoom — the axes always show all of the data. */
  const pathScene = useMemo<PlotScene>(() => {
    const layers: Layer[] = [];
    const e = sim.ensemble;
    const stride = e.steps + 1;
    const tMax = e.times[e.steps];
    const revealed = tab.timeline.playing || tab.timeline.t > 0
      ? Math.max(1, Math.round((tab.timeline.t / Math.max(tab.timeline.tMax, 1e-9)) * e.steps))
      : e.steps;
    const visibleSteps = Math.min(e.steps, revealed);

    // Individual paths first, so the bands and the mean sit on top of them.
    const drawCount = Math.min(cfg.visiblePaths, e.paths);
    for (let i = 0; i < drawCount; i++) {
      const xs = new Float64Array(visibleSteps + 1);
      const ys = new Float64Array(visibleSteps + 1);
      for (let k = 0; k <= visibleSteps; k++) {
        xs[k] = e.times[k];
        ys[k] = e.values[i * stride + k];
      }
      layers.push({ type: 'polyline', xs, ys, colour: PATH_COLOUR, width: 0.9, alpha: 0.24 });
    }

    if (cfg.showBands && sim.bands.curves.length >= 2) {
      // Bands are drawn from the outside in, so the darkest region is the
      // narrowest one and the picture reads as a probability density.
      const n = sim.bands.curves.length;
      const times = Array.from(e.times.slice(0, visibleSteps + 1));
      for (let i = 0; i < Math.floor(n / 2); i++) {
        const lower = sim.bands.curves[i].slice(0, visibleSteps + 1);
        const upper = sim.bands.curves[n - 1 - i].slice(0, visibleSteps + 1);
        layers.push({
          type: 'band',
          xs: times,
          lower,
          upper,
          colour: withAlpha(BAND_COLOUR, 0.1 + i * 0.09),
        });
      }
      for (let i = 0; i < n; i++) {
        layers.push({
          type: 'polyline',
          xs: times,
          ys: sim.bands.curves[i].slice(0, visibleSteps + 1),
          colour: BAND_COLOUR,
          width: 1,
          alpha: 0.55,
          style: 'dashed',
        });
      }
    }

    if (cfg.showMean) {
      layers.push({
        type: 'polyline',
        xs: Array.from(e.times.slice(0, visibleSteps + 1)),
        ys: sim.bands.mean.slice(0, visibleSteps + 1),
        colour: MEAN_COLOUR,
        width: 2.2,
      });
    }

    if (cfg.barrier !== null && Number.isFinite(cfg.barrier)) {
      layers.push({ type: 'hline', y: cfg.barrier, colour: '#fb7185', label: `barrier ${fmt(cfg.barrier)}`, width: 1.5 });
    }
    layers.push({ type: 'hline', y: sim.start, colour: 'rgba(148,163,184,0.4)', style: 'dotted', width: 1 });

    const { lo, hi, pad } = extent;

    return {
      viewport: { xMin: 0, xMax: tMax, yMin: cfg.logScale ? Math.max(lo * 0.9, 1e-6) : lo - pad, yMax: hi + pad },
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: false,
      showAxes: false,
      logY: cfg.logScale,
      xLabel: 'time',
      yLabel: cfg.processId === 'walk' ? 'X' : 'value',
      legend: [
        { label: `${Math.min(cfg.visiblePaths, e.paths)} of ${e.paths} paths`, colour: PATH_COLOUR },
        ...(cfg.showMean ? [{ label: 'mean', colour: MEAN_COLOUR }] : []),
        ...(cfg.showBands ? [{ label: 'percentiles', colour: BAND_COLOUR, dashed: true }] : []),
      ],
      caption: `seed ${cfg.seed} · ${e.steps} steps`,
    };
  }, [sim, extent, cfg, tab.showGrid, tab.timeline.t, tab.timeline.tMax, tab.timeline.playing]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-[3]">
        {/* Deliberately static: this chart derives its own viewport from the
            ensemble, so a pan would write to the store on every pointer move
            and mark the project unsaved while the plot did not move at all. */}
        <Plot2D ref={plotRef} scene={pathScene} staticView showCrosshair={tab.showCrosshair} />
      </div>
      <div className="min-h-0 flex-[2] border-t border-edge">
        <SecondPanel tab={tab} sim={sim} />
      </div>
    </div>
  );
}

function SecondPanel({ tab, sim }: { tab: TabState; sim: Simulation }) {
  const cfg = tab.monteCarlo;

  const scene = useMemo<PlotScene>(() => {
    if (cfg.panel === 'integration') return integrationScene(cfg, tab);

    if (cfg.panel === 'convergence') {
      // The running mean of the terminal values against sample count, with the
      // ±1.96 σ/√n envelope: the visual proof that error falls as 1/√n.
      const values = Array.from(sim.terminal);
      const xs: number[] = [];
      const means: number[] = [];
      const lower: number[] = [];
      const upper: number[] = [];
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < values.length; i++) {
        sum += values[i];
        sumSq += values[i] * values[i];
        if (i < 8) continue;
        const n = i + 1;
        const mean = sum / n;
        const variance = Math.max(0, sumSq / n - mean * mean);
        const se = Math.sqrt(variance / n);
        xs.push(n);
        means.push(mean);
        lower.push(mean - 1.96 * se);
        upper.push(mean + 1.96 * se);
      }
      const final = means[means.length - 1] ?? 0;
      const spread = Math.max(...upper.slice(0, 20).map((v) => Math.abs(v - final)), 1e-6);
      return {
        viewport: { xMin: 0, xMax: values.length, yMin: final - spread * 1.3, yMax: final + spread * 1.3 },
        layers: [
          { type: 'band', xs, lower, upper, colour: withAlpha(BAND_COLOUR, 0.16) },
          { type: 'polyline', xs, ys: means, colour: MEAN_COLOUR, width: 1.8 },
          { type: 'hline', y: final, colour: 'rgba(148,163,184,0.4)', style: 'dotted', width: 1 },
        ],
        showGrid: true,
        showMinorGrid: false,
        showAxes: false,
        xLabel: 'paths used',
        yLabel: 'running mean',
        caption: '95% interval narrows as 1/√n',
      };
    }

    // ---- terminal distribution
    const values = Array.from(sim.terminal);
    const h = histogram(values, 'auto');
    const lo = h.edges[0];
    const hi = h.edges[h.edges.length - 1];
    const k = values.length > 20 ? kde(values, lo, hi, 240) : null;
    const peak = Math.max(maxAbs(h.density), k ? maxAbs(k.ys) : 0, 1e-12);
    const layers: Layer[] = [
      { type: 'bars', edges: h.edges, heights: h.density, colour: withAlpha(PATH_COLOUR, 0.45), stroke: withAlpha(PATH_COLOUR, 0.8) },
    ];
    if (k) layers.push({ type: 'polyline', xs: k.xs, ys: k.ys, colour: MEAN_COLOUR, width: 1.8 });
    layers.push({ type: 'vline', x: sim.risk.mean, colour: MEAN_COLOUR, label: `mean ${fmt(sim.risk.mean)}`, width: 1.5 });
    layers.push({ type: 'vline', x: sim.start, colour: 'rgba(148,163,184,0.55)', style: 'dotted', width: 1.2, label: 'start' });
    if (cfg.barrier !== null && Number.isFinite(cfg.barrier)) {
      layers.push({ type: 'vline', x: cfg.barrier, colour: '#fb7185', width: 1.4, label: 'barrier' });
    }

    return {
      viewport: { xMin: lo, xMax: hi, yMin: -peak * 0.06, yMax: peak * 1.12 },
      layers,
      showGrid: true,
      showMinorGrid: false,
      showAxes: false,
      xLabel: 'terminal value',
      yLabel: 'density',
      caption: `${values.length.toLocaleString()} outcomes`,
    };
  }, [cfg, sim, tab]);

  return <Plot2D scene={scene} staticView showCrosshair={false} />;
}

/** The π-estimation sandbox: uniform darts, with hits and misses coloured. */
function integrationScene(cfg: MonteCarloConfig, tab: TabState): PlotScene {
  const scope = new EvalScope();
  for (const p of tab.parameters) scope.set(p.name, p.value);
  const expr = (cfg.integrationRegion || 'x^2 + y^2 <= 1').replace(/<=|</g, '<=');
  const compiled = scope.compile2(expr.includes('<') || expr.includes('>') ? expr : `${expr}`, 'x', 'y');
  const inside = (x: number, y: number) => {
    const v = compiled.fn(x, y);
    return Number.isFinite(v) && v > 0;
  };
  const bounds = { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
  const result = monteCarloArea(inside, bounds, Math.min(cfg.integrationSamples, 200000), cfg.seed, 3500);

  const hitsX: number[] = [];
  const hitsY: number[] = [];
  const missX: number[] = [];
  const missY: number[] = [];
  for (const p of result.points) {
    if (p.inside) {
      hitsX.push(p.x);
      hitsY.push(p.y);
    } else {
      missX.push(p.x);
      missY.push(p.y);
    }
  }

  return {
    viewport: { xMin: -1.08, xMax: 1.08, yMin: -1.08, yMax: 1.08 },
    layers: [
      { type: 'rect', x0: -1, y0: -1, x1: 1, y1: 1, stroke: 'rgba(148,163,184,0.4)', dash: true },
      { type: 'points', xs: missX, ys: missY, colour: 'rgba(148,163,184,0.35)', radius: 1.2 },
      { type: 'points', xs: hitsX, ys: hitsY, colour: PATH_COLOUR, radius: 1.2 },
    ],
    showGrid: false,
    showMinorGrid: false,
    showAxes: true,
    xLabel: 'x',
    yLabel: 'y',
    caption: `area ≈ ${fmt(result.estimate, 6)} ± ${fmt(1.96 * result.standardError, 3)}  ·  ${cfg.integrationSamples.toLocaleString()} samples`,
  };
}

export function monteCarloCsv(tab: TabState): string | null {
  const cfg = tab.monteCarlo;
  const e = simulate({
    process: cfg.processId as 'gbm',
    params: cfg.params,
    steps: Math.min(cfg.steps, 2000),
    paths: Math.min(cfg.paths, 200),
    seed: cfg.seed,
    antithetic: cfg.antithetic,
  });
  const stride = e.steps + 1;
  const header = ['time', ...Array.from({ length: e.paths }, (_, i) => `path_${i + 1}`)].join(',');
  const rows = [header];
  for (let k = 0; k <= e.steps; k++) {
    const row = [e.times[k]];
    for (let i = 0; i < e.paths; i++) row.push(e.values[i * stride + k]);
    rows.push(row.join(','));
  }
  return rows.join('\n');
}
