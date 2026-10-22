import { useMemo, useState } from 'react';
import { accountBreakdown, project, yearlyContribution } from '../lib/analytics';
import { accountLabel, ACCOUNTS, accountType, contributionLimit, LIMITS_YEAR, type AccountType } from '../lib/accounts';

const dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
import type { Store } from '../useStore';
import { Legend, LineChart } from './Charts';
import { Card, Money, Segmented, Stat } from './ui';

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
  const [account, setAccount] = useState<{ type: AccountType; age: number; hsaFamily: boolean; limitOverride: number | null }>(
    { type: 'taxable', age: 35, hsaFamily: false, limitOverride: null });
  const info = ACCOUNTS[account.type];
  const irsLimit = contributionLimit(account.type, account.age, account.hsaFamily);
  const limit = irsLimit == null ? null : account.limitOverride ?? irsLimit;
  const perYear = yearlyContribution(inp.monthlyContribution, limit);
  const overLimit = limit != null && inp.monthlyContribution * 12 > limit;
  // Changing the account, age or HSA coverage brings the limit back to the IRS figure.
  const changeAccount = (patch: Partial<typeof account>) => setAccount({ ...account, ...patch, limitOverride: null });

  const rows = useMemo(
    () => project({ ...inp, taxRatePct: info.tax === 'yearly' ? inp.taxRatePct : 0, annualLimit: limit }),
    [inp, info.tax, limit],
  );
  const end = rows[rows.length - 1];
  const goalYear = rows.find((r) => r.annualIncome / 12 >= settings.monthlyGoal);
  const set = (k: keyof typeof inp) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInp({ ...inp, [k]: e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value) });

  const thisYear = Number(s.today.slice(0, 4));
  const linkedTotals = useMemo(() => accountBreakdown(s.allHoldings, s.accounts), [s.allHoldings, s.accounts]);
  const [from, setFrom] = useState('portfolio');
  /** Start from one linked account: its type, balance and yield. */
  const startFrom = (id: string) => {
    setFrom(id);
    if (id === 'portfolio') {
      setInp({ ...inp, startValue: Math.round(totals.value), yieldPct: +totals.currentYield.toFixed(2) });
      return;
    }
    const a = s.accounts.find((x) => x.id === id)!;
    const t = linkedTotals.find((x) => x.id === id)!;
    setAccount({ ...account, type: accountType(a.subtype), limitOverride: null });
    setInp({ ...inp, startValue: Math.round(t.value), yieldPct: t.value ? +((t.income / t.value) * 100).toFixed(2) : inp.yieldPct });
  };
  const labels = rows.map((r) => String(thisYear + r.year));
  const yearFmt = (y: string) => y;

  return (
    <div className="page">
      <div className="grid-planner">
        <Card title="Assumptions" className="planner-form">
          <div className="form">
            {s.accounts.length > 0 && (
              <label className="field">
                <span>Start from</span>
                <select id="start-from" className="input-select" value={from} onChange={(e) => startFrom(e.target.value)}>
                  <option value="portfolio">My whole portfolio</option>
                  {s.accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
                </select>
              </label>
            )}
            <label className="field">
              <span>Account type</span>
              <select id="account-type" className="input-select" value={account.type} onChange={(e) => changeAccount({ type: e.target.value as AccountType })}>
                {(Object.keys(ACCOUNTS) as AccountType[]).map((t) => <option key={t} value={t}>{ACCOUNTS[t].label}</option>)}
              </select>
              <small className="muted field-note">{info.note}</small>
            </label>
            {irsLimit != null && (
              <>
                <div className="form-row">
                  <label className="field narrow">Your age
                    <span className="input-affix"><input id="age" type="number" min={18} max={100} value={account.age} onChange={(e) => changeAccount({ age: Number(e.target.value) })} /></span>
                  </label>
                  <label className="field">
                    <span>Yearly limit</span>
                    <span className="input-affix"><i>$</i>
                      <input id="limit" type="number" min={0} step={100} value={limit ?? 0} onChange={(e) => setAccount({ ...account, limitOverride: Number(e.target.value) })} />
                    </span>
                  </label>
                </div>
                {account.type === 'hsa' && (
                  <div className="setting-line">
                    <span>Coverage</span>
                    <Segmented label="HSA coverage" value={account.hsaFamily ? 'family' : 'self'} onChange={(v) => changeAccount({ hsaFamily: v === 'family' })}
                      options={[{ value: 'self', label: 'Self' }, { value: 'family', label: 'Family' }]} />
                  </div>
                )}
                <small className="muted field-note">
                  {account.limitOverride != null && account.limitOverride !== irsLimit
                    ? <>Custom limit. <button type="button" className="link-btn small-link" onClick={() => setAccount({ ...account, limitOverride: null })}>Use the {LIMITS_YEAR} IRS limit ({dollars(irsLimit)})</button></>
                    : <>The {LIMITS_YEAR} IRS limit{account.type === 'hsa' ? (account.age >= 55 ? ', with the 55+ catch-up' : '') : account.age >= 50 ? ', with catch-up for your age' : ''}. Limits usually rise each year; edit it if yours differs.</>}
                </small>
              </>
            )}
            <Field label={irsLimit != null ? 'Starting balance in this account' : 'Starting value'} suffix="$" value={inp.startValue} onChange={set('startValue')} step={100} />
            <Field label="Dividend yield" suffix="%" value={inp.yieldPct} onChange={set('yieldPct')} step={0.1} />
            <Field label="Monthly contribution" suffix="$" value={inp.monthlyContribution} onChange={set('monthlyContribution')} step={50} />
            {overLimit && (
              <p className="limit-note">
                Only {dollars(limit!)} a year can go in (about {dollars(limit! / 12)}/mo), so the planner adds {dollars(perYear)} a year, not {dollars(inp.monthlyContribution * 12)}.
              </p>
            )}
            <Slider label="Dividend growth / yr" value={inp.dividendGrowthPct} min={0} max={15} step={0.5} onChange={set('dividendGrowthPct')} />
            <Slider label="Share price growth / yr" value={inp.priceGrowthPct} min={-2} max={12} step={0.5} onChange={set('priceGrowthPct')} />
            {info.tax === 'yearly'
              ? <Slider label="Dividend tax rate" value={inp.taxRatePct} min={0} max={40} step={1} onChange={set('taxRatePct')} />
              : <p className="muted small tax-note">{info.tax === 'free' ? 'No tax on dividends in this account, so every dollar is reinvested.' : 'No tax on dividends while they stay invested. Withdrawals are taxed as income.'}</p>}
            <Slider label="Years" value={inp.years} min={1} max={40} step={1} onChange={set('years')} unit="" />
            <label className="switch-row">
              <span>Reinvest dividends (DRIP)</span>
              <input type="checkbox" className="switch" checked={inp.reinvest} onChange={set('reinvest')} />
            </label>
            <button className="link-btn" onClick={() => startFrom(from)}>Reset to {from === 'portfolio' ? 'my portfolio' : 'this account'}</button>
          </div>
        </Card>

        <div className="planner-out">
          <div className="stats three">
            <Stat label={`Income in ${thisYear + inp.years}`}
              sub={<><Money v={end.annualIncome / 12} whole />/mo{info.tax === 'free' ? ' · tax-free' : info.tax === 'deferred' ? ' · before tax on withdrawal' : ''}</>}>
              <Money v={end.annualIncome} whole />
            </Stat>
            <Stat label="Portfolio value" sub={<>You put in <Money v={end.contributed} whole /></>}><Money v={end.value} whole /></Stat>
            <Stat label={`${dollars(settings.monthlyGoal)}/mo goal`} sub={goalYear ? `in ${goalYear.year} year${goalYear.year === 1 ? '' : 's'}` : 'Not within this horizon'}>
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
          <p className="footnote">
            A simple model, not a forecast: steady growth rates, contributions at month end, dividends paid monthly. Real returns vary.
            {limit != null && ` Contributions are capped at ${dollars(limit)} a year and the limit is held flat.`}
          </p>
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
