// Plaid client: Link tokens, token exchange, and investment holdings + dividends in the web app's shape.

export const HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' } as const;
export type PlaidEnv = keyof typeof HOSTS;

// Cash dividends. "dividend reinvestment" is the matching buy of new shares, not extra income.
const DIVIDEND_SUBTYPES = new Set(['dividend', 'qualified dividend', 'non-qualified dividend']);
// Tax taken out of a dividend (usually foreign tax on an overseas company's payout).
const WITHHOLDING_SUBTYPES = new Set(['tax withheld', 'non-resident tax']);
// Transactions that change a share count without being a buy or sell.
const SHARE_CHANGE_SUBTYPES = new Set(['split', 'stock distribution', 'transfer', 'send', 'spin off', 'merger']);
const HISTORY_DAYS = 730; // Plaid returns up to 24 months; older payments are kept from earlier syncs.

export interface Holding {
  symbol: string;
  name: string;
  shares: number;
  avgCost: number;
  price: number;
  prevClose: number;
  dividendYield: number;
  sector: string;
  industry: string;
  /** The same holding split by brokerage account; cost is the total cost basis in that account. */
  lots: Lot[];
}

export interface Lot {
  account: string;
  shares: number;
  cost: number;
}

/** One brokerage account (individual, Roth IRA, …) inside a linked login. */
export interface Account {
  id: string;
  name: string;
  mask: string | null;
  /** Plaid's investment account subtype: brokerage, roth, ira, 401k, hsa, … */
  subtype: string;
  institution: string;
}

export interface Dividend {
  id: string;
  symbol: string;
  amount: number;
  rate: number;
  shares: number;
  state: 'paid';
  payDate: string;
  account: string;
  /** From Plaid's subtype; absent when the brokerage only says "dividend". */
  qualified?: boolean;
  withholding?: number;
}

export interface ItemData {
  holdings: Holding[];
  dividends: Dividend[];
  accounts: Account[];
  cash: number;
  historyReady: boolean;
  /** Symbols with a split (or similar) reported by the brokerage, so market-data split fixes skip them. */
  splitSymbols: string[];
}

export class PlaidError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

export class Plaid {
  readonly base: string;

  constructor(private clientId: string, private secret: string, readonly env: PlaidEnv, private fetcher: Fetch = fetch, private redirectUri?: string) {
    if (!(env in HOSTS)) throw new Error(`PLAID_ENV must be one of ${Object.keys(HOSTS).join(', ')}`);
    this.base = HOSTS[env];
  }

