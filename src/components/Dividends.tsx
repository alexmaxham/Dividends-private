import { useMemo, useState } from 'react';
import { isReceived, monthKey } from '../lib/analytics';
import { download, toCsv } from '../lib/csv';
import { dateShort, money, monthLong, shares as fmtShares } from '../lib/format';
import { isSynced, type Dividend } from '../lib/types';
import type { Store } from '../useStore';
import { Card, Empty, Icon, Modal, Money, Segmented, Ticker } from './ui';

type View = 'history' | 'upcoming';
type StateFilter = 'all' | 'received' | 'pending';

interface Line { key: string; symbol: string; date: string; amount: number; rate: number; shares?: number; label: string; tone: string; id?: string; drip?: boolean }

export function Dividends({ s, openHolding }: { s: Store; openHolding: (sym: string) => void }) {
  const [view, setView] = useState<View>('history');
  const [year, setYear] = useState('all');
  const [state, setState] = useState<StateFilter>('all');
  const [q, setQ] = useState('');
  const [logging, setLogging] = useState(false);
  const editable = !isSynced(s.portfolio);

  const years = useMemo(() => [...new Set(s.portfolio.dividends.map((d) => d.payDate.slice(0, 4)))].sort().reverse(), [s.portfolio.dividends]);

  const lines: Line[] = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (view === 'upcoming') {
      return s.payouts.filter((p) => !needle || p.symbol.includes(needle)).map((p) => ({
        key: `${p.symbol}-${p.date}-${p.kind}`, symbol: p.symbol, date: p.date, amount: p.amount, rate: p.rate,
        label: p.kind === 'confirmed' ? 'Confirmed' : 'Estimated', tone: p.kind === 'confirmed' ? 'ok' : '',
      }));
    }
    return s.portfolio.dividends
      .filter((d) => d.state !== 'voided')
      .filter((d) => year === 'all' || d.payDate.startsWith(year))
      .filter((d) => state === 'all' || (state === 'received' ? isReceived(d) : d.state === 'pending'))
      .filter((d) => !needle || d.symbol.includes(needle))
      .map((d) => ({
        key: d.id, id: d.id, symbol: d.symbol, date: d.payDate, amount: d.amount, rate: d.rate, shares: d.shares, drip: d.drip,
        label: d.state === 'pending' ? 'Upcoming' : d.state === 'reinvested' || d.drip ? 'Reinvested' : 'Paid', tone: d.state === 'pending' ? '' : 'ok',
      }));
  }, [view, s.payouts, s.portfolio.dividends, year, state, q]);

  const groups = useMemo(() => {
    const m = new Map<string, Line[]>();
    for (const l of lines) {
      const k = monthKey(l.date);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(l);
    }
    return [...m];
  }, [lines]);

  const total = lines.reduce((a, l) => a + l.amount, 0);

  const exportCsv = () => {
    download(`dividends-${view}-${s.today}.csv`, toCsv(
      ['Date', 'Symbol', 'Status', 'Shares', 'Per share', 'Amount'],
      lines.map((l) => [l.date, l.symbol, l.label, l.shares ?? '', l.rate.toFixed(4), l.amount.toFixed(2)]),
    ));
  };

  const removeDividend = (id: string) => s.replacePortfolio({ ...s.portfolio, source: 'manual', dividends: s.portfolio.dividends.filter((d) => d.id !== id) });
  const addDividend = (d: Dividend) => {
    s.replacePortfolio({ ...s.portfolio, source: 'manual', dividends: [d, ...s.portfolio.dividends].sort((a, b) => b.payDate.localeCompare(a.payDate)) });
    setLogging(false);
  };

  return (
    <div className="page">
      <div className="toolbar">
        <Segmented label="View" value={view} onChange={setView} options={[{ value: 'history', label: 'History' }, { value: 'upcoming', label: 'Next 12 months' }]} />
        {view === 'history' && (
          <>
            <select className="glass-chip select" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
              <option value="all">All years</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select className="glass-chip select" value={state} onChange={(e) => setState(e.target.value as StateFilter)} aria-label="Status">
              <option value="all">Any status</option>
              <option value="received">Received</option>
              <option value="pending">Announced</option>
            </select>
          </>
        )}
        <label className="search glass-chip small">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol" aria-label="Filter by symbol" />
        </label>
        <span className="spacer" />
        {editable && view === 'history' && <button className="btn" onClick={() => setLogging(true)}><Icon name="plus" /> Log dividend</button>}
        <button className="btn" onClick={exportCsv} disabled={!lines.length}><Icon name="download" /> CSV</button>
      </div>

      <div className="summary glass-chip">
        <span><b><Money v={total} /></b> total</span>
        <span><b className="num">{lines.length}</b> payments</span>
        <span><b><Money v={lines.length ? total / lines.length : 0} /></b> average</span>
        <span><b className="num">{new Set(lines.map((l) => l.symbol)).size}</b> companies</span>
      </div>

      {groups.length ? groups.map(([month, items]) => (
        <Card key={month} title={monthLong(month)} action={<b className="month-total"><Money v={items.reduce((a, l) => a + l.amount, 0)} /></b>} pad={false}>
          <ul className="rows list">
            {items.map((l) => (
              <li key={l.key} className="clickable" onClick={() => openHolding(l.symbol)}>
                <span className="date-pill">{dateShort(l.date)}</span>
                <Ticker symbol={l.symbol} size={30} />
                <div className="row-main">
                  <b>{l.symbol}</b>
                  <small>{l.shares ? `${fmtShares(l.shares)} sh × ` : ''}{money(l.rate)}/share</small>
                </div>
                <span className={`tag ${l.tone}`}>{l.label}</span>
                <Money v={l.amount} className="row-amt" />
                {editable && l.id && (
                  <button className="icon-btn inline" aria-label="Delete" onClick={(e) => { e.stopPropagation(); removeDividend(l.id!); }}><Icon name="trash" size={15} /></button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )) : <Card><Empty>No dividends match these filters.</Empty></Card>}

      {logging && <LogDividend symbols={s.portfolio.holdings.map((h) => h.symbol)} today={s.today} onSave={addDividend} onClose={() => setLogging(false)} />}
    </div>
  );
}

function LogDividend({ symbols, today, onSave, onClose }: { symbols: string[]; today: string; onSave: (d: Dividend) => void; onClose: () => void }) {
  const [f, setF] = useState({ symbol: symbols[0] ?? '', payDate: today, shares: '', rate: '', amount: '' });
  const amount = Number(f.amount) || Number(f.shares) * Number(f.rate);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.symbol || amount <= 0) return;
    const sh = Number(f.shares) || 0;
    onSave({
      id: `manual-${Date.now()}`, symbol: f.symbol.toUpperCase(), payDate: f.payDate, amount: +amount.toFixed(2),
      shares: sh, rate: Number(f.rate) || (sh ? amount / sh : 0), state: f.payDate > today ? 'pending' : 'paid',
    });
  };
  return (
    <Modal title="Log a dividend" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <label>Symbol<input list="symbols" value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })} required /></label>
          <datalist id="symbols">{symbols.map((x) => <option key={x} value={x} />)}</datalist>
          <label>Pay date<input type="date" value={f.payDate} onChange={(e) => setF({ ...f, payDate: e.target.value })} required /></label>
        </div>
        <div className="form-row">
          <label>Shares<input inputMode="decimal" value={f.shares} onChange={(e) => setF({ ...f, shares: e.target.value })} /></label>
          <label>Per share<input inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></label>
          <label>Amount<input inputMode="decimal" value={f.amount} placeholder={amount ? amount.toFixed(2) : ''} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        </div>
        <p className="muted small">Enter the amount, or shares and per-share rate. The per-share rate drives future estimates.</p>
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!f.symbol || amount <= 0}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
