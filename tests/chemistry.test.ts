import { describe, expect, it } from 'vitest';
import {
  CATEGORY_COLOURS,
  ELEMENTS,
  ELEMENT_BY_SYMBOL,
  ELEMENT_BY_Z,
  PROPERTIES,
  angularWave,
  buildSubshells,
  layoutOf,
  orbitalSlice,
  radialWave,
  shellsOf,
} from '../src/core/chemistry/elements';

/* The configurations are generated rather than typed, so the tests are about
 * the generator: the electrons have to add up, the shells have to be able to
 * hold them, and the twenty elements that break the Aufbau order have to break
 * it in the right direction. Every one of these was checked against an
 * independent dataset when the table was built; these keep it that way.
 */

describe('the table itself', () => {
  it('has all 118 elements exactly once', () => {
    expect(ELEMENTS).toHaveLength(118);
    expect(ELEMENTS.map((e) => e.z)).toEqual(Array.from({ length: 118 }, (_, i) => i + 1));
    expect(new Set(ELEMENTS.map((e) => e.symbol)).size).toBe(118);
    expect(ELEMENT_BY_SYMBOL.get('Fe')?.name).toBe('Iron');
    expect(ELEMENT_BY_Z.get(79)?.symbol).toBe('Au');
  });

  it('gives every element a colour and a place to sit', () => {
    const cells = new Set<string>();
    for (const e of ELEMENTS) {
      expect(CATEGORY_COLOURS[e.category]).toBeTruthy();
      const { column, row } = layoutOf(e.z);
      expect(column).toBeGreaterThanOrEqual(1);
      expect(column).toBeLessThanOrEqual(18);
      // No two elements in the same cell, which a layout built from arithmetic
      // can very easily produce and nobody would notice at a glance.
      const key = `${column},${row}`;
      expect(cells.has(key)).toBe(false);
      cells.add(key);
    }
  });

  it('puts the famous ones where they belong', () => {
    const at = (symbol: string) => ELEMENT_BY_SYMBOL.get(symbol)!;
    expect([at('H').group, at('H').period]).toEqual([1, 1]);
    expect([at('He').group, at('He').period]).toEqual([18, 1]);
    expect([at('C').group, at('C').period]).toEqual([14, 2]);
    expect([at('Fe').group, at('Fe').period]).toEqual([8, 4]);
    expect([at('Br').group, at('Br').period]).toEqual([17, 4]);
    expect(at('U').period).toBe(7);
    // The f-block has no group, and hangs below the table.
    expect(at('Nd').group).toBe(0);
    expect(layoutOf(60).row).toBe(9);
    expect(layoutOf(92).row).toBe(10);
    expect(at('Hf').group).toBe(4);
  });
});

describe('electron configurations', () => {
  it('accounts for exactly Z electrons, every time', () => {
    for (const e of ELEMENTS) {
      const total = e.subshells.reduce((sum, s) => sum + s.electrons, 0);
      expect(total).toBe(e.z);
      expect(e.shells.reduce((a, b) => a + b, 0)).toBe(e.z);
    }
  });

  it('never overfills a subshell or a shell', () => {
    const capacity = { s: 2, p: 6, d: 10, f: 14 } as const;
    for (const e of ELEMENTS) {
      for (const s of e.subshells) {
        expect(s.electrons).toBeGreaterThan(0);
        expect(s.electrons).toBeLessThanOrEqual(capacity[s.letter]);
      }
      e.shells.forEach((count, i) => {
        const n = i + 1;
        expect(count).toBeLessThanOrEqual(2 * n * n);
      });
    }
  });

  it('writes out the ones everybody knows', () => {
    const config = (symbol: string) => ELEMENT_BY_SYMBOL.get(symbol)!.configuration;
    expect(config('H')).toBe('1s¹');
    expect(config('He')).toBe('1s²');
    expect(config('C')).toBe('1s² 2s² 2p²');
    expect(config('Ne')).toBe('1s² 2s² 2p⁶');
    expect(config('Fe')).toBe('1s² 2s² 2p⁶ 3s² 3p⁶ 4s² 3d⁶');
    expect(ELEMENT_BY_SYMBOL.get('C')!.shortConfiguration).toBe('[He] 2s² 2p²');
    expect(ELEMENT_BY_SYMBOL.get('Fe')!.shortConfiguration).toBe('[Ar] 4s² 3d⁶');
  });

  it('breaks the Aufbau order exactly where the elements do', () => {
    const sub = (symbol: string, label: string) =>
      ELEMENT_BY_SYMBOL.get(symbol)!.subshells.find((s) => s.label === label)?.electrons ?? 0;
    // A half-filled d subshell is worth promoting an s electron for…
    expect([sub('Cr', '4s'), sub('Cr', '3d')]).toEqual([1, 5]);
    // …and so is a full one.
    expect([sub('Cu', '4s'), sub('Cu', '3d')]).toEqual([1, 10]);
    expect([sub('Ag', '5s'), sub('Ag', '4d')]).toEqual([1, 10]);
    expect([sub('Au', '6s'), sub('Au', '5d')]).toEqual([1, 10]);
    // Palladium is the only atom with no outer s electrons at all.
    expect([sub('Pd', '5s'), sub('Pd', '4d')]).toEqual([0, 10]);
    expect([sub('Gd', '4f'), sub('Gd', '5d')]).toEqual([7, 1]);
    expect([sub('U', '5f'), sub('U', '6d')]).toEqual([3, 1]);
    // Lawrencium ends in 7p, not the 6d that older tables give it.
    expect([sub('Lr', '6d'), sub('Lr', '7p')]).toEqual([0, 1]);
  });

  it('fills the shells 2, 8, 18, 32 for a heavy atom', () => {
    expect(ELEMENT_BY_SYMBOL.get('Ne')!.shells).toEqual([2, 8]);
    expect(ELEMENT_BY_SYMBOL.get('Ar')!.shells).toEqual([2, 8, 8]);
    expect(ELEMENT_BY_SYMBOL.get('Kr')!.shells).toEqual([2, 8, 18, 8]);
    expect(ELEMENT_BY_SYMBOL.get('Xe')!.shells).toEqual([2, 8, 18, 18, 8]);
    expect(ELEMENT_BY_SYMBOL.get('Rn')!.shells).toEqual([2, 8, 18, 32, 18, 8]);
  });

  it('is consistent between the generator and the table', () => {
    for (const e of ELEMENTS) {
      expect(shellsOf(buildSubshells(e.z))).toEqual(e.shells);
    }
  });
});

