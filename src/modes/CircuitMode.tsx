import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import { SERIES_COLOURS, type TabState } from '../core/types';
import {
  ELEMENT_SPECS,
  READING_INFO,
  SPEC_BY_KIND,
  advanceCircuit,
  availableReadings,
  buildNetlist,
  circuitSampleAt,
  createCircuitTrajectory,
  defaultValues,
  flowPoint,
  operatingPoint,
  readCircuit,
  readingLabel,
  readingValue,
  sourceVoltage,
  staticResistance,
  terminals,
  wireFlow,
  type CircuitElement,
  type CircuitTrajectory,
  type CircuitWorld,
  type ElementKind,
  type Netlist,
  type ReadingKind,
} from '../core/physics/circuit';
import { analyseCircuit } from '../core/physics/analytic';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { ProbePlot, groupByUnit, type Trace } from '../components/sandbox/ProbePlot';
import { AnalyticCard } from '../components/sandbox/AnalyticCard';
import { useSquareScales } from '../components/sandbox/useSquareScales';
import { ViewPanel } from '../components/panels/ViewPanel';
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
  TextField,
  Toggle,
} from '../components/ui/controls';
import { IconClose, IconEye, IconEyeOff, IconPlus, IconRefresh, IconTrash } from '../components/ui/Icons';
import type { Layer, PlotScene } from '../plot/scene';
import { divergingColour, withAlpha } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* The electronics sandbox.
 *
 * Components live on the edges of a square grid: one component per edge, its
 * two terminals on the two grid points. That single decision does most of the
 * work here. Connectivity becomes a union–find over grid points rather than
 * geometric hit-testing of wire ends; placement can never produce a
 * half-connected part; and the schematic looks like a schematic without any
 * routing code, because the grid *is* the routing.
 *
 * The price is that you cannot draw a diagonal, which no one wants to do
 * anyway, and that two wires crossing at a grid point are connected — the same
 * convention as a hand-drawn circuit with a dot, and the reason the
 * junction-dot notation exists at all.
 */

const PALETTE: ElementKind[] = [
  'wire',
  'cell',
  'battery',
  'ac',
  'resistor',
  'bulb',
  'switch',
  'capacitor',
  'inductor',
  'diode',
  'led',
  'fuse',
  'thermistor',
  'ammeter',
  'voltmeter',
  'ground',
];

const WIRE_COLOUR = '#8ea0bd';
const LIT = '#fde68a';

// ------------------------------------------------------------------ the run

interface Run {
  netlist: Netlist;
  traj: CircuitTrajectory | null;
  dc: ReturnType<typeof operatingPoint> | null;
}

function useCircuitRun(world: CircuitWorld, analysis: 'dc' | 'transient', until: number) {
  const signature = useMemo(() => `${analysis}:${JSON.stringify(world)}`, [world, analysis]);
  const ref = useRef<{ signature: string; run: Run } | null>(null);
  const [, bump] = useState(0);

  if (!ref.current || ref.current.signature !== signature) {
    const netlist = buildNetlist(world);
    ref.current = {
      signature,
      run:
        analysis === 'transient'
          ? { netlist, traj: createCircuitTrajectory(world, Math.max(0.001, until)), dc: null }
          : { netlist, traj: null, dc: operatingPoint(world, netlist) },
    };
  }
  const run = ref.current.run;

  const ready = run.traj ? advanceCircuit(run.traj, until, 30000) : true;
  useEffect(() => {
    if (ready) return;
    const id = requestAnimationFrame(() => bump((n) => n + 1));
    return () => cancelAnimationFrame(id);
  }, [ready, until, signature]);

  return { run, ready };
}

// ------------------------------------------------------------------ symbols

interface Geometry {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  mx: number;
  my: number;
}

function geometry(e: CircuitElement): Geometry {
  const ax = e.x;
  const ay = e.y;
  const bx = e.orientation === 'h' ? e.x + 1 : e.x;
  const by = e.orientation === 'v' ? e.y + 1 : e.y;
  const ux = bx - ax;
  const uy = by - ay;
  return { ax, ay, bx, by, ux, uy, nx: -uy, ny: ux, mx: (ax + bx) / 2, my: (ay + by) / 2 };
}

const poly = (points: number[][], colour: string, width = 1.6, fill?: string): Layer => ({
  type: 'polyline',
  xs: Float64Array.from(points.map((p) => p[0])),
  ys: Float64Array.from(points.map((p) => p[1])),
  colour,
  width,
  ...(fill ? { fill } : {}),
});

/**
 * Draws one component's symbol.
 *
 * These are the conventional shapes rather than anything invented: a student
 * who has drawn a circuit on paper should recognise every one of them without
 * a legend, and should be able to copy what they see here back onto paper.
 */
