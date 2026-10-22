// Loads Plaid Link (Plaid's hosted sign-in) and runs it once. The user signs in on Plaid's and their broker's
// screens; the page only receives a one-time public token, which the server exchanges for read access.

const SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidHandler { open: () => void; destroy: () => void }
interface PlaidMetadata { institution?: { name: string; institution_id: string } | null }
interface PlaidGlobal {
  create: (opts: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string, metadata: PlaidMetadata) => void;
    onExit: (err: { display_message?: string | null; error_message?: string } | null) => void;
  }) => PlaidHandler;
}
declare global { interface Window { Plaid?: PlaidGlobal } }

let loading: Promise<PlaidGlobal> | null = null;

function loadPlaid(): Promise<PlaidGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error('Plaid Link failed to start.')));
    s.onerror = () => { loading = null; reject(new Error("Couldn't load Plaid. Check your connection or ad blocker.")); };
    document.head.appendChild(s);
  });
  return loading;
}

export interface LinkResult { publicToken: string; institution: { name: string; institution_id: string } | null }

// Some brokerages sign people in on their own site or app (OAuth). Plaid then sends the whole page there and back
// to this app with ?oauth_state_id=…, and Link has to be reopened with the same token to finish. The token (and,
// for a repair, which account) is saved before opening so the app can pick up where it left off.
const PENDING_KEY = 'dividends:plaid-link';
const PENDING_MAX_AGE = 30 * 60 * 1000;

export interface PendingLink { token: string; itemId?: string; at: number }

function savePending(p: PendingLink | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* storage blocked: OAuth return can't resume, but the normal flow still works */ }
}

/** The link to finish when the page has just come back from a brokerage's OAuth sign-in. */
export function pendingOAuthReturn(): PendingLink | null {
  if (!new URLSearchParams(location.search).has('oauth_state_id')) return null;
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null') as PendingLink | null;
    return p && Date.now() - p.at < PENDING_MAX_AGE ? p : null;
  } catch {
    return null;
  }
}

/** Drop ?oauth_state_id=… from the address bar once it has been used. */
export function clearOAuthReturn() {
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
}

function run(token: string, receivedRedirectUri?: string): Promise<LinkResult | null> {
  return loadPlaid().then((Plaid) => new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token,
      receivedRedirectUri,
      onSuccess: (publicToken, metadata) => {
        handler.destroy();
        savePending(null);
        resolve({ publicToken, institution: metadata.institution ?? null });
      },
      onExit: (err) => {
        handler.destroy();
        savePending(null);
        if (err) reject(new Error(err.display_message || err.error_message || 'Plaid closed with an error.'));
        else resolve(null);
      },
    });
    handler.open();
  }));
}

/** Opens Plaid Link. Resolves with the public token, or null if the user closed it. */
export function openPlaidLink(token: string, itemId?: string): Promise<LinkResult | null> {
  savePending({ token, itemId, at: Date.now() });
  return run(token);
}

/** Reopens Link after an OAuth sign-in to finish linking. */
export function resumePlaidLink(p: PendingLink): Promise<LinkResult | null> {
  const here = location.href;
  clearOAuthReturn();
  return run(p.token, here);
}
