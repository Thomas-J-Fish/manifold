import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { registerScheme, installHandler, ORIGIN } from './protocol';
import { buildMenu, MenuCommand } from './menu';
import { readRecents, pushRecent, clearRecents } from './recents';
import { isSelfTest, runSelfTest } from './selftest';

const isDev = !app.isPackaged && process.env.MANIFOLD_DEV === '1';
const DEV_URL = 'http://localhost:5273';
const PROJECT_EXT = 'manifold';

/* The compiled main process sits at <root>/out/main, whether <root> is the
 * project directory, Contents/Resources/app, or the inside of an app.asar —
 * `fs` reads through an asar transparently, so one path shape covers all three. */
const APP_ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(APP_ROOT, 'out', 'renderer');

registerScheme();

let mainWindow: BrowserWindow | null = null;
/** Set by the renderer; consulted before closing so unsaved work can be caught. */
let rendererDirty = false;
/** A file the OS asked us to open before the window existed (Finder double-click). */
let pendingOpenPath: string | null = null;
let forceClose = false;
/* `protocol.handle` throws if the same scheme is registered twice, and
 * `createWindow` runs again whenever the dock icon is clicked with no windows
 * open. The handler is process-wide, so it is installed exactly once. */
let protocolInstalled = false;

function resolveIcon(): string | undefined {
  for (const rel of ['build/icon.png', 'build/icon-256.png']) {
    const p = path.join(APP_ROOT, rel);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'Manifold',
    icon: resolveIcon(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // The plotting canvases and the 3D view both stall badly if Chromium
      // throttles rAF when the window is not frontmost mid-animation.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (pendingOpenPath) {
      const p = pendingOpenPath;
      pendingOpenPath = null;
      void openProjectPath(win, p);
    }
    // Only ever set by tools/make-app.js, which launches the bundle it has
    // just built, reads the report and then reports on the build.
    const reportPath = isSelfTest();
    if (reportPath) {
      void runSelfTest(win, reportPath).finally(() => {
        forceClose = true;
        app.quit();
      });
    }
  });

  // Nothing in this app should ever navigate or spawn a window. Anything that
  // tries is either a bug or hostile, so it is turned into an explicit,
  // user-visible external open of http(s) links only.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith(ORIGIN);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  win.on('close', (event) => {
    if (forceClose || !rendererDirty) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save…', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'This project has unsaved changes.',
      detail: 'Your tabs, expressions and simulation settings will be lost if you close without saving.',
    });
    if (choice === 2) return;
    if (choice === 1) {
      forceClose = true;
      win.close();
      return;
    }
    // Hand control back to the renderer, which owns the document and knows
    // whether the save was completed or cancelled.
    win.webContents.send('menu:command', 'file.saveThenClose' satisfies MenuCommand);
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    void win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else if (!fs.existsSync(path.join(RENDERER_DIR, 'index.html'))) {
    /* The renderer is missing from the bundle.
     *
     * This is a packaging failure, not a runtime one, and it used to surface as
     * a black window with the word "Not found" in the corner — the protocol
     * handler's 404 body, rendered as plain text. That tells the user nothing.
     * A packaged app cannot repair itself, so the least it can do is say
     * precisely what is absent and where it was looked for.
     */
    void win.loadURL(missingRendererPage());
  } else {
    if (!protocolInstalled) {
      installHandler(RENDERER_DIR);
      protocolInstalled = true;
    }
    void win.loadURL(`${ORIGIN}/index.html`);
  }

  return win;
}

/** A self-contained diagnostic page, served as a data URL so it does not
 *  depend on the very asset pipeline that has just been shown to be broken. */
function missingRendererPage(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Manifold</title></head>
<body style="margin:0;background:#0b0d12;color:#e6e9f2;font:13px/1.65 -apple-system,BlinkMacSystemFont,system-ui,sans-serif">
<div style="max-width:64ch;padding:56px 48px">
  <h1 style="font-size:16px;margin:0 0 14px">Manifold's interface is missing from this build</h1>
  <p style="color:#9aa3b8;margin:0 0 18px">
    The application started, but the compiled interface was not found inside the bundle, so there is
    nothing to show. This is a packaging problem — the app itself is fine.
  </p>
  <p style="color:#9aa3b8;margin:0 0 10px">Expected to find <code style="color:#a698f8">index.html</code> at:</p>
  <pre style="background:#171b24;border:1px solid #2b3243;border-radius:8px;padding:12px;font-size:11px;color:#9aa3b8;overflow:auto;margin:0 0 22px">${RENDERER_DIR.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
  <h2 style="font-size:13px;margin:0 0 8px">How to fix it</h2>
  <p style="color:#9aa3b8;margin:0 0 8px">Rebuild from the project folder:</p>
  <pre style="background:#171b24;border:1px solid #2b3243;border-radius:8px;padding:12px;font-size:11px;color:#9aa3b8;overflow:auto;margin:0 0 18px">npm install
npm run build
npm run make-app</pre>
  <p style="color:#6b7488;margin:0">
    Both <code>npm run build</code> steps matter: <code>build:main</code> compiles this process and
    <code>build:renderer</code> compiles the interface. Running only the first produces exactly this window.
  </p>
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function openProjectPath(win: BrowserWindow, filePath: string): Promise<void> {
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    pushRecent(filePath);
    refreshMenu();
    win.webContents.send('project:opened', { path: filePath, text });
  } catch (err) {
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'Could not open that project.',
      detail: String(err),
    });
  }
}