function symbol(e: CircuitElement, colour: string, brightness: number): Layer[] {
  const g = geometry(e);
  const at = (along: number, across: number): [number, number] => [
    g.ax + g.ux * along + g.nx * across,
    g.ay + g.uy * along + g.ny * across,
  ];
  const layers: Layer[] = [];
  const lead = (from: number, to: number) => poly([at(from, 0), at(to, 0)], colour, 1.6);

  switch (e.kind) {
    case 'wire':
      return [poly([at(0, 0), at(1, 0)], colour, 1.8)];

    case 'ground': {
      // Always drawn hanging below its terminal, whichever edge it was
      // dropped on. An earth symbol pointing sideways into the circuit it
      // terminates reads as a mistake, and the netlist only uses terminal a
      // anyway, so the drawing is free to ignore the orientation.
      const down = (d: number, w: number): [number, number][] => [
        [g.ax - w, g.ay - d],
        [g.ax + w, g.ay - d],
      ];
      return [
        poly([[g.ax, g.ay], [g.ax, g.ay - 0.26]], colour, 1.6),
        poly(down(0.26, 0.2), colour, 2),
        poly(down(0.36, 0.13), colour, 2),
        poly(down(0.46, 0.06), colour, 2),
      ];
    }

    case 'resistor':
    case 'fuse':
    case 'thermistor':
    case 'bulb':
    case 'led':
    case 'diode':
    case 'capacitor':
    case 'inductor':
    case 'switch':
    case 'cell':
    case 'battery':
    case 'ac':
    case 'ammeter':
    case 'voltmeter':
      layers.push(lead(0, 0.3), lead(0.7, 1));
      break;
    default:
      break;
  }

  switch (e.kind) {
    case 'resistor':
    case 'fuse':
      layers.push(
        poly(
          [at(0.3, -0.13), at(0.7, -0.13), at(0.7, 0.13), at(0.3, 0.13), at(0.3, -0.13)],
          colour,
          1.7,
          'rgba(17,20,27,0.9)',
        ),
      );
      if (e.kind === 'fuse') layers.push(poly([at(0.3, 0), at(0.7, 0)], colour, 1.2));
      break;

    case 'thermistor':
      layers.push(
        poly(
          [at(0.3, -0.13), at(0.7, -0.13), at(0.7, 0.13), at(0.3, 0.13), at(0.3, -0.13)],
          colour,
          1.7,
          'rgba(17,20,27,0.9)',
        ),
        // The diagonal stroke through the box: the mark for a dependent part.
        poly([at(0.24, 0.2), at(0.76, -0.2)], colour, 1.4),
      );
      break;

    case 'bulb': {
      const r = 0.2;
      const circle: number[][] = [];
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        circle.push(at(0.5 + r * Math.cos(a) * (g.ux ? 1 : 1), r * Math.sin(a)));
      }
      layers.push(
        poly(circle, colour, 1.7, brightness > 0.02 ? withAlpha(LIT, 0.25 + 0.6 * brightness) : 'rgba(17,20,27,0.9)'),
        poly([at(0.36, -0.14), at(0.64, 0.14)], colour, 1.3),
        poly([at(0.36, 0.14), at(0.64, -0.14)], colour, 1.3),
      );
      break;
    }

    case 'capacitor':
      layers.push(
        poly([at(0.44, -0.22), at(0.44, 0.22)], colour, 2.2),
        poly([at(0.56, -0.22), at(0.56, 0.22)], colour, 2.2),
      );
      // The leads stop at the plates rather than running through them.
      layers[0] = poly([at(0, 0), at(0.44, 0)], colour, 1.6);
      layers[1] = poly([at(0.56, 0), at(1, 0)], colour, 1.6);
      break;

    case 'inductor': {
      const bumps: number[][] = [];
      for (let i = 0; i <= 60; i++) {
        const s = 0.3 + (0.4 * i) / 60;
        const phase = ((s - 0.3) / 0.4) * Math.PI * 4;
        bumps.push(at(s, -0.11 * Math.abs(Math.sin(phase))));
      }
      layers.push(poly(bumps, colour, 1.7));
      break;
    }

    case 'diode':
    case 'led': {
      const dir = e.reversed ? -1 : 1;
      const tip = dir > 0 ? 0.66 : 0.34;
      const back = dir > 0 ? 0.34 : 0.66;
      layers.push(
        poly([at(back, -0.17), at(back, 0.17), at(tip, 0), at(back, -0.17)], colour, 1.6, withAlpha(colour, 0.35)),
        poly([at(tip, -0.19), at(tip, 0.19)], colour, 2.2),
      );
      if (e.kind === 'led') {
        const glow = brightness > 0.02 ? withAlpha(LIT, 0.35 + 0.6 * brightness) : colour;
        layers.push(
          poly([at(0.42, 0.24), at(0.3, 0.4)], glow, 1.3),
          poly([at(0.56, 0.24), at(0.44, 0.4)], glow, 1.3),
        );
      }
      break;
    }

    case 'switch': {
      const closed = e.values.closed >= 0.5;
      layers.push(
        { type: 'points', xs: Float64Array.from([at(0.3, 0)[0]]), ys: Float64Array.from([at(0.3, 0)[1]]), colour, radius: 2.5 },
        { type: 'points', xs: Float64Array.from([at(0.7, 0)[0]]), ys: Float64Array.from([at(0.7, 0)[1]]), colour, radius: 2.5 },
        poly([at(0.3, 0), closed ? at(0.7, 0) : at(0.68, 0.26)], closed ? colour : '#fb7185', 2),
      );
      break;
    }

    case 'cell':
    case 'battery': {
      const pairs = e.kind === 'battery' ? 2 : 1;
      const span = 0.34;
      const start = 0.5 - span / 2;
      for (let i = 0; i < pairs; i++) {
        const base = start + (i * span) / pairs;
        const longSide = e.reversed ? base + 0.1 : base;
        const shortSide = e.reversed ? base : base + 0.1;
        layers.push(poly([at(longSide, -0.24), at(longSide, 0.24)], colour, 2.2));
        layers.push(poly([at(shortSide, -0.11), at(shortSide, 0.11)], colour, 2.6));
      }
      layers[0] = poly([at(0, 0), at(start, 0)], colour, 1.6);
      layers[1] = poly([at(start + span, 0), at(1, 0)], colour, 1.6);
      layers.push({
        type: 'text',
        ...pointOf(at(e.reversed ? 0.86 : 0.14, -0.3)),
        text: '+',
        colour: withAlpha(colour, 0.9),
        align: 'center',
        baseline: 'middle',
        size: 11,
      });
      break;
    }

    case 'ac':
    case 'ammeter':
    case 'voltmeter': {
      const r = 0.2;
      const circle: number[][] = [];
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * Math.PI * 2;
        circle.push(at(0.5 + r * Math.cos(a), r * Math.sin(a)));
      }
      layers.push(poly(circle, colour, 1.7, 'rgba(17,20,27,0.9)'));
      if (e.kind === 'ac') {
        const wave: number[][] = [];
        for (let i = 0; i <= 30; i++) {
          const s = 0.36 + (0.28 * i) / 30;
          wave.push(at(s, 0.1 * Math.sin(((i / 30) * Math.PI * 2) - Math.PI)));
        }
        layers.push(poly(wave, colour, 1.5));
      } else {
        layers.push({
          type: 'text',
          ...pointOf(at(0.5, 0)),
          text: e.kind === 'ammeter' ? 'A' : 'V',
          colour,
          align: 'center',
          baseline: 'middle',
          size: 11,
          bold: true,
        });
      }
      break;
    }

    default:
      break;
  }

  return layers;
}

