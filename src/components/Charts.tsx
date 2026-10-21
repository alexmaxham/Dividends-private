import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { money, money0, moneyCompact, monthLong, monthShort, dateLong } from '../lib/format';
import type { MonthBar } from '../lib/analytics';
import { PrivacyContext } from './ui';

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Round "nice" tick step so gridlines land on readable values. */
function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 80), width - 80);
  return <div className="tooltip glass-chip" style={{ left, top: y }}>{children}</div>;
}

/** Bar shape with 4px rounded data end and a square baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

// ───────────── Monthly income: received vs projected ─────────────

export function IncomeBars({ data, goal, height = 240 }: { data: MonthBar[]; goal?: number; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const hidden = useContext(PrivacyContext);
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: hidden ? 12 : 48, r: 8, t: 12, b: 28 };
  const max = Math.max(...data.map((d) => d.received + d.projected), goal ?? 0, 1);
  const yt = ticks(max);
  const top = yt[yt.length - 1];
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const slot = iw / data.length;
  const bw = Math.max(4, Math.min(28, slot * 0.62));
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const every = slot < 22 ? 3 : slot < 34 ? 2 : 1;
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label="Monthly dividend income, received and projected">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--series-1)" opacity="0.28" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--series-1)" strokeWidth="2.2" opacity="0.75" />
          </pattern>
        </defs>
        {yt.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            {!hidden && <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="axis">{moneyCompact(t)}</text>}
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2;
          const rh = (d.received / top) * ih;
          const ph = (d.projected / top) * ih;
          const gap = rh > 0 && ph > 0 ? 2 : 0;
          return (
            <g key={d.month} opacity={hover === null || hover === i ? 1 : 0.55}>
              {rh > 0 && <path d={barPath(x, y(d.received), bw, rh, ph > 0 ? 0 : 4)} fill="var(--series-1)" />}
              {ph > 0 && <path d={barPath(x, y(d.received + d.projected), bw, ph - gap)} fill="url(#hatch)" />}
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent"
                onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
              {i % every === 0 && (
                <text x={x + bw / 2} y={height - 10} textAnchor="middle" className={`axis ${d.month.endsWith('-01') ? 'strong' : ''}`}>
                  {d.month.endsWith('-01') ? `’${d.month.slice(2, 4)}` : monthShort(d.month).slice(0, slot < 30 ? 1 : 3)}
                </text>
              )}
            </g>
          );
        })}
        {goal ? (
          <g>
            <line x1={pad.l} x2={width - pad.r} y1={y(goal)} y2={y(goal)} className="goal-line" />
            <text x={width - pad.r - 4} y={y(goal) - 6} textAnchor="end" className="axis strong">Goal</text>
          </g>
        ) : null}
        <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih} y2={pad.t + ih} className="baseline" />
      </svg>
      {h && hover !== null && (
        <Tooltip x={pad.l + hover * slot + slot / 2} y={y(h.received + h.projected) - 10} width={width}>
          <strong>{monthLong(h.month)}</strong>
          {h.received > 0 && <div><i className="sw solid" />Received <b>{hidden ? '•••' : money(h.received)}</b></div>}
          {h.projected > 0 && <div><i className="sw hatch" />Expected <b>{hidden ? '•••' : money(h.projected)}</b></div>}
          {h.received + h.projected === 0 && <div className="muted">No payments</div>}
        </Tooltip>
      )}
    </div>
  );
}

// ───────────── Simple vertical bars (e.g. income per year) ─────────────

export function Bars({ data, height = 200, label, format = moneyCompact }: { data: { label: string; value: number; note?: string }[]; height?: number; label: string; format?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const hidden = useContext(PrivacyContext);
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 8, r: 8, t: 26, b: 26 };
  const max = Math.max(...data.map((d) => d.value), 1);
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const slot = iw / Math.max(1, data.length);
  const bw = Math.min(56, slot * 0.6);
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={label}>
        {data.map((d, i) => {
          const bh = (d.value / max) * ih;
          const x = pad.l + i * slot + (slot - bw) / 2;
          return (
            <g key={d.label} onMouseEnter={() => setHover(i)}>
              <path d={barPath(x, pad.t + ih - bh, bw, bh)} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.55} />
              <text x={x + bw / 2} y={pad.t + ih - bh - 8} textAnchor="middle" className="value-label">{hidden ? '•••' : format(d.value)}</text>
              <text x={x + bw / 2} y={height - 8} textAnchor="middle" className="axis">{d.label}</text>
              <rect x={pad.l + i * slot} y={0} width={slot} height={height} fill="transparent" />
            </g>
          );
        })}
        <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih} y2={pad.t + ih} className="baseline" />
      </svg>
      {hover !== null && data[hover]?.note && (
        <Tooltip x={pad.l + hover * slot + slot / 2} y={pad.t} width={width}>{data[hover].note}</Tooltip>
      )}
    </div>
  );
}

// ───────────── Line / area chart with crosshair ─────────────

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
  dashed?: boolean;
  area?: boolean;
}

export function LineChart({ series, xLabels, height = 220, format = money0, xFormat = dateLong, label }: {
  series: Series[]; xLabels: string[]; height?: number; format?: (n: number) => string; xFormat?: (s: string) => string; label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const hidden = useContext(PrivacyContext);
  const [hover, setHover] = useState<number | null>(null);
  const n = xLabels.length;
  const pad = { l: hidden ? 12 : 56, r: 12, t: 14, b: 26 };
  const all = series.flatMap((s) => s.values);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) { hi += 1; lo -= 1; }
  const span = hi - lo;
  lo = lo >= 0 ? Math.max(0, lo - span * 0.08) : lo - span * 0.04;
  hi += span * 0.06;
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const grid = [0, 0.33, 0.66, 1].map((f) => lo + (hi - lo) * f);
  const labelIdx = n <= 1 ? [0] : [0, Math.round((n - 1) / 2), n - 1];

  const onMove = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - pad.l) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          {series.filter((s) => s.area).map((s) => (
            <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.35" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={pad.l} x2={width - pad.r} y1={y(g)} y2={y(g)} className="grid" />
            {!hidden && <text x={pad.l - 8} y={y(g) + 4} textAnchor="end" className="axis">{moneyCompact(g)}</text>}
          </g>
        ))}
        {series.map((s) => {
          const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
          return (
            <g key={s.key}>
              {s.area && <path d={`${d}L${x(n - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z`} fill={`url(#fill-${s.key})`} />}
              <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeDasharray={s.dashed ? '5 5' : undefined} />
            </g>
          );
        })}
        {labelIdx.map((i, k) => (
          <text key={i} x={x(i)} y={height - 8} textAnchor={k === 0 ? 'start' : k === labelIdx.length - 1 ? 'end' : 'middle'} className="axis">
            {xFormat(xLabels[i])}
          </text>
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="crosshair" />
            {series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r="4.5" fill={s.color} stroke="var(--surface-ring)" strokeWidth="2" />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <Tooltip x={x(hover)} y={pad.t} width={width}>
          <strong>{xFormat(xLabels[hover])}</strong>
          {series.map((s) => (
            <div key={s.key}><i className="sw" style={{ background: s.color }} />{s.label} <b>{hidden ? '•••' : format(s.values[hover])}</b></div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color?: string; hatch?: boolean; dashed?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}>
          <i className={`sw ${it.hatch ? 'hatch' : ''} ${it.dashed ? 'dashed' : ''}`} style={it.color && !it.hatch ? { background: it.dashed ? 'none' : it.color, borderColor: it.color } : undefined} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Horizontal bar rows: label, bar, value. Good for ranked shares (income by holding, by sector). */
export function BarList({ rows, format, max }: { rows: { label: ReactNode; value: number; key: string; sub?: string }[]; format: (n: number) => ReactNode; max?: number }) {
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="barlist">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="bl-label">{r.label}</span>
          <span className="bl-track"><span className="bl-fill" style={{ width: `${Math.max(1.5, (r.value / top) * 100)}%` }} /></span>
          <span className="bl-value">{format(r.value)}{r.sub && <small>{r.sub}</small>}</span>
        </li>
      ))}
    </ul>
  );
}

/** Progress ring for the income goal. */
export function Ring({ value, size = 132, stroke = 12, children }: { value: number; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--series-1)" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}
