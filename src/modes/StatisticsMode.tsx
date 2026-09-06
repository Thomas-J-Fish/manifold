import { useMemo, useState } from 'react';
import { useStore } from '../core/store';
import type { StatisticsConfig, TabState } from '../core/types';
import {
  DISTRIBUTIONS,
  defaultParams,
  getDistribution,
  type Distribution,
} from '../core/math/distributions';
import {
  andersonDarlingNormal,
  correlation,
  histogram,
  kde,
  oneSampleT,
  pairedT,
  parseNumberList,
  summarise,
  twoSampleT,
  zTest,
  type TestResult,
} from '../core/math/stats';
import { sampleFunction } from '../core/math/sampling';
import { bridge } from '../core/bridge';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { ViewPanel } from '../components/panels/ViewPanel';
import {
  Button,
  Callout,
  Collapsible,
  Field,
  NumberField,
  Row,
  SegmentedControl,
  Select,
  Slider,
  Stat,
  StatList,
  Toggle,
  fmt,
  fmtP,
} from '../components/ui/controls';
import { Formula } from '../components/inputs/MathField';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';

const SHADE = '#8b7cf6';

/**
 * A viewport that frames a distribution properly.
 *
 * The x range comes from the distribution's own window; the y range is found
 * by sampling the density and taking its peak, because a Beta(0.5, 0.5) and a
 * Normal(0, 20) differ by three orders of magnitude in height and no fixed
 * default suits both.
 */
function frameDistribution(dist: Distribution, params: Record<string, number>, view: 'pdf' | 'cdf') {
  const [xMin, xMax] = dist.window(params);
  if (view === 'cdf') return { xMin, xMax, yMin: -0.06, yMax: 1.08 };
  let peak = 0;
  const samples = 400;
  for (let i = 0; i <= samples; i++) {
    const x = dist.kind === 'discrete'
      ? Math.round(xMin + ((xMax - xMin) * i) / samples)
      : xMin + ((xMax - xMin) * i) / samples;
    const y = dist.pdf(x, params);
    if (Number.isFinite(y) && y > peak) peak = y;
  }
  if (!(peak > 0)) peak = 1;
  return { xMin, xMax, yMin: -peak * 0.09, yMax: peak * 1.18 };
}
const COMPARE = '#38bdf8';
const DATA = '#34d399';
/* Sample B needs its own colour, not sample A's. A two-sample test whose plot
 * shows one sample is worse than no plot: it invites the reader to judge a
 * difference from a picture of half of it. */
const DATA_B = '#fbbf24';

/* ------------------------------------------------------------------ maths */

interface TailRegion {
  /** Intervals to shade, in the variable's units. */
  intervals: [number, number][];
  /** Total probability inside the shaded region. */
  probability: number;
  lower: number | null;
  upper: number | null;
  description: string;
}

/**
 * Resolves the shaded region from the configuration.
 *
 * Two directions are supported and they are genuinely different questions.
 * Driving by probability answers "where are the 5% cut-offs?" — the everyday
 * critical-value lookup. Driving by value answers "how extreme is 2.3?" — the
 * p-value calculation. Both are here because a statistics tab that only does
 * one of them is only half a statistics tab.
 */
