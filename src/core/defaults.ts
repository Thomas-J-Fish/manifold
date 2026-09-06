/* Factory functions for a fresh document.
 *
 * These are also the migration target: `serialize.ts` builds a default object
 * and merges a loaded file over it, so a project written by an older build
 * gains any field added since without special-case code per version.
 */

import { defaultValues as circuitDefaults } from './physics/circuit';
import type { CircuitElement, ElementKind as CircuitElementKind } from './physics/circuit';
import type { Body as MechBody, Link as MechLink } from './physics/mechanics';
import {
  type CalculusConfig,
  type ChemistryConfig,
  type CircuitConfig,
  type MechanicsConfig,
  type QuantumConfig,
  type SignalsConfig,
  type WavesConfig,
  type DynamicsConfig,
  type ExpressionItem,
  type ExpressionKind,
  type FieldsConfig,
  type FittingConfig,
  type LinAlgConfig,
  type MonteCarloConfig,
  type Parameter,
  type ProjectFile,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  type StatisticsConfig,
  type TabMode,
  type TabState,
  type Viewport,
  SERIES_COLOURS,
} from './types';

let counter = 0;
/** Monotonic, collision-free within a session and stable enough for React keys. */
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function defaultStatistics(): StatisticsConfig {
  return {
    distributionId: 'normal',
    params: { mu: 0, sigma: 1 },
    view: 'pdf',
    tail: 'two',
    lower: -1.959963984540054,
    upper: 1.959963984540054,
    driveBy: 'probability',
    probability: 0.05,
    compareId: null,
    compareParams: {},
    dataA: [],
    dataB: [],
    dataLabelA: 'Sample A',
    dataLabelB: 'Sample B',
    showHistogram: true,
    showKde: false,
    binRule: 'auto',
    binCount: 24,
    testId: 'none',
    testMu0: 0,
    testSigma: 1,
    testTail: 'two',
    confidence: 0.95,
    pooled: false,
  };
}

export function defaultLinAlg(): LinAlgConfig {
  return {
    view: 'transform2d',
    matrix2: [
      [1, 1],
      [0, 1],
    ],
    matrix3: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    progress: 1,
    showEigenvectors: true,
    showUnitSquare: true,
    showGrid: true,
    showDeterminant: true,
    vectors: [
      { id: uid('vec'), v: [1, 2], colour: SERIES_COLOURS[3], label: 'v' },
    ],
    planes: [
      { id: uid('pl'), a: 1, b: 1, c: 1, d: 1, colour: SERIES_COLOURS[0], visible: true },
      { id: uid('pl'), a: 2, b: -1, c: 1, d: 0, colour: SERIES_COLOURS[1], visible: true },
      { id: uid('pl'), a: 0, b: 1, c: -1, d: 2, colour: SERIES_COLOURS[2], visible: true },
    ],
    calcMatrix: [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ],
    calcVector: [8, -11, -3],
    showRrefSteps: false,
  };
}

export function defaultMonteCarlo(): MonteCarloConfig {
  return {
    processId: 'gbm',
    params: { s0: 100, mu: 0.08, sigma: 0.2, T: 1 },
    steps: 252,
    paths: 500,
    seed: 'manifold',
    antithetic: false,
    visiblePaths: 60,
    showBands: true,
    showMean: true,
    bandLevels: [0.05, 0.25, 0.75, 0.95],
    logScale: false,
    barrier: null,
    customDrift: '0.05*x',
    customDiffusion: '0.2*x',
    customX0: 100,
    customT: 1,
    panel: 'terminal',
    integrationSamples: 20000,
    integrationRegion: 'x^2 + y^2 <= 1',
  };
}

export function defaultCalculus(): CalculusConfig {
  return {
    view: 'analysis',
    f: 'sin(x) + x^2/8',
    a: -2,
    b: 3,
    riemannN: 12,
    riemannRule: 'midpoint',
    taylorCentre: 0,
    taylorOrder: 5,
    slopeExpr: 'x - y',
    slopeSeeds: [
      { id: uid('seed'), x: -3, y: 2, colour: SERIES_COLOURS[1] },
      { id: uid('seed'), x: 0, y: -2, colour: SERIES_COLOURS[2] },
      { id: uid('seed'), x: 2, y: 3, colour: SERIES_COLOURS[3] },
    ],
    systemP: 'y',
    systemQ: '-sin(x) - 0.2*y',
    phaseSeeds: [
      { id: uid('seed'), x: 2, y: 0, colour: SERIES_COLOURS[1] },
      { id: uid('seed'), x: -2.5, y: 1, colour: SERIES_COLOURS[2] },
      { id: uid('seed'), x: 0.5, y: 2.5, colour: SERIES_COLOURS[4] },
    ],
    showNullclines: true,
    showEquilibria: true,
    solver: 'dopri5',
    odeSteps: 2000,
    odeDuration: 20,
  };
}

