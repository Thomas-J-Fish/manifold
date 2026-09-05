import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import { SERIES_COLOURS, type TabState } from '../core/types';
import {
  advanceWave,
  createWaveTrajectory,
  freeEnergy,
  potentialAt,
  samplePotential,
  scatterCurve,
  solveBoundStates,
  solvePlaneStates,
  waveFrameAt,
  type BoundStates,
  type FeatureKind,
  type PlaneStates,
  type PotentialFeature,
  type QuantumWorld,
  type WaveTrajectory,
} from '../core/physics/quantum';
import { analyseQuantum } from '../core/physics/analytic';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { ProbePlot, type Trace } from '../components/sandbox/ProbePlot';
import { AnalyticCard } from '../components/sandbox/AnalyticCard';
import { useSquareScales } from '../components/sandbox/useSquareScales';
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
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* The quantum mode.
 *
 * Four views over one potential, because "solve the Schrödinger equation" is
 * four different questions and a student needs to be able to move between them
 * without rebuilding the problem:
 *
 *   Bound states — the ladder, and what the wavefunctions look like on it.
 *   Wavepacket   — the same potential, hit with something that moves.
 *   Transmission — how much gets through, against energy, with the closed form.
 *   Two dimensions — where degeneracy comes from.
 *
 * The potential is a list of features rather than a formula, so that "put a
 * barrier here, 3 eV high, 0.4 nm wide" is three numbers rather than an
 * expression to get right. A free-form V(x) is available underneath for
 * anyone who wants it, and adds to whatever the features build.
 */

const FEATURES: { kind: FeatureKind; label: string; hint: string }[] = [
  { kind: 'well', label: 'Well', hint: 'A rectangular well: somewhere for states to be bound.' },
  { kind: 'barrier', label: 'Barrier', hint: 'A rectangular barrier: something to tunnel through.' },
  { kind: 'step', label: 'Step', hint: 'A change in potential that carries on for ever.' },
  { kind: 'harmonic', label: 'Harmonic', hint: 'A parabola: the oscillator, and every minimum close up.' },
  { kind: 'gaussian', label: 'Gaussian', hint: 'A smooth bump or dip, with no corners to scatter off.' },
  { kind: 'linear', label: 'Field', hint: 'A uniform force: a tilted potential.' },
  { kind: 'coulomb', label: 'Coulomb', hint: 'A softened −1/r attraction, for an atom-like well.' },
];

const FEATURE_BY_KIND = new Map(FEATURES.map((f) => [f.kind, f]));

/* Four words, not four phrases. The control is one sidebar wide and four
 * options across; "Bound states" and "Two dimensions" both ellipsise to
 * nothing useful, and a segmented control whose segments all read "…" is
 * worse than no labels at all. */
const VIEW_OPTIONS = [
  { value: 'bound' as const, label: 'Bound', title: 'Energy levels and their wavefunctions.' },
  { value: 'evolve' as const, label: 'Packet', title: 'Launch a wavepacket and watch it move.' },
  { value: 'scatter' as const, label: 'Tunnel', title: 'Transmission against energy, with the closed form.' },
  { value: 'plane' as const, label: '2D', title: 'States of a two-dimensional well, and their degeneracies.' },
];

/** What each field of a feature means, which depends on the kind. */
function fieldLabels(kind: FeatureKind): { height: string; width: string; unit: string } {
  switch (kind) {
    case 'well':
      return { height: 'Depth', width: 'Width', unit: 'eV' };
    case 'step':
      return { height: 'Rise', width: 'Unused', unit: 'eV' };
    case 'harmonic':
      return { height: 'Height at ½ width', width: 'Width', unit: 'eV' };
    case 'linear':
      return { height: 'Slope', width: 'Unused', unit: 'eV/nm' };
    case 'coulomb':
      return { height: 'Strength', width: 'Softening', unit: 'eV·nm' };
    default:
      return { height: 'Height', width: 'Width', unit: 'eV' };
  }
}

function newFeature(kind: FeatureKind, centre: number): PotentialFeature {
  const base = { id: uid('q'), kind, centre };
  switch (kind) {
    case 'well':
      return { ...base, width: 1, height: 5 };
    case 'barrier':
      return { ...base, width: 0.4, height: 4 };
    case 'step':
      return { ...base, width: 0.1, height: 2 };
    case 'harmonic':
      return { ...base, width: 2, height: 4 };
    case 'gaussian':
      return { ...base, width: 0.8, height: 3 };
    case 'linear':
      return { ...base, width: 1, height: 1 };
    case 'coulomb':
      return { ...base, width: 0.2, height: 3 };
    default:
      return { ...base, width: 1, height: 1 };
  }
}

// ------------------------------------------------------------------ solving

interface Solution {
  states: BoundStates | null;
  traj: WaveTrajectory | null;
  plane: PlaneStates | null;
}

/**
 * Everything the current view needs, recomputed only when the world changes.
 *
 * Keyed on the serialised world rather than on object identity: the store
 * replaces the world object on every keystroke in a number field, and a
 * diagonalisation per keystroke is the difference between a slider that
 * responds and one that stutters.
 */
