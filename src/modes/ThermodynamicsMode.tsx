import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import type { TabState } from '../core/types';
import {
  BOLTZMANN,
  advanceGas,
  boxArea,
  carnotEfficiency,
  createGas,
  kineticEnergy,
  maxwellBoltzmann2D,
  measureIsotherm,
  speedHistogram,
  speedMoments,
  speeds as speedsOf,
  temperatureOf,
  traceCycle,
  type CycleLeg,
  type GasState,
  type GasWorld,
  type IsothermPoint,
  type ProcessKind,
} from '../core/physics/thermo';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { useSquareScales } from '../components/sandbox/useSquareScales';
import { AnalyticCard } from '../components/sandbox/AnalyticCard';
import type { AnalyticResult } from '../core/physics/analytic';
import {
  Button,
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
import { IconPlus, IconTrash } from '../components/ui/Icons';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* Thermodynamics and kinetic theory.
 *
 * The claim this mode makes is that the gas laws are not inputs. There is a
 * box of hard discs; they collide elastically with each other and with the
 * walls; and everything else on screen is measured off that.
 *
 *   Box — the discs themselves, with the temperature read from their speeds
 *     and the pressure from the momentum the walls receive. Move the piston
 *     and the gas heats, because a wall coming towards a disc sends it back
 *     faster. Nothing applies an adiabatic formula.
 *   Speeds — the histogram, with the Maxwell–Boltzmann curve drawn over it.
 *     Start every particle at the same speed and watch the curve appear out
 *     of nothing but collisions.
 *   Cycle — a PV loop you define, integrated leg by leg, with the work and
 *     heat from the first law and an efficiency that is a division of two
 *     measured numbers.
 *   Gas law — pressure measured at a series of box sizes. P against 1/A comes
 *     out straight with slope NkT, which is the ideal gas law arriving as a
 *     fit to data rather than as an assumption.
 *
 * Two dimensions throughout, so ⟨½mv²⟩ = kT, the speed distribution is the
 * Rayleigh one, and the gas law reads PA = NkT with A an area.
 */

const VIEWS = [
  { value: 'box' as const, label: 'Box', title: 'The particles themselves, with a piston.' },
  { value: 'speeds' as const, label: 'Speeds', title: 'The speed histogram against Maxwell–Boltzmann.' },
  { value: 'cycle' as const, label: 'PV cycle', title: 'A cycle you define, accounted for by the first law.' },
  { value: 'gaslaw' as const, label: 'Gas law', title: 'Pressure measured at a series of volumes.' },
];

const PROCESSES: { value: ProcessKind; label: string }[] = [
  { value: 'isothermal', label: 'Isothermal' },
  { value: 'isobaric', label: 'Isobaric' },
  { value: 'isochoric', label: 'Isochoric' },
  { value: 'adiabatic', label: 'Adiabatic' },
];

const WALL = '#64748b';
const MAXWELL = '#fbbf24';
const HIST = '#38bdf8';
const CYCLE = '#f472b6';
const IDEAL = '#4ade80';

/** Blue through to red across the speed range, so the fast ones stand out. */
const SPEED_BANDS = ['#60a5fa', '#22d3ee', '#4ade80', '#facc15', '#fb923c', '#f87171'];

const GAS_CONSTANT_JOULE = 8.314462618;

// ------------------------------------------------------------------ the run

interface GasFrame {
  t: number;
  xs: Float32Array;
  ys: Float32Array;
  speeds: Float32Array;
  temperature: number;
  pressure: number;
  area: number;
  width: number;
  height: number;
  energy: number;
  wallWork: number;
  collisions: number;
}

interface GasRun {
  frames: GasFrame[];
  live: GasState;
  /** Simulation seconds between stored frames. */
  step: number;
}

const FRAME_STEP = 1 / 30;

function worldOf(cfg: TabState['thermodynamics']): GasWorld {
  return {
    count: cfg.count,
    width: cfg.boxWidth,
    height: cfg.boxHeight,
    radius: cfg.radius,
    mass: cfg.particleMass,
    temperature: cfg.temperature,
    thermostat: cfg.thermostat,
    seed: cfg.seed,
    gravity: cfg.gravity,
  };
}

function snapshot(state: GasState): GasFrame {
  const n = state.particles.length;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const speeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = state.particles[i];
    xs[i] = p.x;
    ys[i] = p.y;
    speeds[i] = Math.hypot(p.vx, p.vy);
  }
  return {
    t: state.time,
    xs,
    ys,
    speeds,
    temperature: temperatureOf(state),
    pressure: state.pressure,
    area: boxArea(state),
    width: state.world.width,
    height: state.world.height,
    energy: kineticEnergy(state),
    wallWork: state.wallWork,
    collisions: state.collisions,
  };
}

/**
 * The gas, integrated once and kept.
 *
 * A hard-disc gas is not time-reversible in practice — the collision resolution
 * throws away exactly the information you would need to run it backwards — so
 * scrubbing has to replay stored frames rather than re-integrate. Keeping them
 * in a ref keyed by the world means dragging the scrubber back and forth shows
 * the same gas both times, which is the difference between a simulation and an
 * animation.
 */