const pointOf = (p: [number, number]) => ({ x: p[0], y: p[1] });

/** A short, readable value string: 4.7 kΩ rather than 4700 Ω. */
export function engineering(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `— ${unit}`;
  const abs = Math.abs(value);
  if (abs === 0) return `0 ${unit}`;
  const prefixes: [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
    [1e-9, 'n'],
    [1e-12, 'p'],
  ];
  for (const [scale, prefix] of prefixes) {
    if (abs >= scale) {
      const scaled = value / scale;
      const text = Math.abs(scaled) >= 100 ? scaled.toFixed(0) : Math.abs(scaled) >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
      return `${text.replace(/\.0+$/, '')} ${prefix}${unit}`;
    }
  }
  return `${value.toExponential(1)} ${unit}`;
}

function valueText(e: CircuitElement): string {
  switch (e.kind) {
    case 'resistor':
    case 'bulb':
      return engineering(e.values.resistance, 'Ω');
    case 'cell':
      return engineering(e.values.emf, 'V');
    case 'battery':
      return engineering(e.values.emf * Math.max(1, Math.round(e.values.cells)), 'V');
    case 'ac':
      return `${engineering(e.values.amplitude, 'V')} @ ${engineering(e.values.frequency, 'Hz')}`;
    case 'capacitor':
      return engineering(e.values.capacitance, 'F');
    case 'inductor':
      return engineering(e.values.inductance, 'H');
    case 'thermistor':
      return engineering(e.values.r25, 'Ω');
    case 'fuse':
      return engineering(e.values.rating, 'A');
    case 'led':
    case 'diode':
      return `${e.values.forward.toFixed(1)} V`;
    default:
      return '';
  }
}

// ------------------------------------------------------------------ scene

interface Instant {
  voltage: (index: number) => number;
  current: (index: number) => number;
  /** ∫I dt through the element since t = 0, which is what the dots follow. */
  charge: (index: number) => number;
  nodeVoltage: (node: number) => number;
  /** Largest |I| over the whole run, for scaling the animation. */
  peakCurrent: number;
  time: number;
}

function buildCircuitScene(
  tab: TabState,
  run: Run,
  instant: Instant,
  hover: { x: number; y: number; orientation: 'h' | 'v' } | null,
): PlotScene {
  const cfg = tab.circuits;
  const world = cfg.world;
  const layers: Layer[] = [];
  const netlist = run.netlist;

  let biggest = 1e-9;
  netlist.active.forEach((_, i) => {
    biggest = Math.max(biggest, Math.abs(instant.current(i)));
  });
  let maxNodeVoltage = 1e-9;
  for (let n = 0; n < netlist.nodeCount; n++) {
    maxNodeVoltage = Math.max(maxNodeVoltage, Math.abs(instant.nodeVoltage(n)));
  }

  const indexOf = new Map(netlist.active.map((e, i) => [e.id, i]));

  for (const e of world.elements) {
    const index = indexOf.get(e.id);
    const selected = cfg.selectedId === e.id;
    let colour = e.kind === 'wire' ? WIRE_COLOUR : '#c7d2e4';

    if (cfg.showNodeVoltages && netlist.nodeCount > 0) {
      // Wires are coloured by the potential they sit at, which turns "where
      // does the voltage actually drop?" from an exercise into something you
      // can see at a glance.
      const [a] = terminals(e);
      const node = netlist.nodeOfPoint.get(`${a[0]},${a[1]}`);
      if (e.kind === 'wire' && node !== undefined) {
        const v = node < 0 ? 0 : instant.nodeVoltage(node);
        colour = divergingColour(0.5 + (0.5 * v) / (maxNodeVoltage * 1.05));
      }
    }
    if (selected) colour = '#8b7cf6';

    const brightness =
      index !== undefined && (e.kind === 'bulb' || e.kind === 'led')
        ? e.kind === 'bulb'
          ? Math.min(1, Math.abs(instant.voltage(index) * instant.current(index)) / Math.max(1e-9, e.values.rating))
          : Math.min(1, Math.max(0, instant.current(index)) / Math.max(1e-9, e.values.rating))
        : 0;

    layers.push(...symbol(e, colour, brightness));

    if (cfg.showValues && e.kind !== 'wire' && e.kind !== 'ground') {
      const g = geometry(e);
      const text = valueText(e);
      layers.push({
        type: 'text',
        x: g.mx + g.nx * 0.36,
        y: g.my + g.ny * 0.36,
        text: text ? `${e.label ? `${e.label} ` : ''}${text}` : e.label,
        colour: 'rgba(154,163,184,0.95)',
        align: 'center',
        baseline: 'middle',
        size: 10,
      });
    }
  }

  // ---- current flow -----------------------------------------------------
  if (cfg.showCurrent && instant.peakCurrent > 1e-12) {
    /* Where the charge has got to, not how fast it is moving now.
     *
     * The dots used to be placed at t·I(t): the elapsed time times the present
     * current. For a circuit with a steady current that is the same thing as
     * ∫I dt and looks perfectly convincing, which is why it survived. For any
     * circuit that changes it is wrong, and visibly so — a discharging RC pair
     * has t·e^(−t/τ) turning over at t = τ, so the dots slow, stop and run
     * *backwards* while the current is still flowing the same way; an AC
     * supply gives t·sin(ωt), a sweep that grows without bound instead of an
     * oscillation. Integrating the current is both correct and, for the DC
     * case, identical to what was there before.
     *
     * The scale is the largest current anywhere over the whole run, so the
     * busiest branch moves at a readable speed and the quiet ones crawl in
     * proportion. Taking that maximum per-instant instead — as this also used
     * to — made every branch race at an AC zero crossing, where all the
     * currents are tiny and only their ratio survives. */
    const reference = Math.max(1e-12, instant.peakCurrent);
    // Electrons are negative, so they drift against the conventional current.
    const sense = cfg.flowMode === 'electron' ? -1 : 1;
    const xs: number[] = [];
    const ys: number[] = [];
    const trail = (e: CircuitElement, charge: number, current: number) => {
      if (!Number.isFinite(charge) || Math.abs(current) < reference * 0.002) return;
      const dots = 3;
      const travelled = (sense * charge * 0.6) / reference;
      for (let d = 0; d < dots; d++) {
        // flowPoint, not geometry: a reversed component is drawn along the
        // grid axis but carries its current the other way.
        const [px, py] = flowPoint(e, d / dots + travelled);
        xs.push(px);
        ys.push(py);
      }
    };

    const count = netlist.active.length;
    const currents = new Float64Array(count);
    const charges = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      currents[i] = instant.current(i);
      charges[i] = instant.charge(i);
      trail(netlist.active[i], charges[i], currents[i]);
    }
    /* The wires carry the flow too. Without them the dots stop at one
     * component and reappear at the next, and the one thing the animation is
     * for — seeing the current go *round* — is exactly what is missing. */
    const wireCharge = wireFlow(netlist, charges);
    const wireCurrent = wireFlow(netlist, currents);
    netlist.wires.forEach((w, j) => trail(w, wireCharge[j], wireCurrent[j]));

    if (xs.length) {
      layers.push({
        type: 'points',
        xs: Float64Array.from(xs),
        ys: Float64Array.from(ys),
        colour: cfg.flowMode === 'electron' ? '#60d5fa' : '#fbbf24',
        radius: 2.6,
        alpha: 0.9,
      });
    }
  }

  // ---- node voltages ----------------------------------------------------
  if (cfg.showNodeVoltages) {
    const seen = new Set<number>();
    for (const [pointKey, node] of netlist.nodeOfPoint) {
      if (seen.has(node)) continue;
      seen.add(node);
      const [x, y] = pointKey.split(',').map(Number);
      const v = node < 0 ? 0 : instant.nodeVoltage(node);
      layers.push({
        type: 'text',
        x,
        y: y - 0.22,
        text: `${v.toFixed(2)} V`,
        colour: node < 0 ? 'rgba(148,163,184,0.8)' : 'rgba(56,189,248,0.95)',
        align: 'center',
        baseline: 'bottom',
        size: 9,
      });
    }
  }

  // ---- placement preview ------------------------------------------------
  if (hover && cfg.tool !== 'select') {
    const ghost: CircuitElement = {
      id: 'ghost',
      kind: cfg.tool as ElementKind,
      x: hover.x,
      y: hover.y,
      orientation: hover.orientation,
      reversed: false,
      values: defaultValues(cfg.tool as ElementKind),
      label: '',
    };
    for (const l of symbol(ghost, 'rgba(139,124,246,0.55)', 0)) layers.push(l);
  }

  /* Grid lines on the integers, which is exactly where components can go.
   * The generic "nice ticks" chooser would pick 2s or 0.5s depending on the
   * zoom, and a placement grid whose lines are not the placement positions is
   * worse than no grid at all. */
  const ticks = (min: number, max: number) => {
    const out: number[] = [];
    const from = Math.ceil(min);
    const to = Math.floor(max);
    // Stop drawing once the lines would be closer together than they are
    // useful; the schematic is legible without them when zoomed far out.
    if (to - from > 120) return [];
    for (let v = from; v <= to; v++) out.push(v);
    return out;
  };

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: false,
    showAxes: false,
    ticksX: ticks(tab.viewport.xMin, tab.viewport.xMax),
    ticksY: ticks(tab.viewport.yMin, tab.viewport.yMax),
    formatX: () => '',
    formatY: () => '',
  };
}

