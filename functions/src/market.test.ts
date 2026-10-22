import { describe, expect, it } from 'vitest';
import { Finnhub, Massive, mergeDividends, previousWeekday, reconcileDividends, type MarketDoc } from './market.js';

function fakeMassive(routes: Record<string, unknown>, status = 200) {
  const urls: string[] = [];
  let clock = 0;
  const slept: number[] = [];
  const api = new Massive('key', {
    callsPerMinute: 5,
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    fetcher: async (url) => {
      urls.push(url);
      const u = new URL(url);
      const body = routes[u.pathname + (u.searchParams.get('cursor') ? `?cursor=${u.searchParams.get('cursor')}` : '')] ?? routes[u.pathname];
      return { status: body === undefined ? 404 : status, text: async () => JSON.stringify(body ?? { status: 'NOT_FOUND' }) };
    },
  });
  return { api, urls, slept };
}

describe('Massive', () => {
  it('reads a symbol’s dividends, spacing calls to the plan’s limit', async () => {
    const { api, urls, slept } = fakeMassive({
      '/stocks/v1/dividends': { results: [
        { ticker: 'KO', ex_dividend_date: '2026-11-28', pay_date: '2026-12-15', record_date: '2026-11-28', declaration_date: '2026-10-16', cash_amount: 0.53, frequency: 4 },
        { ticker: 'KO', ex_dividend_date: '2026-09-12', pay_date: '2026-10-01', cash_amount: 0.51, frequency: 4 },
        { ticker: 'KO', ex_dividend_date: '2026-08-01', cash_amount: 0 },
      ] },
    });
    const ds = await api.dividendsFor('KO');
    expect(ds).toEqual([
      { exDate: '2026-11-28', payDate: '2026-12-15', recordDate: '2026-11-28', declared: '2026-10-16', amount: 0.53, frequency: 4 },
      { exDate: '2026-09-12', payDate: '2026-10-01', recordDate: null, declared: null, amount: 0.51, frequency: 4 },
    ]);
    expect(urls[0]).toContain('apiKey=key');
    expect(urls[0]).toContain('ticker=KO');
    await api.dividendsFor('PEP');
    expect(slept).toEqual([12000]); // 5 a minute
  });

  it('groups market-wide sweeps by ticker and follows pages', async () => {
    const { api, urls } = fakeMassive({
      '/stocks/v1/dividends': { results: [{ ticker: 'KO', ex_dividend_date: '2026-11-28', cash_amount: 0.53 }], next_url: 'https://api.massive.com/stocks/v1/dividends?cursor=p2' },
      '/stocks/v1/dividends?cursor=p2': { results: [{ ticker: 'pep', ex_dividend_date: '2026-12-05', cash_amount: 1.48, dividend_type: 'SC' }] },
    });
    const by = await api.dividendsSince('2026-10-12');
    expect([...by.keys()]).toEqual(['KO', 'PEP']);
    expect(by.get('PEP')![0].special).toBe(true);
    expect(urls[1]).toContain('cursor=p2');
    expect(urls[1]).toContain('apiKey=key');
  });

  it('reads splits as a share ratio', async () => {
    const { api } = fakeMassive({ '/stocks/v1/splits': { results: [
      { ticker: 'NVDA', execution_date: '2026-06-10', split_from: 1, split_to: 10 },
      { ticker: 'XYZ', execution_date: '2026-03-02', split_from: 8, split_to: 1 },
    ] } });
    const s = await api.splitsSince('2024-10-21');
    expect(s.get('NVDA')).toEqual([{ date: '2026-06-10', ratio: 10 }]);
    expect(s.get('XYZ')).toEqual([{ date: '2026-03-02', ratio: 0.125 }]);
  });

  it('turns a rate limit into a clear error', async () => {
    const { api } = fakeMassive({ '/stocks/v1/dividends': { status: 'ERROR' } }, 429);
    await expect(api.dividendsFor('KO')).rejects.toMatchObject({ status: 429 });
  });
});

describe('Finnhub', () => {
  it('reads a quote and ignores unknown symbols', async () => {
    const f = new Finnhub('tok', async (url) => ({
      status: 200,
      text: async () => JSON.stringify(url.includes('symbol=KO') ? { c: 71.2, pc: 70.9, t: 1793000000 } : { c: 0, pc: 0 }),
    }));
    expect(await f.quote('KO')).toEqual({ price: 71.2, prevClose: 70.9, at: new Date(1793000000 * 1000).toISOString() });
    expect(await f.quote('NOPE')).toBeNull();
  });
});

describe('reconcileDividends', () => {
  const market = new Map<string, Pick<MarketDoc, 'dividends' | 'splits'>>([
    ['KO', { dividends: [{ exDate: '2026-09-12', payDate: '2026-10-01', amount: 0.51 }], splits: [] }],
    ['NVDA', { dividends: [], splits: [{ date: '2026-06-10', ratio: 10 }] }],
  ]);

  it('uses the announced per-share amount for the same payment', () => {
    // Rebuilt share count was off (say, a transfer Plaid didn't show): 20 shares → $0.255. Market says $0.51.
    const [d] = reconcileDividends([{ symbol: 'KO', amount: 10.2, rate: 0.255, shares: 40, payDate: '2026-10-02' }], market, new Set());
    expect([d.rate, d.shares]).toEqual([0.51, 20]);
  });

  it('undoes a split the brokerage didn’t report', () => {
    // 100 shares today after a 10-for-1 split; in March there were 10, paying $0.04 each.
    const [d] = reconcileDividends([{ symbol: 'NVDA', amount: 0.4, rate: 0.004, shares: 100, payDate: '2026-03-27' }], market, new Set());
    expect([d.shares, d.rate]).toEqual([10, 0.04]);
    const [same] = reconcileDividends([{ symbol: 'NVDA', amount: 0.4, rate: 0.04, shares: 10, payDate: '2026-03-27' }], market, new Set(['NVDA']));
    expect(same.shares).toBe(10); // the split was already in Plaid's transactions
  });

  it('leaves payments it can’t match alone', () => {
    const d = { symbol: 'PEP', amount: 5, rate: 1.25, shares: 4, payDate: '2026-09-30' };
    expect(reconcileDividends([d], market, new Set())[0]).toBe(d);
  });
});

describe('helpers', () => {
  it('merges dividend lists by ex-date, newest first', () => {
    const m = mergeDividends(
      [{ exDate: '2026-09-12', payDate: null, amount: 0.5 }, { exDate: '2020-01-01', payDate: null, amount: 0.3 }],
      [{ exDate: '2026-09-12', payDate: '2026-10-01', amount: 0.51 }, { exDate: '2026-11-28', payDate: '2026-12-15', amount: 0.53 }],
      '2023-10-21',
    );
    expect(m.map((d) => [d.exDate, d.amount])).toEqual([['2026-11-28', 0.53], ['2026-09-12', 0.51]]);
  });

  it('steps back over weekends', () => {
    expect(previousWeekday('2026-10-19')).toBe('2026-10-16'); // Monday → Friday
    expect(previousWeekday('2026-10-21')).toBe('2026-10-20');
  });
});
