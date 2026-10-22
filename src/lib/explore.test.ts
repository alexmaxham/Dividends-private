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
