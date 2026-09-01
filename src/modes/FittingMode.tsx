import { useMemo, useState } from 'react';
import { bridge } from '../core/bridge';
import { useStore } from '../core/store';
import type { FittingConfig, TabState } from '../core/types';
import {
  NONLINEAR_MODELS,
  confidenceBand,
  levenbergMarquardt,
  linearFit,
  parseDelimited,
  polynomialFit,
  type FitDiagnostics,
} from '../core/math/fitting';
import { correlation, extentOf, maxAbs, summarise } from '../core/math/stats';
import { toCsv } from '../core/serialize';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { Formula } from '../components/inputs/MathField';
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
import { IconUpload } from '../components/ui/Icons';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';

const POINTS = '#38bdf8';
const FIT = '#8b7cf6';
const BAND = '#8b7cf6';
const RESIDUAL = '#fb7185';

/* ------------------------------------------------------------------ compute */

interface FitResult {
  fit: (FitDiagnostics & { predict: (x: number) => number }) | null;
  model: (x: number, p: readonly number[]) => number;
  xs: number[];
  ys: number[];
  error: string | null;
  latex: string;
}

function useFit(cfg: FittingConfig): FitResult {
  return useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const row of cfg.rows) {
      const x = row[cfg.xColumn];
      const y = row[cfg.yColumn];
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
        xs.push(x);
        ys.push(y);
      }
    }

    if (xs.length < 3) {
      return {
        fit: null,
        model: () => NaN,
        xs,
        ys,
        error: xs.length ? 'At least three points are needed to fit anything.' : null,
        latex: '',
      };
    }

    try {
      if (cfg.model === 'linear') {
        const fit = linearFit(xs, ys);
        return {
          fit,
          model: (x: number, p: readonly number[]) => p[0] + p[1] * x,
          xs,
          ys,
          error: null,
          latex: `y = ${fmt(fit.slope, 5)}x ${fit.intercept >= 0 ? '+' : '-'} ${fmt(Math.abs(fit.intercept), 5)}`,
        };
      }
      if (cfg.model === 'polynomial') {
        const degree = Math.max(1, Math.min(Math.round(cfg.degree), 10));
        const fit = polynomialFit(xs, ys, degree);
        return {
          fit,
          // The polynomial's parameters live in a centred and scaled basis, so
          // the covariance-based confidence band has to use the same mapping.
          // The centring is computed once, outside the closure: it is a
          // property of the data, and recomputing it per evaluation made every
          // confidence-band point an O(n) operation.
          model: ((): ((x: number, p: readonly number[]) => number) => {
            const { min: xMin, max: xMax } = extentOf(xs);
            const mid = (xMin + xMax) / 2;
            const half = (xMax - xMin) / 2 || 1;
            return (x: number, p: readonly number[]) => {
              const t = (x - mid) / half;
              let acc = 0;
              for (let k = p.length - 1; k >= 0; k--) acc = acc * t + p[k];
              return acc;
            };
          })(),
          xs,
          ys,
          error: null,
          latex: `y = \\sum_{k=0}^{${degree}} c_k\\,u^k, \\quad u = \\frac{x - \\bar{x}}{\\Delta x/2}`,
        };
      }

      const spec = NONLINEAR_MODELS.find((m) => m.id === cfg.nonlinearId) ?? NONLINEAR_MODELS[0];
      const fit = levenbergMarquardt(xs, ys, spec.f, spec.initial(xs, ys), spec.paramNames);
      return { fit, model: spec.f, xs, ys, error: null, latex: spec.latex };
    } catch (err) {
      return { fit: null, model: () => NaN, xs, ys, error: String(err), latex: '' };
    }
  }, [cfg.rows, cfg.xColumn, cfg.yColumn, cfg.model, cfg.degree, cfg.nonlinearId]);
}

/* ------------------------------------------------------------------ panel */

