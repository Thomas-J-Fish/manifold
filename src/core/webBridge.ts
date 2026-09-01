/* The browser's answer to the preload bridge.
 *
 * Everything the app does with files, menus and window state already goes
 * through one narrow interface, `ManifoldBridge`, which Electron fills in from
 * the preload script. So the whole of the web build is this file: implement
 * the same interface with browser APIs and the rest of the application does
 * not know or care which one it is talking to.
 *
 * The alternative — sprinkling `if (isDesktop())` through the components —
 * would have meant two divergent code paths through every file operation, and
 * the browser one would be the one nobody tested.
 *
 * Two things genuinely differ and are handled here rather than pretended away:
 *
 *   · Saving. Chrome and Edge have the File System Access API, so "Save" can
 *     write back to the file you opened, exactly like the desktop app. Firefox
 *     and Safari do not, so saving there is a download and opening is a file
 *     picker. The bridge reports which of the two it managed, so the interface
 *     can stop claiming to have saved a file it actually downloaded.
 *
 *   · Menus. A web page has no native menu bar, so `onMenuCommand` is wired to
 *     an in-page emitter that MenuBar drives with the very same command
 *     strings the Electron menu sends. One command router, two ways of
 *     reaching it.
 */

import type { ManifoldBridge } from './bridge';

/* Injected by Vite from package.json at build time; see vite.config.ts. The
 * fallback keeps `vitest` and a bare `tsc` happy, where no define runs. */
const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0';

// ------------------------------------------------------------------ capability

interface FilePickerHandle {
  name: string;
  createWritable(): Promise<{ write(data: string | Blob): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}

interface PickerWindow {
  showOpenFilePicker?: (options: unknown) => Promise<FilePickerHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<FilePickerHandle>;
}

const picker = (): PickerWindow => window as unknown as PickerWindow;

/** True where the browser can write back to a file the user chose. */
export function hasFileSystemAccess(): boolean {
  return typeof picker().showSaveFilePicker === 'function';
}

// ------------------------------------------------------------------ plumbing

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.click();
  // Revoking immediately can cancel the download in Safari; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    // Safari fires no event at all when the picker is dismissed, so a cancelled
    // open resolves only when the window regains focus. Without this the
    // promise never settles and the caller's "opening…" state sticks forever.
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      resolve(file);
    };
    input.onchange = () => finish(input.files?.[0] ?? null);
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish(input.files?.[0] ?? null), 400),
      { once: true },
    );
    input.click();
  });
}

/* Handles for files opened this session, so "Save" can overwrite the file it
 * came from instead of dropping a second copy in Downloads. Keyed by the name
 * the bridge reports back as the "path", which is all the renderer ever holds
 * onto. */
const handles = new Map<string, FilePickerHandle>();

// ------------------------------------------------------------------ commands

type MenuListener = (cmd: string) => void;
const menuListeners = new Set<MenuListener>();

/** Sends a menu command to the app, from the in-page menu bar or a shortcut. */
export function emitMenuCommand(cmd: string): void {
  for (const listener of menuListeners) listener(cmd);
}

// ------------------------------------------------------------------ discard prompt

export type DiscardAnswer = 'save' | 'discard' | 'cancel';

interface DiscardRequest {
  verb: string;
  resolve: (answer: DiscardAnswer) => void;
}

let pendingDiscard: DiscardRequest | null = null;
const discardListeners = new Set<(request: DiscardRequest | null) => void>();

/** Subscribes the modal to discard requests. */
export function onDiscardRequest(handler: (request: DiscardRequest | null) => void): () => void {
  discardListeners.add(handler);
  handler(pendingDiscard);
  return () => discardListeners.delete(handler);
}

export function answerDiscard(answer: DiscardAnswer): void {
  const request = pendingDiscard;
  pendingDiscard = null;
  for (const listener of discardListeners) listener(null);
  request?.resolve(answer);
}