// ------------------------------------------------------------------ surface

/** The grid edge nearest a point, and whether it runs across or down. */
function nearestEdge(x: number, y: number): { x: number; y: number; orientation: 'h' | 'v' } {
  const hx = Math.round(x - 0.5);
  const hy = Math.round(y);
  const vx = Math.round(x);
  const vy = Math.round(y - 0.5);
  const dh = Math.hypot(x - (hx + 0.5), y - hy);
  const dv = Math.hypot(x - vx, y - (vy + 0.5));
  return dh <= dv ? { x: hx, y: hy, orientation: 'h' } : { x: vx, y: vy, orientation: 'v' };
}

export function CircuitSurface({ tab }: { tab: TabState }) {
  const cfg = tab.circuits;
  const setCircuits = useStore((s) => s.setCircuits);
  const setViewport = useStore((s) => s.setViewport);
  const patchActive = useStore((s) => s.patchActive);
  const commit = useStore((s) => s.commit);
  const plotRef = usePlot2DRef();
  const [hover, setHover] = useState<{ x: number; y: number; orientation: 'h' | 'v' } | null>(null);
  const paintingRef = useRef(false);

  const { run, ready } = useCircuitRun(cfg.world, cfg.analysis, tab.timeline.tMax);
  useSquareScales(plotRef, tab.viewport);
  const traj = run.traj;
  const sampleIndex = traj ? circuitSampleAt(traj, tab.timeline.t) : 0;

  const instant = useMemo((): Instant => {
    const count = run.netlist.active.length;
    const nodes = run.netlist.nodeCount;
    if (traj && traj.count > 0) {
      const k = Math.min(sampleIndex, traj.count - 1);
      return {
        voltage: (i) => traj.voltage[k * count + i],
        current: (i) => traj.current[k * count + i],
        charge: (i) => traj.charge[k * count + i],
        nodeVoltage: (n) => traj.nodeVoltage[k * nodes + n],
        peakCurrent: traj.peakCurrent,
        time: traj.time[k],
      };
    }
    const dc = run.dc;
    let peak = 0;
    for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(dc?.elementCurrent[i] ?? 0));
    return {
      voltage: (i) => dc?.elementVoltage[i] ?? 0,
      current: (i) => dc?.elementCurrent[i] ?? 0,
      // Nothing is changing, so the charge delivered really is I·t.
      charge: (i) => (dc?.elementCurrent[i] ?? 0) * tab.timeline.t,
      nodeVoltage: (n) => dc?.nodeVoltage[n] ?? 0,
      peakCurrent: peak,
      time: tab.timeline.t,
    };
  }, [run, traj, sampleIndex, tab.timeline.t]);

  const editWorld = useCallback(
    (elements: CircuitElement[], select?: string | null) => {
      commit();
      setCircuits({
        world: { ...cfg.world, elements },
        ...(select !== undefined ? { selectedId: select } : {}),
      });
      patchActive({ timeline: { ...tab.timeline, t: 0 } });
    },
    [commit, setCircuits, cfg.world, patchActive, tab.timeline],
  );

  /* Ground is the one part that occupies a *point* rather than an edge, so it
   * never blocks a wire and is only picked when nothing else is on the edge.
   * Treating it like everything else meant a ground symbol made both edges at
   * its corner unusable, which is exactly the corner a return rail wants. */
  const onEdge = useCallback(
    (elements: CircuitElement[], edge: { x: number; y: number; orientation: 'h' | 'v' }) =>
      elements.find((e) => e.kind !== 'ground' && e.x === edge.x && e.y === edge.y && e.orientation === edge.orientation),
    [],
  );

  const elementAt = useCallback(
    (edge: { x: number; y: number; orientation: 'h' | 'v' }) =>
      onEdge(cfg.world.elements, edge) ??
      cfg.world.elements.find((e) => e.kind === 'ground' && e.x === edge.x && e.y === edge.y),
    [cfg.world.elements, onEdge],
  );

  const place = useCallback(
    (edge: { x: number; y: number; orientation: 'h' | 'v' }, elements: CircuitElement[]): CircuitElement[] | null => {
      const kind = cfg.tool as ElementKind;
      const occupied =
        kind === 'ground'
          ? elements.find((e) => e.kind === 'ground' && e.x === edge.x && e.y === edge.y)
          : onEdge(elements, edge);
      // A second wire on an edge that already has one is a no-op rather than a
      // duplicate: painting a run of wire drags across the same edge
      // repeatedly, and every one of those would otherwise be a new element.
      if (occupied) return null;
      const spec = SPEC_BY_KIND.get(kind);
      const count = elements.filter((e) => e.kind === kind).length + 1;
      const label =
        kind === 'wire' || kind === 'ground'
          ? ''
          : `${spec?.name ?? kind}${count > 1 ? ` ${count}` : ''}`;
      const element: CircuitElement = {
        id: uid(kind),
        kind,
        x: edge.x,
        y: edge.y,
        orientation: edge.orientation,
        reversed: false,
        values: defaultValues(kind),
        label,
      };
      return [...elements, element];
    },
    [cfg.tool, onEdge],
  );

  const onPointerDown = useCallback(
    (e: { x: number; y: number; button: number }): boolean => {
      if (e.button !== 0) return false;
      const edge = nearestEdge(e.x, e.y);

      if (cfg.tool === 'select') {
        const hit = elementAt(edge);
        setCircuits({ selectedId: hit?.id ?? null });
        return !!hit;
      }

      const next = place(edge, cfg.world.elements);
      if (next) {
        editWorld(next, next[next.length - 1].id);
      }
      paintingRef.current = cfg.tool === 'wire';
      return true;
    },
    [cfg.tool, cfg.world.elements, elementAt, setCircuits, place, editWorld],
  );

  const onPointerMove = useCallback(
    (e: { x: number; y: number }) => {
      const edge = nearestEdge(e.x, e.y);
      setHover(edge);
      if (!paintingRef.current) return;
      const next = place(edge, cfg.world.elements);
      // Painting a wire run adds edges without a commit each: the whole stroke
      // is one undo step, taken when the pointer comes up.
      if (next) setCircuits({ world: { ...cfg.world, elements: next } });
    },
    [cfg.world, place, setCircuits],
  );

  const onPointerUp = useCallback(() => {
    if (paintingRef.current) {
      paintingRef.current = false;
      commit();
    }
  }, [commit]);

  const scene = useMemo(
    () => buildCircuitScene(tab, run, instant, hover),
    [tab, run, instant, hover],
  );

  const analytic = useMemo(() => analyseCircuit(cfg.world, run.netlist), [cfg.world, run.netlist]);

  const traces = useMemo((): Trace[] => {
    if (!traj || traj.count < 1) return [];
    const upTo = Math.min(sampleIndex, traj.count - 1);
    const stride = Math.max(1, Math.floor(upTo / 1200));
    const points = Math.floor(upTo / stride) + 1;
    return cfg.readings
      .filter((r) => r.visible)
      .map((r) => {
        const xs = new Float64Array(points);
        const ys = new Float64Array(points);
        for (let i = 0; i < points; i++) {
          const k = Math.min(upTo, i * stride);
          xs[i] = traj.time[k];
          ys[i] = readCircuit(traj, r, k);
        }
        const overlay =
          analytic.overlay && analytic.overlay.kind === r.kind && analytic.overlay.target === r.target
            ? analytic.overlay
            : null;
        let predicted: Float64Array | undefined;
        if (overlay) {
          predicted = new Float64Array(points);
          for (let i = 0; i < points; i++) predicted[i] = overlay.fn(xs[i]);
        }
        // The simulator reports voltages relative to how the part was laid
        // down, so a cell placed one way round gives a negative reading of a
        // perfectly ordinary charging curve. The prediction is always written
        // the positive way up, so match its sign rather than showing the user
        // an upside-down exponential and calling it a mismatch.
        if (predicted && ys.length && predicted[predicted.length - 1] * ys[ys.length - 1] < 0) {
          for (let i = 0; i < points; i++) ys[i] = -ys[i];
        }
        return {
          id: r.id,
          label: readingLabel(cfg.world, r),
          unit: READING_INFO[r.kind].unit,
          colour: r.colour,
          xs,
          ys,
          predicted,
          predictedLabel: overlay?.label,
        };
      });
  }, [traj, sampleIndex, cfg.readings, cfg.world, analytic]);

  const groups = useMemo(() => groupByUnit(traces), [traces]);
  const problem = run.netlist.problems[0] ?? traj?.failure ?? null;

  return (
    <SandboxLayout
      storageKey="circuits"
      canvas={
        <div className="flex h-full w-full flex-col">
          <CircuitToolbar
            tool={cfg.tool}
            onTool={(tool) => setCircuits({ tool })}
            analysis={cfg.analysis}
            onAnalysis={(analysis) => setCircuits({ analysis })}
          />
          <div className="relative min-h-0 flex-1">
            <Plot2D
              ref={plotRef}
              scene={scene}
              onViewportChange={setViewport}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              showCrosshair={false}
              readout={() => null}
            />
            {problem && (
              <div className="pointer-events-none absolute inset-x-3 bottom-3">
                <Callout kind="warn">{problem}</Callout>
              </div>
            )}
            {run.netlist.warnings.length > 0 && !problem && (
              <div className="pointer-events-none absolute inset-x-3 bottom-3">
                <Callout>{run.netlist.warnings[0]}</Callout>
              </div>
            )}
            {!ready && (
              <div className="pointer-events-none absolute right-3 top-3 rounded bg-surface-0/85 px-2 py-1 text-2xs text-ink-faint">
                solving…
              </div>
            )}
          </div>
        </div>
      }
      instruments={
        <>
          <div className="border-b border-edge px-3 py-2">
            <h3 className="text-xs font-semibold text-ink">
              {cfg.analysis === 'dc' ? 'Steady state' : 'Readings'}
            </h3>
            <p className="mt-0.5 text-2xs text-ink-faint">
              {cfg.analysis === 'dc'
                ? 'Capacitors are open circuits and inductors are shorts, so this is where the circuit settles.'
                : 'Recorded as the clock runs. Dashed lines are the analytic prediction.'}
            </p>
          </div>

          {cfg.analysis === 'dc' ? (
            <div className="px-3 py-2.5">
              <StatList>
                {cfg.readings.map((r) => {
                  const i = run.netlist.active.findIndex((e) => e.id === r.target);
                  if (i < 0) return null;
                  const info = READING_INFO[r.kind];
                  const value = readingValue(
                    run.netlist.active[i],
                    instant.voltage(i),
                    instant.current(i),
                    r.kind,
                    cfg.world.temperature,
                    run.traj?.state.blown[i] ?? false,
                  );
                  return (
                    <Stat
                      key={r.id}
                      label={readingLabel(cfg.world, r)}
                      value={Number.isFinite(value) ? engineering(value, info.unit) : '—'}
                    />
                  );
                })}
              </StatList>
              {cfg.readings.length === 0 && (
                <p className="text-2xs leading-relaxed text-ink-faint">
                  Add a reading from the panel on the left to see it here.
                </p>
              )}
            </div>
          ) : (
            groups.map((group, i) => (
              <ProbePlot
                key={group.map((t) => t.id).join('|') || i}
                traces={group}
                xLabel="t (s)"
                cursorTime={traj && traj.count ? traj.time[Math.min(sampleIndex, traj.count - 1)] : null}
                height={Math.max(140, Math.round(330 / Math.max(1, groups.length)))}
              />
            ))
          )}
          {cfg.analysis === 'transient' && groups.length === 0 && (
            <p className="px-3 py-6 text-center text-2xs text-ink-faint">
              {cfg.readings.length
                ? 'Press play, or drag the timeline, and the traces appear here.'
                : 'Add a reading from the panel on the left.'}
            </p>
          )}

          <ElementReadout tab={tab} run={run} instant={instant} />
          {cfg.showEquations && <AnalyticCard result={analytic} />}
        </>
      }
    />
  );
}