export function FittingPanel({ tab }: { tab: TabState }) {
  const setFitting = useStore((s) => s.setFitting);
  const pushToast = useStore((s) => s.pushToast);
  const cfg = tab.fitting;
  const result = useFit(cfg);
  const [pasted, setPasted] = useState('');

  const loadTable = (text: string, name: string) => {
    const table = parseDelimited(text);
    if (!table.rows.length || table.numericColumns.length < 2) {
      pushToast({
        kind: 'warn',
        message: 'That data needs at least two fully numeric columns.',
        detail: `Found ${table.columns.length} column${table.columns.length === 1 ? '' : 's'} and ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}.`,
      });
      return;
    }
    setFitting({
      columns: table.columns,
      rows: table.rows,
      xColumn: table.numericColumns[0],
      yColumn: table.numericColumns[1],
      sourceName: name,
    });
    pushToast({ kind: 'success', message: `Loaded ${table.rows.length} rows from ${name}` });
  };

  const importFile = async () => {
    const file = await bridge().importText({ extensions: ['csv', 'tsv', 'txt'], typeName: 'Data' });
    if (file) loadTable(file.text, file.path.split(/[\\/]/).pop() ?? 'data');
  };

  const summary = useMemo(() => (result.ys.length ? summarise(result.ys) : null), [result.ys]);
  const corr = useMemo(
    () => (result.xs.length >= 4 ? correlation(result.xs, result.ys) : null),
    [result.xs, result.ys],
  );

  return (
    <>
      <Collapsible title="Data">
        <Button onClick={importFile}>
          <IconUpload size={13} /> Import a CSV file
        </Button>
        <Field label="…or paste it here" hint="Comma- or tab-separated, with or without a header row.">
          <textarea
            className="input-base h-20 resize-y font-mono text-2xs"
            value={pasted}
            placeholder={'x,y\n1,2.1\n2,3.9\n…'}
            onChange={(e) => setPasted(e.target.value)}
            onBlur={() => pasted.trim() && loadTable(pasted, 'pasted data')}
          />
        </Field>

        {cfg.columns.length > 0 && (
          <>
            <Row>
              <div className="flex-1">
                <span className="field-label">x column</span>
                <Select
                  value={String(cfg.xColumn)}
                  onChange={(v) => setFitting({ xColumn: Number(v) })}
                  options={cfg.columns.map((c, i) => ({ value: String(i), label: c }))}
                />
              </div>
              <div className="flex-1">
                <span className="field-label">y column</span>
                <Select
                  value={String(cfg.yColumn)}
                  onChange={(v) => setFitting({ yColumn: Number(v) })}
                  options={cfg.columns.map((c, i) => ({ value: String(i), label: c }))}
                />
              </div>
            </Row>
            <p className="text-2xs text-ink-faint">
              {result.xs.length} usable point{result.xs.length === 1 ? '' : 's'} from {cfg.rows.length} row
              {cfg.rows.length === 1 ? '' : 's'}
              {cfg.sourceName && ` · ${cfg.sourceName}`}
            </p>
          </>
        )}

        {summary && corr && (
          <StatList>
            <Stat label="mean y" value={fmt(summary.mean)} />
            <Stat label="sd y" value={fmt(summary.sd)} />
            <Stat label="Pearson r" value={fmt(corr.r)} emphasis />
            <Stat label="p (r = 0)" value={fmtP(corr.pValue)} />
          </StatList>
        )}
      </Collapsible>

      <Collapsible title="Model">
        <SegmentedControl
          value={cfg.model}
          onChange={(model) => setFitting({ model })}
          options={[
            { value: 'linear', label: 'Linear' },
            { value: 'polynomial', label: 'Polynomial' },
            { value: 'nonlinear', label: 'Nonlinear' },
          ]}
        />

        {cfg.model === 'polynomial' && (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="field-label">Degree</span>
              <span className="font-mono text-2xs text-ink">{Math.round(cfg.degree)}</span>
            </div>
            <Slider
              value={cfg.degree}
              min={1}
              max={10}
              step={1}
              onChange={(degree) => setFitting({ degree: Math.round(degree) })}
            />
            {cfg.degree >= 6 && (
              <Callout kind="warn">
                A degree-{Math.round(cfg.degree)} polynomial will follow the noise as happily as the signal.
                Watch the adjusted R² and the information criteria rather than R² alone.
              </Callout>
            )}
          </div>
        )}

        {cfg.model === 'nonlinear' && (
          <Field label="Family">
            <Select
              value={cfg.nonlinearId}
              onChange={(nonlinearId) => setFitting({ nonlinearId })}
              options={NONLINEAR_MODELS.map((m) => ({ value: m.id, label: m.name }))}
            />
          </Field>
        )}

        {result.latex && (
          <div className="overflow-x-auto rounded-md border border-edge bg-surface-1 px-2.5 py-2 text-center">
            <Formula latex={result.latex} display />
          </div>
        )}

        <Toggle label="Residual panel" checked={cfg.showResiduals} onChange={(showResiduals) => setFitting({ showResiduals })} />
        <Toggle
          label="Confidence band"
          hint="Delta-method interval on the fitted curve — exact for the linear model, first-order otherwise."
          checked={cfg.showBand}
          onChange={(showBand) => setFitting({ showBand })}
        />
        {cfg.showBand && (
          <Field label="Confidence level">
            <NumberField
              value={cfg.confidence}
              min={0.5}
              max={0.9999}
              step={0.01}
              onChange={(confidence) => setFitting({ confidence })}
            />
          </Field>
        )}
      </Collapsible>

      <Collapsible title="Fit">
        {result.error && <Callout kind="warn">{result.error}</Callout>}
        {result.fit && (
          <>
            <div className="space-y-1">
              {result.fit.params.map((p, i) => (
                <div key={i} className="flex items-baseline justify-between gap-2 font-mono text-xs">
                  <span className="text-ink-faint">{result.fit!.paramNames[i]}</span>
                  <span className="flex-1 text-right text-ink">{fmt(p, 8)}</span>
                  {Number.isFinite(result.fit!.standardErrors[i]) && (
                    <span className="w-24 text-right text-ink-faint">± {fmt(result.fit!.standardErrors[i], 4)}</span>
                  )}
                </div>
              ))}
            </div>

            <StatList>
              <Stat label="R²" value={fmt(result.fit.r2, 6)} emphasis />
              <Stat label="Adjusted R²" value={fmt(result.fit.adjustedR2, 6)} />
              <Stat label="RMSE" value={fmt(result.fit.rmse)} />
              <Stat label="SSE" value={fmt(result.fit.sse)} />
              <Stat label="AIC" value={fmt(result.fit.aic, 6)} hint="Lower is better; comparable across models on the same data" />
              <Stat label="BIC" value={fmt(result.fit.bic, 6)} />
              <Stat label="Degrees of freedom" value={String(result.fit.dof)} />
              {result.fit.iterations !== undefined && <Stat label="Iterations" value={String(result.fit.iterations)} />}
            </StatList>

            {!result.fit.converged && cfg.model === 'nonlinear' && (
              <Callout kind="warn">
                Levenberg–Marquardt stopped without converging. Nonlinear fits depend on the starting guess —
                try a different family, or trim outliers that are dragging the search.
              </Callout>
            )}

            <Callout>
              R² measures how much of the variance the model accounts for, not whether the model is right.
              Look at the residual panel: a good fit leaves residuals scattered without pattern.
            </Callout>
          </>
        )}
      </Collapsible>
    </>
  );
}

