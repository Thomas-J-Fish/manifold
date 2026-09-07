/* The document model.
 *
 * Everything a project file contains is described here, and only here. Two
 * rules keep the format durable: every field is a JSON primitive, array or
 * plain object (no Dates, no Maps, no class instances), and every mode's
 * settings live on every tab whether that mode is active or not. The second
 * rule costs a few hundred bytes per tab and buys the ability to switch a tab
 * from Statistics to Monte Carlo and back without losing what was set up in
 * either — which is what a workspace of scratch tabs actually gets used for.
 */

export const PROJECT_FORMAT = 'manifold-project';
export const PROJECT_VERSION = 1;

export type TabMode =
  | 'graphing'
  | 'statistics'
  | 'linear-algebra'
  | 'monte-carlo'
  | 'calculus'
  | 'dynamics'
  | 'fields'
  | 'fitting'
  | 'mechanics'
  | 'circuits'
  | 'quantum'
  | 'chemistry'
  | 'waves'
  | 'signals'
  | 'optimisation'
  | 'reactions'
  | 'thermodynamics'
  | 'geometry'
  | 'loan';

/* Subject areas, for the two-level pickers.
 *
 * Seventeen modes in one flat list is a wall rather than a menu: nobody reads
 * to the end of it, and the modes at the bottom may as well not exist. Two
 * levels means the first choice is between four things a scientist already has
 * a word for, and the second is a short list.
 *
 * The boundaries are conventions rather than facts — thermodynamics is taught
 * in both physics and chemistry departments, and Monte Carlo is as much a
 * computational method as a mathematical one. Where a mode could sit in two
 * places it is filed under the subject a user would look in *first*, and
 * moving one is a single edit to its entry below.
 */
export type ModeCategory = 'mathematics' | 'physics' | 'chemistry' | 'data' | 'finance';

export interface CategoryInfo {
  id: ModeCategory;
  name: string;
  blurb: string;
}

export const CATEGORIES: CategoryInfo[] = [
  {
    id: 'mathematics',
    name: 'Mathematics',
    blurb: 'Curves and constructions, algebra, calculus, probability and the behaviour of systems.',
  },
  {
    id: 'physics',
    name: 'Physics',
    blurb: 'Benches you build and run: bodies, circuits, waves and quantum states.',
  },
  {
    id: 'chemistry',
    name: 'Chemistry',
    blurb: 'The elements, reactions in time, and the gas laws from the particles up.',
  },
  {
    id: 'data',
    name: 'Data & Computation',
    blurb: 'Getting an answer out of measurements: fitting, signals and optimisation.',
  },
  {
    id: 'finance',
    name: 'Finance',
    blurb: 'Money over time: what a debt costs, and what changes it.',
  },
];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export interface ModeInfo {
  id: TabMode;
  category: ModeCategory;
  name: string;
  short: string;
  blurb: string;
  /** Whether the tab's main surface is the 2D plotter, a 3D scene, or its own. */
  surface: '2d' | '3d' | 'custom';
  supportsTimeline: boolean;
  /** What the clock is measured in. Seconds unless the physics says otherwise
   * — a wavepacket crosses a nanometre in about a femtosecond, and a timeline
   * reading "4.73 s" over a twenty-femtosecond run is not a rounding issue,
   * it is the wrong quantity. */
  timeUnit?: string;
}

