import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Account, Coverage, Flows, FlowNode, HouseholdFull, Person, Txn, UsedBy } from '../api/types';
import { fmt, monthLabel, shiftMonth, shortDate, thisMonth, today } from '../lib/format';
import { Avatar, BrandTile, brandOf, Chip, EmptyState, Field, logoOf, Sheet, ErrorCard, Icon, List, ListRow, Meter, Money, Page, PageSkeleton, Section, Tile } from '../ui';
import { TxnRow, TxnSheet } from './Activity';
import { EditAccountSheet, KIND_LABEL, KIND_TILE } from './More';

/* ---------- Money flow (Sankey) ---------- */
const COLOR: Record<FlowNode['kind'], string> = { inflow: '#30d158', account: '#0a84ff', spending: '#ff9f0a', outflow: '#bf5af2' };
type Laid = FlowNode & { x: number; y: number; h: number; value: number; col: number };

/** Columns: inflows → accounts (deeper when fed by another account) → spending/outflows. Pure layout, no library. */
export function layoutSankey(f: Flows, width: number, height: number) {
  const val = new Map<string, { in: number; out: number }>();
  for (const n of f.nodes) val.set(n.id, { in: 0, out: 0 });
  for (const l of f.links) { val.get(l.source)!.out += l.amount.minor; val.get(l.target)!.in += l.amount.minor; }
  const depth = new Map<string, number>(f.nodes.map(n => [n.id, n.kind === 'inflow' ? 0 : 1]));
  for (let pass = 0; pass < f.nodes.length; pass++) { // relax; capped so a transfer cycle can't loop forever
    let changed = false;
    for (const l of f.links) {
      const s = f.nodes.find(n => n.id === l.source)!, t = f.nodes.find(n => n.id === l.target)!;
      if (s.kind === 'account' && t.kind === 'account' && depth.get(l.target)! <= depth.get(l.source)! && depth.get(l.source)! < 4) { depth.set(l.target, depth.get(l.source)! + 1); changed = true; }
    }
    if (!changed) break;
  }
  const last = Math.max(1, ...f.nodes.filter(n => n.kind === 'account').map(n => depth.get(n.id)!)) + 1;
  for (const n of f.nodes) if (n.kind === 'spending' || n.kind === 'outflow') depth.set(n.id, last);
  const cols: FlowNode[][] = Array.from({ length: last + 1 }, () => []);
  for (const n of f.nodes) if (val.get(n.id)!.in + val.get(n.id)!.out > 0) cols[depth.get(n.id)!].push(n);
  const value = (id: string) => Math.max(val.get(id)!.in, val.get(id)!.out);
  const gap = 22, nodeW = 10;
  const k = Math.min(...cols.filter(c => c.length).map(c => (height - gap * (c.length - 1)) / c.reduce((s, n) => s + value(n.id), 0)));
  const laid = new Map<string, Laid>();
  const usable = cols.filter(c => c.length);
  usable.forEach((c, ci) => {
    c.sort((a, b) => (a.kind === b.kind ? value(b.id) - value(a.id) : a.kind === 'spending' ? -1 : 1));
    let y = 0;
    const x = usable.length === 1 ? 0 : (ci * (width - nodeW)) / (usable.length - 1);
    for (const n of c) { const h = Math.max(2, value(n.id) * k); laid.set(n.id, { ...n, x, y, h, value: value(n.id), col: ci }); y += h + gap; }
  });
  const outOff = new Map<string, number>(), inOff = new Map<string, number>();
  const links = [...f.links].filter(l => laid.has(l.source) && laid.has(l.target))
    .sort((a, b) => laid.get(a.target)!.y - laid.get(b.target)!.y)
    .map(l => {
      const s = laid.get(l.source)!, t = laid.get(l.target)!, w = Math.max(1, l.amount.minor * k);
      const y0 = s.y + (outOff.get(s.id) || 0), y1 = t.y + (inOff.get(t.id) || 0);
      outOff.set(s.id, (outOff.get(s.id) || 0) + w); inOff.set(t.id, (inOff.get(t.id) || 0) + w);
      const x0 = s.x + nodeW, x1 = t.x, xm = (x0 + x1) / 2;
      return { ...l, d: `M${x0},${y0}C${xm},${y0} ${xm},${y1} ${x1},${y1}L${x1},${y1 + w}C${xm},${y1 + w} ${xm},${y0 + w} ${x0},${y0 + w}Z`, color: COLOR[s.kind], s, t };
    });
  return { nodes: [...laid.values()], links, nodeW, cols: usable.length };
}

