import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../core/store';
import type { DynamicsConfig, TabState } from '../core/types';
import {
  MAPS,
  MAP_BY_ID,
  PALETTE_IDS,
  bifurcationColumns,
  cobweb,
  detectPeriod,
  lyapunovExponent,
  orbit,
  renderFractalRows,
  type FractalKind,
  type FractalOptions,
  type PaletteId,
} from '../core/math/fractals';
import { useElementSize } from '../hooks/useElementSize';
import { useProgressiveRender } from '../hooks/useProgressiveRender';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef, usePlotRef } from '../components/shell/PlotContext';
import { ViewPanel } from '../components/panels/ViewPanel';
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
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';

const CURVE = '#8b7cf6';
const WEB = '#fbbf24';
const DIAGONAL = 'rgba(148,163,184,0.45)';

/* ------------------------------------------------------------------ panel */

export function DynamicsPanel({ tab }: { tab: TabState }) {
  const setDynamics = useStore((s) => s.setDynamics);
  const cfg = tab.dynamics;

  return (
    <>
      <Collapsible title="Mode">
        <SegmentedControl
          value={cfg.view}
          onChange={(view) => setDynamics({ view })}
          options={[
            { value: 'orbit', label: 'Cobweb', title: 'Iterate a map and watch the orbit' },
            { value: 'bifurcation', label: 'Bifurcation', title: 'The orbit diagram over a parameter range' },
            { value: 'fractal', label: 'Fractal', title: 'Escape-time sets in the complex plane' },
          ]}
        />
      </Collapsible>

      {cfg.view !== 'fractal' ? <MapPanel cfg={cfg} /> : <FractalPanel cfg={cfg} />}
      {cfg.view === 'orbit' && <ViewPanel tab={tab} />}
    </>
  );
}

