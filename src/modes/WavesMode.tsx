import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import { SERIES_COLOURS, type TabState } from '../core/types';
import {
  MEDIA,
  MEDIUM_BY_ID,
  advanceWaveField,
  axisCrossings,
  brewsterAngle,
  createWaveField,
  criticalAngle,
  diffractionPattern,
  fraunhoferPattern,
  groupVelocity,
  lensmaker,
  modeFrequencies,
  reflectionCoefficient,
  thinLensImage,
  traceRays,
  transmissionCoefficient,
  type Slit,
  type Surface,
  type WaveField,
  type WaveWorld,
} from '../core/physics/waves';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { ProbePlot, type Trace } from '../components/sandbox/ProbePlot';
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
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* Waves and optics.
 *
 * Three views over one idea. A wave on a medium, where reflection and standing
 * waves come out of integrating the wave equation rather than being drawn on.
 * Diffraction through whatever aperture is on the bench, computed by summing
 * over it — so an aperture with no formula still gives the right pattern, and
 * the formulae that do exist appear as limits. And rays through real surfaces,
 * refracted by Snell exactly, so a lens has aberration and a steep enough face
 * traps the light.
 */

const VIEWS = [
  { value: 'propagate' as const, label: 'Waves', title: 'A wave on a medium, with real ends and real reflections.' },
  { value: 'diffract' as const, label: 'Slits', title: 'The pattern from any aperture, by summing over it.' },
  { value: 'rays' as const, label: 'Optics', title: 'Rays through lenses and surfaces, refracted exactly.' },
];

const BOUNDARY_OPTIONS = [
  { value: 'fixed' as const, label: 'Fixed', title: 'Clamped: the reflection comes back inverted.' },
  { value: 'free' as const, label: 'Free', title: 'A ring on a frictionless pole: the reflection comes back upright.' },
  { value: 'absorbing' as const, label: 'Open', title: 'The wave leaves and does not come back.' },
];

// ------------------------------------------------------------------ solving

interface Solution {
  field: WaveField | null;
}

function useField(world: WaveWorld, until: number): WaveField | null {
  const key = useMemo(() => JSON.stringify(world), [world]);
  const cache = useRef<{ key: string; value: Solution } | null>(null);
  const [, bump] = useState(0);

  if (!cache.current || cache.current.key !== key) {
    cache.current = { key, value: { field: world.view === 'propagate' ? createWaveField(world) : null } };
  }
  const field = cache.current.value.field;

  useEffect(() => {
    if (!field) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || !field) return;
      const done = advanceWaveField(field, until, 6000);
      bump((n) => n + 1);
      if (!done) requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [field, until]);

  return field;
}

// ------------------------------------------------------------------ drawing

function waveScene(tab: TabState, field: WaveField | null): PlotScene {
  const cfg = tab.waves;
  const world = cfg.world;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];

  if (field && field.count) {
    const frame = Math.min(
      field.count - 1,
      Math.max(0, Math.round(tab.timeline.t / (field.dt * field.decimation))),
    );
    const ys = field.frames.subarray(frame * field.n, (frame + 1) * field.n);
    layers.push({
      type: 'curve',
      segments: [{ xs: field.x, ys: Float64Array.from(ys), length: field.n }],
      colour: SERIES_COLOURS[0],
      width: 2,
    });
    legend.push({ label: 'displacement', colour: SERIES_COLOURS[0] });

    if (world.junction > 0) {
      layers.push({
        type: 'vline',
        x: world.junction * world.length,
        colour: withAlpha('#f59e0b', 0.7),
        style: 'dashed',
        width: 1.4,
        label: 'medium changes',
      });
    }
    // The ends, drawn as what they are.
    for (const [x, kind] of [
      [0, world.left],
      [world.length, world.right],
    ] as [number, string][]) {
      layers.push({
        type: 'points',
        xs: [x],
        ys: [0],
        colour: kind === 'fixed' ? '#94a3b8' : kind === 'free' ? '#4ade80' : '#64748b',
        radius: kind === 'fixed' ? 5 : 4,
        shape: kind === 'free' ? 'circle' : 'square',
        stroke: '#0b0e14',
      });
    }
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'x (m)',
    yLabel: 'displacement',
    legend,
  };
}

function diffractionScene(tab: TabState): PlotScene {
  const cfg = tab.waves;
  const world = cfg.world;
  const result = diffractionPattern(world, 900);
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];

  const toMm = Float64Array.from(result.x, (v) => v * 1000);
  const shown = cfg.logIntensity
    ? Float64Array.from(result.intensity, (v) => Math.max(-6, Math.log10(Math.max(1e-12, v))))
    : result.intensity;

  layers.push({
    type: 'area',
    segments: [{ xs: toMm, ys: shown, length: shown.length }],
    baseline: cfg.logIntensity ? -6 : 0,
    colour: withAlpha(SERIES_COLOURS[0], 0.25),
  });
  layers.push({
    type: 'curve',
    segments: [{ xs: toMm, ys: shown, length: shown.length }],
    colour: SERIES_COLOURS[0],
    width: 2,
  });
  legend.push({ label: 'computed', colour: SERIES_COLOURS[0] });

  // The textbook curve, where one applies — drawn dashed, never used.
  const identical = world.slits.length > 0 && world.slits.every((s) => Math.abs(s.width - world.slits[0].width) < 1e-9 && s.phase === 0);
  if (cfg.showAnalytic && identical && world.sourceDistance <= 0) {
    const spacing = world.slits.length > 1 ? Math.abs(world.slits[1].centre - world.slits[0].centre) : 0;
    const ys = Float64Array.from(result.angle, (a) =>
      fraunhoferPattern(a, world.wavelength, world.slits[0].width, spacing, world.slits.length),
    );
    const scaled = cfg.logIntensity ? Float64Array.from(ys, (v) => Math.max(-6, Math.log10(Math.max(1e-12, v)))) : ys;
    layers.push({
      type: 'curve',
      segments: [{ xs: toMm, ys: scaled, length: scaled.length }],
      colour: '#f59e0b',
      width: 1.4,
      style: 'dashed',
    });
    legend.push({ label: 'Fraunhofer formula', colour: '#f59e0b', dashed: true });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'position on the screen (mm)',
    yLabel: cfg.logIntensity ? 'log₁₀ intensity' : 'relative intensity',
    legend,
  };
}

