/* The periodic table, and what an atom of each element looks like.
 *
 * The measured properties are data (see `table.ts`). Everything else here is
 * derived, because deriving it is both shorter and safer than typing it: an
 * electron configuration written out 118 times has 118 chances to be wrong and
 * no way to notice, whereas one built from the Aufbau order plus a list of the
 * twenty elements that break it can be checked against the arithmetic — the
 * electrons have to add up to the atomic number, every time.
 *
 * The orbital pictures are hydrogen-like: real solutions of the Schrödinger
 * equation for one electron, at the n and l of the subshell being filled. They
 * are not the true multi-electron orbitals, which have no closed form, and the
 * mode says so. What they get right is the thing they are there to show — the
 * shape, the nodes, and where the electron density actually is.
 */

import { ELEMENT_ROWS } from './table';

export type Block = 's' | 'p' | 'd' | 'f';

export interface Subshell {
  n: number;
  l: number;
  /** 's', 'p', 'd' or 'f'. */
  letter: Block;
  electrons: number;
  label: string;
}

export interface Element {
  z: number;
  symbol: string;
  name: string;
  mass: number;
  /** Van der Waals radius in picometres; NaN where none is known. */
  radius: number;
  electronegativity: number;
  /** First ionisation energy, eV. */
  ionisation: number;
  affinity: number;
  melting: number;
  boiling: number;
  density: number;
  category: string;
  oxidation: string;
  discovered: string;
  group: number;
  period: number;
  block: Block;
  /** Filled subshells in filling order. */
  subshells: Subshell[];
  /** Electrons in each principal shell, K first. */
  shells: number[];
  /** e.g. "1s² 2s² 2p²". */
  configuration: string;
  /** e.g. "[He] 2s² 2p²". */
  shortConfiguration: string;
  /** Where to draw it: column 1–18, row 1–7 for the main block, 9 and 10 for
   * the lanthanides and actinides. */
  column: number;
  row: number;
}

const LETTERS: Block[] = ['s', 'p', 'd', 'f'];
const CAPACITY = [2, 6, 10, 14];

/** The Madelung (n + l, then n) order in which subshells fill. */
const FILLING: [number, number][] = [
  [1, 0],
  [2, 0],
  [2, 1],
  [3, 0],
  [3, 1],
  [4, 0],
  [3, 2],
  [4, 1],
  [5, 0],
  [4, 2],
  [5, 1],
  [6, 0],
  [4, 3],
  [5, 2],
  [6, 1],
  [7, 0],
  [5, 3],
  [6, 2],
  [7, 1],
];

/**
 * The elements that do not follow the Aufbau order, as the move they make.
 *
 * Written as "take this many from that subshell and put them in this one",
 * which is both how the exception is usually explained — a half-filled or full
 * d subshell is worth the promotion — and self-checking, since a move cannot
 * change the number of electrons.
 */
const EXCEPTIONS: Record<number, { from: string; to: string; count: number }> = {
  24: { from: '4s', to: '3d', count: 1 }, // Cr: a half-filled 3d⁵
  29: { from: '4s', to: '3d', count: 1 }, // Cu: a full 3d¹⁰
  41: { from: '5s', to: '4d', count: 1 }, // Nb
  42: { from: '5s', to: '4d', count: 1 }, // Mo
  44: { from: '5s', to: '4d', count: 1 }, // Ru
  45: { from: '5s', to: '4d', count: 1 }, // Rh
  46: { from: '5s', to: '4d', count: 2 }, // Pd: the only empty outer s shell
  47: { from: '5s', to: '4d', count: 1 }, // Ag
  57: { from: '4f', to: '5d', count: 1 }, // La
  58: { from: '4f', to: '5d', count: 1 }, // Ce
  64: { from: '4f', to: '5d', count: 1 }, // Gd: a half-filled 4f⁷
  78: { from: '6s', to: '5d', count: 1 }, // Pt
  79: { from: '6s', to: '5d', count: 1 }, // Au
  89: { from: '5f', to: '6d', count: 1 }, // Ac
  90: { from: '5f', to: '6d', count: 2 }, // Th
  91: { from: '5f', to: '6d', count: 1 }, // Pa
  92: { from: '5f', to: '6d', count: 1 }, // U
  93: { from: '5f', to: '6d', count: 1 }, // Np
  96: { from: '5f', to: '6d', count: 1 }, // Cm
  /* Lawrencium is [Rn]5f¹⁴7s²7p¹, not the 6d¹ that older tables give it. The
   * 7p assignment is what relativistic calculations predict and what the 2015
   * measurement of its ionisation energy confirmed; several widely-copied
   * datasets still carry the old value. */
  103: { from: '6d', to: '7p', count: 1 },
};

