/* Recognising the textbook set-ups.
 *
 * A sandbox that only ever answers "here is what happened" teaches less than
 * one that also says "and here is why, and here is the formula you were meant
 * to derive". So after the scene is built, this module looks at its shape and
 * tries to name it: a simple pendulum, an Atwood machine, a series RLC. When
 * it succeeds it returns the governing equation, the derived quantities
 * (period, time constant, damping ratio) and — where a closed form exists — a
 * function of time that the measurement plot draws over the simulated trace.
 *
 * Overlaying the closed form on the numerical result is the point. Where the
 * two agree the student sees the formula is trustworthy; where they part
 * company — a pendulum past 20°, an underdamped circuit near its first peak —
 * they see exactly which approximation was doing the work. A tool that only
 * ever showed agreement would be teaching the wrong lesson.
 *
 * Recognition is deliberately strict. It is far better to say "no standard
 * form for this arrangement, here is the general statement" than to print a
 * formula that nearly applies, because a nearly-applicable formula is
 * indistinguishable from a correct one until it matters.
 */

import type { MechanicsWorld, PreparedWorld } from './mechanics';
import type { CircuitWorld, ElementKind, Netlist } from './circuit';
import { staticResistance } from './circuit';

export interface DerivedQuantity {
  label: string;
  value: number;
  unit: string;
}

export interface Overlay {
  /** Which measurement the curve predicts, so only that trace is annotated. */
  kind: string;
  target: string;
  label: string;
  fn: (t: number) => number;
}

export interface AnalyticResult {
  title: string;
  /** Rendered with KaTeX, in order. */
  equations: string[];
  quantities: DerivedQuantity[];
  overlay: Overlay | null;
  /** What the closed form assumes, when it assumes anything. */
  caveat: string | null;
}

const fmtDeg = (radians: number) => (radians * 180) / Math.PI;

// ------------------------------------------------------------------ mechanics

/** Complete elliptic integral of the first kind, K(k), by the AGM. */
function ellipticK(k: number): number {
  let a = 1;
  let b = Math.sqrt(Math.max(0, 1 - k * k));
  for (let i = 0; i < 60 && Math.abs(a - b) > 1e-15; i++) {
    const next = (a + b) / 2;
    b = Math.sqrt(a * b);
    a = next;
  }
  return Math.PI / (2 * a);
}

const GENERAL_MECHANICS: AnalyticResult = {
  title: 'No standard form for this arrangement',
  equations: [
    String.raw`M\ddot{q} = F(q,\dot{q}) + J^{\mathsf T}\lambda,\qquad C(q)=0`,
    String.raw`J\ddot{q} = -\dot{J}\dot{q}`,
  ],
  quantities: [],
  overlay: null,
  caveat:
    'This is what the solver is doing: Newton’s second law for every mass, plus a reaction force along each constraint chosen so the constraints stay satisfied. The multipliers λ are the tensions and normal forces the panel reports.',
};

/**
 * Names the arrangement, if it is one of the standard ones.
 *
 * `prep` carries the resolved lengths — a rod whose length was left to be
 * measured from the layout has a number only after preparation — so the
 * formulas quote what will actually be simulated.
 */
