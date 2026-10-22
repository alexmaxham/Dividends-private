import { useRef, useState } from 'react';
import { cloudMessage, type LinkedAccount } from '../cloud/firebase';
import { download, importCsv } from '../lib/csv';
import { demoPortfolio } from '../lib/demo';
import { dateLong, relativeTime } from '../lib/format';
import { openPlaidLink, resumePlaidLink, type LinkResult, type PendingLink } from '../lib/plaidLink';
import { isSynced, type Portfolio } from '../lib/types';
import { EMPTY_PORTFOLIO, type Store } from '../useStore';
import { Card, Icon, Segmented } from './ui';

/** Runs Plaid Link: a new connection, or (with itemId) update mode to repair one whose login expired. */
export async function linkWithPlaid(s: Store, itemId?: string) {
  s.setError(null);
  s.setBusy(true);
  try {
    const { linkToken } = await s.call<{ linkToken: string }>('plaidLinkToken', itemId ? { itemId } : {});
    await finishLink(s, await openPlaidLink(linkToken, itemId), itemId);
  } catch (e) {
    s.setError(cloudMessage(e));
  } finally {
    s.setBusy(false);
  }
}

/** Picks Link back up when a brokerage's own sign-in (OAuth) returns to the app. */
export async function resumeOAuthLink(s: Store, pending: PendingLink) {
  s.setError(null);
  s.setBusy(true);
  try {
    await finishLink(s, await resumePlaidLink(pending), pending.itemId);
  } catch (e) {
    s.setError(cloudMessage(e));
  } finally {
    s.setBusy(false);
  }
}

async function finishLink(s: Store, result: LinkResult | null, itemId?: string) {
  if (!result) return;
  if (itemId) await s.call('plaidRepaired', { itemId });
  else await s.call('plaidExchange', { publicToken: result.publicToken, institution: result.institution });
}

