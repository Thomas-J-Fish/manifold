import { useCallback, useMemo, useRef } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import type { GeoTool, TabState } from '../core/types';
import { SERIES_COLOURS } from '../core/types';
import {
  angleAt,
  circlePoints,
  clipToBox,
  conicGeometry,
  conicPoints,
  distance,
  evaluate,
  locus,
  nearest,
  pointAlong,
  polygonArea,
  polygonPerimeter,
  type GeoObject,
  type Pt,
  type Value,
} from '../core/math/geometry';
import { Plot2D, type PlotPointerEvent } from '../components/plot/Plot2D';
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

/* Geometry and constructions.
 *
 * The other modes compute something and draw the answer. This one is different
 * in character, which is the reason it exists: the figure *is* the object of
 * study, and the only thing the mode does is hold it together while you move
 * it. Drag a vertex and every circle, bisector and intersection built on it
 * follows, because none of them were ever stored — they are rules, evaluated
 * afresh from wherever the free points now are.
 *
 * Three groups of tools over one figure:
 *
 *   Construct — compass and straightedge. Every classical construction is here,
 *     and none of them is a special case in the code: an equilateral triangle
 *     is two circles and an intersection, exactly as in Elements I.1.
 *   Conics — a focus, a directrix and an eccentricity. The curve is sampled
 *     straight from |PF| = e·d, so the ellipse's string property and the
 *     hyperbola's difference property are *results*, printed beside it.
 *   Transform — reflect, rotate, translate, dilate. Applied to whole objects,
 *     so reflecting a circle gives a circle rather than a cloud of points.
 */

const VIEWS = [
  { value: 'construct' as const, label: 'Construct', title: 'Compass, straightedge and the classical constructions.' },
  { value: 'conics' as const, label: 'Conics', title: 'Curves from a focus, a directrix and an eccentricity.' },
  { value: 'transform' as const, label: 'Transform', title: 'Reflect, rotate, translate and scale.' },
];

/** What each slot of a tool will accept. */
type Slot = 'point' | 'line' | 'circle' | 'path' | 'any';

interface ToolSpec {
  id: GeoTool;
  label: string;
  hint: string;
  /** One entry per parent the tool needs, in order. */
  slots: Slot[];
  /** What it builds. Absent for the pointer. */
  makes?: GeoObject['kind'];
  group: 'construct' | 'conics' | 'transform';
}

const TOOLS: ToolSpec[] = [
  { id: 'select', label: 'Select', hint: 'Click to pick, drag a free point to move it.', slots: [], group: 'construct' },
  { id: 'point', label: 'Point', hint: 'Click anywhere to drop a free point.', slots: [], makes: 'point', group: 'construct' },
  {
    id: 'pointOn',
    label: 'Point on',
    hint: 'A point tied to a line, circle or conic. It can only slide along it.',
    slots: ['path'],
    makes: 'pointOn',
    group: 'construct',
  },
  {
    id: 'intersection',
    label: 'Intersection',
    hint: 'Where two objects cross. Stays on the same branch as the figure moves.',
    slots: ['path', 'path'],
    makes: 'intersection',
    group: 'construct',
  },
  { id: 'segment', label: 'Segment', hint: 'Two points, joined.', slots: ['point', 'point'], makes: 'segment', group: 'construct' },
  { id: 'line', label: 'Line', hint: 'The whole infinite line through two points.', slots: ['point', 'point'], makes: 'line', group: 'construct' },
  { id: 'ray', label: 'Ray', hint: 'From the first point, through the second, onwards.', slots: ['point', 'point'], makes: 'ray', group: 'construct' },
  {
    id: 'circle',
    label: 'Circle',
    hint: 'Centre first, then a point on the rim. This is the compass.',
    slots: ['point', 'point'],
    makes: 'circle',
    group: 'construct',
  },
  { id: 'midpoint', label: 'Midpoint', hint: 'Halfway between two points.', slots: ['point', 'point'], makes: 'midpoint', group: 'construct' },
  {
    id: 'bisector',
    label: 'Perp. bisector',
    hint: 'Every point on it is equidistant from the two — the most useful line in the subject.',
    slots: ['point', 'point'],
    makes: 'bisector',
    group: 'construct',
  },
  {
    id: 'perpendicular',
    label: 'Perpendicular',
    hint: 'Through a point, at right angles to a line.',
    slots: ['point', 'line'],
    makes: 'perpendicular',
    group: 'construct',
  },
  { id: 'parallel', label: 'Parallel', hint: 'Through a point, parallel to a line.', slots: ['point', 'line'], makes: 'parallel', group: 'construct' },
  {
    id: 'angleBisector',
    label: 'Angle bisector',
    hint: 'Three points: one arm, the vertex, the other arm.',
    slots: ['point', 'point', 'point'],
    makes: 'angleBisector',
    group: 'construct',
  },
  {
    id: 'polygon',
    label: 'Triangle',
    hint: 'Three points, filled — so the area and perimeter can be read off.',
    slots: ['point', 'point', 'point'],
    makes: 'polygon',
    group: 'construct',
  },
  {
    id: 'conic',
    label: 'Conic',
    hint: 'A focus and a directrix. The eccentricity below decides which curve you get.',
    slots: ['point', 'line'],
    makes: 'conic',
    group: 'conics',
  },
  { id: 'reflect', label: 'Reflect', hint: 'Anything, in a mirror line.', slots: ['any', 'line'], makes: 'reflect', group: 'transform' },
  { id: 'rotate', label: 'Rotate', hint: 'Anything, about a centre, by the angle below.', slots: ['any', 'point'], makes: 'rotate', group: 'transform' },
  {
    id: 'translate',
    label: 'Translate',
    hint: 'Anything, by the vector from the second point to the third.',
    slots: ['any', 'point', 'point'],
    makes: 'translate',
    group: 'transform',
  },
  { id: 'dilate', label: 'Scale', hint: 'Anything, about a centre, by the factor below.', slots: ['any', 'point'], makes: 'dilate', group: 'transform' },
];

