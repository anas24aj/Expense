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
export function MiniBars({ items, highlight, height = 120, format = plain, onSelect, label = 'Monthly spend', color = 'var(--tint-fill)', avg, labelEvery = 1, selected }:
  Common & { items: ChartItem[]; highlight?: number; height?: number; color?: string; avg?: number; labelEvery?: number; selected?: number | null }) {
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
        const on = selected === undefined || selected === null ? i === hi : i === selected;
        const fill = d.value < 0 ? 'var(--red-fill)' : d.color || `url(#${gid})`;
        return (
          <g key={`${d.label}-${i}`} onClick={onSelect ? () => onSelect(d, i) : undefined} style={{ cursor: onSelect ? 'pointer' : undefined }}>
            <rect x={i * bw} y={top} width={bw} height={h} fill="transparent" />
            <rect className={`mbar ${d.value < 0 ? 'neg' : ''}`} x={x} y={y} width={bw * 0.64} height={bh} rx={Math.min(6, bw * 0.25)} fill={fill}
              opacity={on ? 1 : 0.5} style={{ ['--i' as string]: i }}><title>{`${d.label}: ${format(d.value)}`}</title></rect>
            {on && avg === undefined && <text x={i * bw + bw / 2} y={Math.max(11, y - 5)} textAnchor="middle" style={{ fontWeight: 700, fill: 'var(--text)' }}>{format(d.value)}</text>}
            {(i % labelEvery === 0 || on) && <text x={i * bw + bw / 2} y={height - 3} textAnchor="middle" style={on ? { fontWeight: 700, fill: 'var(--text)' } : undefined}>{d.label}</text>}
          </g>
        );
      })}
      {avg !== undefined && <g aria-hidden>
        <line x1="0" x2={w} y1={zero - avg * scale} y2={zero - avg * scale} stroke="var(--text-2)" strokeDasharray="4 3" />
        <text x={w} y={zero - avg * scale - 4} textAnchor="end">avg {format(avg)}</text>
      </g>}
    </svg>
  );
}

/** Columns of stacked parts (e.g. spend, interest, fees) per month, with an optional second column (payments) beside each. */
export function StackedBars({ items, parts, side, height = 140, format = plain, label = 'By month' }:
  Common & { items: { label: string; values: number[]; side?: number }[]; parts: { label: string; color: string }[]; side?: { label: string; color: string }; height?: number }) {
  const w = 320, top = 8, bottom = 18, h = height - top - bottom;
  const max = Math.max(1, ...items.map(d => Math.max(d.values.reduce((a, v) => a + Math.max(0, v), 0), d.side || 0)));
  const bw = w / Math.max(1, items.length), cw = side ? bw * 0.32 : bw * 0.6;
  return (
    <div className="stack-sm">
      <svg className="ch" viewBox={`0 0 ${w} ${height}`} role="img"
        aria-label={`${label}: ${items.map(d => `${d.label} ${parts.map((p, k) => `${p.label} ${format(d.values[k] || 0)}`).join(', ')}${side ? `, ${side.label} ${format(d.side || 0)}` : ''}`).join('; ')}`}>
        <line x1="0" x2={w} y1={top + h} y2={top + h} stroke="var(--hairline)" />
        {items.map((d, i) => {
          let y = top + h;
          const x = i * bw + (side ? bw * 0.14 : bw * 0.2);
          return (
            <g key={`${d.label}-${i}`}>
              {d.values.map((v, k) => {
                const bh = Math.max(0, v) * h / max;
                y -= bh;
                return bh > 0 ? <rect key={k} className="mbar" x={x} y={y} width={cw} height={bh} fill={parts[k].color} style={{ ['--i' as string]: i }}><title>{`${d.label} ${parts[k].label}: ${format(v)}`}</title></rect> : null;
              })}
              {side && (d.side || 0) > 0 && <rect className="mbar" x={x + cw + bw * 0.06} y={top + h - (d.side || 0) * h / max} width={cw} height={(d.side || 0) * h / max} fill={side.color} rx={2}
                style={{ ['--i' as string]: i }}><title>{`${d.label} ${side.label}: ${format(d.side || 0)}`}</title></rect>}
              <text x={i * bw + bw / 2} y={height - 3} textAnchor="middle">{d.label}</text>
            </g>
          );
        })}
      </svg>
      <ul className="ch-legend inline" aria-hidden>{[...parts, ...(side ? [side] : [])].map(p => <li key={p.label}><div><i className="sw" style={{ background: p.color }} /><span className="lbl">{p.label}</span></div></li>)}</ul>
    </div>
  );
}

