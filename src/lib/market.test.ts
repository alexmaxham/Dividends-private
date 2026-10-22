import { describe, expect, it } from 'vitest';
import { buyBy, computeStats, forAccount, projectPayouts, upcomingExDates, withMarketPrices } from './analytics';
import { accountType, taxTreatment } from './accounts';
import { demoMarket, demoPortfolio } from './demo';
import type { Dividend, Holding, Market, Portfolio } from './types';

const TODAY = '2026-10-21';
const holding = (o: Partial<Holding> = {}): Holding => ({
  symbol: 'KO', name: 'Coca-Cola', shares: 10, avgCost: 50, price: 70, prevClose: 69, dividendYield: 0, sector: 'Staples', ...o,
});
const portfolio = (holdings: Holding[], dividends: Dividend[] = [], o: Partial<Portfolio> = {}): Portfolio =>
  ({ holdings, dividends, history: [], cash: 0, source: 'plaid', syncedAt: '2026-10-21T10:30:00Z', ...o });
const KO: Market = {
  KO: {
    symbol: 'KO',
    dividends: [
      { exDate: '2026-11-28', payDate: '2026-12-15', amount: 0.53, frequency: 4 },
      { exDate: '2026-09-12', payDate: '2026-10-01', amount: 0.51, frequency: 4 },
      { exDate: '2026-06-13', payDate: '2026-07-01', amount: 0.51, frequency: 4 },
      { exDate: '2026-03-13', payDate: '2026-04-01', amount: 0.51, frequency: 4 },
      { exDate: '2025-11-28', payDate: '2025-12-15', amount: 0.51, frequency: 4 },
      { exDate: '2025-09-12', payDate: '2025-10-01', amount: 0.485, frequency: 4 },
      { exDate: '2026-08-01', payDate: '2026-08-15', amount: 2, special: true },
    ],
  },
};

describe('market data', () => {
  it('uses the newest declared amount, even with no payments yet', () => {
    // Just bought: no dividends of your own, and Plaid reports no yield.
    const { holdings } = computeStats(portfolio([holding()]), TODAY, KO);
    expect(holdings[0].frequency).toBe('quarterly');
    expect(holdings[0].annualPerShare).toBeCloseTo(2.12); // the announced $0.53 raise, not the special
    expect(holdings[0].growth).toBeCloseTo((0.53 / 0.51 - 1) * 100);
    const none = computeStats(portfolio([holding()]), TODAY);
    expect(none.holdings[0].annualIncome).toBe(0);
  });

  it('marks declared payments confirmed, with ex-dividend dates', () => {
    const { holdings } = computeStats(portfolio([holding()]), TODAY, KO);
    const payouts = projectPayouts(holdings, [], TODAY, 12, KO);
    expect(payouts[0]).toMatchObject({ symbol: 'KO', date: '2026-12-15', kind: 'confirmed', exDate: '2026-11-28', amount: expect.closeTo(5.3) });
    // Then estimates every quarter after the declared one.
    expect(payouts.slice(1, 3).map((p) => [p.date, p.kind])).toEqual([['2027-03-15', 'estimated'], ['2027-06-15', 'estimated']]);
  });

  it('doesn’t double-count a payment the broker also shows as pending', () => {
    const pending: Dividend = { id: 'p', symbol: 'KO', amount: 5.3, rate: 0.53, shares: 10, state: 'pending', payDate: '2026-12-16' };
    const { holdings } = computeStats(portfolio([holding()], [pending]), TODAY, KO);
    const confirmed = projectPayouts(holdings, [pending], TODAY, 12, KO).filter((p) => p.kind === 'confirmed');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].exDate).toBe('2026-11-28');
  });

  it('lists ex-dividend dates with the day to buy by', () => {
    expect(buyBy('2026-11-30')).toBe('2026-11-27'); // Monday → the Friday before
    const ex = upcomingExDates([{ symbol: 'KO', shares: 10 }], KO, '2026-11-20', 21);
    expect(ex).toEqual([{ symbol: 'KO', exDate: '2026-11-28', buyBy: '2026-11-27', payDate: '2026-12-15', amount: 0.53, income: expect.closeTo(5.3) }]);
  });

  it('uses a quote newer than the last sync', () => {
    const p = portfolio([holding()]);
    const fresh = withMarketPrices(p, { KO: { ...KO.KO, quote: { price: 72, prevClose: 70, at: '2026-10-21T15:00:00Z' } } });
    expect([fresh.holdings[0].price, fresh.holdings[0].prevClose]).toEqual([72, 70]);
    const old = withMarketPrices(p, { KO: { ...KO.KO, quote: { price: 60, prevClose: 61, at: '2026-10-20T15:00:00Z' } } });
    expect(old).toBe(p);
  });
});

describe('accounts', () => {
  const p = portfolio(
    [holding({ shares: 15, avgCost: 50, lots: [{ account: 'ind', shares: 10, cost: 450 }, { account: 'roth', shares: 5, cost: 300 }] }),
      holding({ symbol: 'O', lots: [{ account: 'roth', shares: 10, cost: 500 }] })],
    [{ id: 'a', symbol: 'KO', amount: 5, rate: 0.5, shares: 10, state: 'paid', payDate: '2026-10-01', account: 'ind' },
      { id: 'b', symbol: 'KO', amount: 2.5, rate: 0.5, shares: 5, state: 'paid', payDate: '2026-10-01', account: 'roth' }],
    {
      accounts: [{ id: 'ind', name: 'Individual', mask: '1', subtype: 'brokerage', institution: 'R' }, { id: 'roth', name: 'Roth IRA', mask: '2', subtype: 'roth', institution: 'R' }],
      history: [{ date: TODAY, value: 1750, cost: 1250, byAccount: { ind: { value: 700, cost: 450 }, roth: { value: 1050, cost: 800 } } }],
    },
  );

  it('narrows holdings, dividends and history to one account', () => {
    const roth = forAccount(p, 'roth');
    expect(roth.holdings.map((h) => [h.symbol, h.shares, h.avgCost])).toEqual([['KO', 5, 60], ['O', 10, 50]]);
    expect(roth.dividends.map((d) => d.id)).toEqual(['b']);
    expect(roth.history).toEqual([{ date: TODAY, value: 1050, cost: 800 }]);
    expect(forAccount(p, 'all')).toBe(p);
    expect(forAccount(p, 'gone')).toBe(p);
  });

  it('maps Plaid account types to the planner’s and to tax treatment', () => {
    expect(['brokerage', 'roth', 'ira', '401k', 'roth 401k', 'hsa', 'ugma'].map(accountType))
      .toEqual(['taxable', 'roth-ira', 'traditional-ira', '401k', 'roth-401k', 'hsa', 'taxable']);
    expect(['brokerage', 'roth', 'ira', '529'].map(taxTreatment)).toEqual(['yearly', 'free', 'deferred', 'free']);
  });

  it('gives the sample portfolio two accounts and matching market data', () => {
    const demo = demoPortfolio(TODAY);
    expect(demo.accounts!.map((a) => a.subtype)).toEqual(['brokerage', 'roth']);
    expect(forAccount(demo, 'demo-roth').holdings.map((h) => h.symbol).sort()).toEqual(['ABBV', 'JEPI', 'O']);
    const market = demoMarket(TODAY);
    const { holdings } = computeStats(demo, TODAY, market);
    const ko = holdings.find((h) => h.symbol === 'KO')!;
    expect(ko.annualPerShare).toBeCloseTo(0.53 * 4);
    expect(market.SPY.closes!.length).toBeGreaterThan(400);
  });
});
