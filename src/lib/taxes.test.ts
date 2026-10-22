import { describe, expect, it } from 'vitest';
import { likelyQualified, taxableStillToCome, taxYear } from './taxes';
import type { Account, Dividend, HoldingStats } from './types';

const ACCOUNTS: Account[] = [
  { id: 'ind', name: 'Individual', mask: '1', subtype: 'brokerage', institution: 'Robinhood' },
  { id: 'roth', name: 'Roth IRA', mask: '2', subtype: 'roth', institution: 'Robinhood' },
];
const d = (o: Partial<Dividend>): Dividend => ({ id: Math.random().toString(), symbol: 'KO', amount: 100, rate: 1, shares: 100, state: 'paid', payDate: '2026-06-01', account: 'ind', ...o });
const HOLDINGS = [
  { symbol: 'KO', sector: 'Consumer Staples', name: 'Coca-Cola' },
  { symbol: 'O', sector: 'Real Estate', name: 'Realty Income' },
  { symbol: 'NESN', sector: 'Consumer Staples', name: 'Nestle' },
];

describe('taxYear', () => {
  const divs = [
    d({ qualified: true }),
    d({ symbol: 'O', amount: 50, qualified: false }),
    d({ symbol: 'O', amount: 40 }), // unlabeled REIT → ordinary by guess
    d({ symbol: 'KO', amount: 30 }), // unlabeled → qualified by guess
    d({ symbol: 'NESN', amount: 20, qualified: true, withholding: 3 }),
    d({ amount: 500, account: 'roth', qualified: true }), // sheltered
    d({ amount: 70, payDate: '2025-12-15', qualified: true }), // other year
    d({ amount: 60, state: 'pending', payDate: '2026-12-15' }), // not paid yet
  ];
  const t = taxYear(divs, HOLDINGS, ACCOUNTS, '2026', '2026-10-21', { qualified: 15, ordinary: 24 });

  it('splits taxable dividends into qualified and ordinary', () => {
    expect([t.qualified, t.ordinary, t.guessed, t.sheltered, t.withheld]).toEqual([150, 90, 70, 500, 3]);
    expect(t.estimatedTax).toBeCloseTo(150 * 0.15 + 90 * 0.24 - 3);
    expect(t.lines.find((l) => l.symbol === 'O')).toMatchObject({ ordinary: 90, qualified: 0, guessed: true });
  });

  it('previews the 1099-DIV per brokerage', () => {
    expect(t.forms).toEqual([{ institution: 'Robinhood', box1a: 240, box1b: 150, box7: 3 }]);
  });

  it('treats dividends without an account as taxable', () => {
    const manual = taxYear([d({ account: undefined, qualified: false })], HOLDINGS, [], '2026', '2026-10-21', { qualified: 15, ordinary: 24 });
    expect([manual.ordinary, manual.forms[0].institution]).toEqual([100, 'Your brokerage']);
  });

  it('guesses REITs and income funds as ordinary', () => {
    expect(likelyQualified({ sector: 'Real Estate', name: 'Realty Income' })).toBe(false);
    expect(likelyQualified({ sector: 'ETF', name: 'JPMorgan Equity Premium Income ETF' })).toBe(false);
    expect(likelyQualified({ sector: 'Technology', name: 'Microsoft' })).toBe(true);
  });

  it('estimates the rest of the year from taxable shares only', () => {
    const h = { symbol: 'KO', sector: 'Consumer Staples', name: 'Coca-Cola', shares: 20, lots: [{ account: 'ind', shares: 15, cost: 0 }, { account: 'roth', shares: 5, cost: 0 }] } as HoldingStats;
    const r = taxableStillToCome([{ symbol: 'KO', date: '2026-12-15', amount: 10, rate: 0.5, kind: 'confirmed' }, { symbol: 'KO', date: '2027-03-15', amount: 10, rate: 0.5, kind: 'estimated' }],
      [h], ACCOUNTS, '2026', { qualified: 15, ordinary: 24 });
    expect(r).toEqual({ amount: 7.5, tax: 1.13 });
  });
});
