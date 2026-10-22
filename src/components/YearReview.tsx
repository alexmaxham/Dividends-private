import { useMemo, useState } from 'react';
import { download } from '../lib/csv';
import { dateShort, monthLong, monthShort, signedPct } from '../lib/format';
import { reportHtml, reportText, yearReport } from '../lib/report';
import type { Store } from '../useStore';
import { Bars } from './Charts';
import { Icon, Modal, Money, Ticker } from './ui';

export function YearReview({ s, onClose }: { s: Store; onClose: () => void }) {
  const p = s.allPortfolio;
  const thisYear = s.today.slice(0, 4);
  const years = useMemo(() => [...new Set(p.dividends.filter((d) => d.payDate <= s.today).map((d) => d.payDate.slice(0, 4)))].sort().reverse(), [p.dividends, s.today]);
  const [year, setYear] = useState(years[0] ?? thisYear);
  // The report covers every account, whatever the picker is set to.
  const totals = useMemo(() => ({
    annualIncome: s.allHoldings.reduce((a, h) => a + h.annualIncome, 0),
    yieldOnCost: (() => { const cost = s.allHoldings.reduce((a, h) => a + h.cost, 0); return cost ? (s.allHoldings.reduce((a, h) => a + h.annualIncome, 0) / cost) * 100 : 0; })(),
  }), [s.allHoldings]);
  const r = useMemo(() => yearReport(p.dividends, s.allHoldings, totals, year, s.today), [p.dividends, s.allHoldings, totals, year, s.today]);
  const [note, setNote] = useState<string | null>(null);
  const change = r.previous ? (r.total / r.previous - 1) * 100 : null;

  const share = async () => {
    const text = reportText(r, s.settings.privacy);
    try {
      if (navigator.share) await navigator.share({ title: `My ${r.year} in dividends`, text });
      else { await navigator.clipboard.writeText(text); setNote('Copied to the clipboard.'); }
    } catch { /* closed the share sheet */ }
  };

  return (
    <Modal title={`Your ${r.year}${r.partial ? ' so far' : ''} in dividends`} onClose={onClose} wide>
      <div className="review">
        {years.length > 1 && (
          <select className="glass-chip select" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Year">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )}
        <div className="review-total">
          <Money v={r.total} />
          {change != null && <small className={change >= 0 ? 'up' : 'down'}>{signedPct(change, 1)} on {Number(r.year) - 1}</small>}
        </div>
        <div className="kv-grid">
          <div><span>Payments</span><b className="num">{r.payments}</b></div>
          <div><span>Companies and funds</span><b className="num">{r.companies}</b></div>
          <div><span>Best month</span><b>{r.best ? monthLong(r.best.month) : '—'}</b></div>
          <div><span>Forward income</span><b><Money v={r.forwardIncome} whole />/yr</b></div>
        </div>
        <section className="detail-section">
          <h3>By month</h3>
          <Bars data={r.months.map((m) => ({ label: monthShort(m.month), value: m.amount }))} height={170} label={`Dividends by month in ${r.year}`} />
        </section>
        <div className="split">
          <section className="detail-section">
            <h3>Top payers</h3>
            <ul className="rows compact">
              {r.top.map((t) => (
                <li key={t.symbol}><Ticker symbol={t.symbol} size={28} /><div className="row-main"><b>{t.symbol}</b></div><Money v={t.amount} className="row-amt" /></li>
              ))}
            </ul>
          </section>
          <section className="detail-section">
            <h3>{r.raises.length ? `${r.raises.length} raised their dividend` : 'Dividend raises'}</h3>
            {r.raises.length ? (
              <ul className="rows compact">
                {r.raises.slice(0, 5).map((x) => <li key={x.symbol}><Ticker symbol={x.symbol} size={28} /><div className="row-main"><b>{x.symbol}</b></div><b className="num up">{signedPct(x.growth, 1)}</b></li>)}
              </ul>
            ) : <p className="muted small">{r.partial ? 'None in the last year.' : 'Shown for the current year.'}</p>}
          </section>
        </div>
        {r.covered.length > 0 && <p>Your dividends now cover <b>{r.covered[r.covered.length - 1]}</b>{r.covered.length > 1 ? ` and ${r.covered.length - 1} smaller bill${r.covered.length > 2 ? 's' : ''}` : ''} every month.</p>}
        <div className="btn-row">
          <button className="btn primary" onClick={() => download(`dividends-${r.year}.html`, reportHtml(r), 'text/html')}><Icon name="download" /> Download</button>
          <button className="btn" onClick={() => void share()}><Icon name="share" /> Share</button>
        </div>
        {note && <p className="note">{note}</p>}
        <p className="footnote">The download is a page you can open, print or save as a PDF. Sharing {s.settings.privacy ? 'leaves out dollar amounts (privacy mode is on)' : 'includes your total; turn on privacy mode to leave amounts out'}.{r.partial && ` Through ${dateShort(s.today)}.`}</p>
      </div>
    </Modal>
  );
}
