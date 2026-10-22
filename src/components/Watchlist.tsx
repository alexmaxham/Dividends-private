import { useMemo, useState } from 'react';
import { cloudMessage } from '../cloud/firebase';
import { symbolSummary, whatIf } from '../lib/explore';
import { dateShort, FREQ_LABEL, money, pct, shares as fmtShares, signedPct } from '../lib/format';
import type { Store } from '../useStore';
import { IncomeBars, Legend } from './Charts';
import { Card, Empty, Icon, Money, Stat, Ticker } from './ui';

const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export function Watchlist({ s, openHolding }: { s: Store; openHolding: (sym: string) => void }) {
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const demo = s.portfolio.source === 'demo';

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const sym = input.trim().toUpperCase().replace(/^\$/, '');
    setErr(null);
    if (!TICKER.test(sym)) { setErr('Enter a ticker symbol, like SCHD.'); return; }
    if (s.watchlist.includes(sym)) { setErr(`${sym} is already on your watchlist.`); return; }
    if (s.watchlist.length >= 50) { setErr('The watchlist holds 50 symbols. Remove one first.'); return; }
    if (demo || s.mode !== 'cloud') {
      if (!s.market[sym]) {
        setErr(s.mode === 'cloud' || s.mode === 'local' ? 'Looking up symbols needs market data, which this copy of the app doesn’t have.' : 'In the sample, try VYM, HD or TXN. Sign in to look up any symbol.');
        return;
      }
    } else {
      setAdding(true);
      try { await s.call('lookupSymbol', { symbol: sym }); } catch (x) { setErr(cloudMessage(x)); setAdding(false); return; }
      setAdding(false);
    }
    s.updateSettings({ watchlist: [...s.watchlist, sym] });
    setInput('');
  };
  const remove = (sym: string) => s.updateSettings({ watchlist: s.watchlist.filter((x) => x !== sym) });

  const rows = s.watchlist.map((sym) => ({ sym, info: s.market[sym] }));
  const choices = [...new Set([...s.watchlist, ...s.holdings.map((h) => h.symbol)])];

  return (
    <div className="page">
      <form className="toolbar" onSubmit={add}>
        <label className="search glass-chip">
          <Icon name="search" />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Add a symbol, like VYM" aria-label="Symbol to watch" autoCapitalize="characters" />
        </label>
        <button className="btn primary" disabled={adding || !input.trim()}><Icon name="plus" /> {adding ? 'Looking up…' : 'Watch'}</button>
      </form>
      {err && <p className="error"><Icon name="alert" size={16} /> {err}</p>}

      <Card pad={false}>
        {rows.length ? (
          <ul className="rows list watch-list">
            {rows.map(({ sym, info }) => {
              const held = s.allHoldings.find((h) => h.symbol === sym);
              const x = info ? symbolSummary(info, s.today, held) : null;
              return (
                <li key={sym} className="clickable" onClick={() => openHolding(sym)}>
                  <Ticker symbol={sym} />
                  <div className="row-main">
                    <b>{sym}{held && <span className="tag ok">Held</span>}</b>
                    <small>{x?.name ?? 'Loading…'}</small>
                  </div>
                  {x ? (
                    <>
                      <div className="watch-cell"><span>Price</span><b><Money v={x.price} /></b>{x.change != null && <small className={x.change >= 0 ? 'up' : 'down'}>{signedPct(x.change)}</small>}</div>
                      <div className="watch-cell"><span>Yield</span><b className="num">{x.annualPerShare ? pct(x.yieldPct) : '—'}</b><small>{FREQ_LABEL[x.frequency]}</small></div>
                      <div className="watch-cell wide-only"><span>Growth</span><b className={`num ${x.growth == null ? '' : x.growth >= 0 ? 'up' : 'down'}`}>{x.growth == null ? '—' : signedPct(x.growth, 1)}</b><small>a year</small></div>
                      <div className="watch-cell wide-only"><span>Next ex-date</span><b>{x.nextEx ? dateShort(x.nextEx.exDate) : '—'}</b><small>{x.nextEx ? `${money(x.nextEx.amount)}/sh` : 'Not announced'}</small></div>
                    </>
                  ) : <span className="muted small">Fetching market data…</span>}
                  <button className="icon-btn inline" aria-label={`Stop watching ${sym}`} onClick={(e) => { e.stopPropagation(); remove(sym); }}><Icon name="close" size={15} /></button>
                </li>
              );
            })}
          </ul>
        ) : <Empty>Add symbols you're thinking about to see their yield, payment history and next ex-dividend date.</Empty>}
      </Card>

      {choices.length > 0 && <WhatIfCard s={s} choices={choices} />}
    </div>
  );
}

function WhatIfCard({ s, choices }: { s: Store; choices: string[] }) {
  const [symbol, setSymbol] = useState(choices[0]);
  const [amount, setAmount] = useState(1000);
  const sym = choices.includes(symbol) ? symbol : choices[0];
  const r = useMemo(() => whatIf(s.portfolio, s.market, s.today, sym, amount), [s.portfolio, s.market, s.today, sym, amount]);
  const added = r ? r.incomeAfter - r.incomeBefore : 0;

  return (
    <Card title="What if…">
      <div className="whatif-form">
        <label>I add
          <span className="input-affix"><i>$</i><input type="number" min={0} step={100} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Amount to invest" /></span>
        </label>
        <label>to
          <select className="input-select" value={sym} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol">
            {choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      {r ? (
        <>
          <div className="stats three">
            <Stat label="Yearly income" tone="up" sub={<>+<Money v={added / 12} />/mo · {fmtShares(+r.shares.toFixed(4))} shares at <Money v={r.price} /></>}>
              +<Money v={added} />
            </Stat>
            <Stat label="New forward income" sub={<>from <Money v={r.incomeBefore} /></>}><Money v={r.incomeAfter} /></Stat>
            <Stat label="Portfolio yield" sub={`from ${pct(r.yieldBefore)}`}>{pct(r.yieldAfter)}</Stat>
          </div>
          {added > 0 ? (
            <>
              <IncomeBars data={r.months.map((m) => ({ month: m.month, received: m.before, projected: m.added }))} height={200}
                labels={{ solid: 'Already expected', hatched: `From ${sym}` }} label={`Expected monthly income with ${money(amount)} more in ${sym}`} />
              <Legend items={[{ label: 'Already expected', color: 'var(--series-1)' }, { label: `Added by ${sym}`, hatch: true }]} />
            </>
          ) : <p className="muted">{sym} doesn't pay a dividend, so this wouldn't add income.</p>}
          <p className="footnote">At today's price and current dividend rate. A payment only counts if you buy before its ex-dividend date.</p>
        </>
      ) : <p className="muted">Enter an amount to see the difference.</p>}
    </Card>
  );
}
