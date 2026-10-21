import { addDays, addMonths, todayIso } from './analytics';
import type { Dividend, Holding, Portfolio, Snapshot } from './types';

// A made-up sample portfolio so the app has something to show before Robinhood is connected.
interface Seed {
  h: Omit<Holding, 'prevClose' | 'dividendYield'>;
  rate: number; // current per-share payment
  months: number[]; // pay months (1-12)
  day: number;
  growth: number; // yearly raise, percent
  raiseMonth: number;
}

const SEEDS: Seed[] = [
  { h: { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', sector: 'ETF', shares: 210, avgCost: 25.9, price: 28.4 }, rate: 0.27, months: [3, 6, 9, 12], day: 26, growth: 6, raiseMonth: 3 },
  { h: { symbol: 'O', name: 'Realty Income', sector: 'Real Estate', shares: 85, avgCost: 54.2, price: 58.9 }, rate: 0.2715, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day: 15, growth: 3, raiseMonth: 1 },
  { h: { symbol: 'JEPI', name: 'JPMorgan Equity Premium Income ETF', sector: 'ETF', shares: 60, avgCost: 55.1, price: 57.2 }, rate: 0.39, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day: 5, growth: 0, raiseMonth: 1 },
  { h: { symbol: 'KO', name: 'Coca-Cola', sector: 'Consumer Staples', shares: 40, avgCost: 58.3, price: 71.1 }, rate: 0.53, months: [4, 7, 10, 12], day: 1, growth: 5, raiseMonth: 4 },
  { h: { symbol: 'PEP', name: 'PepsiCo', sector: 'Consumer Staples', shares: 18, avgCost: 162.4, price: 152.8 }, rate: 1.48, months: [1, 3, 6, 9], day: 6, growth: 5, raiseMonth: 6 },
  { h: { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Health Care', shares: 22, avgCost: 152.0, price: 176.3 }, rate: 1.34, months: [3, 6, 9, 12], day: 9, growth: 4.5, raiseMonth: 6 },
  { h: { symbol: 'ABBV', name: 'AbbVie', sector: 'Health Care', shares: 15, avgCost: 148.6, price: 214.5 }, rate: 1.72, months: [2, 5, 8, 11], day: 15, growth: 6, raiseMonth: 2 },
  { h: { symbol: 'MSFT', name: 'Microsoft', sector: 'Technology', shares: 12, avgCost: 335.0, price: 512.4 }, rate: 0.91, months: [3, 6, 9, 12], day: 12, growth: 10, raiseMonth: 12 },
  { h: { symbol: 'AAPL', name: 'Apple', sector: 'Technology', shares: 30, avgCost: 168.2, price: 247.6 }, rate: 0.27, months: [2, 5, 8, 11], day: 14, growth: 4, raiseMonth: 5 },
  { h: { symbol: 'VZ', name: 'Verizon', sector: 'Communication', shares: 75, avgCost: 38.4, price: 41.9 }, rate: 0.69, months: [2, 5, 8, 11], day: 1, growth: 2, raiseMonth: 11 },
  { h: { symbol: 'MAIN', name: 'Main Street Capital', sector: 'Financials', shares: 45, avgCost: 44.7, price: 61.3 }, rate: 0.255, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day: 15, growth: 4, raiseMonth: 1 },
  { h: { symbol: 'XOM', name: 'Exxon Mobil', sector: 'Energy', shares: 25, avgCost: 104.0, price: 114.2 }, rate: 1.03, months: [3, 6, 9, 12], day: 10, growth: 4, raiseMonth: 12 },
  { h: { symbol: 'PG', name: 'Procter & Gamble', sector: 'Consumer Staples', shares: 16, avgCost: 151.0, price: 158.7 }, rate: 1.06, months: [2, 5, 8, 11], day: 15, growth: 5, raiseMonth: 5 },
  { h: { symbol: 'NVDA', name: 'NVIDIA', sector: 'Technology', shares: 20, avgCost: 92.0, price: 181.0 }, rate: 0.01, months: [3, 6, 10, 12], day: 27, growth: 0, raiseMonth: 1 },
];

/** Deterministic pseudo-random numbers so the demo looks the same on every load. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export function demoPortfolio(today = todayIso()): Portfolio {
  const rand = rng(42);
  const holdings: Holding[] = [];
  const dividends: Dividend[] = [];
  const start = addMonths(today, -34);
  for (const s of SEEDS) {
    const wiggle = 1 + (rand() - 0.5) * 0.02;
    const yieldPct = ((s.rate * s.months.length) / s.h.price) * 100;
    holdings.push({ ...s.h, prevClose: +(s.h.price / wiggle).toFixed(2), dividendYield: +yieldPct.toFixed(2) });
    for (let m = 0; m <= 37; m++) {
      const month = addMonths(`${start.slice(0, 7)}-01`, m);
      if (!s.months.includes(Number(month.slice(5, 7)))) continue;
      const payDate = `${month.slice(0, 8)}${String(s.day).padStart(2, '0')}`;
      if (payDate > addDays(today, 40)) break;
      // Raises land once a year in raiseMonth; shares grew from ~55% to today's count.
      const idx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
      const lastRaise = idx(today) - ((idx(today) - (s.raiseMonth - 1)) % 12 + 12) % 12;
      const yearsBack = idx(payDate) >= lastRaise ? 0 : Math.ceil((lastRaise - idx(payDate)) / 12);
      const rate = +(s.rate / Math.pow(1 + s.growth / 100, Math.max(0, yearsBack))).toFixed(4);
      const progress = Math.min(1, m / 34);
      const shares = Math.round(s.h.shares * (0.55 + 0.45 * progress));
      dividends.push({
        id: `demo-${s.h.symbol}-${payDate}`, symbol: s.h.symbol, rate, shares, amount: +(rate * shares).toFixed(2),
        state: payDate <= today ? 'paid' : 'pending', payDate, recordDate: addDays(payDate, -14), drip: s.h.symbol === 'O',
      });
    }
  }
  dividends.sort((a, b) => b.payDate.localeCompare(a.payDate));

  const value = holdings.reduce((sum, h) => sum + h.shares * h.price, 0);
  const cost = holdings.reduce((sum, h) => sum + h.shares * h.avgCost, 0);
  const history: Snapshot[] = [];
  let v = value;
  let c = cost;
  for (let i = 0; i < 365; i++) {
    history.push({ date: addDays(today, -i), value: +v.toFixed(2), cost: +c.toFixed(2) });
    v = v / (1 + 0.00055 + (rand() - 0.5) * 0.018);
    if (i % 14 === 13) c -= 260; // biweekly contributions
  }
  history.reverse();
  return { holdings, dividends, history, cash: 412.37, source: 'demo', syncedAt: null };
}