// ------------------------------------------------------------------ the bridge

let dirtyFlag = false;

/** True while the document has unsaved changes; read by the unload guard. */
export function isDirty(): boolean {
  return dirtyFlag;
}

export function createWebBridge(): ManifoldBridge {
  return {
    async openProject() {
      if (hasFileSystemAccess()) {
        try {
          const [handle] = await (picker().showOpenFilePicker as NonNullable<PickerWindow['showOpenFilePicker']>)({
            types: [{ description: 'Manifold project', accept: { 'application/json': ['.manifold', '.json'] } }],
            multiple: false,
          });
          if (!handle) return null;
          const file = await handle.getFile();
          handles.set(handle.name, handle);
          return { path: handle.name, text: await file.text() };
        } catch {
          // An AbortError means the user closed the picker, which is not a
          // failure worth reporting.
          return null;
        }
      }
      const file = await pickFile('.manifold,.json,application/json');
      if (!file) return null;
      return { path: file.name, text: await file.text() };
    },

    async readProject(path: string) {
      const handle = handles.get(path);
      if (!handle) throw new Error('That file is no longer open in this browser.');
      return { path, text: await (await handle.getFile()).text() };
    },

    async saveProject({ path, text, suggestedName }) {
      const name = `${suggestedName || 'Untitled'}.manifold`;
      const existing = path ? handles.get(path) : undefined;

      if (existing && path) {
        const writable = await existing.createWritable();
        await writable.write(text);
        await writable.close();
        return { path };
      }

      if (hasFileSystemAccess()) {
        try {
          const handle = await (picker().showSaveFilePicker as NonNullable<PickerWindow['showSaveFilePicker']>)({
            suggestedName: name,
            types: [{ description: 'Manifold project', accept: { 'application/json': ['.manifold'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(text);
          await writable.close();
          handles.set(handle.name, handle);
          return { path: handle.name };
        } catch {
          return null;
        }
      }

      download(name, new Blob([text], { type: 'application/json' }));
      return { path: name };
    },

    async exportText({ defaultName, text }) {
      download(defaultName, new Blob([text], { type: 'text/plain;charset=utf-8' }));
      return { path: defaultName };
    },

    async exportBinary({ defaultName, dataUrl }) {
      const response = await fetch(dataUrl);
      download(defaultName, await response.blob());
      return { path: defaultName };
    },

    async importText({ extensions }) {
      const file = await pickFile(extensions.map((e) => `.${e}`).join(','));
      if (!file) return null;
      return { path: file.name, text: await file.text() };
    },

    confirmDiscard({ verb }) {
      return new Promise<DiscardAnswer>((resolve) => {
        // Only one can be outstanding; a second request answers the first as a
        // cancel rather than stacking two modals on top of each other.
        pendingDiscard?.resolve('cancel');
        pendingDiscard = { verb, resolve };
        for (const listener of discardListeners) listener(pendingDiscard);
      });
    },

    setDirty(dirty: boolean) {
      dirtyFlag = dirty;
    },

    setTitle() {
      /* `useDocumentTitle` already sets document.title, which is the only title
       * a browser tab has. Nothing further to do. */
    },

    confirmClose() {
      /* The desktop app uses this to let a held-back window close. A browser
       * tab closes on its own and cannot be closed by script. */
    },

    async info() {
      return {
        version: APP_VERSION,
        electron: '—',
        chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '—',
        node: '—',
        platform: `web · ${navigator.userAgent.match(/\((.*?)[;)]/)?.[1] ?? 'browser'}`,
        arch: hasFileSystemAccess() ? 'file access' : 'download only',
      };
    },

    onMenuCommand(handler) {
      menuListeners.add(handler);
      return () => menuListeners.delete(handler);
    },

    onProjectOpened() {
      /* Nothing opens a project from outside the page on the web; a shared
       * link is read once at startup instead. See `share.ts`. */
      return () => {};
    },
  };
}