function resolveTail(dist: Distribution, params: Record<string, number>, cfg: StatisticsConfig): TailRegion {
  const [supportLo, supportHi] = dist.support(params);
  const window = dist.window(params);
  const lo = Number.isFinite(supportLo) ? supportLo : window[0] - 10;
  const hi = Number.isFinite(supportHi) ? supportHi : window[1] + 10;
  const cdf = (x: number) => dist.cdf(x, params);
  const q = (p: number) => dist.quantile(p, params);
  const p = Math.min(0.999999, Math.max(1e-9, cfg.probability));

  const byProbability = cfg.driveBy === 'probability';

  switch (cfg.tail) {
    case 'none':
      return { intervals: [], probability: 0, lower: null, upper: null, description: '' };

    case 'left': {
      const cut = byProbability ? q(p) : cfg.lower;
      return {
        intervals: [[lo, cut]],
        probability: cdf(cut),
        lower: cut,
        upper: null,
        description: `P(X ≤ ${fmt(cut)})`,
      };
    }

    case 'right': {
      const cut = byProbability ? q(1 - p) : cfg.upper;
      return {
        intervals: [[cut, hi]],
        probability: 1 - cdf(cut),
        lower: null,
        upper: cut,
        description: `P(X ≥ ${fmt(cut)})`,
      };
    }

    case 'two': {
      const a = byProbability ? q(p / 2) : Math.min(cfg.lower, cfg.upper);
      const b = byProbability ? q(1 - p / 2) : Math.max(cfg.lower, cfg.upper);
      return {
        intervals: [
          [lo, a],
          [b, hi],
        ],
        probability: cdf(a) + (1 - cdf(b)),
        lower: a,
        upper: b,
        description: `P(X ≤ ${fmt(a)}) + P(X ≥ ${fmt(b)})`,
      };
    }

    case 'between': {
      // In probability mode this is the central interval *containing* the
      // stated mass — a confidence interval rather than a rejection region.
      const a = byProbability ? q((1 - p) / 2) : Math.min(cfg.lower, cfg.upper);
      const b = byProbability ? q((1 + p) / 2) : Math.max(cfg.lower, cfg.upper);
      return {
        intervals: [[a, b]],
        probability: cdf(b) - cdf(a),
        lower: a,
        upper: b,
        description: `P(${fmt(a)} ≤ X ≤ ${fmt(b)})`,
      };
    }

    case 'outside': {
      const a = byProbability ? q((1 - p) / 2) : Math.min(cfg.lower, cfg.upper);
      const b = byProbability ? q((1 + p) / 2) : Math.max(cfg.lower, cfg.upper);
      return {
        intervals: [
          [lo, a],
          [b, hi],
        ],
        probability: cdf(a) + (1 - cdf(b)),
        lower: a,
        upper: b,
        description: `P(X < ${fmt(a)} or X > ${fmt(b)})`,
      };
    }
  }
}

