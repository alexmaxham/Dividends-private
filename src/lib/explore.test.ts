import { describe, expect, it } from 'vitest';
import { demoMarket, demoPortfolio } from './demo';
import { symbolSummary, whatIf } from './explore';

const TODAY = '2026-10-21';
const market = demoMarket(TODAY);
const p = demoPortfolio(TODAY);

describe('watchlist and what-if', () => {
  it('summarizes a symbol you don’t own', () => {
    const vym = symbolSummary(market.VYM, TODAY);
    expect(vym).toMatchObject({ symbol: 'VYM', price: 138.6, frequency: 'quarterly' });
    expect(vym.annualPerShare).toBeCloseTo(0.85 * 4);
    expect(vym.yieldPct).toBeCloseTo((3.4 / 138.6) * 100);
  });

  it('adds a new holding’s income', () => {
    const r = whatIf(p, market, TODAY, 'VYM', 1386)!;
    expect(r.shares).toBeCloseTo(10);
    expect(r.incomeAfter - r.incomeBefore).toBeCloseTo(34);
    expect(r.months.reduce((s, m) => s + m.added, 0)).toBeCloseTo(34, 0); // four payments in the next 12 months
    expect(r.months.filter((m) => m.added > 0).map((m) => m.month.slice(5))).toEqual(['12', '03', '06', '09']);
  });

  it('tops up a holding you already own', () => {
    const r = whatIf(p, market, TODAY, 'KO', 711)!;
    expect(r.shares).toBeCloseTo(10);
    expect(r.incomeAfter - r.incomeBefore).toBeCloseTo(0.53 * 4 * 10);
    expect(whatIf(p, market, TODAY, 'KO', 0)).toBeNull();
  });
});

import { milestones } from './milestones';

describe('milestones', () => {
  it('stacks bills from the smallest', () => {
    const m = milestones(100);
    expect(m.list.filter((x) => x.covered).map((x) => x.id)).toEqual(['streaming', 'internet']); // 18 + 70 = 88
    expect(m.next!.id).toBe('phone');
    expect(m.progress).toBeCloseTo((100 - 88) / 90);
    expect(milestones(0).next!.id).toBe('streaming');
    expect(milestones(1e6).next).toBeNull();
  });
});

import { compareWithBenchmark } from './benchmark';

describe('benchmark', () => {
  const bench = {
    symbol: 'SPY',
    closes: [{ date: '2026-01-02', close: 100 }, { date: '2026-01-05', close: 110 }, { date: '2026-01-06', close: 108 }],
    dividends: [{ exDate: '2026-01-06', payDate: '2026-02-01', amount: 2 }],
  };

  it('adjusts for deposits and counts cash dividends', () => {
    const history = [
      { date: '2026-01-02', value: 1000, cost: 1000 },
      { date: '2026-01-05', value: 1600, cost: 1500 }, // +500 deposited, +100 growth: 10%
      { date: '2026-01-06', value: 1600, cost: 1500 }, // flat, but a $16 cash dividend: +1%
    ];
    const divs = [{ id: 'd', symbol: 'KO', amount: 16, rate: 1, shares: 16, state: 'paid' as const, payDate: '2026-01-06' }];
    const c = compareWithBenchmark(history, divs, bench, '2026-01-01')!;
    expect(c.dates).toEqual(['2026-01-02', '2026-01-05', '2026-01-06']);
    expect(c.portfolio[1]).toBeCloseTo(10);
    expect(c.portfolio[2]).toBeCloseTo(11.1);
    // Benchmark: 100 → 110 (+10%), then 108 plus a $2 dividend = flat: still +10%.
    expect(c.benchmark).toEqual([0, expect.closeTo(10), expect.closeTo(10)]);
  });

  it('needs history on both sides', () => {
    expect(compareWithBenchmark([{ date: '2026-01-05', value: 1, cost: 1 }], [], bench, '2026-01-01')).toBeNull();
    expect(compareWithBenchmark([{ date: '2026-01-05', value: 1, cost: 1 }, { date: '2026-01-06', value: 1, cost: 1 }], [], undefined, '2026-01-01')).toBeNull();
  });
});

import { computeStats } from './analytics';
import { reportHtml, reportText, yearReport } from './report';

describe('year in review', () => {
  it('sums the year and compares it with the last', () => {
    const { holdings, totals } = computeStats(p, TODAY, market);
    const r = yearReport(p.dividends, holdings, totals, '2025', TODAY);
    expect(r.partial).toBe(false);
    expect(r.months).toHaveLength(12);
    expect(r.total).toBeCloseTo(r.months.reduce((s, m) => s + m.amount, 0));
    expect(r.top[0].amount).toBeGreaterThanOrEqual(r.top[1].amount);
    expect(r.raises).toEqual([]);
    const now = yearReport(p.dividends, holdings, totals, '2026', TODAY);
    expect(now.partial).toBe(true);
    expect(now.raises.length).toBeGreaterThan(0);
    expect(reportText(now, true)).not.toContain('$');
    expect(reportHtml(now)).toContain('Your 2026 in dividends');
  });
});