function rayScene(tab: TabState): PlotScene {
  const cfg = tab.waves;
  const world = cfg.world;
  const layers: Layer[] = [];
  const rays = traceRays(world);

  // The optical axis.
  layers.push({ type: 'hline', y: 0, colour: 'rgba(148,163,184,0.35)', style: 'dashed', width: 1 });

  for (const surface of [...world.surfaces].sort((a, b) => a.z - b.z)) {
    const points: number[][] = [];
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const y = -surface.aperture + (2 * surface.aperture * i) / steps;
      let z = surface.z;
      if (surface.radius === 0) {
        z = surface.z + y * Math.tan((surface.tilt * Math.PI) / 180);
      } else {
        const inside = surface.radius * surface.radius - y * y;
        if (inside < 0) continue;
        z = surface.z + surface.radius - Math.sign(surface.radius) * Math.sqrt(inside);
      }
      points.push([z, y]);
    }
    if (points.length < 2) continue;
    const selected = surface.id === cfg.selectedId;
    layers.push({
      type: 'polyline',
      xs: Float64Array.from(points.map((p) => p[0])),
      ys: Float64Array.from(points.map((p) => p[1])),
      colour: selected ? '#8b7cf6' : surface.mirror ? '#f472b6' : '#93c5fd',
      width: selected ? 2.6 : 2,
    });
  }

  rays.forEach((ray, i) => {
    layers.push({
      type: 'polyline',
      xs: Float64Array.from(ray.points.map((p) => p.z)),
      ys: Float64Array.from(ray.points.map((p) => p.y)),
      colour: ray.totalInternal ? '#f87171' : withAlpha(SERIES_COLOURS[i % SERIES_COLOURS.length], 0.9),
      width: 1.3,
    });
  });

  const crossings = axisCrossings(rays);
  for (const z of crossings) {
    layers.push({ type: 'points', xs: [z], ys: [0], colour: '#fbbf24', radius: 2.4 });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: false,
    showAxes: tab.showAxes,
    xLabel: 'z (mm)',
    yLabel: 'height (mm)',
    legend: [],
  };
}

// ------------------------------------------------------------------ panel

