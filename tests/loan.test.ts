import { describe, expect, it } from 'vitest';
import {
  amortise,
  compare,
  formatTerm,
  monthlyRate,
  rateAtMonth,
  rateChangeMonths,
  type LoanWorld,
  type RatePeriod,
} from '../src/core/finance/loan';

/* Amortisation has closed forms in the simple cases, and those are what this
 * file checks against — never against what the loop produced last time. The
 * point of marching the schedule is that it stays right when the closed forms
 * stop applying, so the tests establish agreement where a formula exists and
 * then check the properties that must hold where one does not: the balance
 * never goes negative, the totals are the sums of their columns, and money is
 * conserved.
 */

let counter = 0;
const period = (months: number, annualRate: number): RatePeriod => ({
  id: `p${counter++}`,
  months,
  annualRate,
  label: '',
});

const world = (over: Partial<LoanWorld> = {}): LoanWorld => ({
  principal: 500_000,
  capitalPayment: 2_500,
  periods: [period(2, 1.09), period(0, 4)],
  conversion: 'nominal',
  interestHandling: 'paid',
  overpayment: 0,
  overpaymentMonth: 0,
  maxMonths: 1200,
  ...over,
});

describe('rate conversion', () => {
  it('divides by twelve for a nominal rate', () => {
    expect(monthlyRate(4, 'nominal')).toBeCloseTo(0.04 / 12, 15);
    expect(monthlyRate(1.09, 'nominal')).toBeCloseTo(0.0109 / 12, 15);
    expect(monthlyRate(0, 'nominal')).toBe(0);
  });

  it('takes the twelfth root for an effective rate', () => {
    // (1 + m)^12 = 1 + annual, which is what "effective" means.
    const m = monthlyRate(4, 'effective');
    expect((1 + m) ** 12).toBeCloseTo(1.04, 12);
    // And it is below the nominal rate, always — the gap is the compounding
    // the nominal quote quietly ignores.
    expect(m).toBeLessThan(0.04 / 12);
  });

  it('agrees with itself at zero and stays finite at the extremes', () => {
    expect(monthlyRate(0, 'effective')).toBeCloseTo(0, 15);
    expect(Number.isFinite(monthlyRate(100, 'effective'))).toBe(true);
    expect(Number.isFinite(monthlyRate(-100, 'effective'))).toBe(true);
  });
});

describe('which rate applies when', () => {
  const periods = [period(2, 1.09), period(0, 4)];

  it('uses the first rate for its stated months and the next one after', () => {
    expect(rateAtMonth(periods, 1)).toBe(1.09);
    expect(rateAtMonth(periods, 2)).toBe(1.09);
    expect(rateAtMonth(periods, 3)).toBe(4);
    expect(rateAtMonth(periods, 500)).toBe(4);
  });

  it('keeps the last rate for ever rather than running out', () => {
    // A schedule that outlived its rate table used to fall off the end and get
    // a zero rate, which makes the rest of the loan silently free.
    const short = [period(1, 5), period(1, 6), period(1, 7)];
    expect(rateAtMonth(short, 3)).toBe(7);
    expect(rateAtMonth(short, 4)).toBe(7);
    expect(rateAtMonth(short, 9999)).toBe(7);
  });

  it('reports where the rate changes', () => {
    expect(rateChangeMonths(periods)).toEqual([{ month: 2, from: 1.09, to: 4 }]);
    expect(rateChangeMonths([period(3, 1), period(4, 2), period(0, 3)])).toEqual([
      { month: 3, from: 1, to: 2 },
      { month: 7, from: 2, to: 3 },
    ]);
    // One period never changes.
    expect(rateChangeMonths([period(0, 4)])).toEqual([]);
  });
});

