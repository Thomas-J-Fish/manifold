import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import { SERIES_COLOURS, type MechanicsTool, type TabState } from '../core/types';
import {
  MEASUREMENT_INFO,
  advance,
  createTrajectory,
  measurementLabel,
  prepare,
  readMeasurement,
  sampleAt,
  suggestedStep,
  type Body,
  type Link,
  type MeasurementKind,
  type MechTrajectory,
  type MechanicsWorld,
  type PreparedWorld,
  type Pulley,
  type Surface,
} from '../core/physics/mechanics';
import { analyseMechanics } from '../core/physics/analytic';
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
  fmt,
} from '../components/ui/controls';
import { IconClose, IconEye, IconEyeOff, IconPlus, IconTrash } from '../components/ui/Icons';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* The mechanics sandbox.
 *
 * Two halves: a bench you build on, and the instruments watching it. The bench
 * is the ordinary 2D plotting surface with metres for units, which means pan,
 * zoom, grid and axes all come for free and behave exactly as they do in every
 * other tab — a sandbox that invented its own navigation would be the one part
 * of the app that felt foreign.
 *
 * The one rule that shapes everything here: what you build is the state at
 * t = 0. Dragging a mass edits the initial condition, so the clock rewinds and
 * the trajectory is recomputed from scratch. The alternative — letting you
 * shove things around mid-flight — makes for a livelier toy and a useless
 * instrument, because no measurement taken during the run would mean anything.
 */

const TOOL_HINTS: Record<MechanicsTool, string> = {
  select: 'Click to select, drag to move. Everything you move sets the starting position.',
  mass: 'Click to drop a mass.',
  anchor: 'Click to fix a point in space.',
  rod: 'Click two bodies to join them with a rigid rod.',
  rope: 'Click two bodies to join them with a rope — it pulls, but never pushes.',
  spring: 'Click two bodies to connect a spring.',
  surface: 'Drag to draw a surface. Blocks rest on it and slide along it.',
  pulley: 'Click where the peg goes, then the two masses the rope runs between.',
};

const TOOLS: { id: MechanicsTool; label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'mass', label: 'Mass' },
  { id: 'anchor', label: 'Anchor' },
  { id: 'rod', label: 'Rod' },
  { id: 'rope', label: 'Rope' },
  { id: 'spring', label: 'Spring' },
  { id: 'surface', label: 'Surface' },
  { id: 'pulley', label: 'Pulley' },
];

// ------------------------------------------------------------------ the run

interface Run {
  prep: PreparedWorld;
  traj: MechTrajectory;
}

/**
 * Holds the trajectory for the current scene, recomputing it whenever the
 * scene changes and extending it as the clock advances.
 *
 * The trajectory is a cache, not derived state: it is expensive, it only ever
 * grows, and scrubbing backwards has to be instant. Keeping it in a ref keyed
 * by a signature of the world gives all three — and because integration is
 * deterministic from t = 0, scrubbing to four seconds and back to one shows
 * exactly the same thing both times, which a live stepper could never promise.
 */
function useRun(world: MechanicsWorld, until: number): { run: Run; ready: boolean } {
  const signature = useMemo(() => JSON.stringify(world), [world]);
  const ref = useRef<{ signature: string; run: Run } | null>(null);
  const [, bump] = useState(0);

  if (!ref.current || ref.current.signature !== signature) {
    const prep = prepare(world);
    ref.current = { signature, run: { prep, traj: createTrajectory(prep) } };
  }
  const run = ref.current.run;

  // A generous but bounded slice per frame: enough that a ten-second timeline
  // is ready almost at once, small enough that a stiff scene cannot lock the
  // window while it integrates.
  const ready = advance(run.traj, until, 6000);

  useEffect(() => {
    if (ready) return;
    const id = requestAnimationFrame(() => bump((n) => n + 1));
    return () => cancelAnimationFrame(id);
  }, [ready, until, signature]);

  return { run, ready };
}

// ------------------------------------------------------------------ drawing

const ANCHOR_COLOUR = '#94a3b8';

function springPath(ax: number, ay: number, bx: number, by: number, coils: number, radius: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const lead = Math.min(0.18 * len, 0.12);
  const body = len - 2 * lead;
  const steps = Math.max(8, coils * 4);
  const xs: number[] = [ax, ax + ux * lead];
  const ys: number[] = [ay, ay + uy * lead];
  for (let i = 1; i < steps; i++) {
    const s = lead + (body * i) / steps;
    const side = i % 2 === 0 ? 0 : i % 4 === 1 ? 1 : -1;
    xs.push(ax + ux * s + nx * side * radius);
    ys.push(ay + uy * s + ny * side * radius);
  }
  xs.push(ax + ux * (len - lead), bx);
  ys.push(ay + uy * (len - lead), by);
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) };
}

