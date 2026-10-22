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
  /** The holding split by brokerage account (synced portfolios). cost is the account's total cost basis. */
  lots?: Lot[];
}

export interface Lot {
  account: string;
  shares: number;
  cost: number;
}

/** A brokerage account inside a linked login: individual, Roth IRA, 401(k), … */
export interface Account {
  id: string;
  name: string;
  mask: string | null;
  /** Plaid's investment subtype: brokerage, roth, ira, 401k, hsa, … */
  subtype: string;
  institution: string;
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
  /** Which brokerage account it was paid into. */
  account?: string;
  /** Qualified for the lower tax rate, as the brokerage reported it; undefined when it didn't say. */
  qualified?: boolean;
}

export interface Snapshot {
  date: string;
  value: number;
  cost: number;
  byAccount?: Record<string, { value: number; cost: number }>;
}

export interface Portfolio {
  holdings: Holding[];
  dividends: Dividend[];
  history: Snapshot[];
  cash: number;
  source: 'plaid' | 'robinhood' | 'demo' | 'manual';
  syncedAt: string | null;
  accounts?: Account[];
}

/** One announced or past dividend from market data. */
export interface MarketDividend {
  exDate: string;
  payDate: string | null;
  recordDate?: string | null;
  declared?: string | null;
  amount: number;
  frequency?: number | null;
  special?: boolean;
}

/** Shared market data for one symbol (market/{SYMBOL}). */
export interface MarketInfo {
  symbol: string;
  name?: string;
  sector?: string;
  /** Newest first. */
  dividends: MarketDividend[];
  splits?: { date: string; ratio: number }[];
  close?: number;
  closeDate?: string;
  quote?: { price: number; prevClose: number; at: string };
  closes?: { date: string; close: number }[];
}

export type Market = Record<string, MarketInfo>;

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
  /** confirmed = announced by the company or broker; estimated = projected from the payment pattern. */
  kind: 'confirmed' | 'estimated';
  /** Ex-dividend date, when announced: own the shares before this day to get the payment. */
  exDate?: string;
}

export interface Settings {
  monthlyGoal: number;
  privacy: boolean;
  theme: 'dark' | 'light' | 'system';
  /** 0.4 (very clear) - 1.6 (frosted). 1 is the default glass. */
  glass: number;
  /** Tax rate on qualified dividends, percent (also the planner's default). */
  taxRate: number;
  /** Tax rate on ordinary (non-qualified) dividends, percent: your income tax bracket. */
  ordinaryTaxRate: number;
  /** Which brokerage account to show: 'all' or an account id. Kept on this device. */
  account: string;
  /** Symbols to keep an eye on. */
  watchlist: string[];
  notify: NotifySettings;
}

export interface NotifySettings {
  email: boolean;
  push: boolean;
  payments: boolean;
  raises: boolean;
  reconnect: boolean;
  weekly: boolean;
}

/** Data that came from a brokerage sync and is read-only in the app. */
export const isSynced = (p: Pick<Portfolio, 'source'>) => p.source === 'plaid' || p.source === 'robinhood';
