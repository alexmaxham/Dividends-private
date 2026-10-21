const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

export const money = (n: number) => usd.format(n || 0);
export const money0 = (n: number) => (Math.abs(n) >= 1000 ? usd0.format(n || 0) : usd.format(n || 0));
export const moneyCompact = (n: number) => (Math.abs(n) >= 10000 ? compact.format(n) : usd0.format(n));
export const signedMoney = (n: number) => `${n >= 0 ? '+' : '−'}${usd.format(Math.abs(n))}`;
export const pct = (n: number, digits = 2) => `${(n || 0).toFixed(digits)}%`;
export const signedPct = (n: number, digits = 2) => `${n >= 0 ? '+' : '−'}${Math.abs(n || 0).toFixed(digits)}%`;
export const shares = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(n < 1 ? 4 : 3).replace(/0+$/, ''));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthShort = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1];
export const monthLong = (ym: string) =>
  new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const dateShort = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
export const dateLong = (d: string) => `${dateShort(d)}, ${d.slice(0, 4)}`;

export function relativeTime(isoTime: string | null, now = Date.now()): string {
  if (!isoTime) return 'never';
  const s = Math.round((now - new Date(isoTime).getTime()) / 1000);
  if (s < 0) {
    const ahead = -s;
    if (ahead < 3600) return `in ${Math.max(1, Math.round(ahead / 60))} min`;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)} h`;
    return `in ${Math.round(ahead / 86400)} d`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const FREQ_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Semi-annual', annual: 'Annual', none: '—' } as const;