export function defaultDynamics(): DynamicsConfig {
  return {
    view: 'bifurcation',
    mapId: 'logistic',
    r: 3.7,
    x0: 0.4,
    cobwebSteps: 60,
    transient: 400,
    samples: 220,
    bifurcationRMin: 2.4,
    bifurcationRMax: 4,
    showLyapunov: true,
    fractalKind: 'mandelbrot',
    fractalCentreX: -0.6,
    fractalCentreY: 0,
    fractalScale: 1.6,
    maxIterations: 320,
    juliaRe: -0.7269,
    juliaIm: 0.1889,
    power: 2,
    palette: 'ultra',
    colourPeriod: 48,
    colourOffset: 0,
    interior: 'black',
  };
}

export function defaultFields(): FieldsConfig {
  return {
    view: 'vector',
    p: '-y',
    q: 'x',
    display: 'arrows',
    arrowDensity: 22,
    lengthMode: 'uniform',
    streamlineCount: 60,
    particleCount: 900,
    particleSpeed: 1,
    scalarOverlay: 'none',
    coefficient: 0.4,
    nodes: 161,
    pdeFrames: 180,
    pdeDuration: 2,
    boundary: 'dirichlet',
    initialCondition: 'exp(-60*(x-0.35)^2)',
    initialVelocity: '0',
  };
}

/* A new Data tab opens with something in it.
 *
 * An empty scatter plot teaches nothing and gives the user nothing to press;
 * a small, obviously-synthetic dataset shows the fit, the band and the residual
 * panel all working, and is replaced the moment real data is pasted in. The
 * noise is deterministic so the tab looks identical every time it is opened. */
function sampleData(): (number | string)[][] {
  const rows: (number | string)[][] = [];
  for (let i = 0; i < 24; i++) {
    const x = i * 0.5;
    const jitter = Math.sin(i * 12.9898) * 43758.5453;
    const noise = (jitter - Math.floor(jitter) - 0.5) * 2.2;
    rows.push([Number(x.toFixed(3)), Number((2.4 * x + 3 + noise).toFixed(4))]);
  }
  return rows;
}

export function defaultFitting(): FittingConfig {
  return {
    columns: ['x', 'y'],
    rows: sampleData(),
    xColumn: 0,
    yColumn: 1,
    model: 'linear',
    degree: 2,
    nonlinearId: 'logistic',
    showResiduals: true,
    showBand: true,
    confidence: 0.95,
    pointSize: 3.5,
    sourceName: 'sample data — replace it above',
  };
}

/* A new sandbox tab arrives with an experiment already on the bench.
 *
 * The alternative — an empty grid and a palette — is the version of this
 * feature that gets opened once and closed again. A pendulum that is already
 * swinging, with its angle already being recorded and its period already
 * printed beside the plot, shows what the mode is for in the time it takes to
 * press play, and every piece of it can be dragged, retyped or deleted. */
export function defaultMechanics(): MechanicsConfig {
  const pivot: MechBody = {
    id: 'pivot',
    kind: 'anchor',
    x: 0,
    y: 2,
    vx: 0,
    vy: 0,
    mass: 0,
    radius: 0.09,
    label: 'Pivot',
    colour: '#94a3b8',
  };
  const angle = Math.PI / 4;
  const length = 2;
  const bob: MechBody = {
    id: 'bob',
    kind: 'mass',
    x: pivot.x + length * Math.sin(angle),
    y: pivot.y - length * Math.cos(angle),
    vx: 0,
    vy: 0,
    mass: 1,
    radius: 0.18,
    label: 'Bob',
    colour: SERIES_COLOURS[0],
  };
  const rod: MechLink = {
    id: 'rod',
    kind: 'rod',
    a: 'pivot',
    b: 'bob',
    length: null,
    stiffness: 200,
    damping: 0,
    label: 'Rod',
    colour: '#cbd5e1',
  };

  return {
    world: {
      gravity: 9.81,
      dragMode: 'none',
      dragCoefficient: 0.05,
      bodies: [pivot, bob],
      links: [rod],
      surfaces: [],
      pulleys: [],
    },
    measurements: [
      { id: 'm1', kind: 'angle', target: 'rod', colour: SERIES_COLOURS[0], visible: true },
      { id: 'm2', kind: 'speed', target: 'bob', colour: SERIES_COLOURS[1], visible: true },
    ],
    tool: 'select',
    selectedId: null,
    snap: 0.25,
    showForces: true,
    showVelocities: false,
    showTrails: true,
    showEnergy: true,
    showEquations: true,
    showValues: true,
    plotMode: 'time',
    phaseX: 'm1',
    phaseY: 'm2',
  };
}

