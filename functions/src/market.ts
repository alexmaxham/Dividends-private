// Market data: announced dividends, ex-dividend dates, splits and closing prices from Massive (formerly Polygon.io),
// and prices during the day from Finnhub. Everything lands in shared market/{SYMBOL} documents that any signed-in
// person can read, so each symbol is fetched once no matter how many people hold it.
//
// Massive's free plan allows 5 calls a minute, so the client spaces its calls out and the daily job does
// market-wide sweeps (one call covers every ticker) instead of one call per symbol where it can.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;
type Fetch = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

export interface MarketDividend {
  exDate: string;
  payDate: string | null;
  recordDate?: string | null;
  declared?: string | null;
  /** Cash per share. */
  amount: number;
  /** Payments a year as announced (12, 4, 2, 1); null when not given. */
  frequency?: number | null;
  /** One-off extras that shouldn't set the regular rate. */
  special?: boolean;
}

export interface MarketSplit {
  date: string;
  /** New shares per old share: 2 for a 2-for-1 split, 0.1 for a 1-for-10 reverse split. */
  ratio: number;
}

export interface Quote {
  price: number;
  prevClose: number;
  at: string;
}

export interface MarketDoc {
  symbol: string;
  name?: string;
  sector?: string;
  dividends: MarketDividend[];
  splits: MarketSplit[];
  close?: number;
  closeDate?: string;
  quote?: Quote;
  /** Daily closes, kept only for the benchmark funds. */
  closes?: { date: string; close: number }[];
  /** When this symbol's own dividend history was last fetched. */
  historyAt?: string;
  updatedAt: string;
}

export class MarketError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export const BENCHMARKS = ['SPY', 'SCHD'];
const DAY = 86400000;

export const docId = (symbol: string) => symbol.toUpperCase().replace(/\//g, '_');
const isTicker = (s: string) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s);
export const validSymbol = (s: unknown): s is string => typeof s === 'string' && isTicker(s.toUpperCase());

export interface MarketOptions {
  base?: string;
  callsPerMinute?: number;
  fetcher?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Massive / Polygon.io REST client. Spaces calls to stay under the plan's per-minute limit. */
export class Massive {
  readonly base: string;
  private gap: number;
  private last: number | null = null;
  calls = 0;
  private fetcher: Fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(private apiKey: string, o: MarketOptions = {}) {
    this.base = (o.base || 'https://api.massive.com').replace(/\/$/, '');
    this.gap = 60000 / Math.max(1, o.callsPerMinute ?? 5);
    this.fetcher = o.fetcher ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  async get(pathOrUrl: string, params: Record<string, string | number> = {}): Promise<Json> {
    const wait = this.last === null ? 0 : this.last + this.gap - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
    this.calls++;
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : this.base + pathOrUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set('apiKey', this.apiKey);
    const res = await this.fetcher(url.toString());
    let data: Json;
    try {
      data = JSON.parse((await res.text()) || '{}');
    } catch {
      throw new MarketError(`Market data returned an unreadable response (HTTP ${res.status})`, res.status);
    }
    if (res.status === 429) throw new MarketError('Market data is busy. Try again in a minute.', 429);
    if (res.status >= 400 || data.status === 'ERROR' || data.status === 'NOT_AUTHORIZED') {
      throw new MarketError(data.error || data.message || `Market data returned HTTP ${res.status}`, res.status);
    }
    return data;
  }

  /** Follows next_url pagination, up to maxPages calls. */
  async paged(path: string, params: Record<string, string | number>, maxPages = 6): Promise<Json[]> {
    const out: Json[] = [];
    let data = await this.get(path, params);
    for (let page = 1; ; page++) {
      out.push(...(data.results ?? []));
      if (!data.next_url || page >= maxPages) return out;
      data = await this.get(data.next_url);
    }
  }

  /** One symbol's recent dividends, newest first (the free plan covers two years). */
  async dividendsFor(symbol: string): Promise<MarketDividend[]> {
    const rows = await this.paged('/stocks/v1/dividends', { ticker: symbol, sort: 'ex_dividend_date.desc', limit: 100 }, 1);
    return rows.map(toDividend).filter((d): d is MarketDividend => !!d);
  }

  /** Every ticker's dividends with an ex-dividend date on or after `from`, including newly announced ones. */
  async dividendsSince(from: string): Promise<Map<string, MarketDividend[]>> {
    const rows = await this.paged('/stocks/v1/dividends', { 'ex_dividend_date.gte': from, sort: 'ex_dividend_date.asc', limit: 5000 });
    return groupRows(rows, toDividend);
  }

  /** Every split executed (or scheduled) on or after `from`. */
  async splitsSince(from: string): Promise<Map<string, MarketSplit[]>> {
    const rows = await this.paged('/stocks/v1/splits', { 'execution_date.gte': from, sort: 'execution_date.asc', limit: 5000 });
    return groupRows(rows, toSplit);
  }

  /** Closing price of every US stock on one day; empty on weekends and holidays. */
  async closesOn(date: string): Promise<Map<string, number>> {
    const data = await this.get(`/v2/aggs/grouped/locale/us/market/stocks/${date}`, { adjusted: 'true' });
    return new Map((data.results ?? []).filter((r: Json) => r.T && r.c > 0).map((r: Json) => [String(r.T).toUpperCase(), Number(r.c)]));
  }

  async dailyCloses(symbol: string, from: string, to: string): Promise<{ date: string; close: number }[]> {
    const data = await this.get(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}`, { adjusted: 'true', sort: 'asc', limit: 50000 });
    return (data.results ?? []).filter((r: Json) => r.c > 0).map((r: Json) => ({ date: new Date(r.t).toISOString().slice(0, 10), close: Number(r.c) }));
  }

  async details(symbol: string): Promise<{ name?: string; sector?: string; close?: number; closeDate?: string }> {
    const notFound = (e: unknown): Json => { if (e instanceof MarketError && e.status === 404) return {}; throw e; };
    const d = await this.get(`/v3/reference/tickers/${encodeURIComponent(symbol)}`).catch(notFound);
    const prev = await this.get(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`, { adjusted: 'true' }).catch(notFound);
    const r = d.results ?? {};
    const p = (prev.results ?? [])[0];
    return {
      name: r.name || undefined, sector: r.sic_description ? titleCase(r.sic_description) : r.type === 'ETF' ? 'ETF' : undefined,
      close: p?.c > 0 ? Number(p.c) : undefined, closeDate: p?.t ? new Date(p.t).toISOString().slice(0, 10) : undefined,
    };
  }
}

/** Finnhub: real-time US quotes (free plan: 60 calls a minute). */
export class Finnhub {
  constructor(private token: string, private fetcher: Fetch = fetch, private base = 'https://finnhub.io/api/v1') {}

