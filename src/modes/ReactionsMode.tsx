import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import type { TabState } from '../core/types';
import {
  GAS_CONSTANT,
  arrhenius,
  buildNetwork,
  equilibriumConstant,
  parseReaction,
  rateConstants,
  reactionQuotient,
  runKinetics,
  steepestPoint,
  titrationCurve,
  type Reaction,
} from '../core/chemistry/reactions';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { AnalyticCard } from '../components/sandbox/AnalyticCard';
import type { AnalyticResult } from '../core/physics/analytic';
import {
  Button,
  Callout,
  Collapsible,
  Field,
  IconButton,
  NumberField,
  Panel,
  Row,
  SegmentedControl,
  Slider,
  Stat,
  StatList,
  TextField,
  Toggle,
  fmt,
} from '../components/ui/controls';
import { IconPlus, IconTrash } from '../components/ui/Icons';
import { SERIES_COLOURS } from '../core/types';
import type { Layer, PlotScene } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* Chemical reactions.
 *
 * Every number on screen here is integrated or solved, never sketched. That
 * distinction is the whole mode:
 *
 *   Kinetics — the network you type becomes a system of ODEs by mass action
 *     and is integrated. Nothing knows what an equilibrium is; the flat line
 *     at the end is where the forward and reverse rates happened to balance.
 *   Equilibrium — the same run, kicked partway through. Le Chatelier's
 *     principle is then something you watch happen rather than something you
 *     are told, and the equilibrium constant is measurably unchanged by the
 *     kick while the concentrations all move.
 *   Titration — solved from the charge balance at every volume. The buffer
 *     plateau and the jump at equivalence are consequences of Ka, so changing
 *     Ka moves them correctly because there is nothing else it could do.
 *   Arrhenius — k(T) over a temperature range, and the same data as ln k
 *     against 1/T, which is a straight line of slope −Ea/R.
 */

const VIEWS = [
  { value: 'kinetics' as const, label: 'Kinetics', title: 'Integrate the network you have typed.' },
  { value: 'equilibrium' as const, label: 'Le Chatelier', title: 'Reach equilibrium, then disturb it.' },
  { value: 'titration' as const, label: 'Titration', title: 'A pH curve solved from the charge balance.' },
  { value: 'arrhenius' as const, label: 'Arrhenius', title: 'Rate constants against temperature.' },
];

const PRESETS: { label: string; hint: string; reactions: Omit<Reaction, 'id'>[]; initial: Record<string, number>; duration: number }[] = [
  {
    label: 'A → B → C',
    hint: 'Consecutive. B rises then falls, and where its peak sits depends on the ratio of the two constants.',
    reactions: [
      { equation: 'A -> B', forward: 0.5, reverse: 0, activationForward: 50, activationReverse: 60, enabled: true },
      { equation: 'B -> C', forward: 0.2, reverse: 0, activationForward: 60, activationReverse: 70, enabled: true },
    ],
    initial: { A: 1, B: 0, C: 0 },
    duration: 25,
  },
  {
    label: 'A ⇌ B',
    hint: 'The simplest equilibrium. K = kf/kr comes out of the run, it is not put in.',
    reactions: [
      { equation: 'A <-> B', forward: 0.4, reverse: 0.1, activationForward: 50, activationReverse: 60, enabled: true },
    ],
    initial: { A: 1, B: 0 },
    duration: 20,
  },
  {
    label: 'Haber process',
    hint: 'N₂ + 3H₂ ⇌ 2NH₃. Third order forward, so the rate collapses as hydrogen runs down.',
    reactions: [
      { equation: 'N2 + 3H2 <-> 2NH3', forward: 0.6, reverse: 0.15, activationForward: 60, activationReverse: 110, enabled: true },
    ],
    initial: { N2: 1, H2: 3, NH3: 0 },
    duration: 30,
  },
  {
    label: 'Lotka–Volterra',
    hint: 'Autocatalysis twice over. The concentrations never settle — they cycle, and the cycle is real.',
    reactions: [
      { equation: 'A + X -> 2X', forward: 1, reverse: 0, activationForward: 40, activationReverse: 50, enabled: true },
      { equation: 'X + Y -> 2Y', forward: 1, reverse: 0, activationForward: 40, activationReverse: 50, enabled: true },
      { equation: 'Y -> P', forward: 1, reverse: 0, activationForward: 40, activationReverse: 50, enabled: true },
    ],
    initial: { A: 1, X: 0.4, Y: 0.3, P: 0 },
    duration: 30,
  },
];

const KICK = '#f472b6';
const EQUIV = '#fbbf24';
const BUFFER = '#4ade80';

// ------------------------------------------------------------------ scenes

