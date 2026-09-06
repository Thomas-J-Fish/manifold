/* Worked examples.
 *
 * Each one is a tab, fully configured, that demonstrates something the app can
 * do and that is worth looking at on its own terms. They exist because the
 * hardest part of a tool like this is not the first plot, it is knowing what
 * the tool is for; a Lorenz attractor and a bifurcation diagram answer that
 * faster than any amount of documentation.
 */

import { makeExpression, makeParameter, makeTab, uid } from './defaults';
import { defaultValues as circuitDefaults } from './physics/circuit';
import type { CircuitElement, ElementKind } from './physics/circuit';
import type { Body, Link, Measurement, Surface } from './physics/mechanics';
import { SERIES_COLOURS, type TabMode, type TabState } from './types';

export interface Example {
  id: string;
  /** Declared rather than inferred from `build()`, so the dialog can group the
   * list without constructing forty-five tabs to find out what they are. A
   * test checks the two agree. */
  mode: TabMode;
  title: string;
  blurb: string;
  build: () => TabState;
}

export const EXAMPLES: Example[] = [
  {
    id: 'lissajous',
    mode: 'graphing',
    title: 'Lissajous figures',
    blurb: 'A parametric curve whose shape is set by the ratio of two frequencies. Press play.',
    build: () => {
      const tab = makeTab('graphing', 'Lissajous');
      tab.expressions = [
        {
          ...makeExpression('sin(a*t + d)', 'parametric', 0),
          source2: 'sin(b*t)',
          tMin: 0,
          tMax: 2 * Math.PI,
          width: 2.2,
        },
      ];
      tab.parameters = [
        { ...makeParameter('a', 3), min: 1, max: 9, step: 1 },
        { ...makeParameter('b', 2), min: 1, max: 9, step: 1 },
        { ...makeParameter('d', 0), min: 0, max: Math.PI, step: 0.001, animated: true, period: 8 },
      ];
      tab.viewport = { xMin: -1.4, xMax: 1.4, yMin: -1.15, yMax: 1.15 };
      tab.squareAxes = true;
      tab.timeline = { ...tab.timeline, tMax: 8, playing: true };
      return tab;
    },
  },
  {
    id: 'fourier',
    mode: 'graphing',
    title: 'Fourier square wave',
    blurb: 'Partial sums of the odd-harmonic series, and the Gibbs overshoot that never goes away.',
    build: () => {
      const tab = makeTab('graphing', 'Fourier');
      tab.expressions = [
        {
          ...makeExpression(
            'sin(x) + sin(3x)/3 + sin(5x)/5 + sin(7x)/7 + sin(9x)/9 + sin(11x)/11 + sin(13x)/13',
            'function',
            0,
          ),
          width: 2.2,
          label: '7 harmonics',
        },
        {
          ...makeExpression('sin(x)', 'function', 1),
          style: 'dashed',
          width: 1.4,
          label: 'fundamental',
        },
        {
          ...makeExpression('pi/4 * sign(sin(x))', 'function', 2),
          style: 'dotted',
          width: 1.6,
          label: 'square wave',
        },
      ];
      tab.viewport = { xMin: -7, xMax: 7, yMin: -1.3, yMax: 1.3 };
      return tab;
    },
  },
  {
    id: 'cassini',
    mode: 'graphing',
    title: 'Curves that are not functions',
    blurb:
      'Two Cassini loops found by marching squares, an inequality shaded around them, and the foci marked. Push a past 1 and the loops join.',
    build: () => {
      const tab = makeTab('graphing', 'Implicit');
      tab.expressions = [
        {
          /* Cassini's definition: the product of the distances to two foci at
           * ±1 is constant, here a. Two separate loops while a < 1, joined
           * into a lemniscate at exactly a = 1, a dumbbell up to a = 2 and a
           * convex oval beyond — the whole family under one slider. */
          ...makeExpression('((x-1)^2 + y^2) * ((x+1)^2 + y^2) - a^2', 'implicit', 0),
          width: 2.4,
          label: 'Cassini oval',
        },
        {
          // Shading the *outside* leaves the ovals in clear space and still
          // shows what an inequality does: pick a side of a curve.
          ...makeExpression('x^2/4 + y^2 - 1', 'inequality', 1),
          fill: true,
          width: 1.4,
          label: 'outside the ellipse',
        },
        // Semicolons rather than newlines: the row is a single-line field, and
        // a newline in it displays as the two pairs run together.
        { ...makeExpression('-1, 0; 1, 0', 'points', 2), width: 3, label: 'foci' },
      ];
      tab.parameters = [{ ...makeParameter('a', 0.8), min: 0.2, max: 3, step: 0.001 }];
      tab.viewport = { xMin: -3, xMax: 3, yMin: -1.9, yMax: 1.9 };
      tab.squareAxes = true;
      return tab;
    },
  },
  {
    id: 'confidence',
    mode: 'statistics',
    title: 'Two-tailed critical values',
    blurb: 'The normal distribution with its 5% rejection region shaded, and the exact cut-offs.',
    build: () => {
      const tab = makeTab('statistics', 'Critical values');
      tab.statistics = {
        ...tab.statistics,
        distributionId: 'normal',
        params: { mu: 0, sigma: 1 },
        tail: 'two',
        driveBy: 'probability',
        probability: 0.05,
      };
      return tab;
    },
  },
  {
    id: 'two-sample-t',
    mode: 'statistics',
    title: 'Is the difference real?',
    blurb:
      'Two trays of plants, two fertilisers, and a Welch t-test on the yields. The means differ by 0.39; the test says how surprised to be.',
    build: () => {
      const tab = makeTab('statistics', 't-test');
      tab.statistics = {
        ...tab.statistics,
        // Small enough to read off the screen, spread wide enough that the
        // answer is not obvious by eye — which is the entire point of running
        // a test rather than looking at two bar charts.
        dataA: [5.1, 4.7, 5.4, 5.0, 4.6, 5.3, 4.9, 5.2, 4.8, 5.5, 4.4, 5.0, 5.1, 4.7],
        dataB: [5.4, 5.9, 4.8, 6.1, 5.0, 5.3, 5.7, 4.9, 5.6, 6.0, 4.7, 5.5, 5.1, 5.2],
        dataLabelA: 'Fertiliser A',
        dataLabelB: 'Fertiliser B',
        showHistogram: true,
        showKde: true,
        binRule: 'sturges',
        testId: 'twoSampleT',
        testTail: 'two',
        pooled: false,
        distributionId: 'normal',
        params: { mu: 5.2, sigma: 0.4 },
        tail: 'none',
      };
      // The data sits around 5, not around 0, so the default ±4 window would
      // open on an empty plot.
      tab.viewport = { xMin: 3.7, xMax: 6.7, yMin: -0.08, yMax: 1.35 };
      return tab;
    },
  },
  {
    id: 'binomial-normal',
    mode: 'statistics',
    title: 'Where the bell curve comes from',
    blurb:
      'Forty coin flips, biased. The binomial bars and the normal curve with the matching mean and variance, drawn on top of each other.',
    build: () => {
      const tab = makeTab('statistics', 'Binomial');
      const n = 40;
      const p = 0.35;
      tab.statistics = {
        ...tab.statistics,
        distributionId: 'binomial',
        params: { n, p },
        // np and np(1−p) exactly, so the overlay is the de Moivre–Laplace
        // approximation itself rather than a curve fitted to the bars.
        compareId: 'normal',
        compareParams: { mu: n * p, sigma: Math.sqrt(n * p * (1 - p)) },
        tail: 'right',
        driveBy: 'value',
        lower: 19,
        upper: 40,
      };
      // n p ± 4√(n p q) plus a little, so both tails of the bars are on screen.
      tab.viewport = { xMin: -1, xMax: 30, yMin: -0.012, yMax: 0.16 };
      return tab;
    },
  },
  {
    id: 'shear',
    mode: 'linear-algebra',
    title: 'A shear and its eigenvectors',
    blurb: 'Watch the unit square deform, and see which directions survive untilted.',
    build: () => {
      const tab = makeTab('linear-algebra', 'Shear');
      tab.linalg = {
        ...tab.linalg,
        view: 'transform2d',
        matrix2: [
          [1, 1],
          [0.5, 1.5],
        ],
        progress: 1,
        showEigenvectors: true,
      };
      tab.timeline = { ...tab.timeline, tMax: 6 };
      return tab;
    },
  },
  {
    id: 'planes',
    mode: 'linear-algebra',
    title: 'Three planes meeting in a point',
    blurb: 'Solve a 3×3 system by looking at it. Drag to orbit.',
    build: () => makeTab('linear-algebra', 'Planes'),
  },
  {
    id: 'rank-deficient',
    mode: 'linear-algebra',
    title: 'A matrix that loses a dimension',
    blurb:
      'Row reduction shown step by step on a singular 4×4. Rank 3, a one-dimensional null space, and a determinant of exactly zero.',
    build: () => {
      const tab = makeTab('linear-algebra', 'Rank');
      tab.linalg = {
        ...tab.linalg,
        view: 'calculator',
        // Row 4 = row 1 + row 2 + row 3, so the fourth pivot never appears and
        // elimination has to say so rather than divide by a rounding error.
        calcMatrix: [
          [2, -1, 3, 1],
          [1, 4, -2, 0],
          [3, 1, 1, 5],
          [6, 4, 2, 6],
        ],
        calcVector: [4, 3, 7, 14],
        showRrefSteps: true,
      };
      return tab;
    },
  },
  {
    id: 'gbm',
    mode: 'monte-carlo',
    title: 'Geometric Brownian motion',
    blurb: 'Five hundred price paths, a percentile fan, and the log-normal distribution they land in.',
    build: () => {
      const tab = makeTab('monte-carlo', 'Stock paths');
      tab.monteCarlo = {
        ...tab.monteCarlo,
        processId: 'gbm',
        params: { s0: 100, mu: 0.08, sigma: 0.25, T: 1 },
        paths: 800,
        steps: 252,
      };
      return tab;
    },
  },
  {
    id: 'heston',
    mode: 'monte-carlo',
    title: 'Stochastic volatility',
    blurb: 'The Heston model: volatility clusters, and the return distribution grows fat tails.',
    build: () => {
      const tab = makeTab('monte-carlo', 'Heston');
      tab.monteCarlo = {
        ...tab.monteCarlo,
        processId: 'heston',
        params: { s0: 100, v0: 0.04, mu: 0.05, kappa: 2, theta: 0.06, xi: 0.6, rho: -0.75, T: 2 },
        paths: 600,
        steps: 400,
      };
      return tab;
    },
  },
  {
    id: 'darts',
    mode: 'monte-carlo',
    title: 'Measuring an area by throwing darts',
    blurb:
      'In the panel under the paths: fifty thousand uniform points thrown at a square, and the fraction landing inside an astroid. The true area is 3π/8 = 1.1781.',
    build: () => {
      const tab = makeTab('monte-carlo', 'Astroid');
      tab.monteCarlo = {
        ...tab.monteCarlo,
        // A quiet top plot, because the darts underneath are the subject here.
        paths: 200,
        visiblePaths: 20,
        panel: 'integration',
        // A shape with no elementary "throw a dart at a circle" intuition, so
        // the estimate is genuinely doing work rather than confirming π.
        integrationRegion: 'abs(x)^(2/3) + abs(y)^(2/3) <= 1',
        integrationSamples: 50000,
        seed: 'astroid',
      };
      return tab;
    },
  },
  {
    id: 'riemann',
    mode: 'calculus',
    title: 'Riemann sums converging',
    blurb: 'Drag the rectangle count and watch the error fall. Midpoint beats left by a lot.',
    build: () => {
      const tab = makeTab('calculus', 'Riemann');
      tab.calculus = { ...tab.calculus, view: 'riemann', f: 'x^2*sin(x) + 3', a: 0, b: 6, riemannN: 8 };
      tab.viewport = { xMin: -1, xMax: 7, yMin: -12, yMax: 24 };
      return tab;
    },
  },
  {
    id: 'lotka',
    mode: 'calculus',
    title: 'Predator and prey',
    blurb: 'The Lotka–Volterra system in the phase plane: closed orbits around a centre.',
    build: () => {
      const tab = makeTab('calculus', 'Predator–prey');
      tab.calculus = {
        ...tab.calculus,
        view: 'phase',
        systemP: 'a*x - b*x*y',
        systemQ: 'c*x*y - d*y',
        odeDuration: 40,
        phaseSeeds: [
          { id: 'seed1', x: 1, y: 1, colour: '#38bdf8' },
          { id: 'seed2', x: 2, y: 1.5, colour: '#34d399' },
          { id: 'seed3', x: 3, y: 2, colour: '#fbbf24' },
        ],
      };
      tab.parameters = [
        { ...makeParameter('a', 1.1), min: 0.1, max: 3 },
        { ...makeParameter('b', 0.4), min: 0.05, max: 2 },
        { ...makeParameter('c', 0.1), min: 0.02, max: 1 },
        { ...makeParameter('d', 0.4), min: 0.05, max: 2 },
      ];
      tab.viewport = { xMin: 0, xMax: 8, yMin: 0, yMax: 6 };
      return tab;
    },
  },
  {
    id: 'lorenz',
    mode: 'calculus',
    title: 'The damped pendulum',
    blurb: 'A phase portrait with equilibria and nullclines: every trajectory spirals into rest.',
    build: () => {
      const tab = makeTab('calculus', 'Pendulum');
      tab.calculus = {
        ...tab.calculus,
        view: 'phase',
        systemP: 'y',
        systemQ: '-sin(x) - 0.25*y',
        odeDuration: 30,
      };
      tab.viewport = { xMin: -8, xMax: 8, yMin: -4, yMax: 4 };
      return tab;
    },
  },
  {
    id: 'bifurcation',
    mode: 'dynamics',
    title: 'Route to chaos',
    blurb: 'The logistic map’s period-doubling cascade, with the Lyapunov exponent underneath.',
    build: () => makeTab('dynamics', 'Bifurcation'),
  },
  {
    id: 'mandelbrot',
    mode: 'dynamics',
    title: 'The Mandelbrot set',
    blurb: 'Smooth-coloured escape times. Scroll to zoom — it keeps going.',
    build: () => {
      const tab = makeTab('dynamics', 'Mandelbrot');
      tab.dynamics = { ...tab.dynamics, view: 'fractal', fractalKind: 'mandelbrot' };
      return tab;
    },
  },
  {
    id: 'julia',
    mode: 'dynamics',
    title: 'A Julia set on the boundary',
    blurb:
      'The same iteration as the Mandelbrot set, with c held fixed instead of the starting point. This c sits on the edge, where the set is a dendrite.',
    build: () => {
      const tab = makeTab('dynamics', 'Julia');
      tab.dynamics = {
        ...tab.dynamics,
        view: 'fractal',
        fractalKind: 'julia',
        // Misiurewicz point −0.1011 + 0.9563i: strictly preperiodic, so the
        // filled set has empty interior and the picture is all boundary.
        juliaRe: -0.1011,
        juliaIm: 0.9563,
        fractalCentreX: 0,
        fractalCentreY: 0,
        fractalScale: 1.6,
        maxIterations: 400,
        colourPeriod: 24,
      };
      return tab;
    },
  },
  {
    id: 'dipole',
    mode: 'fields',
    title: 'A vector field with a source and a sink',
    blurb: 'Streamlines and particle advection over a field you can edit.',
    build: () => {
      const tab = makeTab('fields', 'Dipole');
      tab.fields = {
        ...tab.fields,
        p: '(x-1)/((x-1)^2 + y^2)^1.5 - (x+1)/((x+1)^2 + y^2)^1.5',
        q: 'y/((x-1)^2 + y^2)^1.5 - y/((x+1)^2 + y^2)^1.5',
        display: 'particles',
        scalarOverlay: 'magnitude',
      };
      tab.viewport = { xMin: -3, xMax: 3, yMin: -1.9, yMax: 1.9 };
      tab.timeline = { ...tab.timeline, playing: true, tMax: 30 };
      return tab;
    },
  },
  {
    id: 'wave',
    mode: 'fields',
    title: 'A plucked string',
    blurb: 'The wave equation solved by finite differences, played back over time.',
    build: () => {
      const tab = makeTab('fields', 'Wave');
      tab.fields = {
        ...tab.fields,
        view: 'wave1d',
        coefficient: 1,
        initialCondition: 'exp(-140*(x-0.35)^2)',
        pdeDuration: 3,
      };
      tab.timeline = { ...tab.timeline, playing: true, tMax: 3 };
      return tab;
    },
  },
  {
    id: 'heat-bar',
    mode: 'fields',
    title: 'Heat leaking out of a bar',
    blurb:
      'Two hot spots diffusing into each other with the ends insulated, so nothing escapes. The bar ends up flat at 0.142 — the average of where it started, to three figures.',
    build: () => {
      const tab = makeTab('fields', 'Heat');
      tab.fields = {
        ...tab.fields,
        view: 'heat1d',
        coefficient: 0.02,
        // Neumann ends conserve the integral exactly, so the final temperature
        // is the mean of the initial one — a number you can check by eye.
        boundary: 'neumann',
        initialCondition: 'exp(-400*(x-0.25)^2) + 0.6*exp(-400*(x-0.7)^2)',
        pdeDuration: 4,
        pdeFrames: 200,
      };
      tab.viewport = { xMin: -0.05, xMax: 1.05, yMin: -0.15, yMax: 1.2 };
      tab.timeline = { ...tab.timeline, playing: true, tMax: 4 };
      return tab;
    },
  },
  {
    id: 'regression',
    mode: 'fitting',
    title: 'Fitting a logistic curve',
    blurb: 'Noisy adoption data, a nonlinear fit by Levenberg–Marquardt, and its residuals.',
    build: () => {
      const tab = makeTab('fitting', 'Logistic fit');
      const rows: (number | string)[][] = [];
      // A deterministic pseudo-noise so the example is identical every time it
      // is opened — an example that looks different on each load is confusing.
      for (let i = 0; i < 40; i++) {
        const x = i * 0.35;
        const truth = 14 / (1 + Math.exp(-0.9 * (x - 6.5)));
        const noise = Math.sin(i * 12.9898) * 43758.5453;
        rows.push([Number(x.toFixed(3)), Number((truth + (noise - Math.floor(noise) - 0.5) * 1.6).toFixed(4))]);
      }
      tab.fitting = {
        ...tab.fitting,
        columns: ['x', 'y'],
        rows,
        xColumn: 0,
        yColumn: 1,
        model: 'nonlinear',
        nonlinearId: 'logistic',
        sourceName: 'example data',
      };
      return tab;
    },
  },
  {
    id: 'michaelis',
    mode: 'fitting',
    title: 'Enzyme kinetics',
    blurb:
      'Reaction rate against substrate concentration. Levenberg–Marquardt recovers Vmax = 2.35 and Km = 0.77 from data generated at 2.4 and 0.8, and leaves residuals with no structure in them.',
    build: () => {
      const tab = makeTab('fitting', 'Kinetics');
      const rows: (number | string)[][] = [];
      const vmax = 2.4;
      const km = 0.8;
      // Concentrations spaced geometrically, as an assay actually runs them:
      // most of the information about Km is at the low end.
      for (let i = 0; i < 22; i++) {
        const s = 0.06 * Math.pow(1.3, i);
        const v = (vmax * s) / (km + s);
        rows.push([Number(s.toFixed(4)), Number((v + wobble(i, 3) * 0.16).toFixed(4))]);
      }
      tab.fitting = {
        ...tab.fitting,
        columns: ['[S] / mM', 'v / µM s⁻¹'],
        rows,
        xColumn: 0,
        yColumn: 1,
        model: 'nonlinear',
        nonlinearId: 'michaelis',
        showResiduals: true,
        sourceName: 'assay',
      };
      return tab;
    },
  },
  {
    id: 'cubic-calibration',
    mode: 'fitting',
    title: 'Choosing the right degree',
    blurb:
      'A cubic through a sensor calibration, with the 95% band and the residuals below. Drop to degree 1 and the residuals grow a visible arch.',
    build: () => {
      const tab = makeTab('fitting', 'Calibration');
      const rows: (number | string)[][] = [];
      for (let i = 0; i < 34; i++) {
        const x = -3 + i * 0.2;
        const truth = 0.42 * x ** 3 - 1.1 * x ** 2 - 2 * x + 9;
        rows.push([Number(x.toFixed(3)), Number((truth + wobble(i, 7) * 1.9).toFixed(4))]);
      }
      tab.fitting = {
        ...tab.fitting,
        columns: ['reading', 'true value'],
        rows,
        xColumn: 0,
        yColumn: 1,
        model: 'polynomial',
        degree: 3,
        showResiduals: true,
        showBand: true,
        confidence: 0.95,
        sourceName: 'calibration run',
      };
      return tab;
    },
  },

  // ---------------------------------------------------------------- mechanics

  {
    id: 'double-pendulum',
    mode: 'mechanics',
    title: 'Double pendulum',
    blurb: 'Two rods, no closed-form solution, and a trail that never repeats. Press play.',
    build: () => {
      const tab = makeTab('mechanics', 'Double pendulum');
      /* Released with both rods near horizontal, which is the high-energy
       * regime where the motion is unmistakably chaotic. Hung at a modest
       * angle the same pendulum is only weakly so — the trajectories still
       * separate, but slowly enough that the example looks merely wobbly
       * rather than making its point. */
      const bodies: Body[] = [
        mechAnchor('pivot', 0, 2.2, 'Pivot'),
        mass('m1', 1.4, 2.2, 1, 'Upper', 0),
        mass('m2', 2.6, 2.35, 1.2, 'Lower', 1),
      ];
      tab.mechanics = {
        ...tab.mechanics,
        world: { ...tab.mechanics.world, bodies, links: [rod('r1', 'pivot', 'm1', 'Upper rod'), rod('r2', 'm1', 'm2', 'Lower rod')], surfaces: [], pulleys: [] },
        measurements: [
          probe('p1', 'angle', 'r1', 0),
          probe('p2', 'angle', 'r2', 1),
          probe('p3', 'total', '', 2),
        ],
        showTrails: true,
        showForces: false,
      };
      tab.viewport = { xMin: -3.6, xMax: 3.6, yMin: -3.4, yMax: 3.4 };
      tab.timeline = { ...tab.timeline, tMax: 30, playing: true };
      return tab;
    },
  },
  {
    id: 'block-on-a-slope',
    mode: 'mechanics',
    title: 'Block on a slope',
    blurb: 'Raise μ past tan α and the block stops sliding. The panel says exactly where that is.',
    build: () => {
      const tab = makeTab('mechanics', 'Slope');
      const ramp: Surface = {
        id: 'ramp',
        // Long enough that the block is still on it when the timeline ends.
        x0: -4.6,
        y0: 3.1,
        x1: 4.6,
        y1: -0.9,
        muK: 0.25,
        muS: 0.3,
        restitution: 0,
        flip: false,
        label: 'Ramp',
        colour: '#94a3b8',
      };
      /* One radius clear of the surface along its *upward* normal.
       *
       * The sign matters and is easy to get backwards: the engine takes the
       * left normal (−dy, dx) and flips it so it points up. Using the other
       * one puts the block underneath the ramp, where it spends the first
       * step being shoved out — which shows up as a spike on the normal-force
       * trace and an energy jump at t = 0. */
      const dx = ramp.x1 - ramp.x0;
      const dy = ramp.y1 - ramp.y0;
      const len = Math.hypot(dx, dy);
      let nx = -dy / len;
      let ny = dx / len;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      const t = 0.08;
      const block = mass('block', ramp.x0 + dx * t + nx * 0.2, ramp.y0 + dy * t + ny * 0.2, 2, 'Block', 0);
      block.radius = 0.2;
      tab.mechanics = {
        ...tab.mechanics,
        world: { ...tab.mechanics.world, bodies: [block], links: [], surfaces: [ramp], pulleys: [] },
        measurements: [probe('p1', 'speed', 'block', 0), probe('p2', 'normal', 'block', 1), probe('p3', 'friction', 'block', 2)],
        showForces: true,
      };
      tab.viewport = { xMin: -5.4, xMax: 5.4, yMin: -2.6, yMax: 4 };
      tab.timeline = { ...tab.timeline, tMax: 3.2, playing: true };
      return tab;
    },
  },
  {
    id: 'damped-spring',
    mode: 'mechanics',
    title: 'Damped mass on a spring',
    blurb: 'The analytic solution drawn over the simulation. Raise the damping to critical and the wobble vanishes.',
    build: () => {
      const tab = makeTab('mechanics', 'Spring');
      const anchor = mechAnchor('top', 0, 3, 'Support');
      const bob = mass('bob', 0, 0.6, 1.2, 'Mass', 0);
      const spring: Link = {
        id: 'spring',
        kind: 'spring',
        a: 'top',
        b: 'bob',
        length: 1.4,
        stiffness: 70,
        damping: 1.2,
        label: 'Spring',
        colour: '#38bdf8',
      };
      tab.mechanics = {
        ...tab.mechanics,
        world: { ...tab.mechanics.world, bodies: [anchor, bob], links: [spring], surfaces: [], pulleys: [] },
        measurements: [probe('p1', 'y', 'bob', 0), probe('p2', 'force', 'spring', 1)],
        showForces: true,
      };
      tab.viewport = { xMin: -2.4, xMax: 2.4, yMin: -1.2, yMax: 3.6 };
      tab.timeline = { ...tab.timeline, tMax: 12, playing: true };
      return tab;
    },
  },
  {
    id: 'atwood',
    mode: 'mechanics',
    title: 'Atwood machine',
    blurb: 'Two masses over a peg. Change either mass and watch a = g(m₁−m₂)/(m₁+m₂) hold.',
    build: () => {
      const tab = makeTab('mechanics', 'Atwood');
      /* Both hanging directly below the peg, which is what makes this an
       * Atwood machine rather than a rope over a nail — and far enough below
       * it that the rising mass does not reach the peg before the timeline
       * ends. At a = 1.96 m/s² the light one climbs 2.2 m in the 1.5 s the
       * clock runs, so 3 m of clearance is comfortable. */
      const heavy = mass('heavy', -0.32, -1.2, 3, 'Heavy', 0);
      const light = mass('light', 0.32, -3.2, 2, 'Light', 1);
      tab.mechanics = {
        ...tab.mechanics,
        world: {
          ...tab.mechanics.world,
          bodies: [heavy, light],
          links: [],
          surfaces: [],
          pulleys: [
            {
              id: 'peg',
              x: 0,
              y: 2.4,
              a: 'heavy',
              b: 'light',
              length: null,
              radius: 0.24,
              label: 'Pulley',
              colour: '#94a3b8',
            },
          ],
        },
        measurements: [probe('p1', 'vy', 'heavy', 0), probe('p2', 'force', 'peg', 1)],
        showForces: true,
        showTrails: false,
      };
      tab.viewport = { xMin: -3.2, xMax: 3.2, yMin: -4.4, yMax: 3.2 };
      tab.timeline = { ...tab.timeline, tMax: 1.5, playing: true };
      return tab;
    },
  },
  {
    id: 'bouncing-ball',
    mode: 'mechanics',
    title: 'Bouncing ball',
    blurb: 'Each bounce returns to e² of the last height. Set e to 1 and it never settles.',
    build: () => {
      const tab = makeTab('mechanics', 'Bounce');
      const ball = mass('ball', -2, 3, 0.5, 'Ball', 0);
      ball.vx = 1.6;
      ball.radius = 0.16;
      const floor: Surface = {
        id: 'floor',
        x0: -4,
        y0: 0,
        x1: 6,
        y1: 0,
        muK: 0.08,
        muS: 0.1,
        restitution: 0.75,
        flip: false,
        label: 'Floor',
        colour: '#94a3b8',
      };
      tab.mechanics = {
        ...tab.mechanics,
        world: { ...tab.mechanics.world, bodies: [ball], links: [], surfaces: [floor], pulleys: [] },
        measurements: [probe('p1', 'y', 'ball', 0), probe('p2', 'total', '', 1)],
        showTrails: true,
        showForces: false,
      };
      tab.viewport = { xMin: -4.2, xMax: 6.2, yMin: -1, yMax: 4 };
      tab.timeline = { ...tab.timeline, tMax: 10, playing: true };
      return tab;
    },
  },

  // ---------------------------------------------------------------- circuits

  {
    id: 'rc-charging',
    mode: 'circuits',
    title: 'RC charging curve',
    blurb: 'The exponential every course starts with, drawn beside the formula that predicts it.',
    build: () => {
      const tab = makeTab('circuits', 'RC');
      tab.circuits = {
        ...tab.circuits,
        world: {
          ...tab.circuits.world,
          elements: [
            part('cell', 'cell', 0, 0, 'h', 'Cell', { emf: 9, internal: 0.1 }, true),
            part('r', 'resistor', 2, 0, 'h', 'R', { resistance: 4700 }),
            part('c', 'capacitor', 3, 0, 'h', 'C', { capacitance: 100e-6, initial: 0 }),
            part('sw', 'switch', 1, 0, 'h', 'Switch', { closed: 1 }),
            part('gnd', 'ground', 2, -1, 'v', ''),
            ...rail(4, -1),
          ],
        },
        readings: [reading('a', 'voltage', 'c', 0), reading('b', 'current', 'r', 1)],
        analysis: 'transient',
      };
      tab.viewport = { xMin: -0.9, xMax: 4.9, yMin: -2.4, yMax: 1.4 };
      tab.timeline = { ...tab.timeline, tMax: 3, playing: true };
      return tab;
    },
  },
  {
    id: 'rlc-ringing',
    mode: 'circuits',
    title: 'RLC ringing',
    blurb: 'An underdamped loop. Raise R past the critical value in the panel and the oscillation dies.',
    build: () => {
      const tab = makeTab('circuits', 'RLC');
      tab.circuits = {
        ...tab.circuits,
        world: {
          ...tab.circuits.world,
          elements: [
            part('cell', 'cell', 0, 0, 'h', 'Cell', { emf: 5, internal: 0.1 }, true),
            part('r', 'resistor', 1, 0, 'h', 'R', { resistance: 30 }),
            part('l', 'inductor', 2, 0, 'h', 'L', { inductance: 0.05, initial: 0 }),
            part('c', 'capacitor', 3, 0, 'h', 'C', { capacitance: 2e-6, initial: 0 }),
            part('gnd', 'ground', 2, -1, 'v', ''),
            ...rail(4, -1),
          ],
        },
        readings: [reading('a', 'voltage', 'c', 0), reading('b', 'current', 'l', 1)],
        analysis: 'transient',
      };
      tab.viewport = { xMin: -0.9, xMax: 4.9, yMin: -2.4, yMax: 1.4 };
      tab.timeline = { ...tab.timeline, tMax: 0.01, playing: true };
      return tab;
    },
  },
  {
    id: 'led-resistor',
    mode: 'circuits',
    title: 'LED and series resistor',
    blurb: 'The exponential diode model, solved properly. Shrink the resistor and watch it brighten.',
    build: () => {
      const tab = makeTab('circuits', 'LED');
      tab.circuits = {
        ...tab.circuits,
        world: {
          ...tab.circuits.world,
          elements: [
            part('cell', 'cell', 0, 0, 'h', 'Cell', { emf: 5, internal: 0.05 }, true),
            part('r', 'resistor', 1, 0, 'h', 'R', { resistance: 220 }),
            part('led', 'led', 3, 0, 'h', 'LED', { forward: 2, ideality: 2, rating: 0.02 }),
            part('meter', 'ammeter', 2, 0, 'h', 'Ammeter'),
            part('gnd', 'ground', 2, -1, 'v', ''),
            ...rail(4, -1),
          ],
        },
        readings: [reading('a', 'current', 'led', 0), reading('b', 'voltage', 'led', 1)],
        analysis: 'dc',
      };
      tab.viewport = { xMin: -0.9, xMax: 4.9, yMin: -2.4, yMax: 1.4 };
      return tab;
    },
  },
  {
    id: 'potential-divider',
    mode: 'circuits',
    title: 'Potential divider with a thermistor',
    blurb: 'Drag the temperature and watch the output voltage swing — the basis of every simple sensor circuit.',
    build: () => {
      const tab = makeTab('circuits', 'Divider');
      tab.circuits = {
        ...tab.circuits,
        world: {
          ...tab.circuits.world,
          temperature: 25,
          elements: [
            part('cell', 'cell', 0, 0, 'h', 'Supply', { emf: 5, internal: 0.05 }, true),
            part('th', 'thermistor', 1, 0, 'h', 'Thermistor', { r25: 10000, beta: 3950 }),
            part('r', 'resistor', 2, 0, 'h', 'R', { resistance: 10000 }),
            part('vm', 'voltmeter', 2, 1, 'h', 'Voltmeter', { resistance: 1e7 }),
            part('gnd', 'ground', 2, -1, 'v', ''),
            ...rail(3, -1),
            part('w7', 'wire', 2, 0, 'v', ''),
            part('w8', 'wire', 3, 0, 'v', ''),
          ],
        },
        readings: [reading('a', 'voltage', 'vm', 0), reading('b', 'resistance', 'th', 1)],
        analysis: 'dc',
      };
      tab.viewport = { xMin: -0.9, xMax: 4.4, yMin: -2.4, yMax: 2 };
      return tab;
    },
  },
  {
    id: 'double-well',
    mode: 'quantum',
    title: 'A double well, and the states that straddle it',
    blurb:
      'Two wells side by side. Each level of a single well splits into a symmetric and an antisymmetric pair — the whole of chemical bonding, in one picture.',
    build: () => {
      const tab = makeTab('quantum', 'Double well');
      tab.quantum = {
        ...tab.quantum,
        world: {
          ...tab.quantum.world,
          view: 'bound',
          xMin: -4,
          xMax: 4,
          points: 700,
          levels: 6,
          features: [
            { id: 'l', kind: 'well', centre: -0.7, width: 0.8, height: 6 },
            { id: 'r', kind: 'well', centre: 0.7, width: 0.8, height: 6 },
          ],
        },
        selectedId: 'l',
        level: 0,
      };
      tab.viewport = { xMin: -4, xMax: 4, yMin: -7, yMax: 3 };
      return tab;
    },
  },
  {
    id: 'tunnelling',
    mode: 'quantum',
    title: 'Tunnelling through a barrier',
    blurb:
      'A wavepacket with less energy than the barrier in front of it. Most of it comes back; some of it does not. Press play.',
    build: () => {
      const tab = makeTab('quantum', 'Tunnelling');
      tab.quantum = {
        ...tab.quantum,
        world: {
          ...tab.quantum.world,
          view: 'evolve',
          xMin: -12,
          xMax: 12,
          points: 900,
          features: [{ id: 'b', kind: 'barrier', centre: 0, width: 0.35, height: 5 }],
          packet: { centre: -5, width: 1, momentum: 10 },
          duration: 16,
          absorbing: true,
        },
        selectedId: 'b',
      };
      tab.timeline = { ...tab.timeline, tMax: 16, playing: true };
      return tab;
    },
  },
  {
    id: 'quantum-harmonic',
    mode: 'quantum',
    title: 'The harmonic oscillator ladder',
    blurb:
      'Evenly spaced levels, each half a quantum above the last, and a ground state that cannot sit still.',
    build: () => {
      const tab = makeTab('quantum', 'Oscillator');
      tab.quantum = {
        ...tab.quantum,
        world: {
          ...tab.quantum.world,
          view: 'bound',
          xMin: -6,
          xMax: 6,
          points: 700,
          levels: 8,
          features: [{ id: 'h', kind: 'harmonic', centre: 0, width: 4, height: 6 }],
        },
        selectedId: 'h',
        stacked: true,
      };
      tab.viewport = { xMin: -6, xMax: 6, yMin: -0.5, yMax: 8 };
      return tab;
    },
  },
  {
    id: 'periodic-trends',
    mode: 'chemistry',
    title: 'Why the table is shaped the way it is',
    blurb:
      'The periodic table shaded by atomic radius, with the trend plotted underneath. Every jump is a new shell.',
    build: () => {
      const tab = makeTab('chemistry', 'Trends');
      tab.chemistry = {
        ...tab.chemistry,
        selected: 11,
        colourBy: 'radius',
        plotProperty: 'radius',
        showTrend: true,
      };
      return tab;
    },
  },
  {
    id: 'copper-exception',
    mode: 'chemistry',
    title: 'Where the filling rule breaks',
    blurb:
      'Copper should be 3d⁹ 4s². It is 3d¹⁰ 4s¹, because a full d subshell is worth more than a full s. Twenty elements cheat like this.',
    build: () => {
      const tab = makeTab('chemistry', 'Copper');
      tab.chemistry = {
        ...tab.chemistry,
        selected: 29,
        colourBy: 'category',
        atomView: 'shells',
        animate: true,
        showTrend: false,
      };
      return tab;
    },
  },
  {
    id: 'd-orbital',
    mode: 'chemistry',
    title: 'The shape of a d orbital',
    blurb:
      'Iron’s outermost electrons are filling 3d. This is |ψ|² for a hydrogen-like 3d orbital — no radial nodes and two angular ones, computed from the Laguerre and Legendre functions rather than drawn.',
    build: () => {
      const tab = makeTab('chemistry', 'Orbital');
      tab.chemistry = {
        ...tab.chemistry,
        selected: 26,
        colourBy: 'category',
        atomView: 'orbital',
        animate: false,
        showTrend: false,
      };
      return tab;
    },
  },

  // ------------------------------------------------------------------- waves

  {
    id: 'wave-junction',
    mode: 'waves',
    title: 'A pulse meeting a heavier string',
    blurb:
      'Half the string is twice as dense. Part of the pulse goes on, part comes back upside down, and the amplitudes are (c₂−c₁)/(c₂+c₁) exactly.',
    build: () => {
      const tab = makeTab('waves', 'Junction');
      tab.waves = {
        ...tab.waves,
        world: {
          ...tab.waves.world,
          view: 'propagate',
          medium: 'string',
          params: { tension: 40, density: 0.01 },
          length: 1,
          points: 900,
          // Absorbing ends so the only echo on screen is the one from the
          // junction, which is the thing being demonstrated.
          left: 'absorbing',
          right: 'absorbing',
          junction: 0.5,
          // Speed halves, so r = (0.5 − 1)/(0.5 + 1) = −1/3: a third of the
          // amplitude comes back, inverted.
          speedRatio: 0.5,
          source: { kind: 'pulse', centre: 0.18, width: 0.025, frequency: 200, amplitude: 1 },
          // v = √(T/µ) = 63 m/s, so the pulse reaches the junction at 5 ms.
          // Ten milliseconds leaves both halves of it still on screen at the
          // end of the run rather than swallowed by the absorbing ends.
          duration: 0.01,
        },
        selectedId: null,
      };
      tab.timeline = { ...tab.timeline, playing: true, tMax: 0.01 };
      return tab;
    },
  },
  {
    id: 'single-slit',
    mode: 'waves',
    title: 'One slit is enough',
    blurb:
      'A single 80 µm slit in green light. The first dark fringe sits at θ = λ/a — 6.9 mrad, or 13.8 mm on a screen two metres away — and it comes from summing over the aperture, not from a formula.',
    build: () => {
      const tab = makeTab('waves', 'Single slit');
      tab.waves = {
        ...tab.waves,
        world: {
          ...tab.waves.world,
          view: 'diffract',
          wavelength: 550,
          slits: [{ id: 'slit', centre: 0, width: 0.08, transmission: 1, phase: 0 }],
          screenDistance: 2,
          // λ/a = 6.875 mrad, so the first zero lands 13.75 mm out and four
          // orders fit inside ±30 mm.
          screenWidth: 0.03,
          sourceDistance: 0,
        },
        selectedId: 'slit',
        showAnalytic: true,
        logIntensity: false,
      };
      return tab;
    },
  },
  {
    id: 'grating',
    mode: 'waves',
    title: 'Six slits, and why a grating is sharp',
    blurb:
      'The same integral over six apertures. The orders narrow as 1/N and four faint secondary maxima appear between each pair — on a log scale you can count them.',
    build: () => {
      const tab = makeTab('waves', 'Grating');
      const pitch = 0.08;
      tab.waves = {
        ...tab.waves,
        world: {
          ...tab.waves.world,
          view: 'diffract',
          wavelength: 550,
          slits: Array.from({ length: 6 }, (_, i) => ({
            id: `g${i}`,
            centre: (i - 2.5) * pitch,
            width: 0.02,
            transmission: 1,
            phase: 0,
          })),
          screenDistance: 2,
          screenWidth: 0.035,
          sourceDistance: 0,
        },
        selectedId: 'g0',
        // The two-slit formula is not the right analytic curve for six, and
        // saying so on screen is more honest than drawing it anyway.
        showAnalytic: false,
        logIntensity: true,
      };
      return tab;
    },
  },
  {
    id: 'prism-tir',
    mode: 'waves',
    title: 'A prism that cannot let light out',
    blurb:
      'Light enters a glass block square-on and meets a 45° exit face — past the 41.8° critical angle, so all of it turns through a right angle. This is the prism in a pair of binoculars.',
    build: () => {
      const tab = makeTab('waves', 'Prism');
      tab.waves = {
        ...tab.waves,
        world: {
          ...tab.waves.world,
          view: 'rays',
          surfaces: [
            { id: 'entry', z: 0, radius: 0, tilt: 0, aperture: 26, index: 1.5, mirror: false, label: 'Entry face' },
            { id: 'exit', z: 34, radius: 0, tilt: 45, aperture: 26, index: 1, mirror: false, label: '45° face' },
          ],
          rayCount: 9,
          rayHeight: 16,
          objectDistance: 0,
          rayAngle: 0,
        },
        selectedId: 'exit',
        showEquations: true,
      };
      return tab;
    },
  },
  {
    id: 'real-image',
    mode: 'waves',
    title: 'Where the lens equation stops being true',
    blurb:
      'f = 60 mm, object at 120 mm, so 1/v = 1/f − 1/u puts the image at 120. The traced rays cross anywhere from 113 to 130 mm, and that spread is spherical aberration.',
    build: () => {
      const tab = makeTab('waves', 'Lens');
      tab.waves = {
        ...tab.waves,
        world: {
          ...tab.waves.world,
          view: 'rays',
          surfaces: [
            { id: 'front', z: 0, radius: 60, tilt: 0, aperture: 20, index: 1.5, mirror: false, label: 'Front' },
            { id: 'back', z: 10, radius: -60, tilt: 0, aperture: 20, index: 1, mirror: false, label: 'Back' },
          ],
          rayCount: 13,
          // A fan wide enough that the marginal rays miss the paraxial focus
          // by seventeen millimetres. Narrow it and the lens equation comes
          // back true, which is the other half of the lesson.
          rayHeight: 15,
          objectDistance: 120,
          rayAngle: 0,
        },
        selectedId: 'front',
        showEquations: true,
      };
      return tab;
    },
  },

  // ----------------------------------------------------------------- signals

  {
    id: 'crossing-chirps',
    mode: 'signals',
    title: 'Two chirps crossing',
    blurb:
      'One tone sweeping up, one sweeping down, and a spectrogram that shows both. Neither is visible in the waveform.',
    build: () => {
      const tab = makeTab('signals', 'Chirps');
      tab.signals = {
        ...tab.signals,
        view: 'spectrogram',
        // Instantaneous frequency is the derivative of the phase: 120 + 800t
        // rising, 1000 − 800t falling. They meet at t = 0.55 s, 560 Hz.
        expression: 'sin(2*pi*(120*t + 400*t^2)) + sin(2*pi*(1000*t - 400*t^2))',
        sampleRate: 2400,
        duration: 1,
        window: 'hann',
        windowSize: 256,
        noise: 0,
      };
      return tab;
    },
  },
  {
    id: 'buried-tone',
    mode: 'signals',
    title: 'A tone buried in noise',
    blurb:
      'A 77 Hz sine at a seventh the amplitude of the noise on top of it. The waveform is hopeless; in the spectrum it stands 20 dB clear.',
    build: () => {
      const tab = makeTab('signals', 'Buried tone');
      tab.signals = {
        ...tab.signals,
        view: 'spectrum',
        expression: '0.15*sin(2*pi*77*t)',
        sampleRate: 2000,
        // Sixteen thousand samples: the tone lands in one bin and the noise
        // spreads over eight thousand, and that ratio is the processing gain.
        // Halve the recording and the peak drops into the grass.
        duration: 8,
        noise: 1,
        seed: 'buried',
        window: 'hann',
        decibels: true,
      };
      return tab;
    },
  },
  {
    id: 'rc-response',
    mode: 'signals',
    title: 'An RC filter, measured',
    blurb:
      'A first-order low pass is exactly a 1 kΩ resistor and a 100 nF capacitor: corner at 1592 Hz, −20 dB per decade, −45° of phase. Build it in the circuits mode and compare.',
    build: () => {
      const tab = makeTab('signals', 'RC response');
      tab.signals = {
        ...tab.signals,
        view: 'filter',
        // 50 kHz of Nyquist, so a decade and a half of the roll-off fits on
        // the Bode plot before the bilinear transform's zero at Nyquist bends
        // the curve down and the slope stops being −20 dB per decade.
        sampleRate: 100000,
        duration: 0.02,
        expression: 'sign(sin(2*pi*300*t))',
        filter: {
          ...tab.signals.filter,
          family: 'butterworth',
          response: 'lowpass',
          // One pole, one zero at Nyquist: the bilinear transform of 1/(1+sRC).
          order: 1,
          cutoff: 1 / (2 * Math.PI * 1e3 * 100e-9),
          sampleRate: 100000,
        },
        filtered: true,
        logFrequency: true,
        decibels: true,
      };
      return tab;
    },
  },
  {
    id: 'chebyshev-band',
    mode: 'signals',
    title: 'Ripple, and what it buys you',
    blurb:
      'An eighth-order Chebyshev band pass. Give up a decibel of flatness and the skirts fall away twice as fast: 42 dB down at 1.5 kHz, where a Butterworth of the same order manages 19.',
    build: () => {
      const tab = makeTab('signals', 'Chebyshev');
      tab.signals = {
        ...tab.signals,
        view: 'filter',
        sampleRate: 8000,
        filter: {
          ...tab.signals.filter,
          family: 'chebyshev',
          response: 'bandpass',
          order: 8,
          cutoff: 300,
          cutoffHigh: 1200,
          ripple: 1,
          sampleRate: 8000,
        },
        logFrequency: true,
        decibels: true,
      };
      return tab;
    },
  },
  {
    id: 'aliasing',
    mode: 'signals',
    title: 'Undersampling on purpose',
    blurb:
      'A 900 Hz tone sampled at 1 kHz comes back as 100 Hz, and the reconstruction is a perfectly good sine of the wrong frequency. The wagon wheel, in one plot.',
    build: () => {
      const tab = makeTab('signals', 'Aliasing');
      tab.signals = {
        ...tab.signals,
        view: 'sampling',
        // |900 − 1000| = 100 Hz. Nothing downstream can tell the two apart:
        // the samples are identical.
        toneFrequency: 900,
        sampleFrequency: 1000,
      };
      return tab;
    },
  },
];

