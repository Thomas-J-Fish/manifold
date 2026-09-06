import { useCallback, useMemo } from 'react';
import { useStore } from '../core/store';
import { SERIES_COLOURS, type TabState } from '../core/types';
import { WINDOWS, type WindowName } from '../core/math/fft';
import {
  aliasFrequency,
  applyFilter,
  designFilter,
  frequencyResponse,
  satisfiesNyquist,
  sincReconstruct,
  spectrogram,
  spectrum,
  type FilterResponse,
} from '../core/math/signal';
import { Rng } from '../core/math/random';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { useSquareScales } from '../components/sandbox/useSquareScales';
import { ProbePlot, type Trace } from '../components/sandbox/ProbePlot';
import { AnalyticCard } from '../components/sandbox/AnalyticCard';
import { ViewPanel } from '../components/panels/ViewPanel';
import {
  Callout,
  Collapsible,
  Field,
  NumberField,
  Panel,
  Row,
  SegmentedControl,
  Select,
  Slider,
  Stat,
  StatList,
  Toggle,
  fmt,
} from '../components/ui/controls';
import { useScope } from '../hooks/useScope';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* Signal processing.
 *
 * The mode is built around one signal — an expression in t, or numbers pasted
 * in — looked at four ways: as a spectrum, as a spectrogram, through a filter,
 * and sampled too slowly on purpose. Everything downstream comes from the same
 * samples, so a change to the signal shows up everywhere at once, which is the
 * point: a filter's job is easier to see when you can watch what it removes.
 *
 * It pairs with the electronics sandbox deliberately. Build an RC low-pass
 * there, read off its time constant, put 1/2πRC in here as the cutoff, and the
 * Bode plot is the same curve the circuit produces.
 */

const VIEWS = [
  { value: 'spectrum' as const, label: 'Spectrum', title: 'The signal and what frequencies are in it.' },
  { value: 'spectrogram' as const, label: 'Over time', title: 'How the spectrum changes as the signal goes on.' },
  { value: 'filter' as const, label: 'Filter', title: 'Design one, and see its poles, its response and its effect.' },
  { value: 'sampling' as const, label: 'Aliasing', title: 'Sample too slowly on purpose and watch a tone become another one.' },
];

const RESPONSES: { value: FilterResponse; label: string }[] = [
  { value: 'lowpass', label: 'Low pass' },
  { value: 'highpass', label: 'High pass' },
  { value: 'bandpass', label: 'Band pass' },
  { value: 'notch', label: 'Notch' },
];

/** The samples the whole mode works from. */
function useSamples(tab: TabState): { t: Float64Array; y: Float64Array; error: string | null } {
  const cfg = tab.signals;
  const { scope } = useScope(tab.parameters, tab.expressions, tab.timeline.t);

  return useMemo(() => {
    if (cfg.useData && cfg.data.length > 1) {
      const y = Float64Array.from(cfg.data);
      const t = Float64Array.from(y, (_, i) => i / Math.max(1, cfg.sampleRate));
      return { t, y, error: null };
    }
    const count = Math.max(16, Math.min(1 << 16, Math.round(cfg.sampleRate * cfg.duration)));
    const { fn, error } = scope.compile1(cfg.expression || '0', 't');
    const t = new Float64Array(count);
    const y = new Float64Array(count);
    // Noise from the project's own seeded generator, so a spectrum with noise
    // in it is still the same spectrum tomorrow.
    const random = new Rng(`${cfg.seed}|${cfg.noise}`);
    for (let i = 0; i < count; i++) {
      t[i] = i / cfg.sampleRate;
      const value = fn(t[i]);
      y[i] = (Number.isFinite(value) ? value : 0) + (cfg.noise > 0 ? random.normal() * cfg.noise : 0);
    }
    return { t, y, error };
  }, [cfg.useData, cfg.data, cfg.sampleRate, cfg.duration, cfg.expression, cfg.noise, cfg.seed, scope]);
}

// ------------------------------------------------------------------ scenes

