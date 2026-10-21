import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeStats, projectPayouts, todayIso } from './lib/analytics';
import { api, NoServer, setApiToken, type ServerStatus } from './lib/api';
import { demoPortfolio } from './lib/demo';
import type { Portfolio, Settings } from './lib/types';

const PORTFOLIO_KEY = 'dividends:portfolio';
const SETTINGS_KEY = 'dividends:settings';
export const DEFAULT_SETTINGS: Settings = { monthlyGoal: 500, privacy: false, theme: 'dark', glass: 1, apiToken: '', taxRate: 15 };

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

export type Mode = 'loading' | 'server' | 'local';

export function useStore() {
  const [settings, setSettings] = useState<Settings>(() => load(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [mode, setMode] = useState<Mode>('loading');
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio>(() => {
    const saved = load<Portfolio | null>(PORTFOLIO_KEY, null);
    return saved?.holdings ? saved : demoPortfolio();
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  setApiToken(settings.apiToken);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      save(SETTINGS_KEY, next);
      return next;
    });
  }, []);

  const replacePortfolio = useCallback((p: Portfolio) => {
    setPortfolio(p);
    save(PORTFOLIO_KEY, p);
  }, []);

  /** Pull status and, when Robinhood is connected, the latest synced portfolio from the server. */
  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setMode('server');
      setStatus(s);
      if (s.needsToken) return;
      if (s.connected || s.lastSync) {
        const p = await api.portfolio();
        if (p?.holdings) replacePortfolio(p);
      }
    } catch (e) {
      if (e instanceof NoServer) setMode('local');
      else setError((e as Error).message);
    }
  }, [replacePortfolio]);

  useEffect(() => { void refresh(); }, [refresh, settings.apiToken]);

  // Pick up the server's daily sync: re-check every 10 minutes and when the tab comes back into view.
  useEffect(() => {
    if (mode !== 'server') return;
    const id = setInterval(refresh, 10 * 60 * 1000);
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [mode, refresh]);

  const syncNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      replacePortfolio(await api.sync());
      setStatus(await api.status());
    } catch (e) {
      setError((e as Error).message);
      setStatus(await api.status().catch(() => statusRef.current));
    } finally {
      setBusy(false);
    }
  }, [replacePortfolio]);

  const today = todayIso();
  const derived = useMemo(() => {
    const { holdings, totals } = computeStats(portfolio, today);
    const payouts = projectPayouts(holdings, portfolio.dividends, today, 12);
    return { holdings, totals, payouts };
  }, [portfolio, today]);

  return {
    settings, updateSettings, mode, status, setStatus, portfolio, replacePortfolio, refresh, syncNow,
    busy, error, setError, today, ...derived,
  };
}

export type Store = ReturnType<typeof useStore>;
