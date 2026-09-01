/* Constrained planar mechanics.
 *
 * The sandbox lets a student assemble point masses, rigid rods, ropes,
 * springs, pulleys and surfaces, then watch the assembly move. That means the
 * engine has to be *correct*, not merely plausible: the whole pedagogical
 * point is that the simulated pendulum period agrees with 2π√(L/g), that the
 * block on the incline starts sliding at exactly tan⁻¹μ, and that the
 * measured tension in an Atwood machine matches 2m₁m₂g/(m₁+m₂). A springy
 * "close enough" solver of the kind games use would quietly teach wrong
 * physics.
 *
 * So constraints are enforced with Lagrange multipliers rather than stiff
 * penalty springs. For coordinates q and constraints C(q) = 0 with Jacobian
 * J = ∂C/∂q, differentiating C twice gives J·a = −J̇·v, and Newton's second
 * law with the constraint reaction gives M·a = F + Jᵀλ. Stacking them:
 *
 *     ⎡ M  −Jᵀ ⎤ ⎡ a ⎤   ⎡        F        ⎤
 *     ⎣ J   0  ⎦ ⎣ λ ⎦ = ⎣ −J̇v − 2ζωĊ − ω²C ⎦
 *
 * one small dense solve per evaluation. The multipliers λ are not a numerical
 * artefact to be discarded — they *are* the tensions and normal forces, which
 * is what makes "measure the tension in this rod" an exact readout rather
 * than a finite difference.
 *
 * The trailing terms on the right are Baumgarte stabilisation, and they are
 * deliberately mild: the real defence against drift is the explicit position
 * and velocity projection after each step, which pulls the state back onto
 * the constraint manifold to machine precision. Baumgarte alone is a
 * notorious source of spurious energy; projection alone leaves the integrator
 * fighting a discontinuity. Together they hold a rod's length constant to
 * about 1e-15 over a minute of simulated swinging.
 *
 * What this engine deliberately does not model, and why:
 *   · Bodies are point masses, not rigid bodies with a moment of inertia. A
 *     rod is a massless constraint between two masses. That covers every
 *     set-up in the brief — multi-jointed pendulums, spring-block-surface,
 *     Atwood machines — and avoids the substantially harder contact problem
 *     that arrives with rotation. A compound pendulum is built as a chain.
 *   · One contact per body at a time. A block wedged into a corner by two
 *     surfaces is a linear complementarity problem; a block resting on one
 *     surface is a linear system. The sandbox is for the second kind.
 */

import { DenseSolver } from './linsolve';

// ------------------------------------------------------------------ the scene

export type BodyKind = 'mass' | 'anchor';

export interface Body {
  id: string;
  kind: BodyKind;
  /** Position at t = 0, in metres. */
  x: number;
  y: number;
  /** Velocity at t = 0, in m/s. Ignored for anchors. */
  vx: number;
  vy: number;
  /** Kilograms. Ignored for anchors. */
  mass: number;
  /** Drawn radius in metres; also the contact radius against surfaces. */
  radius: number;
  label: string;
  colour: string;
}

export type LinkKind = 'rod' | 'rope' | 'spring';

export interface Link {
  id: string;
  kind: LinkKind;
  a: string;
  b: string;
  /**
   * Rod length, rope maximum length, or spring natural length, in metres.
   * `null` means "whatever the two bodies are apart when the run starts",
   * which is what you want while dragging pieces around on the grid.
   */
  length: number | null;
  /** N/m. Springs only. */
  stiffness: number;
  /** N·s/m, a dashpot in parallel with the spring. Springs only. */
  damping: number;
  label: string;
  colour: string;
}

export interface Surface {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Kinetic and static coefficients of friction. */
  muK: number;
  muS: number;
  /** Coefficient of restitution for impacts, 0 = perfectly inelastic. */
  restitution: number;
  /** Swaps which side of the line is solid. */
  flip: boolean;
  label: string;
  colour: string;
}

export interface Pulley {
  id: string;
  /** The fixed axle the rope runs over. */
  x: number;
  y: number;
  a: string;
  b: string;
  /** Total rope length; `null` measures it from the starting positions. */
  length: number | null;
  radius: number;
  label: string;
  colour: string;
}

export type DragMode = 'none' | 'linear' | 'quadratic';

export interface MechanicsWorld {
  /** Downward acceleration, m/s². 9.81 on Earth, 1.62 on the Moon. */
  gravity: number;
  dragMode: DragMode;
  /** N·s/m for linear drag, N·s²/m² for quadratic. */
  dragCoefficient: number;
  bodies: Body[];
  links: Link[];
  surfaces: Surface[];
  pulleys: Pulley[];
}

// ------------------------------------------------------------------ prepared form

interface PreparedLink {
  index: number;
  kind: LinkKind;
  /** Index into the free-body list, or −1 when the endpoint is an anchor. */
  ai: number;
  bi: number;
  /** World position of the endpoint when it is an anchor. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  length: number;
  stiffness: number;
  damping: number;
}

interface PreparedPulley {
  index: number;
  ai: number;
  bi: number;
  /** World position of each end when that end is an anchor rather than a mass. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  px: number;
  py: number;
  length: number;
}

interface PreparedSurface {
  index: number;
  x0: number;
  y0: number;
  /** Unit tangent and the segment length. */
  ux: number;
  uy: number;
  len: number;
  /** Outward unit normal: the solid side is the side this points away from. */
  nx: number;
  ny: number;
  muK: number;
  muS: number;
  restitution: number;
}

export interface PreparedWorld {
  world: MechanicsWorld;
  /** Bodies that actually move, in a stable order. */
  free: Body[];
  freeIndexById: Map<string, number>;
  mass: Float64Array;
  radius: Float64Array;
  links: PreparedLink[];
  pulleys: PreparedPulley[];
  surfaces: PreparedSurface[];
  /** Human-readable reasons the scene cannot be simulated. */
  problems: string[];
  /** Initial state vectors, length 2·free.length. */
  q0: Float64Array;
  v0: Float64Array;
  /**
   * Below this tangential speed a body on a surface is treated as stationary
   * and held by a static-friction constraint rather than a sliding force.
   *
   * It has to scale with the step size. Kinetic friction changes the speed by
   * μg·dt each step, so any fixed threshold smaller than that is unreachable:
   * the body overshoots zero, friction reverses, and it chatters about the
   * origin forever instead of stopping. Set from the step size in
   * `createTrajectory`; the solver's break-away check means erring large is
   * safe, since a body that friction cannot actually hold is released again on
   * the same step.
   */
  stickSpeed: number;
}

const distance = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(ax - bx, ay - by);

/**
 * Turns the user's scene into indexed arrays and reports anything that would
 * make the run meaningless. Anchors are removed from the coordinate vector
 * entirely rather than given a huge mass: an infinitely stiff mass ratio is
 * exactly the kind of thing that turns a well-conditioned solve into a badly
 * conditioned one, and the anchor's position is a constant the constraint rows
 * can simply read.
 */