  async quote(symbol: string, now = new Date()): Promise<Quote | null> {
    const res = await this.fetcher(`${this.base}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(this.token)}`);
    if (res.status === 429) throw new MarketError('Quotes are busy. Try again in a minute.', 429);
    if (res.status >= 400) throw new MarketError(`Quotes returned HTTP ${res.status}`, res.status);
    const q = JSON.parse((await res.text()) || '{}');
    if (!(q.c > 0)) return null; // unknown symbol
    return { price: Number(q.c), prevClose: Number(q.pc) || Number(q.c), at: (q.t ? new Date(q.t * 1000) : now).toISOString() };
  }
}

// ───────────── Parsing ─────────────

function toDividend(r: Json): MarketDividend | null {
  const amount = Number(r.cash_amount);
  if (!r.ex_dividend_date || !(amount > 0)) return null;
  const kind = String(r.dividend_type ?? r.distribution_type ?? '').toLowerCase();
  const d: MarketDividend = {
    exDate: r.ex_dividend_date, payDate: r.pay_date || null, recordDate: r.record_date || null,
    declared: r.declaration_date || null, amount, frequency: Number(r.frequency) > 0 ? Number(r.frequency) : null,
  };
  if (kind === 'sc' || kind.includes('special') || kind.includes('supplemental')) d.special = true;
  return d;
}

function toSplit(r: Json): MarketSplit | null {
  const from = Number(r.split_from), to = Number(r.split_to);
  if (!r.execution_date || !(from > 0) || !(to > 0)) return null;
  return { date: r.execution_date, ratio: to / from };
}

function groupRows<T>(rows: Json[], parse: (r: Json) => T | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const v = parse(r);
    if (!v || !r.ticker) continue;
    const t = String(r.ticker).toUpperCase();
    if (!out.has(t)) out.set(t, []);
    out.get(t)!.push(v);
  }
  return out;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** Newest first, one entry per ex-dividend date (and per special/regular), newer data winning. */
export function mergeDividends(old: MarketDividend[], fresh: MarketDividend[], keepFrom: string): MarketDividend[] {
  const by = new Map<string, MarketDividend>();
  for (const d of [...old, ...fresh]) by.set(`${d.exDate}|${d.special ? 's' : 'r'}`, d);
  return [...by.values()].filter((d) => d.exDate >= keepFrom).sort((a, b) => b.exDate.localeCompare(a.exDate));
}

export function mergeSplits(old: MarketSplit[], fresh: MarketSplit[]): MarketSplit[] {
  const by = new Map<string, MarketSplit>();
  for (const s of [...old, ...fresh]) by.set(s.date, s);
  return [...by.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// ───────────── Fixing per-share rates in synced dividends ─────────────

interface SyncedDividend { symbol: string; amount: number; rate: number; shares: number; payDate: string }

/**
 * Plaid reports only the dollar amount of each dividend, so the share count is rebuilt from trades. Where market data
 * has the announced per-share amount for the same payment, use it (that also corrects for splits). Otherwise, for a
 * split the brokerage didn't report, scale the rebuilt share count back to what it was before the split.
 */
export function reconcileDividends<T extends SyncedDividend>(dividends: T[], market: Map<string, Pick<MarketDoc, 'dividends' | 'splits'>>, reportedSplits: Set<string>): T[] {
  return dividends.map((d) => {
    const m = market.get(d.symbol);
    if (!m) return d;
    const sameDay = (m.dividends ?? []).filter((x) => x.payDate && Math.abs(Date.parse(x.payDate) - Date.parse(d.payDate)) <= 4 * DAY);
    const rate = sameDay.reduce((s, x) => s + x.amount, 0);
    if (rate > 0) {
      const shares = d.amount / rate;
      // A mismatch this large means it's a different payment (or a partial one); leave the rebuilt figures alone.
      if (!d.shares || (shares / d.shares > 0.05 && shares / d.shares < 20)) return { ...d, rate: round(rate, 6), shares: round(shares, 6) };
      return d;
    }
    if (reportedSplits.has(d.symbol) || !d.shares) return d;
    const factor = (m.splits ?? []).filter((s) => s.date > d.payDate && s.ratio > 0).reduce((f, s) => f * s.ratio, 1);
    if (factor === 1) return d;
    const shares = d.shares / factor;
    return { ...d, shares: round(shares, 6), rate: round(d.amount / shares, 6) };
  });
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

// ───────────── Dates ─────────────

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The most recent weekday before `today` (holidays come back empty and the caller steps back again). */
export function previousWeekday(today: string): string {
  let t = Date.parse(`${today}T00:00:00Z`) - DAY;
  while ([0, 6].includes(new Date(t).getUTCDay())) t -= DAY;
  return isoDay(t);
}
