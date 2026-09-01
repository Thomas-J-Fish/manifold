import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useStore } from '../../core/store';
import { IconSidebar } from '../ui/Icons';

const MIN_WIDTH = 280;
const MAX_WIDTH = 560;

/** The left panel: mode controls, resizable by dragging its inner edge. */
export function Sidebar({ children }: { children: ReactNode }) {
  const width = useStore((s) => s.project.ui.sidebarWidth);
  const collapsed = useStore((s) => s.project.ui.sidebarCollapsed);
  const setSidebar = useStore((s) => s.setSidebar);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      setSidebar({ width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX)) });
    };
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [setSidebar]);

  if (collapsed) {
    return (
      <div className="flex w-9 shrink-0 flex-col items-center border-r border-edge bg-surface-0 pt-2">
        <button
          type="button"
          title="Show the controls (⌘B)"
          onClick={() => setSidebar({ collapsed: false })}
          className="rounded-md p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
        >
          <IconSidebar size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex shrink-0 flex-col border-r border-edge bg-surface-0" style={{ width }}>
      <div className="flex-1 space-y-2.5 overflow-y-auto overflow-x-hidden p-2.5">{children}</div>

      {/* A wide invisible hit area over a hairline: easy to grab, invisible
          until hovered, which is how a resize handle should behave. */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onDoubleClick={() => setSidebar({ width: 348 })}
        className="absolute right-0 top-0 h-full w-1.5 translate-x-1/2 cursor-col-resize transition-colors hover:bg-accent/40"
      />
    </div>
  );
}
