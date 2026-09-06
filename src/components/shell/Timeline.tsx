import { useStore } from '../../core/store';
import { playbackSpeed } from '../../core/defaults';
import { MODE_BY_ID, type TabState } from '../../core/types';
import { IconButton, NumberField, Select } from '../ui/controls';
import { IconPause, IconPlay, IconSkipBack, IconStepForward } from '../ui/Icons';

/* The clock, at enough precision to read.
 *
 * Two decimals is right for a ten-second sweep and useless for an eighty
 * millisecond one, where it shows "0.00" for the whole run. The number of
 * decimals follows the span being scrubbed. */
function formatClock(t: number, span: number): string {
  const digits = span >= 2 ? 2 : span >= 0.02 ? 4 : span >= 0.0002 ? 6 : 8;
  return t.toFixed(digits);
}

/* Playback speed, including genuine slow motion.
 *
 * Some of what this app simulates happens in milliseconds, and at 1× — one
 * simulated second per real second — an eighty-millisecond run replays twelve
 * times a second and a ten-millisecond one a hundred times. Both look like a
 * bug rather than like physics. So the ladder runs down to a thousandth of
 * real time, and everything below 1× is labelled as the slow motion it is
 * rather than as an opaque decimal. The tab's own speed is spliced in, so a
 * project saved with any value still shows that value selected. */
const SPEED_LADDER = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 4];

function formatSpeed(v: number): string {
  if (v >= 1) return `${Number(v.toPrecision(3))}×`;
  const slow = 1 / v;
  return `${Number(slow.toPrecision(3))}× slow`;
}

function speedOptions(current: number): { value: string; label: string }[] {
  const values = SPEED_LADDER.includes(current) ? SPEED_LADDER : [...SPEED_LADDER, current].sort((a, b) => a - b);
  return values.map((v) => ({ value: String(v), label: formatSpeed(v) }));
}

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
      {/* A fiftieth of the run, not a fixed twenty milliseconds: on a
          ten-millisecond timeline the old step jumped past the end. */}
      <IconButton title="Step forward" onClick={() => stepTime((tl.tMax - tl.tMin) / 50 || 0.02)}>
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

      <span className="w-20 shrink-0 text-right font-mono text-2xs tabular-nums text-ink-dim">
        {formatClock(tl.t, tl.tMax - tl.tMin)}
        {MODE_BY_ID.get(tab.mode)?.timeUnit ?? 's'}
      </span>

      <div className="w-20 shrink-0">
        <NumberField
          value={tl.tMax}
          min={0}
          /* A tenth of a second used to be the floor, which made the wave and
             circuit runs — measured in milliseconds — impossible to type. */
          step={Math.max(1e-6, (tl.tMax - tl.tMin) / 10)}
          suffix="s"
          onChange={(tMax) =>
            patchActive({
              timeline: {
                ...tl,
                tMax: Math.max(tl.tMin + 1e-6, tMax),
                t: Math.min(tl.t, tMax),
                speed: playbackSpeed(Math.max(tl.tMin + 1e-6, tMax) - tl.tMin),
              },
            })
          }
        />
      </div>

      <div className="w-[8rem] shrink-0">
        <Select
          value={String(tl.speed)}
          onChange={(v) => patchActive({ timeline: { ...tl, speed: Number(v) } })}
          options={speedOptions(tl.speed)}
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
