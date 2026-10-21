import type { Dividend, Frequency, Holding, HoldingStats, Payout, Portfolio } from './types';

// ───────────── Dates (calendar dates as YYYY-MM-DD, handled in UTC so time zones never shift a day) ─────────────

export function toDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function todayIso(now = new Date()): string {
  return iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
export function addDays(isoDate: string, days: number): string {
  const d = toDate(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
export function addMonths(isoDate: string, months: number): string {
  const d = toDate(isoDate);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000);
}
export const monthKey = (isoDate: string) => isoDate.slice(0, 7);

// ───────────── Dividend pattern ─────────────

export const PERIODS: Record<Frequency, number> = { monthly: 12, quarterly: 4, semiannual: 2, annual: 1, none: 0 };
const counted = (d: Dividend) => d.state !== 'voided';
export const isReceived = (d: Dividend) => d.state === 'paid' || d.state === 'reinvested';

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function nearestFrequency(periods: number): Frequency {
  const options: Frequency[] = ['monthly', 'quarterly', 'semiannual', 'annual'];
  return options.reduce((best, f) => (Math.abs(PERIODS[f] - periods) < Math.abs(PERIODS[best] - periods) ? f : best));
}

/** Payment frequency from the gaps between recent payments (newest first or any order). */
export function detectFrequency(payDates: string[], holding?: Pick<Holding, 'dividendYield' | 'price'>, lastRate?: number): Frequency {
  const dates = [...new Set(payDates)].sort().slice(-7);
  if (dates.length >= 2) {
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const g = median(gaps);
    if (g < 50) return 'monthly';
    if (g < 135) return 'quarterly';
    if (g < 250) return 'semiannual';
    return 'annual';
  }
  // One payment: infer how many a year from the reported yield (annual dividend / one payment).
  if (dates.length === 1 && holding && lastRate && holding.dividendYield > 0 && holding.price > 0) {
    return nearestFrequency((holding.dividendYield / 100) * holding.price / lastRate);
  }
  if (dates.length === 1) return 'quarterly';
  return holding && holding.dividendYield > 0 ? 'quarterly' : 'none';
}

export interface Pattern {
  frequency: Frequency;
  annualPerShare: number;
  lastPayDate: string | null;
  lastRate: number;
  growth: number | null;
  received: number;
}

export function dividendPattern(holding: Holding, dividends: Dividend[], today: string): Pattern {
  const mine = dividends.filter((d) => d.symbol === holding.symbol && counted(d) && d.rate > 0)
    .sort((a, b) => a.payDate.localeCompare(b.payDate));
  // Only the last ~15 months describe the current schedule; older ones can predate a policy change.
  const recent = mine.filter((d) => daysBetween(d.payDate, today) <= 460);
  const last = mine[mine.length - 1];
  const frequency = detectFrequency(recent.map((d) => d.payDate), holding, last?.rate);
  let annualPerShare = 0;
  if (recent.length && frequency !== 'none') annualPerShare = last.rate * PERIODS[frequency];
  else if (holding.dividendYield > 0) annualPerShare = (holding.dividendYield / 100) * holding.price;

  let growth: number | null = null;
  if (last) {
    const target = addDays(last.payDate, -365);
    const prior = mine.filter((d) => Math.abs(daysBetween(d.payDate, target)) <= 45)
      .sort((a, b) => Math.abs(daysBetween(a.payDate, target)) - Math.abs(daysBetween(b.payDate, target)))[0];
    if (prior && prior.rate > 0) growth = (last.rate / prior.rate - 1) * 100;
  }
  const received = mine.filter(isReceived).reduce((s, d) => s + d.amount, 0);
  return {
    frequency: annualPerShare > 0 ? (frequency === 'none' ? 'quarterly' : frequency) : 'none',
    annualPerShare, lastPayDate: last?.payDate ?? null, lastRate: last?.rate ?? 0, growth, received,
  };
}

// ───────────── Portfolio stats ─────────────

export interface Totals {
  value: number;
  cost: number;
  gain: number;
  gainPct: number;
  dayChange: number;
  dayChangePct: number;
  cash: number;
  annualIncome: number;
  monthlyIncome: number;
  dailyIncome: number;
  currentYield: number;
  yieldOnCost: number;
  receivedYtd: number;
  receivedLast12: number;
  receivedAllTime: number;
  receivedLastYearSamePeriod: number;
  payingCount: number;
}

export function computeStats(p: Portfolio, today = todayIso()): { holdings: HoldingStats[]; totals: Totals } {
  const base = p.holdings.map((h) => {
    const pat = dividendPattern(h, p.dividends, today);
    const value = h.shares * h.price;
    const cost = h.shares * h.avgCost;
    return {
      ...h, value, cost, gain: value - cost, gainPct: cost ? (value / cost - 1) * 100 : 0,
      dayChange: h.shares * (h.price - (h.prevClose || h.price)),
      frequency: pat.frequency, annualPerShare: pat.annualPerShare, annualIncome: pat.annualPerShare * h.shares,
      currentYield: h.price ? (pat.annualPerShare / h.price) * 100 : 0,
      yieldOnCost: h.avgCost ? (pat.annualPerShare / h.avgCost) * 100 : 0,
      received: pat.received, lastPayDate: pat.lastPayDate, growth: pat.growth, incomeShare: 0, weight: 0,
    } satisfies HoldingStats;
  });
  const value = base.reduce((s, h) => s + h.value, 0);
  const cost = base.reduce((s, h) => s + h.cost, 0);
  const annualIncome = base.reduce((s, h) => s + h.annualIncome, 0);
  const dayChange = base.reduce((s, h) => s + h.dayChange, 0);
  for (const h of base) {
    h.incomeShare = annualIncome ? h.annualIncome / annualIncome : 0;
    h.weight = value ? h.value / value : 0;
  }
  const received = p.dividends.filter(isReceived);
  const year = today.slice(0, 4);
  const yearAgo = addDays(today, -365);
  const lastYearSame = `${Number(year) - 1}${today.slice(4)}`;
  const sum = (ds: Dividend[]) => ds.reduce((s, d) => s + d.amount, 0);
  return {
    holdings: base.sort((a, b) => b.value - a.value),
    totals: {
      value, cost, gain: value - cost, gainPct: cost ? (value / cost - 1) * 100 : 0,
      dayChange, dayChangePct: value - dayChange ? (dayChange / (value - dayChange)) * 100 : 0,
      cash: p.cash || 0,
      annualIncome, monthlyIncome: annualIncome / 12, dailyIncome: annualIncome / 365,
      currentYield: value ? (annualIncome / value) * 100 : 0,
      yieldOnCost: cost ? (annualIncome / cost) * 100 : 0,
      receivedYtd: sum(received.filter((d) => d.payDate.startsWith(year) && d.payDate <= today)),
      receivedLast12: sum(received.filter((d) => d.payDate > yearAgo && d.payDate <= today)),
      receivedAllTime: sum(received),
      receivedLastYearSamePeriod: sum(received.filter((d) => d.payDate.startsWith(String(Number(year) - 1)) && d.payDate <= lastYearSame)),
      payingCount: base.filter((h) => h.annualIncome > 0).length,
    },
  };
}

// ───────────── Upcoming payouts ─────────────

export function projectPayouts(holdings: HoldingStats[], dividends: Dividend[], today: string, months = 12): Payout[] {
  const horizon = addMonths(today, months);
  const out: Payout[] = [];
  const held = new Set(holdings.map((h) => h.symbol));
  for (const d of dividends) {
    if (d.state === 'pending' && d.payDate >= today && d.payDate <= horizon && held.has(d.symbol)) {
      out.push({ symbol: d.symbol, date: d.payDate, amount: d.amount, rate: d.rate, kind: 'confirmed' });
    }
  }
  for (const h of holdings) {
    const periods = PERIODS[h.frequency];
    if (!periods || h.annualPerShare <= 0) continue;
    const step = 12 / periods;
    const rate = h.annualPerShare / periods;
    const confirmed = out.filter((p) => p.symbol === h.symbol && p.kind === 'confirmed').map((p) => p.date);
    const known = [h.lastPayDate, ...confirmed].filter(Boolean).sort() as string[];
    // No history: assume the next payment lands mid next period.
    let next = known.length ? addMonths(known[known.length - 1], step) : addMonths(today, Math.max(1, Math.round(step / 2)));
    while (next < today) next = addMonths(next, step);
    for (; next <= horizon; next = addMonths(next, step)) {
      // Skip a projection the broker has already confirmed (dates drift a few days between years).
      if (confirmed.some((c) => Math.abs(daysBetween(c, next)) < (step * 30) / 2)) continue;
      out.push({ symbol: h.symbol, date: next, amount: rate * h.shares, rate, kind: 'estimated' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

export interface MonthBar {
  month: string; // YYYY-MM
  received: number;
  projected: number;
}

/** Received income for the past `back` months (including this one) and projected income for the next `ahead`. */
export function monthlySeries(dividends: Dividend[], payouts: Payout[], today: string, back = 12, ahead = 12): MonthBar[] {
  const thisMonth = monthKey(today);
  const bars: MonthBar[] = [];
  for (let i = -(back - 1); i <= ahead; i++) {
    bars.push({ month: monthKey(addMonths(`${thisMonth}-01`, i)), received: 0, projected: 0 });
  }
  const at = new Map(bars.map((b) => [b.month, b]));
  for (const d of dividends) {
    if (isReceived(d) && d.payDate <= today) {
      const b = at.get(monthKey(d.payDate));
      if (b) b.received += d.amount;
    }
  }
  for (const p of payouts) {
    const b = at.get(monthKey(p.date));
    if (b) b.projected += p.amount;
  }
  return bars;
}

export function incomeByYear(dividends: Dividend[], today: string): { year: string; amount: number }[] {
  const by = new Map<string, number>();
  for (const d of dividends) {
    if (isReceived(d) && d.payDate <= today) by.set(d.payDate.slice(0, 4), (by.get(d.payDate.slice(0, 4)) ?? 0) + d.amount);
  }
  return [...by].map(([year, amount]) => ({ year, amount })).sort((a, b) => a.year.localeCompare(b.year));
}

export function groupBy<T>(items: T[], key: (t: T) => string, val: (t: T) => number) {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + val(it));
  return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

// ───────────── Growth projection ─────────────

export interface ProjectionInput {
  startValue: number;
  yieldPct: number;
  monthlyContribution: number;
  dividendGrowthPct: number;
  priceGrowthPct: number;
  years: number;
  reinvest: boolean;
  taxRatePct: number;
}

export interface ProjectionRow {
  year: number;
  value: number;
  annualIncome: number;
  contributed: number;
  dividendsCollected: number;
}

/**
 * Month-by-month model: the price grows at priceGrowth, the payout per share grows at dividendGrowth (so the
 * yield on today's price drifts with the difference), contributions buy at the current price, and dividends
 * (after tax) are reinvested or taken as cash.
 */
export function project(inp: ProjectionInput): ProjectionRow[] {
  const mPrice = Math.pow(1 + inp.priceGrowthPct / 100, 1 / 12);
  const mDiv = Math.pow(1 + inp.dividendGrowthPct / 100, 1 / 12);
  let price = 1;
  let shares = inp.startValue;
  let divPerShare = inp.yieldPct / 100; // annual, per $1 of starting price
  let contributed = inp.startValue;
  let collected = 0;
  const rows: ProjectionRow[] = [{ year: 0, value: inp.startValue, annualIncome: shares * divPerShare, contributed, dividendsCollected: 0 }];
  for (let m = 1; m <= inp.years * 12; m++) {
    price *= mPrice;
    divPerShare *= mDiv;
    const div = (shares * divPerShare) / 12 * (1 - inp.taxRatePct / 100);
    collected += div;
    if (inp.reinvest) shares += div / price;
    shares += inp.monthlyContribution / price;
    contributed += inp.monthlyContribution;
    if (m % 12 === 0) {
      rows.push({ year: m / 12, value: shares * price, annualIncome: shares * divPerShare, contributed, dividendsCollected: collected });
    }
  }
  return rows;
}