describe('interest paid separately', () => {
  /* The balance falls by exactly the capital payment, so it is linear and the
   * whole schedule has a closed form:
   *
   *   balance after n months  = L − Pn
   *   payoff                  = ceil(L / P)
   *   total interest at rate i = i · Σ (L − Pk), k = 0 … N−1
   *                            = i · (N·L − P·N(N−1)/2)
   */
  it('clears a 500,000 loan at 2,500 a month in exactly 200 months', () => {
    const schedule = amortise(world({ periods: [period(0, 4)] }));
    expect(schedule.payoffMonth).toBe(200);
    expect(schedule.rows).toHaveLength(200);
    expect(schedule.rows[199].closingBalance).toBe(0);
    expect(schedule.truncated).toBe(false);
    expect(schedule.neverRepays).toBe(false);
  });

  it('matches the closed form for total interest at a flat rate', () => {
    const schedule = amortise(world({ periods: [period(0, 4)] }));
    const i = 0.04 / 12;
    const N = 200;
    const expected = i * (N * 500_000 - 2_500 * ((N * (N - 1)) / 2));
    // £167,500 exactly, by hand.
    expect(expected).toBeCloseTo(167_500, 6);
    expect(schedule.totalInterest).toBeCloseTo(expected, 6);
  });

  it('matches the closed form when the rate changes partway through', () => {
    const schedule = amortise(world());
    /* Two months at 1.09% on balances of 500,000 and 497,500, then 198 months
     * at 4% on 495,000 down to 2,500. Both sums done by hand:
     *   (500,000 + 497,500) × 0.0109/12                       =    906.0625
     *   (198×495,000 − 2,500×197×198/2) × 0.04/12             = 164,175
     *                                                    total = 165,081.06
     */
    const early = (500_000 + 497_500) * (0.0109 / 12);
    const late = (198 * 495_000 - 2_500 * ((197 * 198) / 2)) * (0.04 / 12);
    expect(early).toBeCloseTo(906.0625, 6);
    expect(late).toBeCloseTo(164_175, 6);
    expect(schedule.totalInterest).toBeCloseTo(early + late, 6);
    expect(schedule.totalInterest).toBeCloseTo(165_081.0625, 4);
    // The rate change does not touch the term, because the balance falls by the
    // capital payment whatever the rate is.
    expect(schedule.payoffMonth).toBe(200);
  });

  it('charges interest on the opening balance, not the closing one', () => {
    const schedule = amortise(world({ periods: [period(0, 4)] }));
    const first = schedule.rows[0];
    expect(first.openingBalance).toBe(500_000);
    expect(first.interest).toBeCloseTo(500_000 * (0.04 / 12), 9);
    // Closing balance × rate would be £8.33 less, every month, for ever.
    expect(first.interest).not.toBeCloseTo(first.closingBalance * (0.04 / 12), 6);
  });

  it('does not overpay in the final month', () => {
    // 500,001 needs a 201st month, and that month repays £1 rather than £2,500.
    const schedule = amortise(world({ principal: 500_001, periods: [period(0, 4)] }));
    expect(schedule.payoffMonth).toBe(201);
    const last = schedule.rows[200];
    expect(last.capital).toBeCloseTo(1, 9);
    expect(last.closingBalance).toBe(0);
    // And the capital column adds up to the principal, exactly.
    expect(schedule.totalCapital).toBeCloseTo(500_001, 6);
  });

  it('never lets the balance go negative', () => {
    for (const principal of [1, 999, 2_499, 2_500, 2_501, 500_000]) {
      const schedule = amortise(world({ principal, periods: [period(0, 4)] }));
      for (const row of schedule.rows) {
        expect(row.closingBalance).toBeGreaterThanOrEqual(0);
        expect(row.capital).toBeLessThanOrEqual(row.openingBalance + 1e-9);
      }
      expect(schedule.totalCapital).toBeCloseTo(principal, 6);
    }
  });

  it('adds up: every total is the sum of its column', () => {
    const schedule = amortise(world());
    const sum = (f: (r: (typeof schedule.rows)[number]) => number) =>
      schedule.rows.reduce((t, r) => t + f(r), 0);
    expect(schedule.totalInterest).toBeCloseTo(sum((r) => r.interest), 6);
    expect(schedule.totalCapital).toBeCloseTo(sum((r) => r.capital), 6);
    expect(schedule.totalPaid).toBeCloseTo(sum((r) => r.payment), 6);
    // Paid = capital + interest when the interest is paid rather than rolled up.
    expect(schedule.totalPaid).toBeCloseTo(schedule.totalCapital + schedule.totalInterest, 6);
    // The running totals agree with the finals.
    const last = schedule.rows[schedule.rows.length - 1];
    expect(last.cumulativeInterest).toBeCloseTo(schedule.totalInterest, 9);
    expect(last.cumulativeCapital).toBeCloseTo(schedule.totalCapital, 9);
  });

  it('costs nothing at a zero rate, and the term is unchanged', () => {
    const schedule = amortise(world({ periods: [period(0, 0)] }));
    expect(schedule.totalInterest).toBe(0);
    expect(schedule.payoffMonth).toBe(200);
    expect(schedule.totalPaid).toBeCloseTo(500_000, 6);
  });
});

