import { useState } from 'react';
import { isDesktop } from '../../core/bridge';
import { useStore } from '../../core/store';
import { MenuBar } from './MenuBar';
import { MODE_BY_ID } from '../../core/types';
import { IconButton } from '../ui/controls';
import {
  IconDownload,
  IconFunction,
  IconGrid,
  IconInfo,
  IconPlus,
  IconSidebar,
  IconTarget,
  IconUpload,
} from '../ui/Icons';

/**
 * The window's own title bar.
 *
 * On macOS the traffic lights are inset over this strip, so the left padding
 * leaves room for them and the whole bar is a drag region except for the
 * controls, which opt out. That is the difference between a window that feels
 * native and one that cannot be moved by its own header.
 */
export function TitleBar({
  onSave,
  onOpen,
  onExport,
}: {
  onSave: () => void;
  onOpen: () => void;
  onExport: () => void;
}) {
  const title = useStore((s) => s.project.meta.title);
  const dirty = useStore((s) => s.dirty);
  const setTitle = useStore((s) => s.setTitle);
  const activeTab = useStore((s) => s.project.tabs.find((t) => t.id === s.project.activeTabId));
  const setSidebar = useStore((s) => s.setSidebar);
  const collapsed = useStore((s) => s.project.ui.sidebarCollapsed);
  const patchActive = useStore((s) => s.patchActive);
  const resetViewport = useStore((s) => s.resetViewport);
  const setDialog = useStore((s) => s.setDialog);
  const setModePickerOpen = useStore((s) => s.setModePickerOpen);
  /* Room for the traffic lights, but only where there are traffic lights: in a
   * browser tab that inset is 84 pixels of nothing at the top-left, and it is
   * where the menu bar goes instead. */
  const desktop = isDesktop();
  const isMac = desktop && typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const mode = activeTab ? MODE_BY_ID.get(activeTab.mode) : undefined;

  return (
    <header
      className="flex h-11 shrink-0 items-center gap-1.5 border-b border-edge bg-surface-0 pr-2"
      style={{ paddingLeft: isMac ? 84 : 10, ['WebkitAppRegion' as string]: 'drag' }}
    >
      {!desktop && (
        <div className="flex items-center gap-2 pr-1" style={{ ['WebkitAppRegion' as string]: 'no-drag' }}>
          <span className="select-none pl-0.5 pr-1 text-sm font-semibold tracking-tight text-ink">Manifold</span>
          <MenuBar />
          <div className="mx-1 h-5 w-px bg-edge" />
        </div>
      )}

      <div className="flex items-center gap-1.5" style={{ ['WebkitAppRegion' as string]: 'no-drag' }}>
        <IconButton title={collapsed ? 'Show the controls (⌘B)' : 'Hide the controls (⌘B)'} onClick={() => setSidebar({ collapsed: !collapsed })}>
          <IconSidebar size={15} />
        </IconButton>
        {/* This used to be "New project", which replaced the whole workspace —
            a destructive action one pixel away from Open and Save, wearing the
            same "+" every other add-something button wears. New Project now
            lives in the File menu and on ⌘N, and asks before discarding. */}
        <IconButton title="New tab (⌘T)" onClick={() => setModePickerOpen(true)}>
          <IconPlus size={15} />
        </IconButton>
        <IconButton title="Open project (⌘O)" onClick={onOpen}>
          <IconUpload size={15} />
        </IconButton>
        <IconButton title="Save project (⌘S)" onClick={onSave}>
          <IconDownload size={15} />
        </IconButton>
      </div>

      <div className="mx-1 h-5 w-px bg-edge" />

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {editing ? (
          <input
            autoFocus
            className="w-56 rounded border border-accent bg-surface-1 px-2 py-1 text-sm text-ink focus:outline-none"
            style={{ ['WebkitAppRegion' as string]: 'no-drag' }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft.trim()) setTitle(draft.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setDraft(title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            style={{ ['WebkitAppRegion' as string]: 'no-drag' }}
            className="truncate rounded px-1.5 py-0.5 text-sm text-ink hover:bg-surface-2"
            title="Rename this project"
            onClick={() => {
              setDraft(title);
              setEditing(true);
            }}
          >
            {title || 'Untitled'}
            {dirty && <span className="ml-1.5 text-accent">•</span>}
          </button>
        )}
        {mode && <span className="hidden truncate text-2xs text-ink-faint lg:inline">{mode.name}</span>}
      </div>

      <div className="flex items-center gap-1" style={{ ['WebkitAppRegion' as string]: 'no-drag' }}>
        {activeTab && (
          <>
            <IconButton
              title="Toggle the grid (⌘G)"
              active={activeTab.showGrid}
              onClick={() => patchActive({ showGrid: !activeTab.showGrid })}
            >
              <IconGrid size={15} />
            </IconButton>
            <IconButton title="Reset the view (⌘0)" onClick={resetViewport}>
              <IconTarget size={15} />
            </IconButton>
          </>
        )}
        <IconButton title="Function reference" onClick={() => setDialog('functions')}>
          <IconFunction size={15} />
        </IconButton>
        <IconButton title="Export the plot as PNG (⌘E)" onClick={onExport}>
          <IconDownload size={15} />
        </IconButton>
        <IconButton title="About Manifold" onClick={() => setDialog('about')}>
          <IconInfo size={15} />
        </IconButton>
      </div>
    </header>
  );
}
