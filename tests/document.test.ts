/* Tests for the parts of the app that are not mathematics: axis formatting,
 * the project file format, and CSV round-tripping. These are the places where
 * a bug is silent — a wrong label or a dropped field looks like a plot until
 * you read it carefully. */

import { describe, expect, it } from 'vitest';
import { formatTick, formatPi, niceTicks, logTicks } from '../src/plot/scene';
import { deserialiseProject, ProjectFormatError, serialiseProject, toCsv } from '../src/core/serialize';
import { defaultViewport, makeExpression, makeProject, makeTab } from '../src/core/defaults';
import { MODES } from '../src/core/types';
import { parseDelimited } from '../src/core/math/fitting';

describe('axis formatting', () => {
  it('never turns 10 into 1', () => {
    // Trailing-zero stripping applied to an integer is the bug this locks down:
    // every axis in the app went from 10 to 1, and no numerical test saw it.
    expect(formatTick(10, 2)).toBe('10');
    expect(formatTick(-10, 2)).toBe('-10');
    expect(formatTick(100, 20)).toBe('100');
    expect(formatTick(2000, 500)).toBe('2000');
    expect(formatTick(0, 1)).toBe('0');
  });

  it('shows exactly the precision the step warrants', () => {
    expect(formatTick(0.5, 0.5)).toBe('0.5');
    expect(formatTick(0.25, 0.25)).toBe('0.25');
    expect(formatTick(1.5, 0.5)).toBe('1.5');
    expect(formatTick(3, 1)).toBe('3');
  });

  it('falls back to exponential notation at the extremes', () => {
    expect(formatTick(1.2e7, 1e6)).toMatch(/e7$/);
    expect(formatTick(1e-6, 1e-7)).toMatch(/e-6$/);
  });

  it('recognises multiples of π', () => {
    expect(formatPi(Math.PI, 1)).toBe('π');
    expect(formatPi(2 * Math.PI, 1)).toBe('2π');
    expect(formatPi(Math.PI / 2, 1)).toBe('π/2');
    expect(formatPi(-Math.PI / 4, 1)).toBe('−π/4');
    expect(formatPi(0, 1)).toBe('0');
  });

  it('chooses nice tick steps', () => {
    for (const [min, max] of [
      [0, 1],
      [-10, 10],
      [0, 0.003],
      [1000, 1200],
      [-1e6, 1e6],
    ]) {
      const { major, step } = niceTicks(min, max, 8);
      expect(major.length).toBeGreaterThan(2);
      expect(major.length).toBeLessThan(30);
      // Every tick is a whole number of steps from zero, and inside the range.
      for (const t of major) {
        expect(t).toBeGreaterThanOrEqual(min - step * 1e-6);
        expect(t).toBeLessThanOrEqual(max + step * 1e-6);
        expect(Math.abs(t / step - Math.round(t / step))).toBeLessThan(1e-6);
      }
    }
  });

  it('produces decade ticks on a log axis', () => {
    const ticks = logTicks(0.5, 1200);
    expect(ticks).toContain(1);
    expect(ticks).toContain(10);
    expect(ticks).toContain(100);
    expect(ticks).toContain(1000);
    expect(ticks.every((t) => t >= 0.5 && t <= 1200)).toBe(true);
  });
});

