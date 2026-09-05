/* Project serialisation.
 *
 * Reading a file the app itself wrote is easy. What matters here is reading a
 * file written by a *different build* — one that predates a field, or that
 * postdates one — and a file that has been hand-edited or corrupted. The
 * approach is deliberately non-strict: build a complete default document, walk
 * the loaded object, and copy across only values that are present and of the
 * right shape. A missing field silently becomes its default; a field of the
 * wrong type is reported and ignored. Nothing throws except a file that is not
 * a Manifold project at all, because a user who opens the wrong file should be
 * told, while a user opening a slightly old project should just see it open.
 */

import { makeProject, makeTab, uid } from './defaults';
import { defaultValues, SPEC_BY_KIND } from './physics/circuit';
import {
  MODE_BY_ID,
  SERIES_COLOURS,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  type ProjectFile,
  type TabMode,
  type TabState,
} from './types';

export interface LoadResult {
  project: ProjectFile;
  /** Non-fatal problems worth telling the user about. */
  warnings: string[];
}

export class ProjectFormatError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/* Fields whose keys are data rather than schema.
 *
 * The overlay below copies only the keys the default object already has, which
 * is exactly right for a fixed shape and exactly wrong for a free-form map: a
 * saved chi-squared distribution stores {df: 7}, and a key-wise merge against
 * the normal default {mu, sigma} would silently drop it. These paths are taken
 * verbatim instead. */
const VERBATIM_SUFFIXES = ['.statistics.params', '.statistics.compareParams', '.monteCarlo.params'];

const isVerbatim = (path: string) => VERBATIM_SUFFIXES.some((suffix) => path.endsWith(suffix));

/**
 * Recursively overlays `loaded` onto `base`, keeping `base`'s value wherever
 * the loaded one is absent or of a different type. Arrays are taken wholesale
 * from the loaded object when present — merging them element-wise would give
 * nonsense for lists of expressions.
 */
function overlay<T>(base: T, loaded: unknown, path: string, warnings: string[]): T {
  if (loaded === undefined || loaded === null) return base;
  if (isVerbatim(path)) {
    if (!isObject(loaded)) {
      warnings.push(`${path} should be an object; kept the default.`);
      return base;
    }
    const numeric: Record<string, number> = {};
    for (const [k, v] of Object.entries(loaded)) if (typeof v === 'number' && Number.isFinite(v)) numeric[k] = v;
    return numeric as unknown as T;
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(loaded)) {
      warnings.push(`${path} should be a list; kept the default.`);
      return base;
    }
    return loaded as unknown as T;
  }
  if (isObject(base)) {
    if (!isObject(loaded)) {
      warnings.push(`${path} should be an object; kept the default.`);
      return base;
    }
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(base as Record<string, unknown>)) {
      if (key in loaded) {
        out[key] = overlay((base as Record<string, unknown>)[key], loaded[key], `${path}.${key}`, warnings);
      }
    }
    return out as T;
  }
  if (typeof base === 'number') return num(loaded, base) as unknown as T;
  if (typeof base === 'string') return str(loaded, base) as unknown as T;
  if (typeof base === 'boolean') return bool(loaded, base) as unknown as T;
  return (typeof loaded === typeof base ? loaded : base) as T;
}

export function serialiseProject(project: ProjectFile): string {
  const out: ProjectFile = {
    ...project,
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    meta: { ...project.meta, modifiedAt: new Date().toISOString() },
  };
  // Two-space indentation, because these files end up in git repositories and
  // a readable diff is worth the extra bytes.
  return JSON.stringify(out, replacer, 2);
}

