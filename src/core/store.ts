/* The application store.
 *
 * One zustand store holds the entire document plus the small amount of UI state
 * that has to be reachable from the native menu. Two decisions are worth
 * flagging:
 *
 * 1. Tabs are stored as an array, not a map. Order is part of the document and
 *    the lists are short; an array keeps the order authoritative instead of
 *    duplicating it alongside a map.
 *
 * 2. Undo snapshots the document as a JSON string rather than keeping
 *    structurally-shared drafts. At the size these projects reach that costs
 *    well under a millisecond, and it makes "what exactly gets restored"
 *    impossible to get subtly wrong — which is the usual failure mode of
 *    hand-rolled undo.
 */

import { create } from 'zustand';
import {
  defaultTabName,
  defaultViewport,
  makeExpression,
  makeParameter,
  makeProject,
  makeTab,
  uid,
} from './defaults';
import type {
  CalculusConfig,
  ChemistryConfig,
  CircuitConfig,
  DynamicsConfig,
  ExpressionItem,
  ExpressionKind,
  FieldsConfig,
  FittingConfig,
  LinAlgConfig,
  MechanicsConfig,
  MonteCarloConfig,
  Parameter,
  ProjectFile,
  QuantumConfig,
  SignalsConfig,
  OptimisationConfig,
  GeometryConfig,
  LoanConfig,
  ReactionsConfig,
  ThermoConfig,
  StatisticsConfig,
  TabMode,
  TabState,
  Viewport,
  WavesConfig,
} from './types';

const UNDO_LIMIT = 80;

export type DialogId = 'about' | 'shortcuts' | 'examples' | 'functions' | 'share' | null;

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail?: string;
}

interface AppState {
  project: ProjectFile;
  filePath: string | null;
  dirty: boolean;
  undoStack: string[];
  redoStack: string[];
  toasts: Toast[];
  dialog: DialogId;
  /** Whether the "new tab" mode picker is showing. In the store rather than in
   *  TabStrip's own state so the native Tab menu and ⌘T can open it too. */
  modePickerOpen: boolean;
  /** Set while a long computation is in flight, to drive the progress strip. */
  busy: { label: string; progress: number } | null;

  // --- selectors used often enough to justify living here
  activeTab: () => TabState;

  // --- document lifecycle
  newProject: () => void;
  loadProject: (project: ProjectFile, path: string | null) => void;
  setFilePath: (path: string | null) => void;
  markSaved: (path: string) => void;
  /**
   * Marks the document as having unsaved changes without changing it.
   *
   * Used for a project that arrived from a link or from the browser's own
   * recovery store: it is real work that exists in no file the person can
   * point at, so the unsaved dot is telling the truth and the discard guard
   * should protect it.
   */
  markDirty: () => void;
  setTitle: (title: string) => void;

  // --- history
  commit: (label?: string) => void;
  undo: () => void;
  redo: () => void;

  // --- tabs
  addTab: (mode?: TabMode) => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  cycleTab: (delta: number) => void;
  renameTab: (id: string, name: string) => void;
  duplicateTab: (id: string) => void;
  moveTab: (id: string, toIndex: number) => void;
  setTabMode: (id: string, mode: TabMode) => void;
  /** Applies a patch to a tab without touching history. */
  patchTab: (id: string, patch: Partial<TabState>) => void;
  /** Applies a patch to the active tab. */
  patchActive: (patch: Partial<TabState>) => void;

  // --- expressions
  addExpression: (kind?: ExpressionKind, source?: string) => void;
  updateExpression: (id: string, patch: Partial<ExpressionItem>) => void;
  removeExpression: (id: string) => void;
  reorderExpression: (id: string, toIndex: number) => void;

  // --- parameters
  addParameter: (name?: string) => void;
  updateParameter: (id: string, patch: Partial<Parameter>) => void;
  removeParameter: (id: string) => void;
  setParameterValue: (id: string, value: number) => void;
  /** Creates sliders for every free symbol that has no parameter yet. */
  syncParameters: (symbols: string[]) => void;