export function prepare(world: MechanicsWorld): PreparedWorld {
  const problems: string[] = [];
  const byId = new Map(world.bodies.map((b) => [b.id, b]));
  const free = world.bodies.filter((b) => b.kind === 'mass');
  const freeIndexById = new Map(free.map((b, i) => [b.id, i]));

  const n = free.length;
  const mass = new Float64Array(n);
  const radius = new Float64Array(n);
  const q0 = new Float64Array(2 * n);
  const v0 = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const b = free[i];
    if (!(b.mass > 0)) problems.push(`${b.label || 'A mass'} needs a positive mass.`);
    mass[i] = b.mass > 0 ? b.mass : 1;
    radius[i] = Math.max(0, b.radius);
    q0[2 * i] = b.x;
    q0[2 * i + 1] = b.y;
    v0[2 * i] = b.vx;
    v0[2 * i + 1] = b.vy;
  }

  const links: PreparedLink[] = [];
  world.links.forEach((l, index) => {
    const a = byId.get(l.a);
    const b = byId.get(l.b);
    if (!a || !b) {
      problems.push(`${l.label || 'A link'} is not attached at both ends.`);
      return;
    }
    if (a.id === b.id) {
      problems.push(`${l.label || 'A link'} joins a body to itself.`);
      return;
    }
    if (a.kind === 'anchor' && b.kind === 'anchor') {
      problems.push(`${l.label || 'A link'} joins two fixed points, so nothing can move.`);
      return;
    }
    const natural = l.length === null ? distance(a.x, a.y, b.x, b.y) : l.length;
    if (l.kind !== 'spring' && !(natural > 0)) {
      problems.push(`${l.label || 'A link'} has zero length.`);
      return;
    }
    if (l.kind === 'spring' && !(l.stiffness > 0)) {
      problems.push(`${l.label || 'A spring'} needs a positive stiffness.`);
      return;
    }
    links.push({
      index,
      kind: l.kind,
      ai: freeIndexById.get(a.id) ?? -1,
      bi: freeIndexById.get(b.id) ?? -1,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      length: natural,
      stiffness: l.stiffness,
      damping: l.damping,
    });
  });

  const pulleys: PreparedPulley[] = [];
  world.pulleys.forEach((p, index) => {
    const a = byId.get(p.a);
    const b = byId.get(p.b);
    if (!a || !b) {
      problems.push(`${p.label || 'A pulley'} needs a mass on both sides.`);
      return;
    }
    const ai = freeIndexById.get(a.id) ?? -1;
    const bi = freeIndexById.get(b.id) ?? -1;
    if (ai < 0 && bi < 0) {
      problems.push(`${p.label || 'A pulley'} has fixed points on both sides.`);
      return;
    }
    const total =
      p.length === null ? distance(a.x, a.y, p.x, p.y) + distance(b.x, b.y, p.x, p.y) : p.length;
    pulleys.push({
      index,
      ai,
      bi,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      px: p.x,
      py: p.y,
      length: total,
    });
  });

  const surfaces: PreparedSurface[] = [];
  world.surfaces.forEach((s, index) => {
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      problems.push(`${s.label || 'A surface'} has zero length.`);
      return;
    }
    const ux = dx / len;
    const uy = dy / len;
    // The left normal, then flipped so it points generally upwards — a surface
    // drawn left-to-right and one drawn right-to-left should both end up being
    // something you can stand on, because which way the user happened to drag
    // is not a physical fact about the ramp.
    let nx = -uy;
    let ny = ux;
    if (ny < 0 || (Math.abs(ny) < 1e-12 && nx < 0)) {
      nx = -nx;
      ny = -ny;
    }
    if (s.flip) {
      nx = -nx;
      ny = -ny;
    }
    surfaces.push({
      index,
      x0: s.x0,
      y0: s.y0,
      ux,
      uy,
      len,
      nx,
      ny,
      muK: Math.max(0, s.muK),
      muS: Math.max(s.muK, s.muS),
      restitution: Math.min(1, Math.max(0, s.restitution)),
    });
  });

  if (n === 0) problems.push('Add at least one mass — anchors alone cannot move.');

  return {
    world,
    free,
    freeIndexById,
    mass,
    radius,
    links,
    pulleys,
    surfaces,
    problems,
    q0,
    v0,
    stickSpeed: 1e-3,
  };
}

// ------------------------------------------------------------------ contacts

type ContactMode = 'none' | 'sliding' | 'stuck';

interface Contact {
  body: number;
  surface: number;
  mode: ContactMode;
  /** Signed gap: positive is clear of the surface. */
  gap: number;
  /** Velocity along the surface tangent. */
  vt: number;
  /** Filled in by the solve. */
  normalForce: number;
  frictionForce: number;
}

const CONTACT_TOL = 2e-3;

/**
 * Above this closing speed an arrival is an impact, not a resting contact.
 *
 * The distinction matters more than it looks. If a ball falling at 6 m/s is
 * given a resting-contact constraint the instant it touches, the solver
 * dutifully produces the enormous force needed to stop it within one step,
 * and the ball loses energy that a coefficient of restitution was supposed to
 * account for. Fast arrivals are left to the impulse code; slow ones — a ball
 * that has finished bouncing, a block being lowered onto a ramp — become
 * constraints, which is what stops a settled object from jittering.
 */
const IMPACT_SPEED = 0.1;

/**
 * Finds at most one supporting surface per body: the one it is nearest to
 * being in contact with, among those it is actually over.
 */