export function analyseMechanics(world: MechanicsWorld, prep: PreparedWorld): AnalyticResult {
  const g = world.gravity;
  const masses = world.bodies.filter((b) => b.kind === 'mass');
  const anchors = world.bodies.filter((b) => b.kind === 'anchor');
  const rods = world.links.filter((l) => l.kind === 'rod');
  const ropes = world.links.filter((l) => l.kind === 'rope');
  const springs = world.links.filter((l) => l.kind === 'spring');
  const { surfaces, pulleys } = world;
  const drag = world.dragMode !== 'none' && world.dragCoefficient > 0;

  const lengthOf = (id: string): number => {
    const index = world.links.findIndex((l) => l.id === id);
    return prep.links.find((l) => l.index === index)?.length ?? 0;
  };

  // ---- simple pendulum -------------------------------------------------
  if (
    masses.length === 1 &&
    anchors.length === 1 &&
    rods.length === 1 &&
    !ropes.length &&
    !springs.length &&
    !surfaces.length &&
    !pulleys.length &&
    !drag &&
    g > 0
  ) {
    const m = masses[0];
    const a = anchors[0];
    const L = lengthOf(rods[0].id);
    const theta = Math.atan2(m.x - a.x, -(m.y - a.y));
    const released = Math.abs(m.vx) < 1e-9 && Math.abs(m.vy) < 1e-9;
    const omega = Math.sqrt(g / L);
    const small = (2 * Math.PI) / omega;
    const exact = 4 * Math.sqrt(L / g) * ellipticK(Math.sin(Math.abs(theta) / 2));

    return {
      title: 'Simple pendulum',
      equations: [
        String.raw`\ddot{\theta} = -\frac{g}{L}\sin\theta`,
        String.raw`T_0 = 2\pi\sqrt{\frac{L}{g}}\qquad\text{(small angles)}`,
        String.raw`T = 4\sqrt{\frac{L}{g}}\,K\!\left(\sin\tfrac{\theta_0}{2}\right)\qquad\text{(exact)}`,
      ],
      quantities: [
        { label: 'Length', value: L, unit: 'm' },
        { label: 'Release angle', value: fmtDeg(theta), unit: '°' },
        { label: 'Small-angle period', value: small, unit: 's' },
        { label: 'Exact period', value: exact, unit: 's' },
        { label: 'Small-angle error', value: (100 * (exact - small)) / exact, unit: '%' },
      ],
      overlay: released
        ? {
            kind: 'angle',
            target: rods[0].id,
            label: 'Small-angle prediction',
            // The angle measurement is taken from the anchor toward the mass
            // against the downward vertical, so a release at −θ₀ reads −θ₀.
            fn: (t) => -fmtDeg(theta) * Math.cos(omega * t),
          }
        : null,
      caveat:
        'The overlaid curve is the small-angle solution θ = θ₀cos(ω₀t). Watch it drift out of step with the simulation as the amplitude grows — that gap is the sin θ ≈ θ approximation failing.',
    };
  }

  // ---- double pendulum -------------------------------------------------
  if (
    masses.length === 2 &&
    anchors.length === 1 &&
    rods.length === 2 &&
    !springs.length &&
    !surfaces.length &&
    !pulleys.length &&
    g > 0
  ) {
    const l1 = lengthOf(rods[0].id);
    const l2 = lengthOf(rods[1].id);
    const m1 = masses[0].mass;
    const m2 = masses[1].mass;
    // Normal modes of the linearised system, for equal lengths.
    const ratio = m2 / m1;
    const modes =
      Math.abs(l1 - l2) < 1e-9
        ? [
            Math.sqrt((g / l1) * (1 + ratio + Math.sqrt(ratio * (1 + ratio)))),
            Math.sqrt((g / l1) * (1 + ratio - Math.sqrt(ratio * (1 + ratio)))),
          ]
        : [];
    return {
      title: 'Double pendulum',
      equations: [
        String.raw`\mathcal{L} = \tfrac12(m_1{+}m_2)L_1^2\dot\theta_1^2 + \tfrac12 m_2L_2^2\dot\theta_2^2 + m_2L_1L_2\dot\theta_1\dot\theta_2\cos(\theta_1{-}\theta_2)`,
        String.raw`\qquad + (m_1{+}m_2)gL_1\cos\theta_1 + m_2gL_2\cos\theta_2`,
      ],
      quantities: modes.length
        ? [
            { label: 'Fast normal mode', value: modes[0] / (2 * Math.PI), unit: 'Hz' },
            { label: 'Slow normal mode', value: modes[1] / (2 * Math.PI), unit: 'Hz' },
          ]
        : [],
      overlay: null,
      caveat:
        'There is no closed-form solution: this system is chaotic, and two releases a thousandth of a degree apart diverge completely within a few seconds. The frequencies quoted are the normal modes of the linearised system, which only describe motion near the hanging equilibrium. Try nudging the starting angle and watching how long the two runs stay together.',
    };
  }

  // ---- mass on a spring ------------------------------------------------
  if (masses.length === 1 && springs.length === 1 && !rods.length && !ropes.length && !pulleys.length) {
    const m = masses[0].mass;
    const spring = springs[0];
    const k = spring.stiffness;
    const c = spring.damping + (world.dragMode === 'linear' ? world.dragCoefficient : 0);
    const omega0 = Math.sqrt(k / m);
    const gamma = c / (2 * m);
    const zeta = gamma / omega0;
    const other = world.bodies.find((b) => b.id === (spring.a === masses[0].id ? spring.b : spring.a));
    const vertical = other ? Math.abs(other.x - masses[0].x) < 1e-6 : false;
    const stretch = vertical && g > 0 ? (m * g) / k : 0;

    const quantities: DerivedQuantity[] = [
      { label: 'Natural frequency', value: omega0 / (2 * Math.PI), unit: 'Hz' },
      { label: 'Undamped period', value: (2 * Math.PI) / omega0, unit: 's' },
    ];
    if (stretch > 0) quantities.push({ label: 'Static extension mg/k', value: stretch, unit: 'm' });
    if (c > 0) {
      quantities.push({ label: 'Damping ratio ζ', value: zeta, unit: '' });
      if (zeta < 1) {
        quantities.push({ label: 'Damped period', value: (2 * Math.PI) / Math.sqrt(omega0 ** 2 - gamma ** 2), unit: 's' });
        quantities.push({ label: 'Q factor', value: 1 / (2 * zeta), unit: '' });
      }
    }

    const regime = c === 0 ? 'undamped' : zeta < 1 ? 'underdamped' : zeta > 1 ? 'overdamped' : 'critically damped';
    const equations = [String.raw`m\ddot{x} + c\dot{x} + kx = 0`, String.raw`\omega_0 = \sqrt{\frac{k}{m}},\quad \zeta = \frac{c}{2\sqrt{mk}}`];
    if (zeta < 1) equations.push(String.raw`x(t) = A\,e^{-\zeta\omega_0 t}\cos\!\left(\omega_0\sqrt{1-\zeta^2}\,t + \phi\right)`);
    else if (zeta > 1) equations.push(String.raw`x(t) = A_1e^{-s_1 t} + A_2e^{-s_2 t},\quad s_{1,2} = \omega_0\left(\zeta \mp \sqrt{\zeta^2-1}\right)`);
    else equations.push(String.raw`x(t) = (A + Bt)\,e^{-\omega_0 t}`);

    // The overlay is only honest for a mass released from rest on a vertical
    // spring, where the equilibrium and the amplitude are both known from the
    // layout alone.
    let overlay: Overlay | null = null;
    const atRest = Math.abs(masses[0].vx) < 1e-9 && Math.abs(masses[0].vy) < 1e-9;
    if (vertical && atRest && other && zeta < 1) {
      const natural = lengthOf(spring.id);
      const equilibrium = other.y - natural - stretch;
      const amplitude = masses[0].y - equilibrium;
      const omegaD = Math.sqrt(omega0 ** 2 - gamma ** 2);
      overlay = {
        kind: 'y',
        target: masses[0].id,
        label: 'Analytic solution',
        fn: (t) =>
          equilibrium +
          amplitude * Math.exp(-gamma * t) * (Math.cos(omegaD * t) + (gamma / omegaD) * Math.sin(omegaD * t)),
      };
    }

    return {
      title: `Mass on a spring — ${regime}`,
      equations,
      quantities,
      overlay,
      caveat:
        stretch > 0
          ? 'Gravity shifts the equilibrium down by mg/k but does not change the frequency — which is why a vertical spring and a horizontal one oscillate at exactly the same rate.'
          : null,
    };
  }

  // ---- Atwood machine --------------------------------------------------
  if (pulleys.length === 1 && masses.length === 2 && !rods.length && !springs.length && !surfaces.length) {
    const p = pulleys[0];
    const a = world.bodies.find((b) => b.id === p.a);
    const b = world.bodies.find((b2) => b2.id === p.b);
    if (a && b && a.kind === 'mass' && b.kind === 'mass') {
      const m1 = a.mass;
      const m2 = b.mass;
      const accel = (g * (m1 - m2)) / (m1 + m2);
      const tension = (2 * m1 * m2 * g) / (m1 + m2);

      /* How far the two rope runs are from vertical.
       *
       * A point peg puts a true Atwood machine's masses at exactly the same x,
       * where they are drawn on top of each other and unreadable. A few
       * degrees of offset makes the picture legible and costs a fraction of a
       * percent, so it is allowed — and named, because a formula presented
       * without its error is the thing this whole module exists to avoid. Past
       * eight degrees it is a rope over a nail and the formulas stop being the
       * right ones at all. */
      const tilt = (body: typeof a) => Math.abs(Math.atan2(body.x - p.x, Math.abs(body.y - p.y) || 1e-9));
      const lean = Math.max(tilt(a), tilt(b));
      const leanDegrees = fmtDeg(lean);
      const nearlyVertical = lean < (8 * Math.PI) / 180;
      return {
        title: 'Atwood machine',
        equations: [
          String.raw`a = \frac{(m_1 - m_2)g}{m_1 + m_2}`,
          String.raw`T = \frac{2m_1m_2g}{m_1 + m_2}`,
        ],
        quantities: [
          { label: 'Acceleration', value: Math.abs(accel), unit: 'm/s²' },
          { label: 'Rope tension', value: tension, unit: 'N' },
          { label: 'Effective g', value: Math.abs(accel), unit: 'm/s²' },
        ],
        overlay: nearlyVertical
          ? { kind: 'vy', target: a.id, label: 'Predicted velocity', fn: (t) => -accel * t }
          : null,
        caveat: !nearlyVertical
          ? `The rope runs are ${leanDegrees.toFixed(0)}° from vertical, so this is a rope over a peg rather than an Atwood machine — the masses swing as well as rise and fall, and the formulas above are only the vertical limit. Move both masses under the peg to match them.`
          : leanDegrees > 0.5
            ? `The rope is modelled as running over a frictionless peg of no mass, so none of the tension goes into spinning the pulley. The two runs are ${leanDegrees.toFixed(1)}° from vertical — enough to tell the masses apart on screen, and about ${(100 * (1 - Math.cos(lean))).toFixed(2)}% away from the vertical formulas above.`
            : 'The rope is modelled as running over a frictionless peg of no mass, so none of the tension goes into spinning the pulley.',
      };
    }
  }

  // ---- one mass on one surface -----------------------------------------
  if (masses.length === 1 && surfaces.length === 1 && !rods.length && !ropes.length && !springs.length && !pulleys.length) {
    const s = surfaces[0];
    const slope = Math.abs(Math.atan2(s.y1 - s.y0, s.x1 - s.x0));
    const alpha = slope > Math.PI / 2 ? Math.PI - slope : slope;
    const critical = Math.atan(s.muS);
    const m = masses[0];

    /* A ball dropped onto a level floor is not a block on a slope, and saying
     * so — complete with a critical angle of 5.7° and a note about raising the
     * incline — is worse than saying nothing, because it is confidently about
     * the wrong experiment. The incline formulas only apply when there is
     * actually an incline and the body is actually resting on it. */
    const level = alpha < (2 * Math.PI) / 180;
    const airborne = Math.abs(m.vy) > 0.05 || Math.abs(m.vx) > 0.05;

    if (level && (s.restitution > 0 || airborne)) {
      const e = s.restitution;
      return {
        title: e > 0 ? 'Bouncing ball' : 'Falling onto a surface',
        equations: [
          String.raw`v_{\text{after}} = -e\,v_{\text{before}}`,
          String.raw`\frac{h_{n+1}}{h_n} = e^2`,
          String.raw`h_n = e^{2n}h_0`,
        ],
        quantities: [
          { label: 'Coefficient of restitution', value: e, unit: '' },
          { label: 'Energy kept per bounce', value: 100 * e * e, unit: '%' },
          ...(e > 0 && e < 1
            ? [
                { label: 'Bounces above h₀/10', value: Math.log(0.1) / (2 * Math.log(e)), unit: '' },
                {
                  // Σ 2e^n √(2h/g) — the geometric series of flight times.
                  label: 'Time to come to rest',
                  value: (Math.sqrt((2 * Math.max(0.01, m.y - s.y0)) / g) * (1 + e)) / (1 - e),
                  unit: 's',
                },
              ]
            : []),
        ],
        overlay: null,
        caveat:
          e > 0 && e < 1
            ? 'The heights form a geometric series, so the ball bounces infinitely often but comes to rest in a finite time — which is why the energy trace is a staircase and not a slope. Set e to 1 and it never settles.'
            : null,
      };
    }

    if (level) {
      const mu = s.muK;
      const speed = Math.hypot(m.vx, m.vy);
      return {
        title: mu > 0 ? 'Sliding on a level surface' : 'Resting on a level surface',
        equations: [
          String.raw`N = mg`,
          String.raw`a = -\mu_k g`,
          String.raw`d = \frac{v_0^2}{2\mu_k g}`,
        ],
        quantities: [
          { label: 'Normal force', value: m.mass * g, unit: 'N' },
          { label: 'Deceleration', value: mu * g, unit: 'm/s²' },
          ...(mu > 0 && speed > 0
            ? [
                { label: 'Distance to stop', value: (speed * speed) / (2 * mu * g), unit: 'm' },
                { label: 'Time to stop', value: speed / (mu * g), unit: 's' },
              ]
            : []),
        ],
        overlay: null,
        caveat: null,
      };
    }

    const willSlide = Math.tan(alpha) > s.muS;
    const accel = g * (Math.sin(alpha) - s.muK * Math.cos(alpha));
    return {
      title: willSlide ? 'Block sliding on a slope' : 'Block held by friction',
      equations: [
        String.raw`N = mg\cos\alpha`,
        willSlide
          ? String.raw`a = g\left(\sin\alpha - \mu_k\cos\alpha\right)`
          : String.raw`F_{\text{friction}} = mg\sin\alpha \le \mu_s N`,
        String.raw`\text{slips when } \tan\alpha > \mu_s`,
      ],
      quantities: [
        { label: 'Slope angle', value: fmtDeg(alpha), unit: '°' },
        { label: 'Angle of friction tan⁻¹μs', value: fmtDeg(critical), unit: '°' },
        { label: 'Normal force', value: m.mass * g * Math.cos(alpha), unit: 'N' },
        ...(willSlide
          ? [{ label: 'Acceleration', value: accel, unit: 'm/s²' }]
          : [{ label: 'Friction needed', value: m.mass * g * Math.sin(alpha), unit: 'N' },
             { label: 'Friction available', value: s.muS * m.mass * g * Math.cos(alpha), unit: 'N' }]),
      ],
      overlay:
        willSlide && Math.hypot(m.vx, m.vy) < 1e-9
          ? { kind: 'speed', target: m.id, label: 'Predicted speed', fn: (t) => Math.max(0, accel) * t }
          : null,
      caveat: willSlide
        ? null
        : `The slope is below the angle of friction, so the block stays put no matter how long you run it. Raise the slope past ${fmtDeg(critical).toFixed(1)}° — or lower μs — and it will let go.`,
    };
  }

  // ---- projectile ------------------------------------------------------
  if (masses.length === 1 && !world.links.length && !surfaces.length && !pulleys.length && g > 0) {
    const m = masses[0];
    const speed = Math.hypot(m.vx, m.vy);
    if (!drag) {
      const flight = speed > 0 ? (2 * m.vy) / g : 0;
      return {
        title: speed > 0 ? 'Projectile' : 'Free fall',
        equations: [
          String.raw`x(t) = x_0 + u_x t`,
          String.raw`y(t) = y_0 + u_y t - \tfrac12 g t^2`,
          String.raw`R = \frac{u^2\sin 2\theta}{g}`,
        ],
        quantities: [
          { label: 'Launch speed', value: speed, unit: 'm/s' },
          { label: 'Launch angle', value: speed > 0 ? fmtDeg(Math.atan2(m.vy, m.vx)) : 0, unit: '°' },
          ...(m.vy > 0
            ? [
                { label: 'Time of flight', value: flight, unit: 's' },
                { label: 'Peak height above launch', value: (m.vy * m.vy) / (2 * g), unit: 'm' },
                { label: 'Range on level ground', value: m.vx * flight, unit: 'm' },
              ]
            : []),
        ],
        overlay: { kind: 'y', target: m.id, label: 'Analytic parabola', fn: (t) => m.y + m.vy * t - 0.5 * g * t * t },
        caveat: null,
      };
    }
    if (world.dragMode === 'linear') {
      const b = world.dragCoefficient;
      const terminal = (m.mass * g) / b;
      const tau = m.mass / b;
      return {
        title: 'Fall with linear drag',
        equations: [
          String.raw`m\dot{v} = -mg - bv`,
          String.raw`v(t) = -v_\infty + (v_0 + v_\infty)e^{-t/\tau}`,
          String.raw`v_\infty = \frac{mg}{b},\qquad \tau = \frac{m}{b}`,
        ],
        quantities: [
          { label: 'Terminal speed', value: terminal, unit: 'm/s' },
          { label: 'Time constant', value: tau, unit: 's' },
        ],
        overlay: {
          kind: 'vy',
          target: m.id,
          label: 'Analytic solution',
          fn: (t) => -terminal + (m.vy + terminal) * Math.exp(-t / tau),
        },
        caveat: null,
      };
    }
  }

  return GENERAL_MECHANICS;
}