const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

const SELECTED = '#fbbf24';
const LOCUS = '#f472b6';
const HINT = '#94a3b8';

/** Whether a value can fill a slot. */
function fits(slot: Slot, v: Value | undefined): boolean {
  if (!v || v.kind === 'invalid') return false;
  if (slot === 'any') return true;
  if (slot === 'point') return v.kind === 'point';
  if (slot === 'line') return v.kind === 'line';
  if (slot === 'circle') return v.kind === 'circle';
  return v.kind === 'line' || v.kind === 'circle' || v.kind === 'conic';
}

// ------------------------------------------------------------------- scene

function buildScene(tab: TabState): PlotScene {
  const cfg = tab.geometry;
  const { values } = evaluate({ objects: cfg.objects });
  const layers: Layer[] = [];
  const view = tab.viewport;
  const selected = new Set(cfg.selection);

  // The locus first, so it sits behind the figure that generated it.
  if (cfg.showLocus && cfg.locusDriver && cfg.locusTracer) {
    for (const branch of locus({ objects: cfg.objects }, cfg.locusDriver, cfg.locusTracer, 300)) {
      layers.push({
        type: 'polyline',
        xs: Float64Array.from(branch.map((p) => p.x)),
        ys: Float64Array.from(branch.map((p) => p.y)),
        colour: LOCUS,
        width: 2,
      });
    }
  }

  /* Curves before points, so a point is never hidden under the circle that
   * defines it — and within the curves, filled polygons first so their tint
   * does not wash out the lines drawn over them. */
  const order: Value['kind'][] = ['polygon', 'conic', 'circle', 'line', 'point'];
  for (const wanted of order) {
    for (const object of cfg.objects) {
      if (!object.visible) continue;
      const value = values.get(object.id);
      if (!value || value.kind !== wanted) continue;
      const isSelected = selected.has(object.id);
      const colour = isSelected ? SELECTED : object.colour;
      const width = isSelected ? 2.6 : 1.7;

      switch (value.kind) {
        case 'polygon': {
          layers.push({
            type: 'polyline',
            closed: true,
            xs: Float64Array.from(value.points.map((p) => p.x)),
            ys: Float64Array.from(value.points.map((p) => p.y)),
            colour,
            fill: withAlpha(object.colour, 0.14),
            width,
          });
          break;
        }
        case 'circle': {
          const pts = circlePoints(value.c, value.r, 220);
          layers.push({
            type: 'polyline',
            xs: Float64Array.from(pts.map((p) => p.x)),
            ys: Float64Array.from(pts.map((p) => p.y)),
            colour,
            width,
          });
          break;
        }
        case 'line': {
          // Clipped to the window, so an infinite line looks infinite rather
          // than stopping at the two points that happened to define it.
          const ends = clipToBox(value, view);
          if (!ends) break;
          layers.push({
            type: 'polyline',
            xs: Float64Array.from([ends[0].x, ends[1].x]),
            ys: Float64Array.from([ends[0].y, ends[1].y]),
            colour,
            width,
          });
          break;
        }
        case 'conic': {
          const reach = Math.max(view.xMax - view.xMin, view.yMax - view.yMin) * 3;
          for (const branch of conicPoints(value.focus, value.foot, value.e, reach, 720)) {
            layers.push({
              type: 'polyline',
              xs: Float64Array.from(branch.map((p) => p.x)),
              ys: Float64Array.from(branch.map((p) => p.y)),
              colour,
              width,
            });
          }
          if (cfg.showConicDetail) layers.push(...conicDetail(value, view));
          break;
        }
        case 'point': {
          layers.push({
            type: 'points',
            xs: [value.p.x],
            ys: [value.p.y],
            colour,
            radius: isSelected ? 6 : 4.5,
            // Free points get a ring, so what can be dragged is visible before
            // you try to drag it.
            stroke: object.kind === 'point' ? '#0f172a' : undefined,
          });
          if (cfg.showLabels && object.label) {
            layers.push({
              type: 'marker',
              x: value.p.x,
              y: value.p.y,
              label: object.label,
              colour,
              radius: 0,
              offset: [8, -8],
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return {
    viewport: view,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'x',
    yLabel: 'y',
    caption: toolCaption(cfg.tool, cfg.selection.length, values, cfg.objects),
  };
}

/** The focus, directrix foot, second focus, axes and asymptotes of a conic. */
function conicDetail(
  v: Extract<Value, { kind: 'conic' }>,
  view: { xMin: number; xMax: number; yMin: number; yMax: number },
): Layer[] {
  const layers: Layer[] = [];
  const g = conicGeometry(v.focus, v.foot, v.e);

  layers.push({ type: 'points', xs: [v.focus.x], ys: [v.focus.y], colour: SERIES_COLOURS[1], radius: 4 });
  if (g.otherFocus) {
    layers.push({
      type: 'points',
      xs: [g.otherFocus.x],
      ys: [g.otherFocus.y],
      colour: SERIES_COLOURS[1],
      radius: 4,
    });
  }

  // The directrix, drawn as the line perpendicular to the axis at the foot.
  const tangent = { x: -v.normal.y, y: v.normal.x };
  const directrix = clipToBox(
    { a: v.foot, b: { x: v.foot.x + tangent.x, y: v.foot.y + tangent.y }, span: 'line' },
    view,
  );
  if (directrix) {
    layers.push({
      type: 'polyline',
      xs: Float64Array.from([directrix[0].x, directrix[1].x]),
      ys: Float64Array.from([directrix[0].y, directrix[1].y]),
      colour: withAlpha(HINT, 0.7),
      width: 1.2,
      style: 'dashed',
    });
  }

  /* A hyperbola's asymptotes, which are the directions its two branches
   * approach and the thing its shape is hardest to see without. */
  if (g.kind === 'hyperbola' && g.centre) {
    const slope = g.b / g.a;
    for (const sign of [1, -1]) {
      const dir = {
        x: v.normal.x + sign * slope * tangent.x,
        y: v.normal.y + sign * slope * tangent.y,
      };
      const asymptote = clipToBox(
        { a: g.centre, b: { x: g.centre.x + dir.x, y: g.centre.y + dir.y }, span: 'line' },
        view,
      );
      if (!asymptote) continue;
      layers.push({
        type: 'polyline',
        xs: Float64Array.from([asymptote[0].x, asymptote[1].x]),
        ys: Float64Array.from([asymptote[0].y, asymptote[1].y]),
        colour: withAlpha(HINT, 0.45),
        width: 1,
        style: 'dotted',
      });
    }
  }
  return layers;
}

/** What the armed tool is waiting for, in words. */
function toolCaption(
  tool: GeoTool,
  picked: number,
  values: Map<string, Value>,
  objects: GeoObject[],
): string {
  const spec = TOOL_BY_ID.get(tool);
  if (!spec || !spec.slots.length) {
    if (tool === 'point') return 'Click anywhere to place a point.';
    return '';
  }
  if (picked >= spec.slots.length) return '';
  const names: Record<Slot, string> = {
    point: 'a point',
    line: 'a line',
    circle: 'a circle',
    path: 'a line, circle or conic',
    any: 'any object',
  };
  void values;
  void objects;
  return `${spec.label}: click ${names[spec.slots[picked]]} (${picked + 1} of ${spec.slots.length}).`;
}

// -------------------------------------------------------------------- panel

export function GeometryPanel({ tab }: { tab: TabState }) {
  const cfg = tab.geometry;
  const setGeometry = useStore((s) => s.setGeometry);
  const commit = useStore((s) => s.commit);

  const values = useMemo(() => evaluate({ objects: cfg.objects }).values, [cfg.objects]);
  const tools = TOOLS.filter((t) => t.group === cfg.view || t.id === 'select' || t.id === 'point');

  const pointOptions = cfg.objects
    .filter((o) => values.get(o.id)?.kind === 'point')
    .map((o) => ({ value: o.id, label: o.label || o.kind }));
  const driverOptions = cfg.objects
    .filter((o) => o.kind === 'pointOn')
    .map((o) => ({ value: o.id, label: o.label || 'point on a path' }));

  return (
    <>
      <Panel title="Tools">
        <SegmentedControl
          size="sm"
          value={cfg.view}
          onChange={(view) => setGeometry({ view, tool: 'select', selection: [] })}
          options={VIEWS}
        />
        <div className="grid grid-cols-2 gap-1.5 pt-1">
          {tools.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.hint}
              data-tool={t.id}
              onClick={() => setGeometry({ tool: t.id, selection: [] })}
              className={`rounded-md border px-2 py-1.5 text-left text-2xs transition ${
                cfg.tool === t.id
                  ? 'border-accent-deep bg-accent/20 text-ink'
                  : 'border-edge bg-surface-1 text-ink-dim hover:border-accent'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="text-2xs leading-snug text-ink-faint">{TOOL_BY_ID.get(cfg.tool)?.hint}</div>
      </Panel>

      {cfg.view === 'conics' && (
        <Panel title="Conic">
          <Field
            label={`Eccentricity ${fmt(cfg.eccentricity, 3)} — ${
              cfg.eccentricity < 0.999 ? 'ellipse' : cfg.eccentricity > 1.001 ? 'hyperbola' : 'parabola'
            }`}
            hint="Below one closes the curve, exactly one opens it into a parabola, above one splits it into two branches."
          >
            <Slider
              value={cfg.eccentricity}
              min={0.05}
              max={3}
              step={0.005}
              onChange={(eccentricity) => {
                // Retune every conic already in the figure, so the slider is a
                // control on what is on screen rather than only on the next one.
                setGeometry({
                  eccentricity,
                  objects: cfg.objects.map((o) => (o.kind === 'conic' ? { ...o, value: eccentricity } : o)),
                });
              }}
            />
          </Field>
          <Row>
            {[
              ['Circle', 0.05],
              ['Ellipse', 0.6],
              ['Parabola', 1],
              ['Hyperbola', 1.8],
            ].map(([label, e]) => (
              <Button
                key={label as string}
                onClick={() => {
                  commit();
                  setGeometry({
                    eccentricity: e as number,
                    objects: cfg.objects.map((o) => (o.kind === 'conic' ? { ...o, value: e as number } : o)),
                  });
                }}
              >
                {label as string}
              </Button>
            ))}
          </Row>
          <Toggle
            label="Show foci, directrix and asymptotes"
            checked={cfg.showConicDetail}
            onChange={(showConicDetail) => setGeometry({ showConicDetail })}
          />
        </Panel>
      )}

      {cfg.view === 'transform' && (
        <Panel title="Amounts">
          <Field label={`Rotate by ${fmt(cfg.rotateAngle, 4)}°`}>
            <Slider
              value={cfg.rotateAngle}
              min={-180}
              max={180}
              step={1}
              onChange={(rotateAngle) => {
                setGeometry({
                  rotateAngle,
                  objects: cfg.objects.map((o) => (o.kind === 'rotate' ? { ...o, value: rotateAngle } : o)),
                });
              }}
            />
          </Field>
          <Field label={`Scale by ${fmt(cfg.dilateFactor, 3)}`} hint="Negative sends the image through the centre.">
            <Slider
              value={cfg.dilateFactor}
              min={-3}
              max={3}
              step={0.05}
              onChange={(dilateFactor) => {
                setGeometry({
                  dilateFactor,
                  objects: cfg.objects.map((o) => (o.kind === 'dilate' ? { ...o, value: dilateFactor } : o)),
                });
              }}
            />
          </Field>
        </Panel>
      )}

      <Panel title="Locus">
        <Toggle
          label="Trace a path"
          hint="Drive one point along its path and draw where another one goes. It works for constructions nobody planned for, because the whole figure is re-evaluated at every step."
          checked={cfg.showLocus}
          onChange={(showLocus) => setGeometry({ showLocus })}
        />
        {cfg.showLocus && (
          <>
            {driverOptions.length === 0 ? (
              <Callout kind="info">
                Nothing to drive yet. Make a point with the <strong>Point on</strong> tool and it can run along its path.
              </Callout>
            ) : (
              <Field label="Driven along its path">
                <Select
                  value={cfg.locusDriver ?? driverOptions[0].value}
                  onChange={(locusDriver) => setGeometry({ locusDriver })}
                  options={driverOptions}
                />
              </Field>
            )}
            {pointOptions.length > 0 && (
              <Field label="Point to trace">
                <Select
                  value={cfg.locusTracer ?? pointOptions[0].value}
                  onChange={(locusTracer) => setGeometry({ locusTracer })}
                  options={pointOptions}
                />
              </Field>
            )}
          </>
        )}
      </Panel>

      <Panel title="Figure">
        <Toggle label="Labels" checked={cfg.showLabels} onChange={(showLabels) => setGeometry({ showLabels })} />
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {cfg.objects.map((o) => {
            const value = values.get(o.id);
            const broken = !value || value.kind === 'invalid';
            return (
              <div
                key={o.id}
                className={`flex items-center gap-2 rounded-md border px-2 py-1 text-2xs ${
                  cfg.selection.includes(o.id) ? 'border-accent-deep bg-accent/15' : 'border-edge bg-surface-1'
                }`}
              >
                <button
                  type="button"
                  className="flex-1 text-left"
                  onClick={() => setGeometry({ selection: [o.id], tool: 'select' })}
                >
                  <span style={{ color: broken ? '#f87171' : o.colour }}>●</span>{' '}
                  {o.label || o.kind}
                  {broken && <span className="text-warn"> — {value?.kind === 'invalid' ? value.why : 'missing'}</span>}
                </button>
                <IconButton
                  title="Delete this and everything built on it"
                  onClick={() => {
                    commit();
                    setGeometry({ objects: withoutDependents(cfg.objects, o.id), selection: [] });
                  }}
                >
                  <IconTrash />
                </IconButton>
              </div>
            );
          })}
        </div>
        <Button
          onClick={() => {
            commit();
            setGeometry({ objects: [], selection: [] });
          }}
        >
          Clear the figure
        </Button>
      </Panel>

      <Collapsible title="Constructions to try" defaultOpen={false}>
        <div className="space-y-1.5">
          {RECIPES.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => {
                commit();
                setGeometry({ ...r.build(), selection: [], tool: 'select' });
              }}
              className="w-full rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-left transition hover:border-accent"
            >
              <div className="text-xs font-medium text-ink">{r.label}</div>
              <div className="text-2xs text-ink-faint">{r.hint}</div>
            </button>
          ))}
        </div>
      </Collapsible>
    </>
  );
}

/**
 * Removes an object and everything that depends on it.
 *
 * Deleting only the object itself would leave its children pointing at an id
 * that no longer exists — they would evaluate as invalid and the figure would
 * fill with broken entries the user did not create. Taking the dependents with
 * it is what "delete" means in a construction.
 */
export function withoutDependents(objects: GeoObject[], id: string): GeoObject[] {
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of objects) {
      if (doomed.has(o.id)) continue;
      if (o.parents.some((parent) => doomed.has(parent))) {
        doomed.add(o.id);
        grew = true;
      }
    }
  }
  return objects.filter((o) => !doomed.has(o.id));
}

// ------------------------------------------------------------------ surface

export function GeometrySurface({ tab }: { tab: TabState }) {
  const cfg = tab.geometry;
  const setViewport = useStore((s) => s.setViewport);
  const setGeometry = useStore((s) => s.setGeometry);
  const commit = useStore((s) => s.commit);
  const plotRef = usePlot2DRef();
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const values = useMemo(() => evaluate({ objects: cfg.objects }).values, [cfg.objects]);
  const scene = useMemo(() => buildScene(tab), [tab]);

  /* A construction is a picture of a space: a circle has to be round and a
   * right angle has to look like one, or the figure is lying about itself. */
  useSquareScales(plotRef, tab.viewport, true, 'contain');

  const pickRadius = ((tab.viewport.xMax - tab.viewport.xMin) / 1000) * 14;

  const onPointerDown = useCallback(
    (e: PlotPointerEvent): boolean | void => {
      const spec = TOOL_BY_ID.get(cfg.tool);
      const hit = nearest(values, cfg.objects, { x: e.x, y: e.y }, pickRadius);

      // The pointer: pick something, and start dragging it if it is free.
      if (!spec || spec.id === 'select') {
        setGeometry({ selection: hit ? [hit] : [] });
        const object = hit ? cfg.objects.find((o) => o.id === hit) : null;
        if (object && object.kind === 'point') {
          commit();
          dragRef.current = { id: object.id, dx: (object.x ?? 0) - e.x, dy: (object.y ?? 0) - e.y };
          return true;
        }
        // A point tied to a path is dragged too, but along the path only.
        if (object && object.kind === 'pointOn') {
          commit();
          dragRef.current = { id: object.id, dx: 0, dy: 0 };
          return true;
        }
        return;
      }

      if (spec.id === 'point') {
        commit();
        setGeometry({ objects: [...cfg.objects, freePoint(cfg.objects, e.x, e.y)] });
        return true;
      }

      /* Every other tool collects parents. Clicking empty space where a point
       * is wanted creates one there, which is what makes the tools feel like
       * drawing rather than like filling in a form. */
      const slot = spec.slots[cfg.selection.length];
      let pickedId = hit && fits(slot, values.get(hit)) ? hit : null;
      let objects = cfg.objects;
      if (!pickedId && (slot === 'point' || slot === 'any')) {
        const created = freePoint(objects, e.x, e.y);
        objects = [...objects, created];
        pickedId = created.id;
      }
      if (!pickedId) return true;

      const selection = [...cfg.selection, pickedId];
      if (selection.length < spec.slots.length) {
        commit();
        setGeometry({ objects, selection });
        return true;
      }

      commit();
      setGeometry({
        objects: [...objects, makeObject(spec, selection, objects, cfg)],
        selection: [],
      });
      return true;
    },
    [cfg, values, pickRadius, setGeometry, commit],
  );

  const onPointerMove = useCallback(
    (e: PlotPointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const object = cfg.objects.find((o) => o.id === drag.id);
      if (!object) return;

      if (object.kind === 'point') {
        setGeometry({
          objects: cfg.objects.map((o) =>
            o.id === drag.id ? { ...o, x: e.x + drag.dx, y: e.y + drag.dy } : o,
          ),
        });
        return;
      }

      /* A point on a path slides rather than moves: find the parameter whose
       * position is nearest the cursor and set that. Sampling beats solving
       * because it works for every path kind — including a conic, where the
       * nearest-point problem is a quartic. */
      const path = values.get(object.parents[0]);
      if (!path) return;
      let best = object.value ?? 0;
      let bestDistance = Infinity;
      for (let i = 0; i <= 720; i++) {
        const t = i / 720;
        const candidate = pointAlongSafe(path, t);
        const d = distance(candidate, { x: e.x, y: e.y });
        if (d < bestDistance) {
          bestDistance = d;
          best = t;
        }
      }
      setGeometry({ objects: cfg.objects.map((o) => (o.id === drag.id ? { ...o, value: best } : o)) });
    },
    [cfg.objects, values, setGeometry],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <SandboxLayout
      storageKey="geometry"
      canvas={
        <div className="h-full w-full">
          <Plot2D
            ref={plotRef}
            scene={scene}
            onViewportChange={setViewport}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            readout={(x, y) => `${x.toFixed(2)}, ${y.toFixed(2)}`}
          />
        </div>
      }
      instruments={
        <>
          <GeometryReadout tab={tab} />
          <AnalyticCard result={analyseGeometry(tab)} />
        </>
      }
    />
  );
}

/** Where a handle dragged along a path should sit. */
function pointAlongSafe(path: Value, t: number): Pt {
  // Re-uses the core's own parameterisation, so a dragged handle lands exactly
  // where the evaluated point will be rather than near it.
  return path.kind === 'invalid' ? { x: 0, y: 0 } : pointAlong(path, t);
}

function freePoint(objects: GeoObject[], x: number, y: number): GeoObject {
  // Labelled A, B, C… in the order they were made, which is how anyone talking
  // about a figure refers to its points.
  const used = objects.filter((o) => o.kind === 'point').length;
  const letter = String.fromCharCode(65 + (used % 26));
  return {
    id: uid('g'),
    kind: 'point',
    parents: [],
    x,
    y,
    label: letter,
    colour: SERIES_COLOURS[0],
    visible: true,
  };
}

function makeObject(
  spec: ToolSpec,
  parents: string[],
  objects: GeoObject[],
  cfg: TabState['geometry'],
): GeoObject {
  const derived = objects.filter((o) => o.kind !== 'point').length;
  const base: GeoObject = {
    id: uid('g'),
    kind: spec.makes ?? 'point',
    parents,
    label: '',
    colour: SERIES_COLOURS[(derived + 2) % SERIES_COLOURS.length],
    visible: true,
  };
  switch (spec.makes) {
    case 'conic':
      return { ...base, value: cfg.eccentricity };
    case 'rotate':
      return { ...base, value: cfg.rotateAngle };
    case 'dilate':
      return { ...base, value: cfg.dilateFactor };
    case 'pointOn':
      return { ...base, value: 0.25, label: nextPointLabel(objects) };
    case 'intersection':
      return { ...base, branch: 0, label: nextPointLabel(objects) };
    case 'midpoint':
      return { ...base, label: nextPointLabel(objects) };
    default:
      return base;
  }
}

const nextPointLabel = (objects: GeoObject[]): string => {
  const used = objects.filter((o) => ['point', 'pointOn', 'intersection', 'midpoint'].includes(o.kind)).length;
  return String.fromCharCode(65 + (used % 26));
};

function GeometryReadout({ tab }: { tab: TabState }) {
  const cfg = tab.geometry;
  const { values, problems } = useMemo(() => evaluate({ objects: cfg.objects }), [cfg.objects]);
  const picked = cfg.selection.map((id) => values.get(id)).filter((v): v is Value => !!v);
  const points = picked.filter((v): v is Extract<Value, { kind: 'point' }> => v.kind === 'point');

  const conics = cfg.objects
    .map((o) => ({ o, v: values.get(o.id) }))
    .filter((e): e is { o: GeoObject; v: Extract<Value, { kind: 'conic' }> } => e.v?.kind === 'conic');

  const polygons = cfg.objects
    .map((o) => ({ o, v: values.get(o.id) }))
    .filter((e): e is { o: GeoObject; v: Extract<Value, { kind: 'polygon' }> } => e.v?.kind === 'polygon');

  return (
    <>
      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat label="Objects" value={String(cfg.objects.length)} />
          <Stat label="Free points" value={String(cfg.objects.filter((o) => o.kind === 'point').length)} />
          {/* Two selected points have a distance; three have an angle. These
              are the measurements a figure is usually made to answer. */}
          {points.length === 2 && <Stat label="Distance" value={fmt(distance(points[0].p, points[1].p), 6)} emphasis />}
          {points.length === 3 && (
            <Stat label="Angle at the middle one" value={`${fmt(angleAt(points[0].p, points[1].p, points[2].p), 5)}°`} emphasis />
          )}
        </StatList>
        {problems.length > 0 && (
          <div className="pt-2">
            <Callout kind="warn">{problems[0].why}</Callout>
          </div>
        )}
      </div>

      {polygons.map(({ o, v }) => (
        <div key={o.id} className="border-b border-edge px-3 py-2.5">
          <div className="pb-1.5 text-xs font-medium text-ink">{o.label || 'Polygon'}</div>
          <StatList>
            <Stat label="Area" value={fmt(Math.abs(polygonArea(v.points)), 6)} emphasis />
            <Stat label="Perimeter" value={fmt(polygonPerimeter(v.points), 6)} />
            {v.points.length === 3 && (
              <>
                <Stat label="Angles" value={
                  [0, 1, 2]
                    .map((i) => fmt(angleAt(v.points[(i + 2) % 3], v.points[i], v.points[(i + 1) % 3]), 4))
                    .join('° · ') + '°'
                } />
                {/* They have to add to 180, and seeing that hold while the
                    triangle is dragged is the point of dragging it. */}
                <Stat
                  label="Angle sum"
                  value={`${fmt(
                    [0, 1, 2].reduce(
                      (s, i) => s + angleAt(v.points[(i + 2) % 3], v.points[i], v.points[(i + 1) % 3]),
                      0,
                    ),
                    6,
                  )}°`}
                />
              </>
            )}
          </StatList>
        </div>
      ))}

      {conics.map(({ o, v }) => {
        const g = conicGeometry(v.focus, v.foot, v.e);
        return (
          <div key={o.id} className="border-b border-edge px-3 py-2.5">
            <div className="pb-1.5 text-xs font-medium text-ink">{g.kind}</div>
            <StatList>
              <Stat label="Eccentricity" value={fmt(v.e, 5)} emphasis />
              <Stat label="Focus to directrix" value={fmt(v.distance, 5)} />
              <Stat label="Semi-latus rectum" value={fmt(g.semiLatus, 5)} />
              {Number.isFinite(g.a) && <Stat label="a" value={fmt(g.a, 5)} />}
              {Number.isFinite(g.b) && <Stat label="b" value={fmt(g.b, 5)} />}
              {Number.isFinite(g.c) && <Stat label="c = ae" value={fmt(g.c, 5)} />}
            </StatList>
            <div className="pt-1.5 text-2xs text-ink-faint">
              {/* The classical definition, stated as a consequence rather than
                  as the thing the curve was drawn from. */}
              {g.kind === 'ellipse'
                ? `Drawn from |PF| = e·d alone — and every point on it turns out to have its distances to the two foci summing to ${fmt(2 * g.a, 5)}.`
                : g.kind === 'hyperbola'
                  ? `Drawn from |PF| = e·d alone — and the difference of the distances to the two foci is ${fmt(2 * g.a, 5)} on both branches.`
                  : 'Every point is exactly as far from the focus as from the directrix, which is what makes it a parabola.'}
            </div>
          </div>
        );
      })}
    </>
  );
}

function analyseGeometry(tab: TabState): AnalyticResult {
  const cfg = tab.geometry;
  if (cfg.view === 'conics') {
    return {
      title: 'Conics from focus and directrix',
      equations: [
        String.raw`\frac{|PF|}{\operatorname{dist}(P, \ell)} = e`,
        String.raw`r = \frac{e\,d_0}{1 - e\cos\theta}`,
        String.raw`a = \frac{e\,d_0}{|1 - e^2|}, \qquad b = \frac{e\,d_0}{\sqrt{|1 - e^2|}}, \qquad c = ae`,
      ],
      quantities: [],
      overlay: null,
      caveat:
        'The curve is sampled from the first line only. The parameters underneath it are worked out separately, so when the string property comes out right it is two independent routes agreeing rather than one route repeated.',
    };
  }
  if (cfg.view === 'transform') {
    return {
      title: 'Transformations',
      equations: [
        String.raw`P' = 2\,\mathrm{foot}_\ell(P) - P \quad \text{(reflection)}`,
        String.raw`P' = C + R_\theta (P - C) \quad \text{(rotation)}`,
        String.raw`P' = C + k\,(P - C) \quad \text{(dilation, areas} \times k^2)`,
      ],
      quantities: [],
      overlay: null,
      caveat:
        'Every one of these is a similarity, so a line maps to a line and a circle to a circle — which is why the images here are real lines and circles rather than clouds of transformed points.',
    };
  }
  return {
    title: 'Compass and straightedge',
    equations: [
      String.raw`|PA| = |PB| \iff P \in \text{perpendicular bisector of } AB`,
      String.raw`\angle APB = 90^\circ \text{ for } P \text{ on the circle with diameter } AB`,
    ],
    quantities: [],
    overlay: null,
    caveat:
      'Nothing in the figure is stored except the free points. Everything else is a rule, re-evaluated wherever you drag them to — so a construction that holds in one position holds in all of them, which is what a proof means.',
  };
}

// ------------------------------------------------------------------ recipes

const RECIPES: { label: string; hint: string; build: () => { objects: GeoObject[]; view: 'construct' | 'conics' | 'transform' } }[] = [
  {
    label: 'Equilateral triangle',
    hint: "Euclid's first proposition: two circles and their crossing. Drag A or B and it stays equilateral.",
    build: () => {
      const a = uid('g');
      const b = uid('g');
      const c1 = uid('g');
      const c2 = uid('g');
      const apex = uid('g');
      return {
        view: 'construct',
        objects: [
          pt(a, -1.5, -1, 'A'),
          pt(b, 1.5, -1, 'B'),
          derived(c1, 'circle', [a, b], 3),
          derived(c2, 'circle', [b, a], 3),
          { ...derived(apex, 'intersection', [c1, c2], 1), branch: 0, label: 'C' },
          derived(uid('g'), 'polygon', [a, b, apex], 1),
        ],
      };
    },
  },
  {
    label: 'Circumcircle of a triangle',
    hint: 'Three perpendicular bisectors meeting at one point, and the circle through all three vertices.',
    build: () => {
      const a = uid('g');
      const b = uid('g');
      const c = uid('g');
      const ab = uid('g');
      const bc = uid('g');
      const o = uid('g');
      return {
        view: 'construct',
        objects: [
          pt(a, -2.4, -1.4, 'A'),
          pt(b, 2.6, -0.9, 'B'),
          pt(c, 0.3, 2.2, 'C'),
          derived(uid('g'), 'polygon', [a, b, c], 1),
          derived(ab, 'bisector', [a, b], 4),
          derived(bc, 'bisector', [b, c], 4),
          derived(uid('g'), 'bisector', [c, a], 4),
          { ...derived(o, 'intersection', [ab, bc], 2), label: 'O' },
          derived(uid('g'), 'circle', [o, a], 2),
        ],
      };
    },
  },
  {
    label: 'Thales: the angle in a semicircle',
    hint: 'Slide P round the circle. The angle at P is 90° all the way round, and the readout says so.',
    build: () => {
      const a = uid('g');
      const b = uid('g');
      const mid = uid('g');
      const circ = uid('g');
      const p = uid('g');
      return {
        view: 'construct',
        objects: [
          pt(a, -2.5, 0, 'A'),
          pt(b, 2.5, 0, 'B'),
          { ...derived(mid, 'midpoint', [a, b], 5), label: 'O' },
          derived(circ, 'circle', [mid, b], 3),
          { ...derived(p, 'pointOn', [circ], 1), value: 0.17, label: 'P' },
          derived(uid('g'), 'segment', [a, p], 2),
          derived(uid('g'), 'segment', [p, b], 2),
        ],
      };
    },
  },
  {
    label: 'An ellipse and its string',
    hint: 'A focus, a directrix and e = 0.6. The readout shows the sum of distances to the two foci coming out constant.',
    build: () => {
      const f = uid('g');
      const d1 = uid('g');
      const d2 = uid('g');
      const dir = uid('g');
      return {
        view: 'conics',
        objects: [
          pt(f, 1, 0, 'F'),
          pt(d1, -2.5, -2, ''),
          pt(d2, -2.5, 2, ''),
          derived(dir, 'line', [d1, d2], 5),
          { ...derived(uid('g'), 'conic', [f, dir], 2), value: 0.6 },
        ],
      };
    },
  },
  {
    label: 'A locus worth watching',
    hint: 'The midpoint of a fixed point and one running round a circle. Turn the locus on and it draws another circle, half the size.',
    build: () => {
      const o = uid('g');
      const rim = uid('g');
      const circ = uid('g');
      const driver = uid('g');
      const fixed = uid('g');
      return {
        view: 'construct',
        objects: [
          pt(o, -1.5, 0, 'O'),
          pt(rim, 0.5, 0, ''),
          derived(circ, 'circle', [o, rim], 3),
          { ...derived(driver, 'pointOn', [circ], 1), value: 0.1, label: 'P' },
          pt(fixed, 3, 1.5, 'Q'),
          derived(uid('g'), 'midpoint', [driver, fixed], 2),
          derived(uid('g'), 'segment', [driver, fixed], 5),
        ],
      };
    },
  },
];

const pt = (id: string, x: number, y: number, label: string): GeoObject => ({
  id,
  kind: 'point',
  parents: [],
  x,
  y,
  label,
  colour: SERIES_COLOURS[0],
  visible: true,
});

const derived = (id: string, kind: GeoObject['kind'], parents: string[], colour: number): GeoObject => ({
  id,
  kind,
  parents,
  label: '',
  colour: SERIES_COLOURS[colour % SERIES_COLOURS.length],
  visible: true,
});

/** The recipes, so the examples catalogue can reuse them. */
export const GEOMETRY_RECIPES = RECIPES;

export function geometryCsv(tab: TabState): string | null {
  const cfg = tab.geometry;
  const { values } = evaluate({ objects: cfg.objects });

  // A locus is the one thing here worth having as numbers elsewhere.
  if (cfg.showLocus && cfg.locusDriver && cfg.locusTracer) {
    const branches = locus({ objects: cfg.objects }, cfg.locusDriver, cfg.locusTracer, 400);
    const rows: (number | string)[][] = [];
    branches.forEach((branch, i) => {
      for (const p of branch) rows.push([i + 1, p.x, p.y]);
    });
    if (rows.length) return toCsv(['branch', 'x', 'y'], rows);
  }

  const rows: (number | string)[][] = [];
  for (const o of cfg.objects) {
    const v = values.get(o.id);
    if (!v) continue;
    if (v.kind === 'point') rows.push([o.label || o.id, o.kind, v.p.x, v.p.y, '']);
    else if (v.kind === 'circle') rows.push([o.label || o.id, o.kind, v.c.x, v.c.y, v.r]);
    else if (v.kind === 'line') rows.push([o.label || o.id, o.kind, v.a.x, v.a.y, '']);
  }
  return rows.length ? toCsv(['label', 'kind', 'x', 'y', 'radius'], rows) : null;
}