function Sankey({ f }: { f: Flows }) {
  const [hover, setHover] = useState<string | null>(null);
  const [width, setWidth] = useState(340);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(300, Math.floor(e.contentRect.width))));
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const perCol = Math.max(...['inflow', 'account', 'spending'].map(k => f.nodes.filter(n => (k === 'spending' ? n.kind === 'spending' || n.kind === 'outflow' : n.kind === k)).length));
  const height = Math.max(320, perCol * 40);
  const narrow = width < 500; // phones: tighter label gutters so a 3-column flow fits without sideways scrolling
  const padL = narrow ? 82 : 112, padR = narrow ? 82 : 112;
  const cols = useMemo(() => layoutSankey(f, 600, height).cols, [f, height]);
  const step = narrow && cols <= 3 ? 88 : 130; // a deeper chain of accounts scrolls sideways, never the page
  const w = Math.max(width, padL + padR + (cols - 1) * step);
  const L = useMemo(() => layoutSankey(f, w - padL - padR, height), [f, w, height]);
  const halo = { paintOrder: 'stroke', stroke: 'var(--glass-solid)', strokeWidth: 3, strokeLinejoin: 'round' } as const;
  return (
    <div ref={box} style={{ overflowX: 'auto', overflowY: 'hidden' }}>
      {w > width && <p className="caption" style={{ marginBottom: 6, position: 'sticky', left: 0 }}>Swipe the chart sideways to follow the money →</p>}
      <svg viewBox={`${-padL} -8 ${w} ${height + 16}`} width={w} height={height + 16} role="img" aria-label="Money flow between income, accounts and spending" style={{ display: 'block', overflow: 'visible' }}>
        {L.links.map((l, i) => (
          <path key={i} d={l.d} fill={l.color} opacity={hover && hover !== l.source && hover !== l.target ? 0.06 : 0.26} style={{ transition: 'opacity .2s' }}>
            <title>{`${l.s.name} → ${l.t.name}: ${fmt(l.amount)}`}</title>
          </path>
        ))}
        {L.nodes.map(n => {
          const right = n.col === L.cols - 1, left = n.col === 0;
          const tx = right ? n.x + L.nodeW + 6 : left ? n.x - 6 : n.x + L.nodeW + 4;
          const anchor = right || !left ? 'start' : 'end';
          const name = n.name.replace(/ Bank\b/, ''), max = narrow && step < 130 ? 13 : 17, short = name.length > max ? name.slice(0, max - 1) + '…' : name;
          return (
            <g key={n.id} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)} onClick={() => setHover(hover === n.id ? null : n.id)}>
              <rect x={n.x} y={n.y} width={L.nodeW} height={n.h} rx={3} fill={COLOR[n.kind]} />
              <text x={tx} y={n.y + Math.min(n.h / 2, 10)} textAnchor={anchor} dominantBaseline="middle" style={{ font: '600 11.5px var(--font)', fill: 'var(--text)', ...halo }}>
                {short}<title>{n.name}</title>
                <tspan x={tx} dy="13" style={{ font: '500 10.5px var(--font)', fill: 'var(--text-2)' }}>{fmt({ minor: n.value, currency: f.currency }, { compact: true })}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

type Range = 'month' | '3m' | 'year';
export function FlowsPage() {
  const [month, setMonth] = useState(thisMonth());
  const [range, setRange] = useState<Range>('month');
  const end = month === thisMonth() ? today() : `${month}-${new Date(+month.slice(0, 4), +month.slice(5), 0).getDate()}`;
  const from = range === 'month' ? `${month}-01` : range === '3m' ? `${shiftMonth(month, -2)}-01` : `${month.slice(0, 4)}-01-01`;
  const q = useApi<Flows>('/insights/flows', { from, to: end });
  const f = q.data;
  const kindOf = (id: string) => f?.nodes.find(n => n.id === id)?.kind;
  // transfers (account → account, or the other side not found) are neither income nor spending
  const sum = (ok: (l: Flows['links'][number]) => boolean) => (f ? f.links.filter(ok).reduce((s, l) => s + l.amount.minor, 0) : 0);
  const cameIn = sum(l => kindOf(l.source) === 'inflow' && l.source !== 'in:transfer');
  const spent = sum(l => kindOf(l.target) === 'spending');
  const moved = sum(l => (kindOf(l.source) === 'account' && kindOf(l.target) === 'account') || l.source === 'in:transfer' || l.target === 'out:transfer');
  return (
    <Page title="Money flow" back="/more" subtitle="Where money came in, which accounts it passed through, and where it went.">
      <div className="between" style={{ flexWrap: 'wrap' }}>
        <div className="month-switch" role="group" aria-label="Month">
          <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="chevL" /></button>
          <strong aria-live="polite">{range === 'year' ? month.slice(0, 4) : range === '3m' ? `${monthLabel(shiftMonth(month, -2))} – ${monthLabel(month)}` : monthLabel(month, true)}</strong>
          <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth()} style={{ opacity: month >= thisMonth() ? .3 : 1 }} aria-label="Next month"><Icon name="chevR" /></button>
        </div>
        <div className="chips">
          {([['month', 'Month'], ['3m', '3 months'], ['year', 'Year']] as [Range, string][]).map(([v, l]) => <Chip key={v} on={range === v} onClick={() => setRange(v)}>{l}</Chip>)}
        </div>
      </div>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !f!.links.length ? (
        <EmptyState icon="chart" title="No movement in this period" text="Pick another month, or import a statement." />
      ) : (
        <>
          <div className="grid-2">
            <div className="glass card stat"><span className="k"><i className="dot" style={{ background: COLOR.inflow }} />Came in</span><span className="v pos"><Money m={{ minor: cameIn, currency: f!.currency }} compact /></span></div>
            <div className="glass card stat"><span className="k"><i className="dot" style={{ background: COLOR.spending }} />Spent</span><span className="v"><Money m={{ minor: spent, currency: f!.currency }} compact /></span></div>
          </div>
          <div className="glass card">
            <Sankey f={f!} />
            <p className="footnote" style={{ marginTop: 8 }}>In {f!.currency}, rupees converted at today’s rate. {moved > 0 && <><b>{fmt({ minor: moved, currency: f!.currency }, { compact: true })}</b> moved between your own accounts (the links between blue bars): not counted as income or spending.</>}{' '}
              <span className="desktop-only">Hover a bar to trace it.</span></p>
          </div>
          <Section title="Biggest flows">
            <List>{f!.links.slice(0, 8).map((l, i) => {
              const s = f!.nodes.find(n => n.id === l.source)!, t = f!.nodes.find(n => n.id === l.target)!;
              return <ListRow key={i} icon={s.kind === 'inflow' ? <Tile icon="arrowDown" color={COLOR.inflow} /> : t.kind === 'account' ? <Tile icon="transfer" color={COLOR.account} /> : <Tile icon="arrowUp" color={COLOR[t.kind]} />}
                title={t.name} sub={`from ${s.name}`} end={<Money m={l.amount} />} />;
            })}</List>
          </Section>
        </>
      )}
    </Page>
  );
}

/* ---------- Coverage: is every account up to date? ---------- */
const SRC_COLOR: Record<string, string> = { sms: 'var(--green-fill)', statement: 'var(--tint-fill)', manual: 'var(--orange-fill)', shortcut: 'var(--green-fill)', peer: '#bf5af2' };
const STATUS: Record<Coverage['status'], [string, string]> = { ok: ['green', 'Up to date'], gaps: ['red', 'Gaps'], stale: ['orange', 'Gone quiet'], no_data: ['', 'No data'] };

export function CoverageStrip({ c, size = 14 }: { c: Coverage; size?: number }) {
  const months = c.months.slice(-12);
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end' }} role="img"
      aria-label={months.map(m => `${monthLabel(m.month)}: ${m.covered ? m.sources.join(' and ') || 'covered' : 'missing'}`).join('; ')}>
      {months.map(m => {
        const src = m.sources.length ? m.sources : m.covered ? ['statement'] : [];
        return (
          <span key={m.month} title={`${monthLabel(m.month, true)} · ${m.covered ? src.join(' + ') : 'missing'}`}
            style={{ width: size, height: size + 4, borderRadius: 4, display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 'none',
              boxShadow: m.covered ? undefined : 'inset 0 0 0 1.5px var(--red-fill)', background: m.covered ? undefined : 'transparent' }}>
            {src.map(s => <i key={s} style={{ flex: 1, background: SRC_COLOR[s] || 'var(--fill-2)' }} />)}
          </span>
        );
      })}
    </div>
  );
}
const quiet = (c: Coverage) => (c.days_quiet === null ? 'No movements yet' : c.days_quiet === 0 ? 'Last movement today' : `Last movement ${c.days_quiet} day${c.days_quiet === 1 ? '' : 's'} ago`);

