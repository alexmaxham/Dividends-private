// Market data jobs against the Firestore emulator with a fake Massive and Finnhub: npm run test:emulator
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Finnhub, Massive } from './market.js';
import { lookupSymbol, refreshMarket, refreshQuotes, trackedSymbols } from './marketSync.js';

const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
let app: App;
let db: Firestore;

function fakeMassive() {
  const paths: string[] = [];
  const api = new Massive('key', {
    callsPerMinute: 6000,
    sleep: async () => {},
    fetcher: async (url) => {
      const u = new URL(url);
      paths.push(u.pathname + (u.searchParams.get('ticker') ? `?${u.searchParams.get('ticker')}` : ''));
      const reply = (v: unknown, status = 200) => ({ status, text: async () => JSON.stringify(v) });
      if (u.searchParams.get('ticker') === 'NOPE') return reply({ results: [] });
      if (u.pathname === '/stocks/v1/dividends' && u.searchParams.get('ticker')) {
        return reply({ results: [{ ticker: u.searchParams.get('ticker'), ex_dividend_date: '2026-09-12', pay_date: '2026-10-01', cash_amount: 0.51, frequency: 4 }] });
      }
      if (u.pathname === '/stocks/v1/dividends') {
        return reply({ results: [{ ticker: 'KO', ex_dividend_date: '2026-11-28', pay_date: '2026-12-15', cash_amount: 0.53, frequency: 4 }, { ticker: 'ZZZ', ex_dividend_date: '2026-11-01', cash_amount: 1 }] });
      }
      if (u.pathname === '/stocks/v1/splits') return reply({ results: [{ ticker: 'KO', execution_date: '2025-01-02', split_from: 1, split_to: 2 }] });
      if (u.pathname === '/v2/aggs/grouped/locale/us/market/stocks/2026-10-20') return reply({ results: [{ T: 'KO', c: 71.5 }, { T: 'SPY', c: 650 }] });
      if (u.pathname.startsWith('/v2/aggs/ticker/') && u.pathname.includes('/range/')) return reply({ results: [{ t: Date.parse('2026-10-20'), c: 650 }] });
      if (u.pathname === '/v3/reference/tickers/VYM') return reply({ results: { name: 'Vanguard High Dividend Yield ETF', type: 'ETF' } });
      if (u.pathname === '/v2/aggs/ticker/VYM/prev') return reply({ results: [{ c: 140.2, t: Date.parse('2026-10-20') }] });
      return reply({ status: 'NOT_FOUND' }, 404);
    },
  });
  return { api, paths };
}

describe.runIf(emulator)('market jobs', () => {
  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-dividends' }, 'market-test');
    db = getFirestore(app);
  });
  afterAll(() => app && deleteApp(app));
  beforeEach(async () => {
    await db.recursiveDelete(db.collection('market'));
    await db.recursiveDelete(db.collection('users'));
  });

  it('collects held and watched symbols plus the benchmarks', async () => {
    await db.doc('users/u1').set({ settings: { watchlist: ['VYM'] } });
    await db.doc('users/u1/portfolio/current').set({ holdings: [{ symbol: 'KO' }] });
    expect((await trackedSymbols(db)).sort()).toEqual(['KO', 'SCHD', 'SPY', 'VYM']);
  });

  it('runs the daily sweeps once, then fills in history', async () => {
    const { api, paths } = fakeMassive();
    const now = new Date('2026-10-21T10:00:00Z');
    const r = await refreshMarket(db, api, { now, symbols: ['KO', 'SPY'] });
    expect(r.sweeps).toEqual(['dividends', 'splits', 'closes', 'benchmarks']);
    expect(r.histories.sort()).toEqual(['KO', 'SCHD', 'SPY']); // the benchmarks always come along
    const ko = (await db.doc('market/KO').get()).data()!;
    expect(ko.dividends.map((d: { exDate: string }) => d.exDate)).toEqual(['2026-11-28', '2026-09-12']);
    expect(ko.splits).toEqual([{ date: '2025-01-02', ratio: 2 }]);
    expect([ko.close, ko.closeDate]).toEqual([71.5, '2026-10-20']);
    expect((await db.doc('market/SPY').get()).data()!.closes).toEqual([{ date: '2026-10-20', close: 650 }]);
    expect((await db.doc('market/ZZZ').get()).exists).toBe(false); // nobody holds it

    const before = paths.length;
    const again = await refreshMarket(db, api, { now: new Date('2026-10-21T12:00:00Z'), symbols: ['KO', 'SPY'] });
    expect(again).toMatchObject({ sweeps: [], histories: [], calls: 0 });
    expect(paths.length).toBe(before);
  });

  it('stops at the call budget and resumes next run', async () => {
    const { api } = fakeMassive();
    const now = new Date('2026-10-21T10:00:00Z');
    await db.doc('market/_meta').set({ dividendsOn: '2026-10-21', splitsOn: '2026-10-21', closesOn: '2026-10-21', benchmarksOn: '2026-10-21' });
    const r = await refreshMarket(db, api, { now, symbols: ['A', 'B', 'C'], maxCalls: 2 });
    expect([r.histories.length, r.pending]).toEqual([2, 1]);
    const next = await refreshMarket(db, api, { now, symbols: ['A', 'B', 'C'], maxCalls: 2 });
    expect([next.histories.length, next.pending]).toEqual([1, 0]);
  });

  it('looks up a new symbol and caches it', async () => {
    const { api, paths } = fakeMassive();
    const now = new Date('2026-10-21T10:00:00Z');
    const doc = await lookupSymbol(db, api, 'vym', now);
    expect(doc).toMatchObject({ symbol: 'VYM', name: 'Vanguard High Dividend Yield ETF', sector: 'ETF', close: 140.2 });
    const n = paths.length;
    await lookupSymbol(db, api, 'VYM', now);
    expect(paths.length).toBe(n);
    await expect(lookupSymbol(db, api, 'NOPE', now)).rejects.toThrow(/Couldn't find NOPE/);
  });

  it('shares quotes for a minute', async () => {
    let calls = 0;
    const f = new Finnhub('t', async () => { calls++; return { status: 200, text: async () => JSON.stringify({ c: 71.2, pc: 70.9, t: 1793000000 }) }; });
    const now = new Date('2026-10-21T15:00:00Z');
    expect((await refreshQuotes(db, f, ['KO'], now)).KO.price).toBe(71.2);
    await refreshQuotes(db, f, ['KO'], new Date(now.getTime() + 30_000));
    expect(calls).toBe(1);
    await refreshQuotes(db, f, ['KO'], new Date(now.getTime() + 90_000));
    expect(calls).toBe(2);
  });
});