describe('interest capitalised', () => {
  /* Now the debt compounds, and the standard annuity formula applies while the
   * rate is constant:
   *
   *   balance(n) = (L − P/i)(1 + i)^n + P/i
   *   term       = ln( P / (P − L·i) ) / ln(1 + i)
   */
  const capitalised = (over: Partial<LoanWorld> = {}) =>
    amortise(world({ interestHandling: 'capitalised', periods: [period(0, 4)], ...over }));

  it('follows the annuity formula month by month', () => {
    const schedule = capitalised();
    const i = 0.04 / 12;
    const P = 2_500;
    const L = 500_000;
    for (const month of [1, 12, 60, 120, 240]) {
      const expected = (L - P / i) * (1 + i) ** month + P / i;
      expect(schedule.rows[month - 1].closingBalance).toBeCloseTo(expected, 5);
    }
  });

  it('takes the term the formula predicts', () => {
    const schedule = capitalised();
    const i = 0.04 / 12;
    const exact = Math.log(2_500 / (2_500 - 500_000 * i)) / Math.log(1 + i);
    // 330.1 months by hand, so the loan clears in the 331st.
    expect(exact).toBeCloseTo(330.12, 1);
    expect(schedule.payoffMonth).toBe(Math.ceil(exact));
  });

  it('costs far more than paying the interest as you go', () => {
    const paid = amortise(world({ periods: [period(0, 4)] }));
    const rolled = capitalised();
    // Same debt, same payment, same rate — and interest that compounds because
    // it was not paid. The extra is the price of not paying it.
    expect(rolled.totalInterest).toBeGreaterThan(paid.totalInterest * 1.4);
    expect(rolled.payoffMonth).toBeGreaterThan(paid.payoffMonth!);
  });

  it('says so when the payment does not cover the interest', () => {
    // 500,000 at 4% costs £1,666.67 a month in interest alone.
    const schedule = capitalised({ capitalPayment: 1_000 });
    expect(schedule.neverRepays).toBe(true);
    expect(schedule.payoffMonth).toBeNull();
    expect(schedule.truncated).toBe(true);
    expect(schedule.message).toContain('does not cover the interest');
    // And the balance really is growing, not merely slow.
    expect(schedule.rows[schedule.rows.length - 1].closingBalance).toBeGreaterThan(500_000);
  });

  it('sits exactly on the knife edge when the payment equals the interest', () => {
    const interest = 500_000 * (0.04 / 12);
    const schedule = capitalised({ capitalPayment: interest });
    // The balance is unchanged every month for ever: an interest-only loan.
    expect(schedule.rows[0].closingBalance).toBeCloseTo(500_000, 6);
    expect(schedule.rows[600].closingBalance).toBeCloseTo(500_000, 6);
    expect(schedule.neverRepays).toBe(true);
  });

  it('respects a rate change, which no annuity formula can', () => {
    const schedule = amortise(
      world({ interestHandling: 'capitalised', periods: [period(24, 1.09), period(0, 4)] }),
    );
    // Cheap for two years, then dear. The first 24 months follow the low-rate
    // formula exactly; after that the single-rate formula is simply wrong, and
    // the schedule is the only thing that knows.
    const iLow = 0.0109 / 12;
    const expected24 = (500_000 - 2_500 / iLow) * (1 + iLow) ** 24 + 2_500 / iLow;
    expect(schedule.rows[23].closingBalance).toBeCloseTo(expected24, 5);
    const iHigh = 0.04 / 12;
    const wrong = (500_000 - 2_500 / iHigh) * (1 + iHigh) ** 24 + 2_500 / iHigh;
    expect(Math.abs(schedule.rows[23].closingBalance - wrong)).toBeGreaterThan(10_000);
  });
});

