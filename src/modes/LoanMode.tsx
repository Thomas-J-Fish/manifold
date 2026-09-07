import { useEffect, useMemo } from 'react';
import { useStore } from '../core/store';
import { uid } from '../core/defaults';
import type { TabState } from '../core/types';
import { SERIES_COLOURS } from '../core/types';
import {
  amortise,
  compare,
  effectivePayment,
  formatTerm,
  monthlyRate,
  rateChangeMonths,
  type LoanSchedule,
  type RatePeriod,
} from '../core/finance/loan';
import { Plot2D } from '../components/plot/Plot2D';
import { usePlot2DRef } from '../components/shell/PlotContext';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { AnalyticCard } from '../components/sandbox/AnalyticCard';
import type { AnalyticResult } from '../core/physics/analytic';
import {
  Button,
  Callout,
  Field,
  IconButton,
  NumberField,
  Panel,
  Row,
  SegmentedControl,
  Slider,
  Stat,
  StatList,
  Toggle,
  fmt,
} from '../components/ui/controls';
import { IconPlus, IconTrash } from '../components/ui/Icons';
import type { Layer, PlotScene } from '../plot/scene';
import { withAlpha } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* A debt, month by month.
 *
 * Three quantities, and they belong on two different axes — which is the whole
 * reason this is a mode rather than three expressions in the graphing tab. The
 * balance and the cumulative interest are *totals*, hundreds of thousands of
 * pounds; the monthly interest is a *rate of payment*, a couple of thousand a
 * month. Drawn together on one axis the monthly figure is a flat line along the
 * bottom, so the views separate them:
 *
 *   Balance — what is still owed, falling to zero, with the cumulative interest
 *     beside it since both are totals in pounds.
 *   Monthly — what leaves the account each month, split into interest and
 *     capital. This is the view where a rate change is a cliff.
 *   Cumulative — what has been paid to date, in total and split.
 *   Schedule — the numbers themselves, for the months worth reading.
 *
 * The x axis is months ahead of now throughout, so month 0 is today's balance.
 */

const VIEWS = [
  { value: 'balance' as const, label: 'Balance', title: 'What is still owed, and what the interest has cost so far.' },
  { value: 'monthly' as const, label: 'Monthly', title: 'What leaves the account each month.' },
  { value: 'cumulative' as const, label: 'Cumulative', title: 'Everything paid to date.' },
  { value: 'schedule' as const, label: 'Schedule', title: 'The month-by-month numbers.' },
];

const BALANCE = SERIES_COLOURS[0];
const INTEREST = '#fb7185';
const CAPITAL = '#34d399';
const TOTAL = '#fbbf24';
const COMPARE = '#94a3b8';

