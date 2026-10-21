export interface Holding {
  symbol: string;
  name: string;
  shares: number;
  avgCost: number;
  price: number;
  prevClose: number;
  /** Trailing yield in percent, as Robinhood's fundamentals report it. Used when there's no payment history. */
  dividendYield: number;
  sector: string;
  industry?: string;
}

export type DividendState = 'paid' | 'pending' | 'reinvested' | 'voided';

export interface Dividend {
  id: string;
  symbol: string;
  amount: number;
  /** Per-share amount. */
  rate: number;
  shares: number;
  withholding?: number;
  state: DividendState;
  /** YYYY-MM-DD */
  payDate: string;
  recordDate?: string;
  drip?: boolean;
}

export interface Snapshot {
  date: string;
  value: number;
  cost: number;
}

export interface Portfolio {
  holdings: Holding[];
  dividends: Dividend[];
  history: Snapshot[];
  cash: number;
  source: 'plaid' | 'robinhood' | 'demo' | 'manual';
  syncedAt: string | null;
}

export type Frequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'none';

export interface HoldingStats extends Holding {
  value: number;
  cost: number;
  gain: number;
  gainPct: number;
  dayChange: number;
  frequency: Frequency;
  /** Forward annual dividend per share. */
  annualPerShare: number;
  annualIncome: number;
  currentYield: number;
  yieldOnCost: number;
  /** Share of total forward income, 0-1. */
  incomeShare: number;
  /** Share of portfolio value, 0-1. */
  weight: number;
  received: number;
  lastPayDate: string | null;
  /** Year-over-year change in per-share rate, percent; null without a year of history. */
  growth: number | null;
}

export interface Payout {
  symbol: string;
  date: string;
  amount: number;
  rate: number;
  /** confirmed = announced by the broker (pending); estimated = projected from the payment pattern. */
  kind: 'confirmed' | 'estimated';
}

export interface Settings {
  monthlyGoal: number;
  privacy: boolean;
  theme: 'dark' | 'light' | 'system';
  /** 0.4 (very clear) - 1.6 (frosted). 1 is the default glass. */
  glass: number;
  apiToken: string;
  taxRate: number;
}

/** Data that came from a brokerage sync and is read-only in the app. */
export const isSynced = (p: Pick<Portfolio, 'source'>) => p.source === 'plaid' || p.source === 'robinhood';
