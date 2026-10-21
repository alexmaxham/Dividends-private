import { useMemo, useState } from 'react';
import { addDays, daysBetween, monthlySeries } from '../lib/analytics';
import { dateShort, pct, signedPct } from '../lib/format';
import type { Store } from '../useStore';
import { IncomeBars, Legend, LineChart, Ring } from './Charts';
import { Card, Empty, Money, Segmented, Stat, Ticker } from './ui';

const RANGES = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, All: 99999 } as const;
type Range = keyof typeof RANGES;

export function Overview({ s, openHolding, goTo }: { s: Store; openHolding: (sym: string) => void; goTo: (tab: string) => void }) {
  const { totals, payouts, portfolio, today, settings, holdings } = s;
  const [range, setRange] = useState<Range>('6M');
  const bars = useMemo(() => monthlySeries(portfolio.dividends, payouts, today, 12, 12), [portfolio.dividends, payouts, today]);
  const history = useMemo(() => {
    const from = addDays(today, -RANGES[range]);
    return portfolio.history.filter((h) => h.date >= from);
  }, [portfolio.history, range, today]);
  const upcoming = payouts.filter((p) => daysBetween(today, p.date) <= 45).slice(0, 7);
  const year = today.slice(0, 4);
  const restOfYear = payouts.filter((p) => p.date.startsWith(year)).reduce((a, p) => a + p.amount, 0);
  const lastYear = useMemo(() => portfolio.dividends.filter((d) => d.payDate.startsWith(String(Number(year) - 1)) && (d.state === 'paid' || d.state === 'reinvested'))
    .reduce((a, d) => a + d.amount, 0), [portfolio.dividends, year]);
  const yearEnd = totals.receivedYtd + restOfYear;
  const thisMonth = bars[11];
  const monthTotal = thisMonth.received + thisMonth.projected;
  const goalProgress = settings.monthlyGoal ? totals.monthlyIncome / settings.monthlyGoal : 0;
  const ytdChange = totals.receivedLastYearSamePeriod ? (totals.receivedYtd / totals.receivedLastYearSamePeriod - 1) * 100 : null;
  const top = holdings.filter((h) => h.annualIncome > 0).sort((a, b) => b.annualIncome - a.annualIncome).slice(0, 5);

  return (
    <div className="page">
      <div className="hero glass">
        <div>
          <div className="stat-label">Portfolio value</div>
          <div className="hero-value"><Money v={totals.value} /></div>
          <div className="hero-sub">
            <span className={totals.dayChange >= 0 ? 'up' : 'down'}><Money v={totals.dayChange} sign /> ({signedPct(totals.dayChangePct)}) today</span>
            <span className="dot-sep" />
            <span className={totals.gain >= 0 ? 'up' : 'down'}><Money v={totals.gain} sign /> ({signedPct(totals.gainPct)}) all time</span>
          </div>
        </div>
        <div className="hero-income">
          <div className="stat-label">Forward annual income</div>
          <div className="hero-value accent"><Money v={totals.annualIncome} /></div>
          <div className="hero-sub"><span><Money v={totals.monthlyIncome} />/mo</span><span className="dot-sep" /><span><Money v={totals.dailyIncome} />/day</span></div>
        </div>
      </div>

      <div className="stats">
        <Stat label="Yield" sub={<>Yield on cost <b>{pct(totals.yieldOnCost)}</b></>}>{pct(totals.currentYield)}</Stat>
        <Stat label={`Received ${today.slice(0, 4)}`} tone={ytdChange === null ? undefined : ytdChange >= 0 ? 'up' : 'down'}
          sub={ytdChange === null ? 'Year to date' : `${signedPct(ytdChange, 1)} vs same time last year`}>
          <Money v={totals.receivedYtd} />
        </Stat>
        <Stat label="This month" sub={thisMonth.projected > 0 ? <><Money v={thisMonth.received} /> paid so far</> : 'All paid'}>
          <Money v={monthTotal} />
        </Stat>
        <Stat label="All-time dividends" sub={<>Last 12 months <Money v={totals.receivedLast12} whole /></>}>
          <Money v={totals.receivedAllTime} />
        </Stat>
      </div>

      <div className="grid-2">
        <Card title="Monthly income" className="span-2"
          action={<Legend items={[{ label: 'Received', color: 'var(--series-1)' }, { label: 'Expected', hatch: true }]} />}>
          <IncomeBars data={bars} goal={settings.monthlyGoal || undefined} />
        </Card>

        <Card title="Coming up" action={<button className="link-btn" onClick={() => goTo('calendar')}>Calendar</button>}>
          {upcoming.length ? (
            <ul className="rows">
              {upcoming.map((p) => (
                <li key={`${p.symbol}-${p.date}`} onClick={() => openHolding(p.symbol)} className="clickable">
                  <Ticker symbol={p.symbol} />
                  <div className="row-main">
                    <b>{p.symbol}</b>
                    <small>{dateShort(p.date)} · {p.kind === 'confirmed' ? <span className="tag ok">Confirmed</span> : <span className="tag">Estimated</span>}</small>
                  </div>
                  <Money v={p.amount} className="row-amt" />
                </li>
              ))}
            </ul>
          ) : <Empty>No payments expected in the next 45 days.</Empty>}
        </Card>

        <div className="stack">
        <Card title="Income goal" action={<button className="link-btn" onClick={() => goTo('settings')}>Edit</button>}>
          <div className="goal">
            <Ring value={goalProgress}>
              <b className="num">{Math.round(goalProgress * 100)}%</b>
              <small>of goal</small>
            </Ring>
            <div className="goal-text">
              <div><Money v={totals.monthlyIncome} /> <span className="muted">/ <Money v={settings.monthlyGoal} whole /> a month</span></div>
              {goalProgress < 1 ? (
                <p className="muted">
                  About <Money v={((settings.monthlyGoal - totals.monthlyIncome) * 12) / Math.max(totals.currentYield / 100, 0.001)} whole /> more
                  invested at your {pct(totals.currentYield)} yield gets you there.
                </p>
              ) : <p className="up">Goal reached. Time to raise it?</p>}
            </div>
          </div>
        </Card>
          <Card title={`${year} outlook`}>
            <div className="outlook">
              <div><span>Received</span><b><Money v={totals.receivedYtd} /></b></div>
              <div><span>Still to come</span><b><Money v={restOfYear} /></b></div>
              <div><span>Full year</span><b className="accent"><Money v={yearEnd} /></b></div>
            </div>
            {lastYear > 0 && (
              <p className={`muted small outlook-note`}>
                {yearEnd >= lastYear ? 'Up' : 'Down'} <b className={yearEnd >= lastYear ? 'up' : 'down'}>{signedPct((yearEnd / lastYear - 1) * 100, 1)}</b> on {Number(year) - 1}'s <Money v={lastYear} />.
              </p>
            )}
          </Card>
        </div>

        <Card title="Portfolio value" className="span-2"
          action={<Segmented label="Range" value={range} onChange={setRange} options={(Object.keys(RANGES) as Range[]).map((r) => ({ value: r, label: r }))} />}>
          {history.length > 1 ? (
            <>
              <LineChart label="Portfolio value over time" xLabels={history.map((h) => h.date)} series={[
                { key: 'value', label: 'Value', color: 'var(--series-1)', values: history.map((h) => h.value), area: true },
                { key: 'cost', label: 'Invested', color: 'var(--ink-3)', values: history.map((h) => h.cost), dashed: true },
              ]} />
              <Legend items={[{ label: 'Value', color: 'var(--series-1)' }, { label: 'Invested', color: 'var(--ink-3)', dashed: true }]} />
            </>
          ) : <Empty>Value history builds up with each daily sync.</Empty>}
        </Card>

        <Card title="Top payers" className="span-2" action={<button className="link-btn" onClick={() => goTo('holdings')}>All holdings</button>}>
          <ul className="rows cols">
            {top.map((h) => (
              <li key={h.symbol} className="clickable" onClick={() => openHolding(h.symbol)}>
                <Ticker symbol={h.symbol} />
                <div className="row-main"><b>{h.symbol}</b><small>{pct(h.currentYield)} yield · {Math.round(h.incomeShare * 100)}% of income</small></div>
                <span className="row-amt"><Money v={h.annualIncome} /><small>/yr</small></span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