export function CoverageCard({ c }: { c: Coverage }) {
  return (
    <div className="stack-sm">
      <div className="between"><span className="caption">{quiet(c)}</span><span className={`badge ${STATUS[c.status][0]}`}>{STATUS[c.status][1]}</span></div>
      {c.months.length > 0 && <CoverageStrip c={c} size={18} />}
      {c.missing_months.length > 0 && (
        <p className="caption neg"><Icon name="warn" size={13} /> Missing {c.missing_months.map(m => monthLabel(m, true)).join(', ')} — import that statement to fill the gap.</p>
      )}
    </div>
  );
}

export function CoveragePage() {
  const q = useApi<{ items: Coverage[]; this_month: string }>('/accounts/coverage');
  const items = q.data?.items || [];
  const bad = items.filter(c => c.status !== 'ok');
  return (
    <Page title="Up to date?" back="/more/accounts" subtitle="Every account, every month — from SMS or a statement.">
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !items.length ? (
        <EmptyState icon="calendar" title="No accounts to check yet" text="Once you add accounts, each one gets a month-by-month strip showing which months came in by SMS or statement, and which are missing."
          action={<Link to="/more/accounts" className="btn small">Add account</Link>} />
      ) : (
        <>
          <div className="glass card row-flex">
            <Tile icon={bad.length ? 'warn' : 'check'} color={bad.length ? '#ff9f0a' : '#30d158'} />
            <div style={{ flex: 1 }}><b>{bad.length ? `${bad.length} of ${items.length} accounts need a look` : 'Everything is up to date'}</b>
              <p className="caption">Filled = covered · <span style={{ color: 'var(--green)' }}>green SMS</span> · <span style={{ color: 'var(--tint)' }}>blue statement</span> · hollow red = missing</p></div>
          </div>
          <List>
            {[...items].sort((a, b) => (a.status === 'ok' ? 1 : 0) - (b.status === 'ok' ? 1 : 0)).map(c => (
              <Link key={c.account_id} to={`/more/accounts/${c.account_id}`} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingTop: 14, paddingBottom: 14 }}>
                <div className="between">
                  <span className="row-flex" style={{ minWidth: 0 }}><Tile icon={(KIND_TILE[c.kind] || KIND_TILE.bank)[0]} color={(KIND_TILE[c.kind] || KIND_TILE.bank)[1]} /><span style={{ minWidth: 0 }}><b>{c.name}</b><br /><span className="caption">{KIND_LABEL[c.kind]?.replace(/s$/, '')} · {c.currency}</span></span></span>
                  <span className={`badge ${STATUS[c.status][0]}`}>{STATUS[c.status][1]}</span>
                </div>
                {c.months.length > 0 && <CoverageStrip c={c} />}
                <span className="caption">{quiet(c)}{c.missing_months.length ? <span className="neg"> · missing {c.missing_months.map(m => monthLabel(m)).join(', ')}</span> : null}</span>
              </Link>
            ))}
          </List>
          <Link to="/more/import" className="btn block secondary"><Icon name="upload" />Import a statement</Link>
        </>
      )}
    </Page>
  );
}

