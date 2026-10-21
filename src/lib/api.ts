import type { Portfolio } from './types';

export interface ServerStatus {
  server: true;
  needsToken?: boolean;
  connected: boolean;
  username?: string | null;
  syncing: boolean;
  lastSync: string | null;
  lastError: string | null;
  nextSync: string | null;
  settings: { syncTime: string; autoSync: boolean };
}

export type LoginResult = { status: 'ok' } | { status: 'mfa_required' } | { status: 'challenge'; type: 'sms' | 'email' | 'prompt'; waiting?: boolean };

let token = '';
export const setApiToken = (t: string) => { token = t; };

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`./api/${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new NoServer();
    const data = await res.json();
    if (!res.ok && !(path === 'status' && data?.needsToken)) throw new Error(data?.error || `Request failed (${res.status})`);
    return data as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('The server took too long to answer.');
    if (e instanceof TypeError) throw new NoServer();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown when the page isn't served by the Python server (e.g. the GitHub Pages demo). */
export class NoServer extends Error {
  constructor() { super('No sync server'); }
}

export const api = {
  status: () => call<ServerStatus>('GET', 'status', undefined, 5000),
  portfolio: () => call<Portfolio | null>('GET', 'portfolio'),
  login: (username: string, password: string, mfaCode?: string) => call<LoginResult>('POST', 'robinhood/login', { username, password, mfaCode }),
  verify: (code?: string) => call<LoginResult>('POST', 'robinhood/verify', { code }),
  logout: () => call<ServerStatus>('POST', 'robinhood/logout', {}),
  sync: () => call<Portfolio>('POST', 'sync', {}, 180000),
  settings: (s: Partial<ServerStatus['settings']>) => call<ServerStatus>('PUT', 'settings', s),
};