export function defaultCircuits(): CircuitConfig {
  const part = (
    id: string,
    kind: CircuitElementKind,
    x: number,
    y: number,
    orientation: 'h' | 'v',
    label: string,
    values: Record<string, number> = {},
    reversed = false,
  ): CircuitElement => ({
    id,
    kind,
    x,
    y,
    orientation,
    reversed,
    values: { ...circuitDefaults(kind), ...values },
    label,
  });

  const wire = (n: number, x: number, y: number, orientation: 'h' | 'v') =>
    part(`w${n}`, 'wire', x, y, orientation, '');

  return {
    world: {
      // A cell, a switch, a resistor and a capacitor: one time constant of
      // 1 s, so the whole charging curve fits comfortably on the default
      // ten-second timeline and the switch gives something to press.
      // Components along the top, return rail underneath, earth hanging off
      // the middle of it — the way it would be drawn on paper.
      elements: [
        part('cell', 'cell', 0, 0, 'h', 'Cell', { emf: 6, internal: 0.5 }, true),
        part('sw', 'switch', 1, 0, 'h', 'Switch', { closed: 1 }),
        part('r1', 'resistor', 2, 0, 'h', 'R', { resistance: 1000 }),
        part('c1', 'capacitor', 3, 0, 'h', 'C', { capacitance: 1e-3, initial: 0 }),
        part('gnd', 'ground', 2, -1, 'v', ''),
        wire(1, 4, -1, 'v'),
        wire(2, 0, -1, 'h'),
        wire(3, 1, -1, 'h'),
        wire(4, 2, -1, 'h'),
        wire(5, 3, -1, 'h'),
        wire(6, 0, -1, 'v'),
      ],
      temperature: 25,
      timestep: 0,
    },
    readings: [
      { id: 'r1', kind: 'voltage', target: 'c1', colour: SERIES_COLOURS[0], visible: true },
      { id: 'r2', kind: 'current', target: 'r1', colour: SERIES_COLOURS[1], visible: true },
    ],
    tool: 'select',
    orientation: 'h',
    selectedId: null,
    showCurrent: true,
    flowMode: 'conventional',
    showNodeVoltages: true,
    showValues: true,
    showEquations: true,
    analysis: 'transient',
  };
}

export function makeParameter(name: string, value = 1): Parameter {
  return {
    id: uid('par'),
    name,
    value,
    min: -5,
    max: 5,
    step: 0.01,
    animated: false,
    period: 6,
    animationMode: 'loop',
  };
}

export function defaultQuantum(): QuantumConfig {
  return {
    world: {
      view: 'bound',
      // A well 1 nm across and 5 eV deep holds four states — enough for the
      // ladder to be a ladder, few enough to count off the screen.
      // Wide enough that a wavepacket has somewhere to start and somewhere to
      // arrive: a packet launched outside the box is not a wavepacket, it is a
      // sliver of one clipped by the wall.
      xMin: -6,
      xMax: 6,
      points: 600,
      mass: 1,
      features: [{ id: 'f1', kind: 'well', centre: 0, width: 1, height: 5 }],
      expression: '',
      levels: 6,
      packet: { centre: -4, width: 0.5, momentum: 10 },
      duration: 20,
      absorbing: true,
      scatterMin: 0.05,
      scatterMax: 8,
      plane: { shape: 'box', size: 1, depth: 200, aspect: 1, points: 90, levels: 6 },
    },
    selectedId: 'f1',
    tool: 'select',
    level: 0,
    probability: false,
    stacked: true,
    showEquations: true,
    scale: 1,
  };
}

export function defaultChemistry(): ChemistryConfig {
  return {
    // Carbon: four bonds, a familiar shell picture, and the middle of a period.
    selected: 6,
    colourBy: 'category',
    plotProperty: 'electronegativity',
    atomView: 'shells',
    orbital: '',
    showTrend: true,
    animate: true,
  };
}

