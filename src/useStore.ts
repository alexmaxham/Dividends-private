import { useCallback, useEffect, useMemo, useState } from 'react';
import { cloudConfig } from './cloud/config';
import { cloudMessage, loadCloud, type Cloud, type CloudUser, type Profile } from './cloud/firebase';
import { computeStats, projectPayouts, todayIso } from './lib/analytics';
import { demoPortfolio } from './lib/demo';
import type { Portfolio, Settings } from './lib/types';

const PORTFOLIO_KEY = 'dividends:portfolio';
const SETTINGS_KEY = 'dividends:settings';
export const DEFAULT_SETTINGS: Settings = { monthlyGoal: 500, privacy: false, theme: 'dark', glass: 1, taxRate: 15 };
export const EMPTY_PORTFOLIO: Portfolio = { holdings: [], dividends: [], history: [], cash: 0, source: 'manual', syncedAt: null };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
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
      // Goal and tax rate belong to the account; theme, glass and privacy stay with this device.
      if (cloud && user && ('monthlyGoal' in patch || 'taxRate' in patch)) {
        cloud.saveSettings(user.uid, { monthlyGoal: next.monthlyGoal, taxRate: next.taxRate }).catch((e) => setError(cloudMessage(e)));
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
  const derived = useMemo(() => {
    const { holdings, totals } = computeStats(portfolio, today);
    const payouts = projectPayouts(holdings, portfolio.dividends, today, 12);
    return { holdings, totals, payouts };
  }, [portfolio, today]);

  return {
    settings, updateSettings, mode, cloud, user, profile, linked, call, exploring, setExploring,
    portfolio, portfolioLoaded, replacePortfolio, syncNow, busy, setBusy, error, setError, today, ...derived,
  };
}

export type Store = ReturnType<typeof useStore>;