describe('project files', () => {
  it('round-trips a project without losing anything', () => {
    const project = makeProject();
    project.meta.title = 'Round trip';
    project.tabs.push(makeTab('statistics'), makeTab('monte-carlo'), makeTab('dynamics'));
    project.tabs[0].expressions.push(makeExpression('cos(x)/x', 'function', 2));
    project.tabs[1].statistics.distributionId = 'chisq';
    project.tabs[1].statistics.params = { df: 7 };
    project.tabs[2].monteCarlo.seed = 'abc123';
    project.tabs[3].dynamics.r = 3.8271;

    const { project: loaded, warnings } = deserialiseProject(serialiseProject(project));
    expect(warnings).toEqual([]);
    expect(loaded.meta.title).toBe('Round trip');
    expect(loaded.tabs.length).toBe(4);
    expect(loaded.tabs[1].statistics.distributionId).toBe('chisq');
    expect(loaded.tabs[1].statistics.params.df).toBe(7);
    expect(loaded.tabs[2].monteCarlo.seed).toBe('abc123');
    expect(loaded.tabs[3].dynamics.r).toBeCloseTo(3.8271, 10);
    expect(loaded.tabs[0].expressions.some((e) => e.source === 'cos(x)/x')).toBe(true);
  });

  it('tells a null that means something from a null that means damage', () => {
    /* The default decides. A field whose default is null is nullable and the
     * null is data — "nothing is selected", "no comparison distribution", "no
     * barrier" — and must come back as null rather than as whatever the
     * default happened to be. A field whose default is text is not nullable
     * and a null there is a broken file, so the default stands. */
    const project = makeProject();
    project.tabs = [makeTab('statistics'), makeTab('monte-carlo'), makeTab('waves')];
    project.activeTabId = project.tabs[0].id;
    project.tabs[0].statistics.compareId = 'lognormal';
    project.tabs[1].monteCarlo.barrier = 62.5;
    project.tabs[2].waves.selectedId = 'a';

    const first = deserialiseProject(serialiseProject(project)).project;
    expect(first.tabs[0].statistics.compareId).toBe('lognormal');
    expect(first.tabs[1].monteCarlo.barrier).toBeCloseTo(62.5, 10);
    expect(first.tabs[2].waves.selectedId).toBe('a');

    // Now clear all three and save again: the cleared state has to survive.
    first.tabs[0].statistics.compareId = null;
    first.tabs[1].monteCarlo.barrier = null;
    first.tabs[2].waves.selectedId = null;
    const second = deserialiseProject(serialiseProject(first)).project;
    expect(second.tabs[0].statistics.compareId).toBe(null);
    expect(second.tabs[1].monteCarlo.barrier).toBe(null);
    expect(second.tabs[2].waves.selectedId).toBe(null);

    // And a null where the default is text keeps the text.
    const damaged = JSON.parse(serialiseProject(second));
    damaged.tabs[0].name = null;
    damaged.tabs[0].statistics.distributionId = null;
    damaged.tabs[1].monteCarlo.seed = null;
    const third = deserialiseProject(JSON.stringify(damaged)).project;
    expect(typeof third.tabs[0].name).toBe('string');
    expect(third.tabs[0].statistics.distributionId).toBe('normal');
    expect(third.tabs[1].monteCarlo.seed).toBe('manifold');
  });

  it('fills in fields a older file never had', () => {
    // A project written before a feature existed must still open, with the
    // missing settings taking their defaults rather than becoming undefined.
    const minimal = JSON.stringify({
      format: 'manifold-project',
      version: 1,
      activeTabId: 'tab_old',
      tabs: [{ id: 'tab_old', name: 'Legacy', mode: 'graphing', expressions: [{ source: 'x^2' }] }],
    });
    const { project, warnings } = deserialiseProject(minimal);
    expect(project.tabs.length).toBe(1);
    expect(project.tabs[0].name).toBe('Legacy');
    expect(project.tabs[0].expressions[0].source).toBe('x^2');
    // Defaults that the file never mentioned:
    expect(project.tabs[0].timeline.tMax).toBeGreaterThan(0);
    expect(project.tabs[0].statistics.distributionId).toBe('normal');
    expect(project.tabs[0].viewport.xMax).toBeGreaterThan(project.tabs[0].viewport.xMin);
    expect(warnings.length).toBe(0);
  });

  it('warns about a newer format rather than refusing it', () => {
    const future = JSON.stringify({
      format: 'manifold-project',
      version: 99,
      activeTabId: 'a',
      tabs: [{ id: 'a', name: 'Future', mode: 'graphing' }],
    });
    const { project, warnings } = deserialiseProject(future);
    expect(project.tabs[0].name).toBe('Future');
    expect(warnings.some((w) => /newer version/.test(w))).toBe(true);
  });

  it('recovers from an unknown mode', () => {
    const odd = JSON.stringify({
      format: 'manifold-project',
      version: 1,
      activeTabId: 'a',
      tabs: [{ id: 'a', name: 'Odd', mode: 'quaternions' }],
    });
    const { project, warnings } = deserialiseProject(odd);
    expect(project.tabs[0].mode).toBe('graphing');
    expect(warnings.some((w) => /unknown mode/.test(w))).toBe(true);
  });

  it('rejects a file that is not a project at all', () => {
    expect(() => deserialiseProject('{"hello":"world"}')).toThrow(ProjectFormatError);
    expect(() => deserialiseProject('not json')).toThrow(ProjectFormatError);
  });

  it('gives every tab a unique id even when the file does not', () => {
    const duplicated = JSON.stringify({
      format: 'manifold-project',
      version: 1,
      activeTabId: '',
      tabs: [
        { id: '', name: 'One', mode: 'graphing' },
        { id: '', name: 'Two', mode: 'graphing' },
      ],
    });
    const { project } = deserialiseProject(duplicated);
    expect(project.tabs[0].id).not.toBe(project.tabs[1].id);
    expect(project.tabs[0].id.length).toBeGreaterThan(0);
  });

  it('gives every mode a sensible starting viewport', () => {
    for (const mode of MODES) {
      const v = defaultViewport(mode.id);
      expect(v.xMax).toBeGreaterThan(v.xMin);
      expect(v.yMax).toBeGreaterThan(v.yMin);
    }
  });

  it('survives non-finite numbers, which JSON cannot represent', () => {
    const project = makeProject();
    project.tabs[0].viewport.yMax = Infinity;
    const text = serialiseProject(project);
    expect(text).not.toMatch(/Infinity|NaN/);
    const { project: loaded } = deserialiseProject(text);
    expect(Number.isFinite(loaded.tabs[0].viewport.yMax)).toBe(true);
  });
});

describe('CSV', () => {
  it('quotes only what needs quoting, and round-trips', () => {
    const csv = toCsv(['a', 'b,c', 'd'], [[1, 'x', 'has "quotes"'], [2, 'y', 'plain']]);
    expect(csv.split('\n')[0]).toBe('a,"b,c",d');
    const parsed = parseDelimited(csv);
    expect(parsed.columns).toEqual(['a', 'b,c', 'd']);
    expect(parsed.rows[0][2]).toBe('has "quotes"');
    expect(parsed.rows[1][0]).toBe(2);
  });

  it('reads a headerless numeric table', () => {
    const parsed = parseDelimited('1,2\n3,4\n5,6');
    expect(parsed.rows.length).toBe(3);
    expect(parsed.numericColumns).toEqual([0, 1]);
    expect(parsed.columns[0]).toBe('Column 1');
  });

  it('detects tabs as the delimiter', () => {
    const parsed = parseDelimited('x\ty\n1\t2\n3\t4');
    expect(parsed.columns).toEqual(['x', 'y']);
    expect(parsed.rows[1]).toEqual([3, 4]);
  });
});