// ------------------------------------------------------------------ helpers

/* Deterministic pseudo-noise in [−0.5, 0.5).
 *
 * Examples must look identical every time they are opened — a scatter plot
 * that reshuffles on each load makes the user doubt the fit rather than read
 * it — so the "measurement error" in the data examples is a fixed function of
 * the row index rather than anything drawn from a generator. */
function wobble(i: number, salt = 0): number {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v) - 0.5;
}

/* Small constructors so the sandbox examples above read as descriptions of a
 * bench rather than as pages of object literals. */

function mass(id: string, x: number, y: number, kg: number, label: string, colour: number): Body {
  return {
    id,
    kind: 'mass',
    x,
    y,
    vx: 0,
    vy: 0,
    mass: kg,
    radius: 0.16,
    label,
    colour: SERIES_COLOURS[colour % SERIES_COLOURS.length],
  };
}

function mechAnchor(id: string, x: number, y: number, label: string): Body {
  return { id, kind: 'anchor', x, y, vx: 0, vy: 0, mass: 0, radius: 0.1, label, colour: '#94a3b8' };
}

function rod(id: string, a: string, b: string, label: string): Link {
  return { id, kind: 'rod', a, b, length: null, stiffness: 0, damping: 0, label, colour: '#cbd5e1' };
}