const SUPERSCRIPT = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
const superscript = (n: number): string =>
  String(n)
    .split('')
    .map((d) => SUPERSCRIPT[Number(d)])
    .join('');

/** Ground-state configuration of a neutral atom. */
export function buildSubshells(z: number): Subshell[] {
  const counts = new Map<string, number>();
  let left = z;
  for (const [n, l] of FILLING) {
    if (left <= 0) break;
    const take = Math.min(CAPACITY[l], left);
    counts.set(`${n}${LETTERS[l]}`, take);
    left -= take;
  }

  const exception = EXCEPTIONS[z];
  if (exception) {
    const from = counts.get(exception.from) ?? 0;
    const to = counts.get(exception.to) ?? 0;
    counts.set(exception.from, from - exception.count);
    counts.set(exception.to, to + exception.count);
  }

  const out: Subshell[] = [];
  for (const [n, l] of FILLING) {
    const key = `${n}${LETTERS[l]}`;
    const electrons = counts.get(key) ?? 0;
    if (electrons <= 0) continue;
    out.push({ n, l, letter: LETTERS[l], electrons, label: key });
  }
  return out;
}

/** Electrons per principal shell, K outwards. */
export function shellsOf(subshells: Subshell[]): number[] {
  const shells: number[] = [];
  for (const s of subshells) {
    while (shells.length < s.n) shells.push(0);
    shells[s.n - 1] += s.electrons;
  }
  return shells;
}

/** The last noble gas at or below z, for the shorthand configuration. */
const NOBLE = [2, 10, 18, 36, 54, 86];
const NOBLE_SYMBOL: Record<number, string> = { 2: 'He', 10: 'Ne', 18: 'Ar', 36: 'Kr', 54: 'Xe', 86: 'Rn' };

function writeConfiguration(subshells: Subshell[], from = 0): string {
  return subshells
    .filter((s) => s.n * 100 + s.l > from)
    .map((s) => `${s.label}${superscript(s.electrons)}`)
    .join(' ');
}

/** Group 1–18, or 0 for the two f-block rows, which have no group. */
export function groupOf(z: number): number {
  if (z === 1) return 1;
  if (z === 2) return 18;
  if ([3, 11, 19, 37, 55, 87].includes(z)) return 1;
  if ([4, 12, 20, 38, 56, 88].includes(z)) return 2;
  if ((z >= 57 && z <= 71) || (z >= 89 && z <= 103)) return 0;
  if (z >= 5 && z <= 10) return z + 8;
  if (z >= 13 && z <= 18) return z;
  if (z >= 21 && z <= 30) return z - 18;
  if (z >= 31 && z <= 36) return z - 18;
  if (z >= 39 && z <= 48) return z - 36;
  if (z >= 49 && z <= 54) return z - 36;
  if (z >= 72 && z <= 80) return z - 68;
  if (z >= 81 && z <= 86) return z - 68;
  if (z >= 104 && z <= 112) return z - 100;
  if (z >= 113 && z <= 118) return z - 100;
  return 0;
}

export function periodOf(z: number): number {
  if (z <= 2) return 1;
  if (z <= 10) return 2;
  if (z <= 18) return 3;
  if (z <= 36) return 4;
  if (z <= 54) return 5;
  if (z <= 86) return 6;
  return 7;
}

/**
 * Where the cell goes.
 *
 * The lanthanides and actinides are pulled out into their own rows, as they
 * are in every printed table — not to save space but because the alternative,
 * a thirty-two column table, makes the periodic *pattern* impossible to see on
 * a screen, which is the entire reason to draw the table rather than list it.
 */
export function layoutOf(z: number): { column: number; row: number } {
  if (z >= 57 && z <= 71) return { column: 3 + (z - 57), row: 9 };
  if (z >= 89 && z <= 103) return { column: 3 + (z - 89), row: 10 };
  return { column: groupOf(z), row: periodOf(z) };
}