function useGas(cfg: TabState['thermodynamics'], until: number): { run: GasRun; ready: boolean } {
  const signature = useMemo(
    () =>
      JSON.stringify([
        cfg.count,
        cfg.boxWidth,
        cfg.boxHeight,
        cfg.radius,
        cfg.particleMass,
        cfg.temperature,
        cfg.thermostat,
        cfg.gravity,
        cfg.seed,
        cfg.identicalSpeeds,
        cfg.pistonSpeed,
      ]),
    [cfg],
  );
  const ref = useRef<{ signature: string; run: GasRun } | null>(null);
  const [, bump] = useState(0);

  if (!ref.current || ref.current.signature !== signature) {
    const live = createGas(worldOf(cfg), cfg.identicalSpeeds);
    ref.current = { signature, run: { frames: [snapshot(live)], live, step: FRAME_STEP } };
  }
  const run = ref.current.run;

  // The piston has to stop somewhere: a wall that keeps going reaches the
  // opposite wall and the discs have nowhere to be.
  const minWidth = Math.max(cfg.radius * 3, cfg.boxWidth * 0.25);
  const maxWidth = cfg.boxWidth * 3;

  // A bounded slice per animation frame, so a thousand particles cannot lock
  // the window while the run catches up with the scrubber.
  const budget = 40;
  let produced = 0;
  while (run.live.time < until - 1e-9 && produced < budget) {
    const w = run.live.world.width;
    run.live.wallVx = cfg.pistonSpeed < 0 ? (w > minWidth ? cfg.pistonSpeed : 0) : w < maxWidth ? cfg.pistonSpeed : 0;
    advanceGas(run.live, Math.min(FRAME_STEP, until - run.live.time));
    run.frames.push(snapshot(run.live));
    produced++;
  }
  const ready = run.live.time >= until - 1e-9;

  useEffect(() => {
    if (ready) return undefined;
    const id = requestAnimationFrame(() => bump((n) => n + 1));
    return () => cancelAnimationFrame(id);
  }, [ready, until, signature]);

  return { run, ready };
}

const frameAt = (run: GasRun, t: number): GasFrame => {
  const i = Math.max(0, Math.min(run.frames.length - 1, Math.round(t / run.step)));
  return run.frames[i];
};

// ------------------------------------------------------------------- scenes

function boxScene(tab: TabState, run: GasRun, frame: GasFrame): PlotScene {
  const cfg = tab.thermodynamics;
  const layers: Layer[] = [];

  // The box, drawn at its current size so a compression is visible as one.
  layers.push({
    type: 'rect',
    x0: -frame.width,
    y0: -frame.height,
    x1: frame.width,
    y1: frame.height,
    fill: withAlpha(WALL, 0.06),
    stroke: WALL,
  });

  if (cfg.showTrails) {
    // A short tail per particle, which is what makes a mean free path visible
    // rather than merely quotable.
    const back = Math.max(0, Math.round(0.25 / run.step));
    const past = run.frames[Math.max(0, run.frames.indexOf(frame) - back)] ?? frame;
    const data = new Float64Array(frame.xs.length * 4);
    for (let i = 0; i < frame.xs.length; i++) {
      data[i * 4] = past.xs[i];
      data[i * 4 + 1] = past.ys[i];
      data[i * 4 + 2] = frame.xs[i];
      data[i * 4 + 3] = frame.ys[i];
    }
    layers.push({ type: 'segments', data, colour: withAlpha(HIST, 0.35), width: 1 });
  }

  const radius = Math.max(1.2, Math.min(6, 1.6 + 120 * cfg.radius));
  if (cfg.colourBySpeed) {
    /* Banded rather than a continuous ramp, because the plot's point layer
     * takes one colour per layer. Six bands is enough to see the fast tail
     * without turning the box into confetti. */
    const rms = Math.sqrt((2 * BOLTZMANN * Math.max(1e-12, frame.temperature)) / cfg.particleMass);
    const top = rms * 2.2;
    const bands: { xs: number[]; ys: number[] }[] = SPEED_BANDS.map(() => ({ xs: [], ys: [] }));
    for (let i = 0; i < frame.xs.length; i++) {
      const k = Math.max(0, Math.min(SPEED_BANDS.length - 1, Math.floor((frame.speeds[i] / top) * SPEED_BANDS.length)));
      bands[k].xs.push(frame.xs[i]);
      bands[k].ys.push(frame.ys[i]);
    }
    bands.forEach((b, k) => {
      if (!b.xs.length) return;
      layers.push({ type: 'points', xs: b.xs, ys: b.ys, colour: SPEED_BANDS[k], radius });
    });
  } else {
    layers.push({ type: 'points', xs: frame.xs, ys: frame.ys, colour: HIST, radius });
  }

  if (cfg.pistonSpeed !== 0) {
    // The moving wall, marked so it is obvious which one is doing the work.
    for (const x of [-frame.width, frame.width]) {
      layers.push({
        type: 'polyline',
        xs: [x, x],
        ys: [-frame.height, frame.height],
        colour: CYCLE,
        width: 3,
      });
    }
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: false,
    showMinorGrid: false,
    showAxes: tab.showAxes,
    xLabel: 'x',
    yLabel: 'y',
    caption: `t = ${fmt(frame.t, 4)}   ·   ${frame.collisions.toLocaleString()} collisions so far`,
  };
}

function speedScene(tab: TabState, frame: GasFrame): PlotScene {
  const cfg = tab.thermodynamics;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];

  const values = Array.from(frame.speeds);
  const rms = Math.sqrt((2 * BOLTZMANN * Math.max(1e-12, frame.temperature)) / cfg.particleMass);
  const top = Math.max(1e-9, rms * 3);
  const hist = speedHistogram(values, cfg.histogramBins, top);

  layers.push({
    type: 'bars',
    edges: hist.edges,
    heights: hist.density,
    colour: withAlpha(HIST, 0.55),
    stroke: HIST,
  });
  legend.push({ label: 'measured', colour: HIST });

  if (cfg.showMaxwell) {
    const n = 300;
    const xs = new Float64Array(n + 1);
    const ys = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const v = (top * i) / n;
      xs[i] = v;
      // Drawn at the temperature measured from the particles at this instant,
      // not at the temperature the box was set to — so during a compression
      // the curve moves with the gas instead of lying about it.
      ys[i] = maxwellBoltzmann2D(v, frame.temperature, cfg.particleMass);
    }
    layers.push({ type: 'polyline', xs, ys, colour: MAXWELL, width: 2.4 });
    legend.push({ label: 'Maxwell–Boltzmann', colour: MAXWELL });

    /* The three characteristic speeds, which in two dimensions sit at √(kT/m),
     * √(πkT/2m) and √(2kT/m) — close enough together that the vline's own
     * label would print all three on top of each other. Labelled with markers
     * at staggered heights instead. */
    const moments = speedMoments(frame.temperature, cfg.particleMass);
    const peak = maxwellBoltzmann2D(moments.mode, frame.temperature, cfg.particleMass);
    const marks: [number, string, number][] = [
      [moments.mode, 'most likely', 0.95],
      [moments.mean, 'mean', 0.78],
      [moments.rms, 'rms', 0.61],
    ];
    for (const [x, label, height] of marks) {
      layers.push({ type: 'vline', x, colour: withAlpha(MAXWELL, 0.55), style: 'dashed', width: 1 });
      layers.push({
        type: 'marker',
        x,
        y: peak * height,
        label,
        colour: withAlpha(MAXWELL, 0.85),
        radius: 0,
        offset: [6, 0],
      });
    }
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'speed',
    yLabel: 'probability density',
    legend,
    caption: `t = ${fmt(frame.t, 4)}   ·   T = ${fmt(frame.temperature, 4)}`,
  };
}