function spectrogramScene(tab: TabState, y: Float64Array): PlotScene {
  const cfg = tab.signals;
  const gram = spectrogram(y, cfg.sampleRate, cfg.windowSize);
  const layers: Layer[] = [];
  if (gram.frames > 1 && gram.bins > 1) {
    const image = new ImageData(gram.frames, gram.bins);
    for (let b = 0; b < gram.bins; b++) {
      for (let f = 0; f < gram.frames; f++) {
        const db = gram.db[f * gram.bins + b];
        const t = Math.max(0, Math.min(1, (db - gram.floor) / -gram.floor));
        // Rows run up the screen, down the raster.
        const at = ((gram.bins - 1 - b) * gram.frames + f) * 4;
        image.data[at] = Math.round(255 * Math.min(1, t * 1.6));
        image.data[at + 1] = Math.round(255 * Math.max(0, Math.min(1, t * 1.5 - 0.4)));
        image.data[at + 2] = Math.round(255 * Math.max(0, Math.min(1, t * 2.2 - 0.2)));
        image.data[at + 3] = 255;
      }
    }
    /* Each column stands for a whole window, so the image runs from half a
     * window before the first centre to half a window after the last. Drawn
     * centre-to-centre it stops short of both ends of the recording and leaves
     * a strip of empty axis that looks like missing data. */
    layers.push({
      type: 'image',
      image,
      x0: gram.times[0] - gram.halfWindow,
      y0: gram.frequency[0],
      x1: gram.times[gram.frames - 1] + gram.halfWindow,
      y1: gram.frequency[gram.bins - 1],
      smooth: true,
    });
  }
  return {
    viewport: tab.viewport,
    layers,
    showGrid: false,
    showMinorGrid: false,
    showAxes: tab.showAxes,
    xLabel: 't (s)',
    yLabel: 'frequency (Hz)',
    legend: [],
  };
}

function poleZeroScene(tab: TabState): PlotScene {
  const filter = designFilter({ ...tab.signals.filter, sampleRate: tab.signals.sampleRate });
  const layers: Layer[] = [];

  // The unit circle: inside it is stable, outside it is not.
  const steps = 200;
  const xs = new Float64Array(steps + 1);
  const ys = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    xs[i] = Math.cos(a);
    ys[i] = Math.sin(a);
  }
  layers.push({ type: 'polyline', xs, ys, colour: 'rgba(148,163,184,0.5)', width: 1.4 });
  layers.push({ type: 'hline', y: 0, colour: 'rgba(148,163,184,0.25)', style: 'dashed', width: 1 });
  layers.push({ type: 'vline', x: 0, colour: 'rgba(148,163,184,0.25)', style: 'dashed', width: 1 });

  layers.push({
    type: 'points',
    xs: filter.zeros.map((z) => z.re),
    ys: filter.zeros.map((z) => z.im),
    colour: '#38bdf8',
    radius: 5,
    shape: 'circle',
  });
  layers.push({
    type: 'points',
    xs: filter.poles.map((p) => p.re),
    ys: filter.poles.map((p) => p.im),
    colour: '#f472b6',
    radius: 5,
    shape: 'cross',
  });

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: false,
    showAxes: tab.showAxes,
    xLabel: 'Re z',
    yLabel: 'Im z',
    legend: [
      { label: 'poles', colour: '#f472b6' },
      { label: 'zeros', colour: '#38bdf8' },
    ],
  };
}

// ------------------------------------------------------------------ panel