function blockOf(subshells: Subshell[], z: number): Block {
  if ((z >= 57 && z <= 71) || (z >= 89 && z <= 103)) return 'f';
  const group = groupOf(z);
  if (group >= 3 && group <= 12) return 'd';
  if (group >= 13 || z === 2) return z === 2 ? 's' : 'p';
  if (group === 1 || group === 2) return 's';
  return subshells[subshells.length - 1]?.letter ?? 's';
}

function build(): Element[] {
  return ELEMENT_ROWS.map((row) => {
    const [z, symbol, name, mass, radius, electronegativity, ionisation, affinity, melting, boiling, density, category, oxidation, discovered] = row;
    const subshells = buildSubshells(z);
    const core = [...NOBLE].reverse().find((n) => n < z);
    const coreSubshells = core ? buildSubshells(core) : [];
    const highest = coreSubshells.reduce((m, s) => Math.max(m, s.n * 100 + s.l), 0);
    const { column, row: gridRow } = layoutOf(z);
    return {
      z,
      symbol,
      name,
      mass,
      radius,
      electronegativity,
      ionisation,
      affinity,
      melting,
      boiling,
      density,
      category,
      oxidation,
      discovered,
      group: groupOf(z),
      period: periodOf(z),
      block: blockOf(subshells, z),
      subshells,
      shells: shellsOf(subshells),
      configuration: writeConfiguration(subshells),
      shortConfiguration: core
        ? `[${NOBLE_SYMBOL[core]}] ${writeConfiguration(subshells, highest)}`
        : writeConfiguration(subshells),
      column,
      row: gridRow,
    };
  });
}

export const ELEMENTS: Element[] = build();
export const ELEMENT_BY_Z = new Map(ELEMENTS.map((e) => [e.z, e]));
export const ELEMENT_BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol, e]));

// ------------------------------------------------------------------ properties

export interface PropertyInfo {
  key: string;
  label: string;
  unit: string;
  /** NaN where the property has never been measured for that element. */
  of: (e: Element) => number;
  /** Low values are big atoms and high values are small ones, so the scale
   * reads correctly rather than upside down. */
  reversed?: boolean;
  /** Spread over orders of magnitude — colour on a log scale. */
  logarithmic?: boolean;
  hint: string;
}

export const PROPERTIES: PropertyInfo[] = [
  {
    key: 'mass',
    label: 'Relative atomic mass',
    unit: '',
    of: (e) => e.mass,
    hint: 'Rises almost, but not quite, monotonically — tellurium is heavier than iodine.',
  },
  {
    key: 'radius',
    label: 'Atomic radius',
    unit: 'pm',
    of: (e) => e.radius,
    hint: 'Falls across a period as the nuclear charge pulls the same shell inwards, and jumps at each new shell.',
  },
  {
    key: 'electronegativity',
    label: 'Electronegativity',
    unit: '',
    of: (e) => e.electronegativity,
    hint: 'Pauling scale. Fluorine at 3.98 is the maximum by construction; caesium is the least at 0.79.',
  },
  {
    key: 'ionisation',
    label: 'First ionisation energy',
    unit: 'eV',
    of: (e) => e.ionisation,
    hint: 'The sawtooth across each period is the shell structure: the dips are where a new subshell starts.',
  },
  {
    key: 'affinity',
    label: 'Electron affinity',
    unit: 'eV',
    of: (e) => e.affinity,
    hint: 'How much energy is released on gaining an electron. Blank where the anion is unbound.',
  },
  {
    key: 'melting',
    label: 'Melting point',
    unit: 'K',
    of: (e) => e.melting,
    hint: 'Peaks in the middle of each transition series, where the d electrons bond most strongly.',
  },
  {
    key: 'boiling',
    label: 'Boiling point',
    unit: 'K',
    of: (e) => e.boiling,
    hint: 'The noble gases sit at the bottom of every period.',
  },
  {
    key: 'density',
    label: 'Density',
    unit: 'g/cm³',
    of: (e) => e.density,
    logarithmic: true,
    hint: 'Osmium and iridium are the densest; the gases are four orders of magnitude below the metals.',
  },
  {
    key: 'discovered',
    label: 'Year discovered',
    unit: '',
    of: (e) => {
      const year = Number(e.discovered);
      // "Ancient" is a real answer, and drawing it as a blank would lose the
      // most striking thing about this map: the metals people have always had.
      return Number.isFinite(year) ? year : 1000;
    },
    hint: 'The elements known to antiquity are the ones found native or easily smelted.',
  },
];

