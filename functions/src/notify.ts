// Notifications: "KO paid you $21.20", "PEP raised its dividend 5%", "Robinhood needs you to reconnect", and a weekly
// summary. Sent by email (Resend) and as web push to devices that turned it on. Each event is sent once: what went
// out is logged in notifyLog/{uid}, which only Cloud Functions can read.

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { MarketDoc } from './market.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

export type EventKind = 'payments' | 'raises' | 'reconnect' | 'weekly' | 'test';

export interface NotifyEvent {
  kind: EventKind;
  /** Unique per event, for sending each one once. */
  key: string;
  title: string;
  body: string;
}

export interface NotifyPrefs {
  email: boolean;
  push: boolean;
  payments: boolean;
  raises: boolean;
  reconnect: boolean;
  weekly: boolean;
}

export const DEFAULT_PREFS: NotifyPrefs = { email: true, push: false, payments: true, raises: true, reconnect: true, weekly: true };
const DAY = 86400000;
const LOG_DAYS = 60;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n: number) => usd.format(n);
const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** New payments since the last sync, and dividend changes the companies you hold just announced. */
export function detectEvents(previous: Json | undefined, next: Json, market: Map<string, Pick<MarketDoc, 'dividends'>>, today: string): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  // Nothing about payments on the very first sync: everything would look new.
  if (previous?.dividends) {
    const seen = new Set((previous.dividends as Json[]).map((d) => d.id));
    const fresh = (next.dividends as Json[]).filter((d) => !seen.has(d.id) && d.state !== 'pending' && daysBetween(d.payDate, today) <= 7);
    if (fresh.length > 3) {
      const total = fresh.reduce((s, d) => s + d.amount, 0);
      out.push({
        kind: 'payments', key: `pay:${fresh.map((d) => d.id).sort().join(',')}`,
        title: `${fresh.length} dividends paid you ${money(total)}`,
        body: fresh.sort((a, b) => b.amount - a.amount).slice(0, 6).map((d) => `${d.symbol} ${money(d.amount)}`).join(', ') + (fresh.length > 6 ? ', …' : ''),
      });
    } else {
      for (const d of fresh) {
        out.push({ kind: 'payments', key: `pay:${d.id}`, title: `${d.symbol} paid you ${money(d.amount)}`, body: `Dividend received ${shortDate(d.payDate)}.` });
      }
    }
  }
  for (const h of (next.holdings ?? []) as Json[]) {
    const regular = (market.get(h.symbol)?.dividends ?? []).filter((d) => !d.special && d.amount > 0).sort((a, b) => b.exDate.localeCompare(a.exDate));
    const [latest, prior] = regular;
    // Only just-announced changes: declared in the last 10 days, or (without a declaration date) going ex soon.
    const recent = latest && (latest.declared ? daysBetween(latest.declared, today) <= 10 : latest.exDate >= today && daysBetween(today, latest.exDate) <= 30);
    if (!recent || !prior) continue;
    const change = (latest.amount / prior.amount - 1) * 100;
    if (Math.abs(change) < 0.5) continue;
    const up = change > 0;
    out.push({
      kind: 'raises', key: `div:${h.symbol}:${latest.exDate}`,
      title: `${h.symbol} ${up ? 'raised' : 'cut'} its dividend ${Math.abs(change).toFixed(1)}%`,
      body: `${money(prior.amount)} → ${money(latest.amount)} a share${latest.payDate ? `, starting with the ${shortDate(latest.payDate)} payment` : ''}. `
        + `About ${money((latest.amount - prior.amount) * h.shares * (latest.frequency || 4))} a year ${up ? 'more' : 'less'} for your ${round(h.shares)} shares.`,
    });
  }
  return out;
}

export function reconnectEvent(itemId: string, institution: string): NotifyEvent {
  return {
    kind: 'reconnect', key: `reauth:${itemId}`, title: `${institution} needs you to reconnect`,
    body: `Your ${institution} sign-in expired, so your portfolio has stopped updating. Open the app and choose Settings → Reconnect.`,
  };
}

/** Once a login works again, a later break should be announced again. */
export async function clearReconnectNotice(db: Firestore, uid: string, itemId: string): Promise<void> {
  await db.doc(`notifyLog/${uid}`).set({ sent: { [`reauth:${itemId}`]: FieldValue.delete() } }, { merge: true });
}

