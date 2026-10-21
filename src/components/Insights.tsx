import { useMemo, useState } from 'react';
import { groupBy, incomeByYear } from '../lib/analytics';
import { money0, pct, signedPct } from '../lib/format';
import type { Store } from '../useStore';
import { BarList, Bars } from './Charts';
import { Card, Icon, Money, Segmented, Ticker } from './ui';

type Basis = 'income' | 'value';

export function Insights({ s, openHolding }: { s: Store; openHolding: (sym: string) => void }) {
  const [basis, setBasis] = useState<Basis>('income');
  const { holdings, totals } = s;
  const pick = (h: (typeof holdings)[number]) => (basis === 'income' ? h.annualIncome : h.value);
  const whole = basis === 'income' ? totals.annualIncome : totals.value;

  const bySector = useMemo(() => groupBy(holdings, (h) => h.sector || 'Other', pick), [holdings, basis]);
  const byHolding = useMemo(() => [...holdings].sort((a, b) => pick(b) - pick(a)).filter((h) => pick(h) > 0), [holdings, basis]);
  const byFreq = useMemo(() => groupBy(holdings.filter((h) => h.annualIncome > 0), (h) => h.frequency, (h) => h.annualIncome), [holdings]);
  const years = useMemo(() => incomeByYear(s.portfolio.dividends, s.today), [s.portfolio.dividends, s.today]);
  const yearBars = years.map((y, i) => {
    const prev = years[i - 1]?.amount;
    return { label: y.year === s.today.slice(0, 4) ? `${y.year} YTD` : y.year, value: y.amount, note: prev ? `${signedPct((y.amount / prev - 1) * 100, 1)} vs ${years[i - 1].year}` : undefined };
  });
  const growers = holdings.filter((h) => h.growth !== null).sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0));
  const cutters = growers.filter((h) => (h.growth ?? 0) < -0.5);

  // Plain-language checks people usually want flagged.
  const flags: { tone: 'warn' | 'ok'; text: string }[] = [];
  const topIncome = [...holdings].sort((a, b) => b.incomeShare - a.incomeShare)[0];
  if (topIncome && topIncome.incomeShare > 0.25) flags.push({ tone: 'warn', text: `${topIncome.symbol} pays ${pct(topIncome.incomeShare * 100, 0)} of your dividend income. A cut there would hurt.` });
  const topSector = groupBy(holdings, (h) => h.sector, (h) => h.value)[0];
  if (topSector && totals.value && topSector.value / totals.value > 0.4) flags.push({ tone: 'warn', text: `${topSector.label} is ${pct((topSector.value / totals.value) * 100, 0)} of the portfolio.` });
  for (const h of cutters) flags.push({ tone: 'warn', text: `${h.symbol} cut its payout ${signedPct(h.growth ?? 0, 1)} from a year ago.` });
  const highYield = holdings.filter((h) => h.currentYield > 9);
  if (highYield.length) flags.push({ tone: 'warn', text: `${highYield.map((h) => h.symbol).join(', ')} yield over 9%. Very high yields can signal a coming cut.` });
  const nonPayers = holdings.filter((h) => h.annualIncome <= 0);
  if (nonPayers.length) flags.push({ tone: 'ok', text: `${nonPayers.length} holding${nonPayers.length > 1 ? 's' : ''} (${nonPayers.map((h) => h.symbol).join(', ')}) pay no dividend.` });
  const avgGrowth = growers.length ? growers.reduce((a, h) => a + (h.growth ?? 0) * h.incomeShare, 0) / growers.reduce((a, h) => a + h.incomeShare, 0) : null;
  if (avgGrowth !== null && avgGrowth > 0) flags.push({ tone: 'ok', text: `Your payers raised dividends ${signedPct(avgGrowth, 1)} over the past year, weighted by income.` });

  const fmt = (n: number) => <span><Money v={n} whole={basis === 'value'} /></span>;

  return (
    <div className="page">
      <div className="grid-2">
        <Card title="Dividend income by year" className="span-2">
          {yearBars.length ? <Bars data={yearBars} label="Dividends received per year" height={220} /> : <p className="muted">No payments yet.</p>}
        </Card>

        <Card title="Allocation" className="span-2" action={<Segmented label="Measure" value={basis} onChange={setBasis} options={[{ value: 'income', label: 'By income' }, { value: 'value', label: 'By value' }]} />}>
          <div className="split">
            <div>
              <h3>Sector</h3>
              <BarList format={fmt} rows={bySector.map((r) => ({ key: r.label, label: r.label, value: r.value, sub: whole ? pct((r.value / whole) * 100, 1) : '' }))} />
            </div>
            <div>
              <h3>Holding</h3>
              <BarList format={fmt} rows={byHolding.slice(0, 12).map((h) => ({
                key: h.symbol, value: pick(h), sub: whole ? pct((pick(h) / whole) * 100, 1) : '',
                label: <button className="link-btn plain" onClick={() => openHolding(h.symbol)}>{h.symbol}</button>,
              }))} />
            </div>
          </div>
        </Card>

        <Card title="Checkup">
          <ul className="flags">
            {flags.length ? flags.map((f, i) => (
              <li key={i} className={f.tone}><Icon name={f.tone === 'warn' ? 'alert' : 'check'} size={16} /> <span>{f.text}</span></li>
            )) : <li className="ok"><Icon name="check" size={16} /> Nothing stands out.</li>}
          </ul>
        </Card>

        <Card title="Payment schedule">
          <BarList format={(n) => <Money v={n} />} rows={byFreq.map((r) => ({ key: r.label, label: r.label[0].toUpperCase() + r.label.slice(1), value: r.value, sub: totals.annualIncome ? pct((r.value / totals.annualIncome) * 100, 0) : '' }))} />
        </Card>

        <Card title="Dividend growth (last 12 months)" className="span-2">
          {growers.length ? (
            <ul className="rows cols">
              {growers.map((h) => (
                <li key={h.symbol} className="clickable" onClick={() => openHolding(h.symbol)}>
                  <Ticker symbol={h.symbol} size={30} />
                  <div className="row-main"><b>{h.symbol}</b><small>{money0(h.annualPerShare)}/share a year</small></div>
                  <b className={`num ${(h.growth ?? 0) >= 0 ? 'up' : 'down'}`}>{signedPct(h.growth ?? 0, 1)}</b>
                </li>
              ))}
            </ul>
          ) : <p className="muted">Needs a year of payment history.</p>}
        </Card>
      </div>
    </div>
  );
}
