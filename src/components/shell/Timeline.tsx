import { useStore } from '../../core/store';
import { MODE_BY_ID, type TabState } from '../../core/types';
import { IconButton, NumberField, Select } from '../ui/controls';
import { IconPause, IconPlay, IconSkipBack, IconStepForward } from '../ui/Icons';

/**
 * The transport bar under the plot.
 *
 * One clock per tab drives everything animatable in that tab: parameter sweeps,
 * the matrix interpolation, particle advection, PDE playback. Having a single
 * shared clock rather than a timer per feature is what lets a Monte Carlo path
 * and a slider sweep stay in step while being scrubbed by hand.
 */
export function Timeline({ tab }: { tab: TabState }) {
  const setTime = useStore((s) => s.setTime);
  const togglePlay = useStore((s) => s.togglePlay);
  const stepTime = useStore((s) => s.stepTime);
  const restartTime = useStore((s) => s.restartTime);
  const patchActive = useStore((s) => s.patchActive);
  const tl = tab.timeline;
  const progress = ((tl.t - tl.tMin) / (tl.tMax - tl.tMin || 1)) * 100;

  return (
    <div className="flex items-center gap-2 border-t border-edge bg-surface-1 px-3 py-1.5">
      <IconButton title="Back to the start" onClick={restartTime}>
        <IconSkipBack size={14} />
      </IconButton>
      <IconButton title={tl.playing ? 'Pause' : 'Play'} active={tl.playing} onClick={togglePlay}>
        {tl.playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </IconButton>
      <IconButton title="Step forward" onClick={() => stepTime(0.02)}>
        <IconStepForward size={14} />
      </IconButton>

      <div className="relative flex-1">
        <input
          type="range"
          className="manifold-slider"
          style={{ ['--fill' as string]: `${Math.max(0, Math.min(100, progress))}%` }}
          min={tl.tMin}
          max={tl.tMax}
          step={(tl.tMax - tl.tMin) / 2000 || 0.001}
          value={tl.t}
          onChange={(e) => setTime(Number(e.target.value))}
        />
      </div>

      <span className="w-16 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-dim">
        {tl.t.toFixed(2)}
        {MODE_BY_ID.get(tab.mode)?.timeUnit ?? 's'}
      </span>

      <div className="w-20 shrink-0">
        <NumberField
          value={tl.tMax}
          min={0.1}
          step={1}
          suffix="s"
          onChange={(tMax) =>
            patchActive({ timeline: { ...tl, tMax: Math.max(tl.tMin + 0.1, tMax), t: Math.min(tl.t, tMax) } })
          }
        />
      </div>

      <div className="w-[6.5rem] shrink-0">
        <Select
          value={String(tl.speed)}
          onChange={(v) => patchActive({ timeline: { ...tl, speed: Number(v) } })}
          options={[
            { value: '0.25', label: '0.25×' },
            { value: '0.5', label: '0.5×' },
            { value: '1', label: '1×' },
            { value: '2', label: '2×' },
            { value: '4', label: '4×' },
          ]}
        />
      </div>

      <div className="w-[7.5rem] shrink-0">
        <Select
          value={tl.mode}
          onChange={(mode) => patchActive({ timeline: { ...tl, mode } })}
          options={[
            { value: 'loop', label: 'Loop' },
            { value: 'pingpong', label: 'Ping-pong' },
            { value: 'once', label: 'Once' },
          ]}
        />
      </div>
    </div>
  );
}
