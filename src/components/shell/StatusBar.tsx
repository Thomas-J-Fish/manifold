import { useStore } from '../../core/store';
import { MODE_BY_ID, type ProjectFile, type TabState } from '../../core/types';
import { formatNumber } from '../ui/controls';

/** The thin strip along the bottom: what is on screen, and where it came from. */
export function StatusBar({ tab, project }: { tab: TabState; project: ProjectFile }) {
  const filePath = useStore((s) => s.filePath);
  const dirty = useStore((s) => s.dirty);
  const busy = useStore((s) => s.busy);
  const mode = MODE_BY_ID.get(tab.mode);
  const v = tab.viewport;

  return (
    <footer className="relative flex h-6 shrink-0 items-center gap-4 overflow-hidden border-t border-edge bg-surface-0 px-3 text-2xs text-ink-faint">
      {busy && (
        <div className="absolute inset-x-0 top-0 h-[2px] overflow-hidden bg-surface-2">
          <div
            className={busy.progress < 0 ? 'progress-indeterminate h-full w-1/4 bg-accent' : 'h-full bg-accent transition-[width] duration-150'}
            style={busy.progress >= 0 ? { width: `${Math.round(busy.progress * 100)}%` } : undefined}
          />
        </div>
      )}

      <span className="shrink-0">{mode?.name}</span>

      {mode?.surface === '2d' && (
        <span className="shrink-0 font-mono tabular-nums">
          x ∈ [{formatNumber(v.xMin, 3)}, {formatNumber(v.xMax, 3)}] · y ∈ [{formatNumber(v.yMin, 3)},{' '}
          {formatNumber(v.yMax, 3)}]
        </span>
      )}

      {tab.parameters.length > 0 && (
        <span className="hidden shrink-0 font-mono md:inline">
          {tab.parameters
            .slice(0, 5)
            .map((p) => `${p.name}=${formatNumber(p.value, 3)}`)
            .join('  ')}
        </span>
      )}

      <span className="flex-1" />

      {busy && <span className="shrink-0 text-accent-soft">{busy.label}</span>}

      <span className="truncate" title={filePath ?? 'Not saved yet'}>
        {filePath ? filePath.replace(/^.*[\\/]/, '') : `${project.tabs.length} tab${project.tabs.length === 1 ? '' : 's'}`}
        {dirty ? ' · unsaved changes' : ''}
      </span>
    </footer>
  );
}
