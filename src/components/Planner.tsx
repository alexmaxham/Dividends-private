import { useMemo, useState } from 'react';
import { project } from '../lib/analytics';
import { money0 } from '../lib/format';
import type { Store } from '../useStore';
import { Legend, LineChart } from './Charts';
import { Card, Money, Stat } from './ui';

export function Planner({ s }: { s: Store }) {
  const { totals, settings } = s;
  const [inp, setInp] = useState({
    startValue: Math.round(totals.value),
    yieldPct: +totals.currentYield.toFixed(2),
    monthlyContribution: 500,
    dividendGrowthPct: 6,
    priceGrowthPct: 5,
    years: 20,
    reinvest: true,
    taxRatePct: settings.taxRate,
  });
  const rows = useMemo(() => project(inp), [inp]);
  const end = rows[rows.length - 1];
  const goalYear = rows.find((r) => r.annualIncome / 12 >= settings.monthlyGoal);
  const set = (k: keyof typeof inp) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInp({ ...inp, [k]: e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value) });

  const thisYear = Number(s.today.slice(0, 4));
  const labels = rows.map((r) => String(thisYear + r.year));
  const yearFmt = (y: string) => y;

  return (
    <div className="page">
      <div className="grid-planner">
        <Card title="Assumptions" className="planner-form">
          <div className="form">
            <Field label="Starting value" suffix="$" value={inp.startValue} onChange={set('startValue')} step={100} />
            <Field label="Dividend yield" suffix="%" value={inp.yieldPct} onChange={set('yieldPct')} step={0.1} />
            <Field label="Monthly contribution" suffix="$" value={inp.monthlyContribution} onChange={set('monthlyContribution')} step={50} />
            <Slider label="Dividend growth / yr" value={inp.dividendGrowthPct} min={0} max={15} step={0.5} onChange={set('dividendGrowthPct')} />
            <Slider label="Share price growth / yr" value={inp.priceGrowthPct} min={-2} max={12} step={0.5} onChange={set('priceGrowthPct')} />
            <Slider label="Dividend tax rate" value={inp.taxRatePct} min={0} max={40} step={1} onChange={set('taxRatePct')} />
            <Slider label="Years" value={inp.years} min={1} max={40} step={1} onChange={set('years')} unit="" />
            <label className="switch-row">
              <span>Reinvest dividends (DRIP)</span>
              <input type="checkbox" className="switch" checked={inp.reinvest} onChange={set('reinvest')} />
            </label>
            <button className="link-btn" onClick={() => setInp({ ...inp, startValue: Math.round(totals.value), yieldPct: +totals.currentYield.toFixed(2) })}>Reset to my portfolio</button>
          </div>
        </Card>

        <div className="planner-out">
          <div className="stats three">
            <Stat label={`Income in ${thisYear + inp.years}`} sub={<><Money v={end.annualIncome / 12} whole />/mo</>}><Money v={end.annualIncome} whole /></Stat>
            <Stat label="Portfolio value" sub={<>You put in <Money v={end.contributed} whole /></>}><Money v={end.value} whole /></Stat>
            <Stat label={`${money0(settings.monthlyGoal)}/mo goal`} sub={goalYear ? `in ${goalYear.year} year${goalYear.year === 1 ? '' : 's'}` : 'Not within this horizon'}>
              {goalYear ? thisYear + goalYear.year : '—'}
            </Stat>
          </div>
          <Card title="Annual dividend income">
            <LineChart label="Projected annual dividend income" xLabels={labels} xFormat={yearFmt}
              series={[{ key: 'inc', label: 'Annual income', color: 'var(--series-1)', values: rows.map((r) => r.annualIncome), area: true }]} />
          </Card>
          <Card title="Portfolio value">
            <LineChart label="Projected portfolio value" xLabels={labels} xFormat={yearFmt} series={[
              { key: 'val', label: 'Value', color: 'var(--series-1)', values: rows.map((r) => r.value), area: true },
              { key: 'con', label: 'Contributed', color: 'var(--ink-3)', values: rows.map((r) => r.contributed), dashed: true },
            ]} />
            <Legend items={[{ label: 'Value', color: 'var(--series-1)' }, { label: 'Contributed', color: 'var(--ink-3)', dashed: true }]} />
          </Card>
          <p className="footnote">A simple model, not a forecast: steady growth rates, contributions at month end, dividends paid monthly. Real returns vary.</p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, suffix, value, onChange, step }: { label: string; suffix: string; value: number; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; step: number }) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="input-affix">
        {suffix === '$' && <i>$</i>}
        <input type="number" value={value} onChange={onChange} step={step} min={0} />
        {suffix === '%' && <i>%</i>}
      </span>
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange, unit = '%' }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; unit?: string;
}) {
  return (
    <label className="field">
      <span>{label} <b className="num">{value}{unit}</b></span>
      <input type="range" value={value} min={min} max={max} step={step} onChange={onChange} style={{ ['--p' as string]: `${((value - min) / (max - min)) * 100}%` }} />
    </label>
  );
}
