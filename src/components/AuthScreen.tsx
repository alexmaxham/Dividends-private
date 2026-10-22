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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!s.cloud) return;
    setWorking(true);
    setError(null);
    setNote(null);
    try {
      if (view === 'signIn') await s.cloud.signIn(email, password);
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
      </form>

      <button className="link-btn explore" onClick={() => s.setExploring(true)}>Look around with sample data first →</button>
      <p className="muted small auth-fine">
        Your portfolio is private to your account. The app gets read-only access to the brokerages you link and can't trade or move money.
        {' '}<a href="./privacy.html">Privacy policy</a>
      </p>
    </main>
  );
}