function probe(id: string, kind: Measurement['kind'], target: string, colour: number): Measurement {
  return { id, kind, target, colour: SERIES_COLOURS[colour % SERIES_COLOURS.length], visible: true };
}

function part(
  id: string,
  kind: ElementKind,
  x: number,
  y: number,
  orientation: 'h' | 'v',
  label: string,
  values: Record<string, number> = {},
  reversed = false,
): CircuitElement {
  return { id, kind, x, y, orientation, reversed, values: { ...circuitDefaults(kind), ...values }, label };
}

/** The return path: down the right-hand side, along the bottom, back up. */
function rail(width: number, bottom: number): CircuitElement[] {
  const out: CircuitElement[] = [part(uid('w'), 'wire', width, bottom, 'v', '')];
  for (let x = 0; x < width; x++) out.push(part(uid('w'), 'wire', x, bottom, 'h', ''));
  out.push(part(uid('w'), 'wire', 0, bottom, 'v', ''));
  return out;
}

function reading(
  id: string,
  kind: 'voltage' | 'current' | 'power' | 'resistance' | 'charge' | 'brightness' | 'stored',
  target: string,
  colour: number,
) {
  return { id, kind, target, colour: SERIES_COLOURS[colour % SERIES_COLOURS.length], visible: true };
}
