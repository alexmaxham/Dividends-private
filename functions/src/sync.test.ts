// syncUser against the Firestore emulator with a fake Plaid: npm run test:emulator
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Plaid } from './plaid.js';
import { syncUser } from './sync.js';

const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
let app: App;
let db: Firestore;

const HOLDINGS = {
  accounts: [{ account_id: 'a1', type: 'investment' }],
  securities: [{ security_id: 's-ko', ticker_symbol: 'KO', name: 'Coca-Cola', type: 'equity' }],
  holdings: [{ account_id: 'a1', security_id: 's-ko', quantity: 10, institution_price: 70, cost_basis: 500 }],
};
const TX = [{ investment_transaction_id: 't1', account_id: 'a1', security_id: 's-ko', date: '2026-10-01', type: 'cash', subtype: 'dividend', amount: -5.1 }];

function fakePlaid(errors: Record<string, Record<string, string>> = {}) {
  return new Plaid('cid', 'sec', 'sandbox', async (_url, init) => {
    const path = _url.replace('https://sandbox.plaid.com', '');
    const body = JSON.parse(init.body);
    const reply = (status: number, v: unknown) => ({ status, text: async () => JSON.stringify(v) });
    const err = errors[body.access_token]?.[path];
    if (err) return reply(400, { error_code: err, error_message: err });
    if (path === '/investments/holdings/get') return reply(200, HOLDINGS);
    if (path === '/investments/transactions/get') return reply(200, { investment_transactions: TX, securities: [], total_investment_transactions: 1 });
    return reply(404, {});
  });
}

describe.runIf(emulator)('syncUser', () => {
  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-dividends' }, 'sync-test');
    db = getFirestore(app);
  });
  afterAll(() => app && deleteApp(app));
  beforeEach(async () => {
    await db.recursiveDelete(db.collection('users'));
    await db.recursiveDelete(db.collection('plaidItems'));
    await db.doc('plaidItems/i1').set({ uid: 'u1', accessToken: 'good', institution: 'Robinhood', institutionId: 'ins_54', linkedAt: '2026-10-01T00:00:00Z', needsReauth: false });
  });

  it('writes the portfolio, history and linked accounts', async () => {
    await syncUser(db, fakePlaid(), 'u1', { now: new Date('2026-10-21T15:00:00Z') });
    const p = (await db.doc('users/u1/portfolio/current').get()).data()!;
    expect(p.source).toBe('plaid');
    expect(p.holdings[0]).toMatchObject({ symbol: 'KO', shares: 10, avgCost: 50 });
    expect(p.dividends[0]).toMatchObject({ amount: 5.1, rate: 0.51 });
    expect(p.history).toEqual([{ date: '2026-10-21', value: 700, cost: 500, byAccount: { a1: { value: 700, cost: 500 } } }]);
    expect(p.accounts).toEqual([{ id: 'a1', name: 'Investment account', mask: null, subtype: 'brokerage', institution: 'Robinhood' }]);
    const user = (await db.doc('users/u1').get()).data()!;
    expect(user.accounts).toEqual([{ itemId: 'i1', institution: 'Robinhood', linkedAt: '2026-10-01T00:00:00Z', needsReauth: false }]);
    expect(user.accounts[0].accessToken).toBeUndefined();
    expect(user.sync).toMatchObject({ syncing: false, lastError: null, lastSync: '2026-10-21T15:00:00.000Z' });
  });

  it('flags a login that needs reconnecting and keeps syncing the others', async () => {
    await db.doc('plaidItems/i2').set({ uid: 'u1', accessToken: 'expired', institution: 'Fidelity', institutionId: null, linkedAt: '2026-10-02T00:00:00Z', needsReauth: false });
    await syncUser(db, fakePlaid({ expired: { '/investments/holdings/get': 'ITEM_LOGIN_REQUIRED' } }), 'u1');
    const user = (await db.doc('users/u1').get()).data()!;
    expect(user.accounts.map((a: { needsReauth: boolean }) => a.needsReauth)).toEqual([false, true]);
    expect(user.sync.lastError).toMatch(/Fidelity needs you to sign in again/);
    expect((await db.doc('users/u1/portfolio/current').get()).data()!.holdings).toHaveLength(1);
  });

  it('skips a link Plaid no longer recognizes and keeps syncing the others', async () => {
    await db.doc('plaidItems/i2').set({ uid: 'u1', accessToken: 'sandbox-old', institution: 'First Platypus Bank', institutionId: null, linkedAt: '2026-10-02T00:00:00Z', needsReauth: false });
    await syncUser(db, fakePlaid({ 'sandbox-old': { '/investments/holdings/get': 'INVALID_ACCESS_TOKEN' } }), 'u1');
    const user = (await db.doc('users/u1').get()).data()!;
    expect(user.sync.lastError).toMatch(/First Platypus Bank is no longer connected/);
    expect((await db.doc('users/u1/portfolio/current').get()).data()!.holdings).toHaveLength(1);
  });

  it('rate-limits manual syncs and blocks overlapping ones', async () => {
    const now = new Date('2026-10-21T15:00:00Z');
    await syncUser(db, fakePlaid(), 'u1', { now });
    await expect(syncUser(db, fakePlaid(), 'u1', { manual: true, now: new Date(now.getTime() + 20_000) })).rejects.toThrow(/less than a minute/);
    await db.doc('users/u1').set({ sync: { syncing: true, startedAt: now.toISOString() } }, { merge: true });
    await expect(syncUser(db, fakePlaid(), 'u1', { now: new Date(now.getTime() + 60_000) })).rejects.toThrow(/already running/);
  });

  it('corrects per-share rates from market data', async () => {
    await db.doc('market/KO').set({ symbol: 'KO', dividends: [{ exDate: '2026-09-12', payDate: '2026-10-01', amount: 0.255 }], splits: [] });
    await syncUser(db, fakePlaid(), 'u1', { now: new Date('2026-10-21T15:00:00Z') });
    const p = (await db.doc('users/u1/portfolio/current').get()).data()!;
    expect(p.dividends[0]).toMatchObject({ amount: 5.1, rate: 0.255, shares: 20 });
    await db.doc('market/KO').delete();
  });

  it("only reads the caller's own linked logins", async () => {
    await db.doc('plaidItems/other').set({ uid: 'u2', accessToken: 'other', institution: 'Schwab', institutionId: null, linkedAt: '2026-10-03T00:00:00Z', needsReauth: false });
    await syncUser(db, fakePlaid(), 'u1');
    const user = (await db.doc('users/u1').get()).data()!;
    expect(user.accounts.map((a: { institution: string }) => a.institution)).toEqual(['Robinhood']);
  });
});