function cycleScene(tab: TabState): PlotScene {
  const cfg = tab.thermodynamics;
  const result = traceCycle(
    cfg.cycle,
    { v: cfg.startVolume, t: cfg.startTemperature },
    cfg.moles,
    GAS_CONSTANT_JOULE,
    cfg.degreesOfFreedom,
    160,
  );
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];

  const KIND_COLOUR: Record<ProcessKind, string> = {
    isothermal: '#38bdf8',
    isobaric: '#4ade80',
    isochoric: '#f472b6',
    adiabatic: '#fbbf24',
  };

  const seen = new Set<ProcessKind>();
  for (const legResult of result.legs) {
    const colour = KIND_COLOUR[legResult.kind];
    layers.push({
      type: 'polyline',
      xs: Float64Array.from(legResult.points.map((p) => p.v)),
      ys: Float64Array.from(legResult.points.map((p) => p.p)),
      colour,
      width: 2.4,
    });
    if (!seen.has(legResult.kind)) {
      seen.add(legResult.kind);
      legend.push({ label: legResult.kind, colour });
    }
  }

  // Corners, so the sequence of states is readable off the loop.
  const corners = result.legs.map((l) => l.points[0]).filter(Boolean);
  if (corners.length) {
    layers.push({
      type: 'points',
      xs: corners.map((p) => p.v),
      ys: corners.map((p) => p.p),
      colour: '#e2e8f0',
      radius: 4,
      stroke: '#0f172a',
    });
    corners.forEach((p, i) => {
      layers.push({
        type: 'marker',
        x: p.v,
        y: p.p,
        label: String(i + 1),
        colour: '#e2e8f0',
        radius: 0,
        offset: [8, -8],
      });
    });
  }

  if (cfg.showCarnot) {
    // The two isotherms the cycle runs between, as a reminder of what the
    // efficiency is being compared with.
    const temps = result.legs.flatMap((l) => l.points.map((p) => p.t));
    if (temps.length) {
      const hot = Math.max(...temps);
      const cold = Math.min(...temps);
      const vs = result.legs.flatMap((l) => l.points.map((p) => p.v));
      const lo = Math.min(...vs);
      const hi = Math.max(...vs);
      for (const t of [hot, cold]) {
        const n = 120;
        const xs = new Float64Array(n + 1);
        const ys = new Float64Array(n + 1);
        for (let i = 0; i <= n; i++) {
          const v = lo + ((hi - lo) * i) / n;
          xs[i] = v;
          ys[i] = (cfg.moles * GAS_CONSTANT_JOULE * t) / v;
        }
        layers.push({ type: 'polyline', xs, ys, colour: withAlpha('#94a3b8', 0.5), width: 1, style: 'dotted' });
        layers.push({
          type: 'marker',
          x: hi,
          y: (cfg.moles * GAS_CONSTANT_JOULE * t) / hi,
          label: `${fmt(t, 4)} K`,
          colour: '#94a3b8',
          radius: 0,
          offset: [6, 0],
        });
      }
      legend.push({ label: 'isotherms', colour: '#94a3b8', dashed: true });
    }
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'volume',
    yLabel: 'pressure',
    legend,
    caption: result.closed ? 'Closed cycle' : 'Not a closed cycle',
  };
}

/** The box sizes the isotherm is measured at, as multiples of the set one. */
const ISOTHERM_SCALES = [0.7, 0.85, 1, 1.2, 1.45, 1.75];

/** Where the sweep will put the points, so the axes mean something before it runs. */
function gasLawFrame(cfg: TabState['thermodynamics']) {
  const areas = ISOTHERM_SCALES.map((s) => 4 * cfg.boxWidth * s * cfg.boxHeight * s);
  const xMax = Math.max(...areas.map((a) => 1 / a)) * 1.2;
  return { xMax, yMax: cfg.count * BOLTZMANN * cfg.temperature * xMax * 1.15 };
}

function gasLawScene(tab: TabState, points: IsothermPoint[]): PlotScene {
  const cfg = tab.thermodynamics;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];

  /* The ideal gas law drawn as a line through the origin, *before* anything is
   * measured. Its slope is NkT from the particle count and the temperature
   * the gas is held at — no part of it is fitted to the pressures, so when the
   * measurement arrives the points either land on the line or they do not. A
   * line fitted afterwards would always look convincing and prove nothing. */
  const { xMax } = gasLawFrame(cfg);
  const nkt = points.length
    ? cfg.count * BOLTZMANN * (points.reduce((s, p) => s + p.temperature, 0) / points.length)
    : cfg.count * BOLTZMANN * cfg.temperature;
  layers.push({
    type: 'polyline',
    xs: [0, xMax],
    ys: [0, nkt * xMax],
    colour: IDEAL,
    width: 2,
    style: 'dashed',
  });
  legend.push({ label: 'P = NkT/A', colour: IDEAL, dashed: true });

  if (points.length) {
    layers.push({
      type: 'points',
      xs: points.map((p) => 1 / p.area),
      ys: points.map((p) => p.pressure),
      colour: HIST,
      radius: 5,
    });
    legend.push({ label: 'measured', colour: HIST });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: '1 / area',
    yLabel: 'measured pressure',
    legend,
    caption: points.length ? '' : 'Press Measure to run the gas at each box size.',
  };
}