export const MODES: ModeInfo[] = [
  {
    id: 'graphing',
    category: 'mathematics',
    name: 'Graphing',
    short: 'Graph',
    blurb: 'Functions, parametric and polar curves, implicit relations and inequalities.',
    surface: '2d',
    supportsTimeline: true,
  },
  {
    id: 'statistics',
    category: 'mathematics',
    name: 'Statistics & Probability',
    short: 'Stats',
    blurb: 'Distributions with interactive tails, critical values and hypothesis tests.',
    surface: '2d',
    supportsTimeline: false,
  },
  {
    id: 'linear-algebra',
    category: 'mathematics',
    name: 'Linear Algebra',
    short: 'Linear',
    blurb: 'Transformation sandbox, matrix calculator and 3D planes with exact intersections.',
    surface: 'custom',
    supportsTimeline: true,
  },
  {
    id: 'monte-carlo',
    category: 'mathematics',
    name: 'Monte Carlo & Simulation',
    short: 'Monte Carlo',
    blurb: 'Stochastic path simulation with fan charts, terminal distributions and risk measures.',
    surface: '2d',
    supportsTimeline: true,
  },
  {
    id: 'calculus',
    category: 'mathematics',
    name: 'Calculus & ODEs',
    short: 'Calculus',
    blurb: 'Derivatives, integrals, Riemann sums, Taylor series, slope fields and phase portraits.',
    surface: '2d',
    supportsTimeline: true,
  },
  {
    id: 'dynamics',
    category: 'mathematics',
    name: 'Dynamical Systems',
    short: 'Dynamics',
    blurb: 'Iterated maps, cobwebs, bifurcation diagrams and escape-time fractals.',
    surface: 'custom',
    supportsTimeline: true,
  },
  {
    id: 'fields',
    category: 'mathematics',
    name: 'Vector Fields & PDEs',
    short: 'Fields',
    blurb: 'Arrow grids, streamlines, particle advection and the heat and wave equations.',
    surface: '2d',
    supportsTimeline: true,
  },
  {
    id: 'fitting',
    category: 'data',
    name: 'Data & Regression',
    short: 'Data',
    blurb: 'Import data, fit linear, polynomial and nonlinear models, and read the diagnostics.',
    surface: '2d',
    supportsTimeline: false,
  },
  {
    id: 'mechanics',
    category: 'physics',
    name: 'Mechanics Sandbox',
    short: 'Mechanics',
    blurb: 'Build pendulums, springs, ramps and pulleys, then run them and measure what happens.',
    surface: 'custom',
    supportsTimeline: true,
  },
  {
    id: 'circuits',
    category: 'physics',
    name: 'Electronics Sandbox',
    short: 'Circuits',
    blurb: 'Wire up cells, resistors, capacitors and LEDs, then watch the currents and voltages.',
    surface: 'custom',
    supportsTimeline: true,
  },
  {
    id: 'quantum',
    category: 'physics',
    name: 'Quantum Mechanics',
    short: 'Quantum',
    blurb: 'Draw wells and barriers, find the bound states, launch a wavepacket and watch it tunnel.',
    surface: 'custom',
    supportsTimeline: true,
    timeUnit: 'fs',
  },
  {
    id: 'chemistry',
    category: 'chemistry',
    name: 'Periodic Table',
    short: 'Elements',
    blurb: 'The table by any property, with each element opened up into its shells and orbitals.',
    surface: 'custom',
    supportsTimeline: false,
  },
  {
    id: 'waves',
    category: 'physics',
    name: 'Waves & Optics',
    short: 'Waves',
    blurb: 'Waves on five media, diffraction through any aperture you draw, and rays through real lenses.',
    surface: 'custom',
    supportsTimeline: true,
  },
  {
    id: 'signals',
    category: 'data',
    name: 'Signal Processing',
    short: 'Signals',
    blurb: 'Spectra, spectrograms, filters with their poles and Bode plots, and aliasing you can hear coming.',
    surface: 'custom',
    supportsTimeline: false,
  },
  {
    id: 'optimisation',
    category: 'data',
    name: 'Optimisation',
    short: 'Optimise',
    blurb: 'Linear programs with the simplex path across the feasible region, gradient descent, and Lagrange multipliers drawn.',
    surface: 'custom',
    supportsTimeline: false,
  },
  {
    id: 'reactions',
    category: 'chemistry',
    name: 'Chemical Reactions',
    short: 'Kinetics',
    blurb: 'Reaction networks integrated as ODEs, equilibria you can perturb, titration curves and Arrhenius.',
    surface: 'custom',
    supportsTimeline: true,
  },
  {
    id: 'loan',
    category: 'finance',
    name: 'Loan Interest',
    short: 'Loan',
    blurb: 'A debt month by month: the balance, the interest each month, and what it all adds up to.',
    surface: '2d',
    supportsTimeline: false,
  },
  {
    id: 'geometry',
    category: 'mathematics',
    name: 'Geometry & Constructions',
    short: 'Geometry',
    blurb: 'Compass and straightedge, conics from focus and directrix, transformations, and figures that hold together when you drag them.',
    surface: '2d',
    supportsTimeline: false,
  },
  {
    id: 'thermodynamics',
    category: 'chemistry',
    name: 'Thermodynamics',
    short: 'Thermo',
    blurb: 'A box of particles you compress and heat, Maxwell–Boltzmann emerging from it, and PV cycles.',
    surface: 'custom',
    supportsTimeline: true,
  },
];