export function SignalsPanel({ tab }: { tab: TabState }) {
  const cfg = tab.signals;
  const setSignals = useStore((s) => s.setSignals);
  const commit = useStore((s) => s.commit);

  const set = useCallback(
    (patch: Parameters<typeof setSignals>[0]) => {
      commit();
      setSignals(patch);
    },
    [commit, setSignals],
  );

  return (
    <>
      <Panel title="View">
        <SegmentedControl size="sm" value={cfg.view} onChange={(view) => set({ view })} options={VIEWS} />
      </Panel>

      {cfg.view !== 'sampling' && (
        <Panel title="Signal">
          <Field label="y(t), with t in seconds">
            <input
              type="text"
              value={cfg.expression}
              spellCheck={false}
              onChange={(e) => setSignals({ expression: e.target.value })}
              className="input-base w-full font-mono"
            />
          </Field>
          <Row>
            <div className="flex-1">
              <Field label="Sample rate (Hz)">
                <NumberField
                  value={cfg.sampleRate}
                  min={8}
                  max={192000}
                  step={100}
                  precision={0}
                  onChange={(sampleRate) => set({ sampleRate: Math.round(sampleRate) })}
                />
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Duration (s)">
                <NumberField value={cfg.duration} min={0.01} step={0.1} onChange={(duration) => set({ duration })} />
              </Field>
            </div>
          </Row>
          <p className="px-0.5 text-2xs text-ink-faint">
            Nyquist is {fmt(cfg.sampleRate / 2, 6)} Hz. Anything above that folds back down — the
            Aliasing view is about exactly that.
          </p>
          <Field label="Add noise (σ)" hint="From the project's seed, so the same noise comes back tomorrow.">
            <Slider value={cfg.noise} min={0} max={2} step={0.01} onChange={(noise) => set({ noise })} />
          </Field>

          <Field label="Window" hint={WINDOWS.find((w) => w.id === cfg.window)?.hint}>
            <Select
              value={cfg.window}
              onChange={(window) => set({ window: window as WindowName })}
              options={WINDOWS.map((w) => ({ value: w.id, label: w.label }))}
            />
          </Field>

          <Field label="Paste samples" hint="Numbers separated by commas, spaces or newlines. Used instead of the expression.">
            <textarea
              rows={3}
              spellCheck={false}
              defaultValue={cfg.data.join(', ')}
              onBlur={(e) => {
                const data = e.target.value
                  .split(/[\s,;]+/)
                  .map((v) => Number(v))
                  .filter((v) => Number.isFinite(v));
                set({ data, useData: data.length > 1 });
              }}
              className="input-base w-full font-mono"
            />
          </Field>
          {cfg.data.length > 1 && (
            <Toggle
              label={`Use the ${cfg.data.length} pasted samples`}
              checked={cfg.useData}
              onChange={(useData) => set({ useData })}
            />
          )}
        </Panel>
      )}

      {cfg.view === 'spectrogram' && (
        <Panel title="Resolution">
          <Field
            label="Window length (samples)"
            hint="Long windows resolve frequency and smear time; short ones do the opposite. There is no setting that does both."
          >
            <Select
              value={String(cfg.windowSize)}
              onChange={(v) => set({ windowSize: Number(v) })}
              options={[64, 128, 256, 512, 1024, 2048].map((n) => ({ value: String(n), label: `${n}` }))}
            />
          </Field>
          <StatList>
            <Stat label="Frequency resolution" value={`${fmt(cfg.sampleRate / cfg.windowSize, 4)} Hz`} />
            <Stat label="Time resolution" value={`${fmt((cfg.windowSize / cfg.sampleRate) * 1000, 4)} ms`} />
          </StatList>
        </Panel>
      )}

      {cfg.view === 'filter' && (
        <Panel title="Filter">
          <Field label="Response">
            <Select
              value={cfg.filter.response}
              onChange={(response) => set({ filter: { ...cfg.filter, response } })}
              options={RESPONSES}
            />
          </Field>
          {cfg.filter.response !== 'notch' && (
            <Field label="Family">
              <SegmentedControl
                size="sm"
                value={cfg.filter.family}
                onChange={(family) => set({ filter: { ...cfg.filter, family } })}
                options={[
                  { value: 'butterworth', label: 'Butterworth', title: 'As flat as possible in the passband.' },
                  { value: 'chebyshev', label: 'Chebyshev', title: 'Steeper, at the price of ripple in the passband.' },
                ]}
              />
            </Field>
          )}
          <Field label={cfg.filter.response === 'bandpass' ? 'Lower edge (Hz)' : 'Cutoff (Hz)'}>
            <Slider
              value={cfg.filter.cutoff}
              min={1}
              max={Math.max(2, cfg.sampleRate / 2 - 1)}
              step={1}
              onChange={(cutoff) => set({ filter: { ...cfg.filter, cutoff } })}
            />
          </Field>
          {cfg.filter.response === 'bandpass' && (
            <Field label="Upper edge (Hz)">
              <Slider
                value={cfg.filter.cutoffHigh}
                min={1}
                max={Math.max(2, cfg.sampleRate / 2 - 1)}
                step={1}
                onChange={(cutoffHigh) => set({ filter: { ...cfg.filter, cutoffHigh } })}
              />
            </Field>
          )}
          {cfg.filter.response === 'notch' ? (
            <Field label="Q" hint="How narrow the notch is. 30 removes mains hum without touching the music either side of it.">
              <Slider
                value={cfg.filter.q}
                min={0.5}
                max={60}
                step={0.5}
                onChange={(q) => set({ filter: { ...cfg.filter, q } })}
              />
            </Field>
          ) : (
            <Field label="Order" hint="Each order adds 6 dB per octave of roll-off, and one more pole.">
              <Slider
                value={cfg.filter.order}
                min={1}
                max={8}
                step={1}
                onChange={(order) => set({ filter: { ...cfg.filter, order: Math.round(order) } })}
              />
            </Field>
          )}
          {cfg.filter.family === 'chebyshev' && cfg.filter.response !== 'notch' && (
            <Field label="Passband ripple (dB)">
              <Slider
                value={cfg.filter.ripple}
                min={0.05}
                max={3}
                step={0.05}
                onChange={(ripple) => set({ filter: { ...cfg.filter, ripple } })}
              />
            </Field>
          )}
          <Toggle
            label="Filter the signal too"
            hint="Runs the samples through it, so the spectrum shows what actually came out."
            checked={cfg.filtered}
            onChange={(filtered) => set({ filtered })}
          />
          <Toggle label="Logarithmic frequency axis" checked={cfg.logFrequency} onChange={(logFrequency) => set({ logFrequency })} />
        </Panel>
      )}

      {cfg.view === 'sampling' && (
        <Panel title="Undersampling">
          <Field label="Tone frequency (Hz)">
            <Slider
              value={cfg.toneFrequency}
              min={1}
              max={2000}
              step={1}
              onChange={(toneFrequency) => set({ toneFrequency })}
            />
          </Field>
          <Field label="Sampling rate (Hz)">
            <Slider
              value={cfg.sampleFrequency}
              min={20}
              max={4000}
              step={10}
              onChange={(sampleFrequency) => set({ sampleFrequency })}
            />
          </Field>
          <Callout kind={satisfiesNyquist(cfg.toneFrequency, cfg.sampleFrequency) ? 'info' : 'warn'}>
            {satisfiesNyquist(cfg.toneFrequency, cfg.sampleFrequency)
              ? `Sampled fast enough: ${fmt(cfg.sampleFrequency, 5)} Hz is more than twice ${fmt(cfg.toneFrequency, 5)} Hz, so the tone can be recovered exactly.`
              : `Too slow. The samples are identical to those of a ${fmt(aliasFrequency(cfg.toneFrequency, cfg.sampleFrequency), 5)} Hz tone — not similar, identical — so nothing can tell them apart afterwards.`}
          </Callout>
        </Panel>
      )}

      <Panel title="Display">
        <Toggle label="Decibels" checked={cfg.decibels} onChange={(decibels) => set({ decibels })} />
      </Panel>

      <ViewPanel tab={tab} />
    </>
  );
}

