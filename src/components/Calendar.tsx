import { useMemo } from 'react';
import { addMonths, monthKey } from '../lib/analytics';
import { monthLong } from '../lib/format';
import type { Payout } from '../lib/types';
import type { Store } from '../useStore';
import { Card, Money, Stat } from './ui';

export function Calendar({ s, openHolding }: { s: Store; openHolding: (sym: string) => void }) {
  const months = useMemo(() => {
    const first = `${s.today.slice(0, 7)}-01`;
    return Array.from({ length: 12 }, (_, i) => {
      const m = monthKey(addMonths(first, i));
      const items = s.payouts.filter((p) => monthKey(p.date) === m);
      // Already-paid amounts this month come from history, so the current month shows the full picture.
      const paid = i === 0 ? s.portfolio.dividends.filter((d) => monthKey(d.payDate) === m && d.payDate < s.today && (d.state === 'paid' || d.state === 'reinvested')) : [];
      const all: (Payout & { paid?: boolean })[] = [
        ...paid.map((d) => ({ symbol: d.symbol, date: d.payDate, amount: d.amount, rate: d.rate, kind: 'confirmed' as const, paid: true })),
        ...items,
      ].sort((a, b) => a.date.localeCompare(b.date));
      return { month: m, items: all, total: all.reduce((a, p) => a + p.amount, 0) };
    });
  }, [s.payouts, s.portfolio.dividends, s.today]);

  const totals = months.map((m) => m.total);
  const max = Math.max(...totals, 1);
  const best = months[totals.indexOf(Math.max(...totals))];
  const worst = months[totals.indexOf(Math.min(...totals))];
  const sum = totals.reduce((a, b) => a + b, 0);

  return (
    <div className="page">
      <div className="stats">
        <Stat label="Next 12 months" sub="Confirmed + estimated"><Money v={sum} /></Stat>
        <Stat label="Monthly average"><Money v={sum / 12} /></Stat>
        <Stat label="Biggest month" sub={monthLong(best.month)}><Money v={best.total} /></Stat>
        <Stat label="Smallest month" sub={monthLong(worst.month)}><Money v={worst.total} /></Stat>
      </div>
      <div className="calendar">
        {months.map((m, i) => (
          <Card key={m.month} className={i === 0 ? 'current' : ''} title={monthLong(m.month)} action={<b className="month-total"><Money v={m.total} /></b>}>
            <div className="cal-meter" aria-hidden="true"><span style={{ width: `${(m.total / max) * 100}%` }} /></div>
            <ul className="cal-list">
              {m.items.map((p) => (
                <li key={`${p.symbol}-${p.date}`} className={`clickable ${p.kind === 'estimated' ? 'est' : ''} ${p.paid ? 'paid' : ''}`} onClick={() => openHolding(p.symbol)}
                  title={p.paid ? 'Paid' : p.kind === 'confirmed' ? 'Confirmed' : 'Estimated'}>
                  <span className="cal-day num">{Number(p.date.slice(8, 10))}</span>
                  <b>{p.symbol}</b>
                  <span className="cal-flag">{p.paid ? '✓' : p.kind === 'confirmed' ? '●' : '○'}</span>
                  <Money v={p.amount} className="row-amt" />
                </li>
              ))}
              {!m.items.length && <li className="muted">Nothing expected</li>}
            </ul>
          </Card>
        ))}
      </div>
      <p className="footnote">✓ paid · ● confirmed by your broker · ○ estimated from each holding's payment pattern and current share count</p>
    </div>
  );
}