/** £1,234,567 → "£1.23M", which is what fits on an axis. */
function money(value: number, currency: string): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${currency}${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${currency}${Math.round(value / 1000)}k`;
  return `${currency}${Math.round(value).toLocaleString()}`;
}

/** The full figure, for a readout where precision matters. */
const exact = (value: number, currency: string): string =>
  `${currency}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ------------------------------------------------------------------- scenes

interface Series {
  xs: Float64Array;
  ys: Float64Array;
}

/** A series over months, starting at month 0 so today is on the chart. */
function seriesFrom(schedule: LoanSchedule, pick: (row: LoanSchedule['rows'][number]) => number, atZero: number): Series {
  const n = schedule.rows.length;
  const xs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  xs[0] = 0;
  ys[0] = atZero;
  for (let i = 0; i < n; i++) {
    xs[i + 1] = schedule.rows[i].month;
    ys[i + 1] = pick(schedule.rows[i]);
  }
  return { xs, ys };
}

const line = (s: Series, colour: string, width = 2.2, style?: 'dashed' | 'dotted'): Layer => ({
  type: 'polyline',
  xs: s.xs,
  ys: s.ys,
  colour,
  width,
  ...(style ? { style } : {}),
});

function buildScene(tab: TabState, schedule: LoanSchedule, variant: LoanSchedule | null): PlotScene {
  const cfg = tab.loan;
  const layers: Layer[] = [];
  const legend: { label: string; colour: string; dashed?: boolean }[] = [];
  const paid = cfg.world.interestHandling === 'paid';

  if (cfg.view === 'balance') {
    layers.push(line(seriesFrom(schedule, (r) => r.closingBalance, cfg.world.principal), BALANCE, 2.6));
    legend.push({ label: 'remaining capital', colour: BALANCE });
    layers.push(line(seriesFrom(schedule, (r) => r.cumulativeInterest, 0), INTEREST));
    legend.push({ label: 'interest paid so far', colour: INTEREST });
    if (variant) {
      layers.push(line(seriesFrom(variant, (r) => r.closingBalance, cfg.world.principal), COMPARE, 1.6, 'dashed'));
      legend.push({ label: `at ${money(cfg.comparePayment, cfg.currency)}/mo`, colour: COMPARE, dashed: true });
    }
  } else if (cfg.view === 'monthly') {
    /* Interest and capital at their own scale, where the rate change is a step
     * you can see rather than a kink in a line near the axis. */
    layers.push(line(seriesFrom(schedule, (r) => r.interest, schedule.rows[0]?.interest ?? 0), INTEREST, 2.4));
    legend.push({ label: 'interest this month', colour: INTEREST });
    layers.push(line(seriesFrom(schedule, (r) => r.capital, schedule.rows[0]?.capital ?? 0), CAPITAL, 2));
    legend.push({ label: 'capital repaid', colour: CAPITAL });
    if (paid) {
      layers.push(line(seriesFrom(schedule, (r) => r.payment, schedule.rows[0]?.payment ?? 0), TOTAL, 2, 'dashed'));
      legend.push({ label: 'total leaving the account', colour: TOTAL, dashed: true });
    }
  } else if (cfg.view === 'cumulative') {
    layers.push(line(seriesFrom(schedule, (r) => r.cumulativeInterest, 0), INTEREST, 2.4));
    legend.push({ label: 'interest to date', colour: INTEREST });
    layers.push(line(seriesFrom(schedule, (r) => r.cumulativeCapital, 0), CAPITAL, 2));
    legend.push({ label: 'capital repaid to date', colour: CAPITAL });
    if (paid) {
      layers.push(line(seriesFrom(schedule, (r) => r.cumulativePaid, 0), TOTAL, 2, 'dashed'));
      legend.push({ label: 'everything paid', colour: TOTAL, dashed: true });
    }
  }

  // Where the rate changes, which is usually the most interesting month.
  if (cfg.showRateChanges) {
    for (const change of rateChangeMonths(cfg.world.periods)) {
      if (change.month <= 0 || change.month > (schedule.rows.length || 0)) continue;
      layers.push({
        type: 'vline',
        x: change.month,
        colour: withAlpha('#94a3b8', 0.75),
        style: 'dashed',
        width: 1.2,
        label: `${fmt(change.from, 4)}% → ${fmt(change.to, 4)}%`,
      });
    }
  }

  if (cfg.showPayoff && schedule.payoffMonth) {
    layers.push({
      type: 'vline',
      x: schedule.payoffMonth,
      colour: withAlpha(CAPITAL, 0.8),
      style: 'dotted',
      width: 1.4,
      label: `clear at month ${schedule.payoffMonth}`,
    });
  }

  return {
    viewport: tab.viewport,
    layers,
    showGrid: tab.showGrid,
    showMinorGrid: tab.showMinorGrid,
    showAxes: tab.showAxes,
    xLabel: 'months from now',
    yLabel: cfg.view === 'monthly' ? `per month (${cfg.currency})` : `total (${cfg.currency})`,
    formatY: (v) => money(v, cfg.currency),
    legend,
    caption: schedule.message,
  };
}

// -------------------------------------------------------------------- panel

export function LoanPanel({ tab }: { tab: TabState }) {
  const cfg = tab.loan;
  const setLoan = useStore((s) => s.setLoan);
  const commit = useStore((s) => s.commit);

  const setWorld = (patch: Partial<typeof cfg.world>) => setLoan({ world: { ...cfg.world, ...patch } });
  const patchPeriod = (id: string, patch: Partial<RatePeriod>) =>
    setWorld({ periods: cfg.world.periods.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

  const last = cfg.world.periods.length - 1;
  /* What the term implies, computed here so the switch above can carry it
   * across and the callout can state it. Cheap: a couple of hundred iterations
   * of a loop over a few hundred months. */
  const solved = effectivePayment({ ...cfg.world, driver: 'term' });
  const firstInterest = amortise(cfg.world).rows[0]?.interest ?? null;

  return (
    <>
      <Panel title="View">
        <SegmentedControl size="sm" value={cfg.view} onChange={(view) => setLoan({ view })} options={VIEWS} />
      </Panel>

      <Panel title="The loan">
        <Field label={`Owed now — ${exact(cfg.world.principal, cfg.currency)}`}>
          <Slider
            value={cfg.world.principal}
            min={0}
            max={2_000_000}
            step={1_000}
            onChange={(principal) => setWorld({ principal })}
          />
        </Field>
        <NumberField
          value={cfg.world.principal}
          min={0}
          step={5_000}
          onChange={(principal) => {
            commit();
            setWorld({ principal });
          }}
        />

        {/* The payment and the term are the same fact seen from two sides, so
            one of them is always the input and the other is always the answer.
            Showing both as editable would beg the question of which wins. */}
        <Field label="Which do you want to fix?">
          <SegmentedControl
            size="sm"
            value={cfg.world.driver}
            onChange={(driver) => {
              commit();
              /* Carry the current answer over as the new input, so switching
                 does not move the loan. Fixing the term after setting a payment
                 should start from the term that payment produced. */
              if (driver === 'term') {
                const months = amortise(cfg.world).payoffMonth;
                setWorld({ driver, targetMonths: months && months > 0 ? months : cfg.world.targetMonths });
              } else {
                setWorld({ driver, capitalPayment: solved });
              }
            }}
            options={[
              { value: 'payment', label: 'The payment' },
              { value: 'term', label: 'The term' },
            ]}
          />
        </Field>

        {cfg.world.driver === 'payment' ? (
          <>
            <Field
              label={`Capital repaid each month — ${exact(cfg.world.capitalPayment, cfg.currency)}`}
              hint="What comes off the debt itself, before any interest."
            >
              <Slider
                value={cfg.world.capitalPayment}
                min={0}
                max={10_000}
                step={50}
                onChange={(capitalPayment) => setWorld({ capitalPayment })}
              />
            </Field>
            <NumberField
              value={cfg.world.capitalPayment}
              min={0}
              step={100}
              onChange={(capitalPayment) => {
                commit();
                setWorld({ capitalPayment });
              }}
            />
          </>
        ) : (
          <>
            <Field label={`Clear it in ${formatTerm(cfg.world.targetMonths)}`}>
              <Slider
                value={cfg.world.targetMonths}
                min={1}
                max={480}
                step={1}
                onChange={(targetMonths) => setWorld({ targetMonths })}
              />
            </Field>
            {/* Years and months separately, because that is how a term is
                said out loud — nobody asks for a hundred and seventy-eight
                months. Either box drives the same underlying number. */}
            <Row>
              <div className="flex-1" data-testid="loan-years">
                <Field label="Years">
                  <NumberField
                    value={Math.floor(cfg.world.targetMonths / 12)}
                    min={0}
                    max={40}
                    step={1}
                    onChange={(years) => {
                      commit();
                      setWorld({
                        targetMonths: Math.max(1, Math.round(years) * 12 + (cfg.world.targetMonths % 12)),
                      });
                    }}
                  />
                </Field>
              </div>
              <div className="flex-1" data-testid="loan-months">
                <Field label="Months">
                  <NumberField
                    value={cfg.world.targetMonths % 12}
                    min={0}
                    max={11}
                    step={1}
                    onChange={(months) => {
                      commit();
                      setWorld({
                        targetMonths: Math.max(
                          1,
                          Math.floor(cfg.world.targetMonths / 12) * 12 + Math.round(months),
                        ),
                      });
                    }}
                  />
                </Field>
              </div>
            </Row>
            <Callout kind="info">
              That needs <strong>{exact(solved, cfg.currency)}</strong> of capital a month
              {cfg.world.interestHandling === 'paid' && firstInterest !== null
                ? `, plus ${exact(firstInterest, cfg.currency)} of interest next month.`
                : '.'}
            </Callout>
          </>
        )}
      </Panel>

      <Panel title="Interest rate">
        <div className="space-y-2">
          {cfg.world.periods.map((p, i) => (
            <div key={p.id} className="space-y-1.5 rounded-md border border-edge bg-surface-1 p-2">
              <Row>
                <div className="flex-1 text-2xs text-ink-faint">
                  {i === last ? 'Then, for the rest of the term' : `First ${p.months} month${p.months === 1 ? '' : 's'}`}
                </div>
                {cfg.world.periods.length > 1 && (
                  <IconButton
                    title="Remove this rate"
                    onClick={() => {
                      commit();
                      setWorld({ periods: cfg.world.periods.filter((x) => x.id !== p.id) });
                    }}
                  >
                    <IconTrash />
                  </IconButton>
                )}
              </Row>
              <Field label={`${fmt(p.annualRate, 4)}% a year — ${fmt(monthlyRate(p.annualRate, cfg.world.conversion) * 100, 4)}% a month`}>
                <Slider
                  value={p.annualRate}
                  min={0}
                  max={15}
                  step={0.01}
                  onChange={(annualRate) => patchPeriod(p.id, { annualRate })}
                />
              </Field>
              {/* A typed box as well as the slider. Fifteen percentage points
                  across a few hundred pixels puts about 0.05% under each one,
                  so landing on 1.09 exactly by dragging is a matter of luck —
                  and the difference between 1.09% and 1.10% on half a million
                  pounds is real money. */}
              <Row>
                <div className="flex-1" data-testid="loan-rate">
                  <NumberField
                    value={p.annualRate}
                    min={0}
                    max={100}
                    step={0.01}
                    suffix="%"
                    onChange={(annualRate) => {
                      commit();
                      patchPeriod(p.id, { annualRate });
                    }}
                  />
                </div>
              </Row>
              {i !== last && (
                <>
                  <Field label={`Lasts ${p.months} month${p.months === 1 ? '' : 's'}`}>
                    <Slider
                      value={p.months}
                      min={1}
                      max={120}
                      step={1}
                      onChange={(months) => patchPeriod(p.id, { months })}
                    />
                  </Field>
                  <NumberField
                    value={p.months}
                    min={1}
                    max={1200}
                    step={1}
                    onChange={(months) => {
                      commit();
                      patchPeriod(p.id, { months });
                    }}
                  />
                </>
              )}
            </div>
          ))}
        </div>
        <Button
          onClick={() => {
            commit();
            /* Inserted before the open-ended final period, since that one has
             * to stay last — it is the rate everything after the table runs on. */
            const periods = [...cfg.world.periods];
            periods.splice(Math.max(0, periods.length - 1), 0, {
              id: uid('rate'),
              months: 12,
              annualRate: periods[Math.max(0, periods.length - 1)]?.annualRate ?? 4,
              label: '',
            });
            setWorld({ periods });
          }}
        >
          <IconPlus /> Add a rate period
        </Button>
      </Panel>

      <Panel title="Conventions">
        <Field
          label="A quoted annual rate means"
          hint="Lenders almost always divide by twelve. An AER is the twelfth root, and costs slightly less."
        >
          <SegmentedControl
            size="sm"
            value={cfg.world.conversion}
            onChange={(conversion) => {
              commit();
              setWorld({ conversion });
            }}
            options={[
              { value: 'nominal', label: 'rate ÷ 12' },
              { value: 'effective', label: 'AER' },
            ]}
          />
        </Field>
        <Field
          label="Interest is"
          hint="Paid means it never joins the debt, so the balance falls by exactly the capital payment. Added means it compounds."
        >
          <SegmentedControl
            size="sm"
            value={cfg.world.interestHandling}
            onChange={(interestHandling) => {
              commit();
              setWorld({ interestHandling });
            }}
            options={[
              { value: 'paid', label: 'paid monthly' },
              { value: 'capitalised', label: 'added to the debt' },
            ]}
          />
        </Field>
      </Panel>

      <Panel title="What if">
        <Toggle
          label="Compare another payment"
          hint="Draws the same loan at a different monthly capital payment, and prices the difference."
          checked={cfg.compareEnabled}
          onChange={(compareEnabled) => setLoan({ compareEnabled })}
        />
        {cfg.compareEnabled && (
          <Field label={`Compare at ${exact(cfg.comparePayment, cfg.currency)} a month`}>
            <Slider
              value={cfg.comparePayment}
              min={0}
              max={10_000}
              step={50}
              onChange={(comparePayment) => setLoan({ comparePayment })}
            />
          </Field>
        )}
        <Field label={`One-off overpayment — ${exact(cfg.world.overpayment, cfg.currency)}`}>
          <Slider
            value={cfg.world.overpayment}
            min={0}
            max={200_000}
            step={1_000}
            onChange={(overpayment) => setWorld({ overpayment })}
          />
        </Field>
        <Field
          label={cfg.world.overpaymentMonth > 0 ? `Paid in month ${cfg.world.overpaymentMonth}` : 'Switched off'}
          hint="Month zero switches it off."
        >
          <Slider
            value={cfg.world.overpaymentMonth}
            min={0}
            max={120}
            step={1}
            onChange={(overpaymentMonth) => setWorld({ overpaymentMonth })}
          />
        </Field>
      </Panel>

      <Panel title="Marks">
        <Toggle label="Rate changes" checked={cfg.showRateChanges} onChange={(showRateChanges) => setLoan({ showRateChanges })} />
        <Toggle label="Payoff month" checked={cfg.showPayoff} onChange={(showPayoff) => setLoan({ showPayoff })} />
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ surface

export function LoanSurface({ tab }: { tab: TabState }) {
  const cfg = tab.loan;
  const setViewport = useStore((s) => s.setViewport);
  const fitViewport = useStore((s) => s.fitViewport);
  const plotRef = usePlot2DRef();

  const schedule = useMemo(() => amortise(cfg.world), [cfg.world]);
  const variant = useMemo(
    () => (cfg.compareEnabled ? amortise({ ...cfg.world, capitalPayment: cfg.comparePayment }) : null),
    [cfg.world, cfg.compareEnabled, cfg.comparePayment],
  );
  const scene = useMemo(() => buildScene(tab, schedule, variant), [tab, schedule, variant]);

  /* Reframed whenever the shape of the answer changes. The three views live on
   * wildly different vertical scales — half a million against a few thousand —
   * so keeping one frame across a view switch would show either a flat line on
   * the floor or a curve off the top. */
  const months = Math.max(schedule.rows.length, variant?.rows.length ?? 0, 12);
  const top = useMemo(() => {
    if (cfg.view === 'monthly') {
      let peak = 0;
      for (const r of schedule.rows) peak = Math.max(peak, r.payment, r.interest, r.capital);
      return peak;
    }
    if (cfg.view === 'cumulative') {
      const last = schedule.rows[schedule.rows.length - 1];
      return Math.max(last?.cumulativePaid ?? 0, last?.cumulativeInterest ?? 0, last?.cumulativeCapital ?? 0);
    }
    return Math.max(cfg.world.principal, schedule.totalInterest, ...schedule.rows.map((r) => r.closingBalance));
  }, [cfg.view, cfg.world.principal, schedule]);

  const frameKey = `${cfg.view}|${months}|${Math.round(top)}`;
  useEffect(() => {
    if (cfg.view === 'schedule') return;
    fitViewport({ xMin: 0, xMax: months * 1.02, yMin: -top * 0.04, yMax: top * 1.12 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);

  return (
    <SandboxLayout
      storageKey="loan"
      canvas={
        cfg.view === 'schedule' ? (
          <ScheduleTable tab={tab} schedule={schedule} />
        ) : (
          <div className="h-full w-full">
            <Plot2D
              ref={plotRef}
              scene={scene}
              onViewportChange={setViewport}
              readout={(x, y) =>
                `month ${Math.max(0, Math.round(x))}\n${money(y, cfg.currency)}`
              }
            />
          </div>
        )
      }
      instruments={
        <>
          <LoanReadout tab={tab} schedule={schedule} variant={variant} />
          <AnalyticCard result={analyseLoan(tab)} />
        </>
      }
    />
  );
}

function ScheduleTable({ tab, schedule }: { tab: TabState; schedule: LoanSchedule }) {
  const cfg = tab.loan;
  /* Every month of a seventeen-year loan is two hundred rows nobody reads. The
   * ones that matter are the start, the months around each rate change, and
   * the end — so those are shown and the rest is thinned to one a year. */
  const marks = new Set<number>([1, 2, 3, schedule.rows.length]);
  for (const change of rateChangeMonths(cfg.world.periods)) {
    for (const m of [change.month - 1, change.month, change.month + 1, change.month + 2]) {
      if (m >= 1) marks.add(m);
    }
  }
  const rows = schedule.rows.filter((r) => marks.has(r.month) || r.month % 12 === 0);

  return (
    <div className="h-full w-full overflow-auto p-3">
      <table className="w-full min-w-[42rem] border-collapse font-mono text-2xs">
        <thead className="sticky top-0 bg-surface-1 text-ink-dim">
          <tr>
            {['Month', 'Opening', 'Rate', 'Interest', 'Capital', 'Closing', 'Interest to date'].map((h) => (
              <th key={h} className="border-b border-edge px-2 py-1.5 text-right first:text-left">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="odd:bg-surface-1/40">
              <td className="px-2 py-1 text-left text-ink">{r.month}</td>
              <td className="px-2 py-1 text-right text-ink-dim">{exact(r.openingBalance, cfg.currency)}</td>
              <td className="px-2 py-1 text-right text-ink-faint">{fmt(r.annualRate, 4)}%</td>
              <td className="px-2 py-1 text-right" style={{ color: INTEREST }}>
                {exact(r.interest, cfg.currency)}
              </td>
              <td className="px-2 py-1 text-right" style={{ color: CAPITAL }}>
                {exact(r.capital, cfg.currency)}
              </td>
              <td className="px-2 py-1 text-right text-ink">{exact(r.closingBalance, cfg.currency)}</td>
              <td className="px-2 py-1 text-right text-ink-dim">{exact(r.cumulativeInterest, cfg.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pt-2 text-2xs text-ink-faint">
        Showing the first months, each rate change, every twelfth month and the last — {schedule.rows.length} in all.
        Export the full schedule with File → Export CSV.
      </div>
    </div>
  );
}

function LoanReadout({
  tab,
  schedule,
  variant,
}: {
  tab: TabState;
  schedule: LoanSchedule;
  variant: LoanSchedule | null;
}) {
  const cfg = tab.loan;
  const first = schedule.rows[0];
  const changes = rateChangeMonths(cfg.world.periods);
  const afterChange = changes.length ? schedule.rows[changes[0].month] : null;
  const comparison = variant ? compare(schedule, variant) : null;

  return (
    <>
      <div className="border-b border-edge px-3 py-2.5">
        <StatList>
          <Stat
            label="Clear in"
            value={schedule.payoffMonth ? `${schedule.payoffMonth} months` : 'never'}
            emphasis
          />
          {schedule.payoffMonth ? <Stat label="That is" value={formatTerm(schedule.payoffMonth)} /> : null}
          <Stat label="Total interest" value={exact(schedule.totalInterest, cfg.currency)} emphasis />
          <Stat label="Total paid" value={exact(schedule.totalPaid, cfg.currency)} />
          {/* The number that makes the cost land: interest as a share of what
              was borrowed. */}
          {cfg.world.principal > 0 && (
            <Stat
              label="Interest per £ borrowed"
              value={`${cfg.currency}${(schedule.totalInterest / cfg.world.principal).toFixed(3)}`}
            />
          )}
        </StatList>
        {(schedule.neverRepays || schedule.truncated) && (
          <div className="pt-2">
            <Callout kind="warn">{schedule.message}</Callout>
          </div>
        )}
      </div>

      <div className="border-b border-edge px-3 py-2.5">
        <div className="pb-1.5 text-xs font-medium text-ink">Next month</div>
        <StatList>
          <Stat label="Interest" value={first ? exact(first.interest, cfg.currency) : '—'} emphasis />
          <Stat label="Capital" value={first ? exact(first.capital, cfg.currency) : '—'} />
          {cfg.world.interestHandling === 'paid' && (
            <Stat label="Total out" value={first ? exact(first.payment, cfg.currency) : '—'} emphasis />
          )}
          <Stat label="Rate" value={first ? `${fmt(first.annualRate, 4)}%` : '—'} />
        </StatList>
      </div>

      {afterChange && changes.length > 0 && (
        <div className="border-b border-edge px-3 py-2.5">
          <div className="pb-1.5 text-xs font-medium text-ink">
            When the rate changes, in month {changes[0].month + 1}
          </div>
          <StatList>
            <Stat label="Interest jumps to" value={exact(afterChange.interest, cfg.currency)} emphasis />
            {first && (
              <Stat
                label="An increase of"
                value={exact(afterChange.interest - first.interest, cfg.currency)}
              />
            )}
            {cfg.world.interestHandling === 'paid' && (
              <Stat label="Monthly outgoing" value={exact(afterChange.payment, cfg.currency)} />
            )}
          </StatList>
        </div>
      )}

      {comparison && (
        <div className="border-b border-edge px-3 py-2.5">
          <div className="pb-1.5 text-xs font-medium text-ink">
            At {exact(cfg.comparePayment, cfg.currency)} a month
          </div>
          <StatList>
            <Stat
              label="Clear in"
              value={comparison.payoffMonth ? `${comparison.payoffMonth} months` : 'never'}
              emphasis
            />
            {comparison.monthsSaved !== null && (
              <Stat
                label={comparison.monthsSaved >= 0 ? 'Months saved' : 'Months added'}
                value={formatTerm(Math.abs(comparison.monthsSaved))}
              />
            )}
            <Stat
              label={comparison.interestSaved >= 0 ? 'Interest saved' : 'Extra interest'}
              value={exact(Math.abs(comparison.interestSaved), cfg.currency)}
              emphasis
            />
          </StatList>
        </div>
      )}
    </>
  );
}

function analyseLoan(tab: TabState): AnalyticResult {
  const cfg = tab.loan;
  const paid = cfg.world.interestHandling === 'paid';
  return {
    title: paid ? 'Interest paid as you go' : 'Interest added to the debt',
    equations: paid
      ? [
          String.raw`I_n = B_{n-1}\, i_n, \qquad B_n = B_{n-1} - P`,
          String.raw`B_n = B_0 - nP, \qquad N = \left\lceil B_0 / P \right\rceil`,
          String.raw`\textstyle\sum I = i\left(N B_0 - P\tfrac{N(N-1)}{2}\right) \quad \text{(one rate)}`,
        ]
      : [
          String.raw`B_n = B_{n-1}(1 + i_n) - P`,
          String.raw`B_n = \left(B_0 - \tfrac{P}{i}\right)(1+i)^n + \tfrac{P}{i} \quad \text{(one rate)}`,
          String.raw`N = \frac{\ln\!\big(P / (P - B_0 i)\big)}{\ln(1+i)}`,
        ],
    quantities: [],
    overlay: null,
    caveat: paid
      ? 'Because the interest is paid rather than added, the balance falls by exactly the capital payment — so the rate changes what the loan costs but not how long it takes. The closed form above holds only while the rate is constant; the chart is the month-by-month schedule, which stays right when it is not.'
      : 'The annuity formula above assumes one rate for the whole term. The chart does not use it — it marches the schedule month by month, which is why a rate change partway through comes out right instead of silently wrong.',
  };
}

export function loanCsv(tab: TabState): string | null {
  const schedule = amortise(tab.loan.world);
  if (!schedule.rows.length) return null;
  return toCsv(
    [
      'month',
      'opening_balance',
      'annual_rate_percent',
      'monthly_rate',
      'interest',
      'capital',
      'payment',
      'closing_balance',
      'cumulative_interest',
      'cumulative_capital',
      'cumulative_paid',
    ],
    schedule.rows.map((r) => [
      r.month,
      r.openingBalance,
      r.annualRate,
      r.monthlyRate,
      r.interest,
      r.capital,
      r.payment,
      r.closingBalance,
      r.cumulativeInterest,
      r.cumulativeCapital,
      r.cumulativePaid,
    ]),
  );
}
