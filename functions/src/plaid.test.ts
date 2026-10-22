import { describe, expect, it } from 'vitest';
import { mergePortfolios, Plaid } from './plaid.js';

const TODAY = '2026-10-21';

const SECURITIES = [
  { security_id: 's-ko', ticker_symbol: 'KO', name: 'Coca-Cola Co', type: 'equity', close_price: 70.5, sector: 'Consumer Non-Durables' },
  { security_id: 's-schd', ticker_symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', type: 'etf', close_price: 28.4 },
  { security_id: 's-cash', ticker_symbol: 'CUR:USD', name: 'U S Dollar', type: 'cash', is_cash_equivalent: true },
];
const HOLDINGS = {
  accounts: [{ account_id: 'a1', type: 'investment' }, { account_id: 'chk', type: 'depository' }],
  securities: SECURITIES,
  holdings: [
    { account_id: 'a1', security_id: 's-ko', quantity: 12, institution_price: 71.0, cost_basis: 660.0 },
    { account_id: 'a1', security_id: 's-schd', quantity: 100, institution_price: 28.5, cost_basis: null },
    { account_id: 'a1', security_id: 's-cash', quantity: 250.25, institution_value: 250.25 },
  ],
};
const TRANSACTIONS = [
  // Plaid amounts: negative = cash into the account.
  { investment_transaction_id: 't1', account_id: 'a1', security_id: 's-ko', date: '2026-07-01', type: 'cash', subtype: 'dividend', amount: -5.1, quantity: 0 },
  { investment_transaction_id: 't2', account_id: 'a1', security_id: 's-ko', date: '2026-08-10', type: 'buy', subtype: 'buy', amount: 140, quantity: 2 },
  { investment_transaction_id: 't3', account_id: 'a1', security_id: 's-ko', date: '2026-10-01', type: 'cash', subtype: 'qualified dividend', amount: -6.12, quantity: 0 },
  { investment_transaction_id: 't4', account_id: 'a1', security_id: 's-ko', date: '2026-10-01', type: 'buy', subtype: 'dividend reinvestment', amount: 6.12, quantity: 0 },
  { investment_transaction_id: 't5', account_id: 'a1', security_id: 's-schd', date: '2026-09-25', type: 'cash', subtype: 'dividend', amount: -26.0, quantity: 0 },
];

function fakePlaid(opts: { pages?: object[][]; errors?: Record<string, string> } = {}) {
  const pages = opts.pages ?? [TRANSACTIONS];
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher = async (url: string, init: { body: string }) => {
    const path = url.replace('https://sandbox.plaid.com', '');
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    expect(body.client_id).toBe('cid');
    expect(body.secret).toBe('sec');
    const reply = (status: number, v: unknown) => ({ status, text: async () => JSON.stringify(v) });
    if (opts.errors?.[path]) return reply(400, { error_code: opts.errors[path], error_message: 'nope' });
    if (path === '/link/token/create') return reply(200, { link_token: 'link-sandbox-123' });
    if (path === '/item/public_token/exchange') return reply(200, { access_token: 'access-1', item_id: 'item-1' });
    if (path === '/investments/holdings/get') return reply(200, HOLDINGS);
    if (path === '/investments/transactions/get') {
      const offset = (body.options as { offset: number }).offset;
      let seen = 0;
      let page: object[] = [];
      for (const p of pages) {
        if (seen === offset) { page = p; break; }
        seen += p.length;
      }
      return reply(200, { investment_transactions: page, securities: SECURITIES, total_investment_transactions: pages.flat().length });
    }
    return reply(404, { error_code: 'NOT_FOUND' });
  };
  return { plaid: new Plaid('cid', 'sec', 'sandbox', fetcher), calls };
}

describe('Plaid', () => {
  it('creates link tokens for new links and update mode', async () => {
    const { plaid, calls } = fakePlaid();
    expect(await plaid.linkToken('u1')).toBe('link-sandbox-123');
    expect(calls[0].body.products).toEqual(['investments']);
    await plaid.linkToken('u1', 'access-1');
    expect(calls[1].body.access_token).toBe('access-1');
    expect(calls[1].body.products).toBeUndefined();
  });

  it('maps holdings, cash and dividends, rebuilding share counts', async () => {
    const out = await fakePlaid().plaid.fetchItem('access', TODAY);
    expect(out.cash).toBe(250.25);
    const [ko, schd] = out.holdings;
    expect([ko.symbol, ko.shares, ko.avgCost, ko.price, ko.sector]).toEqual(['KO', 12, 55, 71, 'Consumer Non-Durables']);
    expect([schd.avgCost, schd.sector]).toEqual([28.5, 'ETF']); // no cost basis → priced at today
    const byId = Object.fromEntries(out.dividends.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(['plaid-t1', 'plaid-t3', 'plaid-t5']); // the DRIP buy isn't income
    // July: 12 shares today minus the 2 bought in August = 10, so $5.10 → $0.51/share.
    expect([byId['plaid-t1'].shares, byId['plaid-t1'].rate]).toEqual([10, 0.51]);
    expect([byId['plaid-t3'].shares, byId['plaid-t3'].rate]).toEqual([12, 0.51]);
    expect(out.historyReady).toBe(true);
  });

  it('pages through transactions', async () => {
    const { plaid, calls } = fakePlaid({ pages: [TRANSACTIONS.slice(0, 2), TRANSACTIONS.slice(2)] });
    expect((await plaid.fetchItem('a', TODAY)).dividends).toHaveLength(3);
    expect(calls.filter((c) => c.path === '/investments/transactions/get').map((c) => (c.body.options as { offset: number }).offset)).toEqual([0, 2]);
  });

  it('returns holdings while history is still loading', async () => {
    const out = await fakePlaid({ errors: { '/investments/transactions/get': 'PRODUCT_NOT_READY' } }).plaid.fetchItem('a', TODAY);
    expect(out.holdings).toHaveLength(2);
    expect(out.historyReady).toBe(false);
  });

  it('raises Plaid errors with their code', async () => {
    await expect(fakePlaid({ errors: { '/investments/holdings/get': 'ITEM_LOGIN_REQUIRED' } }).plaid.fetchItem('a', TODAY))
      .rejects.toMatchObject({ code: 'ITEM_LOGIN_REQUIRED' });
  });
});

describe('mergePortfolios', () => {
  it('keeps older dividends and carries the previous close', async () => {
    const part = await fakePlaid().plaid.fetchItem('a', TODAY);
    const previous = {
      syncedAt: '2026-10-20T22:30:00Z',
      holdings: [{ symbol: 'KO', price: 70, prevClose: 69 }],
      dividends: [{ id: 'plaid-old', symbol: 'KO', payDate: '2024-07-01', amount: 4 }],
    };
    const merged = mergePortfolios([part], previous, TODAY);
    expect(merged.holdings.find((h) => h.symbol === 'KO')!.prevClose).toBe(70);
    expect(merged.dividends.at(-1)!.id).toBe('plaid-old');
    const again = mergePortfolios([part], { ...previous, syncedAt: '2026-10-21T13:00:00Z', holdings: [{ symbol: 'KO', price: 71, prevClose: 70 }] }, TODAY);
    expect(again.holdings.find((h) => h.symbol === 'KO')!.prevClose).toBe(70);
  });

  it('combines several logins', () => {
    const h = (avgCost: number) => ({ symbol: 'KO', name: 'KO', shares: 10, avgCost, price: 70, prevClose: 70, dividendYield: 0, sector: 'x', industry: '' });
    const m = mergePortfolios([
      { holdings: [h(50)], dividends: [], cash: 1, historyReady: true },
      { holdings: [h(60)], dividends: [], cash: 2, historyReady: true },
    ], null, TODAY);
    expect([m.holdings[0].shares, m.holdings[0].avgCost, m.cash]).toEqual([20, 55, 3]);
  });
});