// ------------------------------------------------------------------ circuits

const GENERAL_CIRCUIT: AnalyticResult = {
  title: 'No standard form for this circuit',
  equations: [
    String.raw`\sum_{\text{node}} I = 0 \qquad \sum_{\text{loop}} V = 0`,
    String.raw`\mathbf{G}\mathbf{v} + \mathbf{B}\mathbf{j} = \mathbf{i}`,
  ],
  quantities: [],
  overlay: null,
  caveat:
    'Kirchhoff’s laws at every node, solved as one matrix — which is exactly what the simulator does, so the numbers on the right are as exact as the component values you typed.',
};

/**
 * True when every node joins exactly two terminals: one loop, no branches.
 *
 * Voltmeters are skipped. A voltmeter is an observation of a circuit rather
 * than a part of it — that is the whole point of making its resistance
 * enormous — and counting its two terminals turns every measured divider into
 * an unrecognisable branching network, which is precisely the circuit a
 * student most wants the divider formula for. It still loads the circuit in
 * the solve, as a real one would; it just does not get a vote on what the
 * circuit *is*.
 */
function isSingleLoop(netlist: Netlist): boolean {
  if (!netlist.active.length) return false;
  const degree = new Map<number, number>();
  const bump = (n: number) => degree.set(n, (degree.get(n) ?? 0) + 1);
  for (let i = 0; i < netlist.active.length; i++) {
    if (netlist.active[i].kind === 'voltmeter') continue;
    bump(netlist.nodeA[i]);
    bump(netlist.nodeB[i]);
  }
  if (degree.size === 0) return false;
  for (const count of degree.values()) if (count !== 2) return false;
  return true;
}