export const MODE_BY_ID = new Map(MODES.map((m) => [m.id, m]));

// ------------------------------------------------------------------ shared pieces

export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface Camera3D {
  /** Azimuth and elevation in radians, plus orbit distance. */
  theta: number;
  phi: number;
  distance: number;
  target: [number, number, number];
}

export type AnimationMode = 'loop' | 'pingpong' | 'once';

export interface Parameter {
  id: string;
  /** The variable name expressions refer to. */
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** When set, the parameter sweeps its range on the shared clock. */
  animated: boolean;
  /** Seconds for one full sweep. */
  period: number;
  animationMode: AnimationMode;
}

export type ExpressionKind =
  | 'function'
  | 'parametric'
  | 'polar'
  | 'implicit'
  | 'inequality'
  | 'points'
  | 'definition';

/* The variables each kind of expression has bound for it during evaluation.
 *
 * A polar curve accepts three spellings of one angle, because a student types
 * whichever their keyboard offers and all three mean the same thing. This list
 * is the single source of truth for two things that have to agree: what the
 * sampler writes the sample value into, and what the sidebar treats as already
 * defined. When those two disagree, an expression naming a variable that
 * nothing binds does not fail — it reads zero and draws a confident, wrong
 * picture, which is far worse than an error message.
 */
export const BOUND_VARIABLES: Record<ExpressionKind, readonly string[]> = {
  function: ['x'],
  parametric: ['t'],
  polar: ['θ', 'theta', 't'],
  implicit: ['x', 'y'],
  inequality: ['x', 'y'],
  points: [],
  definition: [],
};

export type LineStyle = 'solid' | 'dashed' | 'dotted';

export interface ExpressionItem {
  id: string;
  kind: ExpressionKind;
  /** The primary expression, or x(t) for parametric, or the definition text. */
  source: string;
  /** y(t) for parametric curves. */
  source2: string;
  /** Parameter range for parametric and polar curves. */
  tMin: number;
  tMax: number;
  colour: string;
  visible: boolean;
  width: number;
  style: LineStyle;
  /** Shade the region under a curve, or the satisfying region of an inequality. */
  fill: boolean;
  /** Overlay the numerical derivative. */
  showDerivative: boolean;
  /** Shade and report a definite integral. */
  showIntegral: boolean;
  integralFrom: number;
  integralTo: number;
  /** Mark roots, extrema and y-intercepts. */
  showFeatures: boolean;
  label: string;
}

export interface Timeline {
  t: number;
  tMin: number;
  tMax: number;
  playing: boolean;
  /** Playback rate multiplier. */
  speed: number;
  mode: AnimationMode;
}

// ------------------------------------------------------------------ per-mode settings

export type TailMode = 'none' | 'left' | 'right' | 'two' | 'between' | 'outside';