/** The kinetics run, shared by the first two views so the kick lands on the same axes. */
function kineticsRun(tab: TabState) {
  const cfg = tab.reactions;
  const network = buildNetwork(cfg.reactions);
  return {
    network,
    result: runKinetics(network, cfg.initial, cfg.duration, cfg.samples, {
      useArrhenius: cfg.useArrhenius,
      temperature: cfg.temperature,
      perturbation: cfg.view === 'equilibrium' ? cfg.perturbation : null,
    }),
  };
}

function kineticsScene(tab: TabState): PlotScene {
  const cfg = tab.reactions;
  const { result } = kineticsRun(tab);
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];

  const xs = Float64Array.from(result.times);
  result.species.forEach((name, i) => {
    const colour = SERIES_COLOURS[i % SERIES_COLOURS.length];
    const ys = Float64Array.from(result.concentrations[i]);
    layers.push({ type: 'polyline', xs, ys, colour, width: 2 });
    legend.push({ label: name, colour });
  });

  // The clock's position, so the timeline scrubber means something here.
  if (tab.timeline.t > 0 && tab.timeline.t <= cfg.duration) {
    layers.push({ type: 'vline', x: tab.timeline.t, colour: '#94a3b8', style: 'dashed', width: 1 });
    result.species.forEach((_, i) => {
      const idx = Math.min(result.times.length - 1, Math.round((tab.timeline.t / cfg.duration) * (result.times.length - 1)));
      const y = result.concentrations[i][idx];
      if (!Number.isFinite(y)) return;
      layers.push({
        type: 'points',
        xs: [tab.timeline.t],
        ys: [y],
        colour: SERIES_COLOURS[i % SERIES_COLOURS.length],
        radius: 4,
      });
    });
  }

  if (cfg.view === 'equilibrium' && cfg.perturbation.enabled && cfg.perturbation.at > 0 && cfg.perturbation.at < cfg.duration) {
    layers.push({
      type: 'vline',
      x: cfg.perturbation.at,
      colour: KICK,
      style: 'dashed',
      width: 1.5,
      label: `${cfg.perturbation.amount >= 0 ? '+' : ''}${fmt(cfg.perturbation.amount, 3)} ${cfg.perturbation.species}`,
    });
    legend.push({ label: 'disturbance', colour: KICK, dashed: true });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'time',
    yLabel: 'concentration',
    logY: cfg.logScale,
    legend,
  };
}

function titrationScene(tab: TabState): PlotScene {
  const cfg = tab.reactions;
  const result = titrationCurve({
    acidConcentration: cfg.acidConcentration,
    acidVolume: cfg.acidVolume,
    baseConcentration: cfg.baseConcentration,
    ka: cfg.ka,
    acidInFlask: cfg.acidInFlask,
    maxVolume: cfg.titrantVolume,
    points: 600,
  });

  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];

  layers.push({
    type: 'polyline',
    xs: Float64Array.from(result.points.map((p) => p.volume)),
    ys: Float64Array.from(result.points.map((p) => p.ph)),
    colour: SERIES_COLOURS[0],
    width: 2.2,
  });
  legend.push({ label: 'pH', colour: SERIES_COLOURS[0] });

  if (cfg.showBuffer) {
    // Half-equivalence: the one place on the curve where pH = pKa exactly, and
    // the reason a titration is a way of *measuring* pKa.
    result.halfEquivalenceVolumes.forEach((v, i) => {
      layers.push({ type: 'vline', x: v, colour: BUFFER, style: 'dotted', width: 1 });
      layers.push({
        type: 'marker',
        x: v,
        y: result.pKa[i],
        label: `pKa = ${fmt(result.pKa[i], 3)}`,
        colour: BUFFER,
        radius: 4,
      });
    });
    if (result.halfEquivalenceVolumes.length) legend.push({ label: 'half-equivalence', colour: BUFFER, dashed: true });
  }

  if (cfg.showEquivalence) {
    result.equivalenceVolumes.forEach((v, i) => {
      layers.push({ type: 'vline', x: v, colour: EQUIV, style: 'dashed', width: 1.4 });
      layers.push({
        type: 'marker',
        x: v,
        y: result.equivalencePh[i],
        label: `pH ${fmt(result.equivalencePh[i], 3)}`,
        colour: EQUIV,
        radius: 4.5,
      });
    });
    if (result.equivalenceVolumes.length) legend.push({ label: 'equivalence', colour: EQUIV, dashed: true });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'titrant added (mL)',
    yLabel: 'pH',
    legend,
  };
}