/** Builds every layer of the bench for one instant of the run. */
function buildScene(
  tab: TabState,
  run: Run,
  sampleIndex: number,
  pending: PendingBuild | null,
): PlotScene {
  const cfg = tab.mechanics;
  const world = cfg.world;
  const { prep, traj } = run;
  const n = prep.free.length;
  const layers: Layer[] = [];
  const selected = cfg.selectedId;

  const position = (id: string): [number, number] => {
    const i = prep.freeIndexById.get(id);
    const body = world.bodies.find((b) => b.id === id);
    if (i === undefined || traj.count === 0) return body ? [body.x, body.y] : [0, 0];
    const k = Math.min(sampleIndex, traj.count - 1);
    return [traj.pos[k * 2 * n + 2 * i], traj.pos[k * 2 * n + 2 * i + 1]];
  };
  const velocity = (id: string): [number, number] => {
    const i = prep.freeIndexById.get(id);
    if (i === undefined || traj.count === 0) return [0, 0];
    const k = Math.min(sampleIndex, traj.count - 1);
    return [traj.vel[k * 2 * n + 2 * i], traj.vel[k * 2 * n + 2 * i + 1]];
  };

  // ---- surfaces ---------------------------------------------------------
  for (const s of world.surfaces) {
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    if (ny < 0 || (Math.abs(ny) < 1e-12 && nx < 0)) {
      nx = -nx;
      ny = -ny;
    }
    if (s.flip) {
      nx = -nx;
      ny = -ny;
    }
    // Hatching on the solid side, the way it is drawn on a blackboard.
    const hatch: number[] = [];
    const spacing = Math.max(0.12, len / 26);
    const depth = spacing * 0.9;
    for (let d = spacing / 2; d < len; d += spacing) {
      const px = s.x0 + (dx / len) * d;
      const py = s.y0 + (dy / len) * d;
      hatch.push(px, py, px - nx * depth - (dx / len) * depth * 0.6, py - ny * depth - (dy / len) * depth * 0.6);
    }
    layers.push({
      type: 'segments',
      data: Float64Array.from(hatch),
      colour: withAlpha(s.colour, 0.5),
      width: 1,
    });
    layers.push({
      type: 'polyline',
      xs: Float64Array.from([s.x0, s.x1]),
      ys: Float64Array.from([s.y0, s.y1]),
      colour: selected === s.id ? '#8b7cf6' : s.colour,
      width: selected === s.id ? 3.5 : 2.5,
    });
    if (cfg.showValues && (s.muK > 0 || s.muS > 0)) {
      layers.push({
        type: 'text',
        x: (s.x0 + s.x1) / 2,
        y: (s.y0 + s.y1) / 2 - 0.001,
        text: `μ ${fmt(s.muK, 2)}`,
        colour: 'rgba(154,163,184,0.9)',
        align: 'center',
        baseline: 'top',
        size: 10,
      });
    }
  }

  // ---- pulleys ----------------------------------------------------------
  for (const p of world.pulleys) {
    const circle: number[] = [];
    const circleY: number[] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      circle.push(p.x + p.radius * Math.cos(a));
      circleY.push(p.y + p.radius * Math.sin(a));
    }
    layers.push({
      type: 'polyline',
      xs: Float64Array.from(circle),
      ys: Float64Array.from(circleY),
      colour: selected === p.id ? '#8b7cf6' : p.colour,
      width: 2,
      fill: withAlpha(p.colour, 0.14),
    });
    const [ax, ay] = position(p.a);
    const [bx, by] = position(p.b);
    layers.push({
      type: 'polyline',
      xs: Float64Array.from([ax, p.x, bx]),
      ys: Float64Array.from([ay, p.y, by]),
      colour: '#cbd5e1',
      width: 1.6,
    });
  }

  // ---- links ------------------------------------------------------------
  world.links.forEach((l) => {
    const [ax, ay] = position(l.a);
    const [bx, by] = position(l.b);
    const isSelected = selected === l.id;
    if (l.kind === 'spring') {
      const path = springPath(ax, ay, bx, by, 9, 0.09);
      layers.push({
        type: 'polyline',
        xs: path.xs,
        ys: path.ys,
        colour: isSelected ? '#8b7cf6' : l.colour,
        width: isSelected ? 2.4 : 1.8,
      });
    } else {
      layers.push({
        type: 'polyline',
        xs: Float64Array.from([ax, bx]),
        ys: Float64Array.from([ay, by]),
        colour: isSelected ? '#8b7cf6' : l.colour,
        width: l.kind === 'rod' ? (isSelected ? 4 : 3) : isSelected ? 2.4 : 1.6,
        style: l.kind === 'rope' ? 'solid' : 'solid',
        alpha: l.kind === 'rope' ? 0.85 : 1,
      });
    }
  });

  // ---- trails -----------------------------------------------------------
  if (cfg.showTrails && traj.count > 1) {
    const from = Math.max(0, Math.min(sampleIndex, traj.count - 1) - 900);
    const to = Math.min(sampleIndex, traj.count - 1);
    if (to > from) {
      for (let i = 0; i < n; i++) {
        const body = prep.free[i];
        const xs = new Float64Array(to - from + 1);
        const ys = new Float64Array(to - from + 1);
        for (let k = from; k <= to; k++) {
          xs[k - from] = traj.pos[k * 2 * n + 2 * i];
          ys[k - from] = traj.pos[k * 2 * n + 2 * i + 1];
        }
        layers.push({ type: 'polyline', xs, ys, colour: withAlpha(body.colour, 0.35), width: 1.2 });
      }
    }
  }

  // ---- bodies -----------------------------------------------------------
  for (const b of world.bodies) {
    const [x, y] = b.kind === 'mass' ? position(b.id) : [b.x, b.y];
    const isSelected = selected === b.id;
    if (b.kind === 'anchor') {
      const r = Math.max(0.06, b.radius);
      layers.push({
        type: 'polyline',
        xs: Float64Array.from([x - r, x + r, x + r, x - r, x - r]),
        ys: Float64Array.from([y - r, y - r, y + r, y + r, y - r]),
        colour: isSelected ? '#8b7cf6' : ANCHOR_COLOUR,
        width: 2,
        closed: true,
        fill: withAlpha(ANCHOR_COLOUR, 0.35),
      });
    } else {
      const r = Math.max(0.04, b.radius);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i <= 44; i++) {
        const a = (i / 44) * Math.PI * 2;
        xs.push(x + r * Math.cos(a));
        ys.push(y + r * Math.sin(a));
      }
      layers.push({
        type: 'polyline',
        xs: Float64Array.from(xs),
        ys: Float64Array.from(ys),
        colour: isSelected ? '#ffffff' : b.colour,
        width: isSelected ? 2.5 : 1.5,
        closed: true,
        fill: withAlpha(b.colour, 0.75),
      });
    }
    if (cfg.showValues && b.label) {
      layers.push({
        type: 'marker',
        x,
        y,
        label: b.kind === 'mass' ? `${b.label} · ${fmt(b.mass, 3)} kg` : b.label,
        colour: withAlpha(b.colour, 0.95),
        radius: 0,
        offset: [10, -12],
      });
    }
  }

  // ---- force and velocity arrows ---------------------------------------
  const arrows: { x: number; y: number; dx: number; dy: number; speed: number }[] = [];
  if (cfg.showVelocities) {
    for (const b of world.bodies) {
      if (b.kind !== 'mass') continue;
      const [x, y] = position(b.id);
      const [vx, vy] = velocity(b.id);
      if (Math.hypot(vx, vy) < 1e-6) continue;
      arrows.push({ x, y, dx: vx * 0.12, dy: vy * 0.12, speed: Math.hypot(vx, vy) });
    }
    if (arrows.length) layers.push({ type: 'arrows', arrows, colour: '#38bdf8', width: 1.6, headSize: 7 });
  }

  if (cfg.showForces && traj.count > 0) {
    const k = Math.min(sampleIndex, traj.count - 1);
    const forceArrows: { x: number; y: number; dx: number; dy: number; speed: number }[] = [];
    // Scaled so the heaviest body's weight is a fixed length on screen —
    // an absolute scale makes a 0.1 kg bob's arrows invisible next to a 10 kg
    // block's, which is the opposite of what a force diagram is for.
    let biggest = 1e-6;
    for (const b of world.bodies) if (b.kind === 'mass') biggest = Math.max(biggest, b.mass * world.gravity);
    const scale = 0.5 / biggest;

    for (const b of world.bodies) {
      if (b.kind !== 'mass') continue;
      const [x, y] = position(b.id);
      const weight = b.mass * world.gravity;
      forceArrows.push({ x, y, dx: 0, dy: -weight * scale, speed: weight });
    }
    if (forceArrows.length) {
      layers.push({ type: 'arrows', arrows: forceArrows, colour: '#fbbf24', width: 1.5, headSize: 6, alpha: 0.85 });
    }

    // Tension along each rigid link, drawn from both ends inward.
    const tensionArrows: { x: number; y: number; dx: number; dy: number; speed: number }[] = [];
    world.links.forEach((l, index) => {
      if (l.kind === 'spring') return;
      const force = traj.linkForce[k * world.links.length + index];
      if (!Number.isFinite(force) || Math.abs(force) < 1e-9) return;
      const [ax, ay] = position(l.a);
      const [bx, by] = position(l.b);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const size = force * scale;
      const bodyA = world.bodies.find((b) => b.id === l.a);
      const bodyB = world.bodies.find((b) => b.id === l.b);
      if (bodyA?.kind === 'mass') tensionArrows.push({ x: ax, y: ay, dx: ux * size, dy: uy * size, speed: force });
      if (bodyB?.kind === 'mass') tensionArrows.push({ x: bx, y: by, dx: -ux * size, dy: -uy * size, speed: force });
    });
    if (tensionArrows.length) {
      layers.push({ type: 'arrows', arrows: tensionArrows, colour: '#34d399', width: 1.5, headSize: 6, alpha: 0.9 });
    }

    // Normal and friction, wherever a body is touching something.
    const contactArrows: { x: number; y: number; dx: number; dy: number; speed: number }[] = [];
    for (let i = 0; i < n; i++) {
      const surfaceIndex = traj.contactSurface[k * n + i];
      if (surfaceIndex < 0) continue;
      const s = world.surfaces[surfaceIndex];
      if (!s) continue;
      const dx = s.x1 - s.x0;
      const dy = s.y1 - s.y0;
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len;
      let ny = dx / len;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      if (s.flip) {
        nx = -nx;
        ny = -ny;
      }
      const x = traj.pos[k * 2 * n + 2 * i];
      const y = traj.pos[k * 2 * n + 2 * i + 1];
      const normal = traj.normalForce[k * n + i];
      const friction = traj.frictionForce[k * n + i];
      contactArrows.push({ x, y, dx: nx * normal * scale, dy: ny * normal * scale, speed: normal });
      if (Math.abs(friction) > 1e-9) {
        contactArrows.push({
          x,
          y,
          dx: (dx / len) * friction * scale,
          dy: (dy / len) * friction * scale,
          speed: Math.abs(friction),
        });
      }
    }
    if (contactArrows.length) {
      layers.push({ type: 'arrows', arrows: contactArrows, colour: '#fb7185', width: 1.5, headSize: 6, alpha: 0.9 });
    }
  }

  // ---- what the current tool is waiting for -----------------------------
  if (pending?.kind === 'link' && pending.from) {
    const [x, y] = position(pending.from);
    layers.push({ type: 'points', xs: Float64Array.from([x]), ys: Float64Array.from([y]), colour: '#8b7cf6', radius: 7, shape: 'circle', alpha: 0.5 });
  }
  if (pending?.kind === 'surface' && pending.start && pending.current) {
    layers.push({
      type: 'polyline',
      xs: Float64Array.from([pending.start[0], pending.current[0]]),
      ys: Float64Array.from([pending.start[1], pending.current[1]]),
      colour: '#8b7cf6',
      width: 2,
      style: 'dashed',
    });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'x (m)',
    yLabel: 'y (m)',
    legend: cfg.showForces
      ? [
          { label: 'Weight', colour: '#fbbf24' },
          { label: 'Tension', colour: '#34d399' },
          { label: 'Contact', colour: '#fb7185' },
        ]
      : undefined,
  };
}

