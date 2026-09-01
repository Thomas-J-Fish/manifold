/* The renderer's view of the preload bridge.
 *
 * This declaration must stay in step with electron/preload.ts by hand — there
 * is no shared build between the two tsconfigs, and introducing one just to
 * share six type signatures would be a poor trade. Everything is optional at
 * the call site via `bridge()`, so the renderer also runs in a plain browser
 * (which is how `npm run dev` and the automated screenshots work).
 */

import { createWebBridge } from './webBridge';

export interface ManifoldBridge {
  openProject(): Promise<{ path: string; text: string } | null>;
  readProject(path: string): Promise<{ path: string; text: string }>;
  saveProject(args: { path: string | null; text: string; suggestedName?: string }): Promise<{ path: string } | null>;
  exportText(args: { defaultName: string; text: string; extensions: string[]; typeName: string }): Promise<{ path: string } | null>;
  exportBinary(args: { defaultName: string; dataUrl: string; extensions: string[]; typeName: string }): Promise<{ path: string } | null>;
  importText(args: { extensions: string[]; typeName: string }): Promise<{ path: string; text: string } | null>;
  confirmDiscard(args: { verb: string }): Promise<'save' | 'discard' | 'cancel'>;
  setDirty(dirty: boolean): void;
  setTitle(title: string): void;
  confirmClose(): void;
  info(): Promise<{
    version: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    arch: string;
  }>;
  onMenuCommand(handler: (cmd: string) => void): () => void;
  onProjectOpened(handler: (p: { path: string; text: string }) => void): () => void;
}

declare global {
  interface Window {
    manifold?: ManifoldBridge;
  }
}

/* Resolved once. Under Electron the preload script has already put the real
 * bridge on `window.manifold`; in a browser tab there is nothing there and the
 * web implementation is built instead.
 *
 * The important consequence is that `bridge()` never returns null any more, so
 * there is exactly one code path through every file operation rather than a
 * desktop one and a lightly-tested browser fallback beside it. */
let resolved: ManifoldBridge | null = null;

export function bridge(): ManifoldBridge {
  if (resolved) return resolved;
  if (typeof window !== 'undefined' && window.manifold) resolved = window.manifold;
  else resolved = createWebBridge();
  return resolved;
}

/** True when running inside the packaged desktop app rather than a browser. */
export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && !!window.manifold;

/** Saves text through whichever bridge is in play. */
export async function saveTextFile(
  defaultName: string,
  text: string,
  extensions: string[],
  typeName: string,
): Promise<string | null> {
  const res = await bridge().exportText({ defaultName, text, extensions, typeName });
  return res?.path ?? null;
}
