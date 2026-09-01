import { useState } from 'react';
import { useStore } from '../../core/store';
import type { Parameter } from '../../core/types';
import { Collapsible, IconButton, NumberField, Row, Select, Slider, Toggle, formatNumber } from '../ui/controls';
import { IconClose, IconPlay, IconPlus, IconTrash } from '../ui/Icons';

/**
 * The slider rack.
 *
 * Sliders are what turn a static plot into an instrument, so this panel is
 * deliberately the second thing in the sidebar and deliberately dense: name,
 * live value, track and range all on two lines, with the range editors hidden
 * until asked for. Dragging a slider does not push an undo entry — see the note
 * on `setParameterValue` in the store.
 */
export function ParameterPanel({ parameters }: { parameters: Parameter[] }) {
  const addParameter = useStore((s) => s.addParameter);

  return (
    <Collapsible
      title={`Parameters${parameters.length ? ` · ${parameters.length}` : ''}`}
      actions={
        <IconButton title="Add a parameter" onClick={() => addParameter()}>
          <IconPlus size={14} />
        </IconButton>
      }
    >
      {parameters.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          Use any letter in an expression — <span className="font-mono text-ink-dim">a·sin(b·x)</span> — and a
          slider appears here for it automatically.
        </p>
      ) : (
        <div className="space-y-2.5">
          {parameters.map((p) => (
            <ParameterRow key={p.id} parameter={p} />
          ))}
        </div>
      )}
    </Collapsible>
  );
}

function ParameterRow({ parameter }: { parameter: Parameter }) {
  const setParameterValue = useStore((s) => s.setParameterValue);
  const updateParameter = useStore((s) => s.updateParameter);
  const removeParameter = useStore((s) => s.removeParameter);
  const commit = useStore((s) => s.commit);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-edge bg-surface-1 px-2 pb-1.5 pt-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded px-1 font-mono text-sm font-semibold text-accent-soft hover:bg-surface-3"
          title="Edit range and animation"
        >
          {parameter.name}
        </button>
        <span className="flex-1 text-right font-mono text-xs tabular-nums text-ink">
          {formatNumber(parameter.value, 4)}
        </span>
        <IconButton
          title={parameter.animated ? 'Stop animating this parameter' : 'Sweep this parameter on the timeline'}
          active={parameter.animated}
          onClick={() => {
            commit();
            updateParameter(parameter.id, { animated: !parameter.animated });
          }}
        >
          <IconPlay size={11} />
        </IconButton>
        <IconButton title={`Remove ${parameter.name}`} onClick={() => removeParameter(parameter.id)}>
          <IconClose size={13} />
        </IconButton>
      </div>

      <Slider
        value={parameter.value}
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        disabled={parameter.animated}
        onChange={(v) => setParameterValue(parameter.id, v)}
      />

      {expanded && (
        <div className="mt-1.5 space-y-2 border-t border-edge pt-2">
          <Row>
            <div className="flex-1">
              <span className="field-label">Min</span>
              <NumberField
                value={parameter.min}
                step={1}
                onChange={(v) => updateParameter(parameter.id, { min: v })}
              />
            </div>
            <div className="flex-1">
              <span className="field-label">Max</span>
              <NumberField
                value={parameter.max}
                step={1}
                onChange={(v) => updateParameter(parameter.id, { max: v })}
              />
            </div>
            <div className="flex-1">
              <span className="field-label">Step</span>
              <NumberField
                value={parameter.step}
                step={0.01}
                min={0}
                onChange={(v) => updateParameter(parameter.id, { step: Math.max(1e-9, v) })}
              />
            </div>
          </Row>

          <Row>
            <div className="flex-1">
              <span className="field-label">Name</span>
              <input
                className="input-base font-mono"
                value={parameter.name}
                spellCheck={false}
                onChange={(e) =>
                  // Only letters, digits and underscores are valid identifiers
                  // in the expression grammar; filtering here stops the user
                  // creating a parameter no expression can ever refer to.
                  updateParameter(parameter.id, {
                    name: e.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 12),
                  })
                }
              />
            </div>
            <div className="flex-1">
              <span className="field-label">Sweep (s)</span>
              <NumberField
                value={parameter.period}
                min={0.1}
                step={0.5}
                onChange={(v) => updateParameter(parameter.id, { period: v })}
              />
            </div>
          </Row>

          <div>
            <span className="field-label">Sweep style</span>
            <Select
              value={parameter.animationMode}
              onChange={(v) => updateParameter(parameter.id, { animationMode: v })}
              options={[
                { value: 'loop', label: 'Loop — jump back to the start' },
                { value: 'pingpong', label: 'Ping-pong — reverse at each end' },
                { value: 'once', label: 'Once — stop at the top' },
              ]}
            />
          </div>

          <Toggle
            label="Animate with the timeline"
            hint="Driven by the shared clock below the plot."
            checked={parameter.animated}
            onChange={(v) => {
              commit();
              updateParameter(parameter.id, { animated: v });
            }}
          />

          <button
            type="button"
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-edge py-1 text-2xs text-ink-faint hover:border-rose-500/50 hover:text-rose-300"
            onClick={() => removeParameter(parameter.id)}
          >
            <IconTrash size={12} />
            Remove parameter
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Maps the shared clock onto a parameter's own range.
 *
 * Each parameter has its own sweep period, so several can animate at different
 * rates against one timeline — which is how a Lissajous figure gets built out
 * of two sliders rather than a special case.
 */
export function animatedValue(parameter: Parameter, time: number): number {
  if (!parameter.animated) return parameter.value;
  const span = parameter.max - parameter.min;
  if (span <= 0 || parameter.period <= 0) return parameter.value;
  const phase = time / parameter.period;
  switch (parameter.animationMode) {
    case 'once':
      return parameter.min + span * Math.min(1, phase);
    case 'pingpong': {
      const t = phase % 2;
      const u = t < 1 ? t : 2 - t;
      return parameter.min + span * u;
    }
    case 'loop':
    default:
      return parameter.min + span * (phase % 1);
  }
}