// ------------------------------------------------------------------ surface

type PendingBuild =
  | { kind: 'link'; linkKind: 'rod' | 'rope' | 'spring'; from: string | null }
  | { kind: 'surface'; start: [number, number] | null; current: [number, number] | null }
  | { kind: 'pulley'; at: [number, number] | null; first: string | null };

export function MechanicsSurface({ tab }: { tab: TabState }) {
  const cfg = tab.mechanics;
  const setMechanics = useStore((s) => s.setMechanics);
  const patchActive = useStore((s) => s.patchActive);
  const setViewport = useStore((s) => s.setViewport);
  const commit = useStore((s) => s.commit);
  const plotRef = usePlot2DRef();
  const [pending, setPending] = useState<PendingBuild | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const { run, ready } = useRun(cfg.world, tab.timeline.tMax);
  const sampleIndex = sampleAt(run.traj, tab.timeline.t);
  useSquareScales(plotRef, tab.viewport);

  const snap = useCallback(
    (v: number) => (cfg.snap > 0 ? Math.round(v / cfg.snap) * cfg.snap : v),
    [cfg.snap],
  );

  /** Any edit to the scene rewinds the clock — see the note at the top. */
  const editWorld = useCallback(
    (patch: Partial<MechanicsWorld>, alsoSelect?: string | null) => {
      commit();
      setMechanics({
        world: { ...cfg.world, ...patch },
        ...(alsoSelect !== undefined ? { selectedId: alsoSelect } : {}),
      });
      patchActive({ timeline: { ...tab.timeline, t: 0, playing: false } });
    },
    [commit, setMechanics, cfg.world, patchActive, tab.timeline],
  );

  const hitTest = useCallback(
    (x: number, y: number): string | null => {
      const world = cfg.world;
      const tolerance = (tab.viewport.xMax - tab.viewport.xMin) * 0.012;
      for (const b of world.bodies) {
        if (Math.hypot(b.x - x, b.y - y) <= Math.max(b.radius, tolerance)) return b.id;
      }
      for (const p of world.pulleys) {
        if (Math.hypot(p.x - x, p.y - y) <= Math.max(p.radius, tolerance)) return p.id;
      }
      const near = (ax: number, ay: number, bx: number, by: number) => {
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      };
      for (const l of world.links) {
        const a = world.bodies.find((b) => b.id === l.a);
        const b = world.bodies.find((x2) => x2.id === l.b);
        if (a && b && near(a.x, a.y, b.x, b.y) <= tolerance) return l.id;
      }
      for (const s of world.surfaces) {
        if (near(s.x0, s.y0, s.x1, s.y1) <= tolerance) return s.id;
      }
      return null;
    },
    [cfg.world, tab.viewport],
  );

  const addBody = useCallback(
    (kind: 'mass' | 'anchor', x: number, y: number) => {
      const count = cfg.world.bodies.filter((b) => b.kind === kind).length + 1;
      const body: Body = {
        id: uid(kind),
        kind,
        x: snap(x),
        y: snap(y),
        vx: 0,
        vy: 0,
        mass: kind === 'mass' ? 1 : 0,
        radius: kind === 'mass' ? 0.18 : 0.09,
        label: kind === 'mass' ? `Mass ${count}` : `Anchor ${count}`,
        colour: kind === 'mass' ? SERIES_COLOURS[(count - 1) % SERIES_COLOURS.length] : ANCHOR_COLOUR,
      };
      editWorld({ bodies: [...cfg.world.bodies, body] }, body.id);
    },
    [cfg.world.bodies, editWorld, snap],
  );

  const onPointerDown = useCallback(
    (e: { x: number; y: number; button: number }): boolean => {
      if (e.button !== 0) return false;
      const tool = cfg.tool;

      if (tool === 'select') {
        const hit = hitTest(e.x, e.y);
        setMechanics({ selectedId: hit });
        if (hit) {
          const body = cfg.world.bodies.find((b) => b.id === hit);
          if (body) {
            dragRef.current = { id: hit, dx: body.x - e.x, dy: body.y - e.y };
            return true;
          }
          const pulley = cfg.world.pulleys.find((p) => p.id === hit);
          if (pulley) {
            dragRef.current = { id: hit, dx: pulley.x - e.x, dy: pulley.y - e.y };
            return true;
          }
        }
        return false;
      }

      if (tool === 'mass' || tool === 'anchor') {
        addBody(tool, e.x, e.y);
        return true;
      }

      if (tool === 'rod' || tool === 'rope' || tool === 'spring') {
        const hit = hitTest(e.x, e.y);
        const body = cfg.world.bodies.find((b) => b.id === hit);
        if (!body) return true;
        const current = pending?.kind === 'link' ? pending : null;
        if (!current?.from) {
          setPending({ kind: 'link', linkKind: tool, from: body.id });
          return true;
        }
        if (current.from === body.id) {
          setPending(null);
          return true;
        }
        const count = cfg.world.links.length + 1;
        const link: Link = {
          id: uid(tool),
          kind: tool,
          a: current.from,
          b: body.id,
          length: null,
          stiffness: tool === 'spring' ? 60 : 0,
          damping: 0,
          label: `${tool[0].toUpperCase()}${tool.slice(1)} ${count}`,
          colour: tool === 'spring' ? '#38bdf8' : '#cbd5e1',
        };
        setPending(null);
        editWorld({ links: [...cfg.world.links, link] }, link.id);
        return true;
      }

      if (tool === 'surface') {
        setPending({ kind: 'surface', start: [snap(e.x), snap(e.y)], current: [snap(e.x), snap(e.y)] });
        return true;
      }

      if (tool === 'pulley') {
        const current = pending?.kind === 'pulley' ? pending : null;
        if (!current?.at) {
          setPending({ kind: 'pulley', at: [snap(e.x), snap(e.y)], first: null });
          return true;
        }
        const hit = hitTest(e.x, e.y);
        const body = cfg.world.bodies.find((b) => b.id === hit);
        if (!body) return true;
        if (!current.first) {
          setPending({ ...current, first: body.id });
          return true;
        }
        if (current.first === body.id) return true;
        const pulley: Pulley = {
          id: uid('pulley'),
          x: current.at[0],
          y: current.at[1],
          a: current.first,
          b: body.id,
          length: null,
          radius: 0.2,
          label: `Pulley ${cfg.world.pulleys.length + 1}`,
          colour: ANCHOR_COLOUR,
        };
        setPending(null);
        editWorld({ pulleys: [...cfg.world.pulleys, pulley] }, pulley.id);
        return true;
      }

      return false;
    },
    [cfg.tool, cfg.world, hitTest, setMechanics, addBody, pending, editWorld, snap],
  );

  const onPointerMove = useCallback(
    (e: { x: number; y: number }) => {
      if (pending?.kind === 'surface' && pending.start) {
        setPending({ ...pending, current: [snap(e.x), snap(e.y)] });
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const x = snap(e.x + drag.dx);
      const y = snap(e.y + drag.dy);
      const body = cfg.world.bodies.find((b) => b.id === drag.id);
      if (body) {
        setMechanics({
          world: {
            ...cfg.world,
            bodies: cfg.world.bodies.map((b) => (b.id === drag.id ? { ...b, x, y } : b)),
          },
        });
        patchActive({ timeline: { ...tab.timeline, t: 0 } });
        return;
      }
      const pulley = cfg.world.pulleys.find((p) => p.id === drag.id);
      if (pulley) {
        setMechanics({
          world: {
            ...cfg.world,
            pulleys: cfg.world.pulleys.map((p) => (p.id === drag.id ? { ...p, x, y } : p)),
          },
        });
        patchActive({ timeline: { ...tab.timeline, t: 0 } });
      }
    },
    [pending, snap, cfg.world, setMechanics, patchActive, tab.timeline],
  );

  const onPointerUp = useCallback(
    (e: { x: number; y: number }) => {
      if (dragRef.current) {
        dragRef.current = null;
        // One undo entry for the whole drag, not one per frame.
        commit();
        return;
      }
      if (pending?.kind === 'surface' && pending.start) {
        const x1 = snap(e.x);
        const y1 = snap(e.y);
        if (Math.hypot(x1 - pending.start[0], y1 - pending.start[1]) > 0.05) {
          const surface: Surface = {
            id: uid('surface'),
            x0: pending.start[0],
            y0: pending.start[1],
            x1,
            y1,
            muK: 0.2,
            muS: 0.3,
            restitution: 0,
            flip: false,
            label: `Surface ${cfg.world.surfaces.length + 1}`,
            colour: ANCHOR_COLOUR,
          };
          editWorld({ surfaces: [...cfg.world.surfaces, surface] }, surface.id);
        }
        setPending(null);
      }
    },
    [pending, snap, cfg.world, editWorld, commit],
  );

  useEffect(() => {
    setPending(null);
  }, [cfg.tool]);

  const scene = useMemo(
    () => buildScene(tab, run, sampleIndex, pending),
    [tab, run, sampleIndex, pending],
  );

  const analytic = useMemo(() => analyseMechanics(cfg.world, run.prep), [cfg.world, run.prep]);

  const traces = useMemo((): Trace[] => {
    const { traj } = run;
    if (traj.count < 1) return [];
    // Deliberately not "wait until there are two samples": at t = 0 that leaves
    // the whole instruments column blank on a freshly opened tab, which reads
    // as a broken panel rather than as a chart waiting for the clock.
    const upTo = Math.min(sampleIndex, traj.count - 1);
    // One in every few samples: 240 Hz is far more resolution than a chart a
    // few hundred pixels wide can show, and drawing all of it just makes the
    // line thicker and the frame slower.
    const stride = Math.max(1, Math.floor(upTo / 1200));
    const points = Math.floor(upTo / stride) + 1;
    return cfg.measurements
      .filter((m) => m.visible)
      .map((m) => {
        const xs = new Float64Array(points);
        const ys = new Float64Array(points);
        for (let i = 0; i < points; i++) {
          const k = Math.min(upTo, i * stride);
          xs[i] = traj.time[k];
          ys[i] = readMeasurement(traj, m, k);
        }
        const info = MEASUREMENT_INFO[m.kind];
        const overlay =
          analytic.overlay && analytic.overlay.kind === m.kind && analytic.overlay.target === m.target
            ? analytic.overlay
            : null;
        let predicted: Float64Array | undefined;
        if (overlay) {
          predicted = new Float64Array(points);
          for (let i = 0; i < points; i++) predicted[i] = overlay.fn(xs[i]);
        }
        return {
          id: m.id,
          label: measurementLabel(cfg.world, m),
          unit: info.unit,
          colour: m.colour,
          xs,
          ys,
          predicted,
          predictedLabel: overlay?.label,
        };
      });
  }, [run, sampleIndex, cfg.measurements, cfg.world, analytic]);

  const groups = useMemo(() => groupByUnit(traces), [traces]);
  const energy = run.traj.count
    ? {
        k: run.traj.kinetic[Math.min(sampleIndex, run.traj.count - 1)],
        u: run.traj.potential[Math.min(sampleIndex, run.traj.count - 1)],
        k0: run.traj.kinetic[0],
        u0: run.traj.potential[0],
      }
    : null;

  return (
    <SandboxLayout
      storageKey="mechanics"
      canvas={
        <div className="flex h-full w-full flex-col">
          <Toolbar tool={cfg.tool} onTool={(tool) => setMechanics({ tool })} pending={pending} />
          <div className="relative min-h-0 flex-1">
            <Plot2D
              ref={plotRef}
              scene={scene}
              onViewportChange={setViewport}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              readout={(x, y) => `${x.toFixed(2)} m, ${y.toFixed(2)} m`}
            />
            {run.prep.problems.length > 0 && (
              <div className="pointer-events-none absolute inset-x-3 bottom-3">
                <Callout kind="warn">{run.prep.problems[0]}</Callout>
              </div>
            )}
            {!ready && (
              <div className="pointer-events-none absolute right-3 top-3 rounded bg-surface-0/85 px-2 py-1 text-2xs text-ink-faint">
                simulating…
              </div>
            )}
          </div>
        </div>
      }
      instruments={
        <>
          <div className="border-b border-edge px-3 py-2">
            <h3 className="text-xs font-semibold text-ink">Measurements</h3>
            <p className="mt-0.5 text-2xs text-ink-faint">
              {traces.length
                ? 'Recorded live as the clock runs. Dashed lines are the analytic prediction.'
                : 'Add something to measure from the panel on the left.'}
            </p>
          </div>
          {groups.map((group, i) => (
            <ProbePlot
              key={group.map((t) => t.id).join('|') || i}
              traces={group}
              xLabel="t (s)"
              cursorTime={run.traj.count ? run.traj.time[Math.min(sampleIndex, run.traj.count - 1)] : null}
              height={Math.max(140, Math.round(320 / Math.max(1, groups.length)))}
            />
          ))}
          {groups.length === 0 && (
            <p className="px-3 py-6 text-center text-2xs text-ink-faint">
              {cfg.measurements.length
                ? 'Press play, or drag the timeline, and the traces appear here.'
                : 'Nothing is being recorded yet.'}
            </p>
          )}

          {cfg.showEnergy && energy && (
            <div className="border-t border-edge px-3 py-2.5">
              <StatList>
                <Stat label="Kinetic energy" value={`${fmt(energy.k, 4)} J`} />
                <Stat label="Potential energy" value={`${fmt(energy.u, 4)} J`} />
                <Stat label="Total" value={`${fmt(energy.k + energy.u, 5)} J`} emphasis />
                <Stat
                  label="Change since t = 0"
                  value={`${fmt(energy.k + energy.u - energy.k0 - energy.u0, 3)} J`}
                  hint="Friction and drag remove energy; anything else is solver error, and should stay near zero."
                />
              </StatList>
            </div>
          )}

          {cfg.showEquations && <AnalyticCard result={analytic} />}
        </>
      }
    />
  );
}

function Toolbar({
  tool,
  onTool,
  pending,
}: {
  tool: MechanicsTool;
  onTool: (t: MechanicsTool) => void;
  pending: PendingBuild | null;
}) {
  const hint =
    pending?.kind === 'link' && pending.from
      ? 'Now click the body at the other end.'
      : pending?.kind === 'pulley' && pending.at && !pending.first
        ? 'Now click the first mass.'
        : pending?.kind === 'pulley' && pending.first
          ? 'Now click the second mass.'
          : TOOL_HINTS[tool];

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-edge bg-surface-0 px-2 py-1.5">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          data-tool={t.id}
          onClick={() => onTool(t.id)}
          title={TOOL_HINTS[t.id]}
          className={`rounded px-2 py-1 text-2xs transition-colors ${
            tool === t.id ? 'bg-accent text-white' : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {t.label}
        </button>
      ))}
      <span className="ml-1 truncate text-2xs text-ink-faint">{hint}</span>
    </div>
  );
}

// ------------------------------------------------------------------ panel

export function MechanicsPanel({ tab }: { tab: TabState }) {
  const cfg = tab.mechanics;
  const setMechanics = useStore((s) => s.setMechanics);
  const patchActive = useStore((s) => s.patchActive);
  const commit = useStore((s) => s.commit);
  const world = cfg.world;

  const setWorld = (patch: Partial<MechanicsWorld>) => {
    commit();
    setMechanics({ world: { ...world, ...patch } });
    patchActive({ timeline: { ...tab.timeline, t: 0 } });
  };

  const selected = cfg.selectedId;
  const body = world.bodies.find((b) => b.id === selected);
  const link = world.links.find((l) => l.id === selected);
  const surface = world.surfaces.find((s) => s.id === selected);
  const pulley = world.pulleys.find((p) => p.id === selected);

  const remove = () => {
    if (!selected) return;
    setWorld({
      bodies: world.bodies.filter((b) => b.id !== selected),
      // Anything attached to a body that has gone must go with it, or the
      // scene would fail to prepare and the whole tab would show an error
      // instead of the thing the user was building.
      links: world.links.filter((l) => l.id !== selected && l.a !== selected && l.b !== selected),
      surfaces: world.surfaces.filter((s) => s.id !== selected),
      pulleys: world.pulleys.filter((p) => p.id !== selected && p.a !== selected && p.b !== selected),
    });
    setMechanics({
      selectedId: null,
      measurements: cfg.measurements.filter((m) => m.target !== selected),
    });
  };

  const targets = [
    ...world.bodies.filter((b) => b.kind === 'mass').map((b) => ({ id: b.id, label: b.label, scope: 'body' as const })),
    ...world.links.map((l) => ({ id: l.id, label: l.label, scope: 'link' as const })),
    ...world.pulleys.map((p) => ({ id: p.id, label: p.label, scope: 'link' as const })),
  ];

  return (
    <>
      <Collapsible title="Experiment">
        <Field label="Gravity" hint="9.81 on Earth, 1.62 on the Moon, 0 in deep space.">
          <Row>
            <NumberField value={world.gravity} step={0.1} min={0} onChange={(gravity) => setWorld({ gravity })} />
            <Button
              className="shrink-0"
              title="Set gravity to zero"
              onClick={() => setWorld({ gravity: world.gravity === 0 ? 9.81 : 0 })}
            >
              {world.gravity === 0 ? 'Earth' : 'Zero'}
            </Button>
          </Row>
          <Slider value={world.gravity} min={0} max={25} step={0.01} onChange={(gravity) => setWorld({ gravity })} />
        </Field>

        <div>
          <span className="field-label">Air resistance</span>
          <SegmentedControl
            value={world.dragMode}
            onChange={(dragMode) => setWorld({ dragMode })}
            options={[
              { value: 'none', label: 'None' },
              { value: 'linear', label: 'Linear', title: 'Drag proportional to speed — Stokes’ law' },
              { value: 'quadratic', label: 'Square', title: 'Drag proportional to speed squared — the everyday case' },
            ]}
          />
        </div>
        {world.dragMode !== 'none' && (
          <Field label="Drag coefficient">
            <Slider
              value={world.dragCoefficient}
              min={0}
              max={2}
              step={0.001}
              onChange={(dragCoefficient) => setWorld({ dragCoefficient })}
            />
          </Field>
        )}

        <Field label="Grid snap" hint="Positions round to this spacing while you drag.">
          <Select
            value={String(cfg.snap)}
            onChange={(v) => setMechanics({ snap: Number(v) })}
            options={[
              { value: '0', label: 'Off' },
              { value: '0.1', label: '0.1 m' },
              { value: '0.25', label: '0.25 m' },
              { value: '0.5', label: '0.5 m' },
              { value: '1', label: '1 m' },
            ]}
          />
        </Field>
      </Collapsible>

      <Collapsible title={selected ? 'Selected piece' : 'Nothing selected'} defaultOpen={!!selected}>
        {!selected && (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Click a mass, rod, spring, surface or pulley on the bench to edit what it is made of.
          </p>
        )}

        {body && (
          <>
            <Field label="Name">
              <TextField
                value={body.label}
                onChange={(label) =>
                  setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, label } : b)) })
                }
              />
            </Field>
            {body.kind === 'mass' && (
              <>
                <Field label="Mass (kg)">
                  <NumberField
                    value={body.mass}
                    min={0.001}
                    step={0.1}
                    onChange={(mass) =>
                      setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, mass } : b)) })
                    }
                  />
                </Field>
                <Row>
                  <div className="flex-1">
                    <span className="field-label">Start x</span>
                    <NumberField
                      value={body.x}
                      step={0.1}
                      onChange={(x) => setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, x } : b)) })}
                    />
                  </div>
                  <div className="flex-1">
                    <span className="field-label">Start y</span>
                    <NumberField
                      value={body.y}
                      step={0.1}
                      onChange={(y) => setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, y } : b)) })}
                    />
                  </div>
                </Row>
                <Row>
                  <div className="flex-1">
                    <span className="field-label">Start vₓ</span>
                    <NumberField
                      value={body.vx}
                      step={0.5}
                      onChange={(vx) => setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, vx } : b)) })}
                    />
                  </div>
                  <div className="flex-1">
                    <span className="field-label">Start v_y</span>
                    <NumberField
                      value={body.vy}
                      step={0.5}
                      onChange={(vy) => setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, vy } : b)) })}
                    />
                  </div>
                </Row>
                <Field label="Radius (m)" hint="Drawing size, and how far its centre sits off a surface.">
                  <Slider
                    value={body.radius}
                    min={0.02}
                    max={1}
                    step={0.01}
                    onChange={(radius) =>
                      setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, radius } : b)) })
                    }
                  />
                </Field>
              </>
            )}
            {body.kind === 'anchor' && (
              <Row>
                <div className="flex-1">
                  <span className="field-label">x</span>
                  <NumberField
                    value={body.x}
                    step={0.1}
                    onChange={(x) => setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, x } : b)) })}
                  />
                </div>
                <div className="flex-1">
                  <span className="field-label">y</span>
                  <NumberField
                    value={body.y}
                    step={0.1}
                    onChange={(y) => setWorld({ bodies: world.bodies.map((b) => (b.id === body.id ? { ...b, y } : b)) })}
                  />
                </div>
              </Row>
            )}
          </>
        )}

        {link && (
          <>
            <Field label="Name">
              <TextField
                value={link.label}
                onChange={(label) =>
                  setWorld({ links: world.links.map((l) => (l.id === link.id ? { ...l, label } : l)) })
                }
              />
            </Field>
            <Field
              label={link.kind === 'spring' ? 'Natural length (m)' : 'Length (m)'}
              hint="Leave it on Auto to use however far apart the two ends are."
            >
              <Row>
                <NumberField
                  value={link.length ?? distanceBetween(world, link.a, link.b)}
                  step={0.1}
                  min={0.01}
                  onChange={(length) =>
                    setWorld({ links: world.links.map((l) => (l.id === link.id ? { ...l, length } : l)) })
                  }
                />
                <Button
                  className="shrink-0"
                  variant={link.length === null ? 'accent' : 'default'}
                  title="Measure the length from the current layout instead of fixing it"
                  onClick={() =>
                    setWorld({
                      links: world.links.map((l) =>
                        l.id === link.id ? { ...l, length: l.length === null ? distanceBetween(world, l.a, l.b) : null } : l,
                      ),
                    })
                  }
                >
                  Auto
                </Button>
              </Row>
            </Field>
            {link.kind === 'spring' && (
              <>
                <Field label="Stiffness k (N/m)">
                  <NumberField
                    value={link.stiffness}
                    min={0.1}
                    step={5}
                    onChange={(stiffness) =>
                      setWorld({ links: world.links.map((l) => (l.id === link.id ? { ...l, stiffness } : l)) })
                    }
                  />
                  <Slider
                    value={link.stiffness}
                    min={1}
                    max={400}
                    step={1}
                    onChange={(stiffness) =>
                      setWorld({ links: world.links.map((l) => (l.id === link.id ? { ...l, stiffness } : l)) })
                    }
                  />
                </Field>
                <Field label="Damping c (N·s/m)" hint="A dashpot alongside the spring. Zero oscillates forever.">
                  <Slider
                    value={link.damping}
                    min={0}
                    max={30}
                    step={0.05}
                    onChange={(damping) =>
                      setWorld({ links: world.links.map((l) => (l.id === link.id ? { ...l, damping } : l)) })
                    }
                  />
                </Field>
              </>
            )}
            <Callout>
              {link.kind === 'rod'
                ? 'A rigid rod: it holds its length exactly, and can push as well as pull.'
                : link.kind === 'rope'
                  ? 'A rope goes slack rather than pushing, and never stretches past its length.'
                  : 'A spring obeys F = −kx about its natural length.'}
            </Callout>
          </>
        )}

        {surface && (
          <>
            <Field label="Name">
              <TextField
                value={surface.label}
                onChange={(label) =>
                  setWorld({ surfaces: world.surfaces.map((s) => (s.id === surface.id ? { ...s, label } : s)) })
                }
              />
            </Field>
            <Field label="Kinetic friction μₖ">
              <Slider
                value={surface.muK}
                min={0}
                max={1.5}
                step={0.01}
                onChange={(muK) =>
                  setWorld({
                    surfaces: world.surfaces.map((s) =>
                      s.id === surface.id ? { ...s, muK, muS: Math.max(muK, s.muS) } : s,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Static friction μₛ" hint="Always at least μₖ. A block slips once tan(slope) exceeds it.">
              <Slider
                value={surface.muS}
                min={0}
                max={1.5}
                step={0.01}
                onChange={(muS) =>
                  setWorld({
                    surfaces: world.surfaces.map((s) => (s.id === surface.id ? { ...s, muS: Math.max(muS, s.muK) } : s)),
                  })
                }
              />
            </Field>
            <Field label="Bounciness e" hint="0 sticks, 1 returns to the height it was dropped from.">
              <Slider
                value={surface.restitution}
                min={0}
                max={1}
                step={0.01}
                onChange={(restitution) =>
                  setWorld({
                    surfaces: world.surfaces.map((s) => (s.id === surface.id ? { ...s, restitution } : s)),
                  })
                }
              />
            </Field>
            <Row>
              <div className="flex-1">
                <span className="field-label">From x</span>
                <NumberField
                  value={surface.x0}
                  step={0.25}
                  onChange={(x0) =>
                    setWorld({ surfaces: world.surfaces.map((s) => (s.id === surface.id ? { ...s, x0 } : s)) })
                  }
                />
              </div>
              <div className="flex-1">
                <span className="field-label">From y</span>
                <NumberField
                  value={surface.y0}
                  step={0.25}
                  onChange={(y0) =>
                    setWorld({ surfaces: world.surfaces.map((s) => (s.id === surface.id ? { ...s, y0 } : s)) })
                  }
                />
              </div>
            </Row>
            <Row>
              <div className="flex-1">
                <span className="field-label">To x</span>
                <NumberField
                  value={surface.x1}
                  step={0.25}
                  onChange={(x1) =>
                    setWorld({ surfaces: world.surfaces.map((s) => (s.id === surface.id ? { ...s, x1 } : s)) })
                  }
                />
              </div>
              <div className="flex-1">
                <span className="field-label">To y</span>
                <NumberField
                  value={surface.y1}
                  step={0.25}
                  onChange={(y1) =>
                    setWorld({ surfaces: world.surfaces.map((s) => (s.id === surface.id ? { ...s, y1 } : s)) })
                  }
                />
              </div>
            </Row>
            <Toggle
              label="Solid on the other side"
              hint="Which face things rest on. Flip it to hang something underneath."
              checked={surface.flip}
              onChange={(flip) =>
                setWorld({ surfaces: world.surfaces.map((s) => (s.id === surface.id ? { ...s, flip } : s)) })
              }
            />
          </>
        )}

        {pulley && (
          <>
            <Field label="Name">
              <TextField
                value={pulley.label}
                onChange={(label) =>
                  setWorld({ pulleys: world.pulleys.map((p) => (p.id === pulley.id ? { ...p, label } : p)) })
                }
              />
            </Field>
            <Field label="Rope length (m)" hint="Auto measures it from where the two masses start.">
              <Row>
                <NumberField
                  value={pulley.length ?? ropeLength(world, pulley)}
                  step={0.1}
                  min={0.1}
                  onChange={(length) =>
                    setWorld({ pulleys: world.pulleys.map((p) => (p.id === pulley.id ? { ...p, length } : p)) })
                  }
                />
                <Button
                  className="shrink-0"
                  variant={pulley.length === null ? 'accent' : 'default'}
                  title="Measure the rope from the current layout instead of fixing it"
                  onClick={() =>
                    setWorld({
                      pulleys: world.pulleys.map((p) =>
                        p.id === pulley.id ? { ...p, length: p.length === null ? ropeLength(world, p) : null } : p,
                      ),
                    })
                  }
                >
                  Auto
                </Button>
              </Row>
            </Field>
            <Callout>
              Modelled as a rope over a frictionless peg with no mass of its own. Hang both masses directly below it and
              you have a textbook Atwood machine; put them to either side and they will swing, which is what a real rope
              over a real nail does.
            </Callout>
          </>
        )}

        {selected && (
          <Button className="w-full" onClick={remove}>
            <span className="flex items-center justify-center gap-1.5">
              <IconTrash size={12} /> Remove this piece
            </span>
          </Button>
        )}
      </Collapsible>

      <Collapsible
        title={`Measure${cfg.measurements.length ? ` · ${cfg.measurements.length}` : ''}`}
        actions={
          <IconButton
            title="Record something else"
            onClick={() => {
              const first = targets[0];
              commit();
              setMechanics({
                measurements: [
                  ...cfg.measurements,
                  {
                    id: uid('meas'),
                    kind: (first?.scope === 'link' ? 'force' : 'y') as MeasurementKind,
                    target: first?.id ?? '',
                    colour: SERIES_COLOURS[cfg.measurements.length % SERIES_COLOURS.length],
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
        {cfg.measurements.length === 0 && (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Nothing is being recorded. Add an angle, a tension or an energy and it appears on the chart as the clock
            runs.
          </p>
        )}
        <div className="space-y-2">
          {cfg.measurements.map((m) => {
            const scope = MEASUREMENT_INFO[m.kind]?.scope ?? 'body';
            const options = Object.entries(MEASUREMENT_INFO).map(([kind, info]) => ({
              value: kind,
              label: `${info.label}${info.unit ? ` (${info.unit})` : ''}`,
            }));
            const valid = targets.filter((t) => (scope === 'link' ? t.scope === 'link' : t.scope === 'body'));
            return (
              <div key={m.id} className="rounded-md border border-edge bg-surface-1 p-2">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: m.colour }} />
                  <span className="flex-1 truncate text-2xs text-ink-dim">{measurementLabel(world, m)}</span>
                  <IconButton
                    title={m.visible ? 'Hide from the chart' : 'Show on the chart'}
                    onClick={() =>
                      setMechanics({
                        measurements: cfg.measurements.map((x) => (x.id === m.id ? { ...x, visible: !x.visible } : x)),
                      })
                    }
                  >
                    {m.visible ? <IconEye size={13} /> : <IconEyeOff size={13} />}
                  </IconButton>
                  <IconButton
                    title="Stop recording this"
                    onClick={() => {
                      commit();
                      setMechanics({ measurements: cfg.measurements.filter((x) => x.id !== m.id) });
                    }}
                  >
                    <IconClose size={13} />
                  </IconButton>
                </div>
                <Select
                  value={m.kind}
                  onChange={(kind) => {
                    const nextScope = MEASUREMENT_INFO[kind as MeasurementKind].scope;
                    const stillValid =
                      nextScope === 'world' ||
                      targets.some(
                        (t) => t.id === m.target && (nextScope === 'link' ? t.scope === 'link' : t.scope === 'body'),
                      );
                    const fallback = targets.find((t) => (nextScope === 'link' ? t.scope === 'link' : t.scope === 'body'));
                    setMechanics({
                      measurements: cfg.measurements.map((x) =>
                        x.id === m.id
                          ? { ...x, kind: kind as MeasurementKind, target: stillValid ? x.target : (fallback?.id ?? '') }
                          : x,
                      ),
                    });
                  }}
                  options={options}
                />
                {scope !== 'world' && (
                  <Select
                    value={m.target}
                    onChange={(target) =>
                      setMechanics({
                        measurements: cfg.measurements.map((x) => (x.id === m.id ? { ...x, target } : x)),
                      })
                    }
                    options={valid.map((t) => ({ value: t.id, label: t.label }))}
                  />
                )}
              </div>
            );
          })}
        </div>
      </Collapsible>

      <Collapsible title="Display" defaultOpen={false}>
        <Toggle label="Force arrows" checked={cfg.showForces} onChange={(showForces) => setMechanics({ showForces })} />
        <Toggle
          label="Velocity arrows"
          checked={cfg.showVelocities}
          onChange={(showVelocities) => setMechanics({ showVelocities })}
        />
        <Toggle label="Trails" checked={cfg.showTrails} onChange={(showTrails) => setMechanics({ showTrails })} />
        <Toggle label="Energy readout" checked={cfg.showEnergy} onChange={(showEnergy) => setMechanics({ showEnergy })} />
        <Toggle
          label="Governing equations"
          checked={cfg.showEquations}
          onChange={(showEquations) => setMechanics({ showEquations })}
        />
        <Toggle
          label="Labels on the bench"
          checked={cfg.showValues}
          onChange={(showValues) => setMechanics({ showValues })}
        />
      </Collapsible>

      <ViewPanel tab={tab} />

      <Collapsible title="Start over" defaultOpen={false}>
        <Button
          className="w-full"
          onClick={() => {
            commit();
            setMechanics({
              world: { ...world, bodies: [], links: [], surfaces: [], pulleys: [] },
              measurements: [],
              selectedId: null,
            });
            patchActive({ timeline: { ...tab.timeline, t: 0, playing: false } });
          }}
        >
          Clear the bench
        </Button>
      </Collapsible>
    </>
  );
}

function distanceBetween(world: MechanicsWorld, a: string, b: string): number {
  const ba = world.bodies.find((x) => x.id === a);
  const bb = world.bodies.find((x) => x.id === b);
  return ba && bb ? Math.hypot(ba.x - bb.x, ba.y - bb.y) : 1;
}

function ropeLength(world: MechanicsWorld, p: Pulley): number {
  const a = world.bodies.find((x) => x.id === p.a);
  const b = world.bodies.find((x) => x.id === p.b);
  if (!a || !b) return 1;
  return Math.hypot(a.x - p.x, a.y - p.y) + Math.hypot(b.x - p.x, b.y - p.y);
}

// ------------------------------------------------------------------ export

export function mechanicsCsv(tab: TabState): string | null {
  const cfg = tab.mechanics;
  const visible = cfg.measurements.filter((m) => m.visible);
  if (!visible.length) return null;
  const prep = prepare(cfg.world);
  if (prep.problems.length) return null;
  const traj = createTrajectory(prep, suggestedStep(prep));
  advance(traj, tab.timeline.tMax, 400000);

  const headers = ['t', ...visible.map((m) => `${measurementLabel(cfg.world, m)} (${MEASUREMENT_INFO[m.kind].unit})`)];
  const rows: (number | string)[][] = [];
  // A CSV of a quarter of a million rows helps nobody; a thousand is plenty
  // to re-plot elsewhere and opens in a spreadsheet without complaint.
  const stride = Math.max(1, Math.floor(traj.count / 1000));
  for (let k = 0; k < traj.count; k += stride) {
    rows.push([traj.time[k], ...visible.map((m) => readMeasurement(traj, m, k))]);
  }
  return toCsv(headers, rows);
}