/** Typed arrays and non-finite numbers do not survive JSON; normalise both. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Float64Array || value instanceof Float32Array) return Array.from(value);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return value === Infinity ? 1e308 : value === -Infinity ? -1e308 : 0;
  }
  return value;
}

export function deserialiseProject(text: string, appVersion = '1.0.0'): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProjectFormatError(
      `This file is not valid JSON, so it cannot be a Manifold project. ${err instanceof Error ? err.message : ''}`,
    );
  }
  if (!isObject(raw)) throw new ProjectFormatError('This file does not contain a Manifold project.');
  if (raw.format !== PROJECT_FORMAT) {
    throw new ProjectFormatError(
      `Expected a Manifold project (format "${PROJECT_FORMAT}") but found "${String(raw.format ?? 'nothing')}".`,
    );
  }

  const warnings: string[] = [];
  const loadedVersion = num(raw.version, 0);
  if (loadedVersion > PROJECT_VERSION) {
    warnings.push(
      `This project was saved by a newer version of Manifold (format ${loadedVersion} vs ${PROJECT_VERSION}). Anything this build does not recognise has been left out.`,
    );
  }

  const base = makeProject(appVersion);
  const tabsRaw = Array.isArray(raw.tabs) ? raw.tabs : [];
  const tabs: TabState[] = tabsRaw.map((t, i) => loadTab(t, i, warnings)).filter((t): t is TabState => t !== null);
  if (!tabs.length) {
    warnings.push('The project contained no readable tabs, so a new one was created.');
    tabs.push(makeTab('graphing'));
  }

  const activeId = str(raw.activeTabId, tabs[0].id);
  const project: ProjectFile = {
    ...base,
    meta: overlay(base.meta, raw.meta, 'meta', warnings),
    ui: overlay(base.ui, raw.ui, 'ui', warnings),
    app: { name: 'Manifold', version: appVersion },
    tabs,
    activeTabId: tabs.some((t) => t.id === activeId) ? activeId : tabs[0].id,
  };
  return { project, warnings };
}

function loadTab(rawTab: unknown, index: number, warnings: string[]): TabState | null {
  if (!isObject(rawTab)) {
    warnings.push(`Tab ${index + 1} was not readable and has been skipped.`);
    return null;
  }
  const modeRaw = str(rawTab.mode, 'graphing');
  const mode: TabMode = MODE_BY_ID.has(modeRaw as TabMode) ? (modeRaw as TabMode) : 'graphing';
  if (!MODE_BY_ID.has(modeRaw as TabMode)) {
    warnings.push(`Tab ${index + 1} uses an unknown mode "${modeRaw}"; it has been opened as a graph.`);
  }
  const base = makeTab(mode);
  const merged = overlay(base, rawTab, `tabs[${index}]`, warnings);
  // Identifiers must be unique and non-empty for React keys and for the tab
  // switcher; a hand-edited file cannot be trusted to have kept them so.
  return {
    ...merged,
    id: str(rawTab.id, '') || uid('tab'),
    mode,
    expressions: merged.expressions.map((e, i) => ({ ...e, id: e.id || uid(`exp${i}`) })),
    parameters: merged.parameters.map((p, i) => ({ ...p, id: p.id || uid(`par${i}`) })),
    mechanics: sanitiseMechanics(merged.mechanics),
    circuits: sanitiseCircuits(merged.circuits),
    quantum: sanitiseQuantum(merged.quantum),
    chemistry: sanitiseChemistry(merged.chemistry),
  };
}

/* Arrays are taken from the file wholesale — the right call for a list of
 * expressions, where merging element by element would produce nonsense — but
 * it means a sandbox scene arrives exactly as it was written, including a body
 * saved before `radius` existed or one a text editor has been let near. The
 * physics engines are defensive about values they are given, but they cannot
 * invent a missing colour or a missing label, and a body with `mass: null`
 * would propagate NaN through a whole trajectory. So the two scenes are
 * normalised on the way in, field by field. */

const number = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const text = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