// -------------------------------------------------------------------- panel

export function ThermodynamicsPanel({ tab }: { tab: TabState }) {
  const cfg = tab.thermodynamics;
  const setThermo = useStore((s) => s.setThermo);
  const commit = useStore((s) => s.commit);

  const patchLeg = useCallback(
    (id: string, change: Partial<CycleLeg>) => {
      commit();
      setThermo({ cycle: cfg.cycle.map((l) => (l.id === id ? { ...l, ...change } : l)) });
    },
    [commit, setThermo, cfg.cycle],
  );

  return (
    <>
      <Panel title="View">
        <SegmentedControl size="sm" value={cfg.view} onChange={(view) => setThermo({ view })} options={VIEWS} />
      </Panel>

      {(cfg.view === 'box' || cfg.view === 'speeds' || cfg.view === 'gaslaw') && (
        <>
          <Panel title="The gas">
            <Field label={`${cfg.count} particles`}>
              <Slider
                value={cfg.count}
                min={2}
                max={1500}
                step={1}
                onChange={(count) => {
                  commit();
                  setThermo({ count });
                }}
              />
            </Field>
            <Field label={`Temperature ${fmt(cfg.temperature, 4)}`} hint="Sets the speeds the gas is seeded at.">
              <Slider
                value={cfg.temperature}
                min={0.05}
                max={8}
                step={0.05}
                onChange={(temperature) => {
                  commit();
                  setThermo({ temperature });
                }}
              />
            </Field>
            <Field label={`Disc radius ${fmt(cfg.radius, 3)}`} hint="Bigger discs collide more often, and depart further from an ideal gas.">
              <Slider
                value={cfg.radius}
                min={0.004}
                max={0.06}
                step={0.001}
                onChange={(radius) => {
                  commit();
                  setThermo({ radius });
                }}
              />
            </Field>
            <Toggle
              label="Start every particle at the same speed"
              hint="Nothing knows what Maxwell–Boltzmann is. Watch it appear anyway."
              checked={cfg.identicalSpeeds}
              onChange={(identicalSpeeds) => {
                commit();
                setThermo({ identicalSpeeds });
              }}
            />
          </Panel>

          <Panel title="The box">
            <Row>
              <div className="flex-1">
                <Field label="Half-width">
                  <NumberField
                    value={cfg.boxWidth}
                    min={0.1}
                    step={0.1}
                    onChange={(boxWidth) => {
                      commit();
                      setThermo({ boxWidth });
                    }}
                  />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Half-height">
                  <NumberField
                    value={cfg.boxHeight}
                    min={0.1}
                    step={0.1}
                    onChange={(boxHeight) => {
                      commit();
                      setThermo({ boxHeight });
                    }}
                  />
                </Field>
              </div>
            </Row>
            <Field
              label={`Piston ${cfg.pistonSpeed === 0 ? 'still' : cfg.pistonSpeed < 0 ? 'compressing' : 'expanding'}`}
              hint="The side walls move at this rate. Slowly is adiabatic; quickly is a shock."
            >
              <Slider
                value={cfg.pistonSpeed}
                min={-0.1}
                max={0.1}
                step={0.002}
                onChange={(pistonSpeed) => {
                  commit();
                  setThermo({ pistonSpeed });
                }}
              />
            </Field>
            <Field
              label={`Thermostat ${cfg.thermostat === 0 ? 'off (insulated)' : fmt(cfg.thermostat, 3)}`}
              hint="Zero means no heat crosses the walls, which is what an adiabatic compression needs."
            >
              <Slider
                value={cfg.thermostat}
                min={0}
                max={5}
                step={0.1}
                onChange={(thermostat) => {
                  commit();
                  setThermo({ thermostat });
                }}
              />
            </Field>
            <Field label={`Gravity ${fmt(cfg.gravity, 3)}`} hint="Turn it up and the density falls off with height — the barometric formula.">
              <Slider
                value={cfg.gravity}
                min={0}
                max={5}
                step={0.1}
                onChange={(gravity) => {
                  commit();
                  setThermo({ gravity });
                }}
              />
            </Field>
          </Panel>

          {cfg.view === 'box' && (
            <Panel title="Drawing">
              <Toggle label="Colour by speed" checked={cfg.colourBySpeed} onChange={(colourBySpeed) => setThermo({ colourBySpeed })} />
              <Toggle
                label="Show trails"
                hint="A quarter-second tail behind each disc, which makes the mean free path visible."
                checked={cfg.showTrails}
                onChange={(showTrails) => setThermo({ showTrails })}
              />
            </Panel>
          )}

          {cfg.view === 'speeds' && (
            <Panel title="Histogram">
              <Field label={`${cfg.histogramBins} bins`}>
                <Slider value={cfg.histogramBins} min={8} max={80} step={1} onChange={(histogramBins) => setThermo({ histogramBins })} />
              </Field>
              <Toggle label="Draw the analytic curve" checked={cfg.showMaxwell} onChange={(showMaxwell) => setThermo({ showMaxwell })} />
            </Panel>
          )}
        </>
      )}

      {cfg.view === 'cycle' && (
        <>
          <Panel title="Starting state">
            <Row>
              <div className="flex-1">
                <Field label="Volume">
                  <NumberField value={cfg.startVolume} min={1e-4} step={0.1} onChange={(startVolume) => setThermo({ startVolume })} />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Temperature (K)">
                  <NumberField
                    value={cfg.startTemperature}
                    min={1}
                    step={25}
                    onChange={(startTemperature) => setThermo({ startTemperature })}
                  />
                </Field>
              </div>
            </Row>
            <Row>
              <div className="flex-1">
                <Field label="Moles">
                  <NumberField value={cfg.moles} min={1e-4} step={0.1} onChange={(moles) => setThermo({ moles })} />
                </Field>
              </div>
              <div className="flex-1">
                <Field label="Degrees of freedom" hint="3 monatomic, 5 diatomic. γ = (f+2)/f.">
                  <NumberField
                    value={cfg.degreesOfFreedom}
                    min={1}
                    max={12}
                    step={1}
                    onChange={(degreesOfFreedom) => setThermo({ degreesOfFreedom })}
                  />
                </Field>
              </div>
            </Row>
          </Panel>

          <Panel title="Legs">
            <div className="space-y-2">
              {cfg.cycle.map((l, i) => (
                <div key={l.id} className="space-y-1.5 rounded-md border border-edge bg-surface-1 p-2">
                  <Row>
                    <div className="flex-1 text-2xs text-ink-faint">Leg {i + 1}</div>
                    <IconButton
                      title="Remove this leg"
                      onClick={() => {
                        commit();
                        setThermo({ cycle: cfg.cycle.filter((x) => x.id !== l.id) });
                      }}
                    >
                      <IconTrash />
                    </IconButton>
                  </Row>
                  <Select
                    value={l.kind}
                    onChange={(kind) => patchLeg(l.id, { kind: kind as ProcessKind })}
                    options={PROCESSES}
                  />
                  <Field
                    label={l.kind === 'isochoric' ? 'To pressure' : 'To volume'}
                    hint={
                      l.kind === 'isochoric'
                        ? 'The volume does not move on this leg, so the target is a pressure.'
                        : undefined
                    }
                  >
                    <NumberField value={l.target} min={1e-6} step={0.1} onChange={(target) => patchLeg(l.id, { target })} />
                  </Field>
                </div>
              ))}
            </div>
            <Button
              onClick={() => {
                commit();
                setThermo({
                  cycle: [...cfg.cycle, { id: uid('leg'), kind: 'isothermal', target: cfg.startVolume, label: '' }],
                });
              }}
            >
              <IconPlus /> Add a leg
            </Button>
            <Toggle label="Show the isotherms" checked={cfg.showCarnot} onChange={(showCarnot) => setThermo({ showCarnot })} />
          </Panel>

          <Collapsible title="Standard cycles" defaultOpen={false}>
            <div className="space-y-1.5">
              {CYCLE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    commit();
                    setThermo({
                      cycle: p.legs(cfg).map((l) => ({ ...l, id: uid('leg') })),
                      degreesOfFreedom: p.dof,
                      startVolume: p.startVolume,
                      startTemperature: p.startTemperature,
                    });
                  }}
                  className="w-full rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-left transition hover:border-accent"
                >
                  <div className="text-xs font-medium text-ink">{p.label}</div>
                  <div className="text-2xs text-ink-faint">{p.hint}</div>
                </button>
              ))}
            </div>
          </Collapsible>
        </>
      )}
    </>
  );
}

