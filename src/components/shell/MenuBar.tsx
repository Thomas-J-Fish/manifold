import { useEffect, useRef, useState } from 'react';
import { isDesktop } from '../../core/bridge';
import { emitMenuCommand } from '../../core/webBridge';
import { useStore } from '../../core/store';

/* The menu the browser does not provide.
 *
 * On the desktop, File/Edit/View/Tab/Run/Help come from Electron and send
 * command strings over IPC. A web page has no native menu, so this renders the
 * same structure in the window and sends the same strings through the web
 * bridge's emitter. `useMenuCommands` in App.tsx is unchanged and cannot tell
 * the difference, which is the point: there is one command router, and adding
 * a menu item means adding it in two menus rather than writing a second
 * implementation of what the item does.
 *
 * Deliberately not a generic menu library. This is six dropdowns of static
 * items; the whole thing is smaller than the configuration a library would
 * need, and it can match the app's own visual language exactly.
 */

interface Item {
  label: string;
  command: string;
  accelerator?: string;
  /** Draws a divider above this item. */
  separated?: boolean;
}

interface Menu {
  label: string;
  items: Item[];
}

const MOD = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';

const MENUS: Menu[] = [
  {
    label: 'File',
    items: [
      { label: 'New Project', command: 'file.new', accelerator: `${MOD}N` },
      { label: 'Open…', command: 'file.open', accelerator: `${MOD}O` },
      { label: 'Save', command: 'file.save', accelerator: `${MOD}S` },
      { label: 'Save As…', command: 'file.saveAs', accelerator: `${MOD}⇧S` },
      { label: 'Share as a link…', command: 'file.share', separated: true },
      { label: 'Export plot as PNG', command: 'file.exportPng', accelerator: `${MOD}E`, separated: true },
      { label: 'Export data as CSV', command: 'file.exportCsv' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', command: 'edit.undo', accelerator: `${MOD}Z` },
      { label: 'Redo', command: 'edit.redo', accelerator: `${MOD}⇧Z` },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Reset the view', command: 'view.resetViewport', accelerator: `${MOD}0` },
      { label: 'Zoom in', command: 'view.zoomIn', accelerator: `${MOD}+` },
      { label: 'Zoom out', command: 'view.zoomOut', accelerator: `${MOD}−` },
      { label: 'Toggle the grid', command: 'view.toggleGrid', accelerator: `${MOD}G`, separated: true },
      { label: 'Show or hide the controls', command: 'view.toggleSidebar', accelerator: `${MOD}B` },
    ],
  },
  {
    label: 'Tab',
    items: [
      { label: 'New Tab…', command: 'tab.new', accelerator: `${MOD}T` },
      { label: 'Duplicate Tab', command: 'tab.duplicate' },
      { label: 'Rename Tab…', command: 'tab.rename' },
      { label: 'Close Tab', command: 'tab.close', accelerator: `${MOD}W`, separated: true },
      { label: 'Next Tab', command: 'tab.next', accelerator: `${MOD}⌥→`, separated: true },
      { label: 'Previous Tab', command: 'tab.prev', accelerator: `${MOD}⌥←` },
    ],
  },
  {
    label: 'Run',
    items: [
      { label: 'Play or pause', command: 'run.playPause', accelerator: 'Space' },
      { label: 'Step forward', command: 'run.step' },
      { label: 'Back to the start', command: 'run.restart' },
      { label: 'New random seed', command: 'run.reseed', separated: true },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'Load an Example…', command: 'help.examples' },
      { label: 'Keyboard Shortcuts', command: 'help.shortcuts' },
      { label: 'Function reference', command: 'help.functions', separated: true },
      { label: 'About Manifold', command: 'help.about' },
    ],
  },
];

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    // `mousedown` rather than `click`, so pressing outside dismisses the menu
    // before the thing underneath receives the press.
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={barRef} className="relative flex items-center gap-0.5" role="menubar">
      {MENUS.map((menu) => (
        <div key={menu.label} className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === menu.label}
            data-menu={menu.label}
            // Once one menu is open, hovering the others switches between them,
            // which is how every real menu bar behaves.
            onMouseEnter={() => open && setOpen(menu.label)}
            onClick={() => setOpen(open === menu.label ? null : menu.label)}
            className={`rounded px-2 py-1 text-2xs transition-colors ${
              open === menu.label ? 'bg-surface-3 text-ink' : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
            }`}
          >
            {menu.label}
          </button>

          {open === menu.label && (
            <div
              role="menu"
              className="absolute left-0 top-full z-50 mt-1 min-w-[15rem] rounded-lg border border-edge bg-surface-2 py-1 shadow-pop"
            >
              {menu.items.map((item) => (
                <div key={item.command}>
                  {item.separated && <div className="my-1 h-px bg-edge" />}
                  <button
                    type="button"
                    role="menuitem"
                    data-command={item.command}
                    onClick={() => {
                      setOpen(null);
                      emitMenuCommand(item.command);
                    }}
                    className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-2xs text-ink-dim transition-colors hover:bg-accent hover:text-white"
                  >
                    <span>{item.label}</span>
                    {item.accelerator && <span className="text-ink-faint">{item.accelerator}</span>}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The accelerators the native menu used to own.
 *
 * Electron registered these itself, so the renderer never needed them. In a
 * browser tab nothing does, and a graphing calculator where ⌘S opens the
 * browser's own "save this web page" dialog is worse than one with no
 * shortcuts at all — so the ones that clash with the browser are captured and
 * prevented, and the rest are left alone.
 */
export function useWebAccelerators(): void {
  useEffect(() => {
    /* Only in a browser. Electron's own menu registers these accelerators, so
     * running both means ⌘S saves twice and ⌘T opens two mode pickers — the
     * kind of bug that looks like the app being flaky rather than like a
     * duplicated handler. */
    if (isDesktop()) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;

      if (!mod) {
        // Space plays and pauses, but not while someone is typing into a field
        // and not when a button has focus, where space is that button's click.
        if (e.key === ' ' && !typing && target?.tagName !== 'BUTTON') {
          e.preventDefault();
          emitMenuCommand('run.playPause');
        }
        return;
      }

      const key = e.key.toLowerCase();
      const command = ({
        s: e.shiftKey ? 'file.saveAs' : 'file.save',
        o: 'file.open',
        n: 'file.new',
        t: 'tab.new',
        w: 'tab.close',
        e: 'file.exportPng',
        g: 'view.toggleGrid',
        b: 'view.toggleSidebar',
        '0': 'view.resetViewport',
      } as Record<string, string>)[key];

      if (!command) return;
      // ⌘N and ⌘T cannot be intercepted in some browsers — the new window or tab
      // opens regardless. Preventing them is still right where it works, and
      // harmless where it does not.
      e.preventDefault();
      emitMenuCommand(command);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

/** Reports whether anything at all is currently unsaved, for the tab-close guard. */
export function useUnloadGuard(): void {
  const dirty = useStore((s) => s.dirty);
  useEffect(() => {
    /* Browser only, and this one is not merely redundant on the desktop but
     * actively harmful: Electron honours a cancelled `beforeunload` by simply
     * not closing the window, with no dialog and no way for the user to
     * insist. The desktop app already asks properly through the main process,
     * and adding this on top made the window impossible to close. */
    if (isDesktop() || !dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Browsers ignore any custom message now and show their own, but the
      // prompt itself only appears if preventDefault is called.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
