import { useStore } from '../../core/store';
import type { TabState } from '../../core/types';
import { usePlotRef } from '../shell/PlotContext';
import { Button, Collapsible, NumberField, Row, Toggle } from '../ui/controls';

/* Used only when the plot has not been measured yet — the first render after a
 * project loads, before the canvas has laid out. Any value keeps the button
 * from doing nothing at all; the next click gets the real one. */
const FALLBACK_ASPECT = 0.625;

/** Viewport and grid controls, shared by every mode that draws on the 2D plot. */
export function ViewPanel({ tab, showAxesOptions = true }: { tab: TabState; showAxesOptions?: boolean }) {
  const setViewport = useStore((s) => s.setViewport);
  const patchActive = useStore((s) => s.patchActive);
  const resetViewport = useStore((s) => s.resetViewport);
  const squareViewport = useStore((s) => s.squareViewport);
  const plotRef = usePlotRef();
  const v = tab.viewport;

  return (
    <Collapsible title="View" defaultOpen={false}>
      <Row>
        <div className="flex-1">
          <span className="field-label">x min</span>
          <NumberField value={v.xMin} step={1} onChange={(xMin) => setViewport({ ...v, xMin })} />
        </div>
        <div className="flex-1">
          <span className="field-label">x max</span>
          <NumberField value={v.xMax} step={1} onChange={(xMax) => setViewport({ ...v, xMax })} />
        </div>
      </Row>
      <Row>
        <div className="flex-1">
          <span className="field-label">y min</span>
          <NumberField value={v.yMin} step={1} onChange={(yMin) => setViewport({ ...v, yMin })} />
        </div>
        <div className="flex-1">
          <span className="field-label">y max</span>
          <NumberField value={v.yMax} step={1} onChange={(yMax) => setViewport({ ...v, yMax })} />
        </div>
      </Row>

      <Row>
        <Button className="flex-1" onClick={resetViewport}>
          Reset
        </Button>
        <Button
          className="flex-1"
          title="Make one unit on x the same length as one unit on y, so circles look circular"
          onClick={() => squareViewport(plotRef.current?.plotAspect?.() ?? FALLBACK_ASPECT)}
        >
          Equal scales
        </Button>
      </Row>

      {showAxesOptions && (
        <>
          <Toggle label="Grid" checked={tab.showGrid} onChange={(showGrid) => patchActive({ showGrid })} />
          <Toggle
            label="Minor grid lines"
            checked={tab.showMinorGrid}
            onChange={(showMinorGrid) => patchActive({ showMinorGrid })}
          />
          <Toggle label="Axes" checked={tab.showAxes} onChange={(showAxes) => patchActive({ showAxes })} />
          <Toggle
            label="Crosshair"
            checked={tab.showCrosshair}
            onChange={(showCrosshair) => patchActive({ showCrosshair })}
          />
        </>
      )}
    </Collapsible>
  );
}