export interface StatisticsConfig {
  distributionId: string;
  params: Record<string, number>;
  /** Plot the density/mass, or the cumulative function. */
  view: 'pdf' | 'cdf';
  tail: TailMode;
  /** Boundaries for the shaded region, in the variable's own units. */
  lower: number;
  upper: number;
  /** Drive the shading from a probability instead of a cut-off. */
  driveBy: 'value' | 'probability';
  probability: number;
  /** Overlay a second distribution for comparison. */
  compareId: string | null;
  compareParams: Record<string, number>;
  /** Pasted or imported sample data. */
  dataA: number[];
  dataB: number[];
  dataLabelA: string;
  dataLabelB: string;
  showHistogram: boolean;
  showKde: boolean;
  binRule: 'auto' | 'sturges' | 'scott' | 'freedman' | 'sqrt' | 'fixed';
  binCount: number;
  testId: 'none' | 'oneSampleT' | 'twoSampleT' | 'pairedT' | 'zTest' | 'correlation' | 'normality';
  testMu0: number;
  testSigma: number;
  testTail: 'two' | 'left' | 'right';
  confidence: number;
  pooled: boolean;
}

export type LinAlgView = 'transform2d' | 'transform3d' | 'planes' | 'calculator';

export interface LinAlgConfig {
  view: LinAlgView;
  /** The 2×2 transformation being visualised. */
  matrix2: number[][];
  /** The 3×3 transformation for the 3D sandbox. */
  matrix3: number[][];
  /** How far along the identity → matrix interpolation the view is. */
  progress: number;
  showEigenvectors: boolean;
  showUnitSquare: boolean;
  showGrid: boolean;
  showDeterminant: boolean;
  /** Extra vectors the user has added to watch transform. */
  vectors: { id: string; v: number[]; colour: string; label: string }[];
  planes: { id: string; a: number; b: number; c: number; d: number; colour: string; visible: boolean }[];
  /** The matrix in the standalone calculator, which may be non-square. */
  calcMatrix: number[][];
  calcVector: number[];
  showRrefSteps: boolean;
}

export interface MonteCarloConfig {
  processId: string;
  params: Record<string, number>;
  steps: number;
  paths: number;
  seed: string;
  antithetic: boolean;
  /** How many individual paths to draw behind the bands. */
  visiblePaths: number;
  showBands: boolean;
  showMean: boolean;
  bandLevels: number[];
  logScale: boolean;
  barrier: number | null;
  /** Custom SDE expressions, used when processId is 'custom'. */
  customDrift: string;
  customDiffusion: string;
  customX0: number;
  customT: number;
  /** Secondary panel: terminal histogram, convergence, or π estimation. */
  panel: 'terminal' | 'convergence' | 'integration';
  integrationSamples: number;
  integrationRegion: string;
}

export type CalculusView = 'analysis' | 'riemann' | 'taylor' | 'slopefield' | 'phase';

export interface CalculusConfig {
  view: CalculusView;
  f: string;
  a: number;
  b: number;
  riemannN: number;
  riemannRule: 'left' | 'right' | 'midpoint' | 'trapezoid' | 'simpson';
  taylorCentre: number;
  taylorOrder: number;
  /** dy/dx = g(x, y) for the slope field. */
  slopeExpr: string;
  /** Initial conditions whose trajectories are drawn on the slope field. */
  slopeSeeds: { id: string; x: number; y: number; colour: string }[];
  /** A planar system x' = P(x,y), y' = Q(x,y). */
  systemP: string;
  systemQ: string;
  phaseSeeds: { id: string; x: number; y: number; colour: string }[];
  showNullclines: boolean;
  showEquilibria: boolean;
  solver: 'rk4' | 'dopri5';
  odeSteps: number;
  odeDuration: number;
}

export type DynamicsView = 'orbit' | 'bifurcation' | 'fractal';

export interface DynamicsConfig {
  view: DynamicsView;
  mapId: string;
  r: number;
  x0: number;
  cobwebSteps: number;
  transient: number;
  samples: number;
  bifurcationRMin: number;
  bifurcationRMax: number;
  showLyapunov: boolean;
  fractalKind: string;
  fractalCentreX: number;
  fractalCentreY: number;
  fractalScale: number;
  maxIterations: number;
  juliaRe: number;
  juliaIm: number;
  power: number;
  palette: string;
  colourPeriod: number;
  colourOffset: number;
  interior: 'black' | 'trap';
}