function ElementReadout({ tab, run, instant }: { tab: TabState; run: Run; instant: Instant }) {
  const cfg = tab.circuits;
  const index = run.netlist.active.findIndex((e) => e.id === cfg.selectedId);
  if (index < 0) return null;
  const e = run.netlist.active[index];
  const v = instant.voltage(index);
  const i = instant.current(index);
  const power = v * i;
  const resistance = staticResistance(e, cfg.world.temperature, run.traj?.state.blown[index] ?? false);

  return (
    <div className="border-t border-edge px-3 py-2.5">
      <h3 className="mb-1.5 text-xs font-semibold text-ink">{e.label || SPEC_BY_KIND.get(e.kind)?.name}</h3>
      <StatList>
        <Stat label="Voltage across" value={engineering(v, 'V')} />
        <Stat label="Current through" value={engineering(i, 'A')} />
        <Stat
          label={power >= 0 ? 'Power dissipated' : 'Power delivered'}
          value={engineering(Math.abs(power), 'W')}
          emphasis
        />
        {Number.isFinite(resistance) && resistance < 1e11 && (
          <Stat label="Resistance" value={engineering(resistance, 'Ω')} />
        )}
        {e.kind === 'capacitor' && <Stat label="Charge" value={engineering(e.values.capacitance * v, 'C')} />}
        {e.kind === 'capacitor' && (
          <Stat label="Energy stored" value={engineering(0.5 * e.values.capacitance * v * v, 'J')} />
        )}
        {e.kind === 'inductor' && (
          <Stat label="Energy stored" value={engineering(0.5 * e.values.inductance * i * i, 'J')} />
        )}
        {(e.kind === 'cell' || e.kind === 'battery') && (
          <Stat label="EMF" value={engineering(sourceVoltage(e, instant.time), 'V')} />
        )}
      </StatList>
    </div>
  );
}