export function defaultWaves(): WavesConfig {
  return {
    world: {
      view: 'propagate',
      medium: 'string',
      params: { tension: 40, density: 0.01 },
      length: 1,
      points: 700,
      left: 'fixed',
      right: 'fixed',
      junction: 0,
      speedRatio: 0.5,
      source: { kind: 'pulse', centre: 0.3, width: 0.03, frequency: 200, amplitude: 1 },
      duration: 0.08,
      // Green light, a pair of slits a fifth of a millimetre apart, a screen
      // two metres away: Young's experiment as it is actually done.
      wavelength: 550,
      slits: [
        { id: 'a', centre: -0.1, width: 0.04, transmission: 1, phase: 0 },
        { id: 'b', centre: 0.1, width: 0.04, transmission: 1, phase: 0 },
      ],
      screenDistance: 2,
      screenWidth: 0.03,
      sourceDistance: 0,
      // A biconvex lens of focal length 60 mm, ten millimetres thick.
      surfaces: [
        { id: 'front', z: 0, radius: 60, tilt: 0, aperture: 18, index: 1.5, mirror: false, label: 'Front' },
        { id: 'back', z: 10, radius: -60, tilt: 0, aperture: 18, index: 1, mirror: false, label: 'Back' },
      ],
      rayCount: 11,
      rayHeight: 14,
      objectDistance: 0,
      rayAngle: 0,
    },
    // Nothing selected, as every other sandbox opens: the default view is the
    // propagating one, which has no slit list on screen to select from.
    selectedId: null,
    showAnalytic: true,
    showEquations: true,
    logIntensity: false,
  };
}

export function defaultSignals(): SignalsConfig {
  return {
    view: 'spectrum',
    // Two tones an octave and a bit apart, so the spectrum has something to
    // separate and the waveform is not simply a sine.
    expression: 'sin(2*pi*50*t) + 0.5*sin(2*pi*120*t)',
    sampleRate: 1000,
    duration: 1,
    window: 'hann',
    noise: 0,
    seed: 'manifold',
    data: [],
    useData: false,
    filter: {
      family: 'butterworth',
      response: 'lowpass',
      order: 4,
      cutoff: 80,
      cutoffHigh: 300,
      sampleRate: 1000,
      ripple: 1,
      q: 8,
    },
    filtered: false,
    logFrequency: false,
    decibels: false,
    windowSize: 256,
    toneFrequency: 900,
    sampleFrequency: 1000,
  };
}

export function makeExpression(
  source = '',
  kind: ExpressionKind = 'function',
  index = 0,
): ExpressionItem {
  return {
    id: uid('exp'),
    kind,
    source,
    source2: '',
    tMin: 0,
    tMax: 2 * Math.PI,
    colour: SERIES_COLOURS[index % SERIES_COLOURS.length],
    visible: true,
    width: 2,
    style: 'solid',
    fill: false,
    showDerivative: false,
    showIntegral: false,
    integralFrom: -1,
    integralTo: 1,
    showFeatures: false,
    label: '',
  };
}

/* Each mode wants a different window on the world. A distribution lives in a
 * few standard deviations of x and a fraction of a unit of density; a vector
 * field wants square axes; a cobweb diagram wants the unit square. Starting
 * every tab at the graphing default meant a new Statistics tab opened with its
 * density squashed into a hairline at the origin. */
const VIEWPORT_BY_MODE: Record<TabMode, Viewport> = {
  graphing: { xMin: -10, xMax: 10, yMin: -6.25, yMax: 6.25 },
  statistics: { xMin: -4.2, xMax: 4.2, yMin: -0.045, yMax: 0.48 },
  'linear-algebra': { xMin: -5.6, xMax: 5.6, yMin: -3.5, yMax: 3.5 },
  'monte-carlo': { xMin: 0, xMax: 1, yMin: 0, yMax: 200 },
  calculus: { xMin: -7, xMax: 7, yMin: -4.4, yMax: 4.4 },
  dynamics: { xMin: -0.04, xMax: 1.04, yMin: -0.04, yMax: 1.04 },
  fields: { xMin: -4.4, xMax: 4.4, yMin: -2.75, yMax: 2.75 },
  fitting: { xMin: -1, xMax: 10, yMin: -1, yMax: 16 },
  // Metres for the bench, grid squares for the breadboard. Both want square
  // scales, and both are framed so the default scene sits comfortably inside
  // them without the user having to reach for the zoom first.
  // Both sandboxes lock their scales square once the plot has been measured,
  // so only the x range here really matters; y is a first guess that lasts one
  // frame.
  mechanics: { xMin: -2.6, xMax: 2.6, yMin: -1.9, yMax: 3.9 },
  circuits: { xMin: -0.9, xMax: 4.9, yMin: -2.4, yMax: 1.4 },
  // Nanometres across, electronvolts up: the axes of the potential itself.
  quantum: { xMin: -3.2, xMax: 3.2, yMin: -6, yMax: 4 },
  // The periodic table draws itself; this is only a first frame.
  chemistry: { xMin: 0, xMax: 19, yMin: -11, yMax: 1 },
  // The wave modes each reframe themselves when the view changes; these are
  // the first frame only.
  waves: { xMin: 0, xMax: 1, yMin: -1.6, yMax: 1.6 },
  signals: { xMin: 0, xMax: 1, yMin: -1.6, yMax: 1.6 },
};