export type FieldsView = 'vector' | 'heat1d' | 'wave1d' | 'heat2d' | 'wave2d';

export interface FieldsConfig {
  view: FieldsView;
  p: string;
  q: string;
  display: 'arrows' | 'streamlines' | 'particles';
  arrowDensity: number;
  lengthMode: 'uniform' | 'scaled';
  streamlineCount: number;
  particleCount: number;
  particleSpeed: number;
  scalarOverlay: 'none' | 'magnitude' | 'divergence' | 'curl';
  /** PDE settings. */
  coefficient: number;
  nodes: number;
  pdeFrames: number;
  pdeDuration: number;
  boundary: 'dirichlet' | 'neumann' | 'periodic';
  initialCondition: string;
  initialVelocity: string;
}

export interface FittingConfig {
  /** Column-oriented data so a CSV maps onto it directly. */
  columns: string[];
  rows: (number | string)[][];
  xColumn: number;
  yColumn: number;
  model: 'linear' | 'polynomial' | 'nonlinear';
  degree: number;
  nonlinearId: string;
  showResiduals: boolean;
  showBand: boolean;
  confidence: number;
  pointSize: number;
  sourceName: string;
}

/* The two sandboxes keep their scene in the physics engines' own types rather
 * than mirroring them here. Those types are already plain JSON — numbers,
 * strings and arrays of them — which is the only thing this file actually
 * requires, and a parallel definition would be one more place for the two to
 * drift apart. */

export type MechanicsTool =
  | 'select'
  | 'mass'
  | 'anchor'
  | 'rod'
  | 'rope'
  | 'spring'
  | 'surface'
  | 'pulley';

export interface MechanicsConfig {
  world: import('./physics/mechanics').MechanicsWorld;
  measurements: import('./physics/mechanics').Measurement[];
  tool: MechanicsTool;
  selectedId: string | null;
  /** Grid spacing in metres; 0 places freely. */
  snap: number;
  showForces: boolean;
  showVelocities: boolean;
  showTrails: boolean;
  showEnergy: boolean;
  showEquations: boolean;
  /** Names, masses and friction coefficients written on the bench itself. */
  showValues: boolean;
  /** Plot measurements against time, or one against another. */
  plotMode: 'time' | 'phase';
  phaseX: string;
  phaseY: string;
}

export interface CircuitConfig {
  world: import('./physics/circuit').CircuitWorld;
  readings: import('./physics/circuit').Reading[];
  /** The palette item armed for placement, or 'select'. */
  tool: string;
  orientation: 'h' | 'v';
  selectedId: string | null;
  showCurrent: boolean;
  /** Which way the animated dots travel: with the conventional current, or
   * with the electrons, which drift the other way. */
  flowMode: 'conventional' | 'electron';
  showNodeVoltages: boolean;
  showValues: boolean;
  showEquations: boolean;
  /** Steady state, or the transient played against the clock. */
  analysis: 'dc' | 'transient';
}

export interface QuantumConfig {
  world: import('./physics/quantum').QuantumWorld;
  /** Which feature of the potential is selected for editing. */
  selectedId: string | null;
  /** What clicking the canvas adds. */
  tool: 'select' | import('./physics/quantum').FeatureKind;
  /** Which rung of the energy ladder is highlighted. */
  level: number;
  /** Draw |ψ|² rather than ψ. */
  probability: boolean;
  /** Offset each state to sit on its own energy, the way textbooks draw it. */
  stacked: boolean;
  showEquations: boolean;
  /** Vertical exaggeration of the wavefunctions against the energy axis. */
  scale: number;
}