function CircuitToolbar({
  tool,
  onTool,
  analysis,
  onAnalysis,
}: {
  tool: string;
  onTool: (t: string) => void;
  analysis: 'dc' | 'transient';
  onAnalysis: (a: 'dc' | 'transient') => void;
}) {
  return (
    <div className="shrink-0 space-y-1 border-b border-edge bg-surface-0 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-tool="select"
          onClick={() => onTool('select')}
          title="Select and edit parts"
          className={`rounded px-2 py-1 text-2xs transition-colors ${
            tool === 'select' ? 'bg-accent text-white' : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
          }`}
        >
          Select
        </button>
        <span className="mx-0.5 h-4 w-px bg-edge" />
        {PALETTE.map((kind) => {
          const spec = SPEC_BY_KIND.get(kind);
          return (
            <button
              key={kind}
              type="button"
              data-tool={kind}
              onClick={() => onTool(kind)}
              title={spec?.blurb}
              className={`rounded px-2 py-1 text-2xs transition-colors ${
                tool === kind ? 'bg-accent text-white' : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
              }`}
            >
              {spec?.name ?? kind}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <div className="w-56">
          <SegmentedControl
            size="sm"
            value={analysis}
            onChange={onAnalysis}
            options={[
              { value: 'dc', label: 'Steady state', title: 'Where the circuit settles' },
              { value: 'transient', label: 'Over time', title: 'Play the circuit against the clock' },
            ]}
          />
        </div>
        <span className="truncate text-2xs text-ink-faint">
          {tool === 'select'
            ? 'Click a part to edit it. Drag with the Wire tool to lay a run of wire.'
            : `Click a grid edge to place a ${SPEC_BY_KIND.get(tool as ElementKind)?.name.toLowerCase() ?? 'part'}.`}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ panel

export function CircuitPanel({ tab }: { tab: TabState }) {
  const cfg = tab.circuits;
  const setCircuits = useStore((s) => s.setCircuits);
  const patchActive = useStore((s) => s.patchActive);
  const commit = useStore((s) => s.commit);
  const world = cfg.world;
  const selected = world.elements.find((e) => e.id === cfg.selectedId);
  const spec = selected ? SPEC_BY_KIND.get(selected.kind) : undefined;

  const setWorld = (patch: Partial<CircuitWorld>) => {
    commit();
    setCircuits({ world: { ...world, ...patch } });
    patchActive({ timeline: { ...tab.timeline, t: 0 } });
  };

  const updateSelected = (patch: Partial<CircuitElement>) => {
    if (!selected) return;
    setWorld({ elements: world.elements.map((e) => (e.id === selected.id ? { ...e, ...patch } : e)) });
  };

  const setValue = (key: string, value: number) => {
    if (!selected) return;
    setWorld({
      elements: world.elements.map((e) =>
        e.id === selected.id ? { ...e, values: { ...e.values, [key]: value } } : e,
      ),
    });
  };

  const measurable = world.elements.filter((e) => availableReadings(e.kind).length > 0);

  return (
    <>
      <Collapsible title="Bench">
        <div>
          <span className="field-label">Analysis</span>
          <SegmentedControl
            value={cfg.analysis}
            onChange={(analysis) => setCircuits({ analysis })}
            options={[
              { value: 'dc', label: 'Steady state' },
              { value: 'transient', label: 'Over time' },
            ]}
          />
        </div>
        <Field
          label="Temperature (°C)"
          hint="Thermistors read this. Everything else ignores it."
        >
          <Slider
            value={world.temperature}
            min={-20}
            max={120}
            step={0.5}
            onChange={(temperature) => setWorld({ temperature })}
          />
        </Field>
        {cfg.analysis === 'transient' && (
          <Field
            label="Timestep (s)"
            hint="Zero picks one from the fastest time constant in the circuit."
          >
            <NumberField
              value={world.timestep}
              min={0}
              step={1e-5}
              onChange={(timestep) => setWorld({ timestep: Math.max(0, timestep) })}
            />
          </Field>
        )}
      </Collapsible>

      <Collapsible title={selected ? (selected.label || spec?.name || 'Part') : 'Nothing selected'} defaultOpen={!!selected}>
        {!selected && (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Pick a part from the toolbar and click a grid edge to place it, then select it here to set its value.
          </p>
        )}

        {selected && spec && (
          <>
            {spec.blurb && <Callout>{spec.blurb}</Callout>}
            {selected.kind !== 'wire' && selected.kind !== 'ground' && (
              <Field label="Name">
                <TextField value={selected.label} onChange={(label) => updateSelected({ label })} />
              </Field>
            )}

            {spec.values.map((v) => {
              if (v.key === 'closed') {
                return (
                  <Toggle
                    key={v.key}
                    label="Closed"
                    hint="An open switch breaks the circuit."
                    checked={selected.values.closed >= 0.5}
                    onChange={(on) => setValue('closed', on ? 1 : 0)}
                  />
                );
              }
              return (
                <Field key={v.key} label={`${v.label}${v.unit ? ` (${v.unit})` : ''}`}>
                  <NumberField
                    value={selected.values[v.key] ?? v.default}
                    min={v.min}
                    max={v.max}
                    step={v.step}
                    onChange={(n) => setValue(v.key, n)}
                  />
                  {v.log ? (
                    // A logarithmic slider, because capacitance spans nine
                    // decades and a linear one would spend its whole travel
                    // between 0.9 and 1 farad.
                    <Slider
                      value={Math.log10(Math.max(v.min, selected.values[v.key] ?? v.default))}
                      min={Math.log10(v.min)}
                      max={Math.log10(v.max)}
                      step={0.01}
                      onChange={(n) => setValue(v.key, Math.pow(10, n))}
                    />
                  ) : (
                    <Slider
                      value={selected.values[v.key] ?? v.default}
                      min={v.min}
                      max={v.max}
                      step={v.step}
                      onChange={(n) => setValue(v.key, n)}
                    />
                  )}
                </Field>
              );
            })}

            <Row>
              {spec.polarised && (
                <Button className="flex-1" onClick={() => updateSelected({ reversed: !selected.reversed })}>
                  <span className="flex items-center justify-center gap-1.5">
                    <IconRefresh size={12} /> Turn it round
                  </span>
                </Button>
              )}
              {selected.kind !== 'ground' && (
                <Button
                  className="flex-1"
                  title="Swap between running across and running down"
                  onClick={() => updateSelected({ orientation: selected.orientation === 'h' ? 'v' : 'h' })}
                >
                  Rotate
                </Button>
              )}
            </Row>

            <Button
              className="w-full"
              onClick={() => {
                setWorld({ elements: world.elements.filter((e) => e.id !== selected.id) });
                setCircuits({
                  selectedId: null,
                  readings: cfg.readings.filter((r) => r.target !== selected.id),
                });
              }}
            >
              <span className="flex items-center justify-center gap-1.5">
                <IconTrash size={12} /> Remove this part
              </span>
            </Button>
          </>
        )}
      </Collapsible>

      <Collapsible
        title={`Readings${cfg.readings.length ? ` · ${cfg.readings.length}` : ''}`}
        actions={
          <IconButton
            title="Measure something else"
            onClick={() => {
              const target = selected && availableReadings(selected.kind).length ? selected : measurable[0];
              if (!target) return;
              commit();
              setCircuits({
                readings: [
                  ...cfg.readings,
                  {
                    id: uid('read'),
                    kind: availableReadings(target.kind)[0],
                    target: target.id,
                    colour: SERIES_COLOURS[cfg.readings.length % SERIES_COLOURS.length],
                    visible: true,
                  },
                ],
              });
            }}
          >
            <IconPlus size={14} />
          </IconButton>
        }
      >
        {cfg.readings.length === 0 && (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Nothing is being measured. Select a part and add a reading to plot its voltage, current or power.
          </p>
        )}
        <div className="space-y-2">
          {cfg.readings.map((r) => {
            const element = world.elements.find((e) => e.id === r.target);
            const kinds = element ? availableReadings(element.kind) : [];
            return (
              <div key={r.id} className="rounded-md border border-edge bg-surface-1 p-2">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.colour }} />
                  <span className="flex-1 truncate text-2xs text-ink-dim">{readingLabel(world, r)}</span>
                  <IconButton
                    title={r.visible ? 'Hide from the chart' : 'Show on the chart'}
                    onClick={() =>
                      setCircuits({
                        readings: cfg.readings.map((x) => (x.id === r.id ? { ...x, visible: !x.visible } : x)),
                      })
                    }
                  >
                    {r.visible ? <IconEye size={13} /> : <IconEyeOff size={13} />}
                  </IconButton>
                  <IconButton
                    title="Stop measuring this"
                    onClick={() => {
                      commit();
                      setCircuits({ readings: cfg.readings.filter((x) => x.id !== r.id) });
                    }}
                  >
                    <IconClose size={13} />
                  </IconButton>
                </div>
                <Select
                  value={r.target}
                  onChange={(target) => {
                    const next = world.elements.find((e) => e.id === target);
                    const allowed = next ? availableReadings(next.kind) : [];
                    setCircuits({
                      readings: cfg.readings.map((x) =>
                        x.id === r.id
                          ? { ...x, target, kind: allowed.includes(x.kind) ? x.kind : (allowed[0] ?? 'voltage') }
                          : x,
                      ),
                    });
                  }}
                  options={measurable.map((e) => ({
                    value: e.id,
                    label: e.label || SPEC_BY_KIND.get(e.kind)?.name || e.kind,
                  }))}
                />
                <Select
                  value={r.kind}
                  onChange={(kind) =>
                    setCircuits({
                      readings: cfg.readings.map((x) => (x.id === r.id ? { ...x, kind: kind as ReadingKind } : x)),
                    })
                  }
                  options={kinds.map((k) => ({
                    value: k,
                    label: `${READING_INFO[k].label}${READING_INFO[k].unit ? ` (${READING_INFO[k].unit})` : ''}`,
                  }))}
                />
              </div>
            );
          })}
        </div>
      </Collapsible>

      <Collapsible title="Display" defaultOpen={false}>
        <Toggle
          label="Animate the current"
          hint="Dots follow the charge round the circuit, faster where the current is larger."
          checked={cfg.showCurrent}
          onChange={(showCurrent) => setCircuits({ showCurrent })}
        />
        {cfg.showCurrent && (
          <div>
            <span className="field-label">The dots are</span>
            <SegmentedControl
              size="sm"
              value={cfg.flowMode}
              onChange={(flowMode) => setCircuits({ flowMode })}
              options={[
                {
                  value: 'conventional',
                  label: 'Conventional current',
                  title: 'Positive charge, leaving the + terminal and going round to the −.',
                },
                {
                  value: 'electron',
                  label: 'Electron flow',
                  title: 'The electrons themselves: negative, so they drift the opposite way — out of the − terminal.',
                },
              ]}
            />
          </div>
        )}
        <Toggle
          label="Node voltages"
          hint="Labels each junction, and colours the wires by potential."
          checked={cfg.showNodeVoltages}
          onChange={(showNodeVoltages) => setCircuits({ showNodeVoltages })}
        />
        <Toggle label="Component values" checked={cfg.showValues} onChange={(showValues) => setCircuits({ showValues })} />
        <Toggle
          label="Governing equations"
          checked={cfg.showEquations}
          onChange={(showEquations) => setCircuits({ showEquations })}
        />
      </Collapsible>

      <ViewPanel tab={tab} showAxesOptions={false} />

      <Collapsible title="Start over" defaultOpen={false}>
        <Button
          className="w-full"
          onClick={() => {
            commit();
            setCircuits({
              world: { ...world, elements: [] },
              readings: [],
              selectedId: null,
            });
            patchActive({ timeline: { ...tab.timeline, t: 0, playing: false } });
          }}
        >
          Clear the board
        </Button>
      </Collapsible>
    </>
  );
}

// ------------------------------------------------------------------ export

export function circuitsCsv(tab: TabState): string | null {
  const cfg = tab.circuits;
  const visible = cfg.readings.filter((r) => r.visible);
  if (!visible.length) return null;
  if (cfg.analysis === 'dc') {
    const netlist = buildNetlist(cfg.world);
    const state = operatingPoint(cfg.world, netlist);
    const rows = visible.map((r) => {
      const i = netlist.active.findIndex((e) => e.id === r.target);
      const v = i < 0 ? NaN : state.elementVoltage[i];
      const current = i < 0 ? NaN : state.elementCurrent[i];
      return [readingLabel(cfg.world, r), r.kind === 'voltage' ? v : r.kind === 'current' ? current : v * current];
    });
    return toCsv(['reading', 'value'], rows);
  }

  const traj = createCircuitTrajectory(cfg.world, tab.timeline.tMax);
  advanceCircuit(traj, tab.timeline.tMax, 2000000);
  const headers = ['t', ...visible.map((r) => `${readingLabel(cfg.world, r)} (${READING_INFO[r.kind].unit})`)];
  const rows: (number | string)[][] = [];
  const stride = Math.max(1, Math.floor(traj.count / 1000));
  for (let k = 0; k < traj.count; k += stride) {
    rows.push([traj.time[k], ...visible.map((r) => readCircuit(traj, r, k))]);
  }
  return toCsv(headers, rows);
}

export { ELEMENT_SPECS };
