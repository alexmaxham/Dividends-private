import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { importCsv } from '../lib/csv';
import { download } from '../lib/csv';
import { demoPortfolio } from '../lib/demo';
import { relativeTime } from '../lib/format';
import type { Portfolio } from '../lib/types';
import type { Store } from '../useStore';
import { Connect } from './Connect';
import { Card, Icon, Segmented } from './ui';

export function Settings({ s }: { s: Store }) {
  const { settings, updateSettings, status, mode } = s;
  const [connecting, setConnecting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState(settings.apiToken);
  const csvRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);
  const fromRobinhood = s.portfolio.source === 'robinhood';

  const onCsv = async (file: File) => {
    try {
      const r = importCsv(await file.text());
      const base: Portfolio = s.portfolio.source === 'demo' ? { holdings: [], dividends: [], history: [], cash: 0, source: 'manual', syncedAt: null } : s.portfolio;
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
      if (data.settings) updateSettings({ ...data.settings, apiToken: settings.apiToken });
      setNote('Backup restored.');
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  const changeServer = async (patch: { syncTime?: string; autoSync?: boolean }) => {
    try { s.setStatus(await api.settings(patch)); } catch (e) { s.setError((e as Error).message); }
  };

  const disconnect = async () => {
    if (!confirm('Disconnect Robinhood? Your synced data stays here until you load something else.')) return;
    try { s.setStatus(await api.logout()); } catch (e) { s.setError((e as Error).message); }
  };

  return (
    <div className="page settings">
      <Card title={<><Icon name="link" /> Robinhood</>}>
        {mode === 'server' && status?.needsToken && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); updateSettings({ apiToken: tokenDraft.trim() }); }}>
            <p className="muted">This server is protected. Enter the APP_TOKEN it was started with.</p>
            <label>Access token<input type="password" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} /></label>
            <div className="form-actions"><span className="spacer" /><button className="btn primary">Save</button></div>
          </form>
        )}
        {mode === 'server' && status && !status.needsToken && (
          <div className="form">
            <div className="conn">
              <span className={`status-dot ${status.connected ? 'on' : ''}`} />
              <div>
                <b>{status.connected ? `Connected${status.username ? ` as ${status.username}` : ''}` : 'Not connected'}</b>
                <small className="muted">
                  Last sync {relativeTime(status.lastSync)}
                  {status.nextSync && <> · next {relativeTime(status.nextSync)}</>}
                </small>
              </div>
              <span className="spacer" />
              {status.connected ? (
                <>
                  <button className="btn" onClick={s.syncNow} disabled={s.busy}><Icon name="sync" /> {s.busy ? 'Syncing…' : 'Sync now'}</button>
                  <button className="btn danger" onClick={disconnect}>Disconnect</button>
                </>
              ) : <button className="btn primary" onClick={() => setConnecting(true)}>Connect Robinhood</button>}
            </div>
            {status.lastError && <p className="error"><Icon name="alert" size={16} /> Last sync failed: {status.lastError}</p>}
            <div className="form">
              <label className="switch-row">
                <span>Update automatically every day</span>
                <input type="checkbox" className="switch" checked={status.settings.autoSync} onChange={(e) => changeServer({ autoSync: e.target.checked })} />
              </label>
              <label className="switch-row">Daily sync at
                <input type="time" value={status.settings.syncTime} onChange={(e) => e.target.value && changeServer({ syncTime: e.target.value })} disabled={!status.settings.autoSync} />
              </label>
            </div>
            <p className="muted small">After the 4 pm close is a good time. If the server was off at that time, it catches up the next time it runs.</p>
          </div>
        )}
        {mode === 'local' && (
          <div className="form">
            <p>Robinhood sync runs through a small server you run yourself, so your login and data never touch anyone else's computer. This page isn't connected to one.</p>
            <pre className="code">cd dividends{'\n'}npm install && npm run build{'\n'}python3 server/server.py</pre>
            <p className="muted small">Then open http://127.0.0.1:8787. Until then you can explore with the sample data, import a CSV, or add holdings by hand.</p>
          </div>
        )}
        {mode === 'loading' && <p className="muted">Looking for the sync server…</p>}
      </Card>

      <Card title={<><Icon name="target" /> Goals</>}>
        <div className="form-row">
          <label className="field">Monthly income goal
            <span className="input-affix"><i>$</i><input type="number" min={0} step={50} value={settings.monthlyGoal} onChange={(e) => updateSettings({ monthlyGoal: Number(e.target.value) })} /></span>
          </label>
          <label className="field">Dividend tax rate (for the planner)
            <span className="input-affix"><input type="number" min={0} max={60} value={settings.taxRate} onChange={(e) => updateSettings({ taxRate: Number(e.target.value) })} /><i>%</i></span>
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
            Showing <b>{s.portfolio.source === 'demo' ? 'sample data' : fromRobinhood ? 'your Robinhood portfolio' : 'your own data'}</b>.
            {fromRobinhood ? ' Synced data is read-only here; Robinhood is the source.' : ' Import Robinhood’s account activity report (Account → Reports and statements) for your dividend history, or a CSV with Symbol, Shares, Average Cost and Price columns for holdings.'}
          </p>
          <div className="btn-row">
            {!fromRobinhood && <button className="btn" onClick={() => csvRef.current?.click()}><Icon name="upload" /> Import CSV</button>}
            <button className="btn" onClick={() => download(`dividend-tracker-backup-${s.today}.json`, JSON.stringify({ portfolio: s.portfolio, settings: { ...settings, apiToken: '' } }, null, 1), 'application/json')}>
              <Icon name="download" /> Back up
            </button>
            <button className="btn" onClick={() => backupRef.current?.click()}>Restore backup</button>
            {!fromRobinhood && s.portfolio.source !== 'demo' && <button className="btn" onClick={() => { s.replacePortfolio(demoPortfolio()); setNote('Sample data loaded.'); }}>Load sample data</button>}
            {s.portfolio.source === 'demo' && (
              <button className="btn" onClick={() => { s.replacePortfolio({ holdings: [], dividends: [], history: [], cash: 0, source: 'manual', syncedAt: null }); setNote('Started fresh. Add holdings or import a CSV.'); }}>
                Start from scratch
              </button>
            )}
          </div>
          {note && <p className="note">{note}</p>}
          <input ref={csvRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onCsv(f); e.target.value = ''; }} />
          <input ref={backupRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onBackup(f); e.target.value = ''; }} />
        </div>
      </Card>

      {connecting && <Connect onClose={() => setConnecting(false)} onDone={async () => { await s.syncNow(); await s.refresh(); setConnecting(false); }} />}
    </div>
  );
}
