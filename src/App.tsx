import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, isDesktop } from './core/bridge';
import { useStore } from './core/store';
import { deserialiseProject, ProjectFormatError, serialiseProject, suggestedFileName } from './core/serialize';
import { MODE_BY_ID, type TabState } from './core/types';
import { useAnimationClock } from './hooks/useAnimationClock';
import { MODE_REGISTRY } from './modes/registry';
import { PlotRefProvider, usePlotRef } from './components/shell/PlotContext';
import { TabStrip } from './components/shell/TabStrip';
import { Timeline } from './components/shell/Timeline';
import { Sidebar } from './components/shell/Sidebar';
import { TitleBar } from './components/shell/TitleBar';
import { StatusBar } from './components/shell/StatusBar';
import { Toasts } from './components/shell/Toasts';
import { AboutDialog, ExamplesDialog, FunctionsDialog, ShortcutsDialog } from './components/shell/Dialogs';
import { DiscardDialog } from './components/shell/DiscardDialog';
import { ShareDialog } from './components/shell/ShareDialog';
import { useUnloadGuard, useWebAccelerators } from './components/shell/MenuBar';
import {
  clearSharePayload,
  decodeProject,
  pendingSharePayload,
  readAutosave,
  writeAutosave,
} from './core/share';

export default function App() {
  return (
    <PlotRefProvider>
      <Workspace />
    </PlotRefProvider>
  );
}

function Workspace() {
  const project = useStore((s) => s.project);
  const activeTab = useStore((s) => s.project.tabs.find((t) => t.id === s.project.activeTabId) ?? s.project.tabs[0]);
  const dialog = useStore((s) => s.dialog);
  const setDialog = useStore((s) => s.setDialog);

  useAnimationClock();
  useDocumentTitle();
  const { save, open, newProject, exportPng, exportCsv } = useFileCommands();
  useMenuCommands({ save, open, newProject, exportPng, exportCsv });
  useKeyboardShortcuts();
  useStartupProject();
  useAutosave();
  useWebAccelerators();
  useUnloadGuard();

  const mode = MODE_BY_ID.get(activeTab.mode);
  const modeModule = MODE_REGISTRY[activeTab.mode];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-0 text-ink">
      <TitleBar onSave={save} onOpen={open} onExport={exportPng} />
      <TabStrip />

      <div className="flex min-h-0 flex-1">
        <Sidebar>
          <modeModule.Panel tab={activeTab} />
        </Sidebar>

        <main className="flex min-w-0 flex-1 flex-col bg-surface-1">
          <div className="min-h-0 flex-1">
            <modeModule.Surface tab={activeTab} />
          </div>
          {mode?.supportsTimeline && <Timeline tab={activeTab} />}
        </main>
      </div>

      <StatusBar tab={activeTab} project={project} />
      <Toasts />

      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === 'examples' && <ExamplesDialog onClose={() => setDialog(null)} />}
      {dialog === 'functions' && <FunctionsDialog onClose={() => setDialog(null)} />}
      {dialog === 'share' && <ShareDialog onClose={() => setDialog(null)} />}
      <DiscardDialog />
    </div>
  );
}

/* ------------------------------------------------------------------ startup
 *
 * A browser tab can be opened three ways and they have a strict order of
 * precedence: a shared link is what the person asked for and wins; otherwise
 * whatever they were last doing here is restored; otherwise a fresh project.
 *
 * Restoring on top of a shared link would be the worst of the three — the
 * sender's work would flash up and then be replaced by the recipient's own,
 * which reads as the link being broken. */
