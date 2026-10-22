import { useEffect, useRef, useState } from 'react';
import { cloudMessage, type LinkedAccount, type TotpSetup } from '../cloud/firebase';
import { download, importCsv } from '../lib/csv';
import { demoPortfolio } from '../lib/demo';
import { dateLong, relativeTime } from '../lib/format';
import { openPlaidLink, resumePlaidLink, type LinkResult, type PendingLink } from '../lib/plaidLink';
import { disablePush, enablePush, isIos, isStandalone, pushActive, pushSupported } from '../lib/push';
import type { NotifySettings } from '../lib/types';
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

      {mode === 'cloud' && <NotificationsCard s={s} />}

      <Card title={<><Icon name="target" /> Goals and taxes</>}>
        <div className="form-row">
          <label className="field">Monthly income goal
            <span className="input-affix"><i>$</i><input id="goal" type="number" min={0} step={50} value={settings.monthlyGoal} onChange={(e) => updateSettings({ monthlyGoal: Number(e.target.value) })} /></span>
          </label>
          <label className="field">Qualified dividend tax rate
            <span className="input-affix"><input id="tax" type="number" min={0} max={40} value={settings.taxRate} onChange={(e) => updateSettings({ taxRate: Number(e.target.value) })} /><i>%</i></span>
          </label>
          <label className="field">Ordinary income tax rate
            <span className="input-affix"><input id="tax-ordinary" type="number" min={0} max={60} value={settings.ordinaryTaxRate} onChange={(e) => updateSettings({ ordinaryTaxRate: Number(e.target.value) })} /><i>%</i></span>
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
            <button className="btn" onClick={() => download(`dividends-backup-${s.today}.json`, JSON.stringify({ portfolio: s.allPortfolio, settings }, null, 1), 'application/json')}>
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
          {s.user?.providers.includes('password') && <button className="btn" onClick={() => setView(view === 'password' ? 'idle' : 'password')}>Change password</button>}
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
        <SignInOptions s={s} />
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

const TOPICS: { key: keyof NotifySettings; label: string; note: string }[] = [
  { key: 'payments', label: 'Payments', note: '"KO paid you $21.20"' },
  { key: 'raises', label: 'Dividend changes', note: '"PEP raised its dividend 5%", and cuts' },
  { key: 'reconnect', label: 'Reconnect reminders', note: 'When a brokerage sign-in expires' },
  { key: 'weekly', label: 'Weekly summary', note: 'Sunday evening: the week and what’s next' },
];

function NotificationsCard({ s }: { s: Store }) {
  const n = s.settings.notify;
  const set = (patch: Partial<NotifySettings>) => s.updateSettings({ notify: { ...n, ...patch } });
  const [here, setHere] = useState(false); // push is on for this device
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  useEffect(() => { void pushActive().then(setHere); }, []);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setWorking(true); setErr(null); setMsg(null);
    try { await fn(); if (done) setMsg(done); } catch (e) { setErr(cloudMessage(e)); } finally { setWorking(false); }
  };
  const togglePush = (on: boolean) => run(async () => {
    if (on) { await enablePush(s.call); set({ push: true }); setHere(true); }
    else { await disablePush(s.call); setHere(false); }
  });

  return (
    <Card title={<><Icon name="bell" /> Notifications</>}>
      <div className="form">
        <label className="switch-row">
          <span>Email <small className="muted">{s.user?.emailVerified ? s.user.email : 'verify your email address first'}</small></span>
          <input type="checkbox" className="switch" checked={n.email} onChange={(e) => set({ email: e.target.checked })} />
        </label>
        <label className="switch-row">
          <span>Push on this device <small className="muted">{pushSupported() ? 'alerts on this phone or computer' : isIos() && !isStandalone() ? 'add to your Home Screen first' : 'not supported in this browser'}</small></span>
          <input type="checkbox" className="switch" checked={here} disabled={working} onChange={(e) => void togglePush(e.target.checked)} />
        </label>
        {isIos() && !isStandalone() && (
          <p className="muted small">On iPhone, notifications work once Dividends is on your Home Screen: tap Share, then Add to Home Screen, and open it from there.</p>
        )}
        <div className="topic-list">
          {TOPICS.map((t) => (
            <label key={t.key} className="switch-row">
              <span>{t.label} <small className="muted">{t.note}</small></span>
              <input type="checkbox" className="switch" checked={n[t.key]} onChange={(e) => set({ [t.key]: e.target.checked })} />
            </label>
          ))}
        </div>
        <div><button className="btn" disabled={working} onClick={() => void run(() => s.call('testNotification'), 'Sent. It can take a minute to arrive.')}>Send a test</button></div>
        {msg && <p className="note">{msg}</p>}
        {err && <p className="error"><Icon name="alert" size={16} /> {err}</p>}
      </div>
    </Card>
  );
}

