/* Two ways a project survives without a server: the browser remembers the last
 * one, and a link carries a whole project inside itself.
 *
 * Neither needs an account, a database or a privacy policy, which is the
 * entire point. A student's work stays on their own machine, and a link they
 * send a friend contains the work rather than pointing at a copy of it that
 * someone has to host, back up and eventually delete.
 *
 * The link puts the project in the URL *fragment*, after the `#`. Fragments
 * are never sent to the server, so even a hosted copy of Manifold never
 * receives what anybody built — the browser strips it before the request goes
 * out. That is a stronger privacy guarantee than any policy could offer, and
 * it comes for free from where the data is put.
 */

import { deserialiseProject, serialiseProject, type LoadResult } from './serialize';
import type { ProjectFile } from './types';

const AUTOSAVE_KEY = 'manifold.session.v1';
const SHARE_PREFIX = '#p=';

/* Roughly where browsers and, more importantly, chat apps stop coping with a
 * URL. Beyond this the honest answer is "send the file instead" rather than a
 * link that silently truncates in the middle of a message. */
const MAX_SHARE_URL = 30_000;

// ------------------------------------------------------------------ encoding

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  // A chunked loop rather than spreading into String.fromCharCode: a project
  // of any size blows the argument limit and throws a RangeError that looks
  // like a corrupt document.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

async function through(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const hasCompression = () => typeof CompressionStream === 'function';

/**
 * Compresses text with raw deflate where the browser has it.
 *
 * A Manifold project is extremely repetitive JSON — every tab carries every
 * mode's settings — so deflate takes it down by roughly nine tenths, which is
 * the difference between a shareable link and one that will not fit in a
 * message. The `1` or `0` prefix records which of the two encodings was used,
 * so a link made in one browser opens in another.
 */
export async function encodeProject(project: ProjectFile): Promise<string> {
  const text = serialiseProject(project);
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  if (!hasCompression()) return `0${toBase64Url(bytes)}`;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return `1${toBase64Url(await through(stream))}`;
}

export async function decodeProject(payload: string): Promise<string> {
  const compressed = payload.startsWith('1');
  const bytes = fromBase64Url(payload.slice(1));
  if (!compressed) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot read compressed links. Try Chrome, Edge, Firefox or Safari 16.4 or newer.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await through(stream));
}

// ------------------------------------------------------------------ links

export interface ShareResult {
  url: string;
  /** Length in characters, so the caller can say how big it turned out. */
  length: number;
  tooLong: boolean;
}

export async function buildShareUrl(project: ProjectFile): Promise<ShareResult> {
  const payload = await encodeProject(project);
  const base = `${location.origin}${location.pathname}${location.search}`;
  const url = `${base}${SHARE_PREFIX}${payload}`;
  return { url, length: url.length, tooLong: url.length > MAX_SHARE_URL };
}

/** The project a link carries, if this page was opened from one. */
export function pendingSharePayload(): string | null {
  const hash = location.hash;
  return hash.startsWith(SHARE_PREFIX) ? hash.slice(SHARE_PREFIX.length) : null;
}

/**
 * Takes the shared project out of the address bar once it has been loaded.
 *
 * Leaving it there means a refresh silently throws away everything done since
 * the link was opened and starts again from the sender's version — which looks
 * exactly like the app losing your work.
 */
export function clearSharePayload(): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

// ------------------------------------------------------------------ autosave

export interface RestoredSession {
  result: LoadResult;
  savedAt: number;
}

/**
 * Writes the project to local storage.
 *
 * Returns false when it did not fit — a project with a large imported dataset
 * can exceed the five-megabyte quota — so the caller can say so once rather
 * than failing silently every second for the rest of the session.
 */
export function writeAutosave(project: ProjectFile): boolean {
  try {
    localStorage.setItem(
      AUTOSAVE_KEY,
      JSON.stringify({ savedAt: Date.now(), project: serialiseProject(project) }),
    );
    return true;
  } catch {
    return false;
  }
}

export function readAutosave(): RestoredSession | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number; project?: string };
    if (typeof parsed.project !== 'string') return null;
    return { result: deserialiseProject(parsed.project), savedAt: parsed.savedAt ?? 0 };
  } catch {
    // A half-written or outdated entry should never stop the app from opening.
    return null;
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* Private browsing can refuse; there is nothing to do about it and nothing
     * to tell the user, since the failure means their work was never stored. */
  }
}
