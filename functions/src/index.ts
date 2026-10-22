// Cloud Functions for Dividends: Plaid Link, manual sync, account deletion, the scheduled daily sync, and market data.
//
// Secrets (set once with `firebase functions:secrets:set NAME`): PLAID_CLIENT_ID, PLAID_SECRET, and the optional
// MARKET_API_KEY (Massive / Polygon.io) and FINNHUB_API_KEY. An optional secret set to "none" leaves that feature off.
// Parameters (asked on first deploy, or in functions/.env): PLAID_ENV = sandbox | production, MARKET_API_BASE,
// MARKET_CALLS_PER_MINUTE.

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineInt, defineSecret, defineString } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { Plaid, PlaidError, type PlaidEnv } from './plaid.js';
import { Finnhub, Massive, MarketError, validSymbol } from './market.js';
import { lookupSymbol as lookup, refreshMarket, refreshQuotes } from './marketSync.js';
import { refreshAccounts, SyncError, syncUser, type PlaidItemDoc } from './sync.js';

initializeApp();
const db = getFirestore();

const PLAID_CLIENT_ID = defineSecret('PLAID_CLIENT_ID');
const PLAID_SECRET = defineSecret('PLAID_SECRET');
const PLAID_ENV = defineString('PLAID_ENV', { default: 'sandbox', description: 'Plaid environment: sandbox or production' });
const PLAID_REDIRECT_URI = defineString('PLAID_REDIRECT_URI', { default: '', description: 'Optional OAuth redirect URI registered with Plaid' });

const MARKET_API_KEY = defineSecret('MARKET_API_KEY');
const FINNHUB_API_KEY = defineSecret('FINNHUB_API_KEY');
const MARKET_API_BASE = defineString('MARKET_API_BASE', { default: 'https://api.massive.com', description: 'Massive / Polygon.io API host' });
const MARKET_CALLS_PER_MINUTE = defineInt('MARKET_CALLS_PER_MINUTE', { default: 5, description: 'Market data calls allowed per minute (5 on the free plan)' });

const secrets = [PLAID_CLIENT_ID, PLAID_SECRET];
/** An optional secret's value, or '' when it was left as the "none" placeholder. */
const optional = (v: string) => (v && v.trim() !== 'none' ? v.trim() : '');
const opts = { secrets, region: 'us-central1', enforceAppCheck: false };

function plaid(): Plaid {
  return new Plaid(PLAID_CLIENT_ID.value(), PLAID_SECRET.value(), PLAID_ENV.value() as PlaidEnv, fetch, PLAID_REDIRECT_URI.value() || undefined);
}

function massive(): Massive | null {
  const key = optional(MARKET_API_KEY.value());
  return key ? new Massive(key, { base: MARKET_API_BASE.value(), callsPerMinute: MARKET_CALLS_PER_MINUTE.value() }) : null;
}

function requireUser(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  return req.auth.uid;
}

/** Turn Plaid and sync failures into messages the app can show. */
function toHttps(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof SyncError) return new HttpsError('failed-precondition', e.message);
  if (e instanceof MarketError) {
    logger.warn('Market data error', { status: e.status, message: e.message });
    return new HttpsError(e.status === 404 ? 'not-found' : e.status === 429 ? 'resource-exhausted' : 'unavailable', e.message);
  }
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

// ───────────── Market data ─────────────

/** Announced dividends, ex-dividend dates, splits and closing prices. Before the 6:30 sync, then every 2 hours to catch up. */
export const marketRefresh = onSchedule(
  { schedule: '5 */2 * * *', timeZone: 'America/New_York', secrets: [MARKET_API_KEY], timeoutSeconds: 540, region: 'us-central1' },
  async () => {
    const api = massive();
    if (!api) return;
    // Leave a minute of the 9-minute limit spare.
    const result = await refreshMarket(db, api, { maxCalls: Math.max(1, MARKET_CALLS_PER_MINUTE.value() * 8) });
    logger.info('Market refresh', result);
  },
);

/** One symbol's dividends and price, for the watchlist and what-if. */
export const lookupSymbol = onCall({ secrets: [MARKET_API_KEY], region: 'us-central1', timeoutSeconds: 120 }, async (req) => {
  requireUser(req);
  const symbol = (req.data as { symbol?: unknown })?.symbol;
  if (!validSymbol(symbol)) throw new HttpsError('invalid-argument', 'Enter a ticker symbol, like SCHD.');
  const api = massive();
  if (!api) throw new HttpsError('failed-precondition', "Market data isn't set up yet.");
  try {
    return await lookup(db, api, symbol);
  } catch (e) {
    throw toHttps(e);
  }
});

/** Prices during the day for the caller's symbols (cached for a minute across everyone). */
export const quotes = onCall({ secrets: [FINNHUB_API_KEY], region: 'us-central1' }, async (req) => {
  requireUser(req);
  const token = optional(FINNHUB_API_KEY.value());
  if (!token) return { quotes: {}, enabled: false };
  const raw = (req.data as { symbols?: unknown })?.symbols;
  const symbols = [...new Set((Array.isArray(raw) ? raw : []).filter(validSymbol).map((s) => s.toUpperCase()))].slice(0, 60);
  try {
    return { quotes: await refreshQuotes(db, new Finnhub(token), symbols), enabled: true };
  } catch (e) {
    throw toHttps(e);
  }
});
