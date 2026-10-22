// Dividend taxes for one year: qualified vs ordinary, an estimated federal bill, and a 1099-DIV preview.
// Only dividends in taxable accounts count; IRAs, 401(k)s and HSAs don't get a 1099-DIV for dividends.

import { isReceived } from './analytics';
import { taxTreatment } from './accounts';
import type { Account, Dividend, Holding, HoldingStats, Payout } from './types';

/** REITs, BDCs, bond and option-income funds mostly pay ordinary (non-qualified) dividends. */
const ORDINARY_SECTOR = /real estate|reit|bond|fixed income|money market/i;
const ORDINARY_NAME = /\b(reit|realty|bdc|premium income|covered call|option income|treasury|bond|money market|preferred)\b/i;

/** Best guess for a dividend the brokerage didn't classify. */
export function likelyQualified(h: Pick<Holding, 'sector' | 'name'> | undefined): boolean {
  if (!h) return true;
  return !ORDINARY_SECTOR.test(h.sector) && !ORDINARY_NAME.test(h.name);
}

export interface TaxLine {
  symbol: string;
  qualified: number;
  ordinary: number;
  withheld: number;
  /** True when some of it is our guess rather than the brokerage's label. */
  guessed: boolean;
}

export interface Form1099 {
  institution: string;
  /** Box 1a: total ordinary dividends (includes the qualified ones). */
  box1a: number;
  /** Box 1b: qualified dividends. */
  box1b: number;
  /** Box 7: foreign tax paid. */
  box7: number;
}

export interface TaxYear {
  year: string;
  qualified: number;
  ordinary: number;
  /** Of the above, how much was classified by guess. */
  guessed: number;
  withheld: number;
  /** Paid into tax-advantaged accounts: not taxed this year. */
  sheltered: number;
  /** Federal estimate: qualified × qualified rate + ordinary × ordinary rate − foreign tax credit. */
  estimatedTax: number;
  lines: TaxLine[];
  forms: Form1099[];
}

export interface Rates { qualified: number; ordinary: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

export function taxYear(dividends: Dividend[], holdings: Pick<Holding, 'symbol' | 'sector' | 'name'>[], accounts: Account[], year: string, today: string, rates: Rates): TaxYear {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const holdingBy = new Map(holdings.map((h) => [h.symbol, h]));
  const lines = new Map<string, TaxLine>();
  const forms = new Map<string, Form1099>();
  let sheltered = 0;
  for (const d of dividends) {
    if (!isReceived(d) || !d.payDate.startsWith(year) || d.payDate > today) continue;
    const account = d.account ? accountById.get(d.account) : undefined;
    if (taxTreatment(account?.subtype) !== 'yearly') { sheltered += d.amount; continue; }
    const q = d.qualified ?? likelyQualified(holdingBy.get(d.symbol));
    const line = lines.get(d.symbol) ?? { symbol: d.symbol, qualified: 0, ordinary: 0, withheld: 0, guessed: false };
    if (q) line.qualified += d.amount; else line.ordinary += d.amount;
    line.withheld += d.withholding ?? 0;
    line.guessed ||= d.qualified === undefined;
    lines.set(d.symbol, line);
    const institution = account?.institution ?? 'Your brokerage';
    const form = forms.get(institution) ?? { institution, box1a: 0, box1b: 0, box7: 0 };
    form.box1a += d.amount;
    if (q) form.box1b += d.amount;
    form.box7 += d.withholding ?? 0;
    forms.set(institution, form);
  }
  const all = [...lines.values()];
  const qualified = all.reduce((s, l) => s + l.qualified, 0);
  const ordinary = all.reduce((s, l) => s + l.ordinary, 0);
  const withheld = all.reduce((s, l) => s + l.withheld, 0);
  const guessed = dividends.filter((d) => isReceived(d) && d.payDate.startsWith(year) && d.payDate <= today && d.qualified === undefined
    && taxTreatment(d.account ? accountById.get(d.account)?.subtype : undefined) === 'yearly').reduce((s, d) => s + d.amount, 0);
  const estimatedTax = Math.max(0, qualified * (rates.qualified / 100) + ordinary * (rates.ordinary / 100) - withheld);
  return {
    year, qualified: r2(qualified), ordinary: r2(ordinary), guessed: r2(guessed), withheld: r2(withheld), sheltered: r2(sheltered),
    estimatedTax: r2(estimatedTax),
    lines: all.map((l) => ({ ...l, qualified: r2(l.qualified), ordinary: r2(l.ordinary), withheld: r2(l.withheld) }))
      .sort((a, b) => b.qualified + b.ordinary - (a.qualified + a.ordinary)),
    forms: [...forms.values()].map((f) => ({ ...f, box1a: r2(f.box1a), box1b: r2(f.box1b), box7: r2(f.box7) })),
  };
}

/** Expected taxable dividends for the rest of `year`, from upcoming payouts and the share held in taxable accounts. */
export function taxableStillToCome(payouts: Payout[], holdings: HoldingStats[], accounts: Account[], year: string, rates: Rates): { amount: number; tax: number } {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  let amount = 0;
  let tax = 0;
  for (const p of payouts) {
    if (!p.date.startsWith(year)) continue;
    const h = holdings.find((x) => x.symbol === p.symbol);
    if (!h) continue;
    const taxableShares = h.lots?.length
      ? h.lots.filter((l) => taxTreatment(accountById.get(l.account)?.subtype) === 'yearly').reduce((s, l) => s + l.shares, 0)
      : h.shares;
    const part = h.shares ? (p.amount * taxableShares) / h.shares : 0;
    amount += part;
    tax += part * ((likelyQualified(h) ? rates.qualified : rates.ordinary) / 100);
  }
  return { amount: r2(amount), tax: r2(tax) };
}