describe('measured properties', () => {
  const at = (symbol: string) => ELEMENT_BY_SYMBOL.get(symbol)!;

  it('has fluorine the most electronegative and caesium the least', () => {
    const known = ELEMENTS.filter((e) => Number.isFinite(e.electronegativity));
    const most = known.reduce((a, b) => (b.electronegativity > a.electronegativity ? b : a));
    const least = known.reduce((a, b) => (b.electronegativity < a.electronegativity ? b : a));
    expect(most.symbol).toBe('F');
    expect(most.electronegativity).toBeCloseTo(3.98, 2);
    expect(least.electronegativity).toBeLessThan(0.8);
  });

  it('has helium the hardest to ionise', () => {
    const known = ELEMENTS.filter((e) => Number.isFinite(e.ionisation));
    const hardest = known.reduce((a, b) => (b.ionisation > a.ionisation ? b : a));
    expect(hardest.symbol).toBe('He');
    expect(at('He').ionisation).toBeGreaterThan(24);
    expect(at('Cs').ionisation).toBeLessThan(4);
  });

  it('leaves a gap rather than a zero where nothing has been measured', () => {
    // Neon has no Pauling electronegativity, and drawing it as 0 would put it
    // at the bottom of the scale as if it were the least electronegative
    // element there is, which is the opposite of the truth.
    expect(Number.isNaN(at('Ne').electronegativity)).toBe(true);
    expect(Number.isNaN(at('Og').density)).toBe(true);
  });

  it('offers a property list that every element can be read through', () => {
    for (const p of PROPERTIES) {
      // Electron affinity is the sparsest: sixty-odd elements have no bound
      // anion to measure one for.
      const values = ELEMENTS.map((e) => p.of(e)).filter((v) => Number.isFinite(v));
      expect(values.length).toBeGreaterThan(50);
      expect(p.label.length).toBeGreaterThan(3);
      expect(p.hint.length).toBeGreaterThan(20);
    }
  });
});

describe('hydrogen-like orbitals', () => {
  it('normalises the radial function', () => {
    // ∫|R|²r² dr = 1 for every (n, l), which is the one check that catches a
    // wrong factorial in the normalisation constant.
    for (const [n, l] of [
      [1, 0],
      [2, 0],
      [2, 1],
      [3, 1],
      [3, 2],
      [4, 3],
    ] as [number, number][]) {
      let sum = 0;
      const dr = 0.002;
      for (let r = dr / 2; r < 200; r += dr) sum += radialWave(n, l, r) ** 2 * r * r * dr;
      expect(sum).toBeCloseTo(1, 4);
    }
  });

  it('gives each orbital n − l − 1 radial nodes', () => {
    for (const [n, l] of [
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [2, 1],
      [3, 1],
      [3, 2],
    ] as [number, number][]) {
      /* Counted by tracking the sign of the last non-zero sample rather than
       * by multiplying neighbours. R₂₀ has its node at exactly r = 2, which on
       * a grid of hundredths is a sample point, and a product test skips a
       * crossing that lands exactly on zero — reporting a nodeless 2s. */
      let crossings = 0;
      let sign = 0;
      for (let r = 0.01; r < 120; r += 0.01) {
        const value = radialWave(n, l, r);
        if (Math.abs(value) < 1e-14) continue;
        const next = value > 0 ? 1 : -1;
        if (sign !== 0 && next !== sign) crossings++;
        sign = next;
      }
      expect(crossings).toBe(n - l - 1);
    }
  });

  it('gives the angular parts their textbook shapes', () => {
    // s is isotropic; p vanishes in the plane and peaks along the axis; d has
    // its node at the magic angle where 3cos²θ = 1.
    expect(angularWave(0, 0)).toBeCloseTo(angularWave(0, 1), 12);
    expect(angularWave(1, 0)).toBeCloseTo(0, 12);
    expect(Math.abs(angularWave(1, 1))).toBeGreaterThan(0.4);
    expect(angularWave(2, Math.sqrt(1 / 3))).toBeCloseTo(0, 12);
    expect(angularWave(3, 0)).toBeCloseTo(0, 12);
  });

  it('renders a slice that fits the orbital it is drawing', () => {
    const small = orbitalSlice(1, 0, 60);
    const large = orbitalSlice(5, 0, 60);
    // A 5s orbital is far bigger than a 1s one, so the frame has to grow with
    // it or the picture is either four pixels wide or a solid square.
    expect(large.extent).toBeGreaterThan(small.extent * 4);
    expect(small.peak).toBeGreaterThan(0);
    // A p orbital changes sign across the plane; an s orbital does not.
    const p = orbitalSlice(2, 1, 40);
    let negative = 0;
    for (const v of p.values) if (v < -1e-9) negative++;
    expect(negative).toBeGreaterThan(50);
    let sNegative = 0;
    for (const v of orbitalSlice(1, 0, 40).values) if (v < -1e-9) sNegative++;
    expect(sNegative).toBe(0);
  });
});