function runTest(cfg: StatisticsConfig): TestResult | null {
  const a = cfg.dataA;
  const b = cfg.dataB;
  try {
    switch (cfg.testId) {
      case 'oneSampleT':
        return a.length >= 2 ? oneSampleT(a, cfg.testMu0, cfg.testTail, cfg.confidence) : null;
      case 'twoSampleT':
        return a.length >= 2 && b.length >= 2
          ? twoSampleT(a, b, { tail: cfg.testTail, conf: cfg.confidence, pooled: cfg.pooled })
          : null;
      case 'pairedT':
        return a.length >= 2 && b.length >= 2 ? pairedT(a, b, cfg.testTail, cfg.confidence) : null;
      case 'zTest':
        return a.length >= 1 ? zTest(a, cfg.testMu0, cfg.testSigma, cfg.testTail, cfg.confidence) : null;
      case 'correlation':
        return a.length >= 4 && b.length >= 4 ? correlation(a, b) : null;
      case 'normality':
        return a.length >= 8 ? andersonDarlingNormal(a) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ panel */

export function StatisticsPanel({ tab }: { tab: TabState }) {
  const setStatistics = useStore((s) => s.setStatistics);
  const cfg = tab.statistics;
  const dist = getDistribution(cfg.distributionId);
  const region = useMemo(() => resolveTail(dist, cfg.params, cfg), [dist, cfg]);
  const test = useMemo(() => runTest(cfg), [cfg]);

  return (
    <>
      <Collapsible title="Distribution">
        <Select
          value={cfg.distributionId}
          onChange={(id) => {
            const next = getDistribution(id);
            const params = defaultParams(next);
            setStatistics({ distributionId: id, params });
            // Re-frame the plot around the new distribution: keeping the old
            // window almost always leaves the density off screen entirely, or
            // as a flat line along the axis.
            useStore.getState().setViewport(frameDistribution(next, params, cfg.view));
          }}
          options={DISTRIBUTIONS.map((d) => ({
            value: d.id,
            label: d.name,
            group: d.kind === 'continuous' ? 'Continuous' : 'Discrete',
          }))}
        />
        <p className="text-2xs leading-relaxed text-ink-faint">{dist.blurb}</p>

        {dist.params.map((p) => (
          <div key={p.key}>
            <div className="flex items-baseline justify-between">
              <span className="field-label">{p.label}</span>
              <span className="font-mono text-2xs tabular-nums text-ink">{fmt(cfg.params[p.key] ?? p.default)}</span>
            </div>
            <Slider
              value={cfg.params[p.key] ?? p.default}
              min={p.min}
              max={p.max}
              step={p.integer ? 1 : p.step}
              onChange={(v) => setStatistics({ params: { ...cfg.params, [p.key]: v } })}
            />
          </div>
        ))}

        <SegmentedControl
          value={cfg.view}
          onChange={(view) => {
            setStatistics({ view });
            useStore.getState().setViewport(frameDistribution(dist, cfg.params, view));
          }}
          options={[
            { value: 'pdf', label: dist.kind === 'discrete' ? 'Mass' : 'Density' },
            { value: 'cdf', label: 'Cumulative' },
          ]}
        />

        <Button onClick={() => useStore.getState().setViewport(frameDistribution(dist, cfg.params, cfg.view))}>
          Frame the distribution
        </Button>

        <StatList>
          <Stat label="Mean" value={fmt(dist.mean(cfg.params))} />
          <Stat label="Variance" value={fmt(dist.variance(cfg.params))} />
          <Stat label="Std. dev." value={fmt(Math.sqrt(dist.variance(cfg.params)))} />
          <Stat label="Median" value={fmt(dist.quantile(0.5, cfg.params))} />
          {dist.skewness && <Stat label="Skewness" value={fmt(dist.skewness(cfg.params))} />}
        </StatList>
      </Collapsible>

      <Collapsible title="Tails & probabilities">
        <Select
          value={cfg.tail}
          onChange={(tail) => setStatistics({ tail })}
          options={[
            { value: 'none', label: 'No shading' },
            { value: 'left', label: 'Left tail' },
            { value: 'right', label: 'Right tail' },
            { value: 'two', label: 'Two tails (rejection region)' },
            { value: 'between', label: 'Between (confidence interval)' },
            { value: 'outside', label: 'Outside an interval' },
          ]}
        />

        {cfg.tail !== 'none' && (
          <>
            <SegmentedControl
              value={cfg.driveBy}
              onChange={(driveBy) => {
                // Carry the current answer across so switching direction does
                // not jump the shading to somewhere unrelated.
                if (driveBy === 'value' && region.lower !== null) {
                  setStatistics({ driveBy, lower: region.lower, upper: region.upper ?? region.lower });
                } else if (driveBy === 'probability') {
                  setStatistics({ driveBy, probability: Math.max(1e-6, Math.min(0.999, region.probability)) });
                } else {
                  setStatistics({ driveBy });
                }
              }}
              options={[
                { value: 'probability', label: 'From a probability' },
                { value: 'value', label: 'From a value' },
              ]}
              size="sm"
            />

            {cfg.driveBy === 'probability' ? (
              <Field label={cfg.tail === 'between' ? 'Confidence level' : 'Tail area α'}>
                <NumberField
                  value={cfg.probability}
                  min={1e-6}
                  max={0.999999}
                  step={0.01}
                  onChange={(probability) => setStatistics({ probability })}
                />
                <div className="mt-1.5 flex gap-1">
                  {(cfg.tail === 'between' ? [0.9, 0.95, 0.99] : [0.1, 0.05, 0.01, 0.001]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setStatistics({ probability: v })}
                      className={`flex-1 rounded border px-1 py-0.5 text-2xs transition-colors ${
                        Math.abs(cfg.probability - v) < 1e-9
                          ? 'border-accent-deep bg-accent/20 text-accent-soft'
                          : 'border-edge text-ink-faint hover:border-edge-strong hover:text-ink-dim'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </Field>
            ) : (
              <Row>
                {cfg.tail !== 'right' && (
                  <div className="flex-1">
                    <span className="field-label">{cfg.tail === 'left' ? 'Cut-off' : 'Lower'}</span>
                    <NumberField value={cfg.lower} step={0.1} onChange={(lower) => setStatistics({ lower })} />
                  </div>
                )}
                {cfg.tail !== 'left' && (
                  <div className="flex-1">
                    <span className="field-label">{cfg.tail === 'right' ? 'Cut-off' : 'Upper'}</span>
                    <NumberField value={cfg.upper} step={0.1} onChange={(upper) => setStatistics({ upper })} />
                  </div>
                )}
              </Row>
            )}

            <div className="rounded-md border border-accent-deep/40 bg-accent/10 px-2.5 py-2">
              <p className="text-2xs text-ink-faint">{region.description}</p>
              <p className="font-mono text-lg tabular-nums text-accent-soft">{region.probability.toFixed(6)}</p>
              {region.lower !== null && (
                <p className="mt-0.5 font-mono text-2xs text-ink-dim">lower cut-off {fmt(region.lower, 8)}</p>
              )}
              {region.upper !== null && (
                <p className="font-mono text-2xs text-ink-dim">upper cut-off {fmt(region.upper, 8)}</p>
              )}
            </div>
            <p className="text-2xs leading-relaxed text-ink-faint">
              Drag the shaded edge on the plot to move the cut-off directly.
            </p>
          </>
        )}
      </Collapsible>

      {/* Open when there is already something in it: a project or an example
          that arrives with a comparison, sample data or a test configured must
          show it, not hide it behind a heading the user has to guess at. */}
      <Collapsible title="Compare" defaultOpen={cfg.compareId !== null}>
        <Select
          value={cfg.compareId ?? ''}
          onChange={(id) =>
            setStatistics(
              id
                ? { compareId: id, compareParams: defaultParams(getDistribution(id)) }
                : { compareId: null, compareParams: {} },
            )
          }
          options={[
            { value: '', label: 'None' },
            ...DISTRIBUTIONS.map((d) => ({ value: d.id, label: d.name })),
          ]}
        />
        {cfg.compareId &&
          getDistribution(cfg.compareId).params.map((p) => (
            <div key={p.key}>
              <div className="flex items-baseline justify-between">
                <span className="field-label">{p.label}</span>
                <span className="font-mono text-2xs text-ink">{fmt(cfg.compareParams[p.key] ?? p.default)}</span>
              </div>
              <Slider
                value={cfg.compareParams[p.key] ?? p.default}
                min={p.min}
                max={p.max}
                step={p.integer ? 1 : p.step}
                onChange={(v) => setStatistics({ compareParams: { ...cfg.compareParams, [p.key]: v } })}
              />
            </div>
          ))}
      </Collapsible>

      <DataPanel cfg={cfg} />
      <TestPanel cfg={cfg} test={test} />
      <ViewPanel tab={tab} />
    </>
  );
}

function DataPanel({ cfg }: { cfg: StatisticsConfig }) {
  const setStatistics = useStore((s) => s.setStatistics);
  const pushToast = useStore((s) => s.pushToast);
  const [rawA, setRawA] = useState(cfg.dataA.join(' '));
  const [rawB, setRawB] = useState(cfg.dataB.join(' '));
  const summaryA = useMemo(() => (cfg.dataA.length ? summarise(cfg.dataA) : null), [cfg.dataA]);

  const importCsv = async () => {
    const file = await bridge().importText({ extensions: ['csv', 'txt', 'tsv'], typeName: 'Data' });
    if (!file) return;
    const values = parseNumberList(file.text);
    if (!values.length) {
      pushToast({ kind: 'warn', message: 'No numbers were found in that file.' });
      return;
    }
    setRawA(values.join(' '));
    setStatistics({ dataA: values, dataLabelA: file.path.split(/[\\/]/).pop() ?? 'Sample A' });
    pushToast({ kind: 'success', message: `Loaded ${values.length} values` });
  };

  return (
    <Collapsible title="Sample data" defaultOpen={cfg.dataA.length > 0 || cfg.dataB.length > 0}>
      <Field label="Sample A" hint="Numbers separated by spaces, commas or new lines.">
        <textarea
          className="input-base h-16 resize-y font-mono text-2xs"
          value={rawA}
          placeholder="12.1 11.8 13.4 …"
          onChange={(e) => setRawA(e.target.value)}
          onBlur={() => setStatistics({ dataA: parseNumberList(rawA) })}
        />
      </Field>
      <Field label="Sample B (optional)">
        <textarea
          className="input-base h-16 resize-y font-mono text-2xs"
          value={rawB}
          placeholder="For two-sample and paired tests"
          onChange={(e) => setRawB(e.target.value)}
          onBlur={() => setStatistics({ dataB: parseNumberList(rawB) })}
        />
      </Field>

      <Row>
        <Button className="flex-1" onClick={importCsv}>
          Import a file
        </Button>
        <Button
          className="flex-1"
          onClick={() => {
            setRawA('');
            setRawB('');
            setStatistics({ dataA: [], dataB: [] });
          }}
        >
          Clear
        </Button>
      </Row>

      {summaryA && (
        <StatList>
          <Stat label="n" value={String(summaryA.n)} />
          <Stat label="Mean" value={fmt(summaryA.mean)} />
          <Stat label="Std. dev." value={fmt(summaryA.sd)} />
          <Stat label="Std. error" value={fmt(summaryA.sem)} />
          <Stat label="Min" value={fmt(summaryA.min)} />
          <Stat label="Q1" value={fmt(summaryA.q1)} />
          <Stat label="Median" value={fmt(summaryA.median)} />
          <Stat label="Q3" value={fmt(summaryA.q3)} />
          <Stat label="Max" value={fmt(summaryA.max)} />
          <Stat label="Skewness" value={fmt(summaryA.skewness)} />
        </StatList>
      )}

      <Toggle
        label="Histogram"
        checked={cfg.showHistogram}
        onChange={(showHistogram) => setStatistics({ showHistogram })}
      />
      <Toggle
        label="Kernel density estimate"
        hint="Gaussian kernel with Silverman's bandwidth."
        checked={cfg.showKde}
        onChange={(showKde) => setStatistics({ showKde })}
      />
      <Field label="Binning rule">
        <Select
          value={cfg.binRule}
          onChange={(binRule) => setStatistics({ binRule })}
          options={[
            { value: 'auto', label: 'Automatic (Freedman–Diaconis)' },
            { value: 'freedman', label: 'Freedman–Diaconis' },
            { value: 'scott', label: 'Scott' },
            { value: 'sturges', label: 'Sturges' },
            { value: 'sqrt', label: 'Square root' },
            { value: 'fixed', label: 'Fixed count' },
          ]}
        />
      </Field>
      {cfg.binRule === 'fixed' && (
        <Field label="Bins">
          <NumberField
            value={cfg.binCount}
            min={1}
            max={300}
            step={1}
            onChange={(binCount) => setStatistics({ binCount: Math.round(binCount) })}
          />
        </Field>
      )}
    </Collapsible>
  );
}

function TestPanel({ cfg, test }: { cfg: StatisticsConfig; test: TestResult | null }) {
  const setStatistics = useStore((s) => s.setStatistics);
  return (
    <Collapsible title="Hypothesis test" defaultOpen={cfg.testId !== 'none'}>
      <Select
        value={cfg.testId}
        onChange={(testId) => setStatistics({ testId })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'oneSampleT', label: 'One-sample t-test' },
          { value: 'twoSampleT', label: 'Two-sample t-test' },
          { value: 'pairedT', label: 'Paired t-test' },
          { value: 'zTest', label: 'z-test (σ known)' },
          { value: 'correlation', label: 'Pearson correlation' },
          { value: 'normality', label: 'Anderson–Darling normality' },
        ]}
      />

      {(cfg.testId === 'oneSampleT' || cfg.testId === 'zTest') && (
        <Field label="Null hypothesis μ₀">
          <NumberField value={cfg.testMu0} step={0.5} onChange={(testMu0) => setStatistics({ testMu0 })} />
        </Field>
      )}
      {cfg.testId === 'zTest' && (
        <Field label="Known σ">
          <NumberField value={cfg.testSigma} min={1e-9} step={0.1} onChange={(testSigma) => setStatistics({ testSigma })} />
        </Field>
      )}
      {cfg.testId === 'twoSampleT' && (
        <Toggle
          label="Assume equal variances"
          hint="Off uses Welch's correction, which is the safer default."
          checked={cfg.pooled}
          onChange={(pooled) => setStatistics({ pooled })}
        />
      )}
      {cfg.testId !== 'none' && cfg.testId !== 'normality' && cfg.testId !== 'correlation' && (
        <Field label="Alternative">
          <Select
            value={cfg.testTail}
            onChange={(testTail) => setStatistics({ testTail })}
            options={[
              { value: 'two', label: 'Two-sided (≠)' },
              { value: 'left', label: 'Less than (<)' },
              { value: 'right', label: 'Greater than (>)' },
            ]}
          />
        </Field>
      )}
      {cfg.testId !== 'none' && (
        <Field label="Confidence level">
          <NumberField
            value={cfg.confidence}
            min={0.5}
            max={0.9999}
            step={0.01}
            onChange={(confidence) => setStatistics({ confidence })}
          />
        </Field>
      )}

      {cfg.testId !== 'none' && !test && (
        <Callout kind="warn">Not enough data for this test yet. Paste values into Sample data above.</Callout>
      )}

      {test && (
        <div className="space-y-2">
          <div className="rounded-md border border-edge bg-surface-1 p-2.5">
            <p className="text-2xs text-ink-faint">{test.name}</p>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="font-mono text-sm text-ink">
                {test.name.includes('correlation') ? 't' : test.distribution.id === 'normal' ? 'z' : 't'} ={' '}
                {fmt(test.statistic)}
              </span>
              <span
                className={`font-mono text-sm ${
                  test.pValue < 1 - cfg.confidence ? 'text-emerald-300' : 'text-ink-dim'
                }`}
              >
                p = {fmtP(test.pValue)}
              </span>
            </div>
            {test.df !== undefined && (
              <p className="mt-0.5 font-mono text-2xs text-ink-faint">{fmt(test.df, 5)} degrees of freedom</p>
            )}
            {test.interval && (
              <p className="mt-1 font-mono text-2xs text-ink-dim">
                {(cfg.confidence * 100).toFixed(0)}% CI [{fmt(test.interval[0])}, {fmt(test.interval[1])}]
              </p>
            )}
          </div>
          <div className="space-y-1">
            {test.notes.map((n) => (
              <p key={n} className="text-2xs leading-relaxed text-ink-faint">
                {n}
              </p>
            ))}
          </div>
          <Callout>
            {test.pValue < 1 - cfg.confidence
              ? `At the ${((1 - cfg.confidence) * 100).toFixed(0)}% level this is evidence against the null hypothesis. It does not measure the size of the effect — read the confidence interval for that.`
              : `At the ${((1 - cfg.confidence) * 100).toFixed(0)}% level there is not enough evidence to reject the null. That is not the same as showing it is true.`}
          </Callout>
        </div>
      )}
    </Collapsible>
  );
}

/* ------------------------------------------------------------------ surface */

export function StatisticsSurface({ tab }: { tab: TabState }) {
  const setViewport = useStore((s) => s.setViewport);
  const setStatistics = useStore((s) => s.setStatistics);
  const plotRef = usePlot2DRef();
  const cfg = tab.statistics;
  const dist = getDistribution(cfg.distributionId);
  const region = useMemo(() => resolveTail(dist, cfg.params, cfg), [dist, cfg]);

  const scene = useMemo<PlotScene>(() => {
    const layers: Layer[] = [];
    const legend: { label: string; colour: string; dashed?: boolean }[] = [];
    const view = { ...tab.viewport, width: 1200, height: 700 };
    const isCdf = cfg.view === 'cdf';
    const f = (x: number) => (isCdf ? dist.cdf(x, cfg.params) : dist.pdf(x, cfg.params));

    // ---- sample data underneath the theoretical curve
    if (cfg.dataA.length > 1 && cfg.showHistogram && !isCdf) {
      const h = histogram(cfg.dataA, cfg.binRule, cfg.binCount);
      layers.push({
        type: 'bars',
        edges: h.edges,
        heights: h.density,
        colour: withAlpha(DATA, 0.28),
        stroke: withAlpha(DATA, 0.65),
      });
      legend.push({ label: `${cfg.dataLabelA} (n=${cfg.dataA.length})`, colour: DATA });
    }
    if (cfg.dataA.length > 4 && cfg.showKde && !isCdf) {
      const k = kde(cfg.dataA, tab.viewport.xMin, tab.viewport.xMax, 300);
      layers.push({ type: 'polyline', xs: k.xs, ys: k.ys, colour: DATA, width: 1.8, style: 'dashed' });
    }
    if (cfg.dataB.length > 1 && cfg.showHistogram && !isCdf) {
      const h = histogram(cfg.dataB, cfg.binRule, cfg.binCount);
      layers.push({
        type: 'bars',
        edges: h.edges,
        heights: h.density,
        colour: withAlpha(DATA_B, 0.24),
        stroke: withAlpha(DATA_B, 0.65),
      });
      legend.push({ label: `${cfg.dataLabelB} (n=${cfg.dataB.length})`, colour: DATA_B });
    }
    if (cfg.dataB.length > 4 && cfg.showKde && !isCdf) {
      const k = kde(cfg.dataB, tab.viewport.xMin, tab.viewport.xMax, 300);
      layers.push({ type: 'polyline', xs: k.xs, ys: k.ys, colour: DATA_B, width: 1.8, style: 'dashed' });
    }

    // ---- shaded region
    if (dist.kind === 'continuous') {
      for (const [a, b] of region.intervals) {
        const lo = Math.max(a, tab.viewport.xMin - 1);
        const hi = Math.min(b, tab.viewport.xMax + 1);
        if (hi <= lo) continue;
        const segments = sampleFunction(f, { ...view, xMin: lo, xMax: hi });
        layers.push({ type: 'area', segments, baseline: 0, colour: withAlpha(SHADE, 0.32) });
      }
    } else {
      // A discrete mass function is shaded by highlighting whole spikes rather
      // than by filling an area, which would imply a density it does not have.
      const [sLo, sHi] = dist.support(cfg.params);
      const kMax = Math.min(Number.isFinite(sHi) ? sHi : tab.viewport.xMax, tab.viewport.xMax);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = Math.max(0, Math.ceil(Math.max(sLo, tab.viewport.xMin))); k <= kMax; k++) {
        if (region.intervals.some(([a, b]) => k >= a && k <= b)) {
          xs.push(k);
          ys.push(f(k));
        }
      }
      if (xs.length) layers.push({ type: 'stems', xs, ys, colour: SHADE, width: 6, radius: 4.5, alpha: 0.45 });
    }

    // ---- the distribution itself
    if (dist.kind === 'continuous') {
      layers.push({ type: 'curve', segments: sampleFunction(f, view), colour: SHADE, width: 2.2 });
    } else {
      const [sLo, sHi] = dist.support(cfg.params);
      const xs: number[] = [];
      const ys: number[] = [];
      const kMax = Math.min(Number.isFinite(sHi) ? sHi : tab.viewport.xMax, tab.viewport.xMax, 5000);
      for (let k = Math.max(0, Math.ceil(Math.max(sLo, tab.viewport.xMin))); k <= kMax; k++) {
        xs.push(k);
        ys.push(f(k));
      }
      layers.push({ type: 'stems', xs, ys, colour: SHADE, width: 1.8, radius: 3.2 });
    }
    legend.push({ label: dist.name, colour: SHADE });

    // ---- comparison overlay
    if (cfg.compareId) {
      const other = getDistribution(cfg.compareId);
      const g = (x: number) => (isCdf ? other.cdf(x, cfg.compareParams) : other.pdf(x, cfg.compareParams));
      if (other.kind === 'continuous') {
        layers.push({ type: 'curve', segments: sampleFunction(g, view), colour: COMPARE, width: 1.8, style: 'dashed' });
      } else {
        const xs: number[] = [];
        const ys: number[] = [];
        for (let k = Math.max(0, Math.ceil(tab.viewport.xMin)); k <= Math.min(tab.viewport.xMax, 5000); k++) {
          xs.push(k);
          ys.push(g(k));
        }
        layers.push({ type: 'stems', xs, ys, colour: COMPARE, width: 1.4, radius: 2.4, alpha: 0.8 });
      }
      legend.push({ label: other.name, colour: COMPARE, dashed: true });
    }

    // ---- cut-off markers
    if (region.lower !== null && Number.isFinite(region.lower)) {
      layers.push({ type: 'vline', x: region.lower, colour: SHADE, label: fmt(region.lower, 6), width: 1.5 });
    }
    if (region.upper !== null && Number.isFinite(region.upper)) {
      layers.push({ type: 'vline', x: region.upper, colour: SHADE, label: fmt(region.upper, 6), width: 1.5 });
    }
    layers.push({ type: 'hline', y: 0, colour: 'rgba(148,163,184,0.25)', style: 'solid', width: 1 });

    return {
      viewport: tab.viewport,
      layers,
      legend: legend.length > 1 ? legend : undefined,
      showGrid: tab.showGrid,
      showMinorGrid: tab.showMinorGrid,
      showAxes: tab.showAxes,
      xLabel: 'x',
      yLabel: isCdf ? 'F(x)' : dist.kind === 'discrete' ? 'P(X = k)' : 'density',
      caption: region.intervals.length ? `${region.description} = ${region.probability.toFixed(6)}` : undefined,
    };
  }, [tab.viewport, tab.showGrid, tab.showMinorGrid, tab.showAxes, cfg, dist, region]);

  /* Dragging a cut-off edge is the fastest way to explore a tail, so a press
   * within a few pixels of one grabs it instead of starting a pan. */
  const grabbed = useMemo(() => ({ current: null as 'lower' | 'upper' | null }), []);

  return (
    <Plot2D
      ref={plotRef}
      scene={scene}
      onViewportChange={setViewport}
      showCrosshair={tab.showCrosshair}
      onPointerDown={(e) => {
        const tolerance = (tab.viewport.xMax - tab.viewport.xMin) * 0.02;
        if (region.lower !== null && Math.abs(e.x - region.lower) < tolerance) {
          grabbed.current = 'lower';
          if (cfg.driveBy !== 'value') {
            setStatistics({ driveBy: 'value', lower: region.lower, upper: region.upper ?? region.lower });
          }
          return true;
        }
        if (region.upper !== null && Math.abs(e.x - region.upper) < tolerance) {
          grabbed.current = 'upper';
          if (cfg.driveBy !== 'value') {
            setStatistics({ driveBy: 'value', lower: region.lower ?? region.upper, upper: region.upper });
          }
          return true;
        }
        return false;
      }}
      onPointerMove={(e) => {
        if (grabbed.current === 'lower') setStatistics({ lower: e.x });
        else if (grabbed.current === 'upper') setStatistics({ upper: e.x });
      }}
      onPointerUp={() => {
        grabbed.current = null;
      }}
      readout={(x) => {
        const density = dist.pdf(x, cfg.params);
        const cum = dist.cdf(x, cfg.params);
        return `x ${fmt(x)}\n${dist.kind === 'discrete' ? 'P' : 'f'}(x) ${fmt(density)}\nF(x) ${fmt(cum)}\n1−F(x) ${fmt(1 - cum)}`;
      }}
    />
  );
}

export function statisticsCsv(tab: TabState): string | null {
  const cfg = tab.statistics;
  const dist = getDistribution(cfg.distributionId);
  const rows = ['x,pdf,cdf'];
  const n = 1000;
  for (let i = 0; i <= n; i++) {
    const x = tab.viewport.xMin + ((tab.viewport.xMax - tab.viewport.xMin) * i) / n;
    rows.push(`${x},${dist.pdf(x, cfg.params)},${dist.cdf(x, cfg.params)}`);
  }
  return rows.join('\n');
}

/** Used by the panel header to show the density formula, where one is short
 *  enough to be worth showing. */
export function DistributionFormula({ id }: { id: string }) {
  const latex: Record<string, string> = {
    normal: 'f(x)=\\frac{1}{\\sigma\\sqrt{2\\pi}}e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}',
    exponential: 'f(x)=\\lambda e^{-\\lambda x}',
    binomial: 'P(X=k)=\\binom{n}{k}p^k(1-p)^{n-k}',
    poisson: 'P(X=k)=\\frac{\\lambda^k e^{-\\lambda}}{k!}',
  };
  const tex = latex[id];
  return tex ? <Formula latex={tex} className="text-xs text-ink-dim" /> : null;
}