/** Google sign-in and two-step verification with an authenticator app. */
function SignInOptions({ s }: { s: Store }) {
  const cloud = s.cloud!;
  const [enrolled, setEnrolled] = useState(() => cloud.totpEnrolled());
  const [setup, setSetup] = useState<(TotpSetup & { qr: string }) | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const hasGoogle = s.user?.providers.includes('google.com');

  const run = async (fn: () => Promise<void>, done?: string) => {
    setWorking(true); setErr(null); setMsg(null);
    try { await fn(); if (done) setMsg(done); } catch (e) { setErr(cloudMessage(e)); } finally { setWorking(false); }
  };
  const start = () => run(async () => {
    const t = await cloud.startTotp();
    const QR = await import('qrcode');
    setSetup({ ...t, qr: await QR.toDataURL(t.url, { margin: 1, width: 336 }) });
  });
  const finish = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await setup!.finish(code);
      setSetup(null); setCode(''); setEnrolled(true);
    }, 'Two-step verification is on. You’ll enter a code from your app each time you sign in.');
  };
  const turnOff = () => {
    if (!confirm('Turn off two-step verification? Signing in will only need your password or Google.')) return;
    void run(async () => { await cloud.removeTotp(); setEnrolled(false); }, 'Two-step verification is off.');
  };

  return (
    <div className="form signin-options">
      <div className="conn">
        <div>
          <b>Google sign-in</b>
          <small className="muted">{hasGoogle ? 'On: you can sign in with your Google account' : 'Sign in with your Google account as well as your password'}</small>
        </div>
        <span className="spacer" />
        {!hasGoogle && <button className="btn" disabled={working} onClick={() => void run(() => cloud.linkGoogle(), 'Google sign-in added.')}>Add Google</button>}
      </div>
      <div className="conn">
        <div>
          <b>Two-step verification</b>
          <small className="muted">{enrolled ? 'On: a code from your authenticator app is needed to sign in' : 'Ask for a code from an authenticator app when you sign in'}</small>
        </div>
        <span className="spacer" />
        {enrolled
          ? <button className="btn" disabled={working} onClick={turnOff}>Turn off</button>
          : !setup && <button className="btn" disabled={working} onClick={() => void start()}><Icon name="shield" /> Set up</button>}
      </div>
      {setup && (
        <form className="form" onSubmit={finish}>
          <div className="totp-setup">
            <img src={setup.qr} alt="QR code to scan with your authenticator app" />
            <div className="form">
              <p className="small">Scan this with Google Authenticator, 1Password, Authy or your phone's password manager. Or enter this key:</p>
              <div className="totp-key">{setup.secretKey}</div>
              <p className="small"><a href={setup.url} className="link-btn">Open in an authenticator app on this device</a></p>
              <label>Code from the app<input id="totp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required /></label>
            </div>
          </div>
          <div className="form-actions"><span className="spacer" /><button type="button" className="btn" onClick={() => setSetup(null)}>Cancel</button><button className="btn primary" disabled={working}>Turn on</button></div>
        </form>
      )}
      {msg && <p className="note">{msg}</p>}
      {err && <p className="error"><Icon name="alert" size={16} /> {err}</p>}
    </div>
  );
}