// ------------------------------------------------------------------ surface

export function SignalsSurface({ tab }: { tab: TabState }) {
  const cfg = tab.signals;
  const setViewport = useStore((s) => s.setViewport);
  const fitViewport = useStore((s) => s.fitViewport);
  const plotRef = usePlot2DRef();
  const { t, y, error } = useSamples(tab);

  const filter = useMemo(
    () => designFilter({ ...cfg.filter, sampleRate: cfg.sampleRate }),
    [cfg.filter, cfg.sampleRate],
  );
  const shown = useMemo(
    () => (cfg.filtered && cfg.view !== 'sampling' ? applyFilter(filter, y) : y),
    [cfg.filtered, cfg.view, filter, y],
  );
  const spec = useMemo(() => spectrum(shown, cfg.sampleRate, cfg.window), [shown, cfg.sampleRate, cfg.window]);

  const waveform = useMemo((): Trace[] => {
    // At most a couple of thousand points on screen: more is slower and looks
    // identical, and the spectrum below is where the detail actually is.
    const stride = Math.max(1, Math.floor(t.length / 2000));
    const xs = new Float64Array(Math.ceil(t.length / stride));
    const ys = new Float64Array(xs.length);
    for (let i = 0, j = 0; i < t.length; i += stride, j++) {
      xs[j] = t[i];
      ys[j] = shown[i];
    }
    return [{ id: 'signal', label: cfg.filtered ? 'Filtered' : 'Signal', unit: '', colour: SERIES_COLOURS[0], xs, ys }];
  }, [t, shown, cfg.filtered]);

  const spectrumTrace = useMemo((): Trace[] => {
    const ys = cfg.decibels ? spec.db : spec.magnitude;
    return [{ id: 'spectrum', label: cfg.decibels ? 'Level' : 'Amplitude', unit: cfg.decibels ? 'dB' : '', colour: SERIES_COLOURS[2], xs: spec.frequency, ys }];
  }, [spec, cfg.decibels]);

  const response = useMemo(
    () => frequencyResponse(filter, cfg.sampleRate, 600, cfg.logFrequency),
    [filter, cfg.sampleRate, cfg.logFrequency],
  );

  const bode = useMemo((): Trace[] => [
    { id: 'mag', label: 'Magnitude', unit: 'dB', colour: SERIES_COLOURS[0], xs: response.frequency, ys: response.db },
  ], [response]);
  const phase = useMemo((): Trace[] => [
    { id: 'phase', label: 'Phase', unit: '°', colour: SERIES_COLOURS[4], xs: response.frequency, ys: response.phase },
  ], [response]);

  const sampling = useMemo(() => {
    const fs = cfg.sampleFrequency;
    const span = Math.min(0.05, 8 / Math.max(1, cfg.toneFrequency));
    const fine = 1200;
    const trueT = new Float64Array(fine);
    const trueY = new Float64Array(fine);
    for (let i = 0; i < fine; i++) {
      trueT[i] = (span * i) / (fine - 1);
      trueY[i] = Math.sin(2 * Math.PI * cfg.toneFrequency * trueT[i]);
    }
    const count = Math.max(2, Math.floor(span * fs) + 1);
    const sampleT = new Float64Array(count);
    const sampleY = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      sampleT[i] = i / fs;
      sampleY[i] = Math.sin((2 * Math.PI * cfg.toneFrequency * i) / fs);
    }
    const rebuilt = sincReconstruct(sampleY, fs, trueT);
    return { trueT, trueY, sampleT, sampleY, rebuilt, span };
  }, [cfg.toneFrequency, cfg.sampleFrequency]);

  const samplingScene = useMemo((): PlotScene => {
    const layers: Layer[] = [
      {
        type: 'curve',
        segments: [{ xs: sampling.trueT, ys: sampling.trueY, length: sampling.trueT.length }],
        colour: withAlpha(SERIES_COLOURS[0], 0.55),
        width: 1.6,
      },
      {
        type: 'curve',
        segments: [{ xs: sampling.trueT, ys: sampling.rebuilt, length: sampling.trueT.length }],
        colour: SERIES_COLOURS[3],
        width: 2.2,
      },
      { type: 'stems', xs: sampling.sampleT, ys: sampling.sampleY, colour: '#e2e8f0', radius: 3, width: 1 },
    ];
    return {
      viewport: tab.viewport,
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: tab.showMinorGrid,
      showAxes: tab.showAxes,
      xLabel: 't (s)',
      yLabel: 'amplitude',
      legend: [
        { label: 'the real tone', colour: withAlpha(SERIES_COLOURS[0], 0.55) },
        { label: 'what the samples rebuild', colour: SERIES_COLOURS[3] },
        { label: 'samples', colour: '#e2e8f0' },
      ],
    };
  }, [sampling, tab.viewport, tab.showGrid, tab.showMinorGrid, tab.showAxes]);

  const scene = useMemo(() => {
    if (cfg.view === 'spectrogram') return spectrogramScene(tab, shown);
    if (cfg.view === 'filter') return poleZeroScene(tab);
    return samplingScene;
  }, [cfg.view, tab, shown, samplingScene]);

  // Each view needs its own window; reframe when it changes.
  const frameKey = `${cfg.view}|${cfg.sampleRate}|${cfg.windowSize}|${sampling.span}`;
  const framed = useMemo(() => frameKey, [frameKey]);
  useMemo(() => {
    if (cfg.view === 'spectrogram') {
      fitViewport({ xMin: 0, xMax: Math.max(0.01, t.length / cfg.sampleRate), yMin: 0, yMax: cfg.sampleRate / 2 });
    } else if (cfg.view === 'filter') {
      fitViewport({ xMin: -1.35, xMax: 1.35, yMin: -1.2, yMax: 1.2 });
    } else if (cfg.view === 'sampling') {
      fitViewport({ xMin: 0, xMax: sampling.span, yMin: -1.35, yMax: 1.35 });
    }
    return framed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framed]);

  /* The pole–zero plot is the one view here where the two axes are the same
   * quantity, so an unequal scale draws the unit circle as an ellipse and a
   * pole 0.9 of the way out looks safely inside on one axis and outside on the
   * other. The rectangle fitted above is only a starting frame; this pins the
   * scales to the pane's measured aspect and keeps them there as it resizes. */
  useSquareScales(plotRef, tab.viewport, cfg.view === 'filter', 'contain');

  const analytic = useMemo(() => analyseSignals(tab, filter), [tab, filter]);
  const peaks = useMemo(() => topPeaks(spec.frequency, spec.magnitude, 5), [spec]);

  return (
    <SandboxLayout
      storageKey="signals"
      canvas={
        cfg.view === 'spectrum' ? (
          <div className="flex h-full w-full flex-col">
            {/* The waveform and its spectrum share the pane equally: neither is
                the subordinate of the other, and both want the height. */}
            <div className="min-h-0 flex-1 border-b border-edge">
              <ProbePlot traces={waveform} xLabel="t (s)" cursorTime={null} height={180} fill />
            </div>
            <div className="min-h-0 flex-1">
              <ProbePlot traces={spectrumTrace} xLabel="frequency (Hz)" cursorTime={null} height={200} fill />
            </div>
          </div>
        ) : cfg.view === 'filter' ? (
          <div className="flex h-full w-full flex-col overflow-auto">
            <div className="border-b border-edge">
              <ProbePlot traces={bode} xLabel="frequency (Hz)" cursorTime={null} height={210} />
            </div>
            <div className="border-b border-edge">
              <ProbePlot traces={phase} xLabel="frequency (Hz)" cursorTime={null} height={170} />
            </div>
            <div className="min-h-[240px] flex-1">
              <Plot2D ref={plotRef} scene={scene} onViewportChange={setViewport} readout={(x, yy) => `${x.toFixed(3)} + ${yy.toFixed(3)}i`} />
            </div>
          </div>
        ) : (
          <div className="h-full w-full">
            <Plot2D
              ref={plotRef}
              scene={scene}
              onViewportChange={setViewport}
              readout={(x, yy) =>
                cfg.view === 'spectrogram' ? `${x.toFixed(4)} s, ${yy.toFixed(1)} Hz` : `${x.toFixed(5)} s, ${yy.toFixed(3)}`
              }
            />
          </div>
        )
      }
      instruments={
        <>
          {error && (
            <div className="px-3 py-2.5">
              <Callout kind="warn">{error}</Callout>
            </div>
          )}

          {(cfg.view === 'spectrum' || cfg.view === 'spectrogram') && (
            <>
              <div className="border-b border-edge px-3 py-2.5">
                <StatList>
                  <Stat label="Samples" value={String(t.length)} />
                  <Stat label="Sample rate" value={`${fmt(cfg.sampleRate, 6)} Hz`} />
                  <Stat label="Nyquist" value={`${fmt(cfg.sampleRate / 2, 6)} Hz`} emphasis />
                  <Stat label="Bin width" value={`${fmt(spec.resolution, 4)} Hz`} />
                </StatList>
              </div>
              <Collapsible title="Strongest components" defaultOpen>
                <div className="space-y-0.5">
                  {peaks.map((p) => (
                    <div key={p.frequency} className="flex items-baseline justify-between px-2 py-1 font-mono text-2xs text-ink-dim">
                      <span>{fmt(p.frequency, 5)} Hz</span>
                      <span>{cfg.decibels ? `${fmt(20 * Math.log10(Math.max(1e-12, p.magnitude / peaks[0].magnitude)), 3)} dB` : fmt(p.magnitude, 4)}</span>
                    </div>
                  ))}
                  {peaks.length === 0 && <p className="px-2 py-2 text-2xs text-ink-faint">Nothing above the noise.</p>}
                </div>
                <p className="px-1 pt-1.5 text-2xs text-ink-faint">
                  Resolution is {fmt(spec.resolution, 4)} Hz — one over the length of the recording,
                  and no window or clever peak-finding changes that.
                </p>
              </Collapsible>
            </>
          )}

          {cfg.view === 'filter' && <FilterReadout tab={tab} filter={filter} />}

          {cfg.view === 'sampling' && (
            <div className="border-b border-edge px-3 py-2.5">
              <StatList>
                <Stat label="Tone" value={`${fmt(cfg.toneFrequency, 5)} Hz`} />
                <Stat label="Sampled at" value={`${fmt(cfg.sampleFrequency, 5)} Hz`} />
                <Stat label="Nyquist" value={`${fmt(cfg.sampleFrequency / 2, 5)} Hz`} />
                <Stat
                  label="Appears at"
                  value={`${fmt(aliasFrequency(cfg.toneFrequency, cfg.sampleFrequency), 5)} Hz`}
                  emphasis
                />
                <Stat label="Recoverable" value={satisfiesNyquist(cfg.toneFrequency, cfg.sampleFrequency) ? 'yes' : 'no'} />
              </StatList>
              <p className="pt-2 text-2xs text-ink-faint">
                The rebuilt curve is the band-limited reconstruction the sampling theorem
                guarantees — a sum of sincs through the samples, not a line joining them. When it
                comes out at the wrong frequency, that is the theorem being obeyed exactly.
              </p>
            </div>
          )}

          <AnalyticCard result={analytic} />
        </>
      }
    />
  );
}

