import { useEffect, useState } from 'react';
import { api, type LoginResult } from '../lib/api';
import { Icon, Modal } from './ui';

type Step = { kind: 'credentials' } | { kind: 'mfa' } | { kind: 'code'; channel: 'sms' | 'email' } | { kind: 'prompt' } | { kind: 'syncing' };

/** Robinhood sign-in: email + password, then whichever verification Robinhood asks for. */
export function Connect({ onDone, onClose }: { onDone: () => Promise<void>; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handle = async (r: LoginResult) => {
    setCode('');
    if (r.status === 'ok') {
      setPassword('');
      setStep({ kind: 'syncing' });
      await onDone();
      return;
    }
    if (r.status === 'mfa_required') setStep({ kind: 'mfa' });
    else if (r.type === 'prompt') setStep({ kind: 'prompt' });
    else setStep({ kind: 'code', channel: r.type });
  };

  const run = async (fn: () => Promise<LoginResult>) => {
    setBusy(true);
    setError(null);
    try { await handle(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  // App approval: poll every 4 seconds until the user taps "Yes, it's me" in the Robinhood app.
  useEffect(() => {
    if (step.kind !== 'prompt') return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api.verify();
        if (!stop && !(r.status === 'challenge' && r.waiting)) return handle(r);
      } catch (e) {
        if (!stop) setError((e as Error).message);
        return;
      }
      if (!stop) setTimeout(tick, 4000);
    };
    const t = setTimeout(tick, 4000);
    return () => { stop = true; clearTimeout(t); };
  }, [step.kind]);

  return (
    <Modal title="Connect Robinhood" onClose={onClose}>
      {step.kind === 'credentials' && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => api.login(username, password)); }}>
          <p className="muted">
            Your sign-in goes only to your own sync server, which passes it to Robinhood. The password isn't saved;
            the server keeps Robinhood's session token so it can refresh your portfolio each day. Access is read-only.
          </p>
          <label>Email<input type="email" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          {error && <p className="error"><Icon name="alert" size={16} /> {error}</p>}
          <div className="form-actions"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></div>
        </form>
      )}
      {(step.kind === 'mfa' || step.kind === 'code') && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void run(() => api.verify(code)); }}>
          <p className="muted">
            {step.kind === 'mfa' ? 'Enter the 6-digit code from your authenticator app.' : `Robinhood sent a code by ${step.channel === 'sms' ? 'text message' : 'email'}. Enter it here.`}
          </p>
          <label>Code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} required autoFocus maxLength={8} className="code-input" /></label>
          {error && <p className="error"><Icon name="alert" size={16} /> {error}</p>}
          <div className="form-actions">
            <button type="button" className="link-btn" onClick={() => { setStep({ kind: 'credentials' }); setError(null); }}>Start over</button>
            <span className="spacer" />
            <button className="btn primary" disabled={busy || !code}>{busy ? 'Checking…' : 'Verify'}</button>
          </div>
        </form>
      )}
      {step.kind === 'prompt' && (
        <div className="form center">
          <div className="pulse"><Icon name="check" size={28} /></div>
          <p>Open the Robinhood app on your phone and approve this sign-in.</p>
          <p className="muted small">Waiting for approval…</p>
          {error && <p className="error"><Icon name="alert" size={16} /> {error}</p>}
          <button className="link-btn" onClick={() => { setStep({ kind: 'credentials' }); setError(null); }}>Start over</button>
        </div>
      )}
      {step.kind === 'syncing' && (
        <div className="form center">
          <div className="pulse spin"><Icon name="sync" size={28} /></div>
          <p>Connected. Pulling your holdings and dividend history…</p>
        </div>
      )}
    </Modal>
  );
}
