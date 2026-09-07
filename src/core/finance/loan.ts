/* Loan amortisation, month by month.
 *
 * The whole file is one loop: take the opening balance, charge interest on it,
 * apply the payment, write down the closing balance, repeat. Nothing here is a
 * formula for the answer — the schedule *is* the answer, and the totals are
 * sums over it.
 *
 * That matters because the closed forms people quote only hold in the easy
 * cases. The standard annuity formula assumes one rate for the whole term and
 * interest rolling into the balance; the moment a rate changes partway through,
 * or the interest is paid separately rather than capitalised, it is the wrong
 * formula and gives a confidently wrong number. Marching the schedule is exact
 * in every case, costs microseconds for a few hundred months, and is the only
 * version that survives a rate change halfway down a slider.
 *
 * Two conventions run through the file, both of which change the answer and
 * neither of which has a universally right choice — so both are settings, and
 * the mode says which is in force:
 *
 *   How an annual rate becomes a monthly one. A lender quoting "4%" almost
 *     always charges 4/12 % a month (nominal); a rate quoted as an AER means
 *     (1.04)^(1/12) − 1 (effective), which is slightly less. Over a long
 *     mortgage the gap is thousands of pounds.
 *   Whether interest is paid or capitalised. If it is paid each month, it never
 *     joins the debt and the balance falls by exactly the capital payment. If it
 *     is added to the balance, the debt compounds and a payment smaller than the
 *     monthly interest never clears it at all.
 */

/** One stretch of the term at a single rate. */
export interface RatePeriod {
  id: string;
  /** How many months this rate lasts. Ignored on the final period, which runs
   * to the end of the loan however long that turns out to be. */
  months: number;
  /** Quoted annual rate, as a percentage: 4 means 4%. */
  annualRate: number;
  label: string;
}

export type RateConversion = 'nominal' | 'effective';
export type InterestHandling = 'paid' | 'capitalised';

/**
 * Which of the payment and the term is the input.
 *
 * They are two ways of asking one question. Fix the payment and the term
 * follows; fix the term and the payment follows. Borrowers arrive with either
 * — "what does £2,500 a month get me?" and "I want this gone in fifteen years,
 * what does that cost?" are the same arithmetic run in opposite directions.
 */
export type LoanDriver = 'payment' | 'term';

export interface LoanWorld {
  /** What is owed right now, at month zero. */
  principal: number;
  driver: LoanDriver;
  /** Capital repaid every month. Used when the driver is the payment. */
  capitalPayment: number;
  /** The term to hit, in months. Used when the driver is the term. */
  targetMonths: number;
  periods: RatePeriod[];
  conversion: RateConversion;
  interestHandling: InterestHandling;
  /** A one-off extra capital payment, to see what it saves. */
  overpayment: number;
  /** The month it lands in. Zero switches it off. */
  overpaymentMonth: number;
  /** How far to run before giving up on a loan that is not shrinking. */
  maxMonths: number;
}

export interface LoanMonth {
  /** Months ahead of now. The first row is month 1. */
  month: number;
  openingBalance: number;
  annualRate: number;
  monthlyRate: number;
  interest: number;
  /** Capital actually repaid — less than the nominal payment in the last month. */
  capital: number;
  /** What leaves the bank account this month. */
  payment: number;
  closingBalance: number;
  cumulativeInterest: number;
  cumulativeCapital: number;
  cumulativePaid: number;
}

export interface LoanSchedule {
  rows: LoanMonth[];
  /** The month the balance first reaches zero, or null if it never does. */
  payoffMonth: number | null;
  totalInterest: number;
  totalCapital: number;
  totalPaid: number;
  /** True when the debt is growing: the payment does not cover the interest. */
  neverRepays: boolean;
  /** True when the run hit `maxMonths` with a balance still outstanding. */
  truncated: boolean;
  message: string;
}

/** A quoted annual percentage as a monthly fraction. */
export function monthlyRate(annualPercent: number, conversion: RateConversion): number {
  const annual = annualPercent / 100;
  if (!Number.isFinite(annual)) return 0;
  /* Nominal is division; effective is the twelfth root. They differ by about
   * 2% of the rate at mortgage levels — 4% nominal is 0.3333% a month, 4%
   * effective is 0.3274% — which is small per month and thousands of pounds
   * over a term. */
  if (conversion === 'effective') {
    return annual <= -1 ? 0 : Math.pow(1 + annual, 1 / 12) - 1;
  }
  return annual / 12;
}

