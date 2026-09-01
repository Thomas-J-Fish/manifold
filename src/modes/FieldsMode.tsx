import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../core/store';
import type { FieldsConfig, TabState } from '../core/types';
import {
  advectParticles,
  arrowGrid,
  curl,
  divergence,
  seedParticles,
  solvePde1d,
  streamlineSet,
  type Particle,
} from '../core/math/fields';
import { Rng } from '../core/math/random';
import { EvalScope } from '../core/math/scope';
import { useScope } from '../hooks/useScope';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { ParameterPanel } from '../components/panels/ParameterPanel';
import { ViewPanel } from '../components/panels/ViewPanel';
import { MathField, analyseExpression } from '../components/inputs/MathField';
import {
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
  fmt,
} from '../components/ui/controls';
import type { Layer, PlotScene } from '../plot/scene';
import { divergingColour, sequentialColour, withAlpha } from '../plot/scene';

const KNOWN = new Set(['x', 'y', 't', 'time']);
const WAVE = '#8b7cf6';

/* ------------------------------------------------------------------ panel */

export function FieldsPanel({ tab }: { tab: TabState }) {
  const setFields = useStore((s) => s.setFields);
  const cfg = tab.fields;

  return (
    <>
      <Collapsible title="Mode">
        <SegmentedControl
          value={cfg.view}
          onChange={(view) => setFields({ view })}
          options={[
            { value: 'vector', label: 'Field', title: 'A 2D vector field' },
            { value: 'heat1d', label: 'Heat', title: 'The heat equation on a line' },
            { value: 'wave1d', label: 'Wave', title: 'The wave equation on a line' },
          ]}
        />
      </Collapsible>

      {cfg.view === 'vector' ? <VectorPanel tab={tab} cfg={cfg} /> : <PdePanel cfg={cfg} />}

      <ParameterPanel parameters={tab.parameters} />
      <ViewPanel tab={tab} />
    </>
  );
}

