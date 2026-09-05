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
import { SERIES_COLOURS, type TabState } from './types';

export interface Example {
  id: string;
  title: string;
  blurb: string;
  build: () => TabState;
}

export const EXAMPLES: Example[] = [
  {
    id: 'lissajous',
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
    id: 'confidence',
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
    id: 'shear',
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
    title: 'Three planes meeting in a point',
    blurb: 'Solve a 3×3 system by looking at it. Drag to orbit.',
    build: () => makeTab('linear-algebra', 'Planes'),
  },
  {
    id: 'gbm',
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
    id: 'riemann',
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
    title: 'Route to chaos',
    blurb: 'The logistic map’s period-doubling cascade, with the Lyapunov exponent underneath.',
    build: () => makeTab('dynamics', 'Bifurcation'),
  },
  {
    id: 'mandelbrot',
    title: 'The Mandelbrot set',
    blurb: 'Smooth-coloured escape times. Scroll to zoom — it keeps going.',
    build: () => {
      const tab = makeTab('dynamics', 'Mandelbrot');
      tab.dynamics = { ...tab.dynamics, view: 'fractal', fractalKind: 'mandelbrot' };
      return tab;
    },
  },
  {
    id: 'dipole',
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
    id: 'regression',
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

  // ---------------------------------------------------------------- mechanics

  {
    id: 'double-pendulum',
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
];

// ------------------------------------------------------------------ helpers

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
