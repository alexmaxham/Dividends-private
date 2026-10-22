import { addDays, addMonths, todayIso } from './analytics';
import type { Account, Dividend, Holding, Market, MarketDividend, Portfolio, Snapshot } from './types';

// A made-up sample portfolio so the app has something to show before Robinhood is connected.
interface Seed {
  h: Omit<Holding, 'prevClose' | 'dividendYield'>;
  rate: number; // current per-share payment
  months: number[]; // pay months (1-12)
  day: number;
  growth: number; // yearly raise, percent
  raiseMonth: number;
  roth?: boolean; // held in the Roth IRA rather than the individual account
  ordinary?: boolean; // dividends taxed as ordinary income (REITs, BDCs, option-income funds)
}

const ACCOUNTS: Account[] = [
  { id: 'demo-individual', name: 'Individual', mask: '4821', subtype: 'brokerage', institution: 'Robinhood' },
  { id: 'demo-roth', name: 'Roth IRA', mask: '7730', subtype: 'roth', institution: 'Robinhood' },
];

const SEEDS: Seed[] = [
  { h: { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', sector: 'ETF', shares: 210, avgCost: 25.9, price: 28.4 }, rate: 0.27, months: [3, 6, 9, 12], day: 26, growth: 6, raiseMonth: 3 },
  { h: { symbol: 'O', name: 'Realty Income', sector: 'Real Estate', shares: 85, avgCost: 54.2, price: 58.9 }, rate: 0.2715, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day: 15, growth: 3, raiseMonth: 1, roth: true, ordinary: true },
  { h: { symbol: 'JEPI', name: 'JPMorgan Equity Premium Income ETF', sector: 'ETF', shares: 60, avgCost: 55.1, price: 57.2 }, rate: 0.39, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day: 5, growth: 0, raiseMonth: 1, roth: true, ordinary: true },
  { h: { symbol: 'KO', name: 'Coca-Cola', sector: 'Consumer Staples', shares: 40, avgCost: 58.3, price: 71.1 }, rate: 0.53, months: [4, 7, 10, 12], day: 1, growth: 5, raiseMonth: 4 },
  { h: { symbol: 'PEP', name: 'PepsiCo', sector: 'Consumer Staples', shares: 18, avgCost: 162.4, price: 152.8 }, rate: 1.48, months: [1, 3, 6, 9], day: 6, growth: 5, raiseMonth: 6 },
  { h: { symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Health Care', shares: 22, avgCost: 152.0, price: 176.3 }, rate: 1.34, months: [3, 6, 9, 12], day: 9, growth: 4.5, raiseMonth: 6 },
  { h: { symbol: 'ABBV', name: 'AbbVie', sector: 'Health Care', shares: 15, avgCost: 148.6, price: 214.5 }, rate: 1.72, months: [2, 5, 8, 11], day: 15, growth: 6, raiseMonth: 2, roth: true },
  { h: { symbol: 'MSFT', name: 'Microsoft', sector: 'Technology', shares: 12, avgCost: 335.0, price: 512.4 }, rate: 0.91, months: [3, 6, 9, 12], day: 12, growth: 10, raiseMonth: 12 },
  { h: { symbol: 'AAPL', name: 'Apple', sector: 'Technology', shares: 30, avgCost: 168.2, price: 247.6 }, rate: 0.27, months: [2, 5, 8, 11], day: 14, growth: 4, raiseMonth: 5 },
  { h: { symbol: 'VZ', name: 'Verizon', sector: 'Communication', shares: 75, avgCost: 38.4, price: 41.9 }, rate: 0.69, months: [2, 5, 8, 11], day: 1, growth: 2, raiseMonth: 11 },
  { h: { symbol: 'MAIN', name: 'Main Street Capital', sector: 'Financials', shares: 45, avgCost: 44.7, price: 61.3 }, rate: 0.255, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day: 15, growth: 4, raiseMonth: 1, ordinary: true },
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
  for (const s of SEEDS) {
    const wiggle = 1 + (rand() - 0.5) * 0.02;
    const yieldPct = ((s.rate * s.months.length) / s.h.price) * 100;
    const account = s.roth ? 'demo-roth' : 'demo-individual';
    holdings.push({
      ...s.h, prevClose: +(s.h.price / wiggle).toFixed(2), dividendYield: +yieldPct.toFixed(2),
      lots: [{ account, shares: s.h.shares, cost: +(s.h.shares * s.h.avgCost).toFixed(2) }],
    });
    for (const { payDate, rate, m } of schedule(s, today)) {
      const progress = Math.min(1, m / 34);
      const shares = Math.round(s.h.shares * (0.55 + 0.45 * progress));
      dividends.push({
        id: `demo-${s.h.symbol}-${payDate}`, symbol: s.h.symbol, rate, shares, amount: +(rate * shares).toFixed(2),
        state: payDate <= today ? 'paid' : 'pending', payDate, recordDate: addDays(payDate, -14), drip: s.h.symbol === 'O',
        account, qualified: !s.ordinary,
      });
    }
  }
  dividends.sort((a, b) => b.payDate.localeCompare(a.payDate));

  const value = holdings.reduce((sum, h) => sum + h.shares * h.price, 0);
  const cost = holdings.reduce((sum, h) => sum + h.shares * h.avgCost, 0);
  const rothShare = holdings.filter((h) => h.lots![0].account === 'demo-roth').reduce((sum, h) => sum + h.shares * h.price, 0) / value;
  const rothCost = holdings.filter((h) => h.lots![0].account === 'demo-roth').reduce((sum, h) => sum + h.shares * h.avgCost, 0) / cost;
  const history: Snapshot[] = [];
  let v = value;
  let c = cost;
  for (let i = 0; i < 365; i++) {
    const split = (total: number, share: number) => +(total * share).toFixed(2);
    history.push({
      date: addDays(today, -i), value: +v.toFixed(2), cost: +c.toFixed(2),
      byAccount: {
        'demo-roth': { value: split(v, rothShare), cost: split(c, rothCost) },
        'demo-individual': { value: split(v, 1 - rothShare), cost: split(c, 1 - rothCost) },
      },
    });
    v = v / (1 + 0.00055 + (rand() - 0.5) * 0.018);
    if (i % 14 === 13) c -= 260; // biweekly contributions
  }
  history.reverse();
  return { holdings, dividends, history, cash: 412.37, source: 'demo', syncedAt: null, accounts: ACCOUNTS };
}

/** Each seed's payments: pay dates and per-share rates, up to 40 days ahead. */
function schedule(s: Seed, today: string): { payDate: string; rate: number; m: number }[] {
  const start = addMonths(today, -34);
  const out: { payDate: string; rate: number; m: number }[] = [];
  for (let m = 0; m <= 37; m++) {
    const month = addMonths(`${start.slice(0, 7)}-01`, m);
    if (!s.months.includes(Number(month.slice(5, 7)))) continue;
    const payDate = `${month.slice(0, 8)}${String(s.day).padStart(2, '0')}`;
    if (payDate > addDays(today, 40)) break;
    // Raises land once a year in raiseMonth; shares grew from ~55% to today's count.
    const idx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
    const lastRaise = idx(today) - ((idx(today) - (s.raiseMonth - 1)) % 12 + 12) % 12;
    const yearsBack = idx(payDate) >= lastRaise ? 0 : Math.ceil((lastRaise - idx(payDate)) / 12);
    out.push({ payDate, rate: +(s.rate / Math.pow(1 + s.growth / 100, Math.max(0, yearsBack))).toFixed(4), m });
  }
  return out;
}

// Symbols for the sample watchlist: not held, so they show what looking something up gives you.
const IDEAS: Seed[] = [
  { h: { symbol: 'VYM', name: 'Vanguard High Dividend Yield ETF', sector: 'ETF', shares: 0, avgCost: 0, price: 138.6 }, rate: 0.85, months: [3, 6, 9, 12], day: 24, growth: 5, raiseMonth: 3 },
  { h: { symbol: 'HD', name: 'Home Depot', sector: 'Consumer Discretionary', shares: 0, avgCost: 0, price: 402.1 }, rate: 2.3, months: [3, 6, 9, 12], day: 18, growth: 7, raiseMonth: 3 },
  { h: { symbol: 'TXN', name: 'Texas Instruments', sector: 'Technology', shares: 0, avgCost: 0, price: 188.4 }, rate: 1.42, months: [2, 5, 8, 11], day: 12, growth: 5, raiseMonth: 11 },
];
export const DEMO_WATCHLIST = IDEAS.map((i) => i.h.symbol);

/** Sample market data: each payment's ex-dividend date and announced amount, plus benchmark prices. */
export function demoMarket(today = todayIso()): Market {
  const out: Market = {};
  for (const s of [...SEEDS, ...IDEAS]) {
    const dividends: MarketDividend[] = schedule(s, today).map(({ payDate, rate }) => ({
      exDate: addDays(payDate, -15), payDate, recordDate: addDays(payDate, -15), amount: rate, frequency: s.months.length,
    })).reverse();
    out[s.h.symbol] = { symbol: s.h.symbol, name: s.h.name, sector: s.h.sector, dividends, close: s.h.price, closeDate: addDays(today, -1) };
  }
  // Benchmarks: two years of daily closes on a steady climb with some noise.
  const rand = rng(7);
  for (const [sym, price, drift] of [['SPY', 652.4, 0.00052], ['SCHD', 28.4, 0.00028]] as const) {
    const closes: { date: string; close: number }[] = [];
    let p = price;
    for (let i = 0; i < 730; i++) {
      const date = addDays(today, -i);
      if ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) continue;
      closes.push({ date, close: +p.toFixed(2) });
      p = p / (1 + drift * 1.4 + (rand() - 0.5) * 0.016);
    }
    out[sym] = { ...(out[sym] ?? { symbol: sym, dividends: [] }), closes: closes.reverse() };
  }
  // SPY pays quarterly: ex-dividend on the 20th of Mar/Jun/Sep/Dec, paid about six weeks later.
  out.SPY.dividends = [3, 6, 9, 12].flatMap((mo) => [0, 1, 2].map((y) => {
    const exDate = `${Number(today.slice(0, 4)) - y}-${String(mo).padStart(2, '0')}-20`;
    return { exDate, payDate: addDays(exDate, 41), amount: 1.85, frequency: 4 };
  })).filter((d) => d.exDate <= today).sort((a, b) => b.exDate.localeCompare(a.exDate));
  return out;
}