  // --- viewport & timeline
  setViewport: (v: Viewport) => void;
  /**
   * Sets the viewport without marking the document unsaved.
   *
   * For corrections the app makes on the user's behalf — the sandboxes
   * relocking their scales to square after a window resize — rather than
   * anything the user did. Routing those through `setViewport` means opening a
   * tab and touching nothing leaves an unsaved-changes dot, which teaches
   * people that the dot means nothing.
   */
  fitViewport: (v: Viewport) => void;
  zoomViewport: (factor: number, anchor?: { x: number; y: number }) => void;
  resetViewport: () => void;
  squareViewport: (aspect: number) => void;
  setTime: (t: number) => void;
  togglePlay: () => void;
  stepTime: (delta: number) => void;
  restartTime: () => void;

  // --- mode configuration
  setStatistics: (patch: Partial<StatisticsConfig>) => void;
  setLinAlg: (patch: Partial<LinAlgConfig>) => void;
  setMonteCarlo: (patch: Partial<MonteCarloConfig>) => void;
  setCalculus: (patch: Partial<CalculusConfig>) => void;
  setDynamics: (patch: Partial<DynamicsConfig>) => void;
  setFields: (patch: Partial<FieldsConfig>) => void;
  setFitting: (patch: Partial<FittingConfig>) => void;
  setMechanics: (patch: Partial<MechanicsConfig>) => void;
  setCircuits: (patch: Partial<CircuitConfig>) => void;
  setQuantum: (patch: Partial<QuantumConfig>) => void;
  setChemistry: (patch: Partial<ChemistryConfig>) => void;
  setWaves: (patch: Partial<WavesConfig>) => void;
  setSignals: (patch: Partial<SignalsConfig>) => void;
  setOptimisation: (patch: Partial<OptimisationConfig>) => void;
  setReactions: (patch: Partial<ReactionsConfig>) => void;
  setGeometry: (patch: Partial<GeometryConfig>) => void;
  setLoan: (patch: Partial<LoanConfig>) => void;
  setThermo: (patch: Partial<ThermoConfig>) => void;

  // --- chrome
  setSidebar: (patch: { width?: number; collapsed?: boolean }) => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  setDialog: (d: DialogId) => void;
  setModePickerOpen: (open: boolean) => void;
  setBusy: (b: { label: string; progress: number } | null) => void;
}

function replaceTab(project: ProjectFile, id: string, fn: (t: TabState) => TabState): ProjectFile {
  return { ...project, tabs: project.tabs.map((t) => (t.id === id ? fn(t) : t)) };
}

/** Deep-clones a tab so a duplicate shares no arrays with its original. */
function cloneTab(tab: TabState, name: string): TabState {
  const copy = JSON.parse(JSON.stringify(tab)) as TabState;
  copy.id = uid('tab');
  copy.name = name;
  copy.expressions = copy.expressions.map((e) => ({ ...e, id: uid('exp') }));
  copy.parameters = copy.parameters.map((p) => ({ ...p, id: uid('par') }));
  return copy;
}

