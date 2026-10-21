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

/** Opens Plaid Link. Resolves with the public token, or null if the user closed it. */
export async function openPlaidLink(token: string): Promise<LinkResult | null> {
  const Plaid = await loadPlaid();
  return new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token,
      onSuccess: (publicToken, metadata) => { handler.destroy(); resolve({ publicToken, institution: metadata.institution ?? null }); },
      onExit: (err) => {
        handler.destroy();
        if (err) reject(new Error(err.display_message || err.error_message || 'Plaid closed with an error.'));
        else resolve(null);
      },
    });
    handler.open();
  });
}