function VectorPanel({ tab, cfg }: { tab: TabState; cfg: FieldsConfig }) {
  const setFields = useStore((s) => s.setFields);
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);
  const known = useMemo(() => new Set([...KNOWN, ...tab.parameters.map((p) => p.name)]), [tab.parameters]);

  const centreStats = useMemo(() => {
    const p = scope.compile2(cfg.p || '0', 'x', 'y');
    const q = scope.compile2(cfg.q || '0', 'x', 'y');
    if (p.error || q.error) return null;
    const f = (x: number, y: number): [number, number] => [p.fn(x, y), q.fn(x, y)];
    const cx = (tab.viewport.xMin + tab.viewport.xMax) / 2;
    const cy = (tab.viewport.yMin + tab.viewport.yMax) / 2;
    return {
      div: divergence(f, cx, cy),
      curl: curl(f, cx, cy),
      speed: Math.hypot(p.fn(cx, cy), q.fn(cx, cy)),
      at: [cx, cy] as [number, number],
    };
  }, [scope, cfg.p, cfg.q, tab.viewport]);

  return (
    <>
      <Collapsible title="Vector field">
        <MathField
          value={cfg.p}
          onChange={(p) => setFields({ p })}
          prefix="P(x,y) ="
          status={analyseExpression(cfg.p, known)}
        />
        <MathField
          value={cfg.q}
          onChange={(q) => setFields({ q })}
          prefix="Q(x,y) ="
          status={analyseExpression(cfg.q, known)}
        />
        <div className="grid grid-cols-2 gap-1">
          {[
            { label: 'Rotation', p: '-y', q: 'x' },
            { label: 'Source', p: 'x', q: 'y' },
            { label: 'Saddle', p: 'x', q: '-y' },
            { label: 'Shear', p: 'y', q: '0' },
            { label: 'Spiral sink', p: '-x - y', q: 'x - y' },
            { label: 'Dipole', p: 'x^2 - y^2', q: '2*x*y' },
            { label: 'Pendulum', p: 'y', q: '-sin(x)' },
            { label: 'Gradient', p: '-2*x', q: '-2*y' },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setFields({ p: preset.p, q: preset.q })}
              className="rounded border border-edge px-1 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Display">
        <SegmentedControl
          value={cfg.display}
          onChange={(display) => setFields({ display })}
          options={[
            { value: 'arrows', label: 'Arrows' },
            { value: 'streamlines', label: 'Streamlines' },
            { value: 'particles', label: 'Particles' },
          ]}
        />

        {cfg.display === 'arrows' && (
          <>
            <div>
              <div className="flex items-baseline justify-between">
                <span className="field-label">Density</span>
                <span className="font-mono text-2xs text-ink">{Math.round(cfg.arrowDensity)}</span>
              </div>
              <Slider
                value={cfg.arrowDensity}
                min={6}
                max={48}
                step={1}
                onChange={(arrowDensity) => setFields({ arrowDensity: Math.round(arrowDensity) })}
              />
            </div>
            <Field label="Arrow length">
              <Select
                value={cfg.lengthMode}
                onChange={(lengthMode) => setFields({ lengthMode })}
                options={[
                  { value: 'uniform', label: 'Uniform — speed shown by colour' },
                  { value: 'scaled', label: 'Proportional to speed' },
                ]}
              />
            </Field>
          </>
        )}

        {cfg.display === 'streamlines' && (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="field-label">Line count</span>
              <span className="font-mono text-2xs text-ink">{Math.round(cfg.streamlineCount)}</span>
            </div>
            <Slider
              value={cfg.streamlineCount}
              min={8}
              max={220}
              step={2}
              onChange={(streamlineCount) => setFields({ streamlineCount: Math.round(streamlineCount) })}
            />
          </div>
        )}

        {cfg.display === 'particles' && (
          <>
            <div>
              <div className="flex items-baseline justify-between">
                <span className="field-label">Particles</span>
                <span className="font-mono text-2xs text-ink">{Math.round(cfg.particleCount)}</span>
              </div>
              <Slider
                value={cfg.particleCount}
                min={100}
                max={4000}
                step={50}
                onChange={(particleCount) => setFields({ particleCount: Math.round(particleCount) })}
              />
            </div>
            <div>
              <div className="flex items-baseline justify-between">
                <span className="field-label">Speed</span>
                <span className="font-mono text-2xs text-ink">{cfg.particleSpeed.toFixed(2)}×</span>
              </div>
              <Slider
                value={cfg.particleSpeed}
                min={0.05}
                max={4}
                step={0.05}
                onChange={(particleSpeed) => setFields({ particleSpeed })}
              />
            </div>
            <Callout>Press play below to set the particles moving.</Callout>
          </>
        )}

        <Field label="Background">
          <Select
            value={cfg.scalarOverlay}
            onChange={(scalarOverlay) => setFields({ scalarOverlay })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'magnitude', label: 'Speed |F|' },
              { value: 'divergence', label: 'Divergence ∇·F' },
              { value: 'curl', label: 'Curl ∇×F' },
            ]}
          />
        </Field>
      </Collapsible>

      {centreStats && (
        <Collapsible title="At the centre of the view">
          <StatList>
            <Stat label="Point" value={`(${fmt(centreStats.at[0], 4)}, ${fmt(centreStats.at[1], 4)})`} />
            <Stat label="Speed" value={fmt(centreStats.speed)} />
            <Stat label="Divergence" value={fmt(centreStats.div)} emphasis />
            <Stat label="Curl" value={fmt(centreStats.curl)} emphasis />
          </StatList>
          <Callout>
            {Math.abs(centreStats.div) < 1e-6
              ? 'Divergence is zero here: the flow is incompressible at this point — as much comes in as goes out.'
              : centreStats.div > 0
                ? 'Positive divergence: this point behaves as a source.'
                : 'Negative divergence: this point behaves as a sink.'}
          </Callout>
        </Collapsible>
      )}
    </>
  );
}

