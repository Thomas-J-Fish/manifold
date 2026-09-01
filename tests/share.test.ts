import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAutosave,
  decodeProject,
  encodeProject,
  readAutosave,
  writeAutosave,
} from '../src/core/share';
import { makeProject, makeTab } from '../src/core/defaults';
import { deserialiseProject } from '../src/core/serialize';
import { EXAMPLES } from '../src/core/examples';
import type { ProjectFile } from '../src/core/types';

/* The link is the whole distribution mechanism for the web version: someone
 * sends it, someone else opens it, and if the encoding is wrong the recipient
 * sees a corrupt-file error for work that was perfectly fine when it left. So
 * it gets the same treatment as the physics — round-trip everything, including
 * the awkward inputs. */

function withTabs(...builders: (() => ProjectFile['tabs'][number])[]): ProjectFile {
  const project = makeProject();
  project.tabs = builders.map((b) => b());
  project.activeTabId = project.tabs[0].id;
  return project;
}

describe('share links', () => {
  it('round-trips a project exactly', async () => {
    const project = withTabs(
      () => EXAMPLES.find((e) => e.id === 'double-pendulum')!.build(),
      () => EXAMPLES.find((e) => e.id === 'rlc-ringing')!.build(),
      () => makeTab('statistics'),
    );
    project.meta.title = 'Shared work';

    const payload = await encodeProject(project);
    const { project: back, warnings } = deserialiseProject(await decodeProject(payload));

    expect(warnings).toEqual([]);
    expect(back.meta.title).toBe('Shared work');
    expect(back.tabs).toHaveLength(3);
    expect(back.tabs[0].mechanics.world).toEqual(project.tabs[0].mechanics.world);
    expect(back.tabs[1].circuits.world).toEqual(project.tabs[1].circuits.world);
  });

  it('compresses far enough to fit in a message', async () => {
    // Five tabs is a realistic piece of work, and every tab carries every
    // mode's settings — so the raw JSON is large and extremely repetitive,
    // which is exactly what deflate is good at. Without compression this would
    // not fit in a URL at all.
    const project = withTabs(
      () => makeTab('graphing'),
      () => makeTab('statistics'),
      () => makeTab('mechanics'),
      () => makeTab('circuits'),
      () => makeTab('monte-carlo'),
    );
    const raw = JSON.stringify(project).length;
    const encoded = (await encodeProject(project)).length;

    expect(raw).toBeGreaterThan(20_000);
    // Comfortably inside the 30,000-character ceiling the share dialog warns
    // at, and about a seventh of the raw size.
    expect(encoded).toBeLessThan(8_000);
    expect(encoded / raw).toBeLessThan(0.2);
  });

  it('survives characters that are not ASCII', async () => {
    const project = makeProject();
    project.meta.title = 'Pendel — θ₀ = 45°, naïve';
    project.meta.notes = 'μₖ = 0.25 · ∫ f(x) dx · 日本語';
    project.tabs[0].name = 'θ vs t';

    const back = deserialiseProject(await decodeProject(await encodeProject(project))).project;
    expect(back.meta.title).toBe('Pendel — θ₀ = 45°, naïve');
    expect(back.meta.notes).toBe('μₖ = 0.25 · ∫ f(x) dx · 日本語');
    expect(back.tabs[0].name).toBe('θ vs t');
  });

  it('produces a payload that is safe in a URL', async () => {
    const payload = await encodeProject(makeProject());
    // Base64url: no +, / or =, so nothing needs escaping and nothing is lost
    // by a chat client that decides to "helpfully" tidy the link.
    expect(payload).toMatch(/^[01][A-Za-z0-9_-]*$/);
    expect(encodeURIComponent(payload)).toBe(payload);
  });

  it('reads a link made by a browser without compression', async () => {
    // The prefix byte records which encoding was used, so a link made in an
    // older browser still opens in a new one and vice versa.
    const project = makeProject();
    project.meta.title = 'Uncompressed';
    const json = JSON.stringify(
      JSON.parse(await decodeProject(await encodeProject(project))),
    );
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const legacy = `0${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

    const back = deserialiseProject(await decodeProject(legacy)).project;
    expect(back.meta.title).toBe('Uncompressed');
  });

  it('rejects a truncated link rather than opening half a project', async () => {
    const payload = await encodeProject(makeProject());
    await expect(decodeProject(payload.slice(0, Math.floor(payload.length / 2)))).rejects.toThrow();
  });
});

describe('autosave', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    // Node has no localStorage; the shim is enough to exercise the real code
    // path rather than mocking the module under test.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  it('writes and reads a project back', () => {
    const project = withTabs(() => EXAMPLES.find((e) => e.id === 'rc-charging')!.build());
    project.meta.title = 'Session';
    expect(writeAutosave(project)).toBe(true);

    const restored = readAutosave();
    expect(restored).not.toBeNull();
    expect(restored!.result.project.meta.title).toBe('Session');
    expect(restored!.result.project.tabs[0].circuits.world).toEqual(project.tabs[0].circuits.world);
    expect(restored!.savedAt).toBeGreaterThan(0);
  });

  it('returns nothing when there is nothing stored', () => {
    expect(readAutosave()).toBeNull();
  });

  it('survives a corrupted entry instead of refusing to start', () => {
    localStorage.setItem('manifold.session.v1', '{"project": "not json at all"');
    expect(readAutosave()).toBeNull();
    localStorage.setItem('manifold.session.v1', JSON.stringify({ project: 42 }));
    expect(readAutosave()).toBeNull();
  });

  it('reports a failure to store rather than throwing', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError');
        },
        removeItem: () => {},
      },
    });
    expect(writeAutosave(makeProject())).toBe(false);
  });

  it('clears cleanly', () => {
    writeAutosave(makeProject());
    clearAutosave();
    expect(readAutosave()).toBeNull();
  });
});
