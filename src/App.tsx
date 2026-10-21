import { useEffect, useState } from 'react';
import { Calendar } from './components/Calendar';
import { Dividends } from './components/Dividends';
import { HoldingDetail } from './components/HoldingDetail';
import { Holdings } from './components/Holdings';
import { Insights } from './components/Insights';
import { Overview } from './components/Overview';
import { Planner } from './components/Planner';
import { Settings } from './components/Settings';
import { Icon, PrivacyContext } from './components/ui';
import { relativeTime } from './lib/format';
import { useStore } from './useStore';

const TABS = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'holdings', label: 'Holdings', icon: 'list' },
  { id: 'dividends', label: 'Dividends', icon: 'coins' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'insights', label: 'Insights', icon: 'pie' },
  { id: 'planner', label: 'Planner', icon: 'trend' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const tabFromHash = (): Tab => {
  const h = location.hash.slice(1);
  return (TABS.find((t) => t.id === h)?.id ?? 'overview') as Tab;
};

export function App() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark = s.settings.theme === 'dark' || (s.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.theme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#070b1a' : '#e9eefb');
    };
    apply();
    root.style.setProperty('--glass-k', String(s.settings.glass));
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [s.settings.theme, s.settings.glass]);

  // Rendered twice: in the top bar on wide screens, as a floating bottom bar on phones. (A fixed bar can't live
  // inside the top bar: its backdrop-filter would make it the bar's containing block.)
  const nav = (where: 'top' | 'bottom') => (
    <nav className={`tabs ${where}`} aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined}>
                <Icon name={t.icon} /> <span>{t.label}</span>
              </a>
            ))}
          </nav>
  );
  const go = (t: string) => { location.hash = t; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const open = (sym: string) => setDetail(sym);
  const st = s.status;
  const connected = s.mode === 'server' && st?.connected;

  return (
    <PrivacyContext.Provider value={s.settings.privacy}>
      <div className="backdrop" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="shell">
        <header className="topbar glass">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">$</span>
            <span>Dividends</span>
          </div>
          {nav('top')}
          <div className="top-actions">
            {connected ? (
              <button className="sync-pill glass-chip" onClick={s.syncNow} disabled={s.busy || st?.syncing} title={st?.nextSync ? `Next automatic sync ${relativeTime(st.nextSync)}` : undefined}>
                <span className={`status-dot on ${s.busy || st?.syncing ? 'busy' : ''}`} />
                <span>{s.busy || st?.syncing ? 'Syncing…' : `Synced ${relativeTime(st?.lastSync ?? null)}`}</span>
                <Icon name="sync" size={15} />
              </button>
            ) : (
              <button className="sync-pill glass-chip" onClick={() => go('settings')}>
                <span className="status-dot" />
                <span>{s.mode === 'server' ? 'Connect Robinhood' : s.portfolio.source === 'demo' ? 'Sample data' : 'Offline'}</span>
              </button>
            )}
            <button className="icon-btn glass-chip" onClick={() => s.updateSettings({ privacy: !s.settings.privacy })} aria-label={s.settings.privacy ? 'Show amounts' : 'Hide amounts'} aria-pressed={s.settings.privacy}>
              <Icon name={s.settings.privacy ? 'eyeOff' : 'eye'} />
            </button>
          </div>
        </header>

        {s.portfolio.source === 'demo' && tab !== 'settings' && (
          <div className="banner glass-chip">
            <span>You're looking at a sample portfolio.</span>
            <button className="link-btn" onClick={() => go('settings')}>{s.mode === 'server' ? 'Connect Robinhood' : 'Use your own data'} →</button>
          </div>
        )}
        {s.error && (
          <div className="banner glass-chip error" role="alert">
            <Icon name="alert" size={16} /><span>{s.error}</span>
            <button className="icon-btn" onClick={() => s.setError(null)} aria-label="Dismiss"><Icon name="close" size={15} /></button>
          </div>
        )}

        <main>
          <h1 className="page-title">{TABS.find((t) => t.id === tab)?.label}</h1>
          {tab === 'overview' && <Overview s={s} openHolding={open} goTo={go} />}
          {tab === 'holdings' && <Holdings s={s} openHolding={open} />}
          {tab === 'dividends' && <Dividends s={s} openHolding={open} />}
          {tab === 'calendar' && <Calendar s={s} openHolding={open} />}
          {tab === 'insights' && <Insights s={s} openHolding={open} />}
          {tab === 'planner' && <Planner s={s} />}
          {tab === 'settings' && <Settings s={s} />}
        </main>
      </div>
      {nav('bottom')}
      {detail && <HoldingDetail s={s} symbol={detail} onClose={() => setDetail(null)} />}
    </PrivacyContext.Provider>
  );
}
