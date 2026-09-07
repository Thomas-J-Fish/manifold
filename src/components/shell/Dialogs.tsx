import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { bridge } from '../../core/bridge';
import { EXAMPLES } from '../../core/examples';
import { useStore } from '../../core/store';
import { FUNCTION_GROUPS } from '../../core/math/functions';
import { CATEGORIES, MODES, type ModeCategory, type TabMode } from '../../core/types';
import { IconChevronDown, IconClose, IconSearch } from '../ui/Icons';

function Modal({
  title,
  subtitle,
  onClose,
  children,
  width = 'max-w-2xl',
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-8 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`flex max-h-full w-full ${width} flex-col overflow-hidden rounded-xl border border-edge bg-surface-2 shadow-pop`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex items-start justify-between gap-4 border-b border-edge px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-2xs text-ink-faint">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <IconClose size={15} />
          </button>
        </header>
        <div className="selectable min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    void bridge()
      .info()
      .then((i) => setInfo(i as unknown as Record<string, string>));
  }, []);

  return (
    <Modal title="Manifold" subtitle="A graphing calculator and simulation studio" onClose={onClose} width="max-w-lg">
      <div className="space-y-4 text-xs leading-relaxed text-ink-dim">
        <p>
          Manifold plots functions, distributions, matrices, vector fields, stochastic processes and iterated
          maps, with every plot driven by expressions you can edit and parameters you can drag.
        </p>
        <p>
          It runs entirely on this machine. Nothing is uploaded, nothing is tracked, and a project file is
          plain JSON you can read, diff and keep in version control.
        </p>
        <div className="rounded-md border border-edge bg-surface-1 p-3 font-mono text-2xs text-ink-faint">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span>Version</span>
            <span className="text-ink">{info?.version ?? '1.0.0'}</span>
            {info && (
              <>
                <span>Electron</span>
                <span className="text-ink">{info.electron}</span>
                <span>Chromium</span>
                <span className="text-ink">{info.chrome}</span>
                <span>Node</span>
                <span className="text-ink">{info.node}</span>
                <span>Platform</span>
                <span className="text-ink">
                  {info.platform} {info.arch}
                </span>
              </>
            )}
          </div>
        </div>
        <p className="text-2xs text-ink-faint">
          MIT licensed. Built with React, Tailwind, math.js, KaTeX and three.js.
        </p>
      </div>
    </Modal>
  );
}

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Project',
    items: [
      ['⌘N', 'New project'],
      ['⌘O', 'Open a project'],
      ['⌘S', 'Save'],
      ['⇧⌘S', 'Save as…'],
      ['⌘E', 'Export the plot as PNG'],
      ['⇧⌘E', 'Export data as CSV'],
      ['⌘Z / ⇧⌘Z', 'Undo / redo'],
    ],
  },
  {
    group: 'Tabs',
    items: [
      ['⌘T', 'New tab'],
      ['⌘W', 'Close tab'],
      ['⌘1…9', 'Jump to a tab'],
      ['⌃Tab', 'Next tab'],
      ['⇧⌘D', 'Duplicate tab'],
      ['⌘R', 'Rename tab'],
      ['Double-click', 'Rename a tab in place'],
    ],
  },
  {
    group: 'View',
    items: [
      ['Scroll', 'Zoom about the pointer'],
      ['⇧ Scroll', 'Zoom the x axis only'],
      ['⌥ Scroll', 'Zoom the y axis only'],
      ['Drag', 'Pan'],
      ['⌘0', 'Reset the view'],
      ['⌥⌘0', 'Square up the axes'],
      ['⌘G', 'Toggle the grid'],
      ['⌘B', 'Show or hide the controls'],
    ],
  },
  {
    group: 'Playback',
    items: [
      ['Space', 'Play or pause'],
      ['→', 'Step forward'],
      ['⇧⌘R', 'Restart from the beginning'],
      ['⇧⌘N', 'New random seed'],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {SHORTCUTS.map((section) => (
          <div key={section.group}>
            <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-faint">{section.group}</h3>
            <dl className="space-y-1">
              {section.items.map(([key, label]) => (
                <div key={key} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-ink-dim">{label}</dt>
                  <dd>
                    <kbd className="rounded border border-edge bg-surface-1 px-1.5 py-0.5 font-mono text-2xs text-ink">
                      {key}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/**
 * The example browser, grouped by mode.
 *
 * A flat grid of forty-five buttons is a wall: everything is equally visible,
 * which means nothing is. Collapsing by mode turns it into fourteen lines a
 * student reads in a second, and the count beside each says what is in there
 * before it is opened. Nothing is open to begin with, which is the point —
 * the first decision is "what am I trying to do", not "which of these
 * seventeen".
 */
export function ExamplesDialog({ onClose }: { onClose: () => void }) {
  const commit = useStore((s) => s.commit);
  const [open, setOpen] = useState<TabMode | null>(null);
  /* Subject first, mode second, examples third.
   *
   * With seventeen modes the mode headings had themselves become the wall the
   * grouping was meant to remove — nearly a screenful of collapsed rows before
   * a single example is visible. One subject open at a time keeps the whole
   * dialog to a glance. */
  const [openCategory, setOpenCategory] = useState<ModeCategory | null>('mathematics');

  const byMode = useMemo(() => {
    const groups = new Map<TabMode, typeof EXAMPLES>();
    for (const ex of EXAMPLES) {
      const list = groups.get(ex.mode);
      if (list) list.push(ex);
      else groups.set(ex.mode, [ex]);
    }
    return groups;
  }, []);

  const load = (ex: (typeof EXAMPLES)[number]) => {
    commit();
    const tab = ex.build();
    useStore.setState((s) => ({
      project: { ...s.project, tabs: [...s.project.tabs, tab], activeTabId: tab.id },
      dirty: true,
    }));
    onClose();
  };

  return (
    <Modal
      title="Examples"
      subtitle={`${EXAMPLES.length} worked examples. Each one opens in a new tab; nothing already open is disturbed.`}
      onClose={onClose}
      width="max-w-3xl"
    >
      <div className="space-y-1.5">
        {CATEGORIES.map((category) => {
          const modesHere = MODES.filter((m) => m.category === category.id && (byMode.get(m.id) ?? []).length);
          if (!modesHere.length) return null;
          const categoryOpen = openCategory === category.id;
          const total = modesHere.reduce((n, m) => n + (byMode.get(m.id) ?? []).length, 0);
          return (
            <div key={category.id} className="overflow-hidden rounded-lg border border-edge bg-surface-0">
              <button
                type="button"
                data-example-category={category.id}
                aria-expanded={categoryOpen}
                onClick={() => {
                  setOpenCategory(categoryOpen ? null : category.id);
                  setOpen(null);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
              >
                <IconChevronDown
                  size={13}
                  className={`shrink-0 text-ink-faint transition-transform ${categoryOpen ? '' : '-rotate-90'}`}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-ink">{category.name}</span>
                  <span className="block text-2xs leading-snug text-ink-faint">{category.blurb}</span>
                </span>
                <span className="ml-auto shrink-0 rounded-full border border-edge px-1.5 py-0.5 text-2xs text-ink-faint">
                  {total}
                </span>
              </button>

              {categoryOpen && (
                <div className="space-y-1.5 border-t border-edge p-1.5">
        {modesHere.map((mode) => {
          const list = byMode.get(mode.id) ?? [];
          if (!list.length) return null;
          const expanded = open === mode.id;
          return (
            <div key={mode.id} className="overflow-hidden rounded-lg border border-edge bg-surface-1">
              <button
                type="button"
                data-example-group={mode.id}
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : mode.id)}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-3"
              >
                <IconChevronDown
                  size={13}
                  className={`shrink-0 text-ink-faint transition-transform ${expanded ? '' : '-rotate-90'}`}
                />
                <span className="text-xs font-medium text-ink">{mode.name}</span>
                <span className="ml-auto shrink-0 rounded-full border border-edge px-1.5 py-0.5 text-2xs text-ink-faint">
                  {list.length}
                </span>
              </button>

              {expanded && (
                <div className="grid gap-2 border-t border-edge p-2 sm:grid-cols-2">
                  {list.map((ex) => (
                    <button
                      key={ex.id}
                      type="button"
                      data-example={ex.id}
                      onClick={() => load(ex)}
                      className="rounded-lg border border-edge bg-surface-2 p-3 text-left transition-colors hover:border-accent-deep hover:bg-surface-3"
                    >
                      <span className="block text-xs font-medium text-ink">{ex.title}</span>
                      <span className="mt-1 block text-2xs leading-relaxed text-ink-faint">{ex.blurb}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function FunctionsDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  return (
    <Modal
      title="Function reference"
      subtitle="Everything the expression language understands. Angles are in radians."
      onClose={onClose}
      width="max-w-3xl"
    >
      <div className="mb-4 flex items-center gap-2 rounded-md border border-edge bg-surface-1 px-2">
        <IconSearch size={14} className="text-ink-faint" />
        <input
          autoFocus
          className="flex-1 bg-transparent py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          placeholder="Search functions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="space-y-5">
        {[...FUNCTION_GROUPS.entries()].map(([group, items]) => {
          const filtered = items.filter(
            ({ name, spec }) =>
              !needle || name.toLowerCase().includes(needle) || spec.doc.toLowerCase().includes(needle),
          );
          if (!filtered.length) return null;
          return (
            <div key={group}>
              <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-faint">{group}</h3>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                {filtered.map(({ name, spec }) => (
                  <div key={name} className="flex items-baseline gap-2 border-b border-edge/50 py-1">
                    <code className="shrink-0 font-mono text-xs text-accent-soft">{spec.sig}</code>
                    <span className="truncate text-2xs text-ink-faint" title={spec.doc}>
                      {spec.doc}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 space-y-2 rounded-md border border-edge bg-surface-1 p-3 text-2xs leading-relaxed text-ink-dim">
        <p>
          <span className="text-ink">Operators.</span> <code className="font-mono">+ − * / ^ %</code>, comparison{' '}
          <code className="font-mono">{'< <= > >= == !='}</code>, logic{' '}
          <code className="font-mono">and or not</code>, the conditional{' '}
          <code className="font-mono">cond ? a : b</code>, and factorial{' '}
          <code className="font-mono">n!</code>. Implicit multiplication works:{' '}
          <code className="font-mono">2x</code> and <code className="font-mono">3sin(x)</code> both parse.
        </p>
        <p>
          <span className="text-ink">Constants.</span> <code className="font-mono">pi π e tau φ inf</code>. The
          shared clock is available in every expression as{' '}
          <code className="font-mono">time</code>.
        </p>
        <p>
          <span className="text-ink">LaTeX.</span> Pasted LaTeX is converted automatically —{' '}
          <code className="font-mono">{'\\frac{x}{2}'}</code>, <code className="font-mono">{'\\sqrt{x}'}</code>{' '}
          and <code className="font-mono">{'\\sin\\left(x\\right)'}</code> all work.
        </p>
      </div>
    </Modal>
  );
}
