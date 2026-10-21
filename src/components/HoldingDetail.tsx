import { useMemo } from 'react';
import { isReceived } from '../lib/analytics';
import { dateLong, dateShort, FREQ_LABEL, money, pct, shares as fmtShares, signedPct } from '../lib/format';
import type { Store } from '../useStore';
import { Bars } from './Charts';
import { Empty, Modal, Money, Ticker } from './ui';

export function HoldingDetail({ s, symbol, onClose }: { s: Store; symbol: string; onClose: () => void }) {
  const h = s.holdings.find((x) => x.symbol === symbol);
  const history = useMemo(() => s.portfolio.dividends.filter((d) => d.symbol === symbol && d.state !== 'voided'), [s.portfolio.dividends, symbol]);
  const next = s.payouts.filter((p) => p.symbol === symbol).slice(0, 4);
  const rates = useMemo(() => [...history].filter(isReceived).reverse().slice(-12)
    .map((d) => ({ label: dateShort(d.payDate).split(' ')[0], value: d.rate, note: `${dateLong(d.payDate)}: ${money(d.rate)}/share` })), [history]);

  return (
    <Modal title={h ? h.name : symbol} onClose={onClose} wide>
      <div className="detail-head">
        <Ticker symbol={symbol} size={52} />
        <div>
          <div className="hero-value small">{h ? <Money v={h.price} /> : '—'}</div>
          {h && <div className={h.price >= h.prevClose ? 'up' : 'down'}>{signedPct(h.prevClose ? (h.price / h.prevClose - 1) * 100 : 0)} today · {h.sector}</div>}
          {!h && <div className="muted">No longer held — dividend history only</div>}
        </div>
      </div>

      {h && (
        <div className="kv-grid">
          <div><span>Shares</span><b className="num">{fmtShares(h.shares)}</b></div>
          <div><span>Value</span><b><Money v={h.value} /></b></div>
          <div><span>Avg cost</span><b><Money v={h.avgCost} /></b></div>
          <div><span>Gain</span><b className={h.gain >= 0 ? 'up' : 'down'}><Money v={h.gain} sign /> ({signedPct(h.gainPct)})</b></div>
          <div><span>Pays</span><b>{FREQ_LABEL[h.frequency]}</b></div>
          <div><span>Annual / share</span><b><Money v={h.annualPerShare} /></b></div>
          <div><span>Yield</span><b className="num">{pct(h.currentYield)}</b></div>
          <div><span>Yield on cost</span><b className="num">{pct(h.yieldOnCost)}</b></div>
          <div><span>Annual income</span><b><Money v={h.annualIncome} /></b></div>
          <div><span>Dividend growth</span><b className={h.growth == null ? '' : h.growth >= 0 ? 'up' : 'down'}>{h.growth == null ? '—' : `${signedPct(h.growth, 1)} YoY`}</b></div>
          <div><span>Collected so far</span><b><Money v={h.received} /></b></div>
          <div><span>Share of income</span><b className="num">{pct(h.incomeShare * 100, 1)}</b></div>
        </div>
      )}

      {rates.length > 1 && (
        <section className="detail-section">
          <h3>Payment per share</h3>
          <Bars data={rates} height={170} format={money} label={`${symbol} dividend per share over time`} />
        </section>
      )}

      {next.length > 0 && (
        <section className="detail-section">
          <h3>Next payments</h3>
          <ul className="rows compact">
            {next.map((p) => (
              <li key={p.date}>
                <div className="row-main"><b>{dateLong(p.date)}</b><small>{p.kind === 'confirmed' ? 'Confirmed' : 'Estimated'} · {money(p.rate)}/share</small></div>
                <Money v={p.amount} className="row-amt" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="detail-section">
        <h3>History</h3>
        {history.length ? (
          <ul className="rows compact scroll">
            {history.map((d) => (
              <li key={d.id}>
                <div className="row-main"><b>{dateLong(d.payDate)}</b><small>{fmtShares(d.shares)} sh × {money(d.rate)}{d.drip ? ' · Reinvested' : ''}</small></div>
                <span className={`tag ${d.state === 'pending' ? '' : 'ok'}`}>{d.state}</span>
                <Money v={d.amount} className="row-amt" />
              </li>
            ))}
          </ul>
        ) : <Empty>No dividends recorded yet.</Empty>}
      </section>
    </Modal>
  );
}