export interface WavesConfig {
  world: import('./physics/waves').WaveWorld;
  /** Selected slit or optical surface. */
  selectedId: string | null;
  /** Draw the Fraunhofer formula over the computed pattern, where one applies. */
  showAnalytic: boolean;
  showEquations: boolean;
  /** Intensity on a log scale, so the faint outer fringes are visible. */
  logIntensity: boolean;
}

export interface SignalsConfig {
  view: 'spectrum' | 'spectrogram' | 'filter' | 'sampling';
  /** The signal, as an expression in t (seconds). */
  expression: string;
  sampleRate: number;
  duration: number;
  window: import('./math/fft').WindowName;
  /** Standard deviation of added noise, in the signal's own units. */
  noise: number;
  seed: string;
  /** Samples pasted in as numbers, used instead of the expression. */
  data: number[];
  useData: boolean;
  filter: import('./math/signal').FilterSpec;
  /** Run the signal through the filter before looking at it. */
  filtered: boolean;
  logFrequency: boolean;
  decibels: boolean;
  windowSize: number;
  /** The deliberate-undersampling demonstration. */
  toneFrequency: number;
  sampleFrequency: number;
}

export interface OptimisationConfig {
  view: 'linear' | 'descent' | 'lagrange';
  // ---- linear programming
  program: import('./math/optimise').LinearProgram;
  /** How far along the simplex path the picture has been stepped. */
  simplexStep: number;
  showRegion: boolean;
  /** Draw the objective's level line through the current corner. */
  showObjectiveLine: boolean;
  // ---- gradient descent
  surface: string;
  method: import('./math/optimise').DescentMethod;
  rate: number;
  momentum: number;
  descentSteps: number;
  startX: number;
  startY: number;
  showContours: boolean;
  contourCount: number;
  // ---- Lagrange
  objective: string;
  constraint: string;
  showGradients: boolean;
  showEquations: boolean;
}

/** What clicking on the canvas currently does. */
export type GeoTool =
  | 'select'
  | 'point'
  | 'pointOn'
  | 'intersection'
  | 'segment'
  | 'line'
  | 'ray'
  | 'circle'
  | 'midpoint'
  | 'bisector'
  | 'perpendicular'
  | 'parallel'
  | 'angleBisector'
  | 'polygon'
  | 'conic'
  | 'reflect'
  | 'rotate'
  | 'translate'
  | 'dilate';

export interface GeometryConfig {
  /** Which group of tools the panel offers. All three share one figure. */
  view: 'construct' | 'conics' | 'transform';
  objects: import('./math/geometry').GeoObject[];
  tool: GeoTool;
  /** Ids picked so far towards the armed tool's parents. */
  selection: string[];
  showLabels: boolean;
  /** Trace what one point sweeps out as another runs along its path. */
  showLocus: boolean;
  locusDriver: string | null;
  locusTracer: string | null;
  /** Degrees, for the rotation tool. */
  rotateAngle: number;
  /** Factor, for the dilation tool. */
  dilateFactor: number;
  /** Eccentricity given to the next conic. */
  eccentricity: number;
  /** Draw the axes, foci and asymptotes of any conic in the figure. */
  showConicDetail: boolean;
}

export interface LoanConfig {
  view: 'balance' | 'monthly' | 'cumulative' | 'schedule';
  world: import('./finance/loan').LoanWorld;
  /** Mark where a rate changes, and where the loan clears. */
  showRateChanges: boolean;
  showPayoff: boolean;
  /** A second payment level, drawn alongside, to price an overpayment. */
  compareEnabled: boolean;
  comparePayment: number;
  /** Currency prefix for the axis and the readouts. Cosmetic only. */
  currency: string;
}

