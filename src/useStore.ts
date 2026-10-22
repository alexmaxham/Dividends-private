import { useCallback, useEffect, useMemo, useState } from 'react';
import { cloudConfig } from './cloud/config';
import { cloudMessage, loadCloud, type AccountSettings, type Cloud, type CloudUser, type Profile } from './cloud/firebase';
import { computeStats, forAccount, projectPayouts, todayIso, withMarketPrices } from './lib/analytics';
import { DEMO_WATCHLIST, demoMarket, demoPortfolio } from './lib/demo';
import type { Market, Portfolio, Settings } from './lib/types';

const PORTFOLIO_KEY = 'dividends:portfolio';
const SETTINGS_KEY = 'dividends:settings';
export const DEFAULT_SETTINGS: Settings = {
  monthlyGoal: 500, privacy: false, theme: 'dark', glass: 1, taxRate: 15, ordinaryTaxRate: 22, account: 'all', watchlist: [],
  notify: { email: true, push: false, payments: true, raises: true, reconnect: true, weekly: true },
};
/** Funds to compare the portfolio with (Insights → Benchmark). */
export const BENCHMARKS = [{ symbol: 'SPY', label: 'S&P 500 (SPY)' }, { symbol: 'SCHD', label: 'SCHD' }];
const ACCOUNT_KEYS = ['monthlyGoal', 'taxRate', 'ordinaryTaxRate', 'watchlist', 'notify'] as const;

/** Regular US trading hours, roughly (holidays aside): weekdays 9:30 am to 4:00 pm in New York. */
export function marketOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return !['Sat', 'Sun'].includes(get('weekday')) && minutes >= 570 && minutes < 960;
}
export const EMPTY_PORTFOLIO: Portfolio = { holdings: [], dividends: [], history: [], cash: 0, source: 'manual', syncedAt: null };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && (fallback as { notify?: object }).notify) saved.notify = { ...(fallback as { notify: object }).notify, ...saved.notify };
    return saved ? { ...fallback, ...saved } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

/**
 * local     – no Firebase project configured: everything lives in this browser.
 * loading   – waiting for Firebase to say whether someone is signed in.
 * signedOut – show the sign-in screen (or the sample data, if they chose to look around).
 * cloud     – signed in: settings and portfolio come from their account and update live.
 */
export type Mode = 'local' | 'loading' | 'signedOut' | 'cloud';