function MapPanel({ cfg }: { cfg: DynamicsConfig }) {
  const setDynamics = useStore((s) => s.setDynamics);
  const spec = MAP_BY_ID.get(cfg.mapId) ?? MAPS[0];

  const diagnostics = useMemo(() => {
    const values = orbit(spec.f, cfg.r, cfg.x0, cfg.transient, 400);
    return {
      period: detectPeriod(values, 1e-7),
      lyapunov: lyapunovExponent(spec.f, cfg.r, cfg.x0),
      last: values.length ? values[values.length - 1] : NaN,
    };
  }, [spec, cfg.r, cfg.x0, cfg.transient]);

  return (
    <>
      <Collapsible title="Map">
        <Select
          value={cfg.mapId}
          onChange={(mapId) => {
            const next = MAP_BY_ID.get(mapId);
            setDynamics(
              next
                ? {
                    mapId,
                    r: next.rDefault,
                    x0: next.x0,
                    bifurcationRMin: next.rMin,
                    bifurcationRMax: next.rMax,
                  }
                : { mapId },
            );
          }}
          options={MAPS.map((m) => ({ value: m.id, label: m.name }))}
        />
        <div className="overflow-x-auto rounded-md border border-edge bg-surface-1 px-2.5 py-2 text-center">
          <Formula latex={spec.latex} display />
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <span className="field-label">Parameter r</span>
            <span className="font-mono text-2xs tabular-nums text-ink">{cfg.r.toFixed(5)}</span>
          </div>
          <Slider
            value={cfg.r}
            min={spec.rMin}
            max={spec.rMax}
            step={(spec.rMax - spec.rMin) / 4000}
            onChange={(r) => setDynamics({ r })}
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <span className="field-label">Starting point x₀</span>
            <span className="font-mono text-2xs tabular-nums text-ink">{cfg.x0.toFixed(5)}</span>
          </div>
          <Slider
            value={cfg.x0}
            min={spec.domain[0]}
            max={spec.domain[1]}
            step={(spec.domain[1] - spec.domain[0]) / 1000}
            onChange={(x0) => setDynamics({ x0 })}
          />
        </div>

        {cfg.view === 'orbit' && (
          <Field label="Iterations drawn">
            <NumberField
              value={cfg.cobwebSteps}
              min={1}
              max={2000}
              step={10}
              onChange={(cobwebSteps) => setDynamics({ cobwebSteps: Math.round(cobwebSteps) })}
            />
          </Field>
        )}
      </Collapsible>

      <Collapsible title="Behaviour">
        <StatList>
          <Stat
            label="Period"
            value={diagnostics.period ? String(diagnostics.period) : 'aperiodic'}
            emphasis
            hint="Length of the repeating cycle, if there is one"
          />
          <Stat label="Lyapunov exponent" value={fmt(diagnostics.lyapunov, 6)} />
          <Stat label="Last value" value={fmt(diagnostics.last, 8)} />
        </StatList>
        <Callout kind={diagnostics.lyapunov > 0 ? 'warn' : 'info'}>
          {diagnostics.lyapunov > 0
            ? 'A positive Lyapunov exponent means nearby starting points separate exponentially: this is chaos. Two orbits differing in the twelfth decimal place become completely different within a few dozen steps.'
            : diagnostics.period
              ? `The orbit settles into a cycle of period ${diagnostics.period}. Nearby starting points converge onto the same cycle.`
              : 'The orbit is contracting, so it converges regardless of where it starts.'}
        </Callout>
      </Collapsible>

      {cfg.view === 'bifurcation' && (
        <Collapsible title="Diagram">
          <Row>
            <div className="flex-1">
              <span className="field-label">r from</span>
              <NumberField
                value={cfg.bifurcationRMin}
                step={0.05}
                onChange={(bifurcationRMin) => setDynamics({ bifurcationRMin })}
              />
            </div>
            <div className="flex-1">
              <span className="field-label">to</span>
              <NumberField
                value={cfg.bifurcationRMax}
                step={0.05}
                onChange={(bifurcationRMax) => setDynamics({ bifurcationRMax })}
              />
            </div>
          </Row>
          <Row>
            <div className="flex-1">
              <span className="field-label">Transient</span>
              <NumberField
                value={cfg.transient}
                min={0}
                max={20000}
                step={100}
                onChange={(transient) => setDynamics({ transient: Math.round(transient) })}
              />
            </div>
            <div className="flex-1">
              <span className="field-label">Samples</span>
              <NumberField
                value={cfg.samples}
                min={10}
                max={2000}
                step={20}
                onChange={(samples) => setDynamics({ samples: Math.round(samples) })}
              />
            </div>
          </Row>
          <Toggle
            label="Lyapunov exponent strip"
            hint="Drawn under the diagram. It crosses zero exactly where chaos begins."
            checked={cfg.showLyapunov}
            onChange={(showLyapunov) => setDynamics({ showLyapunov })}
          />
          <Row>
            <Button
              className="flex-1"
              onClick={() => setDynamics({ bifurcationRMin: 3.4, bifurcationRMax: 3.6 })}
            >
              Zoom to cascade
            </Button>
            <Button
              className="flex-1"
              onClick={() => setDynamics({ bifurcationRMin: MAP_BY_ID.get(cfg.mapId)?.rMin ?? 2.4, bifurcationRMax: MAP_BY_ID.get(cfg.mapId)?.rMax ?? 4 })}
            >
              Full range
            </Button>
          </Row>
          <Callout>
            Each vertical slice is the long-run orbit for one value of r. One line means a fixed point, two
            means a 2-cycle, and the smear is chaos — with periodic windows visible inside it.
          </Callout>
        </Collapsible>
      )}
    </>
  );
}