export function WavesPanel({ tab }: { tab: TabState }) {
  const cfg = tab.waves;
  const world = cfg.world;
  const setWaves = useStore((s) => s.setWaves);
  const commit = useStore((s) => s.commit);
  const patchActive = useStore((s) => s.patchActive);
  const medium = MEDIUM_BY_ID.get(world.medium) ?? MEDIA[0];

  const setWorld = useCallback(
    (patch: Partial<WaveWorld>) => {
      commit();
      setWaves({ world: { ...world, ...patch } });
      /* The clock restarts, and its span follows the run length. A string
       * settles in eighty milliseconds; against the ten-second default the
       * whole simulation happens in the first one per cent of the scrubber
       * and everything after it is the last frame held. */
      const duration = patch.duration ?? world.duration;
      patchActive({ timeline: { ...tab.timeline, t: 0, playing: false, tMax: duration } });
    },
    [commit, setWaves, world, patchActive, tab.timeline],
  );

  const slit = world.slits.find((s) => s.id === cfg.selectedId) ?? null;
  const surface = world.surfaces.find((s) => s.id === cfg.selectedId) ?? null;

  return (
    <>
      <Panel title="Experiment">
        <SegmentedControl size="sm" value={world.view} onChange={(view) => setWorld({ view })} options={VIEWS} />
      </Panel>

      {world.view === 'propagate' && (
        <>
          <Panel title="Medium">
            <Select
              value={world.medium}
              onChange={(id) => {
                const next = MEDIUM_BY_ID.get(id) ?? MEDIA[0];
                const params: Record<string, number> = {};
                for (const p of next.params) params[p.key] = p.default;
                setWorld({ medium: id, params, length: next.extent });
              }}
              options={MEDIA.map((m) => ({ value: m.id, label: m.label }))}
            />
            <p className="px-0.5 text-2xs text-ink-faint">{medium.blurb}</p>
            {medium.params.map((p) => (
              <Field key={p.key} label={`${p.label}${p.unit ? ` (${p.unit})` : ''}`}>
                <Slider
                  value={world.params[p.key] ?? p.default}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  onChange={(v) => setWorld({ params: { ...world.params, [p.key]: v } })}
                />
              </Field>
            ))}
            <StatList>
              <Stat label="Wave speed" value={`${fmt(medium.speed(world.params), 5)} m/s`} emphasis />
              {medium.dispersive && (
                <Stat
                  label="Group speed at 10 m⁻¹"
                  value={`${fmt(groupVelocity(medium, 10, world.params), 5)} m/s`}
                />
              )}
            </StatList>
          </Panel>

          <Panel title="Ends and length">
            <Field label="Length (m)">
              <NumberField value={world.length} min={0.01} step={0.1} onChange={(length) => setWorld({ length })} />
            </Field>
            <Field label="Left end">
              <SegmentedControl size="sm" value={world.left} onChange={(left) => setWorld({ left })} options={BOUNDARY_OPTIONS} />
            </Field>
            <Field label="Right end">
              <SegmentedControl size="sm" value={world.right} onChange={(right) => setWorld({ right })} options={BOUNDARY_OPTIONS} />
            </Field>
            <Field
              label="Change of medium at"
              hint="Zero for a uniform medium. Anywhere else and part of the wave reflects there."
            >
              <Slider value={world.junction} min={0} max={0.95} step={0.01} onChange={(junction) => setWorld({ junction })} />
            </Field>
            {world.junction > 0 && (
              <>
                <Field label="Speed beyond it, relative">
                  <Slider
                    value={world.speedRatio}
                    min={0.1}
                    max={4}
                    step={0.05}
                    onChange={(speedRatio) => setWorld({ speedRatio })}
                  />
                </Field>
                <StatList>
                  <Stat label="Reflected amplitude" value={fmt(reflectionCoefficient(1, world.speedRatio), 4)} />
                  <Stat label="Transmitted" value={fmt(transmissionCoefficient(1, world.speedRatio), 4)} />
                </StatList>
              </>
            )}
          </Panel>

          <Panel title="Source">
            <SegmentedControl
              size="sm"
              value={world.source.kind}
              onChange={(kind) => setWorld({ source: { ...world.source, kind } })}
              options={[
                { value: 'pulse', label: 'Pulse', title: 'A single bump, released from rest.' },
                { value: 'driven', label: 'Driven', title: 'One end shaken at a fixed frequency.' },
                { value: 'mode', label: 'Mode', title: 'Start in a normal mode and watch it stand still in shape.' },
              ]}
            />
            {world.source.kind === 'pulse' && (
              <>
                <Field label="Starts at">
                  <Slider
                    value={world.source.centre}
                    min={0.05}
                    max={0.95}
                    step={0.01}
                    onChange={(centre) => setWorld({ source: { ...world.source, centre } })}
                  />
                </Field>
                <Field label="Width">
                  <Slider
                    value={world.source.width}
                    min={0.005}
                    max={0.2}
                    step={0.005}
                    onChange={(width) => setWorld({ source: { ...world.source, width } })}
                  />
                </Field>
              </>
            )}
            {world.source.kind !== 'pulse' && (
              <Field label={world.source.kind === 'mode' ? 'Mode number' : 'Frequency (Hz)'}>
                <NumberField
                  value={world.source.frequency}
                  min={1}
                  step={world.source.kind === 'mode' ? 1 : 10}
                  onChange={(frequency) => setWorld({ source: { ...world.source, frequency } })}
                />
              </Field>
            )}
            <Field label="Run for (s)">
              <NumberField value={world.duration} min={0.001} step={0.01} onChange={(duration) => setWorld({ duration })} />
            </Field>
          </Panel>
        </>
      )}

      {world.view === 'diffract' && (
        <>
          <Panel title="Light and screen">
            <Field label="Wavelength (nm)" hint="390 is violet, 700 deep red.">
              <Slider
                value={world.wavelength}
                min={200}
                max={1200}
                step={1}
                onChange={(wavelength) => setWorld({ wavelength })}
              />
            </Field>
            <Row>
              <div className="flex-1">
                <Field label="Screen at (m)">
                  <NumberField
                    value={world.screenDistance}
                    min={0.005}
                    step={0.1}
                    onChange={(screenDistance) => setWorld({ screenDistance })}
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Half-width (m)">
                  <NumberField
                    value={world.screenWidth}
                    min={0.0005}
                    step={0.005}
                    onChange={(screenWidth) => setWorld({ screenWidth })}
                  />
                </Field>
              </div>
            </Row>
            <Field
              label="Source distance (m)"
              hint="Zero for a plane wave — a laser, or a very distant source. Anything else and the incoming wavefront is curved."
            >
              <NumberField
                value={world.sourceDistance}
                min={0}
                step={0.1}
                onChange={(sourceDistance) => setWorld({ sourceDistance })}
              />
            </Field>
          </Panel>

          <Panel title="Aperture">
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                data-slit-add="one"
                onClick={() => {
                  const added: Slit = { id: uid('slit'), centre: 0, width: 0.05, transmission: 1, phase: 0 };
                  commit();
                  setWaves({ world: { ...world, slits: [...world.slits, added] }, selectedId: added.id });
                }}
                className="rounded-md border border-dashed border-edge px-2 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
              >
                + Slit
              </button>
              {[2, 5, 20].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    const spacing = 0.2;
                    const slits: Slit[] = Array.from({ length: n }, (_, i) => ({
                      id: uid('slit'),
                      centre: (i - (n - 1) / 2) * spacing,
                      width: 0.04,
                      transmission: 1,
                      phase: 0,
                    }));
                    commit();
                    setWaves({ world: { ...world, slits }, selectedId: slits[0].id });
                  }}
                  className="rounded-md border border-dashed border-edge px-2 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
                >
                  {n} slits
                </button>
              ))}
            </div>

            <div className="space-y-1">
              {world.slits.map((s, i) => (
                <div
                  key={s.id}
                  className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 ${
                    s.id === cfg.selectedId ? 'border-accent-deep bg-accent/10' : 'border-edge bg-surface-1'
                  }`}
                >
                  <button type="button" className="flex-1 text-left text-2xs text-ink" onClick={() => setWaves({ selectedId: s.id })}>
                    Slit {i + 1}
                    <span className="ml-1.5 text-ink-faint">
                      {fmt(s.centre, 3)} mm, {fmt(s.width, 3)} mm wide
                    </span>
                  </button>
                  <IconButton title="Remove" onClick={() => setWorld({ slits: world.slits.filter((x) => x.id !== s.id) })}>
                    <IconTrash size={13} />
                  </IconButton>
                </div>
              ))}
              {world.slits.length === 0 && (
                <p className="py-2 text-center text-2xs text-ink-faint">No aperture: nothing gets through.</p>
              )}
            </div>

            {slit && (
              <div className="space-y-2 rounded-md border border-edge bg-surface-1 p-2">
                <Field label="Centre (mm)">
                  <Slider
                    value={slit.centre}
                    min={-2}
                    max={2}
                    step={0.005}
                    onChange={(centre) =>
                      setWorld({ slits: world.slits.map((x) => (x.id === slit.id ? { ...x, centre } : x)) })
                    }
                  />
                </Field>
                <Field label="Width (mm)">
                  <Slider
                    value={slit.width}
                    min={0.005}
                    max={2}
                    step={0.005}
                    onChange={(width) => setWorld({ slits: world.slits.map((x) => (x.id === slit.id ? { ...x, width } : x)) })}
                  />
                </Field>
                <Field label="Transmission">
                  <Slider
                    value={slit.transmission}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(transmission) =>
                      setWorld({ slits: world.slits.map((x) => (x.id === slit.id ? { ...x, transmission } : x)) })
                    }
                  />
                </Field>
                <Field label="Extra phase (π)" hint="A step of glass over this slit. Half a wavelength turns the middle bright fringe dark.">
                  <Slider
                    value={slit.phase / Math.PI}
                    min={0}
                    max={2}
                    step={0.05}
                    onChange={(v) =>
                      setWorld({ slits: world.slits.map((x) => (x.id === slit.id ? { ...x, phase: v * Math.PI } : x)) })
                    }
                  />
                </Field>
              </div>
            )}
          </Panel>

          <Panel title="Display">
            <Toggle
              label="Draw the Fraunhofer formula too"
              hint="Only where one applies: identical slits, plane wave in. Where it is absent, no textbook formula covers what you have built."
              checked={cfg.showAnalytic}
              onChange={(showAnalytic) => setWaves({ showAnalytic })}
            />
            <Toggle
              label="Log intensity"
              hint="The outer fringes are hundreds of times fainter than the middle."
              checked={cfg.logIntensity}
              onChange={(logIntensity) => setWaves({ logIntensity })}
            />
          </Panel>
        </>
      )}

      {world.view === 'rays' && (
        <>
          <Panel title="Light in">
            <Field label="Object distance (mm)" hint="Zero for parallel light from infinitely far away.">
              <NumberField
                value={world.objectDistance}
                min={0}
                step={10}
                onChange={(objectDistance) => setWorld({ objectDistance })}
              />
            </Field>
            <Row>
              <div className="flex-1">
                <Field label="Rays">
                  <NumberField
                    value={world.rayCount}
                    min={1}
                    max={64}
                    step={2}
                    precision={0}
                    onChange={(rayCount) => setWorld({ rayCount: Math.round(rayCount) })}
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Fan height (mm)">
                  <NumberField value={world.rayHeight} min={0} step={1} onChange={(rayHeight) => setWorld({ rayHeight })} />
                </Field>
              </div>
            </Row>
            <Field label="Tilt (°)">
              <Slider value={world.rayAngle} min={-60} max={60} step={0.5} onChange={(rayAngle) => setWorld({ rayAngle })} />
            </Field>
          </Panel>

          <Panel title="Surfaces">
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => {
                  const added: Surface = {
                    id: uid('surf'),
                    z: (world.surfaces.at(-1)?.z ?? 0) + 40,
                    radius: 0,
                    tilt: 0,
                    aperture: 18,
                    index: 1.5,
                    mirror: false,
                    label: 'Flat',
                  };
                  commit();
                  setWaves({ world: { ...world, surfaces: [...world.surfaces, added] }, selectedId: added.id });
                }}
                className="rounded-md border border-dashed border-edge px-2 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
              >
                + Surface
              </button>
              <button
                type="button"
                onClick={() => {
                  const z = (world.surfaces.at(-1)?.z ?? 0) + 40;
                  const lens: Surface[] = [
                    { id: uid('surf'), z, radius: 60, tilt: 0, aperture: 18, index: 1.5, mirror: false, label: 'Lens front' },
                    { id: uid('surf'), z: z + 8, radius: -60, tilt: 0, aperture: 18, index: 1, mirror: false, label: 'Lens back' },
                  ];
                  commit();
                  setWaves({ world: { ...world, surfaces: [...world.surfaces, ...lens] }, selectedId: lens[0].id });
                }}
                className="rounded-md border border-dashed border-edge px-2 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
              >
                + Lens
              </button>
              <button
                type="button"
                onClick={() => {
                  const z = (world.surfaces.at(-1)?.z ?? 0) + 40;
                  const prism: Surface[] = [
                    { id: uid('surf'), z, radius: 0, tilt: 0, aperture: 30, index: 1.5, mirror: false, label: 'Prism in' },
                    { id: uid('surf'), z: z + 30, radius: 0, tilt: 45, aperture: 30, index: 1, mirror: false, label: 'Prism face' },
                  ];
                  commit();
                  setWaves({ world: { ...world, surfaces: [...world.surfaces, ...prism] }, selectedId: prism[1].id });
                }}
                className="rounded-md border border-dashed border-edge px-2 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
              >
                + Prism face
              </button>
            </div>

            <div className="space-y-1">
              {[...world.surfaces]
                .sort((a, b) => a.z - b.z)
                .map((s) => (
                  <div
                    key={s.id}
                    className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 ${
                      s.id === cfg.selectedId ? 'border-accent-deep bg-accent/10' : 'border-edge bg-surface-1'
                    }`}
                  >
                    <button type="button" className="flex-1 text-left text-2xs text-ink" onClick={() => setWaves({ selectedId: s.id })}>
                      {s.label || 'Surface'}
                      <span className="ml-1.5 text-ink-faint">
                        z = {fmt(s.z, 4)} mm, n = {fmt(s.index, 3)}
                      </span>
                    </button>
                    <IconButton title="Remove" onClick={() => setWorld({ surfaces: world.surfaces.filter((x) => x.id !== s.id) })}>
                      <IconTrash size={13} />
                    </IconButton>
                  </div>
                ))}
            </div>

            {surface && (
              <div className="space-y-2 rounded-md border border-edge bg-surface-1 p-2">
                <Field label="Position z (mm)">
                  <NumberField
                    value={surface.z}
                    step={1}
                    onChange={(z) => setWorld({ surfaces: world.surfaces.map((x) => (x.id === surface.id ? { ...x, z } : x)) })}
                  />
                </Field>
                <Field label="Radius (mm)" hint="Zero is flat. Positive curves away from the light.">
                  <Slider
                    value={surface.radius}
                    min={-200}
                    max={200}
                    step={1}
                    onChange={(radius) =>
                      setWorld({ surfaces: world.surfaces.map((x) => (x.id === surface.id ? { ...x, radius } : x)) })
                    }
                  />
                </Field>
                {surface.radius === 0 && (
                  <Field label="Tilt (°)" hint="Past the critical angle a tilted face stops letting light out altogether.">
                    <Slider
                      value={surface.tilt}
                      min={-80}
                      max={80}
                      step={0.5}
                      onChange={(tilt) =>
                        setWorld({ surfaces: world.surfaces.map((x) => (x.id === surface.id ? { ...x, tilt } : x)) })
                      }
                    />
                  </Field>
                )}
                <Field label="Index after this surface">
                  <Slider
                    value={surface.index}
                    min={1}
                    max={2.6}
                    step={0.01}
                    onChange={(index) =>
                      setWorld({ surfaces: world.surfaces.map((x) => (x.id === surface.id ? { ...x, index } : x)) })
                    }
                  />
                </Field>
                <Field label="Half-height (mm)">
                  <Slider
                    value={surface.aperture}
                    min={1}
                    max={60}
                    step={0.5}
                    onChange={(aperture) =>
                      setWorld({ surfaces: world.surfaces.map((x) => (x.id === surface.id ? { ...x, aperture } : x)) })
                    }
                  />
                </Field>
                <Toggle
                  label="Mirror"
                  checked={surface.mirror}
                  onChange={(mirror) =>
                    setWorld({ surfaces: world.surfaces.map((x) => (x.id === surface.id ? { ...x, mirror } : x)) })
                  }
                />
              </div>
            )}
          </Panel>
        </>
      )}

      <Panel title="Display">
        <Toggle label="Governing equations" checked={cfg.showEquations} onChange={(showEquations) => setWaves({ showEquations })} />
      </Panel>

      <ViewPanel tab={tab} />
    </>
  );
}