export function Settings({ s }: { s: Store }) {
  const { settings, updateSettings, mode } = s;
  const [note, setNote] = useState<string | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);
  const synced = isSynced(s.portfolio) || s.linked;
  const canEdit = !synced && mode !== 'signedOut' && mode !== 'loading';

  const onCsv = async (file: File) => {
    try {
      const r = importCsv(await file.text());
      const base: Portfolio = s.portfolio.source === 'demo' ? EMPTY_PORTFOLIO : s.portfolio;
      if (r.kind === 'dividends') {
        const seen = new Set(base.dividends.map((d) => `${d.symbol}|${d.payDate}|${d.amount.toFixed(2)}`));
        const fresh = r.dividends.filter((d) => !seen.has(`${d.symbol}|${d.payDate}|${d.amount.toFixed(2)}`));
        s.replacePortfolio({ ...base, source: 'manual', dividends: [...base.dividends, ...fresh].sort((a, b) => b.payDate.localeCompare(a.payDate)) });
        setNote(`Imported ${fresh.length} dividends${r.dividends.length - fresh.length ? ` (${r.dividends.length - fresh.length} already there)` : ''}.`);
      } else {
        const bySymbol = new Map(base.holdings.map((h) => [h.symbol, h]));
        for (const h of r.holdings) bySymbol.set(h.symbol, h);
        s.replacePortfolio({ ...base, source: 'manual', holdings: [...bySymbol.values()] });
        setNote(`Imported ${r.holdings.length} holdings.`);
      }
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  const onBackup = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.portfolio?.holdings)) throw new Error('Not a dividend tracker backup.');
      s.replacePortfolio(data.portfolio);
      if (data.settings) updateSettings(data.settings);
      setNote('Backup restored.');
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <div className="page settings">
      {mode === 'cloud' && <AccountCard s={s} />}

      <Card title={<><Icon name="link" /> Brokerage accounts</>}>
        {mode === 'cloud' ? (
          <PlaidPanel s={s} />
        ) : mode === 'local' ? (
          <p className="muted">Linking Robinhood and other brokerages needs accounts, which aren't set up on this copy of the app. See the README to connect it to Firebase.</p>
        ) : (
          <div className="form">
            <p>Sign in to link Robinhood or another brokerage with Plaid. Your portfolio then updates every morning and follows you to any device.</p>
            <div><button className="btn primary" onClick={() => s.setExploring(false)}>Sign in or create an account</button></div>
          </div>
        )}
      </Card>

      <Card title={<><Icon name="target" /> Goals</>}>
        <div className="form-row">
          <label className="field">Monthly income goal
            <span className="input-affix"><i>$</i><input id="goal" type="number" min={0} step={50} value={settings.monthlyGoal} onChange={(e) => updateSettings({ monthlyGoal: Number(e.target.value) })} /></span>
          </label>
          <label className="field">Dividend tax rate (for the planner)
            <span className="input-affix"><input id="tax" type="number" min={0} max={60} value={settings.taxRate} onChange={(e) => updateSettings({ taxRate: Number(e.target.value) })} /><i>%</i></span>
          </label>
        </div>
      </Card>

      <Card title={<><Icon name="eye" /> Appearance</>}>
        <div className="form">
          <div className="setting-line">
            <span>Theme</span>
            <Segmented label="Theme" value={settings.theme} onChange={(theme) => updateSettings({ theme })}
              options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
          </div>
          <label className="field">
            <span>Glass <b>{settings.glass < 0.8 ? 'Clear' : settings.glass > 1.2 ? 'Frosted' : 'Balanced'}</b></span>
            <input type="range" min={0.4} max={1.6} step={0.05} value={settings.glass} onChange={(e) => updateSettings({ glass: Number(e.target.value) })}
              style={{ ['--p' as string]: `${((settings.glass - 0.4) / 1.2) * 100}%` }} />
          </label>
          <label className="switch-row">
            <span>Privacy mode <small className="muted">hides dollar amounts</small></span>
            <input type="checkbox" className="switch" checked={settings.privacy} onChange={(e) => updateSettings({ privacy: e.target.checked })} />
          </label>
        </div>
      </Card>

      <Card title={<><Icon name="upload" /> Data</>}>
        <div className="form">
          <p className="muted small">
            Showing <b>{s.portfolio.source === 'demo' ? 'sample data' : synced ? 'your synced portfolio' : 'your own data'}</b>
            {mode === 'cloud' ? ', saved to your account.' : mode === 'local' ? ', saved in this browser.' : '.'}
            {synced ? ' Synced data is read-only here; your brokerage is the source.'
              : canEdit ? ' Import Robinhood’s account activity report (Account → Reports and statements) for your dividend history, or a CSV with Symbol, Shares, Average Cost and Price columns for holdings.' : ''}
          </p>
          <div className="btn-row">
            {canEdit && <button className="btn" onClick={() => csvRef.current?.click()}><Icon name="upload" /> Import CSV</button>}
            <button className="btn" onClick={() => download(`dividends-backup-${s.today}.json`, JSON.stringify({ portfolio: s.portfolio, settings }, null, 1), 'application/json')}>
              <Icon name="download" /> Back up
            </button>
            {canEdit && <button className="btn" onClick={() => backupRef.current?.click()}>Restore backup</button>}
            {mode === 'local' && s.portfolio.source !== 'demo' && (
              <button className="btn" onClick={() => { s.replacePortfolio(demoPortfolio()); setNote('Sample data loaded.'); }}>Load sample data</button>
            )}
            {canEdit && (s.portfolio.source === 'demo' || s.portfolio.holdings.length > 0) && (
              <button className="btn" onClick={() => {
                if (s.portfolio.source !== 'demo' && !confirm('Clear all holdings and dividends? Back up first if you might want them.')) return;
                s.replacePortfolio(EMPTY_PORTFOLIO);
                setNote('Started fresh. Add holdings or import a CSV.');
              }}>Start from scratch</button>
            )}
          </div>
          {note && <p className="note">{note}</p>}
          <input ref={csvRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onCsv(f); e.target.value = ''; }} />
          <input ref={backupRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onBackup(f); e.target.value = ''; }} />
        </div>
      </Card>
    </div>
  );
}