function FilterReadout({ tab, filter }: { tab: TabState; filter: ReturnType<typeof designFilter> }) {
  const cfg = tab.signals;
  return (
    <>
      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat label="Design" value={filter.description} />
          <Stat label="Sections" value={String(filter.sections.length)} />
          <Stat label="Poles" value={String(filter.poles.length)} />
          <Stat label="Largest pole" value={fmt(filter.worstPole, 5)} emphasis />
          <Stat label="Stable" value={filter.stable ? 'yes' : 'no'} />
        </StatList>
        <p className="pt-2 text-2xs text-ink-faint">
          Every pole inside the unit circle means the impulse response dies away. A pole on it rings
          for ever; outside it, the output grows without bound — which is why the circle is drawn.
        </p>
      </div>
      <Collapsible title="Coefficients">
        <div className="space-y-1.5">
          {filter.sections.map((s, i) => (
            <div key={i} className="rounded-md border border-edge bg-surface-1 px-2 py-1.5 font-mono text-2xs text-ink-dim">
              <div>b = [{fmt(s.b0, 6)}, {fmt(s.b1, 6)}, {fmt(s.b2, 6)}]</div>
              <div>a = [1, {fmt(s.a1, 6)}, {fmt(s.a2, 6)}]</div>
            </div>
          ))}
        </div>
        <p className="px-1 pt-1.5 text-2xs text-ink-faint">
          y[n] = b₀x[n] + b₁x[n−1] + b₂x[n−2] − a₁y[n−1] − a₂y[n−2], applied in series.
        </p>
      </Collapsible>
      <div className="px-3 py-2.5">
        <Callout kind="info">
          An RC low-pass in the electronics sandbox has a cutoff of 1/2πRC. Build one there, work
          that out, put it in here, and this is the response it has.{' '}
          {cfg.filter.response === 'lowpass' && cfg.filter.order === 1
            ? 'First-order low pass is exactly an RC.'
            : ''}
        </Callout>
      </div>
    </>
  );
}