function PdePanel({ cfg }: { cfg: FieldsConfig }) {
  const setFields = useStore((s) => s.setFields);
  const isWave = cfg.view === 'wave1d';

  return (
    <>
      <Collapsible title={isWave ? 'Wave equation' : 'Heat equation'}>
        <div className="rounded-md border border-edge bg-surface-1 px-2.5 py-2 text-center font-mono text-xs text-ink-dim">
          {isWave ? '∂²u/∂t² = c² ∂²u/∂x²' : '∂u/∂t = α ∂²u/∂x²'}
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="field-label">{isWave ? 'Wave speed c' : 'Diffusivity α'}</span>
            <span className="font-mono text-2xs text-ink">{cfg.coefficient.toFixed(3)}</span>
          </div>
          <Slider
            value={cfg.coefficient}
            min={0.01}
            max={4}
            step={0.01}
            onChange={(coefficient) => setFields({ coefficient })}
          />
        </div>

        <Field label="Initial condition u(x, 0)" hint="x runs from 0 to 1.">
          <input
            className="input-base font-mono"
            value={cfg.initialCondition}
            spellCheck={false}
            onChange={(e) => setFields({ initialCondition: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-1">
          {[
            { label: 'Pulse', e: 'exp(-140*(x-0.35)^2)' },
            { label: 'Half sine', e: 'sin(pi*x)' },
            { label: 'Two humps', e: 'sin(2*pi*x)' },
            { label: 'Step', e: 'step(x - 0.5) - 0.5' },
            { label: 'Triangle', e: 'tri(4*(x-0.5))' },
            { label: 'Noise-free comb', e: 'sin(6*pi*x)*exp(-8*(x-0.5)^2)' },
          ].map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setFields({ initialCondition: p.e })}
              className="rounded border border-edge px-1 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
            >
              {p.label}
            </button>
          ))}
        </div>

        {isWave && (
          <Field label="Initial velocity ∂u/∂t (x, 0)">
            <input
              className="input-base font-mono"
              value={cfg.initialVelocity}
              spellCheck={false}
              onChange={(e) => setFields({ initialVelocity: e.target.value })}
            />
          </Field>
        )}

        <Field label="Boundary condition">
          <Select
            value={cfg.boundary}
            onChange={(boundary) => setFields({ boundary })}
            options={[
              { value: 'dirichlet', label: 'Fixed ends (Dirichlet, u = 0)' },
              { value: 'neumann', label: 'Insulated / free ends (Neumann)' },
              { value: 'periodic', label: 'Periodic — the ends are joined' },
            ]}
          />
        </Field>
      </Collapsible>

      <Collapsible title="Discretisation">
        <Row>
          <div className="flex-1">
            <span className="field-label">Grid points</span>
            <NumberField
              value={cfg.nodes}
              min={16}
              max={1200}
              step={20}
              onChange={(nodes) => setFields({ nodes: Math.round(nodes) })}
            />
          </div>
          <div className="flex-1">
            <span className="field-label">Frames</span>
            <NumberField
              value={cfg.pdeFrames}
              min={10}
              max={600}
              step={10}
              onChange={(pdeFrames) => setFields({ pdeFrames: Math.round(pdeFrames) })}
            />
          </div>
        </Row>
        <Field label="Simulated duration">
          <NumberField
            value={cfg.pdeDuration}
            min={0.01}
            step={0.5}
            onChange={(pdeDuration) => setFields({ pdeDuration })}
          />
        </Field>
        <Callout>
          The solver takes as many internal substeps per frame as stability requires — the CFL condition —
          so the frame rate and the accuracy are independent. That is why you can ask for a long duration in
          a few frames without the solution exploding.
        </Callout>
      </Collapsible>
    </>
  );
}

/* ------------------------------------------------------------------ surface */

export function FieldsSurface({ tab }: { tab: TabState }) {
  return tab.fields.view === 'vector' ? <VectorSurface tab={tab} /> : <PdeSurface tab={tab} />;
}