export function useStore() {
  const [settings, setSettings] = useState<Settings>(() => load(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [mode, setMode] = useState<Mode>(cloudConfig ? 'loading' : 'local');
  const [cloud, setCloud] = useState<Cloud | null>(null);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [profile, setProfile] = useState<Profile>({});
  const [cloudPortfolio, setCloudPortfolio] = useState<Portfolio | null>(null);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);
  const [localPortfolio, setLocalPortfolio] = useState<Portfolio>(() => {
    const saved = load<Portfolio | null>(PORTFOLIO_KEY, null);
    return saved?.holdings ? saved : demoPortfolio();
  });
  const demo = useMemo(() => demoPortfolio(), []);
  const [exploring, setExploring] = useState(false); // signed out, looking at the sample data
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveMarket, setLiveMarket] = useState<Market>({});
  const [quotesEnabled, setQuotesEnabled] = useState(false);

  // Connect to Firebase and follow the signed-in person.
  useEffect(() => {
    if (!cloudConfig) return;
    let stop = () => {};
    let cancelled = false;
    loadCloud(cloudConfig).then((c) => {
      if (cancelled) return;
      setCloud(c);
      stop = c.onAuth((u) => {
        setUser(u);
        setMode(u ? 'cloud' : 'signedOut');
        if (u) setExploring(false);
      });
    }).catch((e) => { setError(cloudMessage(e)); setMode('local'); });
    return () => { cancelled = true; stop(); };
  }, []);

  // Live account data: settings, linked accounts, sync status and the portfolio.
  useEffect(() => {
    setProfile({});
    setCloudPortfolio(null);
    setPortfolioLoaded(false);
    if (!cloud || !user) return;
    const onError = (e: unknown) => setError(cloudMessage(e));
    const a = cloud.watchProfile(user.uid, (p) => {
      setProfile(p);
      if (p.settings) setSettings((s) => ({ ...s, ...p.settings }));
    }, onError);
    const b = cloud.watchPortfolio(user.uid, (p) => { setCloudPortfolio(p); setPortfolioLoaded(true); }, onError);
    return () => { a(); b(); };
  }, [cloud, user]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      save(SETTINGS_KEY, next);
      // Goal, tax rates, watchlist and notifications belong to the account; theme, glass, privacy and the account
      // filter stay with this device.
      if (cloud && user && ACCOUNT_KEYS.some((k) => k in patch)) {
        const out = Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, next[k]])) as unknown as AccountSettings;
        cloud.saveSettings(user.uid, out).catch((e) => setError(cloudMessage(e)));
      }
      return next;
    });
  }, [cloud, user]);

  const linked = (profile.accounts?.length ?? 0) > 0;

  const replacePortfolio = useCallback((p: Portfolio) => {
    if (mode === 'cloud' && cloud && user) {
      if (linked) { setError('Your portfolio comes from your linked brokerage. Unlink it to edit by hand.'); return; }
      setCloudPortfolio({ ...p, source: 'manual' });
      cloud.savePortfolio(user.uid, p).catch((e) => setError(cloudMessage(e)));
      return;
    }
    setLocalPortfolio(p);
    save(PORTFOLIO_KEY, p);
  }, [mode, cloud, user, linked]);

  const call = useCallback(async <T,>(name: string, data?: unknown): Promise<T> => {
    if (!cloud) throw new Error('Sign in first.');
    return cloud.call<T>(name, data);
  }, [cloud]);

  const syncNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try { await call('syncNow'); } catch (e) { setError(cloudMessage(e)); } finally { setBusy(false); }
  }, [call]);

  const portfolio: Portfolio =
    mode === 'cloud' ? (cloudPortfolio ?? EMPTY_PORTFOLIO)
      : mode === 'signedOut' || mode === 'loading' ? demo
        : localPortfolio;

  const today = todayIso();
  const isDemo = portfolio.source === 'demo';
  const demoMkt = useMemo(() => (isDemo ? demoMarket(today) : {}), [isDemo, today]);
  const market: Market = isDemo ? demoMkt : liveMarket;
  const watchlist = isDemo && !settings.watchlist.length ? DEMO_WATCHLIST : settings.watchlist;

  // Market data for everything held or watched, plus the benchmark funds; it updates live as the server refreshes it.
  const symbols = useMemo(
    () => [...new Set([...portfolio.holdings.map((h) => h.symbol), ...watchlist, ...BENCHMARKS.map((b) => b.symbol)])].sort(),
    [portfolio.holdings, watchlist],
  );
  const symbolsKey = symbols.join(',');
  useEffect(() => {
    setLiveMarket({});
    if (!cloud || !user || isDemo) return;
    return cloud.watchMarket(symbols, setLiveMarket, () => { /* market data is optional; the app works without it */ });
  }, [cloud, user, symbolsKey, isDemo]);

  // Prices during the day: refresh every five minutes while the market is open and the app is on screen.
  useEffect(() => {
    if (!cloud || !user || isDemo || !symbols.length) return;
    let stopped = false;
    const tick = async (first = false) => {
      if (stopped || document.hidden || (!first && !marketOpen())) return;
      try {
        const r = await cloud.call<{ enabled: boolean }>('quotes', { symbols: symbols.filter((x) => !BENCHMARKS.some((b) => b.symbol === x)) });
        setQuotesEnabled(r.enabled);
      } catch { /* quotes are a nice-to-have; keep the synced prices */ }
    };
    void tick(true);
    const id = setInterval(() => void tick(), 5 * 60 * 1000);
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [cloud, user, symbolsKey, isDemo]);

  const accounts = portfolio.accounts ?? [];
  const account = accounts.some((a) => a.id === settings.account) ? settings.account : 'all';
  const priced = useMemo(() => withMarketPrices(portfolio, market), [portfolio, market]);
  const view = useMemo(() => forAccount(priced, account), [priced, account]);
  const derived = useMemo(() => {
    const { holdings, totals } = computeStats(view, today, market);
    const payouts = projectPayouts(holdings, view.dividends, today, 12, market);
    return { holdings, totals, payouts };
  }, [view, today, market]);
  // Every account together, for views that break things down by account (taxes, income per account).
  const all = useMemo(() => (account === 'all' ? derived : { ...computeStats(priced, today, market) }), [account, derived, priced, today, market]);

  return {
    settings, updateSettings, mode, cloud, user, profile, linked, call, exploring, setExploring,
    portfolio: view, allPortfolio: priced, allHoldings: all.holdings, accounts, account, market, watchlist, quotesEnabled,
    portfolioLoaded, replacePortfolio, syncNow, busy, setBusy, error, setError, today, ...derived,
  };
}

export type Store = ReturnType<typeof useStore>;