function PlaidPanel({ s }: { s: Store }) {
  const accounts: LinkedAccount[] = s.profile.accounts ?? [];
  const sync = s.profile.sync ?? {};

  const unlink = async (a: LinkedAccount) => {
    if (!confirm(`Unlink ${a.institution}? Plaid's access is revoked right away. Your synced history stays in your account.`)) return;
    s.setBusy(true);
    try { await s.call('plaidUnlink', { itemId: a.itemId }); } catch (e) { s.setError(cloudMessage(e)); } finally { s.setBusy(false); }
  };

  return (
    <div className="form">
      <div className="trust">
        <Icon name="shield" size={22} />
        <div>
          <b>Connected securely with Plaid</b>
          <p className="muted small">
            You sign in on Plaid's and your brokerage's own screens. This app never sees your brokerage password; it gets
            read-only access to holdings and investment transactions, and can't trade or move money. Unlink here or at my.plaid.com any time.
          </p>
        </div>
      </div>
      {accounts.length > 0 && (
        <ul className="rows compact">
          {accounts.map((a) => (
            <li key={a.itemId}>
              <span className={`status-dot ${a.needsReauth ? 'warn' : 'on'}`} />
              <div className="row-main">
                <b>{a.institution}</b>
                <small>{a.needsReauth ? 'Sign-in expired. Reconnect to keep syncing.' : `Linked ${dateLong(a.linkedAt.slice(0, 10))}`}</small>
              </div>
              {a.needsReauth && <button className="btn primary" onClick={() => linkWithPlaid(s, a.itemId)} disabled={s.busy}>Reconnect</button>}
              <button className="btn danger" onClick={() => unlink(a)} disabled={s.busy}>Unlink</button>
            </li>
          ))}
        </ul>
      )}
      <div className="conn">
        <div>
          <b>{accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'} linked` : 'No accounts linked yet'}</b>
          <small className="muted">
            {accounts.length ? <>Last sync {relativeTime(sync.lastSync ?? null)} · updates every morning</> : 'Robinhood, Fidelity, Schwab, Vanguard and most other US brokerages'}
          </small>
        </div>
        <span className="spacer" />
        {accounts.length > 0 && (
          <button className="btn" onClick={s.syncNow} disabled={s.busy || sync.syncing}><Icon name="sync" /> {s.busy || sync.syncing ? 'Syncing…' : 'Sync now'}</button>
        )}
        <button className={`btn ${accounts.length ? '' : 'primary'}`} onClick={() => linkWithPlaid(s)} disabled={s.busy}>
          <Icon name="link" /> {accounts.length ? 'Link another account' : 'Link a brokerage'}
        </button>
      </div>
      {sync.lastError && <p className="error"><Icon name="alert" size={16} /> {sync.lastError}</p>}
      {!s.linked && s.portfolio.holdings.length > 0 && (
        <p className="muted small">Linking replaces the holdings you entered by hand with the ones from your brokerage.</p>
      )}
    </div>
  );
}

function AccountCard({ s }: { s: Store }) {
  const [view, setView] = useState<'idle' | 'password' | 'delete'>('idle');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setWorking(true);
    setErr(null);
    try { await fn(); setMsg(done); setView('idle'); setCurrent(''); setNext(''); } catch (e) { setErr(cloudMessage(e)); } finally { setWorking(false); }
  };

  return (
    <Card title={<><Icon name="user" /> Account</>}>
      <div className="form">
        <div className="conn">
          <div>
            <b>{s.user?.email}</b>
            <small className="muted">{s.user?.emailVerified ? 'Email verified' : 'Check your inbox to verify your email'}</small>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={() => setView(view === 'password' ? 'idle' : 'password')}>Change password</button>
          <button className="btn" onClick={() => s.cloud?.signOut()}>Sign out</button>
        </div>
        {view === 'password' && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => s.cloud!.changePassword(current, next), 'Password changed.'); }}>
            <div className="form-row">
              <label>Current password<input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
              <label>New password<input id="pw-new" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
            </div>
            <div className="form-actions"><span className="spacer" /><button type="button" className="btn" onClick={() => setView('idle')}>Cancel</button><button className="btn primary" disabled={working}>Save password</button></div>
          </form>
        )}
        {view === 'delete' ? (
          <form className="form danger-zone" onSubmit={(e) => { e.preventDefault(); void run(() => s.call('deleteAccount').then(() => s.cloud?.signOut()), 'Account deleted.'); }}>
            <p><b>Delete your account?</b> This unlinks every brokerage at Plaid and permanently erases your portfolio, history and settings. It can't be undone.</p>
            <label>Type DELETE to confirm<input id="delete-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" /></label>
            <div className="form-actions"><span className="spacer" /><button type="button" className="btn" onClick={() => setView('idle')}>Cancel</button><button className="btn danger" disabled={working || confirmText !== 'DELETE'}>{working ? 'Deleting…' : 'Delete account'}</button></div>
          </form>
        ) : (
          <div><button className="link-btn danger-link" onClick={() => setView('delete')}>Delete account…</button></div>
        )}
        {msg && <p className="note">{msg}</p>}
        {err && <p className="error"><Icon name="alert" size={16} /> {err}</p>}
        <p className="muted small"><a href="./privacy.html" className="link-btn">Privacy policy</a></p>
      </div>
    </Card>
  );
}