function arrheniusScene(tab: TabState): PlotScene {
  const cfg = tab.reactions;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];
  const lo = Math.min(cfg.arrheniusFrom, cfg.arrheniusTo);
  const hi = Math.max(cfg.arrheniusFrom, cfg.arrheniusTo);
  const n = 240;

  const enabled = cfg.reactions.filter((r) => r.enabled && !parseReaction(r.equation).error);
  enabled.forEach((spec, i) => {
    const colour = SERIES_COLOURS[i % SERIES_COLOURS.length];
    const xs = new Float64Array(n + 1);
    const ys = new Float64Array(n + 1);
    for (let j = 0; j <= n; j++) {
      const t = lo + ((hi - lo) * j) / n;
      // The Arrhenius plot proper: ln k against 1/T, whose slope is −Ea/R.
      // Drawn this way because the straight line is the point — the curve of
      // k against T is impressive but tells you nothing you can measure off it.
      xs[j] = 1000 / t;
      ys[j] = Math.log(Math.max(1e-300, arrhenius(spec.forward, spec.activationForward, t)));
    }
    layers.push({ type: 'polyline', xs, ys, colour, width: 2 });
    legend.push({ label: `${spec.equation} (Ea ${fmt(spec.activationForward, 4)} kJ/mol)`, colour });
  });

  // Where the temperature slider currently sits.
  if (cfg.temperature >= lo && cfg.temperature <= hi) {
    layers.push({
      type: 'vline',
      x: 1000 / cfg.temperature,
      colour: '#94a3b8',
      style: 'dashed',
      width: 1,
      label: `${fmt(cfg.temperature, 4)} K`,
    });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: '1000 / T  (K⁻¹)',
    yLabel: 'ln k',
    legend,
  };
}

// ------------------------------------------------------------------- panel