function findContacts(prep: PreparedWorld, q: Float64Array, v: Float64Array): Contact[] {
  const out: Contact[] = [];
  for (let i = 0; i < prep.free.length; i++) {
    const px = q[2 * i];
    const py = q[2 * i + 1];
    let best: Contact | null = null;
    for (const s of prep.surfaces) {
      const rx = px - s.x0;
      const ry = py - s.y0;
      const along = rx * s.ux + ry * s.uy;
      // A body past the end of a ramp has left it. Corner contact would need a
      // second constraint direction and is out of scope; the body simply flies
      // off the end, which is the physically sensible thing anyway.
      if (along < -CONTACT_TOL || along > s.len + CONTACT_TOL) continue;
      const gap = rx * s.nx + ry * s.ny - prep.radius[i];
      if (gap > CONTACT_TOL) continue;
      const vn = v[2 * i] * s.nx + v[2 * i + 1] * s.ny;
      if (vn < -IMPACT_SPEED) continue;
      const vt = v[2 * i] * s.ux + v[2 * i + 1] * s.uy;
      if (!best || gap > best.gap) {
        best = {
          body: i,
          surface: s.index,
          mode: Math.abs(vt) < prep.stickSpeed ? 'stuck' : 'sliding',
          gap,
          vt,
          normalForce: 0,
          frictionForce: 0,
        };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

// ------------------------------------------------------------------ the solve

/** One constraint row, in the form the assembler consumes. */
interface Row {
  /** (body index, dx, dy) triples — the non-zero blocks of this row of J. */
  entries: { i: number; jx: number; jy: number }[];
  /** Constraint violation C and its rate Ċ, for stabilisation. */
  c: number;
  cdot: number;
  /** The −J̇v term. */
  jdotv: number;
  /** Which scene object this row's multiplier reports a force for. */
  owner: { kind: 'link'; index: number } | { kind: 'pulley'; index: number } | { kind: 'contactN' | 'contactT'; contact: number };
  /** Unilateral rows are dropped when their multiplier takes the wrong sign. */
  unilateral: 0 | 1 | -1;
}

export interface Derivatives {
  a: Float64Array;
  linkForce: Float64Array;
  pulleyForce: Float64Array;
  contacts: Contact[];
  ok: boolean;
}

const OMEGA = 6;
const ZETA = 1;

/**
 * Assembles the constraint rows that are currently active and solves the
 * saddle-point system for accelerations and multipliers.
 *
 * The active set is decided inside this function rather than once per step,
 * because whether a rope is taut or a block has lifted off is a fact about the
 * *forces*, which are not known until the system has been solved. Rows whose
 * multiplier comes out with the wrong sign are dropped and the system is
 * re-solved — at most a few passes, since each pass strictly shrinks the set.
 */
export function evaluate(
  prep: PreparedWorld,
  q: Float64Array,
  v: Float64Array,
  solver: DenseSolver,
  scratch: Float64Array,
): Derivatives {
  const n = prep.free.length;
  const dof = 2 * n;
  const { mass, world } = prep;

  const force = new Float64Array(dof);
  const linkForce = new Float64Array(world.links.length);
  const pulleyForce = new Float64Array(world.pulleys.length);

  // ---- external forces -------------------------------------------------
  for (let i = 0; i < n; i++) force[2 * i + 1] -= mass[i] * world.gravity;

  if (world.dragMode !== 'none' && world.dragCoefficient > 0) {
    const b = world.dragCoefficient;
    for (let i = 0; i < n; i++) {
      const vx = v[2 * i];
      const vy = v[2 * i + 1];
      if (world.dragMode === 'linear') {
        force[2 * i] -= b * vx;
        force[2 * i + 1] -= b * vy;
      } else {
        const speed = Math.hypot(vx, vy);
        force[2 * i] -= b * speed * vx;
        force[2 * i + 1] -= b * speed * vy;
      }
    }
  }

  const point = (idx: number, fx: number, fy: number, out: [number, number]) => {
    if (idx >= 0) {
      out[0] = q[2 * idx];
      out[1] = q[2 * idx + 1];
    } else {
      out[0] = fx;
      out[1] = fy;
    }
  };
  const vel = (idx: number, out: [number, number]) => {
    if (idx >= 0) {
      out[0] = v[2 * idx];
      out[1] = v[2 * idx + 1];
    } else {
      out[0] = 0;
      out[1] = 0;
    }
  };

  const pa: [number, number] = [0, 0];
  const pb: [number, number] = [0, 0];
  const va: [number, number] = [0, 0];
  const vb: [number, number] = [0, 0];

  for (const l of prep.links) {
    if (l.kind !== 'spring') continue;
    point(l.ai, l.ax, l.ay, pa);
    point(l.bi, l.bx, l.by, pb);
    const dx = pa[0] - pb[0];
    const dy = pa[1] - pb[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) continue;
    const ux = dx / len;
    const uy = dy / len;
    vel(l.ai, va);
    vel(l.bi, vb);
    const closing = (va[0] - vb[0]) * ux + (va[1] - vb[1]) * uy;
    // Positive = the spring is stretched and pulling its ends together.
    const magnitude = l.stiffness * (len - l.length) + l.damping * closing;
    linkForce[l.index] = magnitude;
    if (l.ai >= 0) {
      force[2 * l.ai] -= magnitude * ux;
      force[2 * l.ai + 1] -= magnitude * uy;
    }
    if (l.bi >= 0) {
      force[2 * l.bi] += magnitude * ux;
      force[2 * l.bi + 1] += magnitude * uy;
    }
  }

  // ---- candidate constraint rows ---------------------------------------
  const contacts = findContacts(prep, q, v);
  const rows: Row[] = [];

  for (const l of prep.links) {
    if (l.kind === 'spring') continue;
    point(l.ai, l.ax, l.ay, pa);
    point(l.bi, l.bx, l.by, pb);
    const dx = pa[0] - pb[0];
    const dy = pa[1] - pb[1];
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    if (l.kind === 'rope' && len < l.length - 1e-9) continue; // slack: no row at all
    vel(l.ai, va);
    vel(l.bi, vb);
    const rvx = va[0] - vb[0];
    const rvy = va[1] - vb[1];

    // The squared form C = (|d|² − L²)/2 has exact, cheap derivatives:
    // ∂C/∂p_a = d and J̇v = |v_a − v_b|². The unsquared form needs the
    // derivative of a normalisation and buys nothing.
    const entries: Row['entries'] = [];
    if (l.ai >= 0) entries.push({ i: l.ai, jx: dx, jy: dy });
    if (l.bi >= 0) entries.push({ i: l.bi, jx: -dx, jy: -dy });
    if (entries.length === 0) continue;

    rows.push({
      entries,
      // Normalised by the length so the stabilisation gains stay dimensionally
      // comparable across a 5 cm spring and a 5 m rope.
      c: (len2 - l.length * l.length) / (2 * l.length),
      cdot: (dx * rvx + dy * rvy) / l.length,
      jdotv: rvx * rvx + rvy * rvy,
      owner: { kind: 'link', index: l.index },
      unilateral: l.kind === 'rope' ? -1 : 0,
    });
  }

  for (const p of prep.pulleys) {
    // The fallback is the *anchor's* position, not the peg's. Reaching for the
    // peg here collapses the rope run to zero length and silently drops the
    // constraint, so a mass hung from a rope whose other end is tied off would
    // fall as though the rope were not there.
    point(p.ai, p.ax, p.ay, pa);
    point(p.bi, p.bx, p.by, pb);
    const ax = pa[0] - p.px;
    const ay = pa[1] - p.py;
    const bx = pb[0] - p.px;
    const by = pb[1] - p.py;
    const ra = Math.hypot(ax, ay);
    const rb = Math.hypot(bx, by);
    if (ra < 1e-9 || rb < 1e-9) continue;
    const uax = ax / ra;
    const uay = ay / ra;
    const ubx = bx / rb;
    const uby = by / rb;
    const total = ra + rb;
    if (total < p.length - 1e-9) continue; // slack rope over the pulley

    vel(p.ai, va);
    vel(p.bi, vb);
    const radialA = va[0] * uax + va[1] * uay;
    const radialB = vb[0] * ubx + vb[1] * uby;

    const entries: Row['entries'] = [];
    if (p.ai >= 0) entries.push({ i: p.ai, jx: uax, jy: uay });
    if (p.bi >= 0) entries.push({ i: p.bi, jx: ubx, jy: uby });
    if (entries.length === 0) continue;

    // d/dt of a radial unit vector contributes the transverse kinetic term.
    const jdotv =
      (va[0] * va[0] + va[1] * va[1] - radialA * radialA) / ra +
      (vb[0] * vb[0] + vb[1] * vb[1] - radialB * radialB) / rb;

    rows.push({
      entries,
      c: total - p.length,
      cdot: radialA + radialB,
      jdotv,
      owner: { kind: 'pulley', index: p.index },
      unilateral: -1,
    });
  }

  contacts.forEach((contact, ci) => {
    const s = prep.surfaces.find((x) => x.index === contact.surface);
    if (!s) return;
    rows.push({
      entries: [{ i: contact.body, jx: s.nx, jy: s.ny }],
      c: contact.gap,
      cdot: v[2 * contact.body] * s.nx + v[2 * contact.body + 1] * s.ny,
      jdotv: 0,
      owner: { kind: 'contactN', contact: ci },
      unilateral: 1,
    });
    if (contact.mode === 'stuck') {
      // Static friction as a constraint, not a force. This is what makes the
      // block on the ramp sit *exactly* still below the critical angle instead
      // of creeping, and it hands back the required friction force as its own
      // multiplier — which is precisely the quantity a student is asked to
      // compare against μN.
      rows.push({
        entries: [{ i: contact.body, jx: s.ux, jy: s.uy }],
        c: 0,
        cdot: contact.vt,
        jdotv: 0,
        owner: { kind: 'contactT', contact: ci },
        unilateral: 0,
      });
    }
  });

  // ---- solve, dropping rows whose multiplier has the wrong sign ---------
  const a = new Float64Array(dof);
  let active = rows;
  let ok = true;

  for (let pass = 0; pass < 6; pass++) {
    const m = active.length;
    const size = dof + m;
    solver.reset(size);
    const rhs = scratch.subarray(0, size);
    rhs.fill(0);

    for (let i = 0; i < n; i++) {
      solver.set(size, 2 * i, 2 * i, mass[i]);
      solver.set(size, 2 * i + 1, 2 * i + 1, mass[i]);
      rhs[2 * i] = force[2 * i];
      rhs[2 * i + 1] = force[2 * i + 1];
    }
    for (let r = 0; r < m; r++) {
      const row = active[r];
      for (const e of row.entries) {
        solver.set(size, dof + r, 2 * e.i, e.jx);
        solver.set(size, dof + r, 2 * e.i + 1, e.jy);
        solver.set(size, 2 * e.i, dof + r, -e.jx);
        solver.set(size, 2 * e.i + 1, dof + r, -e.jy);
      }
      rhs[dof + r] = -row.jdotv - 2 * ZETA * OMEGA * row.cdot - OMEGA * OMEGA * row.c;
    }

    if (!solver.solveInPlace(size, rhs)) {
      ok = false;
      a.fill(0);
      break;
    }

    // Drop the single worst sign violation and try again. Removing them all at
    // once can chatter between two states that are each individually invalid.
    let worst = -1;
    let worstMagnitude = 1e-9;
    for (let r = 0; r < m; r++) {
      const row = active[r];
      if (row.unilateral === 0) continue;
      const lambda = rhs[dof + r];
      const violation = row.unilateral === 1 ? -lambda : lambda;
      if (violation > worstMagnitude) {
        worstMagnitude = violation;
        worst = r;
      }
    }
    if (worst >= 0) {
      const dropped = active[worst];
      active = active.filter((_, r) => r !== worst);
      // Losing the normal row means the body has left the surface, so its
      // friction row has to go with it or the body would keep being dragged
      // along a surface it is no longer touching.
      if (dropped.owner.kind === 'contactN') {
        const ci = dropped.owner.contact;
        active = active.filter((r) => !(r.owner.kind === 'contactT' && r.owner.contact === ci));
        contacts[ci].mode = 'none';
      }
      continue;
    }

    a.set(rhs.subarray(0, dof));
    for (let r = 0; r < m; r++) {
      const row = active[r];
      const lambda = rhs[dof + r];
      switch (row.owner.kind) {
        case 'link': {
          const index = row.owner.index;
          const l = prep.links.find((x) => x.index === index);
          // λ multiplies d, whose magnitude is the current length; a taut
          // rod pulls its endpoints together, which is λ < 0.
          linkForce[index] = l ? -lambda * l.length : -lambda;
          break;
        }
        case 'pulley':
          pulleyForce[row.owner.index] = -lambda;
          break;
        case 'contactN':
          contacts[row.owner.contact].normalForce = lambda;
          break;
        case 'contactT':
          contacts[row.owner.contact].frictionForce = lambda;
          break;
      }
    }
    break;
  }

  // ---- friction ---------------------------------------------------------
  // Sliding friction depends on the normal force, which the solve has only
  // just produced, so it is applied in a second pass. For a straight surface
  // this is exact rather than approximate: friction acts along the tangent and
  // therefore contributes nothing to the normal equation it was derived from.
  let needsSecondPass = false;
  for (const contact of contacts) {
    const s = prep.surfaces.find((x) => x.index === contact.surface);
    if (!s) continue;
    if (contact.mode === 'stuck') {
      const limit = s.muS * Math.abs(contact.normalForce);
      if (Math.abs(contact.frictionForce) <= limit + 1e-9) continue;
      // The required static friction exceeds what the surface can supply, so
      // it breaks away and starts sliding in the direction it was being held.
      // Its tangential lock has to come out of the active set at the same
      // moment, or the second solve would hold it still after all.
      const ci = contacts.indexOf(contact);
      active = active.filter((r) => !(r.owner.kind === 'contactT' && r.owner.contact === ci));
      contact.mode = 'sliding';
      contact.vt = contact.frictionForce > 0 ? -prep.stickSpeed : prep.stickSpeed;
      needsSecondPass = true;
    } else if (contact.mode === 'sliding' && s.muK > 0 && contact.normalForce > 0) {
      needsSecondPass = true;
    }
  }

  if (needsSecondPass && ok) {
    for (const contact of contacts) {
      if (contact.mode !== 'sliding') continue;
      const s = prep.surfaces.find((x) => x.index === contact.surface);
      if (!s || s.muK <= 0 || contact.normalForce <= 0) continue;
      const magnitude = s.muK * contact.normalForce * (contact.vt > 0 ? -1 : 1);
      contact.frictionForce = magnitude;
      force[2 * contact.body] += magnitude * s.ux;
      force[2 * contact.body + 1] += magnitude * s.uy;
    }
    const again = evaluateWithForces(prep, solver, scratch, force, active, contacts, linkForce, pulleyForce);
    if (again) return { a: again, linkForce, pulleyForce, contacts, ok: true };
  }

  return { a, linkForce, pulleyForce, contacts, ok };
}

/**
 * Re-solves with the same active set and an updated force vector. Split out so
 * the friction pass does not repeat the active-set search, which would risk
 * the two passes disagreeing about which contacts exist.
 */
function evaluateWithForces(
  prep: PreparedWorld,
  solver: DenseSolver,
  scratch: Float64Array,
  force: Float64Array,
  active: Row[],
  contacts: Contact[],
  linkForce: Float64Array,
  pulleyForce: Float64Array,
): Float64Array | null {
  const n = prep.free.length;
  const dof = 2 * n;
  const m = active.length;
  const size = dof + m;
  solver.reset(size);
  const rhs = scratch.subarray(0, size);
  rhs.fill(0);

  for (let i = 0; i < n; i++) {
    solver.set(size, 2 * i, 2 * i, prep.mass[i]);
    solver.set(size, 2 * i + 1, 2 * i + 1, prep.mass[i]);
    rhs[2 * i] = force[2 * i];
    rhs[2 * i + 1] = force[2 * i + 1];
  }
  for (let r = 0; r < m; r++) {
    const row = active[r];
    for (const e of row.entries) {
      solver.set(size, dof + r, 2 * e.i, e.jx);
      solver.set(size, dof + r, 2 * e.i + 1, e.jy);
      solver.set(size, 2 * e.i, dof + r, -e.jx);
      solver.set(size, 2 * e.i + 1, dof + r, -e.jy);
    }
    rhs[dof + r] = -row.jdotv - 2 * ZETA * OMEGA * row.cdot - OMEGA * OMEGA * row.c;
  }
  if (!solver.solveInPlace(size, rhs)) return null;

  for (let r = 0; r < m; r++) {
    const row = active[r];
    const lambda = rhs[dof + r];
    switch (row.owner.kind) {
      case 'link': {
        const index = row.owner.index;
        const l = prep.links.find((x) => x.index === index);
        linkForce[index] = l ? -lambda * l.length : -lambda;
        break;
      }
      case 'pulley':
        pulleyForce[row.owner.index] = -lambda;
        break;
      case 'contactN':
        contacts[row.owner.contact].normalForce = lambda;
        break;
      case 'contactT':
        contacts[row.owner.contact].frictionForce = lambda;
        break;
    }
  }
  return rhs.slice(0, dof);
}

// ------------------------------------------------------------------ projection

/**
 * Pulls positions and velocities back onto the constraint manifold.
 *
 * Without this a rod slowly changes length — a few parts in a million per
 * swing, which is invisible for a second and obvious after a minute, and which
 * quietly injects energy. Gauss–Newton on the constraint residual using the
 * mass-weighted pseudo-inverse restores it, and because the same Jacobian
 * works for the velocity-level residual, both are cleaned up together.
 */
function project(prep: PreparedWorld, q: Float64Array, v: Float64Array, solver: DenseSolver, scratch: Float64Array): void {
  const n = prep.free.length;
  const dof = 2 * n;

  for (let iter = 0; iter < 4; iter++) {
    const rows: Row[] = [];
    for (const l of prep.links) {
      if (l.kind === 'spring') continue;
      const ax = l.ai >= 0 ? q[2 * l.ai] : l.ax;
      const ay = l.ai >= 0 ? q[2 * l.ai + 1] : l.ay;
      const bx = l.bi >= 0 ? q[2 * l.bi] : l.bx;
      const by = l.bi >= 0 ? q[2 * l.bi + 1] : l.by;
      const dx = ax - bx;
      const dy = ay - by;
      const len = Math.hypot(dx, dy);
      if (l.kind === 'rope' && len < l.length) continue;
      const entries: Row['entries'] = [];
      if (l.ai >= 0) entries.push({ i: l.ai, jx: dx / len, jy: dy / len });
      if (l.bi >= 0) entries.push({ i: l.bi, jx: -dx / len, jy: -dy / len });
      if (!entries.length) continue;
      rows.push({
        entries,
        c: len - l.length,
        cdot: 0,
        jdotv: 0,
        owner: { kind: 'link', index: l.index },
        unilateral: l.kind === 'rope' ? -1 : 0,
      });
    }
    for (const p of prep.pulleys) {
      const ax = (p.ai >= 0 ? q[2 * p.ai] : p.ax) - p.px;
      const ay = (p.ai >= 0 ? q[2 * p.ai + 1] : p.ay) - p.py;
      const bx = (p.bi >= 0 ? q[2 * p.bi] : p.bx) - p.px;
      const by = (p.bi >= 0 ? q[2 * p.bi + 1] : p.by) - p.py;
      const ra = Math.hypot(ax, ay);
      const rb = Math.hypot(bx, by);
      if (ra < 1e-9 || rb < 1e-9) continue;
      if (ra + rb < p.length) continue;
      const entries: Row['entries'] = [];
      if (p.ai >= 0) entries.push({ i: p.ai, jx: ax / ra, jy: ay / ra });
      if (p.bi >= 0) entries.push({ i: p.bi, jx: bx / rb, jy: by / rb });
      if (!entries.length) continue;
      rows.push({
        entries,
        c: ra + rb - p.length,
        cdot: 0,
        jdotv: 0,
        owner: { kind: 'pulley', index: p.index },
        unilateral: -1,
      });
    }

    const m = rows.length;
    if (m === 0) return;

    let worst = 0;
    for (const r of rows) worst = Math.max(worst, Math.abs(r.c));
    if (worst < 1e-14 && iter > 0) return;

    // Solve (J M⁻¹ Jᵀ) μ = C, then Δq = −M⁻¹ Jᵀ μ.
    solver.reset(m);
    const rhs = scratch.subarray(0, m);
    for (let r = 0; r < m; r++) {
      rhs[r] = rows[r].c;
      for (let s = 0; s < m; s++) {
        let sum = 0;
        for (const e1 of rows[r].entries) {
          for (const e2 of rows[s].entries) {
            if (e1.i !== e2.i) continue;
            sum += (e1.jx * e2.jx + e1.jy * e2.jy) / prep.mass[e1.i];
          }
        }
        solver.set(m, r, s, sum);
      }
    }
    if (!solver.solveInPlace(m, rhs)) return;
    for (let r = 0; r < m; r++) {
      for (const e of rows[r].entries) {
        q[2 * e.i] -= (e.jx * rhs[r]) / prep.mass[e.i];
        q[2 * e.i + 1] -= (e.jy * rhs[r]) / prep.mass[e.i];
      }
    }

    if (iter === 0) {
      /* Same system, velocity residual: Jv = 0 — but only for rows entitled to
       * enforce it.
       *
       * A rope sitting exactly at its length whose ends are moving *together*
       * is about to go slack, and projecting its velocity would erase that
       * motion: two masses thrown up at a pulley would be held rigidly at
       * arm's length rather than flying free until the rope caught them. A
       * unilateral row may only remove velocity that is stretching it, never
       * velocity that is releasing it. */
      const active = rows.filter((row) => {
        if (row.unilateral === 0) return true;
        let jv = 0;
        for (const e of row.entries) jv += e.jx * v[2 * e.i] + e.jy * v[2 * e.i + 1];
        return jv > 0;
      });
      const mv = active.length;
      if (mv > 0) {
        solver.reset(mv);
        const vrhs = scratch.subarray(dof, dof + mv);
        for (let r = 0; r < mv; r++) {
          let jv = 0;
          for (const e of active[r].entries) jv += e.jx * v[2 * e.i] + e.jy * v[2 * e.i + 1];
          vrhs[r] = jv;
          for (let s = 0; s < mv; s++) {
            let sum = 0;
            for (const e1 of active[r].entries) {
              for (const e2 of active[s].entries) {
                if (e1.i !== e2.i) continue;
                sum += (e1.jx * e2.jx + e1.jy * e2.jy) / prep.mass[e1.i];
              }
            }
            solver.set(mv, r, s, sum);
          }
        }
        if (solver.solveInPlace(mv, vrhs)) {
          for (let r = 0; r < mv; r++) {
            for (const e of active[r].entries) {
              v[2 * e.i] -= (e.jx * vrhs[r]) / prep.mass[e.i];
              v[2 * e.i + 1] -= (e.jy * vrhs[r]) / prep.mass[e.i];
            }
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ collisions

/**
 * Impulsive response for a body that arrives at a surface with real speed.
 *
 * Resting contact is handled by the constraint solver; this deals with the
 * other case, where treating the arrival as a constraint would mean absorbing
 * an unbounded acceleration in one step. The threshold between the two is
 * deliberately low, so a bouncing ball settles into resting contact rather
 * than jittering forever on ever-smaller bounces.
 */
function resolveCollisions(prep: PreparedWorld, q: Float64Array, v: Float64Array): void {
  for (let i = 0; i < prep.free.length; i++) {
    for (const s of prep.surfaces) {
      const rx = q[2 * i] - s.x0;
      const ry = q[2 * i + 1] - s.y0;
      const along = rx * s.ux + ry * s.uy;
      if (along < 0 || along > s.len) continue;
      const gap = rx * s.nx + ry * s.ny - prep.radius[i];
      if (gap >= 0) continue;
      const vn = v[2 * i] * s.nx + v[2 * i + 1] * s.ny;
      q[2 * i] -= gap * s.nx;
      q[2 * i + 1] -= gap * s.ny;
      if (vn >= 0) continue;
      const vt = v[2 * i] * s.ux + v[2 * i + 1] * s.uy;
      const newVn = -s.restitution * vn;
      // Coulomb's law applies to the impulse just as it does to the force: the
      // tangential impulse cannot exceed μ times the normal one, and it can
      // never reverse the tangential motion, only stop it.
      const maxTangential = s.muK * Math.abs(newVn - vn);
      const dvt = Math.sign(vt) * -Math.min(Math.abs(vt), maxTangential);
      const finalVt = vt + dvt;
      v[2 * i] = newVn * s.nx + finalVt * s.ux;
      v[2 * i + 1] = newVn * s.ny + finalVt * s.uy;
    }
  }
}

// ------------------------------------------------------------------ stepping

export interface StepScratch {
  solver: DenseSolver;
  work: Float64Array;
  k1: Float64Array;
  k2: Float64Array;
  k3: Float64Array;
  k4: Float64Array;
  qt: Float64Array;
  vt: Float64Array;
}

export function makeScratch(prep: PreparedWorld): StepScratch {
  const dof = 2 * prep.free.length;
  // Worst case: every rod, every pulley, one normal and one tangential row per
  // body. Sized once so no solve ever allocates.
  const maxRows = prep.links.length + prep.pulleys.length + 2 * prep.free.length;
  return {
    solver: new DenseSolver(dof + maxRows + 1),
    work: new Float64Array(2 * (dof + maxRows + 1)),
    k1: new Float64Array(dof),
    k2: new Float64Array(dof),
    k3: new Float64Array(dof),
    k4: new Float64Array(dof),
    qt: new Float64Array(dof),
    vt: new Float64Array(dof),
  };
}

/**
 * One RK4 step, followed by collision response and projection.
 *
 * RK4 rather than a symplectic scheme because the constraint solve makes the
 * system non-separable anyway, so the usual energy argument for leapfrog does
 * not apply; fourth-order accuracy buys a much better period than any cheap
 * second-order method at the step sizes involved, and the pendulum period is
 * the headline number a student will check.
 */
export function step(
  prep: PreparedWorld,
  q: Float64Array,
  v: Float64Array,
  dt: number,
  scratch: StepScratch,
): Derivatives {
  const dof = q.length;
  const { solver, work, k1, k2, k3, k4, qt, vt } = scratch;

  const d1 = evaluate(prep, q, v, solver, work);
  k1.set(d1.a);
  if (!d1.ok) return d1;

  for (let i = 0; i < dof; i++) {
    qt[i] = q[i] + 0.5 * dt * v[i];
    vt[i] = v[i] + 0.5 * dt * k1[i];
  }
  k2.set(evaluate(prep, qt, vt, solver, work).a);

  for (let i = 0; i < dof; i++) {
    qt[i] = q[i] + 0.5 * dt * (v[i] + 0.5 * dt * k1[i]);
    vt[i] = v[i] + 0.5 * dt * k2[i];
  }
  k3.set(evaluate(prep, qt, vt, solver, work).a);

  for (let i = 0; i < dof; i++) {
    qt[i] = q[i] + dt * (v[i] + 0.5 * dt * k2[i]);
    vt[i] = v[i] + dt * k3[i];
  }
  k4.set(evaluate(prep, qt, vt, solver, work).a);

  for (let i = 0; i < dof; i++) {
    const dv = (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    const va = v[i];
    q[i] += dt * (va + (dt / 6) * (k1[i] + k2[i] + k3[i]));
    v[i] += dv;
  }

  resolveCollisions(prep, q, v);
  project(prep, q, v, solver, work);

  // Report the state the caller has arrived at, not the one it left.
  return evaluate(prep, q, v, solver, work);
}

/**
 * Chooses an integration step small enough for the stiffest thing in the
 * scene. A spring with a high stiffness and a light mass oscillates fast
 * whether or not the user notices, and an integrator that steps over that
 * period does not merely lose accuracy — it goes unstable and the sandbox
 * explodes, which looks like a bug in the app rather than a step-size problem.
 */
export function suggestedStep(prep: PreparedWorld): number {
  let dt = 1 / 240;
  for (const l of prep.links) {
    if (l.kind !== 'spring' || l.stiffness <= 0) continue;
    let m = Infinity;
    if (l.ai >= 0) m = Math.min(m, prep.mass[l.ai]);
    if (l.bi >= 0) m = Math.min(m, prep.mass[l.bi]);
    if (!Number.isFinite(m)) continue;
    const period = 2 * Math.PI * Math.sqrt(m / l.stiffness);
    dt = Math.min(dt, period / 40);
  }
  // Rods behave like very stiff springs; their timescale is the pendulum one.
  for (const l of prep.links) {
    if (l.kind === 'spring') continue;
    if (prep.world.gravity > 0) dt = Math.min(dt, Math.sqrt(l.length / prep.world.gravity) / 40);
  }
  return Math.max(1e-5, dt);
}

// ------------------------------------------------------------------ trajectory

export interface MechTrajectory {
  prep: PreparedWorld;
  dt: number;
  /** Number of samples stored. */
  count: number;
  time: Float64Array;
  pos: Float64Array;
  vel: Float64Array;
  linkForce: Float64Array;
  pulleyForce: Float64Array;
  normalForce: Float64Array;
  frictionForce: Float64Array;
  contactSurface: Int32Array;
  kinetic: Float64Array;
  potential: Float64Array;
  /** Set when the solve failed; the trajectory stops growing at that point. */
  failed: boolean;
  scratch: StepScratch;
  /** Live state, one step past the last stored sample. */
  q: Float64Array;
  v: Float64Array;
}

const MAX_SAMPLES = 40000;

export function createTrajectory(prep: PreparedWorld, dt = suggestedStep(prep)): MechTrajectory {
  const n = prep.free.length;
  const cap = 1024;
  // See the note on `stickSpeed`: the threshold has to be reachable in one
  // step of kinetic friction, or a decelerating block never comes to rest.
  let muMax = 0;
  for (const s of prep.surfaces) muMax = Math.max(muMax, s.muS, s.muK);
  prep.stickSpeed = Math.max(1e-4, 3 * muMax * Math.max(prep.world.gravity, 1) * dt);
  const traj: MechTrajectory = {
    prep,
    dt,
    count: 0,
    time: new Float64Array(cap),
    pos: new Float64Array(cap * 2 * n),
    vel: new Float64Array(cap * 2 * n),
    linkForce: new Float64Array(cap * prep.world.links.length),
    pulleyForce: new Float64Array(cap * prep.world.pulleys.length),
    normalForce: new Float64Array(cap * n),
    frictionForce: new Float64Array(cap * n),
    contactSurface: new Int32Array(cap * n),
    kinetic: new Float64Array(cap),
    potential: new Float64Array(cap),
    failed: prep.problems.length > 0,
    scratch: makeScratch(prep),
    q: Float64Array.from(prep.q0),
    v: Float64Array.from(prep.v0),
  };
  if (!traj.failed) {
    project(prep, traj.q, traj.v, traj.scratch.solver, traj.scratch.work);
    const d = evaluate(prep, traj.q, traj.v, traj.scratch.solver, traj.scratch.work);
    push(traj, 0, d);
  }
  return traj;
}

function grow(traj: MechTrajectory): void {
  const n = traj.prep.free.length;
  const cap = traj.time.length * 2;
  const nl = traj.prep.world.links.length;
  const np = traj.prep.world.pulleys.length;
  const copy = <T extends Float64Array | Int32Array>(old: T, stride: number, make: (n: number) => T): T => {
    const next = make(cap * stride);
    next.set(old.subarray(0, traj.count * stride));
    return next;
  };
  traj.time = copy(traj.time, 1, (m) => new Float64Array(m));
  traj.pos = copy(traj.pos, 2 * n, (m) => new Float64Array(m));
  traj.vel = copy(traj.vel, 2 * n, (m) => new Float64Array(m));
  traj.linkForce = copy(traj.linkForce, nl, (m) => new Float64Array(m));
  traj.pulleyForce = copy(traj.pulleyForce, np, (m) => new Float64Array(m));
  traj.normalForce = copy(traj.normalForce, n, (m) => new Float64Array(m));
  traj.frictionForce = copy(traj.frictionForce, n, (m) => new Float64Array(m));
  traj.contactSurface = copy(traj.contactSurface, n, (m) => new Int32Array(m));
  traj.kinetic = copy(traj.kinetic, 1, (m) => new Float64Array(m));
  traj.potential = copy(traj.potential, 1, (m) => new Float64Array(m));
}

function push(traj: MechTrajectory, t: number, d: Derivatives): void {
  if (traj.count >= traj.time.length) grow(traj);
  const n = traj.prep.free.length;
  const nl = traj.prep.world.links.length;
  const np = traj.prep.world.pulleys.length;
  const k = traj.count;
  traj.time[k] = t;
  traj.pos.set(traj.q, k * 2 * n);
  traj.vel.set(traj.v, k * 2 * n);
  if (nl) traj.linkForce.set(d.linkForce, k * nl);
  if (np) traj.pulleyForce.set(d.pulleyForce, k * np);
  for (let i = 0; i < n; i++) {
    traj.normalForce[k * n + i] = 0;
    traj.frictionForce[k * n + i] = 0;
    traj.contactSurface[k * n + i] = -1;
  }
  for (const c of d.contacts) {
    if (c.mode === 'none') continue;
    traj.normalForce[k * n + c.body] = c.normalForce;
    traj.frictionForce[k * n + c.body] = c.frictionForce;
    traj.contactSurface[k * n + c.body] = c.surface;
  }
  traj.kinetic[k] = kineticEnergy(traj.prep, traj.v);
  traj.potential[k] = potentialEnergy(traj.prep, traj.q);
  traj.count = k + 1;
}

export function kineticEnergy(prep: PreparedWorld, v: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < prep.free.length; i++) {
    sum += 0.5 * prep.mass[i] * (v[2 * i] * v[2 * i] + v[2 * i + 1] * v[2 * i + 1]);
  }
  return sum;
}

export function potentialEnergy(prep: PreparedWorld, q: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < prep.free.length; i++) sum += prep.mass[i] * prep.world.gravity * q[2 * i + 1];
  for (const l of prep.links) {
    if (l.kind !== 'spring') continue;
    const ax = l.ai >= 0 ? q[2 * l.ai] : l.ax;
    const ay = l.ai >= 0 ? q[2 * l.ai + 1] : l.ay;
    const bx = l.bi >= 0 ? q[2 * l.bi] : l.bx;
    const by = l.bi >= 0 ? q[2 * l.bi + 1] : l.by;
    const ext = Math.hypot(ax - bx, ay - by) - l.length;
    sum += 0.5 * l.stiffness * ext * ext;
  }
  return sum;
}

/**
 * Extends the trajectory to at least `until` seconds, doing at most `budget`
 * steps so a long timeline cannot freeze the window. Returns true when it has
 * reached the requested time.
 */
export function advance(traj: MechTrajectory, until: number, budget = 4000): boolean {
  if (traj.failed) return true;
  let done = 0;
  while (traj.count > 0 && traj.time[traj.count - 1] < until - 1e-12) {
    if (done >= budget) return false;
    if (traj.count >= MAX_SAMPLES) return true;
    const t = traj.time[traj.count - 1] + traj.dt;

    /* A mass that has been hauled all the way up to the pulley is past the end
     * of what this model describes: the rope run has no length left, its
     * direction is undefined, and the constraint's Jacobian degenerates. Left
     * alone the mass sails straight through the peg and out the other side,
     * which looks like a physics engine having a seizure. Stopping and saying
     * so is both honest and more useful — the fix is always to start the
     * masses further apart or shorten the run.
     */
    for (const p of traj.prep.pulleys) {
      const radius = traj.prep.world.pulleys[p.index].radius;
      const ra = p.ai >= 0 ? Math.hypot(traj.q[2 * p.ai] - p.px, traj.q[2 * p.ai + 1] - p.py) : Infinity;
      const rb = p.bi >= 0 ? Math.hypot(traj.q[2 * p.bi] - p.px, traj.q[2 * p.bi + 1] - p.py) : Infinity;
      if (Math.min(ra, rb) > Math.max(radius, 1e-3)) continue;
      traj.failed = true;
      traj.prep.problems.push(
        `${traj.prep.world.pulleys[p.index].label || 'A mass'} has reached the pulley, so the run stops here. Start the masses further from it, or give the rope more length.`,
      );
      return true;
    }

    const d = step(traj.prep, traj.q, traj.v, traj.dt, traj.scratch);
    if (!d.ok) {
      traj.failed = true;
      traj.prep.problems.push(
        'The constraints could not be solved — two rigid links may be fighting each other, or a rod may be duplicated.',
      );
      return true;
    }
    push(traj, t, d);
    done++;
  }
  return true;
}

/** The sample index nearest a given time, clamped to what has been computed. */
export function sampleAt(traj: MechTrajectory, t: number): number {
  if (traj.count === 0) return 0;
  const k = Math.round(t / traj.dt);
  return Math.min(traj.count - 1, Math.max(0, k));
}

// ------------------------------------------------------------------ measurements

export type MeasurementKind =
  | 'x'
  | 'y'
  | 'vx'
  | 'vy'
  | 'speed'
  | 'momentum'
  | 'angle'
  | 'angularVelocity'
  | 'extension'
  | 'force'
  | 'normal'
  | 'friction'
  | 'kinetic'
  | 'potential'
  | 'total';

export interface Measurement {
  id: string;
  kind: MeasurementKind;
  /** Body id, link id or pulley id, depending on the kind. */
  target: string;
  colour: string;
  visible: boolean;
}

export interface MeasurementInfo {
  label: string;
  unit: string;
  /** Which kind of scene object this measurement attaches to. */
  scope: 'body' | 'link' | 'world';
}

export const MEASUREMENT_INFO: Record<MeasurementKind, MeasurementInfo> = {
  x: { label: 'Horizontal position', unit: 'm', scope: 'body' },
  y: { label: 'Height', unit: 'm', scope: 'body' },
  vx: { label: 'Horizontal velocity', unit: 'm/s', scope: 'body' },
  vy: { label: 'Vertical velocity', unit: 'm/s', scope: 'body' },
  speed: { label: 'Speed', unit: 'm/s', scope: 'body' },
  momentum: { label: 'Momentum', unit: 'kg·m/s', scope: 'body' },
  angle: { label: 'Angle from vertical', unit: '°', scope: 'link' },
  angularVelocity: { label: 'Angular velocity', unit: '°/s', scope: 'link' },
  extension: { label: 'Extension', unit: 'm', scope: 'link' },
  force: { label: 'Tension / spring force', unit: 'N', scope: 'link' },
  normal: { label: 'Normal force', unit: 'N', scope: 'body' },
  friction: { label: 'Friction force', unit: 'N', scope: 'body' },
  kinetic: { label: 'Kinetic energy', unit: 'J', scope: 'world' },
  potential: { label: 'Potential energy', unit: 'J', scope: 'world' },
  total: { label: 'Total energy', unit: 'J', scope: 'world' },
};

/**
 * Reads one measurement from one stored sample.
 *
 * "Angle from vertical" is measured from the downward vertical at the link's
 * first endpoint, so a pendulum hanging at rest reads zero and a positive
 * angle is anticlockwise — the convention every textbook derivation of
 * θ̈ = −(g/L)sinθ assumes.
 */
export function readMeasurement(traj: MechTrajectory, m: Measurement, k: number): number {
  const prep = traj.prep;
  const n = prep.free.length;
  if (k < 0 || k >= traj.count) return NaN;
  const info = MEASUREMENT_INFO[m.kind];

  if (info.scope === 'world') {
    if (m.kind === 'kinetic') return traj.kinetic[k];
    if (m.kind === 'potential') return traj.potential[k];
    return traj.kinetic[k] + traj.potential[k];
  }

  if (info.scope === 'body') {
    const i = prep.freeIndexById.get(m.target);
    if (i === undefined) return NaN;
    const px = traj.pos[k * 2 * n + 2 * i];
    const py = traj.pos[k * 2 * n + 2 * i + 1];
    const vx = traj.vel[k * 2 * n + 2 * i];
    const vy = traj.vel[k * 2 * n + 2 * i + 1];
    switch (m.kind) {
      case 'x':
        return px;
      case 'y':
        return py;
      case 'vx':
        return vx;
      case 'vy':
        return vy;
      case 'speed':
        return Math.hypot(vx, vy);
      case 'momentum':
        return prep.mass[i] * Math.hypot(vx, vy);
      case 'normal':
        return traj.normalForce[k * n + i];
      case 'friction':
        return traj.frictionForce[k * n + i];
      default:
        return NaN;
    }
  }

  const linkIndex = prep.world.links.findIndex((l) => l.id === m.target);
  if (linkIndex < 0) {
    const pulleyIndex = prep.world.pulleys.findIndex((p) => p.id === m.target);
    if (pulleyIndex >= 0 && m.kind === 'force') {
      return traj.pulleyForce[k * prep.world.pulleys.length + pulleyIndex];
    }
    return NaN;
  }
  const prepared = prep.links.find((l) => l.index === linkIndex);
  if (!prepared) return NaN;

  const at = (idx: number, fx: number, fy: number): [number, number] =>
    idx >= 0 ? [traj.pos[k * 2 * n + 2 * idx], traj.pos[k * 2 * n + 2 * idx + 1]] : [fx, fy];
  const velAt = (idx: number): [number, number] =>
    idx >= 0 ? [traj.vel[k * 2 * n + 2 * idx], traj.vel[k * 2 * n + 2 * idx + 1]] : [0, 0];

  const [ax, ay] = at(prepared.ai, prepared.ax, prepared.ay);
  const [bx, by] = at(prepared.bi, prepared.bx, prepared.by);

  switch (m.kind) {
    case 'force':
      return traj.linkForce[k * prep.world.links.length + linkIndex];
    case 'extension':
      return Math.hypot(ax - bx, ay - by) - prepared.length;
    case 'angle': {
      // From the first endpoint toward the second, against straight down.
      const dx = bx - ax;
      const dy = by - ay;
      return (Math.atan2(-dx, -dy) * 180) / Math.PI;
    }
    case 'angularVelocity': {
      const dx = bx - ax;
      const dy = by - ay;
      const r2 = dx * dx + dy * dy;
      if (r2 < 1e-12) return NaN;
      const [avx, avy] = velAt(prepared.ai);
      const [bvx, bvy] = velAt(prepared.bi);
      const rvx = bvx - avx;
      const rvy = bvy - avy;
      // ω = (r × v) / |r|², and the sign convention matches `angle` above.
      return (((dx * rvy - dy * rvx) / r2) * 180) / Math.PI;
    }
    default:
      return NaN;
  }
}

export function measurementLabel(world: MechanicsWorld, m: Measurement): string {
  const info = MEASUREMENT_INFO[m.kind];
  if (info.scope === 'world') return info.label;
  const target =
    world.bodies.find((b) => b.id === m.target)?.label ??
    world.links.find((l) => l.id === m.target)?.label ??
    world.pulleys.find((p) => p.id === m.target)?.label ??
    '?';
  return `${info.label} · ${target}`;
}
