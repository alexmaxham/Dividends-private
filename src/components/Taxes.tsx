import { useMemo, useState } from 'react';
import { download, toCsv } from '../lib/csv';
import { pct } from '../lib/format';
import { taxableStillToCome, taxYear } from '../lib/taxes';
import type { Store } from '../useStore';
import { BarList } from './Charts';
import { Card, Empty, Icon, Money, Stat } from './ui';

export function Taxes({ s, openHolding }: { s: Store; openHolding: (sym: string) => void }) {
  const { settings, updateSettings } = s;
  const p = s.allPortfolio;
  const thisYear = s.today.slice(0, 4);
  const years = useMemo(() => [...new Set([thisYear, ...p.dividends.map((d) => d.payDate.slice(0, 4))])].sort().reverse(), [p.dividends, thisYear]);
  const [year, setYear] = useState(thisYear);
  const rates = { qualified: settings.taxRate, ordinary: settings.ordinaryTaxRate };
  const t = useMemo(() => taxYear(p.dividends, p.holdings, p.accounts ?? [], year, s.today, rates),
    [p, year, s.today, rates.qualified, rates.ordinary]);
  const ahead = useMemo(() => (year === thisYear ? taxableStillToCome(s.allPayouts, s.allHoldings, p.accounts ?? [], year, rates) : null),
    [year, thisYear, s.allPayouts, s.allHoldings, p.accounts, rates.qualified, rates.ordinary]);
  const taxable = t.qualified + t.ordinary;

  const exportCsv = () => download(`dividend-taxes-${year}.csv`, toCsv(
    ['Symbol', 'Qualified', 'Ordinary', 'Foreign tax withheld', 'Classification'],
    t.lines.map((l) => [l.symbol, l.qualified.toFixed(2), l.ordinary.toFixed(2), l.withheld.toFixed(2), l.guessed ? 'Estimated' : 'From brokerage']),
  ));

  return (
    <div className="page">
      <div className="toolbar">
        <select className="glass-chip select" value={year} onChange={(e) => setYear(e.target.value)} aria-label="Tax year">
          {years.map((y) => <option key={y} value={y}>{y}{y === thisYear ? ' (so far)' : ''}</option>)}
        </select>
        <label className="rate-chip glass-chip">Qualified rate
          <input type="number" min={0} max={40} value={settings.taxRate} onChange={(e) => updateSettings({ taxRate: Number(e.target.value) })} aria-label="Qualified dividend tax rate" />%
        </label>
        <label className="rate-chip glass-chip">Ordinary rate
          <input type="number" min={0} max={60} value={settings.ordinaryTaxRate} onChange={(e) => updateSettings({ ordinaryTaxRate: Number(e.target.value) })} aria-label="Ordinary income tax rate" />%
        </label>
        <span className="spacer" />
        <button className="btn" onClick={exportCsv} disabled={!t.lines.length}><Icon name="download" /> CSV</button>
      </div>

      <div className="stats">
        <Stat label="Taxable dividends" sub={t.sheltered > 0 ? <>Plus <Money v={t.sheltered} /> in tax-advantaged accounts</> : 'In taxable accounts'}><Money v={taxable} /></Stat>
        <Stat label="Qualified" sub={taxable ? `${pct((t.qualified / taxable) * 100, 0)} · taxed at ${settings.taxRate}%` : `Taxed at ${settings.taxRate}%`}><Money v={t.qualified} /></Stat>
        <Stat label="Ordinary" sub={`Taxed as income at ${settings.ordinaryTaxRate}%`}><Money v={t.ordinary} /></Stat>
        <Stat label="Estimated federal tax" sub={ahead && ahead.tax > 0 ? <>About <Money v={t.estimatedTax + ahead.tax} whole /> for the full year</> : t.withheld > 0 ? <>After <Money v={t.withheld} /> foreign tax credit</> : 'On dividends only'}>
          <Money v={t.estimatedTax} />
        </Stat>
      </div>

      <div className="grid-2">
        <Card title={`1099-DIV preview · ${year}`} className="span-2">
          {t.forms.length ? (
            <div className="forms-1099">
              {t.forms.map((f) => (
                <div key={f.institution} className="form-1099">
                  <div className="form-1099-head"><b>{f.institution}</b><span className="muted small">Form 1099-DIV (preview)</span></div>
                  <dl>
                    <div><dt><span className="box">1a</span> Total ordinary dividends</dt><dd><Money v={f.box1a} /></dd></div>
                    <div><dt><span className="box">1b</span> Qualified dividends</dt><dd><Money v={f.box1b} /></dd></div>
                    <div><dt><span className="box">7</span> Foreign tax paid</dt><dd><Money v={f.box7} /></dd></div>
                  </dl>
                </div>
              ))}
            </div>
          ) : <Empty>No dividends in taxable accounts in {year}.</Empty>}
          <p className="footnote">
            Box 1a includes the qualified dividends in 1b. Your brokerage sends the real form by mid-February and can still
            reclassify payments (as return of capital, say), so file with theirs.
            {t.guessed > 0 && <> <b><Money v={t.guessed} /></b> wasn't labeled qualified or not by your brokerage, so it's classified here by the kind of holding (REITs, BDCs and bond or option-income funds as ordinary).</>}
          </p>
        </Card>

        <Card title="By holding" className="span-2">
          {t.lines.length ? (
            <BarList format={(n) => <Money v={n} />} rows={t.lines.map((l) => ({
              key: l.symbol, value: l.qualified + l.ordinary,
              label: <button className="link-btn plain" onClick={() => openHolding(l.symbol)}>{l.symbol}</button>,
              sub: `${l.ordinary && l.qualified ? 'Mixed' : l.ordinary ? 'Ordinary' : 'Qualified'}${l.guessed ? ' (estimated)' : ''}${l.withheld ? ' · foreign tax withheld' : ''}`,
            }))} />
          ) : <Empty>Nothing taxable yet.</Empty>}
        </Card>
      </div>
      <p className="footnote">
        A federal estimate for planning, not tax advice. It leaves out state tax, the 3.8% net investment income tax at higher
        incomes, and the holding-period rule (shares must be held 61 days around the ex-dividend date for a dividend to be qualified).
        Qualified dividends are taxed at 0%, 15% or 20% depending on your income.
      </p>
    </div>
  );
}