// ------------------------------------------------------------------ surface

export function WavesSurface({ tab }: { tab: TabState }) {
  const cfg = tab.waves;
  const world = cfg.world;
  const setViewport = useStore((s) => s.setViewport);
  const fitViewport = useStore((s) => s.fitViewport);
  const plotRef = usePlot2DRef();
  const field = useField(world, world.view === 'propagate' ? world.duration : 0);

  const scene = useMemo(() => {
    if (world.view === 'diffract') return diffractionScene(tab);
    if (world.view === 'rays') return rayScene(tab);
    return waveScene(tab, field);
  }, [tab, field, world.view]);

  /* Each view lives in completely different coordinates — metres of string,
   * millimetres of screen, millimetres along an optical bench — so switching
   * view reframes rather than leaving the last view's window in place. */
  useEffect(() => {
    if (world.view === 'propagate') {
      const amplitude = Math.max(0.3, world.source.amplitude * 1.6);
      fitViewport({ xMin: 0, xMax: world.length, yMin: -amplitude, yMax: amplitude });
    } else if (world.view === 'diffract') {
      const half = world.screenWidth * 1000;
      fitViewport({ xMin: -half, xMax: half, yMin: cfg.logIntensity ? -6.2 : -0.05, yMax: cfg.logIntensity ? 0.3 : 1.08 });
    } else {
      const last = world.surfaces.length ? Math.max(...world.surfaces.map((s) => s.z)) : 100;
      const first = world.surfaces.length ? Math.min(...world.surfaces.map((s) => s.z)) : 0;
      const height = Math.max(20, world.rayHeight * 1.6);
      fitViewport({ xMin: first - 50, xMax: last + 130, yMin: -height, yMax: height });
    }
    // Only when the shape of the experiment changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.view, world.length, world.screenWidth, world.surfaces.length, cfg.logIntensity, fitViewport]);

  const analytic = useMemo(() => analyseWaves(tab), [tab]);

  const energyTrace = useMemo((): Trace[] => {
    if (!field || field.count === 0 || world.view !== 'propagate') return [];
    return [
      {
        id: 'energy',
        label: 'Energy',
        unit: '',
        colour: SERIES_COLOURS[3],
        xs: field.time.subarray(0, field.count),
        ys: field.energy.subarray(0, field.count),
      },
    ];
  }, [field, field?.count, world.view]);

  return (
    <SandboxLayout
      storageKey="waves"
      canvas={
        <div className="flex h-full w-full flex-col">
          <div className="relative min-h-0 flex-1">
            <Plot2D
              ref={plotRef}
              scene={scene}
              onViewportChange={setViewport}
              readout={(x, y) =>
                world.view === 'propagate'
                  ? `${x.toFixed(3)} m, ${y.toFixed(3)}`
                  : world.view === 'diffract'
                    ? `${x.toFixed(3)} mm, ${y.toFixed(3)}`
                    : `${x.toFixed(2)} mm, ${y.toFixed(2)} mm`
              }
            />
          </div>
          {world.view === 'diffract' && <ScreenStrip tab={tab} />}
        </div>
      }
      instruments={
        <>
          {world.view === 'propagate' && <PropagateReadout tab={tab} field={field} traces={energyTrace} />}
          {world.view === 'diffract' && <DiffractReadout tab={tab} />}
          {world.view === 'rays' && <RayReadout tab={tab} />}
          {cfg.showEquations && <AnalyticCard result={analytic} />}
        </>
      }
    />
  );
}

/** The pattern as it would look on a card: a photograph, not a graph. */
function ScreenStrip({ tab }: { tab: TabState }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const world = tab.waves.world;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = Math.max(64, Math.round(canvas.clientWidth));
    const height = 46;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const result = diffractionPattern(world, width);
    const [r, g, b] = wavelengthColour(world.wavelength);
    const image = ctx.createImageData(width, 1);
    for (let i = 0; i < width; i++) {
      // Eye response is closer to a square root of intensity than to intensity.
      const v = Math.sqrt(Math.max(0, result.intensity[i]));
      image.data[i * 4] = Math.round(r * v);
      image.data[i * 4 + 1] = Math.round(g * v);
      image.data[i * 4 + 2] = Math.round(b * v);
      image.data[i * 4 + 3] = 255;
    }
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = 1;
    scratch.getContext('2d')?.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
  }, [world]);

  return (
    <div className="border-t border-edge px-3 py-2">
      <div className="mb-1 text-2xs text-ink-faint">On the screen</div>
      <canvas ref={ref} className="h-[46px] w-full rounded" aria-label="The diffraction pattern as it appears on a screen" />
    </div>
  );
}

