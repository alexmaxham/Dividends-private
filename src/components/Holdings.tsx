import { useMemo, useState } from 'react';
import { FREQ_LABEL, pct, shares as fmtShares, signedPct } from '../lib/format';
import { isSynced, type Holding, type HoldingStats } from '../lib/types';
import type { Store } from '../useStore';
import { Card, Empty, Icon, Modal, Money, Ticker } from './ui';

type Key = 'symbol' | 'value' | 'gainPct' | 'currentYield' | 'yieldOnCost' | 'annualIncome' | 'weight';
const COLS: { key: Key; label: string; num?: boolean }[] = [
  { key: 'symbol', label: 'Holding' },
  { key: 'value', label: 'Value', num: true },
  { key: 'gainPct', label: 'Gain', num: true },
  { key: 'currentYield', label: 'Yield', num: true },
  { key: 'yieldOnCost', label: 'On cost', num: true },
  { key: 'annualIncome', label: 'Income', num: true },
  { key: 'weight', label: 'Weight', num: true },
];

export function Holdings({ s, openHolding }: { s: Store; openHolding: (sym: string) => void }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'value', dir: -1 });
  const [onlyPaying, setOnlyPaying] = useState(false);
  const [editing, setEditing] = useState<Holding | 'new' | null>(null);
  const editable = !isSynced(s.portfolio);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return s.holdings
      .filter((h) => !needle || h.symbol.toLowerCase().includes(needle) || h.name.toLowerCase().includes(needle) || h.sector.toLowerCase().includes(needle))
      .filter((h) => !onlyPaying || h.annualIncome > 0)
      .sort((a, b) => {
        const av = a[sort.key], bv = b[sort.key];
        return (typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number)) * sort.dir;
      });
  }, [s.holdings, q, sort, onlyPaying]);

  const toggle = (key: Key) => setSort((cur) => ({ key, dir: cur.key === key ? (cur.dir === 1 ? -1 : 1) : key === 'symbol' ? 1 : -1 }));

  const saveHolding = (h: Holding, original?: string) => {
    const list = s.portfolio.holdings.filter((x) => x.symbol !== (original ?? h.symbol) && x.symbol !== h.symbol);
    s.replacePortfolio({ ...s.portfolio, source: 'manual', holdings: [...list, h] });
    setEditing(null);
  };
  const remove = (sym: string) => {
    s.replacePortfolio({ ...s.portfolio, source: 'manual', holdings: s.portfolio.holdings.filter((x) => x.symbol !== sym) });
    setEditing(null);
  };

  return (
    <div className="page">
      <div className="toolbar">
        <label className="search glass-chip">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol, name or sector" aria-label="Search holdings" />
        </label>
        <label className="check glass-chip"><input type="checkbox" checked={onlyPaying} onChange={(e) => setOnlyPaying(e.target.checked)} /> Dividend payers only</label>
        <span className="spacer" />
        {editable && <button className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" /> Add holding</button>}
      </div>

      <Card pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} className={c.num ? 'num' : ''} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                    <button onClick={() => toggle(c.key)}>{c.label}{sort.key === c.key && <span className="sort">{sort.dir === 1 ? '↑' : '↓'}</span>}</button>
                  </th>
                ))}
                <th className="num">Pays</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => <Row key={h.symbol} h={h} onOpen={() => openHolding(h.symbol)} onEdit={editable ? () => setEditing(h) : undefined} />)}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td>{rows.length} holdings</td>
                  <td className="num"><Money v={rows.reduce((a, h) => a + h.value, 0)} whole /></td>
                  <td /><td /><td />
                  <td className="num"><Money v={rows.reduce((a, h) => a + h.annualIncome, 0)} /></td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {!rows.length && <Empty>No holdings match.</Empty>}
      </Card>
      {editing && (
        <HoldingEditor initial={editing === 'new' ? undefined : editing} onSave={saveHolding} onDelete={remove} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function Row({ h, onOpen, onEdit }: { h: HoldingStats; onOpen: () => void; onEdit?: () => void }) {
  return (
    <tr className="clickable" onClick={onOpen}>
      <td>
        <div className="cell-holding">
          <Ticker symbol={h.symbol} />
          <div><b>{h.symbol}</b><small>{fmtShares(h.shares)} sh · {h.name}</small></div>
        </div>
      </td>
      <td className="num" data-label="Value"><Money v={h.value} /><small><Money v={h.price} /></small></td>
      <td className={`num ${h.gain >= 0 ? 'up' : 'down'}`} data-label="Gain">{signedPct(h.gainPct)}<small><Money v={h.gain} sign /></small></td>
      <td className="num" data-label="Yield">{h.annualIncome > 0 ? pct(h.currentYield) : '—'}</td>
      <td className="num" data-label="On cost">{h.annualIncome > 0 ? pct(h.yieldOnCost) : '—'}</td>
      <td className="num" data-label="Income"><Money v={h.annualIncome} /><small><Money v={h.annualIncome / 12} />/mo</small></td>
      <td className="num" data-label="Weight">{pct(h.weight * 100, 1)}</td>
      <td className="num" data-label="Pays">
        {FREQ_LABEL[h.frequency]}
        {onEdit && <button className="icon-btn inline" aria-label={`Edit ${h.symbol}`} onClick={(e) => { e.stopPropagation(); onEdit(); }}><Icon name="edit" size={15} /></button>}
      </td>
    </tr>
  );
}

function HoldingEditor({ initial, onSave, onDelete, onClose }: {
  initial?: Holding; onSave: (h: Holding, original?: string) => void; onDelete: (sym: string) => void; onClose: () => void;
}) {
  const [f, setF] = useState({
    symbol: initial?.symbol ?? '', name: initial?.name ?? '', shares: String(initial?.shares ?? ''), avgCost: String(initial?.avgCost ?? ''),
    price: String(initial?.price ?? ''), dividendYield: String(initial?.dividendYield ?? ''), sector: initial?.sector ?? '',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const valid = f.symbol.trim() && Number(f.shares) > 0 && Number(f.price) > 0;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const price = Number(f.price);
    onSave({
      symbol: f.symbol.trim().toUpperCase(), name: f.name.trim() || f.symbol.trim().toUpperCase(), shares: Number(f.shares),
      avgCost: Number(f.avgCost) || price, price, prevClose: initial?.prevClose ?? price, dividendYield: Number(f.dividendYield) || 0,
      sector: f.sector.trim() || 'Other',
    }, initial?.symbol);
  };
  return (
    <Modal title={initial ? `Edit ${initial.symbol}` : 'Add holding'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <label>Symbol<input value={f.symbol} onChange={set('symbol')} required autoFocus placeholder="KO" /></label>
          <label>Name<input value={f.name} onChange={set('name')} placeholder="Coca-Cola" /></label>
        </div>
        <div className="form-row">
          <label>Shares<input value={f.shares} onChange={set('shares')} inputMode="decimal" required /></label>
          <label>Average cost<input value={f.avgCost} onChange={set('avgCost')} inputMode="decimal" placeholder="per share" /></label>
          <label>Price<input value={f.price} onChange={set('price')} inputMode="decimal" required /></label>
        </div>
        <div className="form-row">
          <label>Dividend yield %<input value={f.dividendYield} onChange={set('dividendYield')} inputMode="decimal" placeholder="Used until payments are logged" /></label>
          <label>Sector<input value={f.sector} onChange={set('sector')} placeholder="Consumer Staples" /></label>
        </div>
        <div className="form-actions">
          {initial && <button type="button" className="btn danger" onClick={() => onDelete(initial.symbol)}><Icon name="trash" /> Remove</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
