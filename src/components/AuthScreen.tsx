import { useState } from 'react';
import { cloudMessage } from '../cloud/firebase';
import type { Store } from '../useStore';
import { Icon, Segmented } from './ui';

type View = 'signIn' | 'signUp' | 'reset';

export function AuthScreen({ s }: { s: Store }) {
  const [view, setView] = useState<View>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const [code, setCode] = useState('');

  const attempt = async (fn: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    setNote(null);
    try { await fn(); } catch (err) { setError(cloudMessage(err)); } finally { setWorking(false); }
  };
  const google = () => attempt(async () => { const step = await s.cloud!.signInWithGoogle(); if (step) s.setSecondStep(step); });
  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    void attempt(async () => {
      if (!/^\d{6}$/.test(code.replace(/\s/g, ''))) throw Object.assign(new Error(), { code: 'auth/missing-code' });
      await s.secondStep!.finish(code);
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!s.cloud) return;
    setWorking(true);
    setError(null);
    setNote(null);
    try {
      if (view === 'signIn') { const step = await s.cloud.signIn(email, password); if (step) s.setSecondStep(step); }
      else if (view === 'signUp') await s.cloud.signUp(email, password);
      else {
        await s.cloud.resetPassword(email);
        setNote(`If ${email.trim()} has an account, a reset link is on its way. Check your inbox.`);
        setView('signIn');
      }
    } catch (err) {
      setError(cloudMessage(err));
    } finally {
      setWorking(false);
    }
  };

  const switchTo = (v: View) => { setView(v); setError(null); setNote(null); };

  return (
    <main className="auth">
      <div className="auth-brand">
        <span className="brand-mark big" aria-hidden="true">$</span>
        <h1>Dividends</h1>
        <p className="muted">Your dividend income, payouts and growth in one place. Links Robinhood and other brokerages securely through Plaid.</p>
      </div>

      {s.secondStep ? (
        <form className="glass auth-card form" onSubmit={verify}>
          <h2>Two-step verification</h2>
          <p className="muted small">Enter the 6-digit code from your authenticator app.</p>
          <label>Code
            <input id="auth-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </label>
          {error && <p className="error"><Icon name="alert" size={16} /> {error}</p>}
          <button className="btn primary wide" disabled={working}>{working ? 'Checking…' : 'Verify'}</button>
          <div className="auth-links"><button type="button" className="link-btn" onClick={() => { s.setSecondStep(null); setCode(''); setError(null); }}>Back to sign in</button></div>
        </form>
      ) : (
      <form className="glass auth-card form" onSubmit={submit}>
        {view === 'reset' ? (
          <h2>Reset your password</h2>
        ) : (
          <Segmented label="Account" value={view} onChange={switchTo}
            options={[{ value: 'signIn', label: 'Sign in' }, { value: 'signUp', label: 'Create account' }]} />
        )}
        <label>Email
          <input id="auth-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        {view !== 'reset' && (
          <label>Password
            <input id="auth-password" type="password" autoComplete={view === 'signUp' ? 'new-password' : 'current-password'}
              minLength={view === 'signUp' ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} required />
            {view === 'signUp' && <small className="muted">At least 8 characters.</small>}
          </label>
        )}
        {error && <p className="error"><Icon name="alert" size={16} /> {error}</p>}
        {note && <p className="note">{note}</p>}
        <button className="btn primary wide" disabled={working}>
          {working ? 'One moment…' : view === 'signIn' ? 'Sign in' : view === 'signUp' ? 'Create account' : 'Send reset link'}
        </button>
        <div className="auth-links">
          {view === 'signIn' && <button type="button" className="link-btn" onClick={() => switchTo('reset')}>Forgot password?</button>}
          {view === 'reset' && <button type="button" className="link-btn" onClick={() => switchTo('signIn')}>Back to sign in</button>}
        </div>
        {view !== 'reset' && (
          <>
            <div className="or"><span>or</span></div>
            <button type="button" className="btn wide google-btn" onClick={() => void google()} disabled={working}>
              <GoogleMark /> Continue with Google
            </button>
          </>
        )}
      </form>
      )}

      <button className="link-btn explore" onClick={() => s.setExploring(true)}>Look around with sample data first →</button>
      <p className="muted small auth-fine">
        Your portfolio is private to your account. The app gets read-only access to the brokerages you link and can't trade or move money.
        {' '}<a href="./privacy.html">Privacy policy</a>
      </p>
    </main>
  );
}

/** Google's "G", in its brand colors, for the sign-in button. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
