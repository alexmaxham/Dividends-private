// Keeps market/{SYMBOL} documents current for every symbol someone holds or watches, plus the benchmark funds.

import type { Firestore } from 'firebase-admin/firestore';
import {
  BENCHMARKS, docId, Finnhub, isoDay, Massive, MarketError, mergeDividends, mergeSplits, previousWeekday,
  type MarketDoc, type Quote,
} from './market.js';

const DAY = 86400000;
const KEEP_DAYS = 3 * 365; // dividend history kept per symbol
const HISTORY_REFRESH_DAYS = 30; // the daily sweep catches new announcements; full history is re-read monthly
const QUOTE_TTL_MS = 60 * 1000;

/** Every symbol held in a portfolio or on a watchlist. */
export async function trackedSymbols(db: Firestore): Promise<string[]> {
  const [portfolios, users] = await Promise.all([
    db.collectionGroup('portfolio').select('holdings').get(),
    db.collection('users').select('settings.watchlist').get(),
  ]);
  const out = new Set<string>(BENCHMARKS);
  for (const p of portfolios.docs) for (const h of (p.get('holdings') ?? []) as { symbol?: string }[]) if (h.symbol) out.add(h.symbol.toUpperCase());
  for (const u of users.docs) for (const s of (u.get('settings.watchlist') ?? []) as string[]) if (typeof s === 'string') out.add(s.toUpperCase());
  return [...out].filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s));
}

export interface RefreshResult { calls: number; sweeps: string[]; histories: string[]; pending: number }

/**
 * Runs the day's market-wide sweeps once (announced dividends, splits, closing prices, benchmark history), then
 * fills in per-symbol dividend history, stalest first, until it reaches `maxCalls`. Safe to run often: anything
 * already done today is skipped, and what didn't fit is picked up next run.
 */
export async function refreshMarket(db: Firestore, api: Massive, opts: { now?: Date; maxCalls?: number; symbols?: string[] } = {}): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  const today = isoDay(now.getTime());
  const maxCalls = opts.maxCalls ?? 40;
  const symbols = opts.symbols ?? (await trackedSymbols(db));
  const metaRef = db.doc('market/_meta');
  const meta = (await metaRef.get()).data() ?? {};
  const snaps = symbols.length ? await db.getAll(...symbols.map((s) => db.doc(`market/${docId(s)}`))) : [];
  const docs = new Map<string, MarketDoc>(symbols.map((s, i) => [s, (snaps[i].data() as MarketDoc) ?? { symbol: s, dividends: [], splits: [], updatedAt: '' }]));
  const changed = new Set<string>();
  const sweeps: string[] = [];
  const keepFrom = isoDay(now.getTime() - KEEP_DAYS * DAY);
  const start = api.calls;
  const budget = () => maxCalls - (api.calls - start);

  try {
    if (meta.dividendsOn !== today && budget() >= 6) {
      const fresh = await api.dividendsSince(isoDay(now.getTime() - 10 * DAY));
      for (const [sym, doc] of docs) {
        const f = fresh.get(sym);
        if (f?.length) { doc.dividends = mergeDividends(doc.dividends ?? [], f, keepFrom); changed.add(sym); }
      }
      meta.dividendsOn = today;
      sweeps.push('dividends');
    }
    if (meta.splitsOn !== today && budget() >= 6) {
      const splits = await api.splitsSince(isoDay(now.getTime() - 730 * DAY));
      for (const [sym, doc] of docs) {
        const f = splits.get(sym);
        if (f?.length) { doc.splits = mergeSplits(doc.splits ?? [], f); changed.add(sym); }
      }
      meta.splitsOn = today;
      sweeps.push('splits');
    }
    if (meta.closesOn !== today && budget() >= 4) {
      // Yesterday's closes; step back over holidays, which come back empty.
      let day = previousWeekday(today);
      let closes = await api.closesOn(day);
      for (let tries = 1; tries < 3 && !closes.size; tries++) closes = await api.closesOn((day = previousWeekday(day)));
      for (const [sym, doc] of docs) {
        const c = closes.get(sym);
        if (c) { doc.close = c; doc.closeDate = day; changed.add(sym); }
      }
      meta.closesOn = today;
      sweeps.push('closes');
    }
    if (meta.benchmarksOn !== today && budget() >= BENCHMARKS.length + 1) {
      for (const b of BENCHMARKS) {
        const doc = docs.get(b) ?? { symbol: b, dividends: [], splits: [], updatedAt: '' };
        doc.closes = await api.dailyCloses(b, isoDay(now.getTime() - 729 * DAY), today);
        docs.set(b, doc);
        changed.add(b);
      }
      meta.benchmarksOn = today;
      sweeps.push('benchmarks');
    }

    const cutoff = isoDay(now.getTime() - HISTORY_REFRESH_DAYS * DAY);
    const stale = [...docs.values()].filter((d) => !d.historyAt || d.historyAt < cutoff)
      .sort((a, b) => (a.historyAt ?? '').localeCompare(b.historyAt ?? ''));
    const histories: string[] = [];
    for (const doc of stale) {
      if (budget() < 1) break;
      try {
        doc.dividends = mergeDividends(doc.dividends ?? [], await api.dividendsFor(doc.symbol), keepFrom);
      } catch (e) {
        if (e instanceof MarketError && e.status === 429) break;
        if (!(e instanceof MarketError && e.status === 404)) throw e;
      }
      doc.historyAt = today;
      changed.add(doc.symbol);
      histories.push(doc.symbol);
    }
    return { calls: api.calls - start, sweeps, histories, pending: stale.length - histories.length };
  } finally {
    await writeDocs(db, docs, changed, now);
    await metaRef.set(meta, { merge: true });
  }
}