function sanitiseMechanics(cfg: TabState['mechanics']): TabState['mechanics'] {
  const w = isObject(cfg.world) ? (cfg.world as unknown as Record<string, unknown>) : {};
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter(isObject) : [];

  const bodies = list(w.bodies).map((b, i) => {
    const kind = b.kind === 'anchor' ? ('anchor' as const) : ('mass' as const);
    return {
    id: text(b.id, '') || uid(`body${i}`),
    kind,
    x: number(b.x, 0),
    y: number(b.y, 0),
    vx: number(b.vx, 0),
    vy: number(b.vy, 0),
    /* The floor is there to stop a *mass* having no mass, which would divide
     * by zero in the solver. An anchor is bolted to the world and its mass is
     * meaningless, so clamping it to a millionth of a kilogram changes nothing
     * physically and quietly breaks the promise that a project file
     * round-trips unchanged — which shows up as a phantom diff every time
     * someone saves a file they did not edit. */
    mass: kind === 'anchor' ? number(b.mass, 0) : Math.max(1e-6, number(b.mass, 1)),
    radius: Math.max(0, number(b.radius, 0.15)),
    label: text(b.label, `Body ${i + 1}`),
    colour: text(b.colour, SERIES_COLOURS[i % SERIES_COLOURS.length]),
    };
  });
  const known = new Set(bodies.map((b) => b.id));

  const links = list(w.links)
    .map((l, i) => ({
      id: text(l.id, '') || uid(`link${i}`),
      kind: l.kind === 'rope' ? ('rope' as const) : l.kind === 'spring' ? ('spring' as const) : ('rod' as const),
      a: text(l.a, ''),
      b: text(l.b, ''),
      length: typeof l.length === 'number' && Number.isFinite(l.length) ? l.length : null,
      stiffness: Math.max(0, number(l.stiffness, 100)),
      damping: Math.max(0, number(l.damping, 0)),
      label: text(l.label, `Link ${i + 1}`),
      colour: text(l.colour, '#cbd5e1'),
    }))
    .filter((l) => known.has(l.a) && known.has(l.b));

  const surfaces = list(w.surfaces).map((s, i) => ({
    id: text(s.id, '') || uid(`surf${i}`),
    x0: number(s.x0, 0),
    y0: number(s.y0, 0),
    x1: number(s.x1, 1),
    y1: number(s.y1, 0),
    muK: Math.max(0, number(s.muK, 0.2)),
    muS: Math.max(0, number(s.muS, 0.3)),
    restitution: Math.min(1, Math.max(0, number(s.restitution, 0))),
    flip: flag(s.flip, false),
    label: text(s.label, `Surface ${i + 1}`),
    colour: text(s.colour, '#94a3b8'),
  }));

  const pulleys = list(w.pulleys)
    .map((p, i) => ({
      id: text(p.id, '') || uid(`pul${i}`),
      x: number(p.x, 0),
      y: number(p.y, 0),
      a: text(p.a, ''),
      b: text(p.b, ''),
      length: typeof p.length === 'number' && Number.isFinite(p.length) ? p.length : null,
      radius: Math.max(0.01, number(p.radius, 0.2)),
      label: text(p.label, `Pulley ${i + 1}`),
      colour: text(p.colour, '#94a3b8'),
    }))
    .filter((p) => known.has(p.a) && known.has(p.b));

  const targets = new Set<string>([
    ...bodies.map((b) => b.id),
    ...links.map((l) => l.id),
    ...pulleys.map((p) => p.id),
  ]);
  const measurements = (Array.isArray(cfg.measurements) ? cfg.measurements : [])
    .filter(isObject)
    .map((m, i) => ({
      id: text(m.id, '') || uid(`meas${i}`),
      kind: text(m.kind, 'y') as TabState['mechanics']['measurements'][number]['kind'],
      target: text(m.target, ''),
      colour: text(m.colour, SERIES_COLOURS[i % SERIES_COLOURS.length]),
      visible: flag(m.visible, true),
    }))
    .filter((m) => m.target === '' || targets.has(m.target) || m.kind in WORLD_MEASUREMENTS);

  return {
    ...cfg,
    world: {
      gravity: number(w.gravity, 9.81),
      dragMode: w.dragMode === 'linear' || w.dragMode === 'quadratic' ? w.dragMode : ('none' as const),
      dragCoefficient: Math.max(0, number(w.dragCoefficient, 0.05)),
      bodies,
      links,
      surfaces,
      pulleys,
    },
    measurements,
    selectedId: targets.has(cfg.selectedId ?? '') ? cfg.selectedId : null,
  };
}

const WORLD_MEASUREMENTS = { kinetic: 1, potential: 1, total: 1 };

function sanitiseCircuits(cfg: TabState['circuits']): TabState['circuits'] {
  const w = isObject(cfg.world) ? (cfg.world as unknown as Record<string, unknown>) : {};
  const raw = Array.isArray(w.elements) ? w.elements.filter(isObject) : [];
  const elements = raw
    .filter((e) => SPEC_BY_KIND.has(text(e.kind, '') as never))
    .map((e, i) => {
      const kind = text(e.kind, 'wire') as Parameters<typeof defaultValues>[0];
      const values: Record<string, number> = { ...defaultValues(kind) };
      if (isObject(e.values)) {
        for (const [k, v] of Object.entries(e.values)) {
          if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
        }
      }
      return {
        id: text(e.id, '') || uid(`el${i}`),
        kind,
        x: Math.round(number(e.x, 0)),
        y: Math.round(number(e.y, 0)),
        orientation: e.orientation === 'v' ? ('v' as const) : ('h' as const),
        reversed: flag(e.reversed, false),
        values,
        label: text(e.label, ''),
      };
    });
  const ids = new Set(elements.map((e) => e.id));

  const readings = (Array.isArray(cfg.readings) ? cfg.readings : [])
    .filter(isObject)
    .map((r, i) => ({
      id: text(r.id, '') || uid(`read${i}`),
      kind: text(r.kind, 'voltage') as TabState['circuits']['readings'][number]['kind'],
      target: text(r.target, ''),
      colour: text(r.colour, SERIES_COLOURS[i % SERIES_COLOURS.length]),
      visible: flag(r.visible, true),
    }))
    .filter((r) => ids.has(r.target));

  return {
    ...cfg,
    world: {
      elements,
      temperature: number(w.temperature, 25),
      timestep: Math.max(0, number(w.timestep, 0)),
    },
    readings,
    // A hand-edited file could carry anything here, and an unrecognised value
    // would silently disable the animation rather than pick a direction.
    flowMode: cfg.flowMode === 'electron' ? 'electron' : 'conventional',
    selectedId: ids.has(cfg.selectedId ?? '') ? cfg.selectedId : null,
  };
}

