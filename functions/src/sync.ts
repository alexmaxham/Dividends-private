// Per-user sync: pull every linked login from Plaid, merge, and write the user's portfolio document.

import type { Firestore } from 'firebase-admin/firestore';
import { mergePortfolios, Plaid, PlaidError, type ItemData } from './plaid.js';

export const REAUTH_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT']);
const HISTORY_SNAPSHOTS = 3 * 365;
const LOCK_MS = 5 * 60 * 1000;
const MANUAL_COOLDOWN_MS = 60 * 1000;

export interface PlaidItemDoc {
  uid: string;
  accessToken: string;
  institution: string;
  institutionId: string | null;
  linkedAt: string;
  needsReauth: boolean;
}

/** Calendar date in New York, the market's time zone; used for "today" in history and day change. */
export function marketDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export class SyncError extends Error {}

/** Rebuild the browser-visible list of linked accounts (never includes access tokens). */
export async function refreshAccounts(db: Firestore, uid: string): Promise<void> {
  const items = await db.collection('plaidItems').where('uid', '==', uid).get();
  const accounts = items.docs
    .map((d) => {
      const it = d.data() as PlaidItemDoc;
      return { itemId: d.id, institution: it.institution, linkedAt: it.linkedAt, needsReauth: !!it.needsReauth };
    })
    .sort((a, b) => a.linkedAt.localeCompare(b.linkedAt));
  await db.doc(`users/${uid}`).set({ accounts }, { merge: true });
}

export async function syncUser(db: Firestore, plaid: Plaid, uid: string, opts: { manual?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const userRef = db.doc(`users/${uid}`);

  await db.runTransaction(async (tx) => {
    const sync = (await tx.get(userRef)).data()?.sync ?? {};
    if (sync.syncing && now.getTime() - Date.parse(sync.startedAt ?? 0) < LOCK_MS) throw new SyncError('A sync is already running.');
    if (opts.manual && sync.lastSync && now.getTime() - Date.parse(sync.lastSync) < MANUAL_COOLDOWN_MS) {
      throw new SyncError('Synced less than a minute ago. Try again shortly.');
    }
    tx.set(userRef, { sync: { ...sync, syncing: true, startedAt: now.toISOString() } }, { merge: true });
  });

  const finish = (fields: Record<string, unknown>) => userRef.set({ sync: { syncing: false, ...fields } }, { merge: true });

  try {
    const items = await db.collection('plaidItems').where('uid', '==', uid).get();
    if (items.empty) throw new SyncError('Link an account first.');
    const today = marketDate(now);
    const parts: ItemData[] = [];
    const problems: string[] = [];
    let loading = false;
    for (const doc of items.docs) {
      const it = doc.data() as PlaidItemDoc;
      try {
        const part = await plaid.fetchItem(it.accessToken, today);
        parts.push(part);
        loading ||= !part.historyReady;
        if (it.needsReauth) await doc.ref.update({ needsReauth: false });
      } catch (e) {
        if (e instanceof PlaidError && e.code && REAUTH_CODES.has(e.code)) {
          await doc.ref.update({ needsReauth: true });
          problems.push(`${it.institution} needs you to sign in again (Settings → Reconnect).`);
          continue;
        }
        throw e;
      }
    }
    await refreshAccounts(db, uid);
    if (!parts.length) throw new SyncError(problems.join(' ') || 'No linked accounts returned data.');
    if (loading) problems.push("Plaid is still gathering your dividend history; it'll appear in a few minutes.");

    const portfolioRef = db.doc(`users/${uid}/portfolio/current`);
    const previous = (await portfolioRef.get()).data();
    const merged = mergePortfolios(parts, previous, today);
    const value = merged.holdings.reduce((s, h) => s + h.shares * h.price, 0);
    const cost = merged.holdings.reduce((s, h) => s + h.shares * h.avgCost, 0);
    const history = ((previous?.history ?? []) as { date: string }[]).filter((s) => s.date !== today);
    history.push({ date: today, value: round2(value), cost: round2(cost) } as { date: string });
    const portfolio = { ...merged, history: history.slice(-HISTORY_SNAPSHOTS), source: 'plaid', syncedAt: now.toISOString() };
    await portfolioRef.set(portfolio);
    await finish({
      lastSync: now.toISOString(),
      lastError: problems.join(' ') || null,
      retryAt: loading ? new Date(now.getTime() + 10 * 60 * 1000).toISOString() : null,
    });
    return portfolio;
  } catch (e) {
    await finish({ lastError: (e as Error).message, retryAt: null });
    throw e;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