describe('overpayments', () => {
  it('shortens the term and cuts the interest', () => {
    const base = amortise(world({ periods: [period(0, 4)] }));
    const withExtra = amortise(
      world({ periods: [period(0, 4)], overpayment: 50_000, overpaymentMonth: 1 }),
    );
    // £50,000 is twenty months of capital, so the term drops by twenty.
    expect(base.payoffMonth! - withExtra.payoffMonth!).toBe(20);
    expect(withExtra.totalInterest).toBeLessThan(base.totalInterest);
    // Still repays exactly the principal, no more.
    expect(withExtra.totalCapital).toBeCloseTo(500_000, 6);
  });

  it('does nothing when it is switched off', () => {
    const base = amortise(world());
    const off = amortise(world({ overpayment: 50_000, overpaymentMonth: 0 }));
    expect(off.payoffMonth).toBe(base.payoffMonth);
    expect(off.totalInterest).toBeCloseTo(base.totalInterest, 9);
  });

  it('is reported as months and pounds saved', () => {
    const base = amortise(world({ periods: [period(0, 4)] }));
    const variant = amortise(world({ periods: [period(0, 4)], capitalPayment: 3_000 }));
    const result = compare(base, variant);
    // 500,000 / 3,000 = 166.67, so 167 months against 200.
    expect(variant.payoffMonth).toBe(167);
    expect(result.monthsSaved).toBe(33);
    expect(result.interestSaved).toBeGreaterThan(0);
    expect(result.interestSaved).toBeCloseTo(base.totalInterest - variant.totalInterest, 9);
  });
});

describe('degenerate inputs', () => {
  it('does nothing with nothing owed', () => {
    const schedule = amortise(world({ principal: 0 }));
    expect(schedule.rows).toHaveLength(0);
    expect(schedule.totalInterest).toBe(0);
    expect(schedule.payoffMonth).toBe(0);
  });

  it('never finishes with no payment, and says why', () => {
    const schedule = amortise(world({ capitalPayment: 0 }));
    expect(schedule.payoffMonth).toBeNull();
    expect(schedule.truncated).toBe(true);
    expect(schedule.message).toContain('Nothing is being repaid');
  });

  it('stops at the month limit rather than running for ever', () => {
    const schedule = amortise(world({ capitalPayment: 1, maxMonths: 50 }));
    expect(schedule.rows).toHaveLength(50);
    expect(schedule.truncated).toBe(true);
  });

  it('produces finite numbers throughout, whatever it is given', () => {
    for (const over of [
      { principal: 1e9 },
      { capitalPayment: 1e9 },
      { periods: [period(0, 99)] },
      { periods: [] },
      { conversion: 'effective' as const },
      { interestHandling: 'capitalised' as const, capitalPayment: 1 },
    ]) {
      const schedule = amortise(world({ maxMonths: 300, ...over }));
      for (const row of schedule.rows) {
        expect(Number.isFinite(row.openingBalance)).toBe(true);
        expect(Number.isFinite(row.interest)).toBe(true);
        expect(Number.isFinite(row.closingBalance)).toBe(true);
        expect(Number.isFinite(row.cumulativeInterest)).toBe(true);
      }
      expect(Number.isFinite(schedule.totalInterest)).toBe(true);
      expect(Number.isFinite(schedule.totalPaid)).toBe(true);
    }
  });

  it('treats an empty rate table as zero rather than as NaN', () => {
    const schedule = amortise(world({ periods: [] }));
    expect(schedule.totalInterest).toBe(0);
    expect(schedule.payoffMonth).toBe(200);
  });
});

describe('terms in words', () => {
  it('reads the way anyone would say it', () => {
    expect(formatTerm(200)).toBe('16 years 8 months');
    expect(formatTerm(12)).toBe('1 year');
    expect(formatTerm(24)).toBe('2 years');
    expect(formatTerm(1)).toBe('1 month');
    expect(formatTerm(7)).toBe('7 months');
    expect(formatTerm(13)).toBe('1 year 1 month');
    expect(formatTerm(0)).toBe('0 months');
  });
});