/** Roughly what a wavelength looks like, for the screen strip. */
function wavelengthColour(nm: number): [number, number, number] {
  const w = Math.max(380, Math.min(780, nm));
  let r = 0;
  let g = 0;
  let b = 0;
  if (w < 440) {
    r = -(w - 440) / 60;
    b = 1;
  } else if (w < 490) {
    g = (w - 440) / 50;
    b = 1;
  } else if (w < 510) {
    g = 1;
    b = -(w - 510) / 20;
  } else if (w < 580) {
    r = (w - 510) / 70;
    g = 1;
  } else if (w < 645) {
    r = 1;
    g = -(w - 645) / 65;
  } else {
    r = 1;
  }
  // Infrared and ultraviolet are drawn as a dim grey rather than as black,
  // since "invisible" and "no pattern" are different things.
  const visible = nm >= 380 && nm <= 780;
  if (!visible) return [120, 120, 130];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function PropagateReadout({ tab, field, traces }: { tab: TabState; field: WaveField | null; traces: Trace[] }) {
  const world = tab.waves.world;
  const medium = MEDIUM_BY_ID.get(world.medium) ?? MEDIA[0];
  const speed = medium.speed(world.params);
  const modes = modeFrequencies(speed, world.length, world.left, world.right, 5);
  return (
    <>
      <ProbePlot traces={traces} xLabel="t (s)" cursorTime={null} height={170} />
      <div className="border-t border-edge px-3 py-2.5">
        <StatList>
          <Stat label="Wave speed" value={`${fmt(speed, 5)} m/s`} emphasis />
          <Stat label="Time to cross" value={`${fmt(world.length / speed, 4)} s`} />
          <Stat label="Fundamental" value={modes.length ? `${fmt(modes[0], 5)} Hz` : 'none'} />
          <Stat label="Energy now" value={field && field.count ? fmt(field.energy[field.count - 1], 5) : '—'} />
        </StatList>
      </div>
      <Collapsible title="Harmonics" defaultOpen>
        <div className="space-y-0.5">
          {modes.map((f, i) => (
            <div key={i} className="flex items-baseline justify-between px-2 py-1 font-mono text-2xs text-ink-dim">
              <span>{world.left === world.right ? `n = ${i + 1}` : `n = ${2 * i + 1}`}</span>
              <span>{fmt(f, 5)} Hz</span>
            </div>
          ))}
        </div>
        <p className="px-1 pt-1.5 text-2xs text-ink-faint">
          {modes.length === 0
            ? 'An end that absorbs sends the wave away for good, so nothing comes back to interfere with itself and there is no resonance at any frequency. Make an end fixed or free to get a ladder.'
            : world.left === world.right
              ? 'Both ends the same: every harmonic of v/2L is allowed.'
              : 'One end of each kind: only the odd harmonics of v/4L fit, which is why a clarinet sounds hollow and plays an octave lower than its length suggests.'}
        </p>
      </Collapsible>
    </>
  );
}

function DiffractReadout({ tab }: { tab: TabState }) {
  const world = tab.waves.world;
  const result = useMemo(() => diffractionPattern(world, 900), [world]);
  const identical = world.slits.length > 0 && world.slits.every((s) => Math.abs(s.width - world.slits[0].width) < 1e-9 && s.phase === 0);
  return (
    <>
      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat label="Slits" value={String(world.slits.length)} />
          <Stat label="Wavelength" value={`${fmt(world.wavelength, 4)} nm`} />
          <Stat
            label="First minimum"
            value={result.firstMinimum === null ? '—' : `${fmt((result.firstMinimum * 180) / Math.PI, 4)}°`}
          />
          <Stat
            label="Fringe spacing"
            value={result.fringeSpacing === null ? '—' : `${fmt(result.fringeSpacing * 1000, 4)} mm`}
          />
          <Stat label="Fresnel number" value={fmt(result.fresnelNumber, 4)} emphasis />
        </StatList>
      </div>
      <div className="px-3 py-2.5">
        <Callout kind={result.fresnelNumber > 1 ? 'warn' : 'info'}>
          {result.fresnelNumber > 1
            ? 'Fresnel number above 1: this is the near field, and the far-field formulae do not apply here. What you see is the pattern the integral actually gives.'
            : 'Fresnel number below 1: the far field, where the textbook formulae hold — and the dashed curve should sit on top of the computed one.'}
        </Callout>
        {!identical && (
          <p className="pt-2 text-2xs text-ink-faint">
            The slits are not all identical, so no standard formula describes this aperture. The
            computed pattern is still exactly right.
          </p>
        )}
      </div>
    </>
  );
}

function RayReadout({ tab }: { tab: TabState }) {
  const world = tab.waves.world;
  const rays = useMemo(() => traceRays(world), [world]);
  const crossings = axisCrossings(rays);
  const sorted = [...world.surfaces].sort((a, b) => a.z - b.z);
  const curved = sorted.filter((s) => s.radius !== 0);
  const focal =
    curved.length >= 2 ? lensmaker(curved[0].index, curved[0].radius, curved[1].radius) : null;
  /* Only a curved surface or a mirror focuses anything. Rays turned aside by a
   * flat face all cross the axis somewhere, but calling the spread of those
   * crossings "the focus" describes a lens that is not there — a prism would
   * report a focal spread of twelve millimetres and an aberration it does not
   * have. */
  const focuses = curved.length > 0 || sorted.some((s) => s.mirror);
  const spread = focuses && crossings.length > 1 ? Math.max(...crossings) - Math.min(...crossings) : 0;
  const paraxial = focuses && crossings.length ? Math.max(...crossings) : null;

  // The steepest index step present, for the critical-angle readout.
  let n1 = 1;
  let n2 = 1;
  for (let i = 0; i < sorted.length; i++) {
    const before = i === 0 ? 1 : sorted[i - 1].index;
    if (before > sorted[i].index) {
      n1 = before;
      n2 = sorted[i].index;
    }
  }
  const critical = criticalAngle(n1, n2);

  return (
    <div className="border-b border-edge px-3 py-2.5">
      <StatList>
        <Stat label="Rays traced" value={String(rays.length)} />
        <Stat label="Blocked by an aperture" value={String(rays.filter((r) => r.stopped === 'aperture').length)} />
        {/* Short enough to fit the column: the full phrase was ellipsised. */}
        <Stat label="Trapped by TIR" value={String(rays.filter((r) => r.totalInternal).length)} />
        {focal !== null && Number.isFinite(focal) && (
          <Stat label="Focal length, thin-lens" value={`${fmt(focal, 5)} mm`} emphasis />
        )}
        {focal !== null && Number.isFinite(focal) && world.objectDistance > 0 && (
          <Stat label="Image should be at" value={`${fmt(thinLensImage(focal, world.objectDistance), 5)} mm`} />
        )}
        {paraxial !== null && <Stat label="Rays cross the axis near" value={`${fmt(paraxial, 5)} mm`} />}
        {spread > 0.01 && <Stat label="Spread of the focus" value={`${fmt(spread, 4)} mm`} />}
        {critical !== null && <Stat label="Critical angle" value={`${fmt(critical, 4)}°`} />}
        {critical !== null && <Stat label="Brewster angle" value={`${fmt(brewsterAngle(n1, n2), 4)}°`} />}
      </StatList>
      {spread > 0.01 && (
        <p className="pt-2 text-2xs text-ink-faint">
          The rays do not all cross at one point. That spread is spherical aberration — the edge of
          a spherical lens bends light too strongly — and it is why a paraxial calculation gives one
          focal length and a real lens gives a blur.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ analytic

function analyseWaves(tab: TabState) {
  const world = tab.waves.world;
  const medium = MEDIUM_BY_ID.get(world.medium) ?? MEDIA[0];

  if (world.view === 'propagate') {
    return {
      title: medium.label,
      equations: [
        String.raw`\frac{\partial^{2}u}{\partial t^{2}} = c^{2}\,\frac{\partial^{2}u}{\partial x^{2}}`,
        world.medium === 'water'
          ? String.raw`\omega = \sqrt{gk\tanh kh}`
          : world.medium === 'spring'
            ? String.raw`\omega = 2\sqrt{k/m}\,\left|\sin\tfrac{qa}{2}\right|`
            : String.raw`\omega = ck`,
        String.raw`r = \frac{c_{2}-c_{1}}{c_{2}+c_{1}}, \qquad t = \frac{2c_{2}}{c_{1}+c_{2}}`,
      ],
      quantities: [
        { label: 'Speed', value: medium.speed(world.params), unit: 'm/s' },
        { label: 'Length', value: world.length, unit: 'm' },
        { label: 'Fundamental', value: modeFrequencies(medium.speed(world.params), world.length, world.left, world.right, 1)[0], unit: 'Hz' },
      ],
      overlay: null,
      caveat: medium.dispersive
        ? 'This medium is dispersive, so a pulse changes shape as it goes. The integration here uses a single wave speed and is exact only for the long-wavelength limit.'
        : null,
    };
  }

  if (world.view === 'diffract') {
    return {
      title: 'Diffraction',
      equations: [
        String.raw`E(x_{s}) = \int_{\text{aperture}} A(x)\,\frac{e^{ikr}}{\sqrt{r}}\,dx, \qquad I = |E|^{2}`,
        String.raw`I(\theta) = I_{0}\left(\frac{\sin\beta}{\beta}\right)^{2}\left(\frac{\sin N\gamma}{\sin\gamma}\right)^{2}`,
        String.raw`\beta = \frac{\pi a\sin\theta}{\lambda}, \qquad \gamma = \frac{\pi d\sin\theta}{\lambda}`,
      ],
      quantities: [
        { label: 'Wavelength', value: world.wavelength, unit: 'nm' },
        { label: 'Screen distance', value: world.screenDistance, unit: 'm' },
        { label: 'Slits', value: world.slits.length, unit: '' },
      ],
      overlay: null,
      caveat:
        'The first line is what is computed. The second is the far-field limit of it for identical slits, and is drawn only when it applies.',
    };
  }

  return {
    title: 'Rays',
    equations: [
      String.raw`n_{1}\sin\theta_{1} = n_{2}\sin\theta_{2}`,
      String.raw`\frac{1}{f} = (n-1)\left(\frac{1}{R_{1}} - \frac{1}{R_{2}}\right)`,
      String.raw`\frac{1}{v} = \frac{1}{f} - \frac{1}{u}, \qquad \theta_{c} = \arcsin\frac{n_{2}}{n_{1}}`,
    ],
    quantities: [
      { label: 'Surfaces', value: world.surfaces.length, unit: '' },
      { label: 'Rays', value: world.rayCount, unit: '' },
    ],
    overlay: null,
    caveat:
      'Only the first line is used. The lens equations are the paraxial approximation to it, printed for comparison — where the traced rays disagree with them, the rays are right.',
  };
}

// ------------------------------------------------------------------ export

export function wavesCsv(tab: TabState): string | null {
  const world = tab.waves.world;
  if (world.view === 'diffract') {
    const result = diffractionPattern(world, 1200);
    return toCsv(
      ['position_mm', 'angle_deg', 'intensity'],
      Array.from(result.x, (x, i) => [x * 1000, (result.angle[i] * 180) / Math.PI, result.intensity[i]]),
    );
  }
  if (world.view === 'rays') {
    const rays = traceRays(world);
    const rows: (number | string)[][] = [];
    rays.forEach((ray, i) => {
      for (const p of ray.points) rows.push([i + 1, p.z, p.y, ray.totalInternal ? 'yes' : 'no']);
    });
    return toCsv(['ray', 'z_mm', 'y_mm', 'total_internal'], rows);
  }
  const field = createWaveField(world);
  advanceWaveField(field, world.duration, 400000);
  const rows: number[][] = [];
  const stride = Math.max(1, Math.floor(field.count / 200));
  for (let f = 0; f < field.count; f += stride) {
    for (let i = 0; i < field.n; i += 4) rows.push([field.time[f], field.x[i], field.frames[f * field.n + i]]);
  }
  return toCsv(['t_s', 'x_m', 'displacement'], rows);
}