export const PROPERTY_BY_KEY = new Map(PROPERTIES.map((p) => [p.key, p]));

export const CATEGORY_COLOURS: Record<string, string> = {
  'Alkali metal': '#f472b6',
  'Alkaline earth metal': '#fb923c',
  'Transition metal': '#facc15',
  'Post-transition metal': '#4ade80',
  Metalloid: '#2dd4bf',
  Nonmetal: '#38bdf8',
  Halogen: '#818cf8',
  'Noble gas': '#c084fc',
  Lanthanide: '#f87171',
  Actinide: '#e879f9',
};

// ------------------------------------------------------------------ orbitals

/** Associated Laguerre polynomial L^α_k(x), by the standard recurrence. */
function laguerre(k: number, alpha: number, x: number): number {
  let previous = 1;
  if (k === 0) return previous;
  let current = 1 + alpha - x;
  for (let i = 1; i < k; i++) {
    const next = ((2 * i + 1 + alpha - x) * current - (i + alpha) * previous) / (i + 1);
    previous = current;
    current = next;
  }
  return current;
}

function factorial(n: number): number {
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

/**
 * The radial part of a hydrogen-like orbital, in Bohr radii.
 *
 * Written out rather than approximated because the radial nodes are the point:
 * a 3s orbital with two nodes and a 2s with one is the difference between a
 * picture that teaches the quantum numbers and a picture of a fuzzy ball.
 */
export function radialWave(n: number, l: number, r: number, zEff = 1): number {
  const rho = (2 * zEff * r) / n;
  const norm = Math.sqrt(
    ((2 * zEff) / n) ** 3 * (factorial(n - l - 1) / (2 * n * factorial(n + l))),
  );
  return norm * Math.exp(-rho / 2) * rho ** l * laguerre(n - l - 1, 2 * l + 1, rho);
}

/**
 * The m = 0 real spherical harmonic, as a function of cos θ.
 *
 * One orbital per subshell rather than all of them: the m = 0 member is the
 * one whose cross-section shows the shape everybody draws — the p dumbbell,
 * the d cloverleaf with its ring — and drawing all five d orbitals at
 * once produces a sphere, which is true and useless.
 */
export function angularWave(l: number, cosTheta: number): number {
  const c = cosTheta;
  switch (l) {
    case 0:
      return 0.5 / Math.sqrt(Math.PI);
    case 1:
      return 0.5 * Math.sqrt(3 / Math.PI) * c;
    case 2:
      return 0.25 * Math.sqrt(5 / Math.PI) * (3 * c * c - 1);
    default:
      return 0.25 * Math.sqrt(7 / Math.PI) * (5 * c * c * c - 3 * c);
  }
}

export interface OrbitalSlice {
  /** Square raster of ψ, row-major, top row first. */
  values: Float64Array;
  size: number;
  /** Half-width of the slice in Bohr radii. */
  extent: number;
  peak: number;
}

/**
 * A slice through ψ in the xz-plane, for drawing.
 *
 * The extent is chosen from where the radial function actually falls away
 * rather than fixed: a 1s orbital inside a box sized for a 6s one is four
 * pixels across, and a 6s one inside a box sized for 1s is a solid square.
 */
export function orbitalSlice(n: number, l: number, size = 160, zEff = 1): OrbitalSlice {
  let extent = 1;
  for (let r = 0.5; r < 200; r += 0.5) {
    const value = Math.abs(radialWave(n, l, r, zEff)) * r;
    if (value > 1e-3) extent = r;
  }
  extent = Math.max(2, extent * 1.15);

  const values = new Float64Array(size * size);
  let peak = 0;
  for (let j = 0; j < size; j++) {
    const z = extent * (1 - (2 * (j + 0.5)) / size);
    for (let i = 0; i < size; i++) {
      const x = extent * ((2 * (i + 0.5)) / size - 1);
      const r = Math.hypot(x, z);
      if (r < 1e-9) continue;
      const value = radialWave(n, l, r, zEff) * angularWave(l, z / r);
      values[j * size + i] = value;
      peak = Math.max(peak, Math.abs(value));
    }
  }
  return { values, size, extent, peak: peak || 1 };
}
