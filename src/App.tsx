import { useEffect, useState } from 'react';
import { Calendar } from './components/Calendar';
import { Dividends } from './components/Dividends';
import { HoldingDetail } from './components/HoldingDetail';
import { Holdings } from './components/Holdings';
import { Insights } from './components/Insights';
import { Overview } from './components/Overview';
import { Planner } from './components/Planner';
import { AuthScreen } from './components/AuthScreen';
import { linkWithPlaid, resumeOAuthLink, Settings } from './components/Settings';
import { clearOAuthReturn, pendingOAuthReturn } from './lib/plaidLink';
import { Card, Icon, PrivacyContext } from './components/ui';
import { accountLabel } from './lib/accounts';
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
  const [menuOpen, setMenuOpen] = useState(false);

  // Back from a brokerage's own sign-in during Plaid linking: finish once the account is ready.
  useEffect(() => {
    if (s.mode === 'loading' || !location.search.includes('oauth_state_id')) return;
    const pending = pendingOAuthReturn();
    if (s.mode === 'cloud' && pending) void resumeOAuthLink(s, pending);
    else clearOAuthReturn();
  }, [s.mode]);

  useEffect(() => {
    const on = () => { setTab(tabFromHash()); setMenuOpen(false); };
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

  // The phone menu: close with Escape, and keep the page behind it from scrolling while it's open.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    document.body.classList.add('menu-open');
    return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('menu-open'); };
  }, [menuOpen]);
  const go = (t: string) => { location.hash = t; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const open = (sym: string) => setDetail(sym);
  const sync = s.profile.sync ?? {};
  const syncing = s.busy || !!sync.syncing;
  const needsReauth = s.profile.accounts?.some((a) => a.needsReauth);
  const isEmpty = s.mode === 'cloud' && s.portfolioLoaded && !s.linked && !s.portfolio.holdings.length && !s.portfolio.dividends.length;
  const signedOut = s.mode === 'signedOut' || s.mode === 'loading';

  if (s.mode === 'loading' || (s.mode === 'signedOut' && !s.exploring)) {
    return (
      <>
        <div className="backdrop" aria-hidden="true"><i /><i /><i /><i /></div>
        {s.mode === 'loading' ? <div className="splash"><span className="brand-mark big" aria-hidden="true">$</span></div> : <AuthScreen s={s} />}
      </>
    );
  }

  return (
    <PrivacyContext.Provider value={s.settings.privacy}>
      <div className="backdrop" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="shell">
        <header className="topbar glass">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">$</span>
            <span>Dividends</span>
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined}>
                <Icon name={t.icon} /> <span>{t.label}</span>
              </a>
            ))}
          </nav>
          <div className="top-actions">
            {s.mode === 'cloud' && s.linked && needsReauth ? (
              <button className="sync-pill glass-chip" onClick={() => go('settings')}>
                <span className="status-dot warn" />
                <span>Reconnect needed</span>
              </button>
            ) : s.mode === 'cloud' && s.linked ? (
              <button className="sync-pill glass-chip" onClick={s.syncNow} disabled={syncing} title="Updates every morning. Click to sync now.">
                <span className={`status-dot on ${syncing ? 'busy' : ''}`} />
                <span>{syncing ? 'Syncing…' : `Synced ${relativeTime(sync.lastSync ?? null)}`}</span>
                <Icon name="sync" size={15} />
              </button>
            ) : s.mode === 'cloud' ? (
              <button className="sync-pill glass-chip" onClick={() => linkWithPlaid(s)} disabled={s.busy}>
                <span className="status-dot" />
                <span>Link a brokerage</span>
              </button>
            ) : signedOut ? (
              <button className="sync-pill glass-chip" onClick={() => s.setExploring(false)}>
                <Icon name="user" size={15} />
                <span>Sign in</span>
              </button>
            ) : (
              <span className="sync-pill glass-chip"><span className="status-dot" /><span>{s.portfolio.source === 'demo' ? 'Sample data' : 'On this device'}</span></span>
            )}
            <button className="icon-btn glass-chip" onClick={() => s.updateSettings({ privacy: !s.settings.privacy })} aria-label={s.settings.privacy ? 'Show amounts' : 'Hide amounts'} aria-pressed={s.settings.privacy}>
              <Icon name={s.settings.privacy ? 'eyeOff' : 'eye'} />
            </button>
            <button className={`icon-btn glass-chip menu-btn ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen((o) => !o)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} aria-controls="menu-sheet">
              <span className="burger" aria-hidden="true"><i /><i /><i /></span>
            </button>
          </div>
        </header>

        {s.portfolio.source === 'demo' && tab !== 'settings' && (
          <div className="banner glass-chip">
            <span>You're looking at a sample portfolio.</span>
            {signedOut
              ? <button className="link-btn" onClick={() => s.setExploring(false)}>Sign in to track yours →</button>
              : <button className="link-btn" onClick={() => go('settings')}>Use your own data →</button>}
          </div>
        )}
        {s.error && (
          <div className="banner glass-chip error" role="alert">
            <Icon name="alert" size={16} /><span>{s.error}</span>
            <button className="icon-btn" onClick={() => s.setError(null)} aria-label="Dismiss"><Icon name="close" size={15} /></button>
          </div>
        )}

        <main>
          <div className="page-head">
            <h1 className="page-title">{TABS.find((t) => t.id === tab)?.label}</h1>
            {s.accounts.length > 1 && !['settings', 'taxes', 'watchlist'].includes(tab) && (
              <select className="glass-chip select account-pick" value={s.account} onChange={(e) => s.updateSettings({ account: e.target.value })} aria-label="Account">
                <option value="all">All accounts</option>
                {s.accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
              </select>
            )}
          </div>
          {tab === 'overview' && (isEmpty ? <Welcome s={s} goTo={go} /> : <Overview s={s} openHolding={open} goTo={go} />)}
          {tab === 'holdings' && <Holdings s={s} openHolding={open} />}
          {tab === 'dividends' && <Dividends s={s} openHolding={open} />}
          {tab === 'calendar' && <Calendar s={s} openHolding={open} />}
          {tab === 'insights' && <Insights s={s} openHolding={open} />}
          {tab === 'planner' && <Planner s={s} />}
          {tab === 'settings' && <Settings s={s} />}
        </main>
      </div>
      {/* Phone menu. Outside the top bar: the bar's backdrop-filter would otherwise become its containing block. */}
      <div className={`menu-scrim ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <nav id="menu-sheet" className={`menu-sheet glass ${menuOpen ? 'open' : ''}`} aria-label="Menu" aria-hidden={!menuOpen} inert={!menuOpen}>
        <ul className="menu-list">
          {TABS.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} className={tab === t.id ? 'on' : ''} aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => { setMenuOpen(false); window.scrollTo({ top: 0 }); }}>
                <Icon name={t.icon} size={20} />
                <span>{t.label}</span>
              </a>
            </li>
          ))}
        </ul>
        <div className="menu-foot">
          {s.mode === 'cloud' ? (
            <>
              <span className="menu-account"><Icon name="user" size={16} /> {s.user?.email}</span>
              <button className="btn" onClick={() => { setMenuOpen(false); void s.cloud?.signOut(); }}>Sign out</button>
            </>
          ) : signedOut ? (
            <button className="btn primary" onClick={() => { setMenuOpen(false); s.setExploring(false); }}>Sign in or create an account</button>
          ) : null}
        </div>
      </nav>
      {detail && <HoldingDetail s={s} symbol={detail} onClose={() => setDetail(null)} />}
    </PrivacyContext.Provider>
  );
}

/** First run for a signed-in person with nothing yet: the three ways to get their portfolio in. */
function Welcome({ s, goTo }: { s: ReturnType<typeof useStore>; goTo: (tab: string) => void }) {
  return (
    <div className="page">
      <Card className="welcome">
        <h2>Welcome{s.user?.email ? `, ${s.user.email.split('@')[0]}` : ''}</h2>
        <p className="muted">Bring in your portfolio to see your dividend income, upcoming payouts and growth.</p>
        <div className="welcome-options">
          <button className="welcome-option primary-option" onClick={() => linkWithPlaid(s)} disabled={s.busy}>
            <Icon name="link" size={22} />
            <b>Link Robinhood or another brokerage</b>
            <span>Securely through Plaid. Updates every morning.</span>
          </button>
          <button className="welcome-option" onClick={() => goTo('settings')}>
            <Icon name="upload" size={22} />
            <b>Import a CSV</b>
            <span>Robinhood's activity report or a list of holdings.</span>
          </button>
          <button className="welcome-option" onClick={() => goTo('holdings')}>
            <Icon name="plus" size={22} />
            <b>Add holdings by hand</b>
            <span>Type in what you own and log dividends as they arrive.</span>
          </button>
        </div>
      </Card>
    </div>
  );
}