function refreshMenu(): void {
  buildMenu({
    recents: readRecents(),
    onCommand: (cmd) => mainWindow?.webContents.send('menu:command', cmd),
    onOpenRecent: (p) => {
      if (mainWindow) void openProjectPath(mainWindow, p);
    },
    onClearRecents: () => {
      clearRecents();
      refreshMenu();
    },
  });
}

// ------------------------------------------------------------------ IPC

ipcMain.handle('project:open', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Manifold Project',
    properties: ['openFile'],
    filters: [
      { name: 'Manifold Project', extensions: [PROJECT_EXT] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  const text = await fs.promises.readFile(filePath, 'utf8');
  pushRecent(filePath);
  refreshMenu();
  return { path: filePath, text };
});

ipcMain.handle('project:read', async (_e, filePath: string) => {
  const text = await fs.promises.readFile(filePath, 'utf8');
  pushRecent(filePath);
  refreshMenu();
  return { path: filePath, text };
});

ipcMain.handle(
  'project:save',
  async (_e, args: { path: string | null; text: string; suggestedName?: string }) => {
    if (!mainWindow) return null;
    let target = args.path;
    if (!target) {
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Manifold Project',
        defaultPath: `${args.suggestedName || 'Untitled'}.${PROJECT_EXT}`,
        filters: [{ name: 'Manifold Project', extensions: [PROJECT_EXT] }],
      });
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }
    // Write to a sibling temp file and rename: a crash mid-write then cannot
    // leave the user with a truncated project where a good one used to be.
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, args.text, 'utf8');
    await fs.promises.rename(tmp, target);
    pushRecent(target);
    refreshMenu();
    return { path: target };
  },
);

ipcMain.handle(
  'file:exportText',
  async (_e, args: { defaultName: string; text: string; extensions: string[]; typeName: string }) => {
    if (!mainWindow) return null;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export',
      defaultPath: args.defaultName,
      filters: [{ name: args.typeName, extensions: args.extensions }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.writeFile(res.filePath, args.text, 'utf8');
    return { path: res.filePath };
  },
);

ipcMain.handle(
  'file:exportBinary',
  async (_e, args: { defaultName: string; dataUrl: string; extensions: string[]; typeName: string }) => {
    if (!mainWindow) return null;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Image',
      defaultPath: args.defaultName,
      filters: [{ name: args.typeName, extensions: args.extensions }],
    });
    if (res.canceled || !res.filePath) return null;
    const base64 = args.dataUrl.replace(/^data:[^;]+;base64,/, '');
    await fs.promises.writeFile(res.filePath, Buffer.from(base64, 'base64'));
    return { path: res.filePath };
  },
);

ipcMain.handle('file:importText', async (_e, args: { extensions: string[]; typeName: string }) => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Data',
    properties: ['openFile'],
    filters: [
      { name: args.typeName, extensions: args.extensions },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const text = await fs.promises.readFile(res.filePaths[0], 'utf8');
  return { path: res.filePaths[0], text };
});

ipcMain.on('app:setDirty', (_e, dirty: boolean) => {
  rendererDirty = Boolean(dirty);
  mainWindow?.setDocumentEdited?.(rendererDirty);
});

ipcMain.on('app:setTitle', (_e, title: string) => {
  mainWindow?.setTitle(title || 'Manifold');
});

ipcMain.on('app:closeConfirmed', () => {
  forceClose = true;
  mainWindow?.close();
});

/* Asked before anything that would throw the current workspace away.
 *
 * The renderer cannot put up a native, modal, three-button sheet, and an
 * in-window confirmation is exactly the kind of thing people dismiss without
 * reading. This is the same dialog the window's own close handler uses, so
 * "New Project" and closing the window behave identically. */
ipcMain.handle('app:confirmDiscard', async (_e, args: { verb: string }) => {
  if (!mainWindow) return 'discard';
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save…', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'This project has unsaved changes.',
    detail: `Your tabs, expressions and simulation settings will be lost if you ${args.verb} without saving.`,
  });
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel';
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}));

// ------------------------------------------------------------------ lifecycle

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) void openProjectPath(mainWindow, filePath);
  else pendingOpenPath = filePath;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const file = argv.find((a) => a.endsWith(`.${PROJECT_EXT}`));
    if (file) void openProjectPath(mainWindow, file);
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    refreshMenu();
    mainWindow = createWindow();

    const cliFile = process.argv.find((a) => a.endsWith(`.${PROJECT_EXT}`) && fs.existsSync(a));
    if (cliFile) pendingOpenPath = cliFile;

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