  async call(path: string, body: Json): Promise<Json> {
    const res = await this.fetcher(this.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, secret: this.secret, ...body }),
    });
    let data: Json;
    try {
      data = JSON.parse((await res.text()) || '{}');
    } catch {
      throw new PlaidError(`Plaid returned an unreadable response (HTTP ${res.status})`, undefined, res.status);
    }
    if (res.status >= 400 || data.error_code) {
      throw new PlaidError(data.display_message || data.error_message || `Plaid returned HTTP ${res.status}`, data.error_code, res.status);
    }
    return data;
  }

  /** A token for Plaid Link. With accessToken, Link opens in update mode to repair a broken login. */
  async linkToken(userId: string, accessToken?: string): Promise<string> {
    const body: Json = { client_name: 'Dividends', language: 'en', country_codes: ['US'], user: { client_user_id: userId } };
    if (accessToken) body.access_token = accessToken;
    else body.products = ['investments'];
    if (this.redirectUri) body.redirect_uri = this.redirectUri;
    return (await this.call('/link/token/create', body)).link_token;
  }

  async exchange(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const d = await this.call('/item/public_token/exchange', { public_token: publicToken });
    return { accessToken: d.access_token, itemId: d.item_id };
  }

  async remove(accessToken: string): Promise<void> {
    await this.call('/item/remove', { access_token: accessToken });
  }

  async investmentTransactions(accessToken: string, today: string): Promise<{ transactions: Json[]; securities: Map<string, Json> }> {
    const start = addDays(today, -HISTORY_DAYS);
    const transactions: Json[] = [];
    const securities = new Map<string, Json>();
    for (;;) {
      const page = await this.call('/investments/transactions/get', {
        access_token: accessToken, start_date: start, end_date: today, options: { count: 500, offset: transactions.length },
      });
      const batch: Json[] = page.investment_transactions ?? [];
      transactions.push(...batch);
      for (const s of page.securities ?? []) securities.set(s.security_id, s);
      if (!batch.length || transactions.length >= (page.total_investment_transactions ?? 0)) return { transactions, securities };
    }
  }

  /**
   * Holdings, cash dividends and cash for one linked login. Plaid has no per-share dividend rate or announced
   * dividends, so each payment's share count is rebuilt from the buys and sells after it.
   */
  async fetchItem(accessToken: string, today: string, institution = 'Brokerage'): Promise<ItemData> {
    const h = await this.call('/investments/holdings/get', { access_token: accessToken });
    const securities = new Map<string, Json>((h.securities ?? []).map((s: Json) => [s.security_id, s]));
    const investment = (h.accounts ?? []).filter((a: Json) => a.type === 'investment');
    const accountIds = new Set<string>(investment.map((a: Json) => a.account_id));
    const accounts: Account[] = investment.map((a: Json) => ({
      id: a.account_id, name: a.name || a.official_name || 'Investment account', mask: a.mask ?? null,
      subtype: String(a.subtype ?? 'brokerage').toLowerCase(), institution,
    }));

    const holdings = new Map<string, { h: Holding; costBasis: number }>();
    // Shares of each security in each account, for rebuilding share counts on past pay dates.
    const qty = new Map<string, number>();
    const key = (account: string, security: string) => `${account}|${security}`;
    let cash = 0;
    for (const x of h.holdings ?? []) {
      if (!accountIds.has(x.account_id)) continue;
      const sec = securities.get(x.security_id) ?? {};
      const q = num(x.quantity);
      if (sec.is_cash_equivalent || sec.type === 'cash') {
        cash += num(x.institution_value) || q;
        continue;
      }
      if (sec.type === 'derivative' || q <= 0) continue;
      const symbol = String(sec.ticker_symbol || sec.name || '?').toUpperCase();
      qty.set(key(x.account_id, x.security_id), (qty.get(key(x.account_id, x.security_id)) ?? 0) + q);
      const price = num(x.institution_price) || num(sec.close_price);
      let cur = holdings.get(symbol);
      if (!cur) {
        cur = {
          h: { symbol, name: sec.name || symbol, shares: 0, avgCost: 0, price, prevClose: price, dividendYield: 0,
            sector: sec.sector || sectorForType(sec.type), industry: sec.industry || '', lots: [] },
          costBasis: 0,
        };
        holdings.set(symbol, cur);
      }
      const cost = x.cost_basis != null ? num(x.cost_basis) : q * price;
      cur.h.shares += q;
      cur.costBasis += cost;
      const lot = cur.h.lots.find((l) => l.account === x.account_id);
      if (lot) { lot.shares += q; lot.cost += cost; } else cur.h.lots.push({ account: x.account_id, shares: q, cost });
    }

    let tx: { transactions: Json[]; securities: Map<string, Json> };
    let historyReady = true;
    try {
      tx = await this.investmentTransactions(accessToken, today);
    } catch (e) {
      if (!(e instanceof PlaidError) || e.code !== 'PRODUCT_NOT_READY') throw e;
      tx = { transactions: [], securities: new Map() };
      historyReady = false;
    }
    for (const [k, v] of tx.securities) securities.set(k, v);
    const symbolOf = (t: Json) => {
      const sec = securities.get(t.security_id ?? '') ?? {};
      return String(sec.ticker_symbol || sec.name || symbolFromName(t.name) || '?').toUpperCase();
    };

    const changes = tx.transactions.filter((t) => t.security_id && num(t.quantity) !== 0
      && (t.type === 'buy' || t.type === 'sell' || SHARE_CHANGE_SUBTYPES.has(String(t.subtype ?? '').toLowerCase())));
    const splitSymbols = [...new Set(tx.transactions
      .filter((t) => ['split', 'stock distribution'].includes(String(t.subtype ?? '').toLowerCase())).map(symbolOf))];
    const dividends: Dividend[] = [];
    const withheld: Json[] = [];
    for (const t of tx.transactions) {
      if (!accountIds.has(t.account_id)) continue;
      const subtype = String(t.subtype ?? '').toLowerCase();
      if (WITHHOLDING_SUBTYPES.has(subtype)) withheld.push(t);
      if (!DIVIDEND_SUBTYPES.has(subtype)) continue;
      const amount = Math.abs(num(t.amount));
      if (amount <= 0) continue;
      const shares = sharesOn(t.account_id, t.security_id, t.date, qty, changes);
      const d: Dividend = {
        id: `plaid-${t.investment_transaction_id}`, symbol: symbolOf(t), amount: round(amount, 2),
        rate: shares > 0 ? round(amount / shares, 6) : 0, shares: round(shares, 6), state: 'paid', payDate: t.date, account: t.account_id,
      };
      if (subtype !== 'dividend') d.qualified = subtype === 'qualified dividend';
      dividends.push(d);
    }
    // Withholding is its own transaction; attach it to the dividend it came out of.
    for (const t of withheld) {
      const symbol = symbolOf(t);
      const d = dividends.filter((x) => x.account === t.account_id && x.symbol === symbol && Math.abs(daysBetween(x.payDate, t.date)) <= 5)
        .sort((a, b) => Math.abs(daysBetween(a.payDate, t.date)) - Math.abs(daysBetween(b.payDate, t.date)))[0];
      if (d) d.withholding = round((d.withholding ?? 0) + Math.abs(num(t.amount)), 2);
    }

    const out = [...holdings.values()]
      .map(({ h, costBasis }) => ({
        ...h, shares: round(h.shares, 6), avgCost: h.shares ? round(costBasis / h.shares, 4) : 0,
        lots: h.lots.map((l) => ({ ...l, shares: round(l.shares, 6), cost: round(l.cost, 2) })),
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    return { holdings: out, dividends, accounts, cash: round(cash, 2), historyReady, splitSymbols };
  }
}

export interface PortfolioCore {
  holdings: Holding[];
  dividends: (Dividend | Json)[];
  accounts: Account[];
  cash: number;
}

/**
 * Combine linked logins, keep dividends older than Plaid's 24-month window, and carry yesterday's price forward
 * as previous close so the day's change still works (Plaid only reports the latest price).
 */
export function mergePortfolios(parts: ItemData[], previous: Json | null | undefined, today: string): PortfolioCore {
  const bySymbol = new Map<string, Holding>();
  for (const p of parts) {
    for (const h of p.holdings) {
      const cur = bySymbol.get(h.symbol);
      if (!cur) bySymbol.set(h.symbol, { ...h, lots: [...(h.lots ?? [])] });
      else {
        const cost = cur.avgCost * cur.shares + h.avgCost * h.shares;
        cur.shares += h.shares;
        cur.avgCost = cur.shares ? round(cost / cur.shares, 4) : 0;
        cur.lots.push(...(h.lots ?? []));
      }
    }
  }
  const prev = previous ?? {};
  const prevHoldings = new Map<string, Json>((prev.holdings ?? []).map((h: Json) => [h.symbol, h]));
  const sameDay = String(prev.syncedAt ?? '').slice(0, 10) === today;
  for (const [sym, h] of bySymbol) {
    const p = prevHoldings.get(sym);
    if (p) h.prevClose = sameDay ? (p.prevClose ?? p.price) : p.price;
  }
  const fresh = new Map<string, Json>(parts.flatMap((p) => p.dividends).map((d) => [d.id, d]));
  const oldestFresh = [...fresh.values()].reduce((m, d) => (d.payDate < m ? d.payDate : m), today);
  const kept = (prev.dividends ?? []).filter((d: Json) => !fresh.has(d.id) && d.payDate < oldestFresh);
  const dividends = [...fresh.values(), ...kept].sort((a, b) => b.payDate.localeCompare(a.payDate));
  return {
    holdings: [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)),
    dividends,
    accounts: parts.flatMap((p) => p.accounts ?? []),
    cash: round(parts.reduce((s, p) => s + p.cash, 0), 2),
  };
}

/**
 * Shares held in an account on `date`: today's count minus what was added after it, plus what was removed after it
 * (sells and transfers out have negative quantities). Splits count as shares added on the split date.
 */
function sharesOn(account: string, securityId: string | undefined, date: string, current: Map<string, number>, changes: Json[]): number {
  if (!securityId) return 0;
  let q = current.get(`${account}|${securityId}`) ?? 0;
  for (const t of changes) if (t.account_id === account && t.security_id === securityId && t.date > date) q -= num(t.quantity);
  return Math.max(q, 0);
}

function symbolFromName(name: unknown): string | null {
  // e.g. "Dividend: KO" / "CASH DIV KO": last all-caps word as a fallback when Plaid gives no security.
  const words = String(name ?? '').replace(/:/g, ' ').split(/\s+/).reverse();
  return words.find((w) => /^[A-Z]{1,5}$/.test(w) && !['DIV', 'CASH', 'QUAL'].includes(w)) ?? null;
}

function sectorForType(kind: unknown): string {
  return ({ etf: 'ETF', 'mutual fund': 'Mutual fund', cryptocurrency: 'Crypto', 'fixed income': 'Bonds' } as Record<string, string>)[String(kind)] ?? 'Other';
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : v == null || v === '' ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