export const useStore = create<AppState>((set, get) => ({
  project: makeProject(),
  filePath: null,
  dirty: false,
  undoStack: [],
  redoStack: [],
  toasts: [],
  dialog: null,
  modePickerOpen: false,
  busy: null,

  activeTab: () => {
    const { project } = get();
    return project.tabs.find((t) => t.id === project.activeTabId) ?? project.tabs[0];
  },

  // ---------------------------------------------------------------- lifecycle

  newProject: () =>
    set({ project: makeProject(), filePath: null, dirty: false, undoStack: [], redoStack: [] }),

  loadProject: (project, path) =>
    set({ project, filePath: path, dirty: false, undoStack: [], redoStack: [] }),

  setFilePath: (path) => set({ filePath: path }),

  markSaved: (path) => set({ filePath: path, dirty: false }),

  markDirty: () => set({ dirty: true }),

  setTitle: (title) =>
    set((s) => ({ project: { ...s.project, meta: { ...s.project.meta, title } }, dirty: true })),

  // ---------------------------------------------------------------- history

  commit: () =>
    set((s) => ({
      undoStack: [...s.undoStack, JSON.stringify(s.project)].slice(-UNDO_LIMIT),
      redoStack: [],
    })),

  undo: () =>
    set((s) => {
      if (!s.undoStack.length) return s;
      const previous = s.undoStack[s.undoStack.length - 1];
      return {
        project: JSON.parse(previous) as ProjectFile,
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, JSON.stringify(s.project)].slice(-UNDO_LIMIT),
        dirty: true,
      };
    }),

  redo: () =>
    set((s) => {
      if (!s.redoStack.length) return s;
      const next = s.redoStack[s.redoStack.length - 1];
      return {
        project: JSON.parse(next) as ProjectFile,
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, JSON.stringify(s.project)].slice(-UNDO_LIMIT),
        dirty: true,
      };
    }),

  // ---------------------------------------------------------------- tabs

  addTab: (mode = 'graphing') => {
    get().commit();
    set((s) => {
      // Number the new tab against the others of its kind so a workspace of
      // five graphs does not end up with five tabs called "Graph".
      const stem = defaultTabName(mode);
      const used = s.project.tabs.filter((t) => t.name.startsWith(stem)).length;
      const tab = makeTab(mode, used ? `${stem} ${used + 1}` : stem);
      return {
        project: { ...s.project, tabs: [...s.project.tabs, tab], activeTabId: tab.id },
        dirty: true,
        modePickerOpen: false,
      };
    });
  },

  closeTab: (id) => {
    get().commit();
    set((s) => {
      if (s.project.tabs.length <= 1) return s;
      const index = s.project.tabs.findIndex((t) => t.id === id);
      const tabs = s.project.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.project.activeTabId === id ? tabs[Math.min(index, tabs.length - 1)].id : s.project.activeTabId;
      return { project: { ...s.project, tabs, activeTabId }, dirty: true };
    });
  },

  selectTab: (id) => set((s) => ({ project: { ...s.project, activeTabId: id } })),

  cycleTab: (delta) =>
    set((s) => {
      const i = s.project.tabs.findIndex((t) => t.id === s.project.activeTabId);
      const n = s.project.tabs.length;
      const next = ((i + delta) % n + n) % n;
      return { project: { ...s.project, activeTabId: s.project.tabs[next].id } };
    }),

  renameTab: (id, name) => {
    get().commit();
    set((s) => ({ project: replaceTab(s.project, id, (t) => ({ ...t, name })), dirty: true }));
  },

  duplicateTab: (id) => {
    get().commit();
    set((s) => {
      const source = s.project.tabs.find((t) => t.id === id);
      if (!source) return s;
      const copy = cloneTab(source, `${source.name} copy`);
      const index = s.project.tabs.findIndex((t) => t.id === id);
      const tabs = [...s.project.tabs];
      tabs.splice(index + 1, 0, copy);
      return { project: { ...s.project, tabs, activeTabId: copy.id }, dirty: true };
    });
  },

  moveTab: (id, toIndex) =>
    set((s) => {
      const from = s.project.tabs.findIndex((t) => t.id === id);
      if (from < 0 || toIndex < 0 || toIndex >= s.project.tabs.length) return s;
      const tabs = [...s.project.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(toIndex, 0, moved);
      return { project: { ...s.project, tabs }, dirty: true };
    }),

  setTabMode: (id, mode) => {
    get().commit();
    set((s) => ({
      project: replaceTab(s.project, id, (t) => {
        // The name follows the mode only while it is still the default one,
        // so a tab the user has named keeps its name.
        const wasDefault = /^[A-Za-z ]+( \d+)?$/.test(t.name) && t.name.startsWith(defaultTabName(t.mode));
        return { ...t, mode, name: wasDefault ? defaultTabName(mode) : t.name };
      }),
      dirty: true,
    }));
  },

  patchTab: (id, patch) =>
    set((s) => ({ project: replaceTab(s.project, id, (t) => ({ ...t, ...patch })), dirty: true })),

  patchActive: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({ ...t, ...patch })),
      dirty: true,
    })),

  // ---------------------------------------------------------------- expressions

  addExpression: (kind = 'function', source = '') => {
    get().commit();
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        expressions: [...t.expressions, makeExpression(source, kind, t.expressions.length)],
      })),
      dirty: true,
    }));
  },

  updateExpression: (id, patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        expressions: t.expressions.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      })),
      dirty: true,
    })),

  removeExpression: (id) => {
    get().commit();
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        expressions: t.expressions.filter((e) => e.id !== id),
      })),
      dirty: true,
    }));
  },

  reorderExpression: (id, toIndex) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => {
        const from = t.expressions.findIndex((e) => e.id === id);
        if (from < 0 || toIndex < 0 || toIndex >= t.expressions.length) return t;
        const expressions = [...t.expressions];
        const [moved] = expressions.splice(from, 1);
        expressions.splice(toIndex, 0, moved);
        return { ...t, expressions };
      }),
      dirty: true,
    })),

  // ---------------------------------------------------------------- parameters

  addParameter: (name) => {
    get().commit();
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => {
        const used = new Set(t.parameters.map((p) => p.name));
        // Walk the alphabet for a free single letter before falling back to p1,
        // p2, … — short names are what people actually type in expressions.
        const auto = 'abcdkmnpqrsw'.split('').find((c) => !used.has(c)) ?? `p${t.parameters.length + 1}`;
        return { ...t, parameters: [...t.parameters, makeParameter(name ?? auto)] };
      }),
      dirty: true,
    }));
  },

  updateParameter: (id, patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        parameters: t.parameters.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      })),
      dirty: true,
    })),

  removeParameter: (id) => {
    get().commit();
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        parameters: t.parameters.filter((p) => p.id !== id),
      })),
      dirty: true,
    }));
  },

  // Deliberately does not mark the document dirty or touch history: dragging a
  // slider is exploration, and filling the undo stack with 400 intermediate
  // positions would make undo useless.
  setParameterValue: (id, value) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        parameters: t.parameters.map((p) => (p.id === id ? { ...p, value } : p)),
      })),
      dirty: true,
    })),

  syncParameters: (symbols) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => {
        const existing = new Set(t.parameters.map((p) => p.name));
        const missing = symbols.filter((sym) => !existing.has(sym));
        if (!missing.length) return t;
        return { ...t, parameters: [...t.parameters, ...missing.map((m) => makeParameter(m, 1))] };
      }),
      dirty: true,
    })),

  // ---------------------------------------------------------------- viewport

  setViewport: (v) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({ ...t, viewport: v })),
      dirty: true,
    })),

  fitViewport: (v) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({ ...t, viewport: v })),
    })),

  zoomViewport: (factor, anchor) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => {
        const v = t.viewport;
        const cx = anchor?.x ?? (v.xMin + v.xMax) / 2;
        const cy = anchor?.y ?? (v.yMin + v.yMax) / 2;
        return {
          ...t,
          viewport: {
            xMin: cx + (v.xMin - cx) * factor,
            xMax: cx + (v.xMax - cx) * factor,
            yMin: cy + (v.yMin - cy) * factor,
            yMax: cy + (v.yMax - cy) * factor,
          },
        };
      }),
      dirty: true,
    })),

  resetViewport: () =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        viewport: defaultViewport(t.mode),
        camera: { theta: 0.9, phi: 1.05, distance: 15, target: [0, 0, 0] },
      })),
      dirty: true,
    })),

  squareViewport: (aspect) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => {
        const v = t.viewport;
        const cx = (v.xMin + v.xMax) / 2;
        const cy = (v.yMin + v.yMax) / 2;
        const halfX = (v.xMax - v.xMin) / 2;
        /* Keep the x range and derive y from the plot area's *measured* pixel
         * aspect, so one unit is the same number of pixels on both axes.
         *
         * This used to be handed a hard-coded 0.625 — which is exactly the
         * default viewport's own ratio, so on a fresh tab the button provably
         * did nothing, and everywhere else it used a number with no relation to
         * the pixels on screen. */
        const halfY = halfX * aspect;
        return {
          ...t,
          squareAxes: true,
          viewport: { xMin: cx - halfX, xMax: cx + halfX, yMin: cy - halfY, yMax: cy + halfY },
        };
      }),
      dirty: true,
    })),

  // ---------------------------------------------------------------- timeline

  setTime: (t) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (tab) => ({
        ...tab,
        timeline: { ...tab.timeline, t },
      })),
    })),

  togglePlay: () =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (tab) => ({
        ...tab,
        timeline: { ...tab.timeline, playing: !tab.timeline.playing },
      })),
    })),

  stepTime: (delta) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (tab) => {
        const tl = tab.timeline;
        const span = tl.tMax - tl.tMin || 1;
        let t = tl.t + delta * span;
        if (t > tl.tMax) t = tl.mode === 'once' ? tl.tMax : tl.tMin;
        if (t < tl.tMin) t = tl.mode === 'once' ? tl.tMin : tl.tMax;
        return { ...tab, timeline: { ...tl, t } };
      }),
    })),

  restartTime: () =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (tab) => ({
        ...tab,
        timeline: { ...tab.timeline, t: tab.timeline.tMin },
      })),
    })),

  // ---------------------------------------------------------------- mode config

  setStatistics: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        statistics: { ...t.statistics, ...patch },
      })),
      dirty: true,
    })),

  setLinAlg: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        linalg: { ...t.linalg, ...patch },
      })),
      dirty: true,
    })),

  setMonteCarlo: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        monteCarlo: { ...t.monteCarlo, ...patch },
      })),
      dirty: true,
    })),

  setCalculus: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        calculus: { ...t.calculus, ...patch },
      })),
      dirty: true,
    })),

  setDynamics: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        dynamics: { ...t.dynamics, ...patch },
      })),
      dirty: true,
    })),

  setFields: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        fields: { ...t.fields, ...patch },
      })),
      dirty: true,
    })),

  setFitting: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        fitting: { ...t.fitting, ...patch },
      })),
      dirty: true,
    })),

  setMechanics: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        mechanics: { ...t.mechanics, ...patch },
      })),
      dirty: true,
    })),

  setCircuits: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        circuits: { ...t.circuits, ...patch },
      })),
      dirty: true,
    })),

  setQuantum: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        quantum: { ...t.quantum, ...patch },
      })),
      dirty: true,
    })),

  setChemistry: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        chemistry: { ...t.chemistry, ...patch },
      })),
      dirty: true,
    })),

  setWaves: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        waves: { ...t.waves, ...patch },
      })),
      dirty: true,
    })),

  setOptimisation: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        optimisation: { ...t.optimisation, ...patch },
      })),
      dirty: true,
    })),

  setLoan: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        loan: { ...t.loan, ...patch },
      })),
      dirty: true,
    })),

  setGeometry: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        geometry: { ...t.geometry, ...patch },
      })),
      dirty: true,
    })),

  setReactions: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        reactions: { ...t.reactions, ...patch },
      })),
      dirty: true,
    })),

  setThermo: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        thermodynamics: { ...t.thermodynamics, ...patch },
      })),
      dirty: true,
    })),

  setSignals: (patch) =>
    set((s) => ({
      project: replaceTab(s.project, s.project.activeTabId, (t) => ({
        ...t,
        signals: { ...t.signals, ...patch },
      })),
      dirty: true,
    })),

  // ---------------------------------------------------------------- chrome

  setSidebar: (patch) =>
    set((s) => ({
      project: {
        ...s.project,
        ui: {
          sidebarWidth: patch.width ?? s.project.ui.sidebarWidth,
          sidebarCollapsed: patch.collapsed ?? s.project.ui.sidebarCollapsed,
        },
      },
    })),

  pushToast: (t) =>
    set((s) => ({ toasts: [...s.toasts, { ...t, id: uid('toast') }].slice(-4) })),

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setDialog: (d) => set({ dialog: d }),

  setModePickerOpen: (open) => set({ modePickerOpen: open }),

  setBusy: (b) => set({ busy: b }),
}));

/** Reads the active tab outside React, for menu handlers and hotkeys. */
export const getActiveTab = (): TabState => useStore.getState().activeTab();
