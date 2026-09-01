import { useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { MODES, type TabMode, type TabState } from '../../core/types';
import { IconClose, IconPlus } from '../ui/Icons';

const MODE_GLYPH: Record<TabMode, string> = {
  graphing: 'ƒ',
  statistics: 'σ',
  'linear-algebra': 'A',
  'monte-carlo': 'S',
  calculus: '∫',
  dynamics: 'λ',
  fields: '∇',
  fitting: 'R²',
  mechanics: '⚙',
  circuits: '⏚',
};

/**
 * The tab bar.
 *
 * Tabs can be dragged to reorder and double-clicked to rename in place. The
 * "+" opens a mode picker rather than adding another graph, because choosing
 * the mode is the decision that actually starts the work — a new tab that has
 * to be converted afterwards is an extra step every single time.
 */
export function TabStrip() {
  const tabs = useStore((s) => s.project.tabs);
  const activeId = useStore((s) => s.project.activeTabId);
  const selectTab = useStore((s) => s.selectTab);
  const closeTab = useStore((s) => s.closeTab);
  const moveTab = useStore((s) => s.moveTab);
  const picking = useStore((s) => s.modePickerOpen);
  const setPicking = useStore((s) => s.setModePickerOpen);
  const dragId = useRef<string | null>(null);

  /* Two nested elements, and the nesting matters.
   *
   * The scroll lives on the inner row; the outer row is the positioning context
   * for the dropdown. They used to be one element with `overflow-x-auto`, and
   * CSS then computes `overflow-y` to `auto` as well — which clipped the picker,
   * anchored below a 38px-tall strip, down to nothing. The button worked all
   * along; its menu was simply cropped out of existence.
   */
  return (
    <div className="relative border-b border-edge bg-surface-0">
      <div className="flex items-end gap-0.5 overflow-x-auto px-2 pt-1.5">
        {tabs.map((tab, index) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            canClose={tabs.length > 1}
            onSelect={() => selectTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onDragStart={() => {
              dragId.current = tab.id;
            }}
            onDragOver={() => {
              if (dragId.current && dragId.current !== tab.id) moveTab(dragId.current, index);
            }}
            onDragEnd={() => {
              dragId.current = null;
            }}
          />
        ))}

        <button
          type="button"
          data-testid="new-tab"
          title="New tab (⌘T)"
          aria-haspopup="menu"
          aria-expanded={picking}
          onClick={() => setPicking(!picking)}
          className={`mb-1 ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors
            ${picking ? 'bg-surface-3 text-ink' : 'text-ink-faint hover:bg-surface-2 hover:text-ink'}`}
        >
          <IconPlus size={15} />
        </button>
      </div>

      {picking && <ModePicker onClose={() => setPicking(false)} />}
    </div>
  );
}

function TabButton({
  tab,
  active,
  canClose,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  tab: TabState;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
}) {
  const renameTab = useStore((s) => s.renameTab);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.name);

  return (
    <div
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onDoubleClick={() => {
        setDraft(tab.name);
        setEditing(true);
      }}
      className={`group relative flex h-8 shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs transition-colors
        ${
          active
            ? 'border-edge bg-surface-2 text-ink'
            : 'border-transparent bg-transparent text-ink-faint hover:bg-surface-1 hover:text-ink-dim'
        }`}
      style={{ marginBottom: active ? -1 : 0 }}
    >
      <span
        className={`font-mono text-[11px] ${active ? 'text-accent-soft' : 'text-ink-faint'}`}
        title={MODES.find((m) => m.id === tab.mode)?.name}
      >
        {MODE_GLYPH[tab.mode]}
      </span>

      {editing ? (
        <input
          autoFocus
          className="w-24 bg-transparent text-xs text-ink focus:outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft.trim()) renameTab(tab.id, draft.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(tab.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="max-w-[10rem] truncate">{tab.name}</span>
      )}

      {canClose && (
        <button
          type="button"
          title="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="-mr-1 rounded p-0.5 text-ink-faint opacity-0 transition-opacity hover:bg-surface-4 hover:text-ink group-hover:opacity-100"
        >
          <IconClose size={11} />
        </button>
      )}
    </div>
  );
}

function ModePicker({ onClose }: { onClose: () => void }) {
  const addTab = useStore((s) => s.addTab);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-2 top-full z-50 mt-1 w-[26rem] overflow-hidden rounded-lg border border-edge bg-surface-2 shadow-pop">
        <div className="flex items-baseline justify-between border-b border-edge px-3 py-2">
          <span className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">New tab</span>
          <span className="text-2xs text-ink-faint">Esc to close</span>
        </div>
        <div className="max-h-[26rem] overflow-y-auto p-1">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              data-mode={mode.id}
              onClick={() => addTab(mode.id)}
              className="flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-3"
            >
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-edge bg-surface-1 font-mono text-xs text-accent-soft">
                {MODE_GLYPH[mode.id]}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-ink">{mode.name}</span>
                <span className="block text-2xs leading-snug text-ink-faint">{mode.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