async function writeDocs(db: Firestore, docs: Map<string, MarketDoc>, changed: Set<string>, now: Date) {
  const list = [...changed];
  for (let i = 0; i < list.length; i += 400) {
    const batch = db.batch();
    for (const sym of list.slice(i, i + 400)) {
      const d = docs.get(sym)!;
      batch.set(db.doc(`market/${docId(sym)}`), { ...d, symbol: sym, updatedAt: now.toISOString() });
    }
    await batch.commit();
  }
}

/** One symbol, fetched now if it isn't already known (for the watchlist and what-if). */
export async function lookupSymbol(db: Firestore, api: Massive, symbol: string, now = new Date()): Promise<MarketDoc> {
  const sym = symbol.toUpperCase();
  const ref = db.doc(`market/${docId(sym)}`);
  const cur = (await ref.get()).data() as MarketDoc | undefined;
  const today = isoDay(now.getTime());
  if (cur?.historyAt && cur.close && cur.name && Date.parse(cur.historyAt) > now.getTime() - 7 * DAY) return cur;
  const dividends = await api.dividendsFor(sym);
  const details = await api.details(sym);
  if (!details.close && !dividends.length) throw new MarketError(`Couldn't find ${sym}.`, 404);
  const doc: MarketDoc = {
    ...(cur ?? { splits: [] }), symbol: sym,
    dividends: mergeDividends(cur?.dividends ?? [], dividends, isoDay(now.getTime() - KEEP_DAYS * DAY)),
    splits: cur?.splits ?? [], historyAt: today, updatedAt: now.toISOString(),
  };
  if (details.name) doc.name = details.name;
  if (details.sector) doc.sector = details.sector;
  if (details.close) { doc.close = details.close; doc.closeDate = details.closeDate; }
  await ref.set(doc);
  return doc;
}

/** Quotes for these symbols, reusing any fetched in the last minute (by anyone). */
export async function refreshQuotes(db: Firestore, finnhub: Finnhub, symbols: string[], now = new Date()): Promise<Record<string, Quote>> {
  const refs = symbols.map((s) => db.doc(`market/${docId(s)}`));
  const snaps = refs.length ? await db.getAll(...refs) : [];
  const out: Record<string, Quote> = {};
  const stale: number[] = [];
  snaps.forEach((s, i) => {
    const q = s.get('quote') as Quote | undefined;
    const fetchedAt = s.get('quoteFetchedAt') as string | undefined;
    if (q && fetchedAt && now.getTime() - Date.parse(fetchedAt) < QUOTE_TTL_MS) out[symbols[i]] = q;
    else stale.push(i);
  });
  const fetched = await Promise.allSettled(stale.map((i) => finnhub.quote(symbols[i], now)));
  const batch = db.batch();
  fetched.forEach((r, k) => {
    const i = stale[k];
    if (r.status !== 'fulfilled' || !r.value) return;
    out[symbols[i]] = r.value;
    batch.set(refs[i], { symbol: symbols[i], quote: r.value, quoteFetchedAt: now.toISOString() }, { merge: true });
  });
  await batch.commit();
  return out;
}
