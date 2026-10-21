import { describe, expect, it } from 'vitest';
import { addMonths, computeStats, detectFrequency, monthlySeries, project, projectPayouts } from './analytics';
import { importCsv, parseCsv, toCsv } from './csv';
import { demoPortfolio } from './demo';
import type { Dividend, Holding, Portfolio } from './types';

const TODAY = '2026-10-21';
const holding = (o: Partial<Holding> = {}): Holding => ({
  symbol: 'KO', name: 'Coca-Cola', shares: 10, avgCost: 50, price: 70, prevClose: 69, dividendYield: 2.9, sector: 'Staples', ...o,
});
const div = (payDate: string, rate: number, o: Partial<Dividend> = {}): Dividend => ({
  id: `${o.symbol ?? 'KO'}-${payDate}`, symbol: 'KO', amount: rate * 10, rate, shares: 10, state: 'paid', payDate, ...o,
});
const portfolio = (holdings: Holding[], dividends: Dividend[]): Portfolio =>
  ({ holdings, dividends, history: [], cash: 0, source: 'manual', syncedAt: null });

describe('dates', () => {
  it('clamps month ends', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });
});

describe('detectFrequency', () => {
  it('reads monthly, quarterly, semiannual and annual gaps', () => {
    expect(detectFrequency(['2026-07-15', '2026-08-15', '2026-09-15'])).toBe('monthly');
    expect(detectFrequency(['2026-04-01', '2026-07-01', '2026-10-01'])).toBe('quarterly');
    expect(detectFrequency(['2025-12-01', '2026-06-01'])).toBe('semiannual');
    expect(detectFrequency(['2025-06-01', '2026-06-01'])).toBe('annual');
  });
  it('infers from yield with one payment', () => {
    // 6% yield on $50 = $3/yr; a $0.25 payment means monthly.
    expect(detectFrequency(['2026-10-01'], { dividendYield: 6, price: 50 }, 0.25)).toBe('monthly');
  });
  it('is none without payments or yield', () => {
    expect(detectFrequency([], { dividendYield: 0, price: 10 })).toBe('none');
  });
});

describe('computeStats', () => {
  it('derives forward income from the latest rate and frequency', () => {
    const p = portfolio([holding()], [div('2025-10-01', 0.485), div('2026-04-01', 0.51), div('2026-07-01', 0.51), div('2026-10-01', 0.51)]);
    const { holdings, totals } = computeStats(p, TODAY);
    expect(holdings[0].frequency).toBe('quarterly');
    expect(holdings[0].annualPerShare).toBeCloseTo(2.04);
    expect(totals.annualIncome).toBeCloseTo(20.4);
    expect(holdings[0].yieldOnCost).toBeCloseTo(4.08);
    expect(holdings[0].growth).toBeCloseTo((0.51 / 0.485 - 1) * 100);
    expect(totals.receivedYtd).toBeCloseTo(15.3);
    expect(totals.receivedAllTime).toBeCloseTo(20.15);
  });
  it('falls back to the reported yield without history', () => {
    const { holdings } = computeStats(portfolio([holding({ dividendYield: 4, price: 50 })], []), TODAY);
    expect(holdings[0].annualPerShare).toBeCloseTo(2);
    expect(holdings[0].frequency).toBe('quarterly');
  });
  it('ignores voided dividends and pending ones in received totals', () => {
    const p = portfolio([holding()], [div('2026-07-01', 0.5, { state: 'voided' }), div('2026-11-01', 0.5, { state: 'pending' })]);
    expect(computeStats(p, TODAY).totals.receivedAllTime).toBe(0);
  });
});

describe('projectPayouts', () => {
  it('uses confirmed payments and projects the rest of the year', () => {
    const p = portfolio([holding()], [div('2026-07-01', 0.51), div('2026-10-01', 0.51), div('2027-01-02', 0.53, { state: 'pending' })]);
    const { holdings } = computeStats(p, TODAY);
    const out = projectPayouts(holdings, p.dividends, TODAY, 12);
    expect(out[0]).toMatchObject({ date: '2027-01-02', kind: 'confirmed' });
    expect(out[0].amount).toBeCloseTo(5.3);
    expect(out.filter((x) => x.kind === 'estimated').map((x) => x.date)).toEqual(['2027-04-02', '2027-07-02', '2027-10-02'].filter((d) => d <= '2027-10-21'));
  });
  it('builds a 24-month series', () => {
    const p = demoPortfolio(TODAY);
    const { holdings } = computeStats(p, TODAY);
    const bars = monthlySeries(p.dividends, projectPayouts(holdings, p.dividends, TODAY), TODAY);
    expect(bars).toHaveLength(24);
    expect(bars[11].month).toBe('2026-10');
    expect(bars.slice(0, 11).every((b) => b.received > 0)).toBe(true);
    expect(bars.slice(12).every((b) => b.projected > 0)).toBe(true);
  });
});

describe('project', () => {
  it('compounds with reinvestment', () => {
    const flat = project({ startValue: 10000, yieldPct: 4, monthlyContribution: 0, dividendGrowthPct: 0, priceGrowthPct: 0, years: 10, reinvest: false, taxRatePct: 0 });
    const drip = project({ startValue: 10000, yieldPct: 4, monthlyContribution: 0, dividendGrowthPct: 0, priceGrowthPct: 0, years: 10, reinvest: true, taxRatePct: 0 });
    expect(flat[10].value).toBeCloseTo(10000);
    expect(flat[10].dividendsCollected).toBeCloseTo(4000);
    expect(drip[10].value).toBeGreaterThan(14800);
    expect(drip[10].annualIncome).toBeGreaterThan(590);
  });
});

describe('csv', () => {
  it('parses quotes and newlines', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
    expect(toCsv(['x'], [['a,b']])).toBe('x\n"a,b"');
  });
  it('imports Robinhood activity dividends', () => {
    const text = [
      '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"',
      '"7/1/2026","7/1/2026","7/1/2026","KO","Cash Div: R/D 2026-06-13 P/D 2026-07-01 - 10 shares at 0.51","CDIV","","","$5.10"',
      '"6/2/2026","6/2/2026","6/3/2026","KO","Coca-Cola","Buy","2","$70.00","($140.00)"',
    ].join('\n');
    const r = importCsv(text);
    expect(r.kind).toBe('dividends');
    expect(r.skipped).toBe(1);
    expect(r.dividends[0]).toMatchObject({ symbol: 'KO', amount: 5.1, rate: 0.51, shares: 10, payDate: '2026-07-01', recordDate: '2026-06-13' });
  });
  it('imports a holdings list', () => {
    const r = importCsv('Symbol,Shares,Average Cost,Price\nko,10,50,70\n,1,1,1\n');
    expect(r.holdings).toEqual([expect.objectContaining({ symbol: 'KO', shares: 10, avgCost: 50, price: 70 })]);
    expect(r.skipped).toBe(1);
  });
  it('rejects unknown files', () => {
    expect(() => importCsv('foo,bar\n1,2')).toThrow(/Unrecognized/);
  });
});