/* The three cycles worth having to hand. Each one computes its own leg targets
 * so the loop actually closes — a Carnot cycle whose adiabats do not share a
 * compression ratio draws an open path, and an open path has no efficiency. */
const CYCLE_PRESETS: {
  label: string;
  hint: string;
  dof: number;
  startVolume: number;
  startTemperature: number;
  legs: (cfg: TabState['thermodynamics']) => Omit<CycleLeg, 'id'>[];
}[] = [
  {
    label: 'Carnot',
    hint: 'Two isotherms and two adiabats. The efficiency comes out at 1 − Tc/Th without that being coded anywhere.',
    dof: 3,
    startVolume: 1,
    startTemperature: 500,
    legs: () => {
      const gamma = 5 / 3;
      const ratio = (500 / 300) ** (1 / (gamma - 1));
      return [
        { kind: 'isothermal', target: 2, label: 'Expand at 500 K' },
        { kind: 'adiabatic', target: 2 * ratio, label: 'Expand to 300 K' },
        { kind: 'isothermal', target: ratio, label: 'Compress at 300 K' },
        { kind: 'adiabatic', target: 1, label: 'Compress to 500 K' },
      ];
    },
  },
  {
    label: 'Otto',
    hint: 'The petrol engine: adiabatic squeeze, constant-volume burn, adiabatic push, constant-volume exhaust.',
    dof: 5,
    startVolume: 1,
    startTemperature: 300,
    legs: (cfg) => {
      const gamma = 7 / 5;
      const r = 8;
      const v2 = 1 / r;
      const t2 = 300 * r ** (gamma - 1);
      const t3 = 3 * t2;
      const p3 = (cfg.moles * GAS_CONSTANT_JOULE * t3) / v2;
      const p1 = (cfg.moles * GAS_CONSTANT_JOULE * 300) / 1;
      return [
        { kind: 'adiabatic', target: v2, label: 'Compression stroke' },
        { kind: 'isochoric', target: p3, label: 'Ignition' },
        { kind: 'adiabatic', target: 1, label: 'Power stroke' },
        { kind: 'isochoric', target: p1, label: 'Exhaust' },
      ];
    },
  },
  {
    label: 'Stirling',
    hint: 'Two isotherms joined by two constant-volume legs. Same corners as Carnot, less efficient, and the diagram shows why.',
    dof: 3,
    startVolume: 1,
    startTemperature: 500,
    legs: (cfg) => {
      const pAfter = (cfg.moles * GAS_CONSTANT_JOULE * 300) / 2;
      const pBack = (cfg.moles * GAS_CONSTANT_JOULE * 500) / 1;
      return [
        { kind: 'isothermal', target: 2, label: 'Expand at 500 K' },
        { kind: 'isochoric', target: pAfter, label: 'Cool to 300 K' },
        { kind: 'isothermal', target: 1, label: 'Compress at 300 K' },
        { kind: 'isochoric', target: pBack, label: 'Heat to 500 K' },
      ];
    },
  },
];

// ------------------------------------------------------------------ surface

