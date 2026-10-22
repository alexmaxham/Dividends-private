// Cloud Functions for Dividends: Plaid Link, manual sync, account deletion, and the scheduled daily sync.
//
// Secrets (set once with `firebase functions:secrets:set NAME`): PLAID_CLIENT_ID, PLAID_SECRET.
// Parameters (asked on first deploy, or in functions/.env): PLAID_ENV = sandbox | production.

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { Plaid, PlaidError, type PlaidEnv } from './plaid.js';
import { refreshAccounts, SyncError, syncUser, type PlaidItemDoc } from './sync.js';

initializeApp();
const db = getFirestore();

const PLAID_CLIENT_ID = defineSecret('PLAID_CLIENT_ID');
const PLAID_SECRET = defineSecret('PLAID_SECRET');
const PLAID_ENV = defineString('PLAID_ENV', { default: 'sandbox', description: 'Plaid environment: sandbox or production' });
const PLAID_REDIRECT_URI = defineString('PLAID_REDIRECT_URI', { default: '', description: 'Optional OAuth redirect URI registered with Plaid' });

const secrets = [PLAID_CLIENT_ID, PLAID_SECRET];
const opts = { secrets, region: 'us-central1', enforceAppCheck: false };

function plaid(): Plaid {
  return new Plaid(PLAID_CLIENT_ID.value(), PLAID_SECRET.value(), PLAID_ENV.value() as PlaidEnv, fetch, PLAID_REDIRECT_URI.value() || undefined);
}

function requireUser(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  return req.auth.uid;
}

/** Turn Plaid and sync failures into messages the app can show. */
function toHttps(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof SyncError) return new HttpsError('failed-precondition', e.message);
  if (e instanceof PlaidError) {
    logger.warn('Plaid error', { code: e.code, status: e.status, message: e.message });
    return new HttpsError('failed-precondition', e.message, { code: e.code });
  }
  logger.error(e);
  return new HttpsError('internal', 'Something went wrong. Try again.');
}

async function ownedItem(uid: string, itemId: unknown) {
  if (typeof itemId !== 'string' || !itemId) throw new HttpsError('invalid-argument', 'Missing itemId.');
  const snap = await db.doc(`plaidItems/${itemId}`).get();
  if (!snap.exists || snap.data()?.uid !== uid) throw new HttpsError('not-found', "That account isn't linked.");
  return snap;
}

export const plaidLinkToken = onCall(opts, async (req) => {
  const uid = requireUser(req);
  try {
    const itemId = (req.data as { itemId?: string })?.itemId;
    const access = itemId ? ((await ownedItem(uid, itemId)).data() as PlaidItemDoc).accessToken : undefined;
    return { linkToken: await plaid().linkToken(uid, access), env: PLAID_ENV.value() };
  } catch (e) {
    throw toHttps(e);
  }
});

export const plaidExchange = onCall(opts, async (req) => {
  const uid = requireUser(req);
  const { publicToken, institution } = (req.data ?? {}) as { publicToken?: string; institution?: { name?: string; institution_id?: string } | null };
  if (!publicToken) throw new HttpsError('invalid-argument', 'Missing publicToken.');
  try {
    const p = plaid();
    const { accessToken, itemId } = await p.exchange(publicToken);
    const item: PlaidItemDoc = {
      uid, accessToken, institution: institution?.name || 'Brokerage', institutionId: institution?.institution_id ?? null,
      linkedAt: new Date().toISOString(), needsReauth: false,
    };
    await db.doc(`plaidItems/${itemId}`).set(item);
    await refreshAccounts(db, uid);
    try {
      await syncUser(db, p, uid);
    } catch (e) {
      logger.warn('First sync after linking failed', e); // recorded on the user's sync status
    }
    return { itemId };
  } catch (e) {
    throw toHttps(e);
  }
});

/** After Link's update mode fixes a login: clear the flag and sync. */
export const plaidRepaired = onCall(opts, async (req) => {
  const uid = requireUser(req);
  const snap = await ownedItem(uid, (req.data as { itemId?: string })?.itemId);
  await snap.ref.update({ needsReauth: false });
  await refreshAccounts(db, uid);
  try {
    await syncUser(db, plaid(), uid);
  } catch (e) {
    logger.warn('Sync after reconnect failed', e);
  }
  return { ok: true };
});

export const plaidUnlink = onCall(opts, async (req) => {
  const uid = requireUser(req);
  const snap = await ownedItem(uid, (req.data as { itemId?: string })?.itemId);
  try {
    await plaid().remove((snap.data() as PlaidItemDoc).accessToken);
  } catch (e) {
    logger.warn('Plaid item/remove failed; forgetting the item anyway', e);
  }
  await snap.ref.delete();
  await refreshAccounts(db, uid);
  return { ok: true };
});

export const syncNow = onCall({ ...opts, timeoutSeconds: 120 }, async (req) => {
  const uid = requireUser(req);
  try {
    await syncUser(db, plaid(), uid, { manual: true });
    return { ok: true };
  } catch (e) {
    throw toHttps(e);
  }
});

/** Deletes everything stored for the caller (revoking Plaid access first), then their sign-in. */
export const deleteAccount = onCall(opts, async (req) => {
  const uid = requireUser(req);
  const items = await db.collection('plaidItems').where('uid', '==', uid).get();
  const p = items.empty ? null : plaid();
  for (const doc of items.docs) {
    try {
      await p!.remove((doc.data() as PlaidItemDoc).accessToken);
    } catch (e) {
      logger.warn('Plaid item/remove failed during account deletion', e);
    }
    await doc.ref.delete();
  }
  await db.recursiveDelete(db.doc(`users/${uid}`));
  await getAuth().deleteUser(uid);
  return { ok: true };
});

/** Every morning, after Plaid's overnight refresh of investment data. */
export const dailySync = onSchedule(
  { schedule: '30 6 * * *', timeZone: 'America/New_York', secrets, timeoutSeconds: 540, memory: '512MiB', region: 'us-central1' },
  async () => {
    const items = await db.collection('plaidItems').select('uid').get();
    const uids = [...new Set(items.docs.map((d) => d.get('uid') as string))];
    const p = plaid();
    let ok = 0;
    for (let i = 0; i < uids.length; i += 5) {
      const results = await Promise.allSettled(uids.slice(i, i + 5).map((uid) => syncUser(db, p, uid)));
      ok += results.filter((r) => r.status === 'fulfilled').length;
    }
    logger.info(`Daily sync: ${ok}/${uids.length} users updated`);
  },
);

/** Picks up users whose dividend history was still loading at Plaid on their last sync. */
export const retrySync = onSchedule(
  { schedule: 'every 15 minutes', secrets, timeoutSeconds: 300, region: 'us-central1' },
  async () => {
    const due = await db.collection('users').where('sync.retryAt', '<=', new Date().toISOString()).limit(50).get();
    const p = plaid();
    await Promise.allSettled(due.docs.map((d) => syncUser(db, p, d.id)));
  },
);