const isSource = (k: ElementKind) => k === 'cell' || k === 'battery' || k === 'ac';

export function analyseCircuit(world: CircuitWorld, netlist: Netlist): AnalyticResult {
  const active = netlist.active;
  if (!active.length) return GENERAL_CIRCUIT;

  const count = (k: ElementKind) => active.filter((e) => e.kind === k).length;
  const sources = active.filter((e) => isSource(e.kind));
  const caps = active.filter((e) => e.kind === 'capacitor');
  const inds = active.filter((e) => e.kind === 'inductor');
  const nonlinear = count('diode') + count('led');

  /* The series resistance of the loop. Voltmeters are left out for the same
   * reason they are left out of `isSingleLoop`: a ten-megohm meter across one
   * resistor is in parallel with it, not in series with the loop, and adding
   * it to this sum would put the time constant of an RC circuit out by three
   * orders of magnitude the moment anyone measured it. */
  let resistance = 0;
  for (const e of active) {
    if (e.kind === 'voltmeter') continue;
    const r = staticResistance(e, world.temperature, false);
    if (Number.isFinite(r) && r < 1e11) resistance += r;
  }
  for (const e of sources) resistance += e.values.internal ?? 0;

  const loop = isSingleLoop(netlist);
  const dcSource = sources.find((e) => e.kind !== 'ac');
  const emf = dcSource
    ? dcSource.kind === 'battery'
      ? dcSource.values.emf * Math.max(1, Math.round(dcSource.values.cells))
      : dcSource.values.emf
    : 0;

  // ---- series RLC ------------------------------------------------------
  if (loop && caps.length === 1 && inds.length === 1 && !nonlinear && sources.length <= 1) {
    const l = inds[0].values.inductance;
    const c = caps[0].values.capacitance;
    const alpha = resistance / (2 * l);
    const omega0 = 1 / Math.sqrt(l * c);
    const zeta = alpha / omega0;
    const regime = zeta < 1 ? 'underdamped' : zeta > 1 ? 'overdamped' : 'critically damped';
    const equations = [
      String.raw`L\frac{d^2q}{dt^2} + R\frac{dq}{dt} + \frac{q}{C} = V`,
      String.raw`\omega_0 = \frac{1}{\sqrt{LC}},\qquad \alpha = \frac{R}{2L},\qquad \zeta = \frac{\alpha}{\omega_0}`,
    ];
    if (zeta < 1) equations.push(String.raw`v_C(t) = V\left[1 - e^{-\alpha t}\left(\cos\omega_d t + \frac{\alpha}{\omega_d}\sin\omega_d t\right)\right]`);

    const omegaD = zeta < 1 ? Math.sqrt(omega0 * omega0 - alpha * alpha) : 0;
    const startsEmpty = Math.abs(caps[0].values.initial ?? 0) < 1e-12 && Math.abs(inds[0].values.initial ?? 0) < 1e-12;
    return {
      title: `Series RLC — ${regime}`,
      equations,
      quantities: [
        { label: 'Resonant frequency', value: omega0 / (2 * Math.PI), unit: 'Hz' },
        { label: 'Damping ratio ζ', value: zeta, unit: '' },
        ...(zeta < 1
          ? [
              { label: 'Ringing frequency', value: omegaD / (2 * Math.PI), unit: 'Hz' },
              { label: 'Q factor', value: 1 / (2 * zeta), unit: '' },
              { label: 'Decay time 1/α', value: 1 / alpha, unit: 's' },
            ]
          : []),
        { label: 'Critical resistance', value: 2 * Math.sqrt(l / c), unit: 'Ω' },
      ],
      overlay:
        dcSource && zeta < 1 && startsEmpty
          ? {
              kind: 'voltage',
              target: caps[0].id,
              label: 'Analytic solution',
              fn: (t) =>
                emf * (1 - Math.exp(-alpha * t) * (Math.cos(omegaD * t) + (alpha / omegaD) * Math.sin(omegaD * t))),
            }
          : null,
      caveat: `Raise the resistance past ${(2 * Math.sqrt(l / c)).toPrecision(3)} Ω and the ringing disappears entirely — that is the critical damping boundary, and it is worth dragging the slider through it to watch.`,
    };
  }

  // ---- series RC -------------------------------------------------------
  if (loop && caps.length === 1 && !inds.length && !nonlinear && sources.length <= 1) {
    const c = caps[0].values.capacitance;
    const tau = resistance * c;
    const initial = caps[0].values.initial ?? 0;
    const charging = !!dcSource;
    return {
      title: charging ? 'RC charging' : 'RC discharge',
      equations: [
        String.raw`RC\frac{dV_C}{dt} + V_C = V`,
        charging
          ? String.raw`V_C(t) = V\left(1 - e^{-t/\tau}\right)`
          : String.raw`V_C(t) = V_0\,e^{-t/\tau}`,
        String.raw`\tau = RC,\qquad Q = CV`,
      ],
      quantities: [
        { label: 'Total resistance', value: resistance, unit: 'Ω' },
        { label: 'Time constant τ', value: tau, unit: 's' },
        { label: 'Half-life τ ln2', value: tau * Math.LN2, unit: 's' },
        { label: 'Reaches 99% after', value: tau * Math.log(100), unit: 's' },
        ...(charging
          ? [
              { label: 'Final charge', value: c * emf, unit: 'C' },
              { label: 'Energy stored ½CV²', value: 0.5 * c * emf * emf, unit: 'J' },
              { label: 'Energy lost in R', value: 0.5 * c * emf * emf, unit: 'J' },
            ]
          : [{ label: 'Initial charge', value: c * initial, unit: 'C' }]),
      ],
      overlay: {
        kind: 'voltage',
        target: caps[0].id,
        label: 'Analytic solution',
        fn: charging
          ? (t) => emf - (emf - initial) * Math.exp(-t / tau)
          : (t) => initial * Math.exp(-t / tau),
      },
      caveat: charging
        ? 'Exactly half the energy the cell supplies ends up as heat in the resistor, whatever its value — a result that surprises most people the first time they meet it, and one this circuit demonstrates directly.'
        : null,
    } as AnalyticResult;
  }

  // ---- series RL -------------------------------------------------------
  if (loop && inds.length === 1 && !caps.length && !nonlinear && sources.length <= 1) {
    const l = inds[0].values.inductance;
    const tau = l / Math.max(1e-9, resistance);
    const final = resistance > 0 ? emf / resistance : 0;
    return {
      title: 'RL circuit',
      equations: [
        String.raw`L\frac{dI}{dt} + RI = V`,
        String.raw`I(t) = \frac{V}{R}\left(1 - e^{-t/\tau}\right)`,
        String.raw`\tau = \frac{L}{R}`,
      ],
      quantities: [
        { label: 'Total resistance', value: resistance, unit: 'Ω' },
        { label: 'Time constant τ', value: tau, unit: 's' },
        { label: 'Final current', value: final, unit: 'A' },
        { label: 'Energy stored ½LI²', value: 0.5 * l * final * final, unit: 'J' },
      ],
      overlay: dcSource
        ? {
            kind: 'current',
            target: inds[0].id,
            label: 'Analytic solution',
            fn: (t) => final * (1 - Math.exp(-t / tau)),
          }
        : null,
      caveat: null,
    };
  }

  // ---- purely resistive ------------------------------------------------
  if (!caps.length && !inds.length && !nonlinear && dcSource) {
    if (loop) {
      const current = resistance > 0 ? emf / resistance : 0;
      const internal = dcSource.values.internal ?? 0;
      const equations = [
        String.raw`R_{\text{total}} = \sum R_i`,
        String.raw`I = \frac{\varepsilon}{R + r}`,
      ];
      if (internal > 0) equations.push(String.raw`V_{\text{terminal}} = \varepsilon - Ir`);
      const dividers = active.filter((e) => e.kind === 'resistor' || e.kind === 'bulb' || e.kind === 'thermistor');
      if (dividers.length === 2) {
        equations.push(String.raw`V_1 = \varepsilon\,\frac{R_1}{R_1 + R_2}`);
      }
      return {
        title: dividers.length === 2 ? 'Potential divider' : 'Series circuit',
        equations,
        quantities: [
          { label: 'Total resistance', value: resistance, unit: 'Ω' },
          { label: 'Current', value: current, unit: 'A' },
          ...(internal > 0
            ? [
                { label: 'Terminal voltage', value: emf - current * internal, unit: 'V' },
                { label: 'Lost volts', value: current * internal, unit: 'V' },
              ]
            : []),
          { label: 'Power from the source', value: emf * current, unit: 'W' },
        ],
        overlay: null,
        caveat:
          internal > 0
            ? 'The terminal voltage falls as the current rises — draw more current and the cell delivers less than its EMF. Maximum power reaches the load when the external resistance equals the internal resistance.'
            : null,
      };
    }
    return {
      title: 'Resistor network',
      equations: [
        String.raw`\text{series: } R = R_1 + R_2`,
        String.raw`\text{parallel: } \frac{1}{R} = \frac{1}{R_1} + \frac{1}{R_2}`,
      ],
      quantities: [{ label: 'Source EMF', value: emf, unit: 'V' }],
      overlay: null,
      caveat:
        'This network is not a single loop, so there is no one formula for it — but every node and loop equation still holds, and the readings on the right satisfy all of them simultaneously.',
    };
  }

  // ---- diode / LED with a series resistor ------------------------------
  if (loop && nonlinear === 1 && dcSource && !caps.length && !inds.length) {
    const part = active.find((e) => e.kind === 'diode' || e.kind === 'led');
    if (part) {
      const vf = part.values.forward;
      const seriesR = resistance;
      return {
        title: part.kind === 'led' ? 'LED with a series resistor' : 'Diode with a series resistor',
        equations: [
          String.raw`I = I_S\left(e^{V/nV_T} - 1\right)`,
          String.raw`I \approx \frac{\varepsilon - V_f}{R}`,
          String.raw`R = \frac{\varepsilon - V_f}{I_{\text{rated}}}`,
        ],
        quantities: [
          { label: 'Forward voltage', value: vf, unit: 'V' },
          { label: 'Series resistance', value: seriesR, unit: 'Ω' },
          { label: 'Estimated current', value: seriesR > 0 ? (emf - vf) / seriesR : 0, unit: 'A' },
          ...(part.kind === 'led'
            ? [
                {
                  label: 'Resistor for the rated current',
                  value: (emf - vf) / Math.max(1e-6, part.values.rating),
                  unit: 'Ω',
                },
              ]
            : []),
        ],
        overlay: null,
        caveat:
          'The estimate treats the junction as a fixed voltage drop; the simulation solves the full exponential, so the two differ by a few percent. That difference is what the exponential model is for.',
      };
    }
  }

  return GENERAL_CIRCUIT;
}