/** The week's dividends and what's declared for next week. */
export function weeklySummary(portfolio: Json, market: Map<string, Pick<MarketDoc, 'dividends'>>, today: string): NotifyEvent | null {
  const weekAgo = addDays(today, -7);
  const paid = ((portfolio.dividends ?? []) as Json[]).filter((d) => d.state !== 'pending' && d.state !== 'voided' && d.payDate > weekAgo && d.payDate <= today);
  const total = paid.reduce((s, d) => s + d.amount, 0);
  const nextWeek = addDays(today, 7);
  const coming: { symbol: string; amount: number; date: string }[] = [];
  for (const h of (portfolio.holdings ?? []) as Json[]) {
    for (const d of market.get(h.symbol)?.dividends ?? []) {
      if (d.payDate && d.payDate > today && d.payDate <= nextWeek) coming.push({ symbol: h.symbol, amount: d.amount * h.shares, date: d.payDate });
    }
  }
  const comingTotal = coming.reduce((s, c) => s + c.amount, 0);
  if (!paid.length && !coming.length) return null;
  const lines = [
    paid.length ? `This week: ${money(total)} from ${paid.length} payment${paid.length === 1 ? '' : 's'} (${paid.sort((a, b) => b.amount - a.amount).slice(0, 4).map((d) => d.symbol).join(', ')}${paid.length > 4 ? ', …' : ''}).` : 'No dividends this week.',
    coming.length ? `Next week: ${money(comingTotal)} declared from ${coming.map((c) => c.symbol).join(', ')}.` : '',
  ].filter(Boolean);
  return { kind: 'weekly', key: `week:${today}`, title: paid.length ? `Your week in dividends: ${money(total)}` : `Next week: ${money(comingTotal)} in dividends`, body: lines.join(' ') };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

// ───────────── Delivery ─────────────

export interface Senders {
  /** Sends one email; resolves when accepted. */
  email?: (to: string, subject: string, text: string, html: string) => Promise<void>;
  /** Sends one push message; rejects with { statusCode: 404 | 410 } when the subscription is gone. */
  push?: (subscription: Json, payload: string) => Promise<void>;
}

export interface Recipient { email: string | null; emailVerified: boolean }

/** Sends whichever events this person wants and hasn't been sent yet. Returns the keys sent. */
export async function deliver(db: Firestore, uid: string, events: NotifyEvent[], who: Recipient, senders: Senders, now = new Date()): Promise<string[]> {
  if (!events.length) return [];
  const prefs: NotifyPrefs = { ...DEFAULT_PREFS, ...((await db.doc(`users/${uid}`).get()).get('settings.notify') ?? {}) };
  const logRef = db.doc(`notifyLog/${uid}`);
  const log: Record<string, string> = (await logRef.get()).get('sent') ?? {};
  // A test goes out whatever the topic switches say; only the channels (email, push) apply.
  const wanted = events.filter((e) => (e.kind === 'test' || prefs[e.kind]) && !log[e.key]);
  if (!wanted.length) return [];

  const email = prefs.email && senders.email && who.email && who.emailVerified ? who.email : null;
  const subs = prefs.push && senders.push ? await db.collection('pushSubs').where('uid', '==', uid).get() : null;
  if (!email && !subs?.size) return [];

  for (const e of wanted) {
    if (email) await senders.email!(email, e.title, `${e.body}\n\nOpen Dividends: ${APP_URL}`, emailHtml(e));
    for (const s of subs?.docs ?? []) {
      try {
        await senders.push!(s.get('subscription'), JSON.stringify({ title: e.title, body: e.body, tag: e.kind, url: APP_URL }));
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await s.ref.delete(); // the browser unsubscribed
        else throw err;
      }
    }
    log[e.key] = now.toISOString();
  }
  const cutoff = new Date(now.getTime() - LOG_DAYS * DAY).toISOString();
  const kept = Object.fromEntries(Object.entries(log).filter(([, at]) => at >= cutoff));
  await logRef.set({ sent: kept });
  return wanted.map((e) => e.key);
}

export const APP_URL = 'https://alexmaxham.github.io/Dividends-private/';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function emailHtml(e: NotifyEvent): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0b1020">
<p style="font-size:13px;color:#5b6480;margin:0 0 6px">Dividends</p>
<h1 style="font-size:20px;margin:0 0 12px">${esc(e.title)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 20px">${esc(e.body)}</p>
<a href="${APP_URL}" style="display:inline-block;background:#3b6cf6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600">Open Dividends</a>
<p style="font-size:12px;color:#8a92ab;margin:24px 0 0">You're getting this because notifications are on in Settings → Notifications.</p>
</div>`;
}

/** Resend's HTTP API (https://resend.com). */
export function resendSender(apiKey: string, from: string, fetcher: typeof fetch = fetch): NonNullable<Senders['email']> {
  return async (to, subject, text, html) => {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
    if (res.status >= 400) throw new Error(`Email failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  };
}