/** From a starting amount, each step takes away (or adds) a part, ending at what is left: a waterfall. */
export function Waterfall({ start, steps, format = plain, label = 'From income to what is left' }:
  Common & { start: ChartItem; steps: ChartItem[] }) {
  const w = 320, rowH = 26, labelW = 104, h = rowH * (steps.length + 2);
  let run = start.value;
  const rows = [{ ...start, from: 0, to: start.value, color: start.color || 'var(--green-fill)' }];
  for (const s of steps) { rows.push({ ...s, from: run, to: run - s.value, color: s.color || 'var(--orange-fill)' }); run -= s.value; }
  rows.push({ label: run < 0 ? 'Short by' : 'Left over', value: run, from: 0, to: run, color: run < 0 ? 'var(--red-fill)' : 'var(--green-fill)' });
  const lo = Math.min(0, ...rows.map(r => Math.min(r.from, r.to))), hi = Math.max(1, ...rows.map(r => Math.max(r.from, r.to)));
  const x = (v: number) => labelW + ((v - lo) / (hi - lo)) * (w - labelW - 8);
  return (
    <svg className="ch" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: ${rows.map(r => `${r.label} ${format(r.value)}`).join(', ')}`}>
      <line x1={x(0)} x2={x(0)} y1={0} y2={h} stroke="var(--hairline)" />
      {rows.map((r, i) => {
        const a = x(Math.min(r.from, r.to)), b = x(Math.max(r.from, r.to)), last = i === rows.length - 1;
        return (
          <g key={`${r.label}-${i}`}>
            <text x={0} y={i * rowH + rowH / 2 + 4} style={last || !i ? { fontWeight: 700, fill: 'var(--text)' } : undefined}>{r.label.length > 16 ? r.label.slice(0, 15) + '…' : r.label}</text>
            <rect className="mbar" x={a} y={i * rowH + 5} width={Math.max(2, b - a)} height={rowH - 10} rx={4} fill={r.color} style={{ ['--i' as string]: i }}><title>{`${r.label}: ${format(r.value)}`}</title></rect>
            {i > 0 && !last && <line x1={x(r.from)} x2={x(r.from)} y1={i * rowH - 5} y2={i * rowH + 5} stroke="var(--text-2)" strokeDasharray="2 2" />}
          </g>
        );
      })}
    </svg>
  );
}

/** Stacked areas over time (each debt falling to zero), with an optional dashed total to compare (paying extra). */
export function StackedArea({ labels, series, compare, height = 150, format = plain, label = 'Over time', labelEvery = 1 }:
  Common & { labels: string[]; series: { label: string; values: number[]; color?: string }[]; compare?: { label: string; values: number[] }; height?: number; labelEvery?: number }) {
  const w = 320, top = 8, bottom = 18, h = height - top - bottom, n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i] || 0), 0));
  const max = Math.max(1, ...totals, ...(compare?.values || []));
  const x = (i: number) => (n <= 1 ? w / 2 : (i * w) / (n - 1));
  const y = (v: number) => top + h - (v / max) * h;
  const acc = labels.map(() => 0);
  const paths = series.map((s, k) => {
    const lower = acc.slice();
    labels.forEach((_, i) => { acc[i] += Math.max(0, s.values[i] || 0); });
    const up = labels.map((_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(acc[i]).toFixed(1)}`).join('');
    const down = labels.map((_, i) => `L${x(n - 1 - i).toFixed(1)},${y(lower[n - 1 - i]).toFixed(1)}`).join('');
    return { d: up + down + 'Z', color: s.color || CHART_COLORS[k % CHART_COLORS.length], label: s.label };
  });
  return (
    <div className="stack-sm">
      <svg className="ch" viewBox={`0 0 ${w} ${height}`} role="img"
        aria-label={`${label}: ${labels.map((l, i) => `${l} ${format(totals[i])}${compare ? `, ${compare.label} ${format(compare.values[i] || 0)}` : ''}`).filter((_, i) => i % labelEvery === 0).join('; ')}`}>
        {paths.map(p => <path key={p.label} d={p.d} fill={p.color} opacity={0.75}><title>{p.label}</title></path>)}
        {compare && <path d={compare.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')} fill="none" stroke="var(--text)" strokeWidth={2} strokeDasharray="5 4" />}
        <line x1="0" x2={w} y1={top + h} y2={top + h} stroke="var(--hairline)" />
        {labels.map((l, i) => i % labelEvery === 0 ? <text key={i} x={Math.min(w - 12, Math.max(12, x(i)))} y={height - 3} textAnchor="middle">{l}</text> : null)}
      </svg>
      <ul className="ch-legend inline" aria-hidden>{paths.map(p => <li key={p.label}><div><i className="sw" style={{ background: p.color }} /><span className="lbl">{p.label}</span></div></li>)}
        {compare && <li><div><i className="sw dash" /><span className="lbl">{compare.label}</span></div></li>}</ul>
    </div>
  );
}

/** A small trend line (net worth by month): no axes, the last value marked. */
export function Sparkline({ values, height = 40, label = 'Trend', format = plain }: Common & { values: number[]; height?: number }) {
  const w = 320, min = Math.min(...values), max = Math.max(...values), n = values.length;
  const x = (i: number) => (n <= 1 ? w / 2 : 4 + (i * (w - 8)) / (n - 1));
  const y = (v: number) => 4 + (height - 8) * (1 - (v - min) / (max - min || 1));
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const up = n > 1 && values[n - 1] >= values[0];
  return (
    <svg className="ch" viewBox={`0 0 ${w} ${height}`} role="img" aria-label={`${label}: ${values.map(format).join(', ')}`} preserveAspectRatio="none" style={{ height }}>
      <path d={d} fill="none" stroke={up ? 'var(--green-fill)' : 'var(--red-fill)'} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {n > 0 && <circle cx={x(n - 1)} cy={y(values[n - 1])} r={3.5} fill={up ? 'var(--green-fill)' : 'var(--red-fill)'} />}
    </svg>
  );
}

/** One bar: what you own (green) against what you owe (red), with both amounts under it. */
export function OwnOweBar({ own, owe, ownLabel, oweLabel }: { own: number; owe: number; ownLabel: ReactNode; oweLabel: ReactNode }) {
  const pct = own + owe > 0 ? (100 * own) / (own + owe) : 50;
  return (
    <div className="stack-sm">
      <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden' }} role="img" aria-label={`Own ${pct.toFixed(0)}%, owe ${(100 - pct).toFixed(0)}%`}>
        <i style={{ width: `${pct}%`, background: 'var(--green-fill)' }} /><i style={{ flex: 1, background: 'var(--red-fill)' }} />
      </div>
      <div className="between caption"><span>Own <b className="pos">{ownLabel}</b></span><span>Owe <b className="neg">{oweLabel}</b></span></div>
    </div>
  );
}