function topPeaks(frequency: Float64Array, magnitude: Float64Array, count: number) {
  const peaks: { frequency: number; magnitude: number }[] = [];
  for (let i = 2; i < magnitude.length - 2; i++) {
    if (magnitude[i] > magnitude[i - 1] && magnitude[i] >= magnitude[i + 1]) {
      peaks.push({ frequency: frequency[i], magnitude: magnitude[i] });
    }
  }
  peaks.sort((a, b) => b.magnitude - a.magnitude);
  const strongest = peaks[0]?.magnitude ?? 0;
  return peaks.filter((p) => p.magnitude > strongest * 0.01).slice(0, count);
}

function analyseSignals(tab: TabState, filter: ReturnType<typeof designFilter>) {
  const cfg = tab.signals;
  if (cfg.view === 'filter') {
    return {
      title: filter.description,
      equations: [
        String.raw`H(z) = \prod_{k} \frac{b_{0k} + b_{1k}z^{-1} + b_{2k}z^{-2}}{1 + a_{1k}z^{-1} + a_{2k}z^{-2}}`,
        String.raw`|H(f)| = \left[1 + \left(\frac{\tan(\pi f/f_{s})}{\tan(\pi f_{c}/f_{s})}\right)^{2N}\right]^{-1/2}`,
        String.raw`z = \frac{1 + sT/2}{1 - sT/2}`,
      ],
      quantities: [
        { label: 'Cutoff', value: cfg.filter.cutoff, unit: 'Hz' },
        { label: 'Order', value: cfg.filter.order, unit: '' },
        { label: 'Roll-off', value: 6.02 * cfg.filter.order, unit: 'dB/octave' },
      ],
      overlay: null,
      caveat:
        'The second line is the Butterworth magnitude, tangents and all: the bilinear transform warps frequency, and the cutoff is pre-warped so that it lands where it was asked to.',
    };
  }
  if (cfg.view === 'sampling') {
    return {
      title: 'Sampling',
      equations: [
        String.raw`f_{\text{alias}} = \left|f - f_{s}\left\lfloor \tfrac{f}{f_{s}} + \tfrac{1}{2} \right\rfloor\right|`,
        String.raw`x(t) = \sum_{n} x[n]\,\operatorname{sinc}\!\left(\frac{t - nT}{T}\right)`,
      ],
      quantities: [
        { label: 'Tone', value: cfg.toneFrequency, unit: 'Hz' },
        { label: 'Sampling rate', value: cfg.sampleFrequency, unit: 'Hz' },
        { label: 'Alias', value: aliasFrequency(cfg.toneFrequency, cfg.sampleFrequency), unit: 'Hz' },
      ],
      overlay: null,
      caveat: 'Exact, not approximate: above Nyquist the samples of the two tones are the same numbers.',
    };
  }
  return {
    title: 'The discrete Fourier transform',
    equations: [
      String.raw`X_{k} = \sum_{n=0}^{N-1} x_{n}\,w_{n}\,e^{-2\pi i kn/N}`,
      String.raw`\Delta f = \frac{f_{s}}{N} = \frac{1}{T_{\text{record}}}`,
    ],
    quantities: [
      { label: 'Sample rate', value: cfg.sampleRate, unit: 'Hz' },
      { label: 'Nyquist', value: cfg.sampleRate / 2, unit: 'Hz' },
    ],
    overlay: null,
    caveat:
      'Resolution is set by how long you recorded for, and by nothing else. A longer window resolves finer; a different window function only changes how the leakage is shaped.',
  };
}

// ------------------------------------------------------------------ export

export function signalsCsv(tab: TabState): string | null {
  const cfg = tab.signals;
  const filter = designFilter({ ...cfg.filter, sampleRate: cfg.sampleRate });
  if (cfg.view === 'filter') {
    const response = frequencyResponse(filter, cfg.sampleRate, 800, cfg.logFrequency);
    return toCsv(
      ['frequency_Hz', 'magnitude_dB', 'phase_deg', 'group_delay_samples'],
      Array.from(response.frequency, (f, i) => [f, response.db[i], response.phase[i], response.groupDelay[i]]),
    );
  }
  const count = Math.max(16, Math.min(1 << 16, Math.round(cfg.sampleRate * cfg.duration)));
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) y[i] = Math.sin((2 * Math.PI * cfg.toneFrequency * i) / cfg.sampleRate);
  const spec = spectrum(y, cfg.sampleRate, cfg.window);
  return toCsv(
    ['frequency_Hz', 'amplitude', 'db'],
    Array.from(spec.frequency, (f, i) => [f, spec.magnitude[i], spec.db[i]]),
  );
}