/**
 * The annual rate in force in a given month, 1-based.
 *
 * Periods are consumed in order, and the last one never runs out — a schedule
 * that outlives its rate table stays on the final rate rather than falling off
 * the end into zero, which would quietly make the rest of the loan free.
 */
export function rateAtMonth(periods: RatePeriod[], month: number): number {
  if (!periods.length) return 0;
  let start = 0;
  for (const p of periods) {
    const length = Math.max(0, Math.floor(p.months));
    if (month <= start + length) return p.annualRate;
    start += length;
  }
  /* Past the end of the table, the last rate continues. Falling through to a
   * zero here would make the remainder of the loan silently free, which is the
   * most flattering possible bug and therefore the one to guard hardest
   * against — a schedule outliving its rate table is the normal case, since
   * the final period's length is not meant to bound anything. */
  return periods[periods.length - 1].annualRate;
}

/**
 * The balance after a given number of months, allowed to go negative.
 *
 * Deliberately unclamped, which is what makes it usable as the function to
 * solve. `amortise` stops at zero because a real loan does; a root finder needs
 * to see *how far past* zero a payment overshoots, or it has nothing to bisect
 * on — every payment large enough would look identical.
 */
function balanceAfter(world: LoanWorld, payment: number, months: number): number {
  let balance = Math.max(0, world.principal);
  for (let month = 1; month <= months; month++) {
    const rate = monthlyRate(rateAtMonth(world.periods, month), world.conversion);
    const extra = world.overpaymentMonth === month ? Math.max(0, world.overpayment) : 0;
    balance =
      world.interestHandling === 'capitalised'
        ? balance * (1 + rate) - payment - extra
        : balance - payment - extra;
  }
  return balance;
}

/**
 * The monthly capital payment that clears the loan in exactly `targetMonths`.
 *
 * Found by bisection rather than by a formula, for the same reason the schedule
 * is marched rather than looked up: the annuity formula inverts cleanly only
 * for a single rate, and a fixed period ending partway through is the normal
 * case. Bisection needs only that the balance after N months falls as the
 * payment rises, which is true for every arrangement here — including a
 * one-off overpayment, which no closed form accommodates at all.
 *
 * With the interest paid separately this reduces to principal ÷ months, and the
 * tests check that it does.
 */
export function solvePayment(world: LoanWorld): number {
  const months = Math.max(1, Math.round(world.targetMonths));
  if (!(world.principal > 0)) return 0;

  // Paying nothing leaves the whole debt; the bracket has to contain the root.
  if (balanceAfter(world, 0, months) <= 0) return 0;
  let high = Math.max(1, world.principal);
  // Doubling up rather than guessing an upper bound: at a high enough rate the
  // payment that clears in one month is a long way above the principal.
  for (let i = 0; i < 60 && balanceAfter(world, high, months) > 0; i++) high *= 2;

  let low = 0;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (balanceAfter(world, mid, months) > 0) low = mid;
    else high = mid;
    if (high - low < 1e-9) break;
  }
  return high;
}

/** The capital payment actually in force, whichever way round the loan is set up. */
export function effectivePayment(world: LoanWorld): number {
  return world.driver === 'term' ? solvePayment(world) : Math.max(0, world.capitalPayment);
}

/**
 * Runs the loan out to its end.
 *
 * The loop stops on the month the balance reaches zero, so the last row shows
 * a smaller capital payment than the others — paying £2,500 into a £900 debt
 * repays £900, and a schedule that pretends otherwise ends with a negative
 * balance and a total that is too high.
 */