export function ReactionsPanel({ tab }: { tab: TabState }) {
  const cfg = tab.reactions;
  const setReactions = useStore((s) => s.setReactions);
  const commit = useStore((s) => s.commit);

  const network = useMemo(() => buildNetwork(cfg.reactions), [cfg.reactions]);

  /* The run's duration and the clock's span are the same quantity seen twice,
   * so they move together. Leaving them independent means loading a longer
   * example draws a thirty-second curve under a scrubber that stops at
   * twenty-five, and the last fifth of the plot can never be reached. */
  const patchActive = useStore((s) => s.patchActive);
  const setDuration = useCallback(
    (duration: number) => {
      commit();
      setReactions({ duration });
      patchActive({
        timeline: { ...tab.timeline, tMax: duration, t: Math.min(tab.timeline.t, duration) },
      });
    },
    [commit, setReactions, patchActive, tab.timeline],
  );

  const patch = useCallback(
    (id: string, change: Partial<Reaction>) => {
      commit();
      setReactions({ reactions: cfg.reactions.map((r) => (r.id === id ? { ...r, ...change } : r)) });
    },
    [commit, setReactions, cfg.reactions],
  );

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    commit();
    setReactions({
      reactions: preset.reactions.map((r) => ({ ...r, id: uid('rxn') })),
      initial: { ...preset.initial },
      duration: preset.duration,
    });
    patchActive({ timeline: { ...tab.timeline, tMax: preset.duration, t: 0 } });
  };

  return (
    <>
      <Panel title="View">
        <SegmentedControl size="sm" value={cfg.view} onChange={(view) => setReactions({ view })} options={VIEWS} />
      </Panel>

      {(cfg.view === 'kinetics' || cfg.view === 'equilibrium' || cfg.view === 'arrhenius') && (
        <>
          <Panel title="Reactions">
            <div className="space-y-2">
              {cfg.reactions.map((r) => {
                const parsed = parseReaction(r.equation);
                return (
                  <div key={r.id} className="space-y-1.5 rounded-md border border-edge bg-surface-1 p-2">
                    <Row>
                      <div className="flex-1">
                        <TextField
                          value={r.equation}
                          placeholder="A + 2B -> C"
                          onChange={(equation) => patch(r.id, { equation })}
                        />
                      </div>
                      <IconButton
                        title="Remove this reaction"
                        onClick={() => {
                          commit();
                          setReactions({ reactions: cfg.reactions.filter((x) => x.id !== r.id) });
                        }}
                      >
                        <IconTrash />
                      </IconButton>
                    </Row>
                    {parsed.error && <div className="text-2xs text-warn">{parsed.error}</div>}
                    <Row>
                      <div className="flex-1">
                        <Field label={cfg.useArrhenius ? 'A forward' : 'k forward'}>
                          <NumberField
                            value={r.forward}
                            min={0}
                            step={0.05}
                            onChange={(forward) => patch(r.id, { forward })}
                          />
                        </Field>
                      </div>
                      {parsed.reversible && (
                        <div className="flex-1">
                          <Field label={cfg.useArrhenius ? 'A reverse' : 'k reverse'}>
                            <NumberField
                              value={r.reverse}
                              min={0}
                              step={0.05}
                              onChange={(reverse) => patch(r.id, { reverse })}
                            />
                          </Field>
                        </div>
                      )}
                    </Row>
                    {cfg.useArrhenius && (
                      <Row>
                        <div className="flex-1">
                          <Field label="Ea forward (kJ/mol)">
                            <NumberField
                              value={r.activationForward}
                              min={0}
                              step={5}
                              onChange={(activationForward) => patch(r.id, { activationForward })}
                            />
                          </Field>
                        </div>
                        {parsed.reversible && (
                          <div className="flex-1">
                            <Field label="Ea reverse">
                              <NumberField
                                value={r.activationReverse}
                                min={0}
                                step={5}
                                onChange={(activationReverse) => patch(r.id, { activationReverse })}
                              />
                            </Field>
                          </div>
                        )}
                      </Row>
                    )}
                    <Toggle label="Include" checked={r.enabled} onChange={(enabled) => patch(r.id, { enabled })} />
                  </div>
                );
              })}
            </div>
            <Button
              onClick={() => {
                commit();
                setReactions({
                  reactions: [
                    ...cfg.reactions,
                    {
                      id: uid('rxn'),
                      equation: 'C -> D',
                      forward: 0.2,
                      reverse: 0,
                      activationForward: 50,
                      activationReverse: 60,
                      enabled: true,
                    },
                  ],
                });
              }}
            >
              <IconPlus /> Add reaction
            </Button>
            {network.problems.length > 0 && (
              <Callout kind="warn">{network.problems.join(' ')}</Callout>
            )}
          </Panel>

          <Panel title="Starting concentrations">
            {network.species.length === 0 ? (
              <div className="text-2xs text-ink-faint">Type a reaction and its species will appear here.</div>
            ) : (
              <div className="space-y-1.5">
                {network.species.map((name) => (
                  <Field key={name} label={`[${name}]₀`}>
                    <NumberField
                      value={cfg.initial[name] ?? 0}
                      min={0}
                      step={0.1}
                      onChange={(v) => {
                        commit();
                        setReactions({ initial: { ...cfg.initial, [name]: v } });
                      }}
                    />
                  </Field>
                ))}
              </div>
            )}
          </Panel>

          {cfg.view !== 'arrhenius' && (
            <Panel title="Run">
              <Field label="Duration">
                <NumberField value={cfg.duration} min={1e-3} step={5} onChange={setDuration} />
              </Field>
              <Field label="Samples" hint="Points along the run. More is smoother and slower.">
                <NumberField value={cfg.samples} min={2} max={4000} step={50} onChange={(samples) => setReactions({ samples })} />
              </Field>
              <Toggle
                label="Logarithmic concentration"
                hint="Useful when one species is three orders of magnitude below another."
                checked={cfg.logScale}
                onChange={(logScale) => setReactions({ logScale })}
              />
            </Panel>
          )}

          {cfg.view === 'equilibrium' && (
            <Panel title="Disturbance">
              <Toggle
                label="Add something partway through"
                hint="Reach equilibrium, then change one concentration and watch where it settles."
                checked={cfg.perturbation.enabled}
                onChange={(enabled) => {
                  commit();
                  setReactions({ perturbation: { ...cfg.perturbation, enabled } });
                }}
              />
              {cfg.perturbation.enabled && (
                <>
                  <Field label="At time">
                    <Slider
                      value={cfg.perturbation.at}
                      min={0}
                      max={cfg.duration}
                      step={cfg.duration / 200}
                      onChange={(at) => setReactions({ perturbation: { ...cfg.perturbation, at } })}
                    />
                  </Field>
                  <Field label="Species">
                    <SegmentedControl
                      size="sm"
                      value={cfg.perturbation.species}
                      onChange={(species) => setReactions({ perturbation: { ...cfg.perturbation, species } })}
                      options={network.species.map((s) => ({ value: s, label: s }))}
                    />
                  </Field>
                  <Field label="Amount" hint="Negative removes some.">
                    <NumberField
                      value={cfg.perturbation.amount}
                      step={0.1}
                      onChange={(amount) => setReactions({ perturbation: { ...cfg.perturbation, amount } })}
                    />
                  </Field>
                </>
              )}
            </Panel>
          )}

          <Panel title="Temperature">
            <Toggle
              label="Arrhenius rate constants"
              hint="k = A·exp(−Ea/RT) rather than the constants typed above. The rates at the current temperature are kept, so only changing T changes anything."
              checked={cfg.useArrhenius}
              onChange={(useArrhenius) => {
                commit();
                /* Converted rather than reinterpreted.
                 *
                 * The same field holds k when Arrhenius is off and the
                 * pre-exponential A when it is on, and those differ by
                 * exp(Ea/RT) — a factor of 10⁸ for a typical activation
                 * energy. Simply flipping the flag would take a reaction that
                 * was finishing in twenty seconds and stop it dead, which
                 * reads as a broken switch rather than as a unit change. So
                 * the constants are rescaled to leave every rate exactly as
                 * it is at the temperature currently set; turning the
                 * temperature dial is then the only thing that moves them,
                 * which is the point of the view. */
                const convert = (value: number, activation: number) => {
                  const factor = Math.exp(activation / (GAS_CONSTANT * cfg.temperature));
                  const next = useArrhenius ? value * factor : value / factor;
                  return Number.isFinite(next) && next > 0 ? next : value;
                };
                setReactions({
                  useArrhenius,
                  reactions: cfg.reactions.map((r) => ({
                    ...r,
                    forward: convert(r.forward, r.activationForward),
                    reverse: r.reverse > 0 ? convert(r.reverse, r.activationReverse) : r.reverse,
                  })),
                });
              }}
            />
            <Field label={`T = ${fmt(cfg.temperature, 4)} K`}>
              <Slider
                value={cfg.temperature}
                min={200}
                max={800}
                step={1}
                onChange={(temperature) => setReactions({ temperature })}
              />
            </Field>
            {cfg.view === 'arrhenius' && (
              <Row>
                <div className="flex-1">
                  <Field label="From (K)">
                    <NumberField value={cfg.arrheniusFrom} min={1} step={10} onChange={(arrheniusFrom) => setReactions({ arrheniusFrom })} />
                  </Field>
                </div>
                <div className="flex-1">
                  <Field label="To (K)">
                    <NumberField value={cfg.arrheniusTo} min={1} step={10} onChange={(arrheniusTo) => setReactions({ arrheniusTo })} />
                  </Field>
                </div>
              </Row>
            )}
          </Panel>

          <Collapsible title="Examples" defaultOpen={false}>
            <div className="space-y-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="w-full rounded-md border border-edge bg-surface-1 px-2 py-1.5 text-left transition hover:border-accent"
                >
                  <div className="text-xs font-medium text-ink">{p.label}</div>
                  <div className="text-2xs text-ink-faint">{p.hint}</div>
                </button>
              ))}
            </div>
          </Collapsible>
        </>
      )}

      {cfg.view === 'titration' && (
        <>
          <Panel title="In the flask">
            <SegmentedControl
              size="sm"
              value={cfg.acidInFlask ? 'acid' : 'base'}
              onChange={(v) => {
                commit();
                setReactions({ acidInFlask: v === 'acid' });
              }}
              options={[
                { value: 'acid', label: 'Acid' },
                { value: 'base', label: 'Base' },
              ]}
            />
            <Field label="Concentration (M)">
              <NumberField
                value={cfg.acidConcentration}
                min={1e-6}
                step={0.01}
                onChange={(acidConcentration) => setReactions({ acidConcentration })}
              />
            </Field>
            <Field label="Volume (mL)">
              <NumberField value={cfg.acidVolume} min={0.1} step={5} onChange={(acidVolume) => setReactions({ acidVolume })} />
            </Field>
          </Panel>

          <Panel title="In the burette">
            <Field label="Concentration (M)">
              <NumberField
                value={cfg.baseConcentration}
                min={1e-6}
                step={0.01}
                onChange={(baseConcentration) => setReactions({ baseConcentration })}
              />
            </Field>
            <Field label="Add up to (mL)">
              <NumberField value={cfg.titrantVolume} min={1} step={10} onChange={(titrantVolume) => setReactions({ titrantVolume })} />
            </Field>
          </Panel>

          <Panel title="Dissociation constants">
            <div className="space-y-1.5">
              {cfg.ka.map((k, i) => (
                <Row key={i}>
                  <div className="flex-1">
                    <Field label={`pKa${cfg.ka.length > 1 ? ` ${i + 1}` : ''} = ${fmt(-Math.log10(k), 4)}`}>
                      <Slider
                        value={-Math.log10(k)}
                        min={0}
                        max={14}
                        step={0.05}
                        onChange={(p) => {
                          const next = [...cfg.ka];
                          next[i] = 10 ** -p;
                          setReactions({ ka: next });
                        }}
                      />
                    </Field>
                  </div>
                  {cfg.ka.length > 1 && (
                    <IconButton
                      title="Remove this dissociation"
                      onClick={() => {
                        commit();
                        setReactions({ ka: cfg.ka.filter((_, j) => j !== i) });
                      }}
                    >
                      <IconTrash />
                    </IconButton>
                  )}
                </Row>
              ))}
            </div>
            <Button
              onClick={() => {
                commit();
                // A second proton is always weaker than the first, by two or
                // three orders of magnitude in every real polyprotic acid.
                setReactions({ ka: [...cfg.ka, cfg.ka[cfg.ka.length - 1] / 1e4] });
              }}
            >
              <IconPlus /> Add a proton
            </Button>
            <Toggle label="Mark equivalence" checked={cfg.showEquivalence} onChange={(showEquivalence) => setReactions({ showEquivalence })} />
            <Toggle
              label="Mark half-equivalence"
              hint="Where pH = pKa, which is how a titration measures one."
              checked={cfg.showBuffer}
              onChange={(showBuffer) => setReactions({ showBuffer })}
            />
          </Panel>
        </>
      )}
    </>
  );
}