function useStartupProject(): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || isDesktop()) return;
    done.current = true;
    const state = useStore.getState();

    const payload = pendingSharePayload();
    if (payload) {
      void decodeProject(payload)
        .then((text) => {
          const { project, warnings } = deserialiseProject(text, project_version());
          state.loadProject(project, null);
          // A shared project is not "saved" anywhere the recipient can reach,
          // so it starts dirty on purpose: the unsaved dot is telling the
          // truth, and the guard offers to save it before anything can throw
          // it away.
          state.markDirty();
          for (const w of warnings) state.pushToast({ kind: 'warn', message: w });
          state.pushToast({
            kind: 'success',
            message: `Opened “${project.meta.title || 'a shared project'}” from a link`,
            detail: 'This is your own copy. Changes stay on this machine.',
          });
        })
        .catch((err) => {
          state.pushToast({
            kind: 'error',
            message: 'That link could not be read',
            detail: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(clearSharePayload);
      return;
    }

    const restored = readAutosave();
    if (!restored) return;
    state.loadProject(restored.result.project, null);
    /* Restored work counts as unsaved, and this is not a technicality. The
     * browser's copy is a safety net, not a file: "New Project" overwrites it,
     * and clearing site data deletes it. Marking it clean would put a
     * reassuring "saved" state on work that lives in exactly one place nobody
     * has ever chosen. */
    state.markDirty();
    state.pushToast({
      kind: 'info',
      message: 'Picked up where you left off',
      detail: 'Your work is kept in this browser. Save a file to keep it anywhere else.',
    });
  }, []);
}

/* Keeps the browser's copy current, but not on every keystroke: serialising a
 * project is milliseconds and writing it to local storage is synchronous, and
 * doing both while a slider is being dragged is exactly the sort of thing that
 * makes an interface feel gummy. */
function useAutosave(): void {
  const project = useStore((s) => s.project);
  const pushToast = useStore((s) => s.pushToast);
  const warned = useRef(false);

  useEffect(() => {
    if (isDesktop()) return;
    const id = setTimeout(() => {
      if (writeAutosave(project) || warned.current) return;
      warned.current = true;
      pushToast({
        kind: 'warn',
        message: 'This project is too big for the browser to remember',
        detail: 'Save it as a file — usually it is an imported dataset that pushes it over the limit.',
      });
    }, 800);
    return () => clearTimeout(id);
  }, [project, pushToast]);
}

// ------------------------------------------------------------------ file commands

interface FileCommands {
  save: (forceDialog?: boolean) => Promise<boolean>;
  open: () => Promise<void>;
  newProject: () => Promise<void>;
  exportPng: () => Promise<void>;
  exportCsv: () => Promise<void>;
}

function useFileCommands(): FileCommands {
  const plotRef = usePlotRef();
  const [busy, setBusy] = useState(false);

  const save = useCallback(
    async (forceDialog = false): Promise<boolean> => {
      if (busy) return false;
      const api = bridge();
      const state = useStore.getState();
      const text = serialiseProject(state.project);
      setBusy(true);
      try {
        const result = await api.saveProject({
          path: forceDialog ? null : state.filePath,
          text,
          suggestedName: suggestedFileName(state.project),
        });
        if (!result) return false;
        state.markSaved(result.path);
        state.pushToast({ kind: 'success', message: `Saved ${baseName(result.path)}` });
        return true;
      } catch (err) {
        useStore.getState().pushToast({ kind: 'error', message: 'Could not save', detail: String(err) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  /**
   * Asks before throwing away unsaved work, and saves first if asked to.
   *
   * Returns false when the user cancels, in which case the caller must do
   * nothing at all. "New Project" used to replace the workspace outright with
   * no prompt, which meant one stray click on a toolbar button destroyed every
   * open tab.
   */
  const guardUnsaved = useCallback(
    async (verb: string): Promise<boolean> => {
      const state = useStore.getState();
      if (!state.dirty) return true;
      const answer = await bridge().confirmDiscard({ verb });
      if (answer === 'cancel') return false;
      if (answer === 'save') return save();
      return true;
    },
    [save],
  );

  const applyLoaded = useCallback((path: string | null, text: string) => {
    const state = useStore.getState();
    try {
      const { project, warnings } = deserialiseProject(text, project_version());
      state.loadProject(project, path);
      for (const w of warnings) state.pushToast({ kind: 'warn', message: w });
      state.pushToast({ kind: 'success', message: `Opened ${project.meta.title || baseName(path ?? '')}` });
    } catch (err) {
      state.pushToast({
        kind: 'error',
        message: err instanceof ProjectFormatError ? err.message : 'Could not open that project',
        detail: err instanceof ProjectFormatError ? undefined : String(err),
      });
    }
  }, []);

  const open = useCallback(async () => {
    if (!(await guardUnsaved('open another project'))) return;
    const result = await bridge().openProject();
    if (result) applyLoaded(result.path, result.text);
  }, [applyLoaded, guardUnsaved]);

  const newProject = useCallback(async () => {
    if (!(await guardUnsaved('start a new project'))) return;
    useStore.getState().newProject();
    bridge().setDirty(false);
  }, [guardUnsaved]);

  const exportPng = useCallback(async () => {
    const handle = plotRef.current;
    if (!handle) {
      useStore.getState().pushToast({ kind: 'warn', message: 'This view has nothing to export as an image.' });
      return;
    }
    const dataUrl = handle.toDataUrl(2);
    const state = useStore.getState();
    const tab = state.activeTab();
    const name = `${suggestedFileName(state.project)} — ${tab.name}.png`;
    const res = await bridge().exportBinary({
      defaultName: name,
      dataUrl,
      extensions: ['png'],
      typeName: 'PNG Image',
    });
    if (res) state.pushToast({ kind: 'success', message: `Exported ${baseName(res.path)}` });
  }, [plotRef]);

  const exportCsv = useCallback(async () => {
    const state = useStore.getState();
    const tab = state.activeTab();
    const csv = MODE_REGISTRY[tab.mode].toCsv?.(tab);
    if (!csv) {
      state.pushToast({ kind: 'warn', message: 'This view has no tabular data to export.' });
      return;
    }
    const name = `${suggestedFileName(state.project)} — ${tab.name}.csv`;
    const res = await bridge().exportText({
      defaultName: name,
      text: csv,
      extensions: ['csv'],
      typeName: 'CSV',
    });
    if (res) state.pushToast({ kind: 'success', message: `Exported ${baseName(res.path)}` });
  }, []);

  // A project opened from Finder arrives asynchronously from the main process.
  useEffect(() => bridge().onProjectOpened(({ path, text }) => applyLoaded(path, text)), [applyLoaded]);

  return { save, open, newProject, exportPng, exportCsv };
}

function project_version(): string {
  return '1.0.0';
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// ------------------------------------------------------------------ menu & keys

function useMenuCommands(commands: FileCommands): void {
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    return bridge().onMenuCommand(async (cmd) => {
      const s = useStore.getState();
      const c = commandsRef.current;
      switch (cmd) {
        case 'file.new':
          c.newProject();
          break;
        case 'file.open':
          await c.open();
          break;
        case 'file.save':
          await c.save();
          break;
        case 'file.saveAs':
          await c.save(true);
          break;
        case 'file.saveThenClose':
          // The main process is holding a close it could not complete; only
          // confirm it once the save has actually succeeded.
          if (await c.save()) bridge().confirmClose();
          break;
        case 'file.exportPng':
          await c.exportPng();
          break;
        case 'file.exportCsv':
          await c.exportCsv();
          break;
        case 'file.share':
          s.setDialog('share');
          break;
        case 'edit.undo':
          s.undo();
          break;
        case 'edit.redo':
          s.redo();
          break;
        case 'help.functions':
          s.setDialog('functions');
          break;
        case 'tab.new':
          // Opens the same picker the "+" button does: choosing the mode is the
          // decision that starts the work, and a new tab that has to be
          // converted afterwards is an extra step every single time.
          s.setModePickerOpen(true);
          break;
        case 'tab.close':
          s.closeTab(s.project.activeTabId);
          break;
        case 'tab.next':
          s.cycleTab(1);
          break;
        case 'tab.prev':
          s.cycleTab(-1);
          break;
        case 'tab.duplicate':
          s.duplicateTab(s.project.activeTabId);
          break;
        case 'tab.rename': {
          const name = window.prompt('Rename tab', s.activeTab().name);
          if (name?.trim()) s.renameTab(s.project.activeTabId, name.trim());
          break;
        }
        case 'view.resetViewport':
          s.resetViewport();
          break;
        case 'view.zoomIn':
          s.zoomViewport(1 / 1.3);
          break;
        case 'view.zoomOut':
          s.zoomViewport(1.3);
          break;
        case 'view.squareAxes':
          s.squareViewport(0.625);
          break;
        case 'view.toggleGrid':
          s.patchActive({ showGrid: !s.activeTab().showGrid });
          break;
        case 'view.toggleSidebar':
          s.setSidebar({ collapsed: !s.project.ui.sidebarCollapsed });
          break;
        case 'run.playPause':
          s.togglePlay();
          break;
        case 'run.step':
          s.stepTime(0.02);
          break;
        case 'run.restart':
          s.restartTime();
          break;
        case 'run.reseed':
          s.setMonteCarlo({ seed: Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0') });
          break;
        case 'help.about':
          s.setDialog('about');
          break;
        case 'help.shortcuts':
          s.setDialog('shortcuts');
          break;
        case 'help.examples':
          s.setDialog('examples');
          break;
      }
    });
  }, []);
}

/** In-window shortcuts for the things the native menu does not cover. */
function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const s = useStore.getState();

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (typing) return;

      // Number keys jump straight to a tab, the way every editor does it.
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1;
        const tab = s.project.tabs[index];
        if (tab) {
          e.preventDefault();
          s.selectTab(tab.id);
        }
        return;
      }
      if (e.key === 'Escape') {
        s.setDialog(null);
        s.setModePickerOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

/** Keeps the window title and the macOS "edited" dot in step with the store. */
function useDocumentTitle(): void {
  const title = useStore((s) => s.project.meta.title);
  const dirty = useStore((s) => s.dirty);
  const filePath = useStore((s) => s.filePath);

  useEffect(() => {
    const name = filePath ? baseName(filePath).replace(/\.manifold$/, '') : title || 'Untitled';
    const full = `${name}${dirty ? ' — Edited' : ''} · Manifold`;
    document.title = full;
    bridge().setTitle(`${name}${dirty ? ' — Edited' : ''}`);
    bridge().setDirty(dirty);
  }, [title, dirty, filePath]);
}

export type { TabState };
