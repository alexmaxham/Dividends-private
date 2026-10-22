// "Your year in dividends": a summary to read in the app, download as a page, or share.

import { addMonths, isReceived } from './analytics';
import { money, monthLong, monthShort, pct, signedPct } from './format';
import { milestones } from './milestones';
import type { Dividend, HoldingStats } from './types';

export interface YearReport {
  year: string;
  /** True for the year still in progress. */
  partial: boolean;
  total: number;
  previous: number;
  payments: number;
  companies: number;
  months: { month: string; amount: number }[];
  best: { month: string; amount: number } | null;
  top: { symbol: string; amount: number }[];
  raises: { symbol: string; growth: number }[];
  forwardIncome: number;
  yieldOnCost: number;
  covered: string[];
}

export function yearReport(dividends: Dividend[], holdings: HoldingStats[], totals: { annualIncome: number; yieldOnCost: number }, year: string, today: string): YearReport {
  const paid = dividends.filter((d) => isReceived(d) && d.payDate.startsWith(year) && d.payDate <= today);
  const total = paid.reduce((s, d) => s + d.amount, 0);
  const previous = dividends.filter((d) => isReceived(d) && d.payDate.startsWith(String(Number(year) - 1))).reduce((s, d) => s + d.amount, 0);
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = addMonths(`${year}-01-01`, i).slice(0, 7);
    return { month, amount: paid.filter((d) => d.payDate.startsWith(month)).reduce((s, d) => s + d.amount, 0) };
  });
  const bySymbol = new Map<string, number>();
  for (const d of paid) bySymbol.set(d.symbol, (bySymbol.get(d.symbol) ?? 0) + d.amount);
  const best = months.reduce<YearReport['best']>((b, m) => (m.amount > (b?.amount ?? 0) ? m : b), null);
  const thisYear = year === today.slice(0, 4);
  return {
    year, partial: thisYear, total, previous, payments: paid.length, companies: bySymbol.size, months, best,
    top: [...bySymbol].map(([symbol, amount]) => ({ symbol, amount })).sort((a, b) => b.amount - a.amount).slice(0, 5),
    // Raises over the last year are only meaningful for the current year.
    raises: thisYear ? holdings.filter((h) => (h.growth ?? 0) >= 0.5).map((h) => ({ symbol: h.symbol, growth: h.growth! })).sort((a, b) => b.growth - a.growth) : [],
    forwardIncome: totals.annualIncome, yieldOnCost: totals.yieldOnCost,
    covered: milestones(totals.annualIncome / 12).list.filter((m) => m.covered).map((m) => m.label),
  };
}

const change = (r: YearReport) => (r.previous ? (r.total / r.previous - 1) * 100 : null);

/** A few lines to share. Leaves out dollar amounts when `privately` is set. */
export function reportText(r: YearReport, privately = false): string {
  const c = change(r);
  const lines = [
    `My ${r.year}${r.partial ? ' so far' : ''} in dividends:`,
    privately ? `${r.payments} payments from ${r.companies} companies` : `${money(r.total)} from ${r.payments} payments by ${r.companies} companies`,
    c != null ? `${signedPct(c, 0)} on ${Number(r.year) - 1}` : '',
    r.raises.length ? `${r.raises.length} of my holdings raised their dividend` : '',
    r.covered.length ? `My dividends now cover ${r.covered[r.covered.length - 1].replace(/^your /, 'my ')} and more` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** A standalone page (prints well, opens offline). */
export function reportHtml(r: YearReport): string {
  const c = change(r);
  const max = Math.max(...r.months.map((m) => m.amount), 1);
  const bars = r.months.map((m) => `<div class="bar"><i style="height:${((m.amount / max) * 100).toFixed(1)}%"></i><span>${monthShort(m.month)}</span></div>`).join('');
  const rows = (items: [string, string][]) => items.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${r.year} in dividends</title>
<style>
body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#0b1020;background:#f4f6fb;margin:0;padding:32px 16px}
main{max-width:720px;margin:0 auto;background:#fff;border-radius:20px;padding:32px;box-shadow:0 10px 40px -20px rgba(20,30,70,.3)}
h1{margin:0 0 4px;font-size:26px}.muted{color:#5b6480}.big{font-size:44px;font-weight:700;margin:16px 0 4px;color:#2f5bea}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:24px 0}
.grid div{background:#f4f6fb;border-radius:14px;padding:12px 14px}.grid b{display:block;font-size:20px;margin-top:4px}
.bars{display:flex;align-items:flex-end;gap:6px;height:150px;margin:20px 0 28px}.bar{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px}
.bar i{display:block;width:100%;background:#3b6cf6;border-radius:6px 6px 0 0;min-height:2px}.bar span{font-size:11px;color:#5b6480}
h2{font-size:16px;margin:24px 0 8px}table{width:100%;border-collapse:collapse}td{padding:8px 0;border-top:1px solid #e6e9f2}td:last-child{text-align:right;font-weight:600}
footer{margin-top:28px;font-size:12px;color:#8a92ab}@media print{body{background:#fff;padding:0}main{box-shadow:none}}
</style></head><body><main>
<h1>Your ${r.year} in dividends</h1><div class="muted">${r.partial ? `So far, through ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}` : 'January to December'}</div>
<div class="big">${money(r.total)}</div>
<div class="muted">${c != null ? `${signedPct(c, 1)} on ${Number(r.year) - 1}'s ${money(r.previous)}` : ''}</div>
<div class="grid">
<div class="muted">Payments<b>${r.payments}</b></div><div class="muted">Companies and funds<b>${r.companies}</b></div>
<div class="muted">Best month<b>${r.best ? esc(monthLong(r.best.month)) : '—'}</b></div><div class="muted">Forward income<b>${money(r.forwardIncome)}/yr</b></div>
<div class="muted">Yield on cost<b>${pct(r.yieldOnCost)}</b></div>
</div>
<h2>By month</h2><div class="bars">${bars}</div>
<h2>Top payers</h2><table>${rows(r.top.map((t) => [t.symbol, money(t.amount)]))}</table>
${r.raises.length ? `<h2>Dividend raises</h2><table>${rows(r.raises.map((x) => [x.symbol, signedPct(x.growth, 1)]))}</table>` : ''}
${r.covered.length ? `<h2>Milestones</h2><p>Your dividends cover ${esc(r.covered.join(', '))} each month.</p>` : ''}
<footer>Made with Dividends · ${new Date().toISOString().slice(0, 10)}</footer>
</main></body></html>`;
}