/* ------------------------------------------------------------------ surface */

export function FittingSurface({ tab }: { tab: TabState }) {
  const plotRef = usePlot2DRef();
  const cfg = tab.fitting;
  const result = useFit(cfg);

  const bounds = useMemo(() => {
    if (!result.xs.length) return { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
    const { min: xMin, max: xMax } = extentOf(result.xs);
    const { min: yMin, max: yMax } = extentOf(result.ys);
    const padX = (xMax - xMin) * 0.08 + 1e-9;
    const padY = (yMax - yMin) * 0.12 + 1e-9;
    return { xMin: xMin - padX, xMax: xMax + padX, yMin: yMin - padY, yMax: yMax + padY };
  }, [result.xs, result.ys]);

  const scene = useMemo<PlotScene>(() => {
    const layers: Layer[] = [];

    if (result.fit) {
      const n = 300;
      const gridX = Array.from({ length: n }, (_, i) => bounds.xMin + ((bounds.xMax - bounds.xMin) * i) / (n - 1));

      if (cfg.showBand) {
        const band = confidenceBand(result.fit, result.model, gridX, cfg.confidence);
        if (band) {
          layers.push({
            type: 'band',
            xs: band.map((b) => b.x),
            lower: band.map((b) => b.lower),
            upper: band.map((b) => b.upper),
            colour: withAlpha(BAND, 0.16),
          });
        }
      }

      layers.push({
        type: 'polyline',
        xs: gridX,
        ys: gridX.map((x) => result.model(x, result.fit!.params)),
        colour: FIT,
        width: 2.4,
      });
    }

    layers.push({
      type: 'points',
      xs: result.xs,
      ys: result.ys,
      colour: POINTS,
      radius: cfg.pointSize,
      shape: 'circle',
      alpha: 0.9,
    });

    return {
      viewport: bounds,
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: false,
      showAxes: false,
      xLabel: cfg.columns[cfg.xColumn] ?? 'x',
      yLabel: cfg.columns[cfg.yColumn] ?? 'y',
      legend: result.fit
        ? [
            { label: `data (n = ${result.xs.length})`, colour: POINTS },
            { label: `fit · R² = ${fmt(result.fit.r2, 5)}`, colour: FIT },
          ]
        : undefined,
      caption: result.xs.length ? undefined : 'Import or paste some data to begin',
    };
  }, [result, bounds, cfg, tab.showGrid]);

  const residualScene = useMemo<PlotScene | null>(() => {
    if (!cfg.showResiduals || !result.fit) return null;
    const residuals = result.fit.residuals;
    const spread = Math.max(maxAbs(residuals), 1e-9) * 1.25;
    const sd = Math.sqrt(result.fit.sse / result.fit.dof);
    return {
      viewport: { xMin: bounds.xMin, xMax: bounds.xMax, yMin: -spread, yMax: spread },
      layers: [
        { type: 'hline', y: 0, colour: 'rgba(148,163,184,0.5)', style: 'solid', width: 1 },
        { type: 'hline', y: 2 * sd, colour: 'rgba(251,113,133,0.35)', style: 'dashed', width: 1, label: '+2σ' },
        { type: 'hline', y: -2 * sd, colour: 'rgba(251,113,133,0.35)', style: 'dashed', width: 1, label: '−2σ' },
        {
          type: 'segments',
          data: Float64Array.from(result.xs.flatMap((x, i) => [x, 0, x, residuals[i]])),
          colour: withAlpha(RESIDUAL, 0.4),
          width: 1,
        },
        { type: 'points', xs: result.xs, ys: Array.from(residuals), colour: RESIDUAL, radius: 2.6 },
      ],
      showGrid: true,
      showMinorGrid: false,
      showAxes: false,
      xLabel: cfg.columns[cfg.xColumn] ?? 'x',
      yLabel: 'residual',
      caption: 'Structure here means the model is missing something',
    };
  }, [cfg.showResiduals, cfg.columns, cfg.xColumn, result, bounds]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-[3]">
        {/* Static for the same reason as the Monte Carlo chart: the viewport is
            derived from the data, so a pan would dirty the document without
            moving anything. */}
        <Plot2D
          ref={plotRef}
          scene={scene}
          staticView
          showCrosshair={tab.showCrosshair}
          readout={(x, y) =>
            result.fit ? `x ${fmt(x, 5)}   y ${fmt(y, 5)}\nfit ${fmt(result.model(x, result.fit.params), 5)}` : null
          }
        />
      </div>
      {residualScene && (
        <div className="min-h-0 flex-1 border-t border-edge">
          <Plot2D scene={residualScene} staticView showCrosshair={false} />
        </div>
      )}
    </div>
  );
}

export function fittingCsv(tab: TabState): string | null {
  const cfg = tab.fitting;
  if (!cfg.rows.length) return null;
  // Export the data with the fitted values and residuals alongside, which is
  // what anyone exporting a regression actually wants.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const row of cfg.rows) {
    const x = row[cfg.xColumn];
    const y = row[cfg.yColumn];
    if (typeof x === 'number' && typeof y === 'number') {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 3) return toCsv(cfg.columns, cfg.rows);

  let predict: (x: number) => number;
  if (cfg.model === 'linear') predict = linearFit(xs, ys).predict;
  else if (cfg.model === 'polynomial') predict = polynomialFit(xs, ys, Math.round(cfg.degree)).predict;
  else {
    const spec = NONLINEAR_MODELS.find((m) => m.id === cfg.nonlinearId) ?? NONLINEAR_MODELS[0];
    predict = levenbergMarquardt(xs, ys, spec.f, spec.initial(xs, ys), spec.paramNames).predict;
  }

  const headers = [cfg.columns[cfg.xColumn] ?? 'x', cfg.columns[cfg.yColumn] ?? 'y', 'fitted', 'residual'];
  const rows = xs.map((x, i) => [x, ys[i], predict(x), ys[i] - predict(x)]);
  return toCsv(headers, rows);
}
