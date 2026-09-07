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

import {
  defaultGeometry,
  defaultOptimisation,
  defaultReactions,
  defaultSignals,
  defaultThermo,
  defaultWaves,
  makeProject,
  makeTab,
  uid,
} from './defaults';
import { defaultValues, SPEC_BY_KIND } from './physics/circuit';
import type { GeoObject } from './math/geometry';
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
const VERBATIM_SUFFIXES = [
  '.statistics.params',
  '.statistics.compareParams',
  '.monteCarlo.params',
  // Starting concentrations are keyed by species name, so the keys come from
  // whatever equations the user typed. Merging them against the default's
  // {A, B, C} would silently drop every species of a saved Haber run and put
  // back the three the app happens to ship with.
  '.reactions.initial',
];

const isVerbatim = (path: string) => VERBATIM_SUFFIXES.some((suffix) => path.endsWith(suffix));

/**
 * Recursively overlays `loaded` onto `base`, keeping `base`'s value wherever
 * the loaded one is absent or of a different type. Arrays are taken wholesale
 * from the loaded object when present — merging them element-wise would give
 * nonsense for lists of expressions.
 */
function overlay<T>(base: T, loaded: unknown, path: string, warnings: string[]): T {
  if (loaded === undefined) return base;

  /* Null needs its own rule, and the default is what supplies it.
   *
   * A field whose default is null is nullable — `selectedId`, `compareId`,
   * `barrier` — and null is a value there, not an absence: "nothing is
   * selected" has to survive a save. A field whose default is a string or a
   * number is not nullable, and a null in the file is damage; those keep the
   * default. Without the first half of that rule, saving a tab with nothing
   * selected and opening it again silently selected something; without the
   * second, one corrupted field could put a null where the UI expects text. */
  if (base === null) {
    const kind = typeof loaded;
    if (loaded === null || kind === 'string' || kind === 'number' || kind === 'boolean') {
      return (kind === 'number' && !Number.isFinite(loaded as number) ? null : loaded) as T;
    }
    warnings.push(`${path} should be a simple value or nothing; kept the default.`);
    return base;
  }
  if (loaded === null) return base;
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
    waves: sanitiseWaves(merged.waves),
    signals: sanitiseSignals(merged.signals),
    optimisation: sanitiseOptimisation(merged.optimisation),
    reactions: sanitiseReactions(merged.reactions),
    thermodynamics: sanitiseThermo(merged.thermodynamics),
    geometry: sanitiseGeometry(merged.geometry),
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

const WAVE_VIEWS = new Set(['propagate', 'diffract', 'rays']);
const MEDIA_IDS = new Set(['string', 'spring', 'sound', 'water', 'em']);
const BOUNDARIES = new Set(['fixed', 'free', 'absorbing']);
const SOURCE_KINDS = new Set(['pulse', 'driven', 'mode']);

function sanitiseWaves(cfg: TabState['waves']): TabState['waves'] {
  const fallback = defaultWaves().world;
  const w = isObject(cfg.world) ? (cfg.world as unknown as Record<string, unknown>) : {};
  const pick = <T extends string>(v: unknown, allowed: Set<string>, dflt: T): T =>
    (allowed.has(text(v, '')) ? (v as T) : dflt);

  // Medium parameters are read by name inside the speed formulas; a null or a
  // string among them would turn the whole wave speed into NaN, and every
  // sample with it.
  const params: Record<string, number> = {};
  if (isObject(w.params)) {
    for (const [key, value] of Object.entries(w.params as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    }
  }

  const src = isObject(w.source) ? (w.source as Record<string, unknown>) : {};
  const rawSlits = Array.isArray(w.slits) ? w.slits.filter(isObject) : [];
  const slits = rawSlits.map((s, i) => ({
    id: text(s.id, '') || uid(`slit${i}`),
    centre: number(s.centre, 0),
    // A slit of zero width transmits nothing and divides by zero when the
    // aperture is sampled.
    width: Math.max(1e-4, number(s.width, 0.04)),
    transmission: Math.max(0, Math.min(1, number(s.transmission, 1))),
    phase: number(s.phase, 0),
  }));

  const rawSurfaces = Array.isArray(w.surfaces) ? w.surfaces.filter(isObject) : [];
  const surfaces = rawSurfaces.map((s, i) => ({
    id: text(s.id, '') || uid(`surf${i}`),
    z: number(s.z, 0),
    // Zero is meaningful here: a flat surface. Anything non-finite is not.
    radius: number(s.radius, 0),
    tilt: number(s.tilt, 0),
    aperture: Math.max(1e-3, number(s.aperture, 18)),
    // An index below one is physically fine (X-rays, plasmas) but a zero or
    // negative one inverts Snell's law into nonsense.
    index: Math.max(1e-3, number(s.index, 1)),
    // Zero means no dispersion. A negative Abbe number would invert the
    // Cauchy curve and make blue refract less than red, which no glass does.
    abbe: Math.max(0, Math.min(200, number(s.abbe, 0))),
    mirror: flag(s.mirror, false),
    label: text(s.label, `Surface ${i + 1}`),
  }));

  const ids = new Set<string>([...slits.map((s) => s.id), ...surfaces.map((s) => s.id)]);

  return {
    ...cfg,
    world: {
      view: pick(w.view, WAVE_VIEWS, fallback.view),
      medium: pick(w.medium, MEDIA_IDS, fallback.medium),
      params: Object.keys(params).length > 0 ? params : { ...fallback.params },
      length: Math.max(1e-3, number(w.length, fallback.length)),
      points: Math.max(32, Math.min(4000, Math.round(number(w.points, fallback.points)))),
      left: pick(w.left, BOUNDARIES, fallback.left),
      right: pick(w.right, BOUNDARIES, fallback.right),
      junction: Math.max(0, Math.min(1, number(w.junction, fallback.junction))),
      speedRatio: Math.max(1e-3, number(w.speedRatio, fallback.speedRatio)),
      source: {
        kind: pick(src.kind, SOURCE_KINDS, fallback.source.kind),
        centre: Math.max(0, Math.min(1, number(src.centre, fallback.source.centre))),
        width: Math.max(1e-4, number(src.width, fallback.source.width)),
        frequency: Math.max(0, number(src.frequency, fallback.source.frequency)),
        amplitude: number(src.amplitude, fallback.source.amplitude),
      },
      duration: Math.max(1e-4, number(w.duration, fallback.duration)),
      wavelength: Math.max(1e-3, number(w.wavelength, fallback.wavelength)),
      slits: slits.length > 0 ? slits : fallback.slits,
      screenDistance: Math.max(1e-4, number(w.screenDistance, fallback.screenDistance)),
      screenWidth: Math.max(1e-5, number(w.screenWidth, fallback.screenWidth)),
      sourceDistance: Math.max(0, number(w.sourceDistance, fallback.sourceDistance)),
      surfaces,
      rayCount: Math.max(1, Math.min(201, Math.round(number(w.rayCount, fallback.rayCount)))),
      // Zero is a legitimate fan: one ray straight down the axis, which is
      // how a prism is normally drawn. Nothing divides by this.
      rayHeight: Math.max(0, number(w.rayHeight, fallback.rayHeight)),
      objectDistance: number(w.objectDistance, fallback.objectDistance),
      rayAngle: number(w.rayAngle, fallback.rayAngle),
      dispersion: flag(w.dispersion, fallback.dispersion),
      spectrumLines: Math.max(2, Math.min(24, Math.round(number(w.spectrumLines, fallback.spectrumLines)))),
    },
    selectedId: ids.has(cfg.selectedId ?? '') ? cfg.selectedId : null,
    showAnalytic: flag(cfg.showAnalytic, true),
    showEquations: flag(cfg.showEquations, true),
    logIntensity: flag(cfg.logIntensity, false),
  };
}

const SIGNAL_VIEWS = new Set(['spectrum', 'spectrogram', 'filter', 'sampling']);
const WINDOW_NAMES = new Set(['rectangular', 'hann', 'hamming', 'blackman', 'flattop']);
const FILTER_FAMILIES = new Set(['butterworth', 'chebyshev']);
const FILTER_RESPONSES = new Set(['lowpass', 'highpass', 'bandpass', 'notch']);

function sanitiseSignals(cfg: TabState['signals']): TabState['signals'] {
  const fallback = defaultSignals();
  const pick = <T extends string>(v: unknown, allowed: Set<string>, dflt: T): T =>
    (allowed.has(text(v, '')) ? (v as T) : dflt);
  const f = isObject(cfg.filter) ? (cfg.filter as unknown as Record<string, unknown>) : {};

  const sampleRate = Math.max(1, number(cfg.sampleRate, fallback.sampleRate));
  // A power-of-two window longer than the signal would read off the end of the
  // sample buffer; the spectrogram would come back as a column of zeros.
  const windowSize = Math.max(8, Math.min(8192, Math.round(number(cfg.windowSize, fallback.windowSize))));

  return {
    ...cfg,
    view: pick(cfg.view, SIGNAL_VIEWS, fallback.view),
    expression: text(cfg.expression, fallback.expression),
    sampleRate,
    duration: Math.max(1e-4, Math.min(600, number(cfg.duration, fallback.duration))),
    window: pick(cfg.window, WINDOW_NAMES, fallback.window),
    noise: Math.max(0, number(cfg.noise, 0)),
    seed: text(cfg.seed, fallback.seed),
    data: Array.isArray(cfg.data)
      ? cfg.data.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      : [],
    useData: flag(cfg.useData, false),
    filter: {
      family: pick(f.family, FILTER_FAMILIES, fallback.filter.family),
      response: pick(f.response, FILTER_RESPONSES, fallback.filter.response),
      // An odd order is legal; a zero or a fractional one is not a filter.
      order: Math.max(1, Math.min(16, Math.round(number(f.order, fallback.filter.order)))),
      cutoff: Math.max(1e-6, number(f.cutoff, fallback.filter.cutoff)),
      cutoffHigh: Math.max(1e-6, number(f.cutoffHigh, fallback.filter.cutoffHigh)),
      sampleRate: Math.max(1, number(f.sampleRate, sampleRate)),
      ripple: Math.max(1e-3, Math.min(12, number(f.ripple, fallback.filter.ripple))),
      q: Math.max(0.1, Math.min(200, number(f.q, fallback.filter.q))),
    },
    filtered: flag(cfg.filtered, false),
    logFrequency: flag(cfg.logFrequency, false),
    decibels: flag(cfg.decibels, false),
    windowSize,
    toneFrequency: Math.max(0, number(cfg.toneFrequency, fallback.toneFrequency)),
    sampleFrequency: Math.max(1, number(cfg.sampleFrequency, fallback.sampleFrequency)),
  };
}

const OPT_VIEWS = new Set(['linear', 'descent', 'lagrange']);
const RELATIONS = new Set(['<=', '>=', '=']);
const DESCENT_METHODS = new Set(['gradient', 'momentum', 'nesterov', 'adam', 'newton']);

function sanitiseOptimisation(cfg: TabState['optimisation']): TabState['optimisation'] {
  const fallback = defaultOptimisation();
  const pick = <T extends string>(v: unknown, allowed: Set<string>, dflt: T): T =>
    allowed.has(text(v, '')) ? (v as T) : dflt;
  const program = isObject(cfg.program) ? (cfg.program as unknown as Record<string, unknown>) : {};

  /* Every constraint has to carry exactly two coefficients. The simplex reads
   * them by index, so a row that arrived one short would silently be solved as
   * though its second variable had coefficient undefined — which propagates as
   * NaN through the whole tableau and comes out as an empty feasible region
   * with no explanation. */
  const coefficients = (v: unknown): [number, number] => {
    const a = Array.isArray(v) ? v : [];
    return [number(a[0], 0), number(a[1], 0)];
  };

  const rawConstraints = Array.isArray(program.constraints) ? program.constraints : [];
  const constraints = rawConstraints.slice(0, 40).map((raw) => {
    const c: Record<string, unknown> = isObject(raw) ? raw : {};
    return {
      id: text(c.id, uid('con')),
      coefficients: coefficients(c.coefficients),
      relation: pick(c.relation, RELATIONS, '<=' as const),
      rhs: number(c.rhs, 0),
      label: text(c.label, ''),
    };
  });

  return {
    ...cfg,
    view: pick(cfg.view, OPT_VIEWS, fallback.view),
    program: {
      objective: coefficients(program.objective),
      maximise: flag(program.maximise, true),
      nonNegative: flag(program.nonNegative, true),
      constraints,
    },
    // −1 means "the whole path"; anything else indexes into it and is clamped
    // by the drawing code, so only the sentinel needs protecting here.
    simplexStep: Math.max(-1, Math.round(number(cfg.simplexStep, -1))),
    showRegion: flag(cfg.showRegion, true),
    showObjectiveLine: flag(cfg.showObjectiveLine, true),
    surface: text(cfg.surface, fallback.surface),
    method: pick(cfg.method, DESCENT_METHODS, fallback.method),
    rate: Math.max(1e-9, Math.min(10, number(cfg.rate, fallback.rate))),
    momentum: Math.max(0, Math.min(0.999, number(cfg.momentum, fallback.momentum))),
    descentSteps: Math.max(1, Math.min(50000, Math.round(number(cfg.descentSteps, fallback.descentSteps)))),
    startX: number(cfg.startX, fallback.startX),
    startY: number(cfg.startY, fallback.startY),
    showContours: flag(cfg.showContours, true),
    contourCount: Math.max(2, Math.min(60, Math.round(number(cfg.contourCount, fallback.contourCount)))),
    objective: text(cfg.objective, fallback.objective),
    constraint: text(cfg.constraint, fallback.constraint),
    showGradients: flag(cfg.showGradients, true),
    showEquations: flag(cfg.showEquations, true),
  };
}

const GEOMETRY_VIEWS = new Set(['construct', 'conics', 'transform']);
const GEO_KINDS = new Set([
  'point', 'pointOn', 'intersection', 'line', 'ray', 'segment', 'parallel', 'perpendicular',
  'circle', 'circleRadius', 'midpoint', 'bisector', 'angleBisector',
  'reflect', 'rotate', 'translate', 'dilate', 'conic', 'polygon',
]);
const GEO_TOOLS = new Set([
  'select', 'point', 'pointOn', 'intersection', 'segment', 'line', 'ray', 'circle', 'midpoint',
  'bisector', 'perpendicular', 'parallel', 'angleBisector', 'polygon', 'conic',
  'reflect', 'rotate', 'translate', 'dilate',
]);

function sanitiseGeometry(cfg: TabState['geometry']): TabState['geometry'] {
  const fallback = defaultGeometry();
  const pick = <T extends string>(v: unknown, allowed: Set<string>, dflt: T): T =>
    allowed.has(text(v, '')) ? (v as T) : dflt;

  const rawObjects = Array.isArray(cfg.objects) ? cfg.objects : [];
  const objects = rawObjects.slice(0, 400).map((raw) => {
    const o: Record<string, unknown> = isObject(raw) ? raw : {};
    const parents = (Array.isArray(o.parents) ? o.parents : [])
      .filter((v): v is string => typeof v === 'string')
      .slice(0, 8);
    /* The optional fields stay optional.
     *
     * A line has no x, and a midpoint has no branch. Writing a zero into every
     * slot would round-trip a saved file into a different-looking one, bloat
     * the JSON, and — worse — suggest to anyone reading it that a bisector has
     * a position of its own. Each is carried across only when it is actually
     * there and actually a number. */
    const out: GeoObject = {
      id: text(o.id, uid('g')),
      kind: pick(o.kind, GEO_KINDS, 'point' as const),
      parents,
      label: text(o.label, '').slice(0, 24),
      colour: text(o.colour, SERIES_COLOURS[0]),
      visible: flag(o.visible, true),
    };
    if (typeof o.x === 'number' && Number.isFinite(o.x)) out.x = o.x;
    if (typeof o.y === 'number' && Number.isFinite(o.y)) out.y = o.y;
    if (typeof o.value === 'number' && Number.isFinite(o.value)) out.value = o.value;
    if (typeof o.branch === 'number') out.branch = o.branch >= 1 ? 1 : 0;
    return out;
  });

  /* Parents that do not exist would evaluate as invalid for ever, and a
   * construction whose objects reference each other in a cycle would too — but
   * the evaluator reports that itself, so only dangling references are pruned
   * here. Objects are kept in order, and a parent may legitimately appear after
   * its child, so membership is checked against the whole set. */
  const ids = new Set(objects.map((o) => o.id));
  const kept = objects.filter((o) => o.parents.every((parent) => ids.has(parent)));

  const idOf = (v: unknown): string | null => {
    const s = text(v, '');
    return s && kept.some((o) => o.id === s) ? s : null;
  };

  return {
    ...cfg,
    view: pick(cfg.view, GEOMETRY_VIEWS, fallback.view),
    objects: kept,
    tool: pick(cfg.tool, GEO_TOOLS, 'select' as const),
    selection: (Array.isArray(cfg.selection) ? cfg.selection : [])
      .filter((v): v is string => typeof v === 'string' && kept.some((o) => o.id === v))
      .slice(0, 8),
    showLabels: flag(cfg.showLabels, true),
    showLocus: flag(cfg.showLocus, false),
    locusDriver: idOf(cfg.locusDriver),
    locusTracer: idOf(cfg.locusTracer),
    rotateAngle: Math.max(-360, Math.min(360, number(cfg.rotateAngle, fallback.rotateAngle))),
    dilateFactor: Math.max(-20, Math.min(20, number(cfg.dilateFactor, fallback.dilateFactor))),
    // Zero or negative is not a conic, and infinity is not a number.
    eccentricity: Math.max(1e-4, Math.min(20, number(cfg.eccentricity, fallback.eccentricity))),
    showConicDetail: flag(cfg.showConicDetail, true),
  };
}

const REACTION_VIEWS = new Set(['kinetics', 'equilibrium', 'titration', 'arrhenius']);

function sanitiseReactions(cfg: TabState['reactions']): TabState['reactions'] {
  const fallback = defaultReactions();
  const pick = <T extends string>(v: unknown, allowed: Set<string>, dflt: T): T =>
    allowed.has(text(v, '')) ? (v as T) : dflt;

  const rawReactions = Array.isArray(cfg.reactions) ? cfg.reactions : [];
  const reactions = rawReactions.slice(0, 24).map((raw) => {
    const r: Record<string, unknown> = isObject(raw) ? raw : {};
    return {
      id: text(r.id, uid('rxn')),
      equation: text(r.equation, 'A -> B'),
      // A negative rate constant would run the reaction backwards through its
      // own rate law and send the concentrations off to minus infinity.
      forward: Math.max(0, number(r.forward, 1)),
      reverse: Math.max(0, number(r.reverse, 0)),
      activationForward: Math.max(0, number(r.activationForward, 50)),
      activationReverse: Math.max(0, number(r.activationReverse, 50)),
      enabled: flag(r.enabled, true),
    };
  });

  const initial: Record<string, number> = {};
  if (isObject(cfg.initial)) {
    for (const [key, value] of Object.entries(cfg.initial)) {
      if (typeof key === 'string' && key.length <= 24) initial[key] = Math.max(0, number(value, 0));
    }
  }

  const p = isObject(cfg.perturbation) ? (cfg.perturbation as unknown as Record<string, unknown>) : {};
  // Ka values must be positive: log10 of zero is −Infinity and the bisection
  // would search an interval with no finite endpoint.
  const ka = (Array.isArray(cfg.ka) ? cfg.ka : [])
    .map((k) => number(k, 0))
    .filter((k) => k > 0 && k < 1e6)
    .slice(0, 6);

  return {
    ...cfg,
    view: pick(cfg.view, REACTION_VIEWS, fallback.view),
    reactions: reactions.length ? reactions : fallback.reactions,
    initial,
    duration: Math.max(1e-6, Math.min(1e6, number(cfg.duration, fallback.duration))),
    samples: Math.max(2, Math.min(4000, Math.round(number(cfg.samples, fallback.samples)))),
    useArrhenius: flag(cfg.useArrhenius, false),
    temperature: Math.max(1, Math.min(5000, number(cfg.temperature, fallback.temperature))),
    perturbation: {
      at: Math.max(0, number(p.at, 0)),
      species: text(p.species, 'A'),
      amount: number(p.amount, 0),
      enabled: flag(p.enabled, false),
    },
    showEquilibrium: flag(cfg.showEquilibrium, true),
    logScale: flag(cfg.logScale, false),
    acidConcentration: Math.max(1e-9, Math.min(20, number(cfg.acidConcentration, fallback.acidConcentration))),
    acidVolume: Math.max(1e-3, Math.min(1e4, number(cfg.acidVolume, fallback.acidVolume))),
    baseConcentration: Math.max(1e-9, Math.min(20, number(cfg.baseConcentration, fallback.baseConcentration))),
    ka: ka.length ? ka : fallback.ka,
    acidInFlask: flag(cfg.acidInFlask, true),
    titrantVolume: Math.max(1e-3, Math.min(1e4, number(cfg.titrantVolume, fallback.titrantVolume))),
    showEquivalence: flag(cfg.showEquivalence, true),
    showBuffer: flag(cfg.showBuffer, true),
    arrheniusFrom: Math.max(1, Math.min(5000, number(cfg.arrheniusFrom, fallback.arrheniusFrom))),
    arrheniusTo: Math.max(1, Math.min(5000, number(cfg.arrheniusTo, fallback.arrheniusTo))),
  };
}

const THERMO_VIEWS = new Set(['box', 'speeds', 'cycle', 'gaslaw']);
const PROCESS_KINDS = new Set(['isothermal', 'isobaric', 'isochoric', 'adiabatic']);

function sanitiseThermo(cfg: TabState['thermodynamics']): TabState['thermodynamics'] {
  const fallback = defaultThermo();
  const pick = <T extends string>(v: unknown, allowed: Set<string>, dflt: T): T =>
    allowed.has(text(v, '')) ? (v as T) : dflt;

  const boxWidth = Math.max(0.1, Math.min(20, number(cfg.boxWidth, fallback.boxWidth)));
  const boxHeight = Math.max(0.1, Math.min(20, number(cfg.boxHeight, fallback.boxHeight)));
  /* The radius has to leave room for the particles to exist: discs bigger than
   * the box are placed on top of each other and the collision resolver spends
   * every frame pushing an impossible arrangement apart, which reads as a gas
   * that explodes on load. It also sets the collision grid's cell size, so a
   * zero radius would ask for infinitely many cells. */
  const radius = Math.max(1e-4, Math.min(Math.min(boxWidth, boxHeight) / 4, number(cfg.radius, fallback.radius)));

  const rawCycle = Array.isArray(cfg.cycle) ? cfg.cycle : [];
  const cycle = rawCycle.slice(0, 12).map((raw) => {
    const l: Record<string, unknown> = isObject(raw) ? raw : {};
    return {
      id: text(l.id, uid('leg')),
      kind: pick(l.kind, PROCESS_KINDS, 'isothermal' as const),
      // Zero or negative targets are states the gas cannot be in; the tracer
      // reports them, but only if they arrive as finite numbers.
      target: Math.max(1e-6, number(l.target, 1)),
      label: text(l.label, ''),
    };
  });

  return {
    ...cfg,
    view: pick(cfg.view, THERMO_VIEWS, fallback.view),
    count: Math.max(1, Math.min(4000, Math.round(number(cfg.count, fallback.count)))),
    boxWidth,
    boxHeight,
    radius,
    particleMass: Math.max(1e-6, Math.min(1e4, number(cfg.particleMass, fallback.particleMass))),
    temperature: Math.max(1e-6, Math.min(1e5, number(cfg.temperature, fallback.temperature))),
    thermostat: Math.max(0, Math.min(100, number(cfg.thermostat, 0))),
    gravity: Math.max(-100, Math.min(100, number(cfg.gravity, 0))),
    seed: text(cfg.seed, fallback.seed),
    identicalSpeeds: flag(cfg.identicalSpeeds, false),
    pistonSpeed: Math.max(-2, Math.min(2, number(cfg.pistonSpeed, 0))),
    histogramBins: Math.max(4, Math.min(200, Math.round(number(cfg.histogramBins, fallback.histogramBins)))),
    showMaxwell: flag(cfg.showMaxwell, true),
    showTrails: flag(cfg.showTrails, false),
    colourBySpeed: flag(cfg.colourBySpeed, true),
    cycle: cycle.length ? cycle : fallback.cycle,
    startVolume: Math.max(1e-6, Math.min(1e6, number(cfg.startVolume, fallback.startVolume))),
    startTemperature: Math.max(1e-6, Math.min(1e6, number(cfg.startTemperature, fallback.startTemperature))),
    moles: Math.max(1e-6, Math.min(1e6, number(cfg.moles, fallback.moles))),
    // Two, three, five or six in practice; γ = (f+2)/f needs f > 0 whatever.
    degreesOfFreedom: Math.max(1, Math.min(12, Math.round(number(cfg.degreesOfFreedom, fallback.degreesOfFreedom)))),
    showCarnot: flag(cfg.showCarnot, true),
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