// ----------------------------------------------------------------- surface

export function ReactionsSurface({ tab }: { tab: TabState }) {
  const cfg = tab.reactions;
  const setViewport = useStore((s) => s.setViewport);
  const fitViewport = useStore((s) => s.fitViewport);
  const plotRef = usePlot2DRef();

  const scene = useMemo(() => {
    if (cfg.view === 'titration') return titrationScene(tab);
    if (cfg.view === 'arrhenius') return arrheniusScene(tab);
    return kineticsScene(tab);
  }, [tab, cfg.view]);

  /* Each view lives on completely different axes — seconds against molarity,
   * millilitres against pH, reciprocal kelvin against a logarithm — so the
   * frame is recomputed whenever the thing being plotted changes rather than
   * leaving the user to hunt for the curve. */
  const frameKey = [
    cfg.view,
    cfg.duration,
    cfg.logScale,
    JSON.stringify(cfg.reactions),
    JSON.stringify(cfg.initial),
    cfg.acidConcentration,
    cfg.acidVolume,
    cfg.baseConcentration,
    cfg.titrantVolume,
    cfg.ka.join(','),
    cfg.acidInFlask,
    cfg.arrheniusFrom,
    cfg.arrheniusTo,
  ].join('|');

  useEffect(() => {
    if (cfg.view === 'titration') {
      fitViewport({ xMin: 0, xMax: cfg.titrantVolume, yMin: 0, yMax: 14 });
      return;
    }
    if (cfg.view === 'arrhenius') {
      const lo = Math.min(cfg.arrheniusFrom, cfg.arrheniusTo);
      const hi = Math.max(cfg.arrheniusFrom, cfg.arrheniusTo);
      const enabled = cfg.reactions.filter((r) => r.enabled && !parseReaction(r.equation).error);
      const values = enabled.flatMap((r) => [
        Math.log(Math.max(1e-300, arrhenius(r.forward, r.activationForward, lo))),
        Math.log(Math.max(1e-300, arrhenius(r.forward, r.activationForward, hi))),
      ]);
      if (!values.length) return;
      const yLo = Math.min(...values);
      const yHi = Math.max(...values);
      const pad = Math.max(1, (yHi - yLo) * 0.15);
      fitViewport({ xMin: 1000 / hi, xMax: 1000 / lo, yMin: yLo - pad, yMax: yHi + pad });
      return;
    }
    const { result } = kineticsRun(tab);
    let top = 0;
    for (const row of result.concentrations) for (const v of row) if (Number.isFinite(v)) top = Math.max(top, v);
    if (top <= 0) top = 1;
    fitViewport({
      xMin: 0,
      xMax: cfg.duration,
      // A log axis cannot show zero, so the floor is a small positive number
      // rather than the −5% headroom the linear axis gets.
      yMin: cfg.logScale ? Math.max(1e-9, top * 1e-6) : -0.05 * top,
      yMax: top * 1.1,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);

  return (
    <SandboxLayout
      storageKey="reactions"
      canvas={
        <div className="h-full w-full">
          <Plot2D ref={plotRef} scene={scene} onViewportChange={setViewport} />
        </div>
      }
      instruments={
        <>
          {(cfg.view === 'kinetics' || cfg.view === 'equilibrium') && <KineticsReadout tab={tab} />}
          {cfg.view === 'titration' && <TitrationReadout tab={tab} />}
          {cfg.view === 'arrhenius' && <ArrheniusReadout tab={tab} />}
          <AnalyticCard result={analyseReactions(tab)} />
        </>
      }
    />
  );
}

function KineticsReadout({ tab }: { tab: TabState }) {
  const cfg = tab.reactions;
  const setReactions = useStore((s) => s.setReactions);
  const commit = useStore((s) => s.commit);
  const { network, result } = useMemo(() => kineticsRun(tab), [tab]);

  const last = result.times.length - 1;
  const final: Record<string, number> = {};
  result.species.forEach((s, i) => {
    final[s] = result.concentrations[i][last] ?? 0;
  });

  /* Le Chatelier's principle is about a system *at equilibrium* moving when it
   * is disturbed. A network of irreversible steps has no equilibrium to move,
   * so the view would show a kick and a return to the same finish — which
   * teaches the opposite of what it is for. Say so, and offer a network that
   * does have one rather than silently replacing the user's. */
  const reversible = network.reactions.some((r) => r.parsed.reversible && r.spec.reverse > 0);

  return (
    <>
      {cfg.view === 'equilibrium' && !reversible && (
        <div className="space-y-2 border-b border-edge px-3 py-2.5">
          <Callout kind="info">
            None of these reactions runs backwards, so there is no equilibrium here to disturb — whatever you add is
            simply consumed. Le Chatelier needs a reversible step.
          </Callout>
          <Button
            onClick={() => {
              commit();
              const preset = PRESETS.find((p) => p.label === 'Haber process');
              if (!preset) return;
              setReactions({
                reactions: preset.reactions.map((r) => ({ ...r, id: uid('rxn') })),
                initial: { ...preset.initial },
                duration: preset.duration,
                perturbation: { at: preset.duration / 2, species: 'N2', amount: 0.5, enabled: true },
              });
            }}
          >
            Load the Haber equilibrium
          </Button>
        </div>
      )}

      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          {result.species.map((s, i) => (
            <Stat key={s} label={`[${s}] final`} value={fmt(result.concentrations[i][last] ?? 0, 5)} />
          ))}
        </StatList>
        {result.problems.length > 0 && (
          <div className="pt-2">
            <Callout kind="warn">{result.problems.join(' ')}</Callout>
          </div>
        )}
      </div>

      {network.reactions.map(({ spec, parsed }) => {
        const k = rateConstants(spec, cfg.useArrhenius, cfg.temperature);
        const keq = equilibriumConstant(spec, cfg.useArrhenius, cfg.temperature);
        const q = reactionQuotient(parsed, final);
        return (
          <div key={spec.id} className="border-b border-edge px-3 py-2.5">
            <div className="pb-1.5 text-xs font-medium text-ink">{spec.equation}</div>
            <StatList>
              <Stat label="k forward" value={fmt(k.forward, 5)} />
              {parsed.reversible && <Stat label="k reverse" value={fmt(k.reverse, 5)} />}
              {/* Q is only worth showing next to a K it can be compared with.
                  An irreversible step has no equilibrium, so its "reaction
                  quotient" grows without bound and reporting it invites the
                  reader to compare it with nothing. */}
              {keq !== null && <Stat label="K = kf/kr" value={fmt(keq, 5)} emphasis />}
              {keq !== null && q !== null && <Stat label="Q at the end" value={fmt(q, 5)} />}
              {keq === null && <Stat label="Equilibrium" value="none — irreversible" />}
            </StatList>
            {keq !== null && q !== null && (
              <div className="pt-1.5 text-2xs text-ink-faint">
                {/* Q approaching K is the definition of reaching equilibrium, and
                    saying how close it got is more honest than a green tick. */}
                {Math.abs(q - keq) < 0.02 * Math.max(1e-12, keq)
                  ? 'Q has reached K, so this reaction is at equilibrium.'
                  : `Q is ${q > keq ? 'above' : 'below'} K, so this reaction is still moving ${q > keq ? 'left' : 'right'}.`}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function TitrationReadout({ tab }: { tab: TabState }) {
  const cfg = tab.reactions;
  const result = useMemo(
    () =>
      titrationCurve({
        acidConcentration: cfg.acidConcentration,
        acidVolume: cfg.acidVolume,
        baseConcentration: cfg.baseConcentration,
        ka: cfg.ka,
        acidInFlask: cfg.acidInFlask,
        maxVolume: cfg.titrantVolume,
        points: 600,
      }),
    [cfg],
  );
  const steepest = useMemo(() => steepestPoint(result.points), [result.points]);

  return (
    <div className="border-b border-edge px-3 py-2.5">
      <StatList>
        <Stat label="Starting pH" value={fmt(result.points[0]?.ph ?? 0, 4)} />
        {result.equivalenceVolumes.map((v, i) => (
          <Stat key={i} label={`Equivalence ${result.equivalenceVolumes.length > 1 ? i + 1 : ''}`} value={`${fmt(v, 4)} mL`} emphasis />
        ))}
        {result.equivalencePh.map((p, i) => (
          <Stat key={i} label={`pH there`} value={fmt(p, 4)} />
        ))}
        {steepest && <Stat label="Steepest at" value={`${fmt(steepest.volume, 4)} mL`} />}
      </StatList>
      {result.equivalencePh.length > 0 && (
        <div className="pt-2 text-2xs text-ink-faint">
          {/* The single most commonly mis-taught fact about titration, so it is
              worth saying explicitly and only when it is true. */}
          {Math.abs(result.equivalencePh[0] - 7) < 0.15
            ? 'Equivalence sits at pH 7 because both the acid and the base here are strong.'
            : `Equivalence is at pH ${fmt(result.equivalencePh[0], 3)}, not 7 — the conjugate ${
                cfg.acidInFlask ? 'base' : 'acid'
              } left in the flask is not a spectator.`}
        </div>
      )}
    </div>
  );
}

function ArrheniusReadout({ tab }: { tab: TabState }) {
  const cfg = tab.reactions;
  const enabled = cfg.reactions.filter((r) => r.enabled && !parseReaction(r.equation).error);
  return (
    <div className="border-b border-edge px-3 py-2.5">
      {enabled.length === 0 && <div className="text-2xs text-ink-faint">No readable reactions.</div>}
      {enabled.map((r) => {
        const k = arrhenius(r.forward, r.activationForward, cfg.temperature);
        const hotter = arrhenius(r.forward, r.activationForward, cfg.temperature + 10);
        return (
          <div key={r.id} className="pb-2">
            <div className="text-xs font-medium text-ink">{r.equation}</div>
            <StatList>
              <Stat label={`k at ${fmt(cfg.temperature, 4)} K`} value={fmt(k, 5)} emphasis />
              <Stat label="Ea" value={`${fmt(r.activationForward, 4)} kJ/mol`} />
              {/* The plot's x axis is 1000/T rather than 1/T, which keeps the
                  numbers readable — so the slope drawn is −Ea/1000R, and
                  labelling it −Ea/R would be off by a factor of a thousand. */}
              <Stat label="Slope (−Ea/1000R)" value={fmt(-r.activationForward / GAS_CONSTANT / 1000, 5)} />
              {/* The rule of thumb every chemistry course quotes, checked rather
                  than repeated: it holds near room temperature for Ea ≈ 50 kJ/mol
                  and nowhere else. */}
              <Stat label="×  per +10 K" value={fmt(k > 0 ? hotter / k : 0, 4)} />
            </StatList>
          </div>
        );
      })}
    </div>
  );
}

function analyseReactions(tab: TabState): AnalyticResult {
  const cfg = tab.reactions;
  if (cfg.view === 'titration') {
    return {
      title: 'Titration from the charge balance',
      equations: [
        String.raw`C_b + [\mathrm{H^+}] = C_a\sum_i i\,\alpha_i + \frac{K_w}{[\mathrm{H^+}]}`,
        String.raw`\mathrm{pH} = \mathrm{p}K_a + \log_{10}\frac{[\mathrm{A^-}]}{[\mathrm{HA}]}`,
      ],
      quantities: [],
      overlay: null,
      caveat:
        'Every point is the exact charge balance solved for [H⁺] by bisection — the Henderson–Hasselbalch line above is shown for comparison, not used. Activities are taken as concentrations, which is the usual approximation below about 0.1 M.',
    };
  }
  if (cfg.view === 'arrhenius') {
    return {
      title: 'Arrhenius',
      equations: [String.raw`k = A\,e^{-E_a/RT}`, String.raw`\ln k = \ln A - \frac{E_a}{R}\cdot\frac{1}{T}`],
      quantities: [],
      overlay: null,
      caveat:
        'A and Ea are taken as independent of temperature. Over a few hundred kelvin that is good; over a thousand it is not, and the real plot bends.',
    };
  }
  return {
    title: 'Mass action',
    equations: [
      String.raw`\text{rate} = k_f\prod_i [\mathrm{R}_i]^{\nu_i} - k_r\prod_j [\mathrm{P}_j]^{\nu_j}`,
      String.raw`\frac{d[\mathrm{X}]}{dt} = \sum_r \nu_{X,r}\,\text{rate}_r`,
      String.raw`K = \frac{k_f}{k_r} = \frac{\prod_j [\mathrm{P}_j]^{\nu_j}}{\prod_i [\mathrm{R}_i]^{\nu_i}}\bigg|_{\text{eq}}`,
    ],
    quantities: [],
    overlay: null,
    caveat:
      'Rate orders are taken from the stoichiometry, which is true for an elementary step and not for an overall equation. Write the mechanism out as separate steps and it is exact.',
  };
}

export function reactionsCsv(tab: TabState): string | null {
  const cfg = tab.reactions;
  if (cfg.view === 'titration') {
    const result = titrationCurve({
      acidConcentration: cfg.acidConcentration,
      acidVolume: cfg.acidVolume,
      baseConcentration: cfg.baseConcentration,
      ka: cfg.ka,
      acidInFlask: cfg.acidInFlask,
      maxVolume: cfg.titrantVolume,
      points: 600,
    });
    if (!result.points.length) return null;
    return toCsv(['volume_mL', 'pH'], result.points.map((p) => [p.volume, p.ph]));
  }

  if (cfg.view === 'arrhenius') {
    const lo = Math.min(cfg.arrheniusFrom, cfg.arrheniusTo);
    const hi = Math.max(cfg.arrheniusFrom, cfg.arrheniusTo);
    const enabled = cfg.reactions.filter((r) => r.enabled && !parseReaction(r.equation).error);
    if (!enabled.length) return null;
    const rows: (number | string)[][] = [];
    for (let i = 0; i <= 200; i++) {
      const t = lo + ((hi - lo) * i) / 200;
      rows.push([t, 1 / t, ...enabled.map((r) => arrhenius(r.forward, r.activationForward, t))]);
    }
    return toCsv(['T_K', 'inverse_T', ...enabled.map((r) => r.equation)], rows);
  }

  const { result } = kineticsRun(tab);
  if (!result.times.length) return null;
  return toCsv(
    ['time', ...result.species],
    result.times.map((t, i) => [t, ...result.concentrations.map((row) => row[i])]),
  );
}
