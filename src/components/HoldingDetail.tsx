import { useMemo } from 'react';
import { buyBy, isReceived, regularDividends } from '../lib/analytics';
import { symbolSummary } from '../lib/explore';
import { accountLabel } from '../lib/accounts';
import { dateLong, dateShort, FREQ_LABEL, money, pct, shares as fmtShares, signedPct } from '../lib/format';
import type { Store } from '../useStore';
import { Bars } from './Charts';
import { Empty, Modal, Money, Ticker } from './ui';

export function HoldingDetail({ s, symbol, onClose }: { s: Store; symbol: string; onClose: () => void }) {
  const h = s.holdings.find((x) => x.symbol === symbol);
  const history = useMemo(() => s.portfolio.dividends.filter((d) => d.symbol === symbol && d.state !== 'voided'), [s.portfolio.dividends, symbol]);
  const next = s.payouts.filter((p) => p.symbol === symbol).slice(0, 4);
  const info = s.market[symbol];
  const own = useMemo(() => [...history].filter(isReceived).reverse().slice(-12)
    .map((d) => ({ label: dateShort(d.payDate).split(' ')[0], value: d.rate, note: `${dateLong(d.payDate)}: ${money(d.rate)}/share` })), [history]);
  // Not held, or no payments yet: the company's own record from market data.
  const rates = own.length > 1 || !info ? own : regularDividends(info).slice(-12)
    .map((d) => ({ label: dateShort(d.payDate ?? d.exDate).split(' ')[0], value: d.amount, note: `Ex-dividend ${dateLong(d.exDate)}: ${money(d.amount)}/share` }));
  const watched = !h && info ? symbolSummary(info, s.today) : null;

  return (
    <Modal title={h ? h.name : info?.name ?? symbol} onClose={onClose} wide>
      <div className="detail-head">
        <Ticker symbol={symbol} size={52} />
        <div>
          <div className="hero-value small">{h ? <Money v={h.price} /> : watched ? <Money v={watched.price} /> : '—'}</div>
          {h && <div className={h.price >= h.prevClose ? 'up' : 'down'}>{signedPct(h.prevClose ? (h.price / h.prevClose - 1) * 100 : 0)} today · {h.sector}</div>}
          {!h && <div className="muted">{watched ? `Not held${s.watchlist.includes(symbol) ? ' · on your watchlist' : ''}` : 'No longer held — dividend history only'}</div>}
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

      {watched && (
        <div className="kv-grid">
          <div><span>Yield</span><b className="num">{watched.annualPerShare ? pct(watched.yieldPct) : '—'}</b></div>
          <div><span>Annual / share</span><b><Money v={watched.annualPerShare} /></b></div>
          <div><span>Pays</span><b>{FREQ_LABEL[watched.frequency]}</b></div>
          <div><span>Dividend growth</span><b className={watched.growth == null ? '' : watched.growth >= 0 ? 'up' : 'down'}>{watched.growth == null ? '—' : `${signedPct(watched.growth, 1)} YoY`}</b></div>
          <div><span>Next ex-dividend</span><b>{watched.nextEx ? dateShort(watched.nextEx.exDate) : '—'}</b></div>
          <div><span>Buy by</span><b>{watched.nextEx ? dateShort(buyBy(watched.nextEx.exDate)) : '—'}</b></div>
        </div>
      )}

      {h && s.account === 'all' && (h.lots?.length ?? 0) > 1 && (
        <section className="detail-section">
          <h3>By account</h3>
          <ul className="rows compact">
            {h.lots!.map((l) => {
              const a = s.accounts.find((x) => x.id === l.account);
              return (
                <li key={l.account}>
                  <div className="row-main"><b>{a ? accountLabel(a) : 'Account'}</b><small>{fmtShares(l.shares)} sh · <Money v={l.shares * h.annualPerShare} />/yr</small></div>
                  <Money v={l.shares * h.price} className="row-amt" />
                </li>
              );
            })}
          </ul>
        </section>
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
                <div className="row-main">
                  <b>{dateLong(p.date)}</b>
                  <small>{p.kind === 'confirmed' ? 'Confirmed' : 'Estimated'} · {money(p.rate)}/share
                    {p.exDate && p.exDate >= s.today && <> · ex-dividend {dateShort(p.exDate)}, buy by {dateShort(buyBy(p.exDate))}</>}</small>
                </div>
                <Money v={p.amount} className="row-amt" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {!(watched && !history.length) && <section className="detail-section">
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
      </section>}
    </Modal>
  );
}
