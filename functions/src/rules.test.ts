// Firestore security rules, run against the emulator: npm run test:emulator
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
let env: RulesTestEnvironment;

describe.runIf(emulator)('firestore.rules', () => {
  beforeAll(async () => {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':');
    env = await initializeTestEnvironment({
      projectId: 'demo-dividends',
      firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host, port: Number(port) },
    });
  });
  afterAll(() => env?.cleanup());
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'users/alice'), { settings: { monthlyGoal: 500 } });
      await setDoc(doc(db, 'users/alice/portfolio/current'), { source: 'manual', holdings: [] });
      await setDoc(doc(db, 'users/linked'), { settings: {}, accounts: [{ itemId: 'i1', institution: 'Robinhood' }] });
      await setDoc(doc(db, 'users/linked/portfolio/current'), { source: 'plaid', holdings: [] });
      await setDoc(doc(db, 'plaidItems/i1'), { uid: 'linked', accessToken: 'access-secret' });
      await setDoc(doc(db, 'market/KO'), { symbol: 'KO', dividends: [] });
    });
  });

  const as = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

  it('lets people read only their own data', async () => {
    await assertSucceeds(getDoc(doc(as('alice'), 'users/alice')));
    await assertSucceeds(getDoc(doc(as('alice'), 'users/alice/portfolio/current')));
    await assertFails(getDoc(doc(as('bob'), 'users/alice')));
    await assertFails(getDoc(doc(as('bob'), 'users/alice/portfolio/current')));
    await assertFails(getDoc(doc(as(null), 'users/alice')));
  });

  it('shares market data with signed-in people, read-only', async () => {
    await assertSucceeds(getDoc(doc(as('alice'), 'market/KO')));
    await assertFails(getDoc(doc(as(null), 'market/KO')));
    await assertFails(setDoc(doc(as('alice'), 'market/KO'), { symbol: 'KO', dividends: [{ amount: 99 }] }));
  });

  it('never exposes Plaid access tokens', async () => {
    await assertFails(getDoc(doc(as('linked'), 'plaidItems/i1')));
    await assertFails(setDoc(doc(as('linked'), 'plaidItems/i2'), { uid: 'linked', accessToken: 'x' }));
  });

  it('allows settings changes but not sync status or linked accounts', async () => {
    await assertSucceeds(updateDoc(doc(as('alice'), 'users/alice'), { settings: { monthlyGoal: 750, taxRate: 15 } }));
    await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { settings: { monthlyGoal: -1 } }));
    await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { settings: { admin: true } }));
    await assertSucceeds(updateDoc(doc(as('alice'), 'users/alice'), {
      settings: { monthlyGoal: 750, taxRate: 15, ordinaryTaxRate: 24, watchlist: ['VYM', 'HD'], notify: { email: true, push: false, payments: true, raises: true, reconnect: true, weekly: false } },
    }));
    await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { settings: { notify: { email: 'yes' } } }));
    await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { settings: { notify: { sms: true } } }));
    await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { settings: { watchlist: Array.from({ length: 51 }, (_, i) => `S${i}`) } }));
    await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { accounts: [] }));
    await assertFails(updateDoc(doc(as('alice'), 'users/alice'), { sync: { lastSync: 'x' } }));
    await assertSucceeds(setDoc(doc(as('carol'), 'users/carol'), { settings: { monthlyGoal: 100 } }));
    await assertFails(setDoc(doc(as('dave'), 'users/dave'), { settings: {}, accounts: [{ itemId: 'fake' }] }));
  });

  it('allows manual portfolios only without a linked brokerage', async () => {
    await assertSucceeds(setDoc(doc(as('alice'), 'users/alice/portfolio/current'), { source: 'manual', holdings: [{ symbol: 'KO' }] }));
    await assertFails(setDoc(doc(as('alice'), 'users/alice/portfolio/current'), { source: 'plaid', holdings: [] }));
    await assertSucceeds(setDoc(doc(as('carol'), 'users/carol/portfolio/current'), { source: 'manual', holdings: [] }));
    await assertFails(setDoc(doc(as('linked'), 'users/linked/portfolio/current'), { source: 'manual', holdings: [] }));
    await assertFails(deleteDoc(doc(as('linked'), 'users/linked/portfolio/current')));
    await assertFails(setDoc(doc(as('bob'), 'users/alice/portfolio/current'), { source: 'manual', holdings: [] }));
  });
});