/* ---------- One account ---------- */
export function AccountPage() {
  const { id = '' } = useParams();
  const accounts = useApi<{ items: Account[] }>('/accounts');
  const cov = useApi<{ items: Coverage[] }>('/accounts/coverage');
  const txns = useApi<{ items: Txn[] }>('/transactions', { account_id: id, limit: 15 });
  const hh = useApi<HouseholdFull>('/households/current');
  const [open, setOpen] = useState<Txn | null>(null);
  const [editing, setEditing] = useState(false);
  const [lending, setLending] = useState(false);
  const a = accounts.data?.items.find(x => x.id === id);
  const c = cov.data?.items.find(x => x.account_id === id);
  const owner = hh.data?.members.find(m => m.id === a?.owner_member_id)?.display_name;
  const [icon, color] = KIND_TILE[a?.kind || 'bank'] || KIND_TILE.bank;
  return (
    <Page title={a ? `${a.institution}${a.last4 ? ' ··' + a.last4 : ''}` : 'Account'} back="/more/accounts"
      trail={a && <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>}>
      {accounts.isLoading ? <PageSkeleton /> : !a ? <EmptyState icon="bank" title="Account not found" /> : (
        <div className="grid-desktop stack">
          <section className="glass hero span-2">
            <div className="row-flex">{brandOf(a.institution) || logoOf(a.institution) ? <BrandTile name={a.institution} /> : <Tile icon={icon} color={color} />}<div><b>{a.name}</b><p className="caption">{KIND_LABEL[a.kind]?.replace(/s$/, '')} · {a.country} · {a.currency}{owner ? ` · ${owner}` : ''}{a.visibility === 'private' ? ' · private' : ''}</p></div></div>
            <div className={`hero-amount ${a.balance && a.balance.minor < 0 ? 'neg' : ''}`} style={{ fontSize: 40 }}>{fmt(a.balance)}</div>
            <p className="caption">{a.balance_at ? `Balance as of ${shortDate(a.balance_at.slice(0, 10))}` : 'No balance seen yet — it appears from the next SMS or statement'}</p>
            {a.credit_limit && a.used_pct !== null && (
              <div className="stack-sm" style={{ marginTop: 14 }}>
                <Meter pct={a.used_pct} color={a.used_pct > 70 ? 'var(--red-fill)' : a.used_pct > 30 ? 'var(--orange-fill)' : 'var(--green-fill)'} />
                <span className="caption">{a.used_pct}% of <Money m={a.credit_limit} /> used{a.due_day ? ` · pay by the ${a.due_day}th` : ''}{a.rate_bp ? ` · ${(a.rate_bp / 100).toFixed(1)}% a year` : ''}</span>
              </div>
            )}
          </section>
          <Section title="Statement coverage" action={<Link to="/more/coverage">All accounts</Link>}>
            <div className="glass card">{c ? <CoverageCard c={c} /> : <div className="skel" style={{ height: 40 }} />}</div>
          </Section>
          <Section title="Links">
            <List>
              <ListRow to={`/activity?account_id=${a.id}`} icon={<Tile icon="activity" color="#0a84ff" />} title="All transactions" />
              <ListRow to={`/more/import?account=${a.id}`} icon={<Tile icon="upload" color="#30b0c7" />} title="Import a statement" sub="Fills any missing months" />
              <ListRow onClick={() => setLending(true)} icon={<Tile icon="person" color="#ff9f0a" />} title="Someone else used it" sub="Spending between two dates is theirs, now and when imported later" />
              <ListRow to="/more/flows" icon={<Tile icon="chart" color="#bf5af2" />} title="Money flow" sub="Where this account’s money went" />
            </List>
          </Section>
          <UsedByRanges a={a} />
          <Section title="Recent">
            {txns.data?.items.length ? <List>{txns.data.items.slice(0, 15).map(t => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</List>
              : txns.isLoading ? <PageSkeleton /> : <p className="caption" style={{ marginLeft: 4 }}>No transactions yet.</p>}
          </Section>
        </div>
      )}
      <TxnSheet txn={open} onClose={() => setOpen(null)} />
      {a && <EditAccountSheet key={a.id} a={a} open={editing} onClose={() => setEditing(false)} />}
      {a && <UsedBySheet a={a} open={lending} onClose={() => setLending(false)} />}
    </Page>
  );
}

/** The saved "someone else used it" ranges, each removable (what it tagged goes back to being yours). */
function UsedByRanges({ a }: { a: Account }) {
  const q = useApi<{ items: UsedBy[] }>(`/accounts/${a.id}/used-by`);
  const del = useWrite<{ id: string }>('DELETE', b => `/accounts/${a.id}/used-by/${b.id}`);
  if (!q.data?.items.length) return null;
  return (
    <Section title="Lent to someone">
      <List>{q.data.items.map(r => (
        <ListRow key={r.id} icon={<Avatar name={r.person.name || '?'} />} title={r.person.name} sub={`${shortDate(r.from)} – ${shortDate(r.to)} · ${r.purpose === 'support' ? 'family support' : 'they owe you'}`}
          end={<button className="link-btn" style={{ color: 'var(--red)' }} disabled={del.isPending} aria-label={`Remove ${r.person.name}’s range`}
            onClick={() => confirm(`Remove this range? Its spending goes back to being yours.`) && del.mutate({ id: r.id })}>Remove</button>} chevron={false} />
      ))}</List>
    </Section>
  );
}

/** A card lent to someone for a stretch (e.g. a roommate's trip): every money-out row in the dates becomes theirs. */
function UsedBySheet({ a, open, onClose }: { a: Account; open: boolean; onClose: () => void }) {
  const people = (useApi<{ items: Person[] }>(open ? '/people' : null).data?.items || []).filter(p => p.relation !== 'self');
  const [who, setWho] = useState<Person | null>(null);
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const save = useWrite<object, { tagged: number }>('POST', `/accounts/${a.id}/used-by`);
  const [done, setDone] = useState<number | null>(null);
  const close = () => { setDone(null); setWho(null); save.reset(); onClose(); };
  return (
    <Sheet open={open} onClose={close} title="Someone else used it">
      {done !== null ? <div className="stack"><p>{done} spend{done === 1 ? '' : 's'} marked as {who?.name}’s.</p><button className="btn block" onClick={close}>Done</button></div> : (
        <div className="stack">
          <p className="caption">Spending on {a.name} between these days becomes {who ? who.name + '’s' : 'theirs'}, including statements and SMS that arrive later: friends then owe you, family counts as support. Fees, interest and card charges stay yours.</p>
          <div className="row-flex" style={{ gap: 8 }}>
            <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
            <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
          </div>
          <List>{people.map(p => <ListRow key={p.kind + p.id} icon={<Avatar name={p.name} photo={p.photo} />} title={p.name} sub={p.kind === 'member' ? 'Family' : 'Friend'}
            end={who?.id === p.id ? <Icon name="check" size={22} className="pos" /> : undefined} onClick={() => setWho(p)} chevron={false} />)}</List>
          {save.error && <p className="caption neg">{save.error.message}</p>}
          <button className="btn block" disabled={!who || !from || !to || to < from || save.isPending}
            onClick={async () => setDone((await save.mutateAsync({ person: { kind: who!.kind, id: who!.id }, from, to })).tagged)}>Mark as theirs</button>
        </div>
      )}
    </Sheet>
  );
}