function FractalPanel({ cfg }: { cfg: DynamicsConfig }) {
  const setDynamics = useStore((s) => s.setDynamics);
  return (
    <>
      <Collapsible title="Set">
        <Select
          value={cfg.fractalKind}
          onChange={(fractalKind) => setDynamics({ fractalKind })}
          options={[
            { value: 'mandelbrot', label: 'Mandelbrot' },
            { value: 'julia', label: 'Julia' },
            { value: 'burningship', label: 'Burning ship' },
            { value: 'tricorn', label: 'Tricorn' },
            { value: 'multibrot', label: 'Multibrot' },
          ]}
        />
        <Formula
          latex={
            cfg.fractalKind === 'julia'
              ? 'z_{n+1} = z_n^2 + c,\\quad z_0 = \\text{pixel}'
              : cfg.fractalKind === 'multibrot'
                ? `z_{n+1} = z_n^{${Math.round(cfg.power)}} + c`
                : 'z_{n+1} = z_n^2 + c,\\quad z_0 = 0'
          }
          className="block text-center text-xs text-ink-dim"
        />

        {cfg.fractalKind === 'julia' && (
          <>
            <div>
              <div className="flex items-baseline justify-between">
                <span className="field-label">Re(c)</span>
                <span className="font-mono text-2xs text-ink">{cfg.juliaRe.toFixed(5)}</span>
              </div>
              <Slider value={cfg.juliaRe} min={-2} max={2} step={0.0005} onChange={(juliaRe) => setDynamics({ juliaRe })} />
            </div>
            <div>
              <div className="flex items-baseline justify-between">
                <span className="field-label">Im(c)</span>
                <span className="font-mono text-2xs text-ink">{cfg.juliaIm.toFixed(5)}</span>
              </div>
              <Slider value={cfg.juliaIm} min={-2} max={2} step={0.0005} onChange={(juliaIm) => setDynamics({ juliaIm })} />
            </div>
            <div className="grid grid-cols-2 gap-1">
              {[
                { label: 'Dendrite', re: 0, im: 1 },
                { label: 'Rabbit', re: -0.123, im: 0.745 },
                { label: 'Siegel disc', re: -0.391, im: -0.587 },
                { label: 'San Marco', re: -0.75, im: 0 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setDynamics({ juliaRe: p.re, juliaIm: p.im })}
                  className="rounded border border-edge px-1 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </>
        )}

        {cfg.fractalKind === 'multibrot' && (
          <Field label="Exponent">
            <NumberField
              value={cfg.power}
              min={2}
              max={12}
              step={1}
              onChange={(power) => setDynamics({ power: Math.round(power) })}
            />
          </Field>
        )}

        <div>
          <div className="flex items-baseline justify-between">
            <span className="field-label">Maximum iterations</span>
            <span className="font-mono text-2xs text-ink">{cfg.maxIterations}</span>
          </div>
          <Slider
            value={cfg.maxIterations}
            min={40}
            max={3000}
            step={20}
            onChange={(maxIterations) => setDynamics({ maxIterations: Math.round(maxIterations) })}
          />
          <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
            Raise this as you zoom: the boundary only reveals more structure when the iteration budget can
            resolve it.
          </p>
        </div>
      </Collapsible>

      <Collapsible title="Colour">
        <Field label="Palette">
          <Select
            value={cfg.palette}
            onChange={(palette) => setDynamics({ palette })}
            options={PALETTE_IDS.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
          />
        </Field>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="field-label">Cycle length</span>
            <span className="font-mono text-2xs text-ink">{Math.round(cfg.colourPeriod)}</span>
          </div>
          <Slider
            value={cfg.colourPeriod}
            min={4}
            max={400}
            step={1}
            onChange={(colourPeriod) => setDynamics({ colourPeriod })}
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="field-label">Offset</span>
            <span className="font-mono text-2xs text-ink">{cfg.colourOffset.toFixed(2)}</span>
          </div>
          <Slider value={cfg.colourOffset} min={0} max={1} step={0.005} onChange={(colourOffset) => setDynamics({ colourOffset })} />
        </div>
        <Field label="Interior">
          <Select
            value={cfg.interior}
            onChange={(interior) => setDynamics({ interior })}
            options={[
              { value: 'black', label: 'Solid' },
              { value: 'trap', label: 'Orbit-trap shading' },
            ]}
          />
        </Field>
      </Collapsible>

      <Collapsible title="Position">
        <Row>
          <div className="flex-1">
            <span className="field-label">Centre Re</span>
            <NumberField
              value={cfg.fractalCentreX}
              step={0.05}
              precision={12}
              onChange={(fractalCentreX) => setDynamics({ fractalCentreX })}
            />
          </div>
          <div className="flex-1">
            <span className="field-label">Centre Im</span>
            <NumberField
              value={cfg.fractalCentreY}
              step={0.05}
              precision={12}
              onChange={(fractalCentreY) => setDynamics({ fractalCentreY })}
            />
          </div>
        </Row>
        <Field label="Half-width" hint="Scroll on the image to zoom; drag to pan.">
          <NumberField
            value={cfg.fractalScale}
            min={1e-13}
            step={0.1}
            precision={12}
            onChange={(fractalScale) => setDynamics({ fractalScale })}
          />
        </Field>
        <Button
          onClick={() => setDynamics({ fractalCentreX: -0.6, fractalCentreY: 0, fractalScale: 1.6, maxIterations: 320 })}
        >
          Reset view
        </Button>
        <Callout>
          Zoom depth is limited by double precision: below a half-width of about 1e−13 the pixels start to
          collide and the image goes blocky. That is arithmetic, not the renderer.
        </Callout>
      </Collapsible>
    </>
  );
}

/* ------------------------------------------------------------------ surface */

export function DynamicsSurface({ tab }: { tab: TabState }) {
  const cfg = tab.dynamics;
  if (cfg.view === 'fractal') return <FractalSurface tab={tab} />;
  if (cfg.view === 'bifurcation') return <BifurcationSurface tab={tab} />;
  return <CobwebSurface tab={tab} />;
}

function CobwebSurface({ tab }: { tab: TabState }) {
  const setViewport = useStore((s) => s.setViewport);
  const plotRef = usePlot2DRef();
  const cfg = tab.dynamics;
  const spec = MAP_BY_ID.get(cfg.mapId) ?? MAPS[0];

  const scene = useMemo<PlotScene>(() => {
    const [lo, hi] = spec.domain;
    const steps = tab.timeline.playing
      ? Math.max(1, Math.round((tab.timeline.t / Math.max(tab.timeline.tMax, 1e-9)) * cfg.cobwebSteps) % (cfg.cobwebSteps + 1))
      : cfg.cobwebSteps;

    const xs: number[] = [];
    const ys: number[] = [];
    const n = 600;
    for (let i = 0; i <= n; i++) {
      const x = lo + ((hi - lo) * i) / n;
      xs.push(x);
      ys.push(spec.f(x, cfg.r));
    }

    const web = cobweb(spec.f, cfg.r, cfg.x0, steps);
    const webX: number[] = [];
    const webY: number[] = [];
    for (let i = 0; i < web.length; i += 2) {
      webX.push(web[i]);
      webY.push(web[i + 1]);
    }

    const trajectory = orbit(spec.f, cfg.r, cfg.x0, 0, Math.max(2, steps));
    const period = detectPeriod(orbit(spec.f, cfg.r, cfg.x0, cfg.transient, 400), 1e-7);

    const layers: Layer[] = [
      { type: 'polyline', xs: [lo, hi], ys: [lo, hi], colour: DIAGONAL, width: 1.2, style: 'dashed' },
      { type: 'polyline', xs, ys, colour: CURVE, width: 2.2 },
      { type: 'polyline', xs: webX, ys: webY, colour: WEB, width: 1.3, alpha: 0.9 },
      { type: 'points', xs: [cfg.x0], ys: [0], colour: WEB, radius: 4, shape: 'ring', stroke: WEB },
    ];

    // Fixed points are where the curve meets the diagonal; marking them makes
    // the cobweb's destination obvious before it gets there.
    for (let i = 0; i < n; i++) {
      const x0 = lo + ((hi - lo) * i) / n;
      const x1 = lo + ((hi - lo) * (i + 1)) / n;
      const g0 = spec.f(x0, cfg.r) - x0;
      const g1 = spec.f(x1, cfg.r) - x1;
      if (Number.isFinite(g0) && Number.isFinite(g1) && g0 * g1 < 0) {
        const t = g0 / (g0 - g1);
        const root = x0 + t * (x1 - x0);
        const slope = (spec.f(root + 1e-6, cfg.r) - spec.f(root - 1e-6, cfg.r)) / 2e-6;
        layers.push({
          type: 'marker',
          x: root,
          y: root,
          label: `${Math.abs(slope) < 1 ? 'stable' : 'unstable'} |f′| = ${fmt(Math.abs(slope), 3)}`,
          colour: Math.abs(slope) < 1 ? '#34d399' : '#fb7185',
          radius: 4,
        });
      }
    }

    return {
      viewport: tab.viewport,
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: tab.showMinorGrid,
      showAxes: tab.showAxes,
      xLabel: 'xₙ',
      yLabel: 'xₙ₊₁',
      caption: `r = ${cfg.r.toFixed(5)}  ·  ${steps} iterations  ·  ${period ? `period ${period}` : 'aperiodic'}  ·  final x ≈ ${fmt(trajectory[trajectory.length - 1] ?? NaN, 6)}`,
    };
  }, [cfg, spec, tab.viewport, tab.showGrid, tab.showMinorGrid, tab.showAxes, tab.timeline.t, tab.timeline.tMax, tab.timeline.playing]);

  return <Plot2D ref={plotRef} scene={scene} onViewportChange={setViewport} showCrosshair={tab.showCrosshair} />;
}

function BifurcationSurface({ tab }: { tab: TabState }) {
  const plotRef = usePlot2DRef();
  const setDynamics = useStore((s) => s.setDynamics);
  const cfg = tab.dynamics;
  const spec = MAP_BY_ID.get(cfg.mapId) ?? MAPS[0];

  const COLS = 900;
  const ROWS = 560;
  const [lo, hi] = spec.domain;

  const buffers = useMemo(
    () => ({ density: new Float32Array(COLS * ROWS), image: new ImageData(COLS, ROWS), max: 1 }),
    // A new buffer per configuration; the old one is garbage as soon as any
    // parameter changes, so reusing it would only show a stale picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg.mapId, cfg.bifurcationRMin, cfg.bifurcationRMax, cfg.transient, cfg.samples, cfg.x0],
  );

  const key = `${cfg.mapId}|${cfg.bifurcationRMin}|${cfg.bifurcationRMax}|${cfg.transient}|${cfg.samples}|${cfg.x0}`;

  const progress = useProgressiveRender({
    key,
    total: COLS,
    budgetMs: 9,
    initialChunk: 6,
    step: (from, to) => {
      const max = bifurcationColumns(
        buffers.density,
        {
          map: spec.f,
          rMin: cfg.bifurcationRMin,
          rMax: cfg.bifurcationRMax,
          columns: COLS,
          rows: ROWS,
          transient: cfg.transient,
          samples: cfg.samples,
          x0: cfg.x0,
          yMin: lo,
          yMax: hi,
        },
        from,
        to,
      );
      if (max > buffers.max) buffers.max = max;
      paintDensity(buffers.image, buffers.density, buffers.max, from, to, COLS);
    },
  });

  const lyapunov = useMemo(() => {
    if (!cfg.showLyapunov) return null;
    const xs: number[] = [];
    const ys: number[] = [];
    const n = 420;
    for (let i = 0; i <= n; i++) {
      const r = cfg.bifurcationRMin + ((cfg.bifurcationRMax - cfg.bifurcationRMin) * i) / n;
      const l = lyapunovExponent(spec.f, r, cfg.x0, 300, 1200);
      xs.push(r);
      ys.push(Number.isFinite(l) ? Math.max(-4, Math.min(2, l)) : NaN);
    }
    return { xs, ys };
  }, [cfg.showLyapunov, cfg.bifurcationRMin, cfg.bifurcationRMax, cfg.x0, spec]);

  const scene = useMemo<PlotScene>(
    () => ({
      viewport: { xMin: cfg.bifurcationRMin, xMax: cfg.bifurcationRMax, yMin: lo, yMax: hi },
      layers: [
        {
          type: 'image',
          image: buffers.image,
          x0: cfg.bifurcationRMin,
          y0: lo,
          x1: cfg.bifurcationRMax,
          y1: hi,
          smooth: false,
        },
        { type: 'vline', x: cfg.r, colour: withAlpha(WEB, 0.85), width: 1.4, label: `r = ${cfg.r.toFixed(4)}` },
      ],
      showGrid: false,
      showMinorGrid: false,
      showAxes: false,
      xLabel: 'r',
      yLabel: 'long-run x',
      caption: progress.done ? undefined : `computing… ${(progress.progress * 100).toFixed(0)}%`,
    }),
    // `progress.version` is what makes the partially-filled buffer repaint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg.bifurcationRMin, cfg.bifurcationRMax, cfg.r, lo, hi, progress.version, progress.done, buffers],
  );

  const lyapunovScene = useMemo<PlotScene | null>(() => {
    if (!lyapunov) return null;
    return {
      viewport: { xMin: cfg.bifurcationRMin, xMax: cfg.bifurcationRMax, yMin: -2.2, yMax: 1.2 },
      layers: [
        { type: 'hline', y: 0, colour: 'rgba(251,113,133,0.6)', style: 'dashed', width: 1.2 },
        { type: 'polyline', xs: lyapunov.xs, ys: lyapunov.ys, colour: '#38bdf8', width: 1.4 },
        { type: 'vline', x: cfg.r, colour: withAlpha(WEB, 0.85), width: 1.2 },
      ],
      showGrid: true,
      showMinorGrid: false,
      showAxes: false,
      xLabel: 'r',
      yLabel: 'λ',
      caption: 'λ > 0 is chaos',
    };
  }, [lyapunov, cfg.bifurcationRMin, cfg.bifurcationRMax, cfg.r]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-[3]">
        <Plot2D
          ref={plotRef}
          scene={scene}
          staticView
          showCrosshair={false}
          onDoubleClick={(e) => setDynamics({ r: e.x, view: 'orbit' })}
          readout={(x, y) => `r ${x.toFixed(6)}   x ${y.toFixed(6)}`}
        />
      </div>
      {lyapunovScene && (
        <div className="min-h-0 flex-1 border-t border-edge">
          <Plot2D scene={lyapunovScene} staticView showCrosshair={false} />
        </div>
      )}
    </div>
  );
}

/** Log-scaled density into the image buffer: a linear ramp makes the chaotic
 *  region a uniform blur, while a log ramp keeps its internal structure. */
function paintDensity(
  image: ImageData,
  density: Float32Array,
  max: number,
  colFrom: number,
  colTo: number,
  cols: number,
): void {
  const rows = image.height;
  const logMax = Math.log1p(max);
  for (let row = 0; row < rows; row++) {
    for (let c = colFrom; c < colTo; c++) {
      const value = density[row * cols + c];
      const t = value > 0 ? Math.log1p(value) / logMax : 0;
      const k = (row * cols + c) * 4;
      const shade = Math.pow(t, 0.6);
      // Density zero has to land exactly on the plot background, or the
      // rendered region shows up as a visible rectangle against the part that
      // has not been computed yet.
      image.data[k] = Math.round(17 + shade * 182);
      image.data[k + 1] = Math.round(20 + shade * 160);
      image.data[k + 2] = Math.round(27 + shade * 228);
      image.data[k + 3] = 255;
    }
  }
}

function FractalSurface({ tab }: { tab: TabState }) {
  const setDynamics = useStore((s) => s.setDynamics);
  const plotRef = usePlotRef();
  const cfg = tab.dynamics;
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<{ re: number; im: number } | null>(null);

  // A modest fixed resolution keeps the render time predictable regardless of
  // window size; the canvas is then scaled up, which at these iteration counts
  // is a much better trade than a 4K render nobody waits for.
  const width = Math.max(320, Math.min(size.width, 1280));
  const height = Math.max(200, Math.min(size.height, 860));

  const buffer = useMemo(
    () => ({ pixels: new Uint8ClampedArray(width * height * 4), image: new ImageData(width, height) }),
    [width, height],
  );

  const options = useMemo<FractalOptions>(
    () => ({
      kind: cfg.fractalKind as FractalKind,
      maxIterations: cfg.maxIterations,
      juliaRe: cfg.juliaRe,
      juliaIm: cfg.juliaIm,
      power: cfg.power,
      colourPeriod: cfg.colourPeriod,
      colourOffset: cfg.colourOffset,
      palette: cfg.palette as PaletteId,
      interior: cfg.interior,
    }),
    [cfg],
  );

  const view = useMemo(
    () => ({
      centreX: cfg.fractalCentreX,
      centreY: cfg.fractalCentreY,
      scale: cfg.fractalScale,
      width,
      height,
    }),
    [cfg.fractalCentreX, cfg.fractalCentreY, cfg.fractalScale, width, height],
  );

  const key = `${width}x${height}|${JSON.stringify(options)}|${view.centreX}|${view.centreY}|${view.scale}`;

  const progress = useProgressiveRender({
    key,
    total: height,
    budgetMs: 11,
    initialChunk: 4,
    step: (from, to) => {
      renderFractalRows(buffer.image.data, view, options, from, to);
    },
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.getContext('2d')?.putImageData(buffer.image, 0, 0);
  }, [progress.version, buffer, width, height]);

  // ---- gestures in complex coordinates
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const toComplex = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const u = (clientX - rect.left) / rect.width;
    const v = (clientY - rect.top) / rect.height;
    const aspect = height / width;
    return {
      re: view.centreX + (u * 2 - 1) * view.scale,
      im: view.centreY - (v * 2 - 1) * view.scale * aspect,
    };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toComplex(e.clientX, e.clientY);
      if (!p) return;
      const factor = Math.exp(e.deltaY * 0.0018);
      const nextScale = Math.max(1e-14, Math.min(4, cfg.fractalScale * factor));
      // Zoom about the pointer rather than the centre, which is what makes
      // hunting for detail at the boundary bearable.
      setDynamics({
        fractalScale: nextScale,
        fractalCentreX: p.re + (cfg.fractalCentreX - p.re) * (nextScale / cfg.fractalScale),
        fractalCentreY: p.im + (cfg.fractalCentreY - p.im) * (nextScale / cfg.fractalScale),
      });
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [cfg.fractalScale, cfg.fractalCentreX, cfg.fractalCentreY, setDynamics, view, width, height]);

  useEffect(() => {
    if (plotRef) {
      plotRef.current = {
        toDataUrl: () => canvasRef.current?.toDataURL('image/png') ?? '',
      };
    }
  }, [plotRef]);

  const zoomDepth = Math.log10(1.6 / Math.max(cfg.fractalScale, 1e-15));

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-surface-0">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-crosshair touch-none"
        style={{ imageRendering: progress.done ? 'auto' : 'pixelated' }}
        onPointerDown={(e) => {
          const p = toComplex(e.clientX, e.clientY);
          if (!p) return;
          dragRef.current = { x: e.clientX, y: e.clientY, cx: cfg.fractalCentreX, cy: cfg.fractalCentreY };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = toComplex(e.clientX, e.clientY);
          if (p) setHover(p);
          const drag = dragRef.current;
          if (!drag) return;
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const dx = ((e.clientX - drag.x) / rect.width) * 2 * view.scale;
          const dy = ((e.clientY - drag.y) / rect.height) * 2 * view.scale * (height / width);
          setDynamics({ fractalCentreX: drag.cx - dx, fractalCentreY: drag.cy + dy });
        }}
        onPointerUp={(e) => {
          dragRef.current = null;
          try {
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
          } catch {
            /* already released */
          }
        }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(e) => {
          // Double-clicking the Mandelbrot picks the Julia parameter at that
          // point, which is the single most illuminating link between the two.
          const p = toComplex(e.clientX, e.clientY);
          if (p && cfg.fractalKind !== 'julia') {
            setDynamics({ fractalKind: 'julia', juliaRe: p.re, juliaIm: p.im, fractalCentreX: 0, fractalCentreY: 0, fractalScale: 1.6 });
          }
        }}
      />

      {!progress.done && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-edge bg-surface-0/85 px-2 py-1 font-mono text-2xs text-ink-dim">
          {(progress.progress * 100).toFixed(0)}%
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 right-3 whitespace-pre-line rounded-md border border-edge bg-surface-0/90 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-ink-dim">
        {hover ? `${hover.re.toFixed(12)}\n${hover.im >= 0 ? '+' : '−'}${Math.abs(hover.im).toFixed(12)}i\n` : ''}
        {`zoom 10^${zoomDepth.toFixed(1)}  ·  ${cfg.maxIterations} iterations`}
        {cfg.fractalKind !== 'julia' && '\ndouble-click for the Julia set here'}
      </div>
    </div>
  );
}

export function dynamicsCsv(tab: TabState): string | null {
  const cfg = tab.dynamics;
  if (cfg.view === 'fractal') return null;
  const spec = MAP_BY_ID.get(cfg.mapId) ?? MAPS[0];

  if (cfg.view === 'orbit') {
    const values = orbit(spec.f, cfg.r, cfg.x0, 0, Math.max(2, cfg.cobwebSteps));
    return ['n,x', ...Array.from(values).map((v, i) => `${i + 1},${v}`)].join('\n');
  }

  const rows = ['r,lyapunov,period'];
  const n = 600;
  for (let i = 0; i <= n; i++) {
    const r = cfg.bifurcationRMin + ((cfg.bifurcationRMax - cfg.bifurcationRMin) * i) / n;
    const l = lyapunovExponent(spec.f, r, cfg.x0, 400, 2000);
    const period = detectPeriod(orbit(spec.f, r, cfg.x0, 2000, 200), 1e-7);
    rows.push(`${r},${l},${period}`);
  }
  return rows.join('\n');
}