function VectorSurface({ tab }: { tab: TabState }) {
  const setViewport = useStore((s) => s.setViewport);
  const plotRef = usePlot2DRef();
  const cfg = tab.fields;
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);

  const field = useMemo(() => {
    const p = scope.compile2(cfg.p || '0', 'x', 'y');
    const q = scope.compile2(cfg.q || '0', 'x', 'y');
    const error = p.error ?? q.error;
    const fn = (x: number, y: number): [number, number] => [p.fn(x, y), q.fn(x, y)];
    return { fn, error };
  }, [scope, cfg.p, cfg.q]);

  /* Particles carry state between frames, so they live in a ref rather than in
   * the scene. They are reseeded whenever the field or the window changes,
   * because advecting old positions through a new field looks wrong. */
  const particlesRef = useRef<Particle[]>([]);
  const rngRef = useRef(new Rng('field'));
  const lastTimeRef = useRef(tab.timeline.t);
  const seedKey = `${cfg.p}|${cfg.q}|${cfg.particleCount}|${JSON.stringify(tab.viewport)}`;

  useEffect(() => {
    rngRef.current = new Rng('field');
    particlesRef.current = seedParticles(tab.viewport, Math.round(cfg.particleCount), () => rngRef.current.next());
    lastTimeRef.current = tab.timeline.t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  if (cfg.display === 'particles') {
    const dt = Math.max(0, Math.min(tab.timeline.t - lastTimeRef.current, 0.1)) * cfg.particleSpeed;
    lastTimeRef.current = tab.timeline.t;
    if (dt > 0 && !field.error) {
      advectParticles(particlesRef.current, field.fn, dt, tab.viewport, () => rngRef.current.next());
    }
  }

  const scene = useMemo<PlotScene>(() => {
    const layers: Layer[] = [];
    const v = tab.viewport;

    if (cfg.scalarOverlay !== 'none' && !field.error) {
      const overlay = buildScalarOverlay(field.fn, v, cfg.scalarOverlay);
      if (overlay) layers.push({ type: 'image', ...overlay, alpha: 0.75, smooth: true });
    }

    if (!field.error) {
      if (cfg.display === 'arrows') {
        const rows = Math.max(4, Math.round((cfg.arrowDensity * (v.yMax - v.yMin)) / (v.xMax - v.xMin)));
        const { arrows, maxSpeed } = arrowGrid(field.fn, {
          xMin: v.xMin,
          xMax: v.xMax,
          yMin: v.yMin,
          yMax: v.yMax,
          columns: Math.round(cfg.arrowDensity),
          rows,
          lengthMode: cfg.lengthMode,
        });
        layers.push({
          type: 'arrows',
          arrows,
          colour: (speed: number) => sequentialColour(0.25 + 0.75 * Math.min(1, speed / (maxSpeed || 1))),
          width: 1.35,
          headSize: 4,
        });
      } else if (cfg.display === 'streamlines') {
        for (const line of streamlineSet(field.fn, v, Math.round(cfg.streamlineCount))) {
          const xs: number[] = [];
          const ys: number[] = [];
          for (let i = 0; i < line.length; i += 2) {
            xs.push(line[i]);
            ys.push(line[i + 1]);
          }
          layers.push({ type: 'polyline', xs, ys, colour: '#a698f8', width: 1.2, alpha: 0.75 });
        }
      } else {
        // Trails are drawn as short polylines rather than points, which is what
        // gives the flow its sense of direction.
        for (const particle of particlesRef.current) {
          if (particle.trail.length < 4) continue;
          const xs: number[] = [];
          const ys: number[] = [];
          for (let i = 0; i < particle.trail.length; i += 2) {
            xs.push(particle.trail[i]);
            ys.push(particle.trail[i + 1]);
          }
          layers.push({ type: 'polyline', xs, ys, colour: '#c4b5fd', width: 1, alpha: 0.5 });
        }
        layers.push({
          type: 'points',
          xs: particlesRef.current.map((p) => p.x),
          ys: particlesRef.current.map((p) => p.y),
          colour: '#e6e9f2',
          radius: 1.1,
          alpha: 0.85,
        });
      }
    }

    return {
      viewport: v,
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: false,
      showAxes: tab.showAxes,
      xLabel: 'x',
      yLabel: 'y',
      caption: field.error ?? undefined,
    };
    // The particle positions change without any of these changing, so the
    // timeline value is included to force a repaint each frame.
  }, [cfg, field, tab.viewport, tab.showGrid, tab.showAxes, tab.timeline.t]);

  return (
    <Plot2D
      ref={plotRef}
      scene={scene}
      onViewportChange={setViewport}
      showCrosshair={tab.showCrosshair}
      readout={(x, y) => {
        if (field.error) return null;
        const [u, w] = field.fn(x, y);
        return `x ${fmt(x, 4)}   y ${fmt(y, 4)}\nF = (${fmt(u, 4)}, ${fmt(w, 4)})\n|F| ${fmt(Math.hypot(u, w), 4)}\n∇·F ${fmt(divergence(field.fn, x, y), 4)}\n∇×F ${fmt(curl(field.fn, x, y), 4)}`;
      }}
    />
  );
}

function buildScalarOverlay(
  f: (x: number, y: number) => [number, number],
  view: { xMin: number; xMax: number; yMin: number; yMax: number },
  kind: 'magnitude' | 'divergence' | 'curl',
): { image: ImageData; x0: number; y0: number; x1: number; y1: number } | null {
  if (typeof document === 'undefined') return null;
  const nx = 150;
  const ny = 100;
  const values = new Float64Array(nx * ny);
  let lo = Infinity;
  let hi = -Infinity;
  const dx = (view.xMax - view.xMin) / (nx - 1);
  const dy = (view.yMax - view.yMin) / (ny - 1);

  for (let j = 0; j < ny; j++) {
    const y = view.yMax - j * dy;
    for (let i = 0; i < nx; i++) {
      const x = view.xMin + i * dx;
      let value: number;
      if (kind === 'magnitude') {
        const [u, w] = f(x, y);
        value = Math.hypot(u, w);
      } else if (kind === 'divergence') {
        value = divergence(f, x, y);
      } else {
        value = curl(f, x, y);
      }
      values[j * nx + i] = value;
      if (Number.isFinite(value)) {
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return null;

  // Divergence and curl are signed, so their scale is centred on zero and uses
  // a diverging ramp; magnitude is non-negative and uses a sequential one.
  const signed = kind !== 'magnitude';
  const extent = Math.max(Math.abs(lo), Math.abs(hi));

  const image = new ImageData(nx, ny);
  for (let k = 0; k < nx * ny; k++) {
    const value = values[k];
    const t = signed ? 0.5 + value / (2 * extent) : (value - lo) / (hi - lo);
    const css = signed ? divergingColour(t) : sequentialColour(t);
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(css);
    const idx = k * 4;
    if (m) {
      image.data[idx] = Number(m[1]);
      image.data[idx + 1] = Number(m[2]);
      image.data[idx + 2] = Number(m[3]);
    }
    image.data[idx + 3] = Number.isFinite(value) ? 255 : 0;
  }
  return { image, x0: view.xMin, y0: view.yMin, x1: view.xMax, y1: view.yMax };
}

function PdeSurface({ tab }: { tab: TabState }) {
  const plotRef = usePlot2DRef();
  const cfg = tab.fields;
  const { scope } = useScope(tab.parameters, tab.expressions, 0);

  const solution = useMemo(() => {
    const initial = scope.compile1(cfg.initialCondition || '0', 'x');
    const velocity = scope.compile1(cfg.initialVelocity || '0', 'x');
    if (initial.error) return { error: initial.error, result: null };
    const result = solvePde1d({
      kind: cfg.view === 'wave1d' ? 'wave1d' : 'heat1d',
      coefficient: cfg.coefficient,
      length: 1,
      nodes: Math.max(16, Math.min(cfg.nodes, 1200)),
      frames: Math.max(2, Math.min(cfg.pdeFrames, 600)),
      duration: cfg.pdeDuration,
      boundary: cfg.boundary,
      initial: (x) => {
        const v = initial.fn(x);
        return Number.isFinite(v) ? v : 0;
      },
      ...(cfg.view === 'wave1d'
        ? {
            initialVelocity: (x: number) => {
              const v = velocity.fn(x);
              return Number.isFinite(v) ? v : 0;
            },
          }
        : {}),
    });
    return { error: null, result };
  }, [scope, cfg]);

  const scene = useMemo<PlotScene>(() => {
    const result = solution.result;
    if (!result) {
      return {
        viewport: { xMin: 0, xMax: 1, yMin: -1, yMax: 1 },
        layers: [],
        showGrid: true,
        showMinorGrid: false,
        showAxes: true,
        caption: solution.error ?? undefined,
      };
    }

    const phase = tab.timeline.tMax > 0 ? (tab.timeline.t / tab.timeline.tMax) % 1 : 0;
    const frame = Math.min(result.frameCount - 1, Math.max(0, Math.round(phase * (result.frameCount - 1))));

    let peak = 0;
    for (const v of result.frames) if (Math.abs(v) > peak) peak = Math.abs(v);
    peak = peak || 1;

    const xs = Array.from(result.x);
    const layers: Layer[] = [];

    // Ghosts of earlier frames give the animation a visible history, which is
    // what turns "a wiggling line" into "a wave travelling and reflecting".
    for (const back of [18, 12, 6]) {
      const ghost = frame - back;
      if (ghost < 0) continue;
      layers.push({
        type: 'polyline',
        xs,
        ys: Array.from(result.frames.slice(ghost * result.nodeCount, (ghost + 1) * result.nodeCount)),
        colour: WAVE,
        width: 1,
        alpha: 0.12 + (18 - back) * 0.012,
      });
    }

    const current = Array.from(result.frames.slice(frame * result.nodeCount, (frame + 1) * result.nodeCount));
    layers.push({ type: 'polyline', xs, ys: current, colour: WAVE, width: 2.4 });
    layers.push({
      type: 'band',
      xs,
      lower: current.map(() => 0),
      upper: current,
      colour: withAlpha(WAVE, 0.16),
    });
    layers.push({ type: 'hline', y: 0, colour: 'rgba(148,163,184,0.3)', style: 'solid', width: 1 });

    const energy = current.reduce((s, v) => s + v * v, 0) / result.nodeCount;

    return {
      viewport: { xMin: -0.02, xMax: 1.02, yMin: -peak * 1.15, yMax: peak * 1.15 },
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: false,
      showAxes: false,
      xLabel: 'x',
      yLabel: 'u',
      caption: `t = ${result.times[frame].toFixed(3)}  ·  frame ${frame + 1}/${result.frameCount}  ·  ${result.substeps} substep${result.substeps === 1 ? '' : 's'} per frame  ·  mean u² = ${fmt(energy, 4)}`,
    };
  }, [solution, tab.timeline.t, tab.timeline.tMax, tab.showGrid]);

  return <Plot2D ref={plotRef} scene={scene} staticView showCrosshair={false} />;
}

export function fieldsCsv(tab: TabState): string | null {
  const cfg = tab.fields;
  const scope = new EvalScope();
  for (const p of tab.parameters) scope.set(p.name, p.value);

  if (cfg.view === 'vector') {
    const p = scope.compile2(cfg.p || '0', 'x', 'y');
    const q = scope.compile2(cfg.q || '0', 'x', 'y');
    if (p.error || q.error) return null;
    const rows = ['x,y,P,Q,magnitude'];
    const n = 60;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const x = tab.viewport.xMin + ((tab.viewport.xMax - tab.viewport.xMin) * i) / n;
        const y = tab.viewport.yMin + ((tab.viewport.yMax - tab.viewport.yMin) * j) / n;
        const u = p.fn(x, y);
        const w = q.fn(x, y);
        rows.push(`${x},${y},${u},${w},${Math.hypot(u, w)}`);
      }
    }
    return rows.join('\n');
  }

  const initial = scope.compile1(cfg.initialCondition || '0', 'x');
  if (initial.error) return null;
  const result = solvePde1d({
    kind: cfg.view === 'wave1d' ? 'wave1d' : 'heat1d',
    coefficient: cfg.coefficient,
    length: 1,
    nodes: Math.min(cfg.nodes, 400),
    frames: Math.min(cfg.pdeFrames, 200),
    duration: cfg.pdeDuration,
    boundary: cfg.boundary,
    initial: (x) => initial.fn(x),
  });
  const rows = ['t,' + Array.from(result.x).map((x) => x.toFixed(6)).join(',')];
  for (let f = 0; f < result.frameCount; f++) {
    const slice = Array.from(result.frames.slice(f * result.nodeCount, (f + 1) * result.nodeCount));
    rows.push(`${result.times[f]},${slice.join(',')}`);
  }
  return rows.join('\n');
}
