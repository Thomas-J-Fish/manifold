import { useMemo } from 'react';
import { useStore } from '../core/store';
import type { TabState } from '../core/types';
import { EvalScope } from '../core/math/scope';
import { useScope } from '../hooks/useScope';
import { buildGraphScene } from './graphing';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { ExpressionPanel } from '../components/panels/ExpressionPanel';
import { ParameterPanel } from '../components/panels/ParameterPanel';
import { ViewPanel } from '../components/panels/ViewPanel';
import { Callout, Collapsible } from '../components/ui/controls';
import type { PlotScene } from '../plot/scene';

export function GraphingPanel({ tab }: { tab: TabState }) {
  const { definitionErrors } = useScope(tab.parameters, tab.expressions, tab.timeline.t);
  return (
    <>
      <ExpressionPanel
        expressions={tab.expressions}
        parameters={tab.parameters}
        definitionErrors={definitionErrors}
      />
      <ParameterPanel parameters={tab.parameters} />
      <GraphNotes tab={tab} />
      <ViewPanel tab={tab} />
    </>
  );
}

/** Numeric results that come out of the plot: integrals, and any errors. */
function GraphNotes({ tab }: { tab: TabState }) {
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);
  const result = useMemo(
    () =>
      buildGraphScene({
        expressions: tab.expressions,
        scope,
        view: { ...tab.viewport, width: 900, height: 560 },
        detailed: false,
      }),
    [tab.expressions, tab.viewport, scope],
  );

  if (!result.notes.length && !result.errors.length) return null;

  return (
    <Collapsible title="Results">
      {result.notes.map((n) => (
        <div key={`${n.id}-${n.text}`} className="rounded-md border border-edge bg-surface-1 px-2.5 py-2">
          <p className="text-2xs text-ink-faint">{n.label}</p>
          <p className="font-mono text-xs text-ink">{n.text}</p>
        </div>
      ))}
      {result.errors.map((e) => (
        <Callout key={e.id} kind="error">
          {e.message}
        </Callout>
      ))}
    </Collapsible>
  );
}

export function GraphingSurface({ tab }: { tab: TabState }) {
  const setViewport = useStore((s) => s.setViewport);
  const plotRef = usePlot2DRef();
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);

  const scene = useMemo<PlotScene>(() => {
    const view = { ...tab.viewport, width: 1200, height: 720 };
    // Feature detection is skipped while the clock is running: finding every
    // root and turning point twice per frame is the one thing in this mode
    // that cannot keep up with 60 fps.
    const { layers, legend } = buildGraphScene({
      expressions: tab.expressions,
      scope,
      view,
      detailed: !tab.timeline.playing,
    });
    return {
      viewport: tab.viewport,
      layers,
      legend: legend.length > 1 ? legend : undefined,
      showGrid: tab.showGrid,
      showMinorGrid: tab.showMinorGrid,
      showAxes: tab.showAxes,
      xLabel: 'x',
      yLabel: 'y',
    };
  }, [tab.expressions, tab.viewport, tab.showGrid, tab.showMinorGrid, tab.showAxes, tab.timeline.playing, scope]);

  // The readout evaluates every visible function at the pointer's x, which is
  // the one number a user actually wants while hovering a graph.
  const readout = useMemo(() => {
    const fns = tab.expressions
      .filter((e) => e.visible && e.kind === 'function' && e.source.trim())
      .map((e) => ({ label: e.label || e.source, fn: scope.compile1(e.source, 'x') }));
    return (x: number, y: number) => {
      const parts = [`x ${fmt(x)}   y ${fmt(y)}`];
      for (const f of fns.slice(0, 3)) {
        if (f.fn.error) continue;
        parts.push(`${truncate(f.label)} = ${fmt(f.fn.fn(x))}`);
      }
      return parts.join('\n');
    };
  }, [tab.expressions, scope]);

  return (
    <Plot2D
      ref={plotRef}
      scene={scene}
      onViewportChange={setViewport}
      showCrosshair={tab.showCrosshair}
      readout={(x, y) => readout(x, y)}
      onDoubleClick={() => useStore.getState().resetViewport()}
    />
  );
}

export function graphingCsv(tab: TabState): string | null {
  const functions = tab.expressions.filter((e) => e.visible && e.kind === 'function' && e.source.trim());
  if (!functions.length) return null;
  // The scope is rebuilt from scratch here because the export runs from the
  // native menu, where there is no component and so no hook to read from.
  const scope = new EvalScope();
  for (const p of tab.parameters) scope.set(p.name, p.value);
  scope.set('time', tab.timeline.t);
  const compiled = functions.map((e) => ({ label: e.label || e.source, ...scope.compile1(e.source, 'x') }));
  const rows: string[] = ['x,' + compiled.map((c) => JSON.stringify(c.label)).join(',')];
  const n = 1000;
  for (let i = 0; i <= n; i++) {
    const x = tab.viewport.xMin + ((tab.viewport.xMax - tab.viewport.xMin) * i) / n;
    rows.push([x, ...compiled.map((c) => c.fn(x))].map((v) => (Number.isFinite(v) ? v : '')).join(','));
  }
  return rows.join('\n');
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return v.toExponential(3);
  return v.toFixed(4);
}

function truncate(s: string): string {
  return s.length > 14 ? `${s.slice(0, 13)}…` : s;
}
