import { Component, createContext, ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import type { Money as M } from '../api/types';
import { fmt, monthLabel } from '../lib/format';
import { Icon } from './Icon';

export { Icon, Tile, CategoryTile, Avatar, brandOf } from './Icon';

/* ---------- Money ---------- */
export function Money({ m, compact, sign, cents, className = '', tone }: { m: M | null | undefined; compact?: boolean; sign?: boolean; cents?: boolean; className?: string; tone?: boolean }) {
  const t = tone && m ? (m.minor < 0 ? 'neg' : m.minor > 0 ? 'pos' : '') : '';
  return <span className={`num ${t} ${className}`}>{fmt(m, { compact, sign, cents })}</span>;
}
/** Several currencies side by side, never summed. */
export function Monies({ items, empty = '—' }: { items: M[]; empty?: string }) {
  if (!items.length) return <span className="muted">{empty}</span>;
  return <>{items.map((m, i) => <span key={m.currency}>{i ? ' · ' : ''}<Money m={m} /></span>)}</>;
}

/* ---------- Page: top bar + collapsing large title ---------- */
export function Page({ title, subtitle, back, trail, children }: { title: string; subtitle?: ReactNode; back?: string | true; trail?: ReactNode; children: ReactNode }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setCollapsed(!e.isIntersecting), { rootMargin: '-60px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => { document.title = `${title} · Ledger`; }, [title]);
  return (
    <div className="page-enter">
      <header className={`topbar ${collapsed ? 'collapsed' : ''}`}>
        <div className="lead">
          {back && (
            <button className="icon-btn" onClick={() => (back === true ? nav(-1) : nav(back))} aria-label="Back">
              <Icon name="chevL" />
            </button>
          )}
        </div>
        <div className="small-title" aria-hidden={!collapsed}>{title}</div>
        <div className="trail">{trail}</div>
      </header>
      <h1 className="large-title">{title}</h1>
      <div ref={sentinel} />
      {subtitle && <p className="large-sub">{subtitle}</p>}
      <div className="stack">{children}</div>
    </div>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="stack-sm" aria-label={title}>
      <h2 className="section-title"><span>{title}</span>{action}</h2>
      {children}
    </section>
  );
}

/* ---------- list rows ---------- */
type RowProps = { icon?: ReactNode; title: ReactNode; sub?: ReactNode; end?: ReactNode; endSub?: ReactNode; to?: string; onClick?: () => void; chevron?: boolean; label?: string };
export function ListRow({ icon, title, sub, end, endSub, to, onClick, chevron, label }: RowProps) {
  const inner = (
    <>
      {icon}
      <div className="body"><div className="title">{title}</div>{sub && <div className="sub">{sub}</div>}</div>
      {(end || endSub) && <div className="end">{end && <div className="amt">{end}</div>}{endSub && <div className="caption">{endSub}</div>}</div>}
      {(chevron ?? !!(to || onClick)) && <Icon name="chevR" className="chev" />}
    </>
  );
  const cls = `list-row ${icon ? '' : 'no-icon'}`;
  if (to) return <Link className={cls} to={to} aria-label={label}>{inner}</Link>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-label={label}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}
export const List = ({ children, className = '' }: { children: ReactNode; className?: string }) => <div className={`glass list ${className}`}>{children}</div>;

/* ---------- Chip / Badge ---------- */
export function Chip({ on, onClick, children, icon }: { on?: boolean; onClick?: () => void; children: ReactNode; icon?: string }) {
  return <button type="button" className="chip" aria-pressed={!!on} onClick={onClick}>{icon && <Icon name={icon} />}{children}</button>;
}
const STATUS: Record<string, [string, string]> = { paid: ['green', 'Paid'], due: ['orange', 'Due'], overdue: ['red', 'Overdue'], upcoming: ['', 'Upcoming'] };
export const StatusBadge = ({ status }: { status: string }) => <span className={`badge ${STATUS[status]?.[0] || ''}`}>{STATUS[status]?.[1] || status}</span>;

/* ---------- Segmented control ---------- */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const i = Math.max(0, options.findIndex(o => o.value === value));
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      <span className="thumb" style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${i * 100}%)` }} />
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ---------- Progress ring ---------- */
export function ProgressRing({ pct, size = 56, stroke = 6, color = 'var(--tint-fill)', label }: { pct: number; size?: number; stroke?: number; color?: string; label?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
  return (
    <span className="ring-wrap" style={{ width: size, height: size }} role="img" aria-label={`${Math.round(p)} percent`}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} />
      </svg>
      <span className="ring-label">{label ?? `${Math.round(p)}%`}</span>
    </span>
  );
}
export const Meter = ({ pct, color }: { pct: number; color?: string }) => (
  <div className="meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: color }} /></div>
);

/* ---------- charts (SVG, no library) ---------- */
type Pt = { month: string; value: number };
export function BarChart({ data, height = 140, highlight }: { data: Pt[]; height?: number; highlight?: number }) {
  const w = 320, top = 14, bottom = 20, h = height - top - bottom;
  const max = Math.max(1, ...data.map(d => Math.abs(d.value)));
  const hasNeg = data.some(d => d.value < 0);
  const zero = hasNeg ? top + h * (max / (2 * max)) : top + h;
  const scale = hasNeg ? h / (2 * max) : h / max;
  const bw = w / data.length;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Free money by month">
      <defs>
        <linearGradient id="barg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--tint-fill)" /><stop offset="1" stopColor="var(--tint-fill)" stopOpacity=".55" /></linearGradient>
      </defs>
      <line x1="0" x2={w} y1={zero} y2={zero} stroke="var(--hairline)" />
      {data.map((d, i) => {
        const bh = Math.max(2, Math.abs(d.value) * scale);
        const x = i * bw + bw * 0.2, y = d.value >= 0 ? zero - bh : zero;
        return (
          <g key={d.month}>
            <rect x={x} y={y} width={bw * 0.6} height={bh} rx={Math.min(6, bw * 0.3)} fill={d.value < 0 ? 'var(--red-fill)' : 'url(#barg)'} opacity={highlight === undefined || highlight === i ? 1 : 0.45} />
            <text x={i * bw + bw / 2} y={height - 4} textAnchor="middle">{monthLabel(d.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}
export function AreaChart({ data, height = 120 }: { data: Pt[]; height?: number }) {
  const gid = useId().replace(/:/g, '');
  const w = 320, top = 10, bottom = 20, h = height - top - bottom;
  const vals = data.map(d => d.value), max = Math.max(...vals), min = Math.min(0, ...vals);
  const x = (i: number) => (data.length === 1 ? w / 2 : 10 + (i * (w - 20)) / (data.length - 1));
  const y = (v: number) => top + h - ((v - min) / (max - min || 1)) * h;
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join('');
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label="Look-ahead of free money">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--tint-fill)" stopOpacity=".35" /><stop offset="1" stopColor="var(--tint-fill)" stopOpacity="0" /></linearGradient>
      </defs>
      <path d={`${line}L${x(data.length - 1)},${top + h}L${x(0)},${top + h}Z`} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="var(--tint-fill)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => (
        <g key={d.month}>
          <circle cx={x(i)} cy={y(d.value)} r="3.5" fill={d.value < 0 ? 'var(--red-fill)' : 'var(--glass-solid)'} stroke={d.value < 0 ? 'var(--red-fill)' : 'var(--tint-fill)'} strokeWidth="2" />
          <text x={x(i)} y={height - 4} textAnchor="middle">{monthLabel(d.month)}</text>
        </g>
      ))}
    </svg>
  );
}

/* ---------- Empty / Skeleton ---------- */
export function EmptyState({ icon = 'sparkle', title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="glass empty">
      <span className="icon-tile" style={{ background: 'linear-gradient(160deg, #5ac8fa, #0a84ff)' }}><Icon name={icon} /></span>
      <h3>{title}</h3>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}
export const Skeleton = ({ h = 20, w = '100%', r }: { h?: number; w?: number | string; r?: number }) => <div className="skel" style={{ height: h, width: w, borderRadius: r }} aria-hidden />;
export function PageSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      <Skeleton h={200} r={26} />
      <Skeleton h={72} r={26} />
      <Skeleton h={160} r={26} />
    </div>
  );
}
export function ErrorCard({ error, retry }: { error: Error | null; retry?: () => void }) {
  return <EmptyState icon="warn" title="Couldn’t load this" text={error?.message} action={retry && <button className="btn small secondary" onClick={retry}>Try again</button>} />;
}

/** Keeps one broken screen from blanking the app; resets when the route changes (key it by pathname). */
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    return this.state.error
      ? <div style={{ paddingTop: 80 }}><ErrorCard error={new Error('Something on this screen broke. Other tabs still work.')} retry={() => this.setState({ error: null })} /></div>
      : this.props.children;
  }
}

/* ---------- Sheet: bottom sheet with detents and drag to dismiss ---------- */
type Detent = 'auto' | 'medium' | 'large';
export function Sheet({ open, onClose, title, children, detent = 'auto', lead, trail }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; detent?: Detent; lead?: ReactNode; trail?: ReactNode }) {
  const [size, setSize] = useState<Detent>(detent);
  const [drag, setDrag] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ y: number; t: number } | null>(null);
  const titleId = useId();

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setClosing(false); setDrag(null); onClose(); }, 280);
  }, [onClose]);

  useEffect(() => { if (open) setSize(detent); }, [open, detent]);
  useLayoutEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab' && ref.current) { // keep focus inside the sheet
        const f = ref.current.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = overflow; prev?.focus?.(); };
  }, [open, close]);

  if (!open) return null;
  const onDown = (e: React.PointerEvent) => { start.current = { y: e.clientY, t: Date.now() }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setDrag(0); };
  const onMove = (e: React.PointerEvent) => { if (start.current) setDrag(e.clientY - start.current.y); };
  const onUp = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dy = e.clientY - start.current.y, v = dy / Math.max(1, Date.now() - start.current.t);
    start.current = null;
    if (dy > 140 || v > 0.8) { if (size === 'large' && detent !== 'large' && dy < 320) setSize(detent); else return close(); }
    else if (dy < -50) setSize('large');
    setDrag(null);
  };
  const height = size === 'large' ? 'calc(100dvh - var(--safe-t) - 14px)' : size === 'medium' ? '58dvh' : undefined;
  const offset = closing ? '100%' : drag !== null ? `${Math.max(0, drag)}px` : '0';
  const stretch = drag !== null && drag < 0 ? Math.min(40, -drag / 3) : 0;
  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={close} style={{ opacity: closing ? 0 : 1, transition: 'opacity .28s' }} />
      <div ref={ref} className={`sheet ${drag !== null ? 'dragging' : ''}`} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} tabIndex={-1}
        style={{ height, maxHeight: 'calc(100dvh - var(--safe-t) - 14px)', transform: `translateY(${offset})`, paddingTop: stretch }}>
        <div className="grabber" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}><i /></div>
        <div className="sheet-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="lead" onPointerDown={e => e.stopPropagation()}>{lead}</div>
          {title && <h2 id={titleId}>{title}</h2>}
          <div className="trail" onPointerDown={e => e.stopPropagation()}>{trail ?? <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={close} aria-label="Close"><Icon name="close" size={18} /></button>}</div>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

/* ---------- Toasts ---------- */
type ToastT = { id: number; text: string; undo?: () => void };
const ToastCtx = createContext<(text: string, undo?: () => void) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const push = useCallback((text: string, undo?: () => void) => {
    const id = Date.now() + Math.random();
    setItems(t => [...t.slice(-2), { id, text, undo }]);
    setTimeout(() => setItems(t => t.filter(x => x.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className="toast"><Icon name="check" />{t.text}{t.undo && <button onClick={t.undo}>Undo</button>}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- form bits ---------- */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
export function Toggle({ label, checked, onChange, sub }: { label: string; checked: boolean; onChange: (v: boolean) => void; sub?: string }) {
  return (
    <label className="toggle">
      <span><span style={{ display: 'block', fontWeight: 500 }}>{label}</span>{sub && <span className="caption">{sub}</span>}</span>
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={e => onChange(e.target.checked)} />
    </label>
  );
}
/** Big centered amount entry (keypad on phones). */
export function AmountInput({ value, onChange, currency, onCurrency, label = 'Amount', autoFocus }: { value: string; onChange: (v: string) => void; currency: string; onCurrency?: (c: string) => void; label?: string; autoFocus?: boolean }) {
  return (
    <div className="stack-sm" style={{ alignItems: 'center' }}>
      <div className="amount-input">
        <span className="cur">{currency === 'INR' ? '₹' : currency}</span>
        <input aria-label={label} inputMode="decimal" placeholder="0" value={value} autoFocus={autoFocus} style={{ width: `${Math.max(1, value.length) + 0.6}ch` }}
          onChange={e => onChange(e.target.value.replace(/[^\d.]/g, ''))} />
      </div>
      {onCurrency && (
        <div style={{ width: 180 }}>
          <Segmented label="Currency" value={currency} onChange={onCurrency} options={[{ value: 'SAR', label: 'SAR' }, { value: 'INR', label: 'INR ₹' }]} />
        </div>
      )}
    </div>
  );
}