export function ThermodynamicsSurface({ tab }: { tab: TabState }) {
  const cfg = tab.thermodynamics;
  const setViewport = useStore((s) => s.setViewport);
  const fitViewport = useStore((s) => s.fitViewport);
  const plotRef = usePlot2DRef();

  const particleView = cfg.view === 'box' || cfg.view === 'speeds';
  const { run, ready } = useGas(cfg, particleView ? tab.timeline.t : 0);
  const frame = frameAt(run, particleView ? tab.timeline.t : 0);

  const [isotherm, setIsotherm] = useState<IsothermPoint[]>([]);
  const [measuring, setMeasuring] = useState(false);

  const scene = useMemo(() => {
    if (cfg.view === 'cycle') return cycleScene(tab);
    if (cfg.view === 'gaslaw') return gasLawScene(tab, isotherm);
    if (cfg.view === 'speeds') return speedScene(tab, frame);
    return boxScene(tab, run, frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, cfg.view, frame, isotherm]);

  const frameKey = [cfg.view, cfg.boxWidth, cfg.boxHeight, cfg.temperature, cfg.particleMass, JSON.stringify(cfg.cycle), isotherm.length].join('|');
  useEffect(() => {
    if (cfg.view === 'box') {
      // Room for the box at its largest, so a compression shrinks the box
      // rather than the camera chasing it — which would hide the compression.
      const w = cfg.boxWidth * 1.15;
      const h = cfg.boxHeight * 1.15;
      fitViewport({ xMin: -w, xMax: w, yMin: -h, yMax: h });
    } else if (cfg.view === 'speeds') {
      const rms = Math.sqrt((2 * BOLTZMANN * Math.max(1e-12, cfg.temperature)) / cfg.particleMass);
      const top = rms * 3;
      const peak = maxwellBoltzmann2D(Math.sqrt((BOLTZMANN * cfg.temperature) / cfg.particleMass), cfg.temperature, cfg.particleMass);
      fitViewport({ xMin: 0, xMax: top, yMin: -0.05 * peak, yMax: peak * 1.5 });
    } else if (cfg.view === 'cycle') {
      const result = traceCycle(
        cfg.cycle,
        { v: cfg.startVolume, t: cfg.startTemperature },
        cfg.moles,
        GAS_CONSTANT_JOULE,
        cfg.degreesOfFreedom,
        60,
      );
      const vs = result.legs.flatMap((l) => l.points.map((p) => p.v));
      const ps = result.legs.flatMap((l) => l.points.map((p) => p.p));
      if (!vs.length) return;
      const vPad = (Math.max(...vs) - Math.min(...vs)) * 0.12 || 1;
      const pPad = (Math.max(...ps) - Math.min(...ps)) * 0.12 || 1;
      fitViewport({
        xMin: Math.min(...vs) - vPad,
        xMax: Math.max(...vs) + vPad,
        yMin: Math.max(0, Math.min(...ps) - pPad),
        yMax: Math.max(...ps) + pPad,
      });
    } else {
      // Framed from where the sweep *will* put the points, so the axes are
      // meaningful before the measurement has been taken.
      const frame = gasLawFrame(cfg);
      const measured = isotherm.length ? Math.max(...isotherm.map((p) => p.pressure)) * 1.15 : 0;
      fitViewport({ xMin: 0, xMax: frame.xMax, yMin: 0, yMax: Math.max(frame.yMax, measured) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);

  // The box is a picture of a physical space, so a disc has to be round and the
  // box has to have the proportions it claims to have.
  useSquareScales(plotRef, tab.viewport, cfg.view === 'box', 'contain');

  const measure = useCallback(() => {
    setMeasuring(true);
    // Deferred a frame so the button's pressed state paints before the main
    // thread disappears into the measurement.
    requestAnimationFrame(() => {
      const points = measureIsotherm(worldOf({ ...cfg, thermostat: Math.max(cfg.thermostat, 1) }), ISOTHERM_SCALES, 3, 10);
      setIsotherm(points);
      setMeasuring(false);
    });
  }, [cfg]);

  return (
    <SandboxLayout
      storageKey="thermodynamics"
      canvas={
        <div className="h-full w-full">
          <Plot2D ref={plotRef} scene={scene} onViewportChange={setViewport} />
        </div>
      }
      instruments={
        <>
          {particleView && <GasReadout tab={tab} frame={frame} ready={ready} />}
          {cfg.view === 'cycle' && <CycleReadout tab={tab} />}
          {cfg.view === 'gaslaw' && (
            <GasLawReadout tab={tab} points={isotherm} measuring={measuring} onMeasure={measure} />
          )}
          <AnalyticCard result={analyseThermo(tab, frame)} />
        </>
      }
    />
  );
}

function GasReadout({ tab, frame, ready }: { tab: TabState; frame: GasFrame; ready: boolean }) {
  const cfg = tab.thermodynamics;
  const nkt = cfg.count * BOLTZMANN * frame.temperature;
  const pa = frame.pressure * frame.area;
  /* The area the discs deny one another: b = 2πr² per disc is the second
   * virial coefficient of a hard-disc gas, and it is what separates this gas
   * from an ideal one — both in the pressure above and in the adiabatic
   * invariant below. */
  const excludedArea = cfg.count * 2 * Math.PI * cfg.radius * cfg.radius;
  const moments = speedMoments(frame.temperature, cfg.particleMass);
  const sampleMean = frame.speeds.length
    ? Array.from(frame.speeds).reduce((s, v) => s + v, 0) / frame.speeds.length
    : 0;

  return (
    <>
      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat label="Temperature" value={fmt(frame.temperature, 5)} emphasis />
          <Stat label="Pressure" value={fmt(frame.pressure, 5)} />
          <Stat label="Area" value={fmt(frame.area, 5)} />
          {/* The whole claim of the mode, as one number. */}
          <Stat label="PA / NkT" value={nkt > 0 ? fmt(pa / nkt, 4) : '—'} emphasis />
          <Stat label="Kinetic energy" value={fmt(frame.energy, 5)} />
          {cfg.pistonSpeed !== 0 && <Stat label="Work by the piston" value={fmt(frame.wallWork, 5)} />}
          <Stat label="Collisions" value={frame.collisions.toLocaleString()} />
        </StatList>
        {nkt > 0 && pa / nkt > 1.02 && (
          <div className="pt-2 text-2xs text-ink-faint">
            {/* Reported rather than rounded away. The excess is the second
                virial coefficient of a hard-disc gas, 1/(1 − Nb/A) with
                b = 2πr², and it is a real property of the gas rather than an
                error in the measurement. */}
            PA/NkT sits above one because the discs have an area of their own — about{' '}
            {fmt((100 * excludedArea) / frame.area, 3)}% of the box is unavailable to any given disc. Shrink the radius
            and it goes to one.
          </div>
        )}
        {!ready && <div className="pt-2 text-2xs text-ink-faint">Catching up with the clock…</div>}
      </div>

      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat label="Mean speed (measured)" value={fmt(sampleMean, 5)} />
          <Stat label="Mean speed (Maxwell)" value={fmt(moments.mean, 5)} />
          <Stat label="Most likely" value={fmt(moments.mode, 5)} />
          <Stat label="rms" value={fmt(moments.rms, 5)} />
        </StatList>
        {cfg.thermostat === 0 && cfg.pistonSpeed !== 0 && (
          <div className="pt-2 text-2xs text-ink-faint">
            {/* γ = 2 in two dimensions, so for an ideal gas the adiabatic
                invariant would be TV^(γ−1) = TA. These are hard discs, and the
                area they deny one another has to come out of the volume before
                the invariant holds — which is why TA drifts during a
                compression and T(A − Nb) does not. Showing the one that drifts
                and calling it constant would be teaching the wrong thing. */}
            TA = {fmt(frame.temperature * frame.area, 5)}, T(A − Nb) = {fmt(frame.temperature * (frame.area - excludedArea), 5)}
            . The second is what stays put through a slow adiabatic change: γ = 2 in two dimensions, and Nb = 2πr²N is the
            area the discs deny each other.
          </div>
        )}
      </div>
    </>
  );
}

function CycleReadout({ tab }: { tab: TabState }) {
  const cfg = tab.thermodynamics;
  const result = useMemo(
    () =>
      traceCycle(
        cfg.cycle,
        { v: cfg.startVolume, t: cfg.startTemperature },
        cfg.moles,
        GAS_CONSTANT_JOULE,
        cfg.degreesOfFreedom,
        400,
      ),
    [cfg.cycle, cfg.startVolume, cfg.startTemperature, cfg.moles, cfg.degreesOfFreedom],
  );

  const temps = result.legs.flatMap((l) => l.points.map((p) => p.t));
  const hot = temps.length ? Math.max(...temps) : 0;
  const cold = temps.length ? Math.min(...temps) : 0;
  const carnot = carnotEfficiency(cold, hot);

  return (
    <>
      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat label="Net work" value={fmt(result.netWork, 5)} emphasis />
          <Stat label="Heat in" value={fmt(result.heatIn, 5)} />
          <Stat label="Heat out" value={fmt(result.heatOut, 5)} />
          <Stat label="Efficiency" value={result.heatIn > 0 ? `${fmt(result.efficiency * 100, 4)} %` : '—'} emphasis />
          {temps.length > 0 && <Stat label="Carnot limit" value={`${fmt(carnot * 100, 4)} %`} />}
          <Stat label="γ" value={fmt((cfg.degreesOfFreedom + 2) / cfg.degreesOfFreedom, 4)} />
        </StatList>
        <div className="pt-2 text-2xs text-ink-faint">{result.message}</div>
        {result.closed && result.heatIn > 0 && (
          <div className="pt-1 text-2xs text-ink-faint">
            {result.efficiency > carnot + 1e-6
              ? 'This exceeds the Carnot limit, which means one of the legs is not what it claims to be.'
              : `This reaches ${fmt((result.efficiency / carnot) * 100, 3)}% of the Carnot limit between the same two temperatures.`}
          </div>
        )}
      </div>

      <div className="border-b border-edge px-3 py-2.5">
        <div className="pb-1.5 text-xs font-medium text-ink">Leg by leg</div>
        <StatList>
          {result.legs.map((l, i) => (
            <Stat key={i} label={`${i + 1}. ${l.kind}`} value={`W ${fmt(l.work, 4)} · Q ${fmt(l.heat, 4)}`} />
          ))}
        </StatList>
      </div>
    </>
  );
}

function GasLawReadout({
  tab,
  points,
  measuring,
  onMeasure,
}: {
  tab: TabState;
  points: IsothermPoint[];
  measuring: boolean;
  onMeasure: () => void;
}) {
  const cfg = tab.thermodynamics;

  /* A least-squares slope through the origin, which is the only fit the ideal
   * gas law permits: no gas exerts a pressure in an infinite box. Comparing
   * that slope with NkT is then a fair test rather than a curve drawn to
   * match. */
  const fit = useMemo(() => {
    if (points.length < 2) return null;
    let sxy = 0;
    let sxx = 0;
    for (const p of points) {
      const x = 1 / p.area;
      sxy += x * p.pressure;
      sxx += x * x;
    }
    if (sxx <= 0) return null;
    const slope = sxy / sxx;
    const meanT = points.reduce((s, p) => s + p.temperature, 0) / points.length;
    const predicted = cfg.count * BOLTZMANN * meanT;
    let ssRes = 0;
    let ssTot = 0;
    const meanP = points.reduce((s, p) => s + p.pressure, 0) / points.length;
    for (const p of points) {
      const x = 1 / p.area;
      ssRes += (p.pressure - slope * x) ** 2;
      ssTot += (p.pressure - meanP) ** 2;
    }
    return { slope, predicted, meanT, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
  }, [points, cfg.count]);

  return (
    <div className="border-b border-edge px-3 py-2.5 space-y-2">
      <Button onClick={onMeasure} disabled={measuring}>
        {measuring ? 'Measuring…' : 'Measure the isotherm'}
      </Button>
      {points.length === 0 && !measuring && (
        <Callout kind="info">
          Six box sizes, each run until the pressure reading settles. It takes a few seconds because it is a measurement,
          not a formula.
        </Callout>
      )}
      {fit && (
        <>
          <StatList>
            <Stat label="Fitted slope" value={fmt(fit.slope, 5)} emphasis />
            <Stat label="NkT" value={fmt(fit.predicted, 5)} />
            <Stat label="Ratio" value={fmt(fit.slope / fit.predicted, 4)} emphasis />
            <Stat label="r²" value={fmt(fit.r2, 5)} />
          </StatList>
          <div className="text-2xs text-ink-faint">
            {/* Hard discs are not ideal, and saying so is more useful than
                rounding the discrepancy away. */}
            {fit.slope / fit.predicted > 1.03
              ? 'The slope sits above NkT because the discs have an area of their own: the gas behaves as though the box were smaller than it is. Shrink the radius and the excess goes away.'
              : 'The slope agrees with NkT, so P = NkT/A holds for this gas — and nothing in the measurement assumed it.'}
          </div>
        </>
      )}
      {points.length > 0 && (
        <StatList>
          {points.map((p, i) => (
            <Stat key={i} label={`A = ${fmt(p.area, 4)}`} value={`PA/NkT ${fmt(p.compressibility, 4)}`} />
          ))}
        </StatList>
      )}
    </div>
  );
}

function analyseThermo(tab: TabState, frame: GasFrame): AnalyticResult {
  const cfg = tab.thermodynamics;
  if (cfg.view === 'cycle') {
    return {
      title: 'The first law, leg by leg',
      equations: [
        String.raw`\Delta U = Q - W, \qquad W = \int P\,dV`,
        String.raw`\Delta U = \tfrac{f}{2}nR\,\Delta T, \qquad \gamma = \frac{f+2}{f}`,
        String.raw`\eta = \frac{W_{\text{net}}}{Q_{\text{in}}} \le 1 - \frac{T_c}{T_h}`,
      ],
      quantities: [],
      overlay: null,
      caveat:
        'The work is the trapezium integral of the sampled path, and the heat is whatever the first law then requires — so the efficiency is a division of two computed numbers rather than a formula for the cycle.',
    };
  }
  if (cfg.view === 'gaslaw') {
    return {
      title: 'The ideal gas law, in two dimensions',
      equations: [String.raw`PA = Nk_BT`, String.raw`P = \frac{Nk_BT}{A}\quad\text{— a straight line in }1/A`],
      quantities: [],
      overlay: null,
      caveat:
        'Pressure is measured as wall momentum per unit time per unit length of wall, which is force per length — the two-dimensional pressure. Real discs exclude area from one another, so the measured slope sits slightly above NkT.',
    };
  }
  return {
    title: 'Kinetic theory in two dimensions',
    equations: [
      String.raw`\left\langle \tfrac{1}{2}mv^2 \right\rangle = k_BT \quad \text{(two degrees of freedom)}`,
      String.raw`f(v) = \frac{m}{k_BT}\,v\,e^{-mv^2/2k_BT}`,
      String.raw`v_{\text{likely}} = \sqrt{\frac{k_BT}{m}},\quad \bar v = \sqrt{\frac{\pi k_BT}{2m}},\quad v_{\text{rms}} = \sqrt{\frac{2k_BT}{m}}`,
    ],
    quantities: [
      { label: 'T from the particles', value: frame.temperature, unit: '' },
      { label: 'PA / NkT', value: frame.temperature > 0 ? (frame.pressure * frame.area) / (cfg.count * BOLTZMANN * frame.temperature) : 0, unit: '' },
    ],
    overlay: null,
    caveat:
      'These are the two-dimensional results. In three dimensions the energy per particle is (3/2)kT and the speed distribution carries a v² rather than a v — using those over this simulation would look almost right and be wrong.',
  };
}

export function thermoCsv(tab: TabState): string | null {
  const cfg = tab.thermodynamics;
  if (cfg.view === 'cycle') {
    const result = traceCycle(
      cfg.cycle,
      { v: cfg.startVolume, t: cfg.startTemperature },
      cfg.moles,
      GAS_CONSTANT_JOULE,
      cfg.degreesOfFreedom,
      200,
    );
    const rows: (number | string)[][] = [];
    result.legs.forEach((l, i) => {
      for (const p of l.points) rows.push([i + 1, l.kind, p.v, p.p, p.t]);
    });
    if (!rows.length) return null;
    return toCsv(['leg', 'process', 'volume', 'pressure', 'temperature'], rows);
  }

  // The particle views export the state of the gas at the current instant,
  // which is the thing a user would want to take away and plot elsewhere.
  const state = createGas(worldOf(cfg), cfg.identicalSpeeds);
  const target = Math.max(0, tab.timeline.t);
  let t = 0;
  while (t < target - 1e-9) {
    const step = Math.min(FRAME_STEP, target - t);
    advanceGas(state, step);
    t += step;
  }
  const values = speedsOf(state);
  if (!values.length) return null;
  if (cfg.view === 'speeds') {
    const rms = Math.sqrt((2 * BOLTZMANN * Math.max(1e-12, temperatureOf(state))) / cfg.particleMass);
    const hist = speedHistogram(values, cfg.histogramBins, rms * 3);
    return toCsv(
      ['bin_low', 'bin_high', 'measured_density', 'maxwell_density'],
      hist.density.map((d, i) => [
        hist.edges[i],
        hist.edges[i + 1],
        d,
        maxwellBoltzmann2D((hist.edges[i] + hist.edges[i + 1]) / 2, temperatureOf(state), cfg.particleMass),
      ]),
    );
  }
  return toCsv(
    ['x', 'y', 'vx', 'vy', 'speed'],
    state.particles.map((p) => [p.x, p.y, p.vx, p.vy, Math.hypot(p.vx, p.vy)]),
  );
}