export function defaultViewport(mode: TabMode): Viewport {
  return { ...VIEWPORT_BY_MODE[mode] };
}

/* How long the clock runs, for the modes whose own simulation fixes it.
 *
 * A wave on a string has crossed and come back in eighty milliseconds, and a
 * wavepacket is done in twenty femtoseconds. Left at the ten-second default,
 * the whole run happens inside the first one per cent of the scrubber's travel
 * and the remaining ninety-nine per cent holds the last frame — which looks
 * exactly like an animation that has frozen. Modes with no natural end (a
 * rotating vector field, a parameter sweep) keep the ten seconds. */
const TIMELINE_MAX_BY_MODE: Partial<Record<TabMode, number>> = {
  waves: defaultWaves().world.duration,
  quantum: defaultQuantum().world.duration,
};

export function makeTab(mode: TabMode = 'graphing', name?: string): TabState {
  const seedExpressions: ExpressionItem[] =
    mode === 'graphing'
      ? [makeExpression('a*sin(b*x)', 'function', 0), makeExpression('x^2/4 - 2', 'function', 1)]
      : [];
  const seedParameters: Parameter[] =
    mode === 'graphing'
      ? [
          { ...makeParameter('a', 2), min: -5, max: 5 },
          { ...makeParameter('b', 1), min: 0.1, max: 8 },
        ]
      : [];

  return {
    id: uid('tab'),
    name: name ?? defaultTabName(mode),
    mode,
    viewport: defaultViewport(mode),
    camera: { theta: 0.9, phi: 1.05, distance: 15, target: [0, 0, 0] },
    parameters: seedParameters,
    expressions: seedExpressions,
    timeline: { t: 0, tMin: 0, tMax: TIMELINE_MAX_BY_MODE[mode] ?? 10, playing: false, speed: 1, mode: 'loop' },
    showGrid: true,
    showMinorGrid: true,
    showAxes: true,
    showCrosshair: true,
    squareAxes: false,
    statistics: defaultStatistics(),
    linalg: defaultLinAlg(),
    monteCarlo: defaultMonteCarlo(),
    calculus: defaultCalculus(),
    dynamics: defaultDynamics(),
    fields: defaultFields(),
    fitting: defaultFitting(),
    mechanics: defaultMechanics(),
    circuits: defaultCircuits(),
    quantum: defaultQuantum(),
    chemistry: defaultChemistry(),
    waves: defaultWaves(),
    signals: defaultSignals(),
  };
}

const NAME_BY_MODE: Record<TabMode, string> = {
  graphing: 'Graph',
  statistics: 'Distribution',
  'linear-algebra': 'Transform',
  'monte-carlo': 'Simulation',
  calculus: 'Calculus',
  dynamics: 'Dynamics',
  fields: 'Field',
  fitting: 'Data',
  mechanics: 'Bench',
  circuits: 'Circuit',
  quantum: 'Well',
  chemistry: 'Elements',
  waves: 'Wave',
  signals: 'Signal',
};

export function defaultTabName(mode: TabMode): string {
  return NAME_BY_MODE[mode] ?? 'Tab';
}

export function makeProject(appVersion = '1.0.0'): ProjectFile {
  const tab = makeTab('graphing');
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app: { name: 'Manifold', version: appVersion },
    meta: { title: 'Untitled', createdAt: now, modifiedAt: now, notes: '' },
    activeTabId: tab.id,
    tabs: [tab],
    ui: { sidebarWidth: 348, sidebarCollapsed: false },
  };
}