export function amortise(world: LoanWorld): LoanSchedule {
  const rows: LoanMonth[] = [];
  const limit = Math.max(1, Math.min(12_000, Math.round(world.maxMonths)));
  const payment = effectivePayment(world);

  let balance = Math.max(0, world.principal);
  let cumulativeInterest = 0;
  let cumulativeCapital = 0;
  let payoffMonth: number | null = balance <= 0 ? 0 : null;
  let truncated = false;

  for (let month = 1; month <= limit && balance > 1e-9; month++) {
    const annualRate = rateAtMonth(world.periods, month);
    const rate = monthlyRate(annualRate, world.conversion);
    // Interest is charged on what was owed at the start of the month, which is
    // the convention every lender uses and the reason a payment made on the
    // first of the month still costs a full month's interest.
    const interest = balance * rate;

    const extra = world.overpaymentMonth === month ? Math.max(0, world.overpayment) : 0;
    let capital: number;
    let closing: number;

    if (world.interestHandling === 'capitalised') {
      // The interest joins the debt, and the payment then eats into the total.
      const owed = balance + interest;
      capital = Math.min(payment + extra, owed);
      closing = owed - capital;
    } else {
      // The interest is paid separately, so it never joins the debt and the
      // balance falls by exactly what is paid off it.
      capital = Math.min(payment + extra, balance);
      closing = balance - capital;
    }

    cumulativeInterest += interest;
    cumulativeCapital += capital;
    if (closing <= 1e-9) closing = 0;

    rows.push({
      month,
      openingBalance: balance,
      annualRate,
      monthlyRate: rate,
      interest,
      capital,
      // What actually leaves the account. When interest is capitalised the
      // payment is just the capital; when it is paid, it is both.
      payment: world.interestHandling === 'capitalised' ? capital : capital + interest,
      closingBalance: closing,
      cumulativeInterest,
      cumulativeCapital,
      cumulativePaid:
        world.interestHandling === 'capitalised'
          ? cumulativeCapital
          : cumulativeCapital + cumulativeInterest,
    });

    if (closing === 0) payoffMonth = month;
    balance = closing;
  }

  if (balance > 1e-9) truncated = true;

  /* "Never repays" is a statement about the arithmetic, not about running out
   * of months: with interest capitalised, a payment at or below the monthly
   * interest leaves the balance the same or larger every month, and no term
   * however long will clear it. Worth saying plainly, because the chart of a
   * balance creeping upwards is easy to mistake for a slow one going down. */
  const last = rows[rows.length - 1];
  const neverRepays =
    world.interestHandling === 'capitalised' &&
    rows.length > 0 &&
    last.closingBalance >= rows[0].openingBalance - 1e-9;

  const totalInterest = cumulativeInterest;
  const totalCapital = cumulativeCapital;
  const totalPaid = world.interestHandling === 'capitalised' ? totalCapital : totalCapital + totalInterest;

  return {
    rows,
    payoffMonth,
    totalInterest,
    totalCapital,
    totalPaid,
    neverRepays,
    truncated,
    message: describe({ payoffMonth, neverRepays, truncated, limit, world }),
  };
}

function describe(state: {
  payoffMonth: number | null;
  neverRepays: boolean;
  truncated: boolean;
  limit: number;
  world: LoanWorld;
}): string {
  if (effectivePayment(state.world) <= 0) {
    return 'Nothing is being repaid, so the balance never falls.';
  }
  if (state.neverRepays) {
    return 'The payment does not cover the interest, so the debt grows every month and no term will clear it. Raise the payment above the monthly interest.';
  }
  if (state.truncated) {
    return `Still outstanding after ${state.limit} months — the run stops there rather than going on for ever.`;
  }
  if (state.payoffMonth === null) return 'Nothing left to repay.';
  return `Clear in ${formatTerm(state.payoffMonth)}.`;
}

/** "200 months" as "16 years 8 months", which is how anyone thinks about it. */
export function formatTerm(months: number): string {
  const whole = Math.max(0, Math.round(months));
  const years = Math.floor(whole / 12);
  const rest = whole % 12;
  if (years === 0) return `${rest} month${rest === 1 ? '' : 's'}`;
  if (rest === 0) return `${years} year${years === 1 ? '' : 's'}`;
  return `${years} year${years === 1 ? '' : 's'} ${rest} month${rest === 1 ? '' : 's'}`;
}

/** Where the rate changes, for marking on the chart. */
export function rateChangeMonths(periods: RatePeriod[]): { month: number; from: number; to: number }[] {
  const out: { month: number; from: number; to: number }[] = [];
  let start = 0;
  for (let i = 0; i < periods.length - 1; i++) {
    start += Math.max(0, Math.floor(periods[i].months));
    out.push({ month: start, from: periods[i].annualRate, to: periods[i + 1].annualRate });
  }
  return out;
}

/**
 * The same loan under a different setting, for comparison.
 *
 * Used to answer the question every borrower actually has — "what does another
 * £100 a month buy me?" — as two numbers rather than as a second chart.
 */
export interface LoanComparison {
  payoffMonth: number | null;
  totalInterest: number;
  monthsSaved: number | null;
  interestSaved: number;
}

export function compare(base: LoanSchedule, variant: LoanSchedule): LoanComparison {
  const monthsSaved =
    base.payoffMonth !== null && variant.payoffMonth !== null ? base.payoffMonth - variant.payoffMonth : null;
  return {
    payoffMonth: variant.payoffMonth,
    totalInterest: variant.totalInterest,
    monthsSaved,
    interestSaved: base.totalInterest - variant.totalInterest,
  };
}
