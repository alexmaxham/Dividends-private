import type { Dividend, Holding } from './types';

/** RFC 4180-ish parser: quoted fields, escaped quotes, CRLF, and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const num = (s: string | undefined) => {
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s.trim());
  const n = Number(s.replace(/[$,()\s]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
};

function usDate(s: string): string {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return s.trim().slice(0, 10);
}

export interface ImportResult {
  kind: 'dividends' | 'holdings';
  dividends: Dividend[];
  holdings: Holding[];
  skipped: number;
}

/**
 * Understands two files:
 *  - Robinhood's account activity report (Account → Reports and statements → Reports): rows with
 *    Trans Code CDIV (cash dividend) become dividends.
 *  - A holdings list with columns like Symbol, Shares/Quantity, Average Cost, Price, Sector.
 */
export function importCsv(text: string): ImportResult {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (!rows.length) throw new Error('The file is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));

  const code = col('trans code', 'transaction code', 'type');
  if (code >= 0 && col('instrument') >= 0) {
    const inst = col('instrument'), date = col('activity date', 'date'), amount = col('amount'),
      desc = col('description'), qty = col('quantity');
    const dividends: Dividend[] = [];
    let skipped = 0;
    rows.slice(1).forEach((r, i) => {
      const c = (r[code] || '').trim().toUpperCase();
      if (c !== 'CDIV' && c !== 'DIV') { skipped++; return; }
      const d = desc >= 0 ? r[desc] || '' : '';
      // "Cash Div: R/D 2026-06-13 P/D 2026-07-01 - 10 shares at 0.51"
      const pd = d.match(/P\/D (\d{4}-\d{2}-\d{2})/)?.[1];
      const rd = d.match(/R\/D (\d{4}-\d{2}-\d{2})/)?.[1];
      const sh = Number(d.match(/([\d.,]+) shares? at/)?.[1]?.replace(/,/g, '')) || num(r[qty]);
      const rate = Number(d.match(/at ([\d.]+)/)?.[1]) || 0;
      const amt = num(r[amount]);
      if (!r[inst]?.trim() || amt <= 0) { skipped++; return; }
      dividends.push({
        id: `csv-${r[inst].trim()}-${pd || usDate(r[date])}-${i}`,
        symbol: r[inst].trim().toUpperCase(), amount: amt, rate: rate || (sh ? amt / sh : 0), shares: sh,
        state: 'paid', payDate: pd || usDate(r[date]), recordDate: rd,
      });
    });
    return { kind: 'dividends', dividends, holdings: [], skipped };
  }

  const sym = col('symbol', 'ticker', 'instrument');
  const qty = col('shares', 'quantity', 'qty');
  if (sym < 0 || qty < 0) {
    throw new Error('Unrecognized file. Use a Robinhood activity report, or a CSV with Symbol and Shares columns.');
  }
  const cost = col('average cost', 'avg cost', 'average_buy_price', 'cost basis per share', 'avgcost');
  const price = col('price', 'last price', 'current price');
  const name = col('name', 'description');
  const sector = col('sector');
  const yld = col('dividend yield', 'yield');
  const holdings: Holding[] = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const s = r[sym]?.trim().toUpperCase();
    const q = num(r[qty]);
    if (!s || q <= 0) { skipped++; continue; }
    const p = price >= 0 ? num(r[price]) : 0;
    const c = cost >= 0 ? num(r[cost]) : p;
    holdings.push({
      symbol: s, name: name >= 0 ? r[name]?.trim() || s : s, shares: q, avgCost: c, price: p || c, prevClose: p || c,
      dividendYield: yld >= 0 ? num(r[yld]) : 0, sector: sector >= 0 ? r[sector]?.trim() || 'Other' : 'Other',
    });
  }
  return { kind: 'holdings', dividends: [], holdings, skipped };
}

const esc = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

export function download(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