const FEATURE_KINDS = new Set(['barrier', 'well', 'step', 'harmonic', 'gaussian', 'linear', 'coulomb']);
const QUANTUM_VIEWS = new Set(['bound', 'evolve', 'scatter', 'plane']);
const PLANE_SHAPES = new Set(['box', 'circle', 'harmonic', 'separable']);

function sanitiseQuantum(cfg: TabState['quantum']): TabState['quantum'] {
  const w = isObject(cfg.world) ? (cfg.world as unknown as Record<string, unknown>) : {};
  const raw = Array.isArray(w.features) ? w.features.filter(isObject) : [];
  const features = raw
    .filter((f) => FEATURE_KINDS.has(text(f.kind, '')))
    .map((f, i) => ({
      id: text(f.id, '') || uid(`qf${i}`),
      kind: text(f.kind, 'barrier') as TabState['quantum']['world']['features'][number]['kind'],
      centre: number(f.centre, 0),
      // A zero or negative width is not a thin feature, it is a division by
      // zero in every one of the shape functions.
      width: Math.max(1e-4, number(f.width, 1)),
      height: number(f.height, 1),
    }));

  const packet = isObject(w.packet) ? (w.packet as Record<string, unknown>) : {};
  const plane = isObject(w.plane) ? (w.plane as Record<string, unknown>) : {};
  const xMin = number(w.xMin, -3);
  const xMax = number(w.xMax, 3);
  const ids = new Set(features.map((f) => f.id));

  return {
    ...cfg,
    world: {
      view: (QUANTUM_VIEWS.has(text(w.view, '')) ? text(w.view, 'bound') : 'bound') as TabState['quantum']['world']['view'],
      xMin: Math.min(xMin, xMax),
      // A zero-width domain would make the grid spacing zero and every energy
      // infinite; a hand-edited file is entitled to try.
      xMax: Math.max(xMax, Math.min(xMin, xMax) + 0.01),
      points: Math.max(32, Math.min(2000, Math.round(number(w.points, 480)))),
      mass: Math.max(1e-4, number(w.mass, 1)),
      features,
      expression: text(w.expression, ''),
      levels: Math.max(1, Math.min(24, Math.round(number(w.levels, 6)))),
      packet: {
        centre: number(packet.centre, 0),
        width: Math.max(1e-3, number(packet.width, 1)),
        momentum: number(packet.momentum, 0),
      },
      duration: Math.max(0.01, number(w.duration, 20)),
      absorbing: flag(w.absorbing, true),
      scatterMin: Math.max(1e-4, number(w.scatterMin, 0.05)),
      scatterMax: Math.max(1e-3, number(w.scatterMax, 8)),
      plane: {
        shape: (PLANE_SHAPES.has(text(plane.shape, '')) ? text(plane.shape, 'box') : 'box') as TabState['quantum']['world']['plane']['shape'],
        size: Math.max(0.05, number(plane.size, 1)),
        depth: number(plane.depth, 200),
        aspect: Math.max(0.2, Math.min(5, number(plane.aspect, 1))),
        points: Math.max(16, Math.min(160, Math.round(number(plane.points, 90)))),
        levels: Math.max(1, Math.min(24, Math.round(number(plane.levels, 6)))),
      },
    },
    selectedId: ids.has(cfg.selectedId ?? '') ? cfg.selectedId : (features[0]?.id ?? null),
    level: Math.max(0, Math.round(number(cfg.level, 0))),
    scale: Math.max(0.05, Math.min(10, number(cfg.scale, 1))),
  };
}

function sanitiseChemistry(cfg: TabState['chemistry']): TabState['chemistry'] {
  return {
    ...cfg,
    // Out of range means no element panel at all, and an empty right-hand
    // column with no explanation of why.
    selected: Math.max(1, Math.min(118, Math.round(number(cfg.selected, 6)))),
  };
}

/** A short, filesystem-safe name derived from the project title. */
export function suggestedFileName(project: ProjectFile): string {
  const base = project.meta.title.trim() || 'Untitled';
  return base.replace(/[^\w\- ]+/g, '').slice(0, 60) || 'Untitled';
}

// ------------------------------------------------------------------ CSV export

/** Serialises a table to CSV, quoting only where it is actually required. */
export function toCsv(headers: string[], rows: (number | string)[][]): string {
  const cell = (v: number | string) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');
}
