import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearReconnectNotice, deliver, detectEvents, reconnectEvent, weeklySummary, type NotifyEvent } from './notify.js';

const TODAY = '2026-10-21';
const KO = { symbol: 'KO', shares: 40 };
const paid = (id: string, symbol: string, amount: number, payDate = '2026-10-20') => ({ id, symbol, amount, payDate, state: 'paid' });

describe('detectEvents', () => {
  it('announces new payments, but not on the first sync', () => {
    const next = { holdings: [KO], dividends: [paid('a', 'KO', 21.2), paid('old', 'KO', 20, '2026-07-01')] };
    expect(detectEvents(undefined, next, new Map(), TODAY)).toEqual([]);
    const events = detectEvents({ dividends: [paid('old', 'KO', 20, '2026-07-01')] }, next, new Map(), TODAY);
    expect(events).toEqual([{ kind: 'payments', key: 'pay:a', title: 'KO paid you $21.20', body: 'Dividend received Oct 20.' }]);
  });

  it('rolls many payments into one', () => {
    const next = { holdings: [], dividends: ['A', 'B', 'C', 'D'].map((s, i) => paid(s, s, i + 1)) };
    const [e] = detectEvents({ dividends: [] }, next, new Map(), TODAY);
    expect(e.title).toBe('4 dividends paid you $10.00');
    expect(e.body).toBe('D $4.00, C $3.00, B $2.00, A $1.00');
  });

  it('announces a raise or cut just declared', () => {
    const market = new Map([['KO', { dividends: [
      { exDate: '2026-11-28', payDate: '2026-12-15', declared: '2026-10-16', amount: 0.53, frequency: 4 },
      { exDate: '2026-09-12', payDate: '2026-10-01', amount: 0.51, frequency: 4 },
    ] }]]);
    const [e] = detectEvents(undefined, { holdings: [KO], dividends: [] }, market, TODAY);
    expect(e).toMatchObject({ kind: 'raises', key: 'div:KO:2026-11-28', title: 'KO raised its dividend 3.9%' });
    expect(e.body).toBe('$0.51 → $0.53 a share, starting with the Dec 15 payment. About $3.20 a year more for your 40 shares.');
    // Declared a month ago: old news.
    expect(detectEvents(undefined, { holdings: [KO], dividends: [] }, market, '2026-11-20')).toEqual([]);
  });

  it('summarizes the week', () => {
    const market = new Map([['KO', { dividends: [{ exDate: '2026-10-10', payDate: '2026-10-25', amount: 0.53 }] }]]);
    const e = weeklySummary({ holdings: [KO], dividends: [paid('a', 'KO', 21.2), paid('b', 'PEP', 26.64, '2026-10-16')] }, market, TODAY)!;
    expect(e.title).toBe('Your week in dividends: $47.84');
    expect(e.body).toBe('This week: $47.84 from 2 payments (PEP, KO). Next week: $21.20 declared from KO.');
    expect(weeklySummary({ holdings: [], dividends: [] }, new Map(), TODAY)).toBeNull();
  });
});

const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
let app: App;
let db: Firestore;

describe.runIf(emulator)('deliver', () => {
  const sent: string[] = [];
  const pushed: string[] = [];
  const senders = {
    email: async (to: string, subject: string) => { sent.push(`${to}: ${subject}`); },
    push: async (sub: { endpoint: string }, payload: string) => {
      if (sub.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      pushed.push(JSON.parse(payload).title);
    },
  };
  const who = { email: 'a@example.com', emailVerified: true };
  const pay: NotifyEvent = { kind: 'payments', key: 'pay:1', title: 'KO paid you $21.20', body: '' };

  beforeAll(() => {
    app = initializeApp({ projectId: 'demo-dividends' }, 'notify-test');
    db = getFirestore(app);
  });
  afterAll(() => app && deleteApp(app));
  beforeEach(async () => {
    sent.length = 0;
    pushed.length = 0;
    for (const c of ['users', 'notifyLog', 'pushSubs']) await db.recursiveDelete(db.collection(c));
  });

  it('sends each event once, by email by default', async () => {
    expect(await deliver(db, 'u1', [pay], who, senders)).toEqual(['pay:1']);
    expect(await deliver(db, 'u1', [pay], who, senders)).toEqual([]);
    expect(sent).toEqual(['a@example.com: KO paid you $21.20']);
  });

  it('respects topic and channel switches, and skips unverified emails', async () => {
    await db.doc('users/u1').set({ settings: { notify: { payments: false } } });
    expect(await deliver(db, 'u1', [pay], who, senders)).toEqual([]);
    await db.doc('users/u2').set({ settings: { notify: { email: true } } });
    expect(await deliver(db, 'u2', [pay], { email: 'b@example.com', emailVerified: false }, senders)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('pushes to each device and forgets ones that unsubscribed', async () => {
    await db.doc('users/u1').set({ settings: { notify: { email: false, push: true } } });
    await db.doc('pushSubs/s1').set({ uid: 'u1', subscription: { endpoint: 'https://push.example/ok', keys: {} } });
    await db.doc('pushSubs/s2').set({ uid: 'u1', subscription: { endpoint: 'https://push.example/gone', keys: {} } });
    await db.doc('pushSubs/s3').set({ uid: 'u2', subscription: { endpoint: 'https://push.example/other', keys: {} } });
    await deliver(db, 'u1', [pay], who, senders);
    expect(pushed).toEqual(['KO paid you $21.20']);
    expect((await db.doc('pushSubs/s2').get()).exists).toBe(false);
    expect((await db.doc('pushSubs/s3').get()).exists).toBe(true);
  });

  it('announces a broken login again after it was fixed', async () => {
    const e = reconnectEvent('item1', 'Robinhood');
    expect(e.title).toBe('Robinhood needs you to reconnect');
    await deliver(db, 'u1', [e], who, senders);
    await deliver(db, 'u1', [e], who, senders);
    await clearReconnectNotice(db, 'u1', 'item1');
    await deliver(db, 'u1', [e], who, senders);
    expect(sent).toHaveLength(2);
  });
});
