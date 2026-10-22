// Watchlist and what-if: what a symbol pays, and what adding money to it would do to your income.

import { addMonths, computeStats, dividendPattern, monthKey, projectPayouts, regularDividends } from './analytics';
import type { Frequency, Holding, Market, MarketInfo, Portfolio } from './types';

export interface SymbolSummary {
  symbol: string;
  name: string;
  price: number;
  /** Day change in percent, when there's a quote. */
  change: number | null;
  annualPerShare: number;
  yieldPct: number;
  frequency: Frequency;
  growth: number | null;
  nextEx: { exDate: string; payDate: string | null; amount: number } | null;
}

export function symbolPrice(info: MarketInfo | undefined, held?: Pick<Holding, 'price'>): number {
  return info?.quote?.price || held?.price || info?.close || 0;
}

export function symbolSummary(info: MarketInfo, today: string, held?: Holding): SymbolSummary {
  const price = symbolPrice(info, held);
  const h: Holding = held ?? { symbol: info.symbol, name: info.name ?? info.symbol, shares: 0, avgCost: 0, price, prevClose: price, dividendYield: 0, sector: info.sector ?? 'Other' };
  const pat = dividendPattern({ ...h, price }, [], today, info);
  const next = regularDividends(info).find((d) => d.exDate >= today) ?? null;
  const q = info.quote;
  return {
    symbol: info.symbol, name: info.name ?? h.name, price,
    change: q && q.prevClose ? (q.price / q.prevClose - 1) * 100 : null,
    annualPerShare: pat.annualPerShare, yieldPct: price ? (pat.annualPerShare / price) * 100 : 0,
    frequency: pat.frequency, growth: pat.growth,
    nextEx: next ? { exDate: next.exDate, payDate: next.payDate, amount: next.amount } : null,
  };
}

export interface WhatIf {
  shares: number;
  price: number;
  incomeBefore: number;
  incomeAfter: number;
  yieldBefore: number;
  yieldAfter: number;
  /** Next 12 months: income you already expect, and what the purchase adds, per month. */
  months: { month: string; before: number; added: number }[];
}

/** Buying `amount` dollars of `symbol` today at its current price. */
export function whatIf(p: Portfolio, market: Market, today: string, symbol: string, amount: number): WhatIf | null {
  const info = market[symbol];
  const held = p.holdings.find((h) => h.symbol === symbol);
  const price = symbolPrice(info, held);
  if (!(price > 0) || !(amount > 0)) return null;
  const shares = amount / price;
  const holdings = held
    ? p.holdings.map((h) => (h.symbol === symbol ? { ...h, shares: h.shares + shares, avgCost: (h.avgCost * h.shares + amount) / (h.shares + shares) } : h))
    : [...p.holdings, { symbol, name: info?.name ?? symbol, shares, avgCost: price, price, prevClose: price, dividendYield: 0, sector: info?.sector ?? 'Other' }];
  const before = computeStats(p, today, market);
  const after = computeStats({ ...p, holdings }, today, market);
  const sum = (payouts: { date: string; amount: number }[]) => {
    const by = new Map<string, number>();
    for (const x of payouts) by.set(monthKey(x.date), (by.get(monthKey(x.date)) ?? 0) + x.amount);
    return by;
  };
  const b = sum(projectPayouts(before.holdings, p.dividends, today, 12, market));
  const a = sum(projectPayouts(after.holdings, p.dividends, today, 12, market));
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = monthKey(addMonths(`${today.slice(0, 7)}-01`, i));
    const before = b.get(m) ?? 0;
    return { month: m, before, added: Math.max(0, (a.get(m) ?? 0) - before) };
  });
  return {
    shares, price, incomeBefore: before.totals.annualIncome, incomeAfter: after.totals.annualIncome,
    yieldBefore: before.totals.currentYield, yieldAfter: after.totals.currentYield, months,
  };
}
