import { ReactNode, useId, useState } from 'react';

/** Small SVG chart kit: animated in CSS (styles.css "charts"), theme-aware through CSS variables, no library. */
export type ChartItem = { label: string; value: number; color?: string };

/** Categorical colours, distinct in light and dark. Pass `color` on an item to pin one (e.g. red for losses). */
export const CHART_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#40c8e0', '#ffcc00', '#ff375f', '#5e5ce6', '#a2845e', '#8e8e93'];
const colorOf = (it: ChartItem, i: number) => it.color || CHART_COLORS[i % CHART_COLORS.length];
const plain = (v: number) => Math.round(v).toLocaleString();
const pctOf = (v: number, total: number) => (total > 0 ? Math.round((v / total) * 100) : 0);

type Common = { format?: (v: number) => string; onSelect?: (item: ChartItem, index: number) => void; label?: string };

/** Ring of segments with a legend. `center` sits in the hole (a total, say). Negative and zero values are left out. */
export function Donut({ items, center, size = 220, thickness = 26, legend = true, format = plain, onSelect, label = 'Breakdown' }:
  Common & { items: ChartItem[]; center?: ReactNode; size?: number; thickness?: number; legend?: boolean }) {
  const [on, setOn] = useState<number | null>(null);
  const shown = items.map((it, i) => ({ ...it, color: colorOf(it, i), idx: i })).filter(it => it.value > 0);
  const total = shown.reduce((s, it) => s + it.value, 0);
  const r = (size - thickness) / 2 - 4;
  const gap = shown.length > 1 ? 0.6 : 0; // percent of the ring between segments
  let acc = 0;
  const summary = shown.map(it => `${it.label} ${format(it.value)} (${pctOf(it.value, total)}%)`).join(', ');
  return (
    <div className="donut-wrap">
      <div className="donut-box" style={{ width: `min(${size}px, 60vw)` }}>
        <svg className={`ch ${on !== null ? 'dim' : ''}`} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${summary || 'nothing yet'}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill)" strokeWidth={thickness} />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {shown.map((it, i) => {
              const len = (it.value / total) * 100, off = acc;
              acc += len;
              return (
                <circle key={it.label} className={`seg-arc ${on === i ? 'on' : ''}`} cx={size / 2} cy={size / 2} r={r} fill="none" pathLength={100}
                  stroke={it.color} strokeWidth={thickness} strokeDasharray={`${Math.max(0.01, len - gap)} ${100 - Math.max(0.01, len - gap)}`} strokeDashoffset={-off}
                  style={{ ['--i' as string]: i, ['--sw-on' as string]: thickness + 6 }} onPointerEnter={() => setOn(i)} onPointerLeave={() => setOn(null)} />
              );
            })}
          </g>
        </svg>
        {center !== undefined && <div className="donut-center">{center}</div>}
      </div>
      {legend && shown.length > 0 && (
        <ul className="ch-legend" aria-label={`${label} legend`}>
          {shown.map((it, i) => {
            const inner = <><i className="sw" style={{ background: it.color }} /><span className="lbl">{it.label}</span><span className="val">{format(it.value)}</span><span className="pct">{pctOf(it.value, total)}%</span></>;
            return (
              <li key={it.label} onPointerEnter={() => setOn(i)} onPointerLeave={() => setOn(null)}>
                {onSelect ? <button type="button" onClick={() => onSelect(items[it.idx], it.idx)}>{inner}</button> : <div>{inner}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Horizontal bars, one per category, longest first as given. `max` fixes the scale (defaults to the largest value). */
export function BarRow({ items, max, format = plain, onSelect, label = 'By category' }: Common & { items: (ChartItem & { hint?: ReactNode })[]; max?: number }) {
  const top = max ?? Math.max(1, ...items.map(it => Math.abs(it.value)));
  return (
    <ul className="barrow" aria-label={label}>
      {items.map((it, i) => {
        const w = Math.max(1.5, Math.min(100, (Math.abs(it.value) / top) * 100));
        const inner = (
          <>
            <span className="top"><span>{it.label}{it.hint ? <span className="caption"> · {it.hint}</span> : null}</span><span className="val">{format(it.value)}</span></span>
            <span className="track" aria-hidden><i style={{ width: `${w}%`, background: colorOf(it, i), ['--i' as string]: i }} /></span>
          </>
        );
        return <li key={it.label}>{onSelect ? <button type="button" onClick={() => onSelect(it, i)} aria-label={`${it.label} ${format(it.value)}`}>{inner}</button> : <div>{inner}</div>}</li>;
      })}
    </ul>
  );
}

/** Column per month (6–12 of them). `highlight` marks one (the current month); negatives hang below the line in red. */
export function MiniBars({ items, highlight, height = 120, format = plain, onSelect, label = 'Monthly spend', color = 'var(--tint-fill)' }:
  Common & { items: ChartItem[]; highlight?: number; height?: number; color?: string }) {
  const gid = useId().replace(/:/g, '');
  const w = 320, top = 18, bottom = 18, h = height - top - bottom;
  const max = Math.max(1, ...items.map(d => Math.abs(d.value)));
  const hasNeg = items.some(d => d.value < 0);
  const scale = hasNeg ? h / (2 * max) : h / max;
  const zero = hasNeg ? top + h / 2 : top + h;
  const bw = w / Math.max(1, items.length);
  const hi = highlight ?? items.length - 1;
  return (
    <svg className="ch" viewBox={`0 0 ${w} ${height}`} role="img" aria-label={`${label}: ${items.map(d => `${d.label} ${format(d.value)}`).join(', ')}`}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} /><stop offset="1" stopColor={color} stopOpacity=".55" /></linearGradient>
      </defs>
      <line x1="0" x2={w} y1={zero} y2={zero} stroke="var(--hairline)" />
      {items.map((d, i) => {
        const bh = Math.max(2, Math.abs(d.value) * scale), x = i * bw + bw * 0.18, y = d.value >= 0 ? zero - bh : zero;
        const fill = d.value < 0 ? 'var(--red-fill)' : d.color || `url(#${gid})`;
        return (
          <g key={`${d.label}-${i}`} onClick={onSelect ? () => onSelect(d, i) : undefined} style={{ cursor: onSelect ? 'pointer' : undefined }}>
            <rect x={i * bw} y={top} width={bw} height={h} fill="transparent" />
            <rect className={`mbar ${d.value < 0 ? 'neg' : ''}`} x={x} y={y} width={bw * 0.64} height={bh} rx={Math.min(6, bw * 0.25)} fill={fill}
              opacity={i === hi ? 1 : 0.5} style={{ ['--i' as string]: i }}><title>{`${d.label}: ${format(d.value)}`}</title></rect>
            {i === hi && <text x={i * bw + bw / 2} y={Math.max(11, y - 5)} textAnchor="middle" style={{ fontWeight: 700, fill: 'var(--text)' }}>{format(d.value)}</text>}
            <text x={i * bw + bw / 2} y={height - 3} textAnchor="middle" style={i === hi ? { fontWeight: 700, fill: 'var(--text)' } : undefined}>{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