export interface ReactionsConfig {
  view: 'kinetics' | 'equilibrium' | 'titration' | 'arrhenius';
  reactions: import('./chemistry/reactions').Reaction[];
  /** Starting concentration per species, by name. */
  initial: Record<string, number>;
  duration: number;
  samples: number;
  /** Rate constants from the Arrhenius equation rather than typed directly. */
  useArrhenius: boolean;
  temperature: number;
  perturbation: import('./chemistry/reactions').Perturbation;
  showEquilibrium: boolean;
  logScale: boolean;
  // ---- titration
  acidConcentration: number;
  acidVolume: number;
  baseConcentration: number;
  /** Successive Ka values, strongest first. */
  ka: number[];
  acidInFlask: boolean;
  titrantVolume: number;
  showEquivalence: boolean;
  showBuffer: boolean;
  // ---- Arrhenius
  arrheniusFrom: number;
  arrheniusTo: number;
}

export interface ThermoConfig {
  view: 'box' | 'speeds' | 'cycle' | 'gaslaw';
  count: number;
  boxWidth: number;
  boxHeight: number;
  radius: number;
  particleMass: number;
  temperature: number;
  /** Zero for a perfectly insulated box, which is what adiabatic needs. */
  thermostat: number;
  gravity: number;
  seed: string;
  /** Every particle at the same speed, so the distribution has to form. */
  identicalSpeeds: boolean;
  /** Rate the walls move, negative to compress. */
  pistonSpeed: number;
  histogramBins: number;
  showMaxwell: boolean;
  showTrails: boolean;
  colourBySpeed: boolean;
  // ---- PV cycle
  cycle: import('./physics/thermo').CycleLeg[];
  startVolume: number;
  startTemperature: number;
  moles: number;
  degreesOfFreedom: number;
  showCarnot: boolean;
}

export type ElementProperty =
  | 'category'
  | 'mass'
  | 'radius'
  | 'electronegativity'
  | 'ionisation'
  | 'affinity'
  | 'melting'
  | 'boiling'
  | 'density'
  | 'abundance'
  | 'discovered';

export interface ChemistryConfig {
  /** Atomic number of the element on show. */
  selected: number;
  colourBy: ElementProperty;
  plotProperty: ElementProperty;
  /** Bohr shells, or the probability cloud of the outermost subshell. */
  atomView: 'shells' | 'orbital';
  /** Which orbital the cloud shows, when it is not the outermost one. */
  orbital: string;
  showTrend: boolean;
  /** Electrons go round. Off for a still picture, and for a screenshot. */
  animate: boolean;
}

// ------------------------------------------------------------------ tab & project

export interface TabState {
  id: string;
  name: string;
  mode: TabMode;
  viewport: Viewport;
  camera: Camera3D;
  parameters: Parameter[];
  expressions: ExpressionItem[];
  timeline: Timeline;
  showGrid: boolean;
  showMinorGrid: boolean;
  showAxes: boolean;
  showCrosshair: boolean;
  /** Lock the y scale to the x scale so circles look circular. */
  squareAxes: boolean;
  statistics: StatisticsConfig;
  linalg: LinAlgConfig;
  monteCarlo: MonteCarloConfig;
  calculus: CalculusConfig;
  dynamics: DynamicsConfig;
  fields: FieldsConfig;
  fitting: FittingConfig;
  mechanics: MechanicsConfig;
  circuits: CircuitConfig;
  quantum: QuantumConfig;
  chemistry: ChemistryConfig;
  waves: WavesConfig;
  signals: SignalsConfig;
  optimisation: OptimisationConfig;
  reactions: ReactionsConfig;
  thermodynamics: ThermoConfig;
  geometry: GeometryConfig;
  loan: LoanConfig;
}

export interface ProjectMeta {
  title: string;
  createdAt: string;
  modifiedAt: string;
  /** Free-text notes the user can attach to the whole project. */
  notes: string;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  app: { name: string; version: string };
  meta: ProjectMeta;
  activeTabId: string;
  tabs: TabState[];
  ui: {
    sidebarWidth: number;
    sidebarCollapsed: boolean;
  };
}

/** The palette expressions cycle through as they are added. */
export const SERIES_COLOURS = [
  '#8b7cf6',
  '#38bdf8',
  '#34d399',
  '#fbbf24',
  '#fb7185',
  '#f472b6',
  '#22d3ee',
  '#a3e635',
];