function useSolution(world: QuantumWorld, extra: ((x: number) => number) | undefined, until: number): Solution {
  const key = useMemo(() => `${JSON.stringify(world)}|${world.expression}`, [world]);
  const cache = useRef<{ key: string; value: Solution } | null>(null);
  const [, bump] = useState(0);

  if (!cache.current || cache.current.key !== key) {
    const value: Solution = { states: null, traj: null, plane: null };
    if (world.view === 'plane') {
      value.plane = solvePlaneStates(world);
    } else if (world.view === 'evolve') {
      value.traj = createWaveTrajectory(world, extra);
      // The bound states come along anyway: they are what the packet is made
      // of, and the energy readout means little without the ladder beside it.
      value.states = solveBoundStates(world, extra);
    } else {
      value.states = solveBoundStates(world, extra);
    }
    cache.current = { key, value };
  }

  const solution = cache.current.value;
  useEffect(() => {
    if (!solution.traj) return;
    // Run the evolution in slices so a long one does not lock the window.
    let cancelled = false;
    const tick = () => {
      if (cancelled || !solution.traj) return;
      const done = advanceWave(solution.traj, until, 4000);
      bump((n) => n + 1);
      if (!done) requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [solution, until]);

  return solution;
}

// ------------------------------------------------------------------ drawing

const POTENTIAL_COLOUR = '#94a3b8';
const LEVEL_COLOUR = '#64748b';

function buildScene(tab: TabState, solution: Solution, extra: ((x: number) => number) | undefined): PlotScene {
  const cfg = tab.quantum;
  const world = cfg.world;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];

  if (world.view === 'plane') {
    return planeScene(tab, solution.plane);
  }

  const sample = samplePotential(world, extra);
  layers.push({
    type: 'curve',
    segments: [{ xs: sample.x, ys: sample.v, length: sample.x.length }],
    colour: POTENTIAL_COLOUR,
    width: 2,
  });
  legend.push({ label: 'V(x)', colour: POTENTIAL_COLOUR });

  // The walls, drawn so it is obvious the box is part of the problem.
  layers.push({ type: 'vline', x: world.xMin, colour: withAlpha(POTENTIAL_COLOUR, 0.5), style: 'dashed', width: 1.2 });
  layers.push({ type: 'vline', x: world.xMax, colour: withAlpha(POTENTIAL_COLOUR, 0.5), style: 'dashed', width: 1.2 });

  const states = solution.states;
  if (world.view === 'bound' && states) {
    const span = spanOf(states);
    for (let s = 0; s < states.energies.length; s++) {
      const energy = states.energies[s];
      const chosen = s === cfg.level;
      const colour = SERIES_COLOURS[s % SERIES_COLOURS.length];
      const alpha = chosen ? 1 : 0.42;

      /* Only the bound levels and whichever is selected are labelled. The
       * unbound ones are the box's own standing waves and crowd together just
       * above zero, where four labels land on top of each other and none of
       * them can be read. */
      const labelled = chosen || s < states.bound;
      layers.push({
        type: 'hline',
        y: energy,
        colour: withAlpha(s < states.bound ? LEVEL_COLOUR : '#b45309', chosen ? 0.95 : 0.35),
        style: s < states.bound ? 'solid' : 'dotted',
        width: chosen ? 1.6 : 1,
        ...(labelled ? { label: `E${s + 1} = ${fmt(energy, 4)} eV` } : {}),
      });

      if (!chosen && cfg.level >= 0 && cfg.stacked === false) continue;
      const ys = new Float64Array(states.n);
      const height = span * 0.11 * cfg.scale;
      for (let i = 0; i < states.n; i++) {
        const value = states.psi[s * states.n + i];
        const drawn = cfg.probability ? value * value : value;
        ys[i] = (cfg.stacked ? energy : 0) + drawn * height * (cfg.probability ? 1.6 : 1);
      }
      layers.push({
        type: 'curve',
        segments: [{ xs: states.x, ys, length: states.n }],
        colour: withAlpha(colour, alpha),
        width: chosen ? 2 : 1.2,
      });
      if (chosen) legend.push({ label: `${cfg.probability ? '|ψ|²' : 'ψ'} of level ${s + 1}`, colour });
    }
  }

  if (world.view === 'evolve' && solution.traj) {
    const traj = solution.traj;
    const frame = waveFrameAt(traj, tab.timeline.t);
    const n = traj.n;
    const base = frame * 2 * n;
    /* The packet is drawn against the *viewport*, not against the range of the
     * potential. A packet sitting at its own mean energy well above a shallow
     * well would otherwise be scaled by the well's depth and drawn several
     * screens tall, which is how the first version of this looked: a flat line
     * of clipped wavefunction jammed against the top of the frame. */
    const height = Math.max(1e-6, tab.viewport.yMax - tab.viewport.yMin) * 0.16 * cfg.scale;
    const density = new Float64Array(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let peak = 1e-12;
    for (let i = 0; i < n; i++) {
      const a = traj.frames[base + i];
      const b = traj.frames[base + n + i];
      density[i] = a * a + b * b;
      peak = Math.max(peak, density[i]);
    }
    const centre = traj.energy[frame] ?? 0;
    for (let i = 0; i < n; i++) {
      re[i] = centre + (traj.frames[base + i] / Math.sqrt(peak)) * height * 0.7;
      im[i] = centre + (traj.frames[base + n + i] / Math.sqrt(peak)) * height * 0.7;
      density[i] = centre + (density[i] / peak) * height;
    }
    if (!cfg.probability) {
      layers.push({ type: 'curve', segments: [{ xs: traj.x, ys: re, length: n }], colour: '#38bdf8', width: 1.4 });
      layers.push({ type: 'curve', segments: [{ xs: traj.x, ys: im, length: n }], colour: '#f472b6', width: 1.2, style: 'dashed' });
      legend.push({ label: 'Re ψ', colour: '#38bdf8' });
      legend.push({ label: 'Im ψ', colour: '#f472b6', dashed: true });
    }
    layers.push({
      type: 'area',
      segments: [{ xs: traj.x, ys: density, length: n }],
      baseline: centre,
      colour: withAlpha('#a78bfa', 0.35),
    });
    layers.push({ type: 'curve', segments: [{ xs: traj.x, ys: density, length: n }], colour: '#a78bfa', width: 1.8 });
    legend.push({ label: '|ψ|²', colour: '#a78bfa' });
    layers.push({ type: 'hline', y: centre, colour: withAlpha(LEVEL_COLOUR, 0.5), style: 'dotted', width: 1 });
    if (traj.split > world.xMin && traj.split < world.xMax) {
      layers.push({
        type: 'vline',
        x: traj.split,
        colour: withAlpha('#22c55e', 0.55),
        style: 'dashed',
        width: 1.2,
        label: 'transmitted →',
      });
    }
  }

  if (world.view === 'scatter' && states) {
    // The potential alone, with the energy window marked on it.
    layers.push({
      type: 'rect',
      x0: world.xMin,
      y0: world.scatterMin,
      x1: world.xMax,
      y1: world.scatterMax,
      fill: withAlpha('#38bdf8', 0.07),
      stroke: withAlpha('#38bdf8', 0.35),
      dash: true,
    });
    layers.push({
      // Anchored to the bottom of the band rather than the top, which is
      // usually off the top of the frame: the sweep goes to 8 eV and the
      // bound-state view is scaled to a 5 eV well.
      type: 'text',
      x: (world.xMin + world.xMax) / 2,
      y: world.scatterMin,
      text: 'energies swept',
      colour: withAlpha('#38bdf8', 0.9),
      align: 'center',
      baseline: 'top',
      size: 10,
    });
  }

  // Handles on each feature, so the potential can be dragged rather than typed.
  for (const f of world.features) {
    if (f.kind === 'linear') continue;
    const selected = f.id === cfg.selectedId;
    const top = potentialAt(world.features, f.centre) + (extra ? extra(f.centre) : 0);
    layers.push({
      type: 'points',
      xs: [f.centre],
      ys: [top],
      colour: selected ? '#8b7cf6' : withAlpha(POTENTIAL_COLOUR, 0.8),
      radius: selected ? 5 : 3.5,
      stroke: '#0b0e14',
    });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'x (nm)',
    yLabel: 'energy (eV)',
    legend,
  };
}

const minOf = (a: Float64Array): number => {
  let m = Infinity;
  for (const v of a) if (v < m) m = v;
  return Number.isFinite(m) ? m : 0;
};

function spanOf(states: BoundStates): number {
  const top = states.energies[states.energies.length - 1] ?? 1;
  const bottom = Math.min(states.energies[0] ?? 0, minOf(states.v));
  return Math.max(1e-6, top - bottom);
}

/** |ψ|² of a 2D state as a raster, which is the only honest way to draw it. */
function planeScene(tab: TabState, plane: PlaneStates | null): PlotScene {
  const cfg = tab.quantum;
  const layers: Layer[] = [];
  if (plane && plane.count) {
    const s = Math.min(Math.max(0, cfg.level), plane.count - 1);
    const size = plane.nx * plane.ny;
    const offset = s * size;
    let peak = 1e-12;
    for (let i = 0; i < size; i++) {
      const v = cfg.probability ? plane.psi[offset + i] ** 2 : plane.psi[offset + i];
      peak = Math.max(peak, Math.abs(v));
    }
    const image = new ImageData(plane.nx, plane.ny);
    for (let j = 0; j < plane.ny; j++) {
      for (let i = 0; i < plane.nx; i++) {
        const raw = plane.psi[offset + j * plane.nx + i];
        const value = (cfg.probability ? raw * raw : raw) / peak;
        // Rows run up the screen but down the raster.
        const at = ((plane.ny - 1 - j) * plane.nx + i) * 4;
        const [r, g, b] = cfg.probability ? hotColour(value) : divergingPair(value);
        image.data[at] = r;
        image.data[at + 1] = g;
        image.data[at + 2] = b;
        image.data[at + 3] = 255;
      }
    }
    layers.push({
      type: 'image',
      image,
      x0: plane.x[0],
      y0: plane.y[0],
      x1: plane.x[plane.nx - 1],
      y1: plane.y[plane.ny - 1],
      smooth: true,
    });
  }
  return {
    viewport: tab.viewport,
    layers,
    showGrid: false,
    showMinorGrid: false,
    showAxes: tab.showAxes,
    xLabel: 'x (nm)',
    yLabel: 'y (nm)',
    legend: [],
  };
}

/** Black through violet to white: zero is dark, so nodes read as nodes. */
function hotColour(t: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, t));
  return [
    Math.round(255 * Math.min(1, v * 1.6)),
    Math.round(255 * Math.max(0, Math.min(1, v * 1.6 - 0.5))),
    Math.round(255 * Math.max(0, Math.min(1, v * 2.2 - 0.15))),
  ];
}

