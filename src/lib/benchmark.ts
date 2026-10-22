// Total return, dividends included, compared with a benchmark fund.
//
// Portfolio: time-weighted return from the daily value history. Each day's change is adjusted for money added or
// taken out (the change in invested cost), and cash dividends count as return. Reinvested dividends show up as both
// a dividend and a purchase, so they cancel out and the value itself carries them.
// Benchmark: its daily closes with each dividend reinvested on the ex-dividend date.

import { isReceived } from './analytics';
import type { Dividend, MarketInfo, Snapshot } from './types';

export interface Comparison {
  dates: string[];
  /** Cumulative return in percent at each date. */
  portfolio: number[];
  benchmark: number[];
}

export function compareWithBenchmark(history: Snapshot[], dividends: Dividend[], bench: MarketInfo | undefined, from: string): Comparison | null {
  const closes = bench?.closes ?? [];
  const snaps = history.filter((h) => h.date >= from && h.value > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (snaps.length < 2 || closes.length < 2) return null;
  // Benchmark total-return index on each trading day.
  const exDivs = new Map<string, number>();
  for (const d of bench?.dividends ?? []) exDivs.set(d.exDate, (exDivs.get(d.exDate) ?? 0) + d.amount);
  const tr: { date: string; index: number }[] = [];
  let index = 1;
  closes.forEach((c, i) => {
    if (i > 0) index *= (c.close + (exDivs.get(c.date) ?? 0)) / closes[i - 1].close;
    tr.push({ date: c.date, index });
  });
  const benchAt = (date: string) => {
    let lo = 0, hi = tr.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (tr[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans >= 0 ? tr[ans].index : null;
  };
  // Start where both series have data.
  const start = snaps.findIndex((s) => benchAt(s.date) !== null);
  if (start < 0 || start >= snaps.length - 1) return null;
  const days = snaps.slice(start);
  const cash = dividends.filter((d) => isReceived(d) && !d.drip);
  const base = benchAt(days[0].date)!;
  const dates = [days[0].date];
  const portfolio = [0];
  const benchmark = [0];
  let growth = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1], cur = days[i];
    const flow = cur.cost - prev.cost;
    const paid = cash.filter((d) => d.payDate > prev.date && d.payDate <= cur.date).reduce((s, d) => s + d.amount, 0);
    const r = (cur.value - flow + paid) / prev.value - 1;
    if (Number.isFinite(r) && Math.abs(r) < 0.5) growth *= 1 + r; // skip broken days (a missing account, say)
    dates.push(cur.date);
    portfolio.push((growth - 1) * 100);
    benchmark.push((benchAt(cur.date)! / base - 1) * 100);
  }
  return { dates, portfolio, benchmark };
}