/** Blue–black–orange, so the sign of ψ is visible rather than implied. */
function divergingPair(t: number): [number, number, number] {
  const v = Math.max(-1, Math.min(1, t));
  if (v >= 0) return [Math.round(255 * v), Math.round(160 * v), Math.round(40 * v)];
  return [Math.round(50 * -v), Math.round(140 * -v), Math.round(255 * -v)];
}

// ------------------------------------------------------------------ panel

export function QuantumPanel({ tab }: { tab: TabState }) {
  const cfg = tab.quantum;
  const world = cfg.world;
  const setQuantum = useStore((s) => s.setQuantum);
  const commit = useStore((s) => s.commit);
  const patchActive = useStore((s) => s.patchActive);

  const setWorld = useCallback(
    (patch: Partial<QuantumWorld>) => {
      commit();
      setQuantum({ world: { ...world, ...patch } });
      // Any change to the problem invalidates the clock, exactly as in the
      // other sandboxes: a packet halfway through an evolution of a potential
      // that no longer exists is not a thing anyone wants to look at.
      patchActive({ timeline: { ...tab.timeline, t: 0, playing: false } });
    },
    [commit, setQuantum, world, patchActive, tab.timeline],
  );

  const selected = world.features.find((f) => f.id === cfg.selectedId) ?? null;
  const labels = selected ? fieldLabels(selected.kind) : null;

  const patchFeature = (patch: Partial<PotentialFeature>) => {
    if (!selected) return;
    setWorld({ features: world.features.map((f) => (f.id === selected.id ? { ...f, ...patch } : f)) });
  };

  return (
    <>
      <Panel title="Problem">
        <Field label="Equation to solve">
          <SegmentedControl
            size="sm"
            value={world.view}
            onChange={(view) => setWorld({ view })}
            options={VIEW_OPTIONS}
          />
        </Field>

        <Row>
          <div className="flex-1">
            <Field label="Mass (mₑ)">
            <NumberField value={world.mass} min={0.01} max={2000} step={0.05} onChange={(mass) => setWorld({ mass })} />
          </Field>
        </div>
          <div className="flex-1">
            <Field label="Grid points">
            <NumberField
              value={world.points}
              min={64}
              max={2000}
              step={20}
              precision={0}
              onChange={(points) => setWorld({ points: Math.round(points) })}
            />
          </Field>
        </div>
        </Row>
        <p className="px-0.5 text-2xs text-ink-faint">
          An electron is 1. Silicon's conduction electrons behave like 0.26; a proton is 1836.
        </p>

        <Row>
          <div className="flex-1">
            <Field label="x from (nm)">
            <NumberField value={world.xMin} step={0.5} onChange={(xMin) => setWorld({ xMin })} />
          </Field>
        </div>
          <div className="flex-1">
            <Field label="to">
            <NumberField value={world.xMax} step={0.5} onChange={(xMax) => setWorld({ xMax })} />
          </Field>
        </div>
        </Row>
      </Panel>

      {world.view === 'plane' && (
        <Panel title="Two dimensions">
          <Field label="Shape">
            <Select
              value={world.plane.shape}
              onChange={(shape) => setWorld({ plane: { ...world.plane, shape } })}
              options={[
                { value: 'box', label: 'Rectangular box' },
                { value: 'circle', label: 'Circular well' },
                { value: 'harmonic', label: 'Harmonic trap' },
                { value: 'separable', label: 'Your features, in both axes' },
              ]}
            />
          </Field>
          <Field label="Size (nm)">
            <Slider
              value={world.plane.size}
              min={0.2}
              max={5}
              step={0.05}
              onChange={(size) => setWorld({ plane: { ...world.plane, size } })}
            />
          </Field>
          {world.plane.shape !== 'circle' && (
            <Field label="Aspect ratio" hint="Exactly 1 makes the box square, and the levels degenerate.">
              <Slider
                value={world.plane.aspect}
                min={0.4}
                max={3}
                step={0.01}
                onChange={(aspect) => setWorld({ plane: { ...world.plane, aspect } })}
              />
            </Field>
          )}
          {world.plane.shape !== 'box' && (
            <Field label="Depth (eV)">
              <NumberField
                value={world.plane.depth}
                min={0.1}
                step={5}
                onChange={(depth) => setWorld({ plane: { ...world.plane, depth } })}
              />
            </Field>
          )}
          <Row>
            <div className="flex-1">
            <Field label="Grid">
              <NumberField
                value={world.plane.points}
                min={24}
                max={160}
                step={10}
                precision={0}
                onChange={(points) => setWorld({ plane: { ...world.plane, points: Math.round(points) } })}
              />
            </Field>
          </div>
            <div className="flex-1">
            <Field label="States">
              <NumberField
                value={world.plane.levels}
                min={1}
                max={20}
                step={1}
                precision={0}
                onChange={(levels) => setWorld({ plane: { ...world.plane, levels: Math.round(levels) } })}
              />
            </Field>
          </div>
          </Row>
          <Toggle
            label="Show |ψ|² instead of ψ"
            checked={cfg.probability}
            onChange={(probability) => setQuantum({ probability })}
          />
        </Panel>
      )}

      {/* Three of the four two-dimensional shapes build their own potential,
        * so the feature list is not just unused there but actively misleading —
        * it invites edits that change nothing on screen. */}
      {(world.view !== 'plane' || world.plane.shape === 'separable') && (
        <>
      <Panel title="Potential">
        <div className="flex flex-wrap gap-1">
          {FEATURES.map((f) => (
            <button
              key={f.kind}
              type="button"
              title={f.hint}
              data-feature={f.kind}
              onClick={() => {
                const centre = (world.xMin + world.xMax) / 2;
                const added = newFeature(f.kind, centre);
                commit();
                setQuantum({ world: { ...world, features: [...world.features, added] }, selectedId: added.id });
              }}
              className="rounded-md border border-dashed border-edge px-2 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
            >
              + {f.label}
            </button>
          ))}
        </div>

        <div className="space-y-1.5">
          {world.features.map((f) => (
            <div
              key={f.id}
              className={`rounded-md border px-2 py-1.5 transition-colors ${
                f.id === cfg.selectedId ? 'border-accent-deep bg-accent/10' : 'border-edge bg-surface-1'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex-1 text-left text-2xs text-ink"
                  onClick={() => setQuantum({ selectedId: f.id })}
                >
                  {FEATURE_BY_KIND.get(f.kind)?.label ?? f.kind}
                  <span className="ml-1.5 text-ink-faint">
                    at {fmt(f.centre, 3)} nm
                    {f.kind !== 'step' && f.kind !== 'linear' ? `, ${fmt(f.width, 3)} nm wide` : ''}
                  </span>
                </button>
                <IconButton
                  title="Remove"
                  onClick={() => setWorld({ features: world.features.filter((x) => x.id !== f.id) })}
                >
                  <IconTrash size={13} />
                </IconButton>
              </div>
            </div>
          ))}
          {world.features.length === 0 && (
            <p className="py-2 text-center text-2xs text-ink-faint">
              No features: an empty box, which is the infinite square well.
            </p>
          )}
        </div>

        {selected && labels && (
          <div className="space-y-2 rounded-md border border-edge bg-surface-1 p-2">
            <Field label="Centre (nm)">
              <Slider
                value={selected.centre}
                min={world.xMin}
                max={world.xMax}
                step={(world.xMax - world.xMin) / 400}
                onChange={(centre) => patchFeature({ centre })}
              />
            </Field>
            {selected.kind !== 'step' && selected.kind !== 'linear' && (
              <Field label={`${labels.width} (nm)`}>
                <Slider
                  value={selected.width}
                  min={0.02}
                  max={Math.max(0.5, (world.xMax - world.xMin) / 2)}
                  step={0.01}
                  onChange={(width) => patchFeature({ width })}
                />
              </Field>
            )}
            <Field label={`${labels.height} (${labels.unit})`}>
              <Slider
                value={selected.height}
                min={selected.kind === 'linear' ? -20 : 0}
                max={40}
                step={0.05}
                onChange={(height) => patchFeature({ height })}
              />
            </Field>
          </div>
        )}

        <Field label="Extra V(x), in eV" hint="Added to whatever the features build. Leave empty for none.">
          <input
            type="text"
            value={world.expression}
            spellCheck={false}
            onChange={(e) => setWorld({ expression: e.target.value })}
            placeholder="e.g. 0.5*x^2 or 3*sin(4x)"
            className="input-base w-full font-mono"
          />
        </Field>
      </Panel>
        </>
      )}

      {world.view === 'bound' && (
        <Panel title="Levels">
          <Field label="How many to find">
            <NumberField
              value={world.levels}
              min={1}
              max={24}
              step={1}
              precision={0}
              onChange={(levels) => setWorld({ levels: Math.round(levels) })}
            />
          </Field>
          <Toggle
            label="Draw each state on its own level"
            hint="The textbook picture: every wavefunction sits on the energy it belongs to."
            checked={cfg.stacked}
            onChange={(stacked) => setQuantum({ stacked })}
          />
          <Toggle
            label="Show |ψ|² instead of ψ"
            hint="The probability density — what a measurement would actually find."
            checked={cfg.probability}
            onChange={(probability) => setQuantum({ probability })}
          />
          <Field label="Wavefunction scale">
            <Slider value={cfg.scale} min={0.2} max={4} step={0.05} onChange={(scale) => setQuantum({ scale })} />
          </Field>
        </Panel>
      )}

      {world.view === 'evolve' && (
        <Panel title="Wavepacket">
          <Field label="Starts at (nm)">
            <Slider
              value={world.packet.centre}
              min={world.xMin}
              max={world.xMax}
              step={(world.xMax - world.xMin) / 400}
              onChange={(centre) => setWorld({ packet: { ...world.packet, centre } })}
            />
          </Field>
          <Field label="Width σ (nm)">
            <Slider
              value={world.packet.width}
              min={0.05}
              max={Math.max(1, (world.xMax - world.xMin) / 6)}
              step={0.01}
              onChange={(width) => setWorld({ packet: { ...world.packet, width } })}
            />
          </Field>
          <Field label="Wavenumber k (nm⁻¹)" hint={`Kinetic energy ${fmt(freeEnergy(world.packet.momentum, world.mass), 4)} eV`}>
            <Slider
              value={world.packet.momentum}
              min={-40}
              max={40}
              step={0.1}
              onChange={(momentum) => setWorld({ packet: { ...world.packet, momentum } })}
            />
          </Field>
          <Field label="Run for (fs)">
            <NumberField value={world.duration} min={0.1} max={500} step={1} onChange={(duration) => setWorld({ duration })} />
          </Field>
          <Toggle
            label="Absorb at the edges"
            hint="Soaks the packet up when it reaches the wall instead of bouncing it back. What leaves has left."
            checked={world.absorbing}
            onChange={(absorbing) => setWorld({ absorbing })}
          />
        </Panel>
      )}

      {world.view === 'scatter' && (
        <Panel title="Energies to sweep">
          <Row>
            <div className="flex-1">
            <Field label="From (eV)">
              <NumberField value={world.scatterMin} min={0.001} step={0.1} onChange={(scatterMin) => setWorld({ scatterMin })} />
            </Field>
          </div>
            <div className="flex-1">
            <Field label="To (eV)">
              <NumberField value={world.scatterMax} min={0.01} step={0.5} onChange={(scatterMax) => setWorld({ scatterMax })} />
            </Field>
          </div>
          </Row>
          <Callout kind="info">
            Transmission is computed by transfer matrix, which is exact for a potential made of flat
            steps. Where a closed form exists it is drawn dashed on the same axes.
          </Callout>
        </Panel>
      )}

      <Panel title="Display">
        <Toggle
          label="Governing equations"
          checked={cfg.showEquations}
          onChange={(showEquations) => setQuantum({ showEquations })}
        />
      </Panel>

      <ViewPanel tab={tab} />
    </>
  );
}

// ------------------------------------------------------------------ surface

export function QuantumSurface({ tab }: { tab: TabState }) {
  const cfg = tab.quantum;
  const world = cfg.world;
  const setQuantum = useStore((s) => s.setQuantum);
  const setViewport = useStore((s) => s.setViewport);
  const plotRef = usePlot2DRef();
  const fitViewport = useStore((s) => s.fitViewport);

  // The free-form V(x) shares the expression engine with every other mode, so
  // sliders and definitions in this tab work inside it too.
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);
  const extra = useMemo(() => {
    if (!world.expression.trim()) return undefined;
    const { fn, error } = scope.compile1(world.expression, 'x');
    return error ? undefined : fn;
  }, [scope, world.expression]);
  const expressionError = useMemo(() => {
    if (!world.expression.trim()) return null;
    return scope.compile1(world.expression, 'x').error;
  }, [scope, world.expression]);

  const solution = useSolution(world, extra, world.view === 'evolve' ? world.duration : 0);

  /* The two-dimensional view is a picture of a region, not a graph, so it gets
   * square axes and a viewport that frames the well. Without both, a circular
   * well is drawn as an ellipse somewhere off to one side of an energy axis
   * that means nothing here. */
  useSquareScales(plotRef, tab.viewport, world.view === 'plane');
  /* The wavepacket view frames itself once, around the potential and the
   * energy the packet is actually at. Left at the bound-state framing, a
   * packet launched at 3.6 eV in a window that stops at 4 is drawn in the top
   * two per cent of the plot and clipped. */
  useEffect(() => {
    if (world.view !== 'evolve' || !solution.traj || solution.traj.count === 0) return;
    const traj = solution.traj;
    const floor = Math.min(minOf(traj.v), 0);
    const energy = traj.energy[0] ?? 0;
    const range = Math.max(1, energy - floor);
    const yMin = floor - range * 0.15;
    const yMax = energy + range * 0.55;
    if (Math.abs(tab.viewport.yMin - yMin) < range * 0.02 && Math.abs(tab.viewport.yMax - yMax) < range * 0.02) return;
    fitViewport({ xMin: world.xMin, xMax: world.xMax, yMin, yMax });
    // Only when the problem changes; panning afterwards is the user's business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.view, solution.traj, fitViewport]);

  useEffect(() => {
    if (world.view !== 'plane' || !solution.plane) return;
    const p = solution.plane;
    const halfX = Math.abs(p.x[p.nx - 1]) * 1.05;
    const halfY = Math.abs(p.y[p.ny - 1]) * 1.05;
    const already =
      Math.abs(tab.viewport.xMin + halfX) < halfX * 0.02 && Math.abs(tab.viewport.xMax - halfX) < halfX * 0.02;
    if (already) return;
    fitViewport({ xMin: -halfX, xMax: halfX, yMin: -halfY, yMax: halfY });
    // Only when the shape of the problem changes, not on every pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.view, solution.plane, fitViewport]);
  const scene = useMemo(
    () => buildScene(tab, solution, extra),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, solution, solution.traj?.count, extra],
  );
  const analytic = useMemo(() => analyseQuantum(world, solution.states), [world, solution.states]);

  const scatter = useMemo(() => (world.view === 'scatter' ? scatterCurve(world, 260, extra) : null), [world, extra]);

  const traces = useMemo((): Trace[] => {
    const traj = solution.traj;
    if (world.view !== 'evolve' || !traj || traj.count === 0) return [];
    const time = traj.time.subarray(0, traj.count);
    return [
      {
        id: 'left',
        label: 'Reflected',
        unit: '',
        colour: SERIES_COLOURS[1],
        xs: time,
        ys: traj.left.subarray(0, traj.count),
      },
      {
        id: 'right',
        label: 'Transmitted',
        unit: '',
        colour: SERIES_COLOURS[2],
        xs: time,
        ys: traj.right.subarray(0, traj.count),
      },
    ];
    // `count` is in the dependencies because `advanceWave` fills the same
    // arrays in place: without it these memos are computed once, while the
    // trajectory is still one frame long, and never again.
  }, [solution.traj, solution.traj?.count, world.view]);

  const positionTrace = useMemo((): Trace[] => {
    const traj = solution.traj;
    if (world.view !== 'evolve' || !traj || traj.count === 0) return [];
    return [
      {
        id: 'x',
        label: '⟨x⟩',
        unit: 'nm',
        colour: SERIES_COLOURS[0],
        xs: traj.time.subarray(0, traj.count),
        ys: traj.meanX.subarray(0, traj.count),
      },
      {
        id: 'sigma',
        label: 'σ',
        unit: 'nm',
        colour: SERIES_COLOURS[3],
        xs: traj.time.subarray(0, traj.count),
        ys: traj.spread.subarray(0, traj.count),
      },
    ];
  }, [solution.traj, solution.traj?.count, world.view]);

  const onPointerDown = useCallback(
    (x: number) => {
      // Clicking near a feature selects it, which is quicker than finding it
      // in the list once there are four of them.
      let best: string | null = null;
      let bestDistance = (world.xMax - world.xMin) * 0.03;
      for (const f of world.features) {
        const d = Math.abs(f.centre - x);
        if (d < bestDistance) {
          bestDistance = d;
          best = f.id;
        }
      }
      if (best) setQuantum({ selectedId: best });
    },
    [world.features, world.xMin, world.xMax, setQuantum],
  );

  const frame = solution.traj ? waveFrameAt(solution.traj, tab.timeline.t) : 0;

  return (
    <SandboxLayout
      storageKey="quantum"
      canvas={
        <div className="flex h-full w-full flex-col">
          <div className="relative min-h-0 flex-1">
            <Plot2D
              ref={plotRef}
              scene={scene}
              onViewportChange={setViewport}
              onPointerDown={(e) => onPointerDown(e.x)}
              readout={(x, y) =>
                world.view === 'plane' ? `${x.toFixed(3)} nm, ${y.toFixed(3)} nm` : `${x.toFixed(3)} nm, ${y.toFixed(3)} eV`
              }
            />
            {expressionError && (
              <div className="pointer-events-none absolute inset-x-3 bottom-3">
                <Callout kind="warn">{expressionError}</Callout>
              </div>
            )}
          </div>
        </div>
      }
      instruments={
        <>
          {world.view === 'bound' && solution.states && (
            <LevelLadder states={solution.states} level={cfg.level} onPick={(level) => setQuantum({ level })} />
          )}

          {world.view === 'plane' && solution.plane && (
            <PlaneLadder plane={solution.plane} level={cfg.level} onPick={(level) => setQuantum({ level })} />
          )}

          {world.view === 'scatter' && scatter && <ScatterPlot curve={scatter} />}

          {world.view === 'evolve' && solution.traj && (
            <>
              <ProbePlot traces={traces} xLabel="t (fs)" cursorTime={solution.traj.time[frame] ?? null} height={170} />
              <ProbePlot traces={positionTrace} xLabel="t (fs)" cursorTime={solution.traj.time[frame] ?? null} height={170} />
              <div className="border-t border-edge px-3 py-2.5">
                <StatList>
                  <Stat label="Norm" value={fmt(solution.traj.norm[frame] ?? 1, 6)} />
                  <Stat label="⟨E⟩" value={`${fmt(solution.traj.energy[frame] ?? 0, 5)} eV`} emphasis />
                  <Stat label="⟨x⟩" value={`${fmt(solution.traj.meanX[frame] ?? 0, 4)} nm`} />
                  <Stat label="σₓ" value={`${fmt(solution.traj.spread[frame] ?? 0, 4)} nm`} />
                  <Stat label="Transmitted" value={fmt(solution.traj.right[frame] ?? 0, 4)} />
                  <Stat label="Reflected" value={fmt(solution.traj.left[frame] ?? 0, 4)} />
                </StatList>
              </div>
            </>
          )}

          {cfg.showEquations && <AnalyticCard result={analytic} />}
        </>
      }
    />
  );
}

function LevelLadder({
  states,
  level,
  onPick,
}: {
  states: BoundStates;
  level: number;
  onPick: (level: number) => void;
}) {
  return (
    <Collapsible title={`Energy levels · ${states.energies.length}`} defaultOpen>
      <p className="px-1 pb-1.5 text-2xs text-ink-faint">
        {states.bound === 0
          ? 'Nothing is bound: every level here is held in by the walls of the simulation.'
          : `${states.bound} bound state${states.bound === 1 ? '' : 's'}; the rest are the box's own standing waves.`}
      </p>
      <div className="space-y-0.5">
        {Array.from(states.energies, (energy, i) => (
          <button
            key={i}
            type="button"
            data-level={i}
            onClick={() => onPick(i)}
            className={`flex w-full items-baseline justify-between rounded px-2 py-1 text-2xs transition-colors ${
              i === level ? 'bg-accent/15 text-ink' : 'text-ink-dim hover:bg-surface-2'
            }`}
          >
            <span className="font-mono">
              n = {i + 1}
              {i >= states.bound && <span className="ml-1.5 text-warn">unbound</span>}
            </span>
            <span className="font-mono">{fmt(energy, 5)} eV</span>
          </button>
        ))}
      </div>
      {states.energies.length > 1 && (
        <div className="mt-2 border-t border-edge pt-2">
          <StatList>
            <Stat label="E₂ − E₁" value={`${fmt(states.energies[1] - states.energies[0], 5)} eV`} />
            <Stat
              label="Photon wavelength"
              value={`${fmt(1239.84 / Math.max(1e-9, states.energies[1] - states.energies[0]), 5)} nm`}
            />
          </StatList>
        </div>
      )}
    </Collapsible>
  );
}

function PlaneLadder({
  plane,
  level,
  onPick,
}: {
  plane: PlaneStates;
  level: number;
  onPick: (level: number) => void;
}) {
  return (
    <Collapsible title={`States · ${plane.count}`} defaultOpen>
      <div className="space-y-0.5">
        {Array.from({ length: plane.count }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPick(i)}
            className={`flex w-full items-baseline justify-between rounded px-2 py-1 text-2xs transition-colors ${
              i === level ? 'bg-accent/15 text-ink' : 'text-ink-dim hover:bg-surface-2'
            }`}
          >
            <span className="font-mono">{plane.labels[i]}</span>
            <span className="font-mono">{fmt(plane.energies[i], 5)} eV</span>
          </button>
        ))}
      </div>
      <p className="px-1 pt-2 text-2xs text-ink-faint">
        Two states at the same energy are degenerate. A square box has them because nₓ and n_y can
        swap; make it slightly oblong and they separate.
      </p>
    </Collapsible>
  );
}

function ScatterPlot({ curve }: { curve: ReturnType<typeof scatterCurve> }) {
  const traces: Trace[] = [
    {
      id: 'T',
      label: 'Transmission',
      unit: '',
      colour: SERIES_COLOURS[0],
      xs: curve.energy,
      ys: curve.transmitted,
      ...(curve.analytic ? { predicted: curve.analytic, predictedLabel: curve.analyticLabel ?? 'Closed form' } : {}),
    },
  ];
  let resonance: number | null = null;
  for (let i = 1; i < curve.transmitted.length - 1; i++) {
    if (curve.transmitted[i] > 0.999 && curve.transmitted[i] >= curve.transmitted[i - 1]) {
      resonance = curve.energy[i];
      break;
    }
  }
  return (
    <>
      <ProbePlot traces={traces} xLabel="E (eV)" cursorTime={null} height={230} />
      <div className="border-t border-edge px-3 py-2.5">
        <StatList>
          <Stat label="T at the lowest energy" value={fmt(curve.transmitted[0], 5)} />
          <Stat label="T at the highest" value={fmt(curve.transmitted[curve.transmitted.length - 1], 5)} />
          {resonance !== null && <Stat label="First resonance" value={`${fmt(resonance, 4)} eV`} emphasis />}
        </StatList>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ export

export function quantumCsv(tab: TabState): string | null {
  const world = tab.quantum.world;
  if (world.view === 'scatter') {
    const curve = scatterCurve(world, 400);
    const headers = ['energy_eV', 'transmission'];
    if (curve.analytic) headers.push('closed_form');
    return toCsv(
      headers,
      Array.from(curve.energy, (E, i) =>
        curve.analytic ? [E, curve.transmitted[i], curve.analytic[i]] : [E, curve.transmitted[i]],
      ),
    );
  }
  if (world.view === 'plane') {
    const plane = solvePlaneStates(world);
    return toCsv(
      ['state', 'label', 'energy_eV'],
      Array.from({ length: plane.count }, (_, i) => [i + 1, plane.labels[i], plane.energies[i]]),
    );
  }
  const states = solveBoundStates(world);
  const headers = ['x_nm', 'V_eV', ...Array.from(states.energies, (_, s) => `psi_${s + 1}`)];
  return toCsv(
    headers,
    Array.from({ length: states.n }, (_, i) => [
      states.x[i],
      states.v[i],
      ...Array.from(states.energies, (_, s) => states.psi[s * states.n + i]),
    ]),
  );
}
