import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Claim, Money as M, Trip, TripDetail, TripExpense, TripStatus } from '../api/types';
import { fmt, shortDate, today } from '../lib/format';
import { Chip, CategoryTile, EmptyState, ErrorCard, Field, Icon, List, ListRow, Money, Page, PageSkeleton, Section, Segmented, Sheet, Tile, useToast } from '../ui';
import { ImportClaimSheet } from './People';

const ST: Record<TripStatus, { label: string; badge: string }> = {
  claimed: { label: 'Claimed', badge: 'green' },
  personal: { label: 'Personal', badge: '' },
  missed: { label: 'Missed claim', badge: 'red' },
  unreviewed: { label: 'To review', badge: 'orange' },
};
const range = (t: Trip) => `${shortDate(t.start_on).replace(/,? \d{4}$/, '')} – ${shortDate(t.end_on)}`;
const md = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
/** "Nov 8 – 12" or "Oct 30 – Nov 2": the list groups by year. */
const shortRange = (t: Trip) => t.start_on.slice(0, 7) === t.end_on.slice(0, 7) ? `${md(t.start_on)} – ${Number(t.end_on.slice(8))}` : `${md(t.start_on)} – ${md(t.end_on)}`;
const nights =(t: Trip) => Math.round((new Date(t.end_on).getTime() - new Date(t.start_on).getTime()) / 864e5);
const sub = (a: M, b: M): M => ({ minor: a.minor - b.minor, currency: a.currency });

/** Spent = claimed + your cost + still to review (missed claims are your cost until claimed). */
const parts = (t: Trip) => [
  { k: 'Claimed', v: t.totals.claimed, c: 'var(--green-fill)' },
  { k: 'Your cost', v: sub(t.totals.burden, t.totals.unreviewed), c: 'var(--tint-fill)' },
  { k: 'To review', v: t.totals.unreviewed, c: 'var(--orange-fill)' },
];
function SplitBar({ t, thin }: { t: Trip; thin?: boolean }) {
  return (
    <div className={`stackbar${thin ? ' thin' : ''}`} role="img" aria-label={parts(t).map(p => `${p.k} ${fmt(p.v)}`).join(', ')}>
      {parts(t).map(p => p.v.minor > 0 && <span key={p.k} style={{ flexGrow: p.v.minor, background: p.c }} />)}
    </div>
  );
}

function TripRow({ t }: { t: Trip }) {
  const now = t.start_on <= today() && today() <= t.end_on;
  const { unreviewed, missed } = t.totals;
  return (
    <Link to={`/more/trips/${t.id}`} className="list-row" style={{ flexWrap: 'wrap', rowGap: 10 }}>
      <Tile icon="plane" color={t.kind === 'business' ? '#32ade6' : '#ff9f0a'} />
      <div className="body"><div className="title">{t.name}</div><div className="sub">{t.city} · {shortRange(t)}</div></div>
      <div className="end">
        <span className="amt"><Money m={t.totals.spent} /></span>
        {now ? <span className="badge blue">Now</span> : missed.minor ? <span className="badge red">Missed claim</span>
          : unreviewed.minor ? <span className="badge orange">To review</span> : t.count ? <span className="badge green">Done</span> : null}
      </div>
      {t.count > 0 && (
        <div style={{ flexBasis: '100%', paddingLeft: 50 }} className="stack-sm">
          <SplitBar t={t} thin />
          <span className="caption">{parts(t).filter(p => p.v.minor > 0).slice(0, 2).map((p, i) => <span key={p.k}>{i ? ' · ' : ''}{p.k} <Money m={p.v} /></span>)}</span>
        </div>
      )}
    </Link>
  );
}

export function TripsPage() {
  const q = useApi<{ items: Trip[] }>('/trips');
  const [adding, setAdding] = useState(false);
  const items = [...(q.data?.items || [])].sort((a, b) => b.start_on.localeCompare(a.start_on));
  const years = [...new Set(items.map(t => t.start_on.slice(0, 4)))];
  return (
    <Page title="Trips" back="/more" subtitle="Everything you spend between the dates lands in the trip. Claim what’s work."
      trail={<button className="icon-btn" onClick={() => setAdding(true)} aria-label="New trip"><Icon name="plus" /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !items.length
        ? <EmptyState icon="plane" title="No trips yet" text="Add one before you fly — expenses file themselves." action={<button className="btn small" onClick={() => setAdding(true)}>New trip</button>} />
        : years.map(y => (
          <Section key={y} title={y}>
            <List>{items.filter(t => t.start_on.startsWith(y)).map(t => <TripRow key={t.id} t={t} />)}</List>
          </Section>
        ))}
      <NewTripSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

const dayHead = (t: Trip, day: string) => {
  const n = Math.round((new Date(day).getTime() - new Date(t.start_on).getTime()) / 864e5) + 1;
  const label = new Date(day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
  return n >= 1 && day <= t.end_on ? `Day ${n} · ${label}` : label;
};

export function TripPage() {
  const { id } = useParams();
  const q = useApi<TripDetail>(`/trips/${id}`);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const tag = useWrite<{ txn_ids: string[]; status: TripStatus }>('POST', `/trips/${id}/tag`);
  const toast = useToast();
  const nav = useNavigate();
  const t = q.data;
  const days = useMemo(() => {
    const g = new Map<string, TripExpense[]>();
    for (const x of [...(t?.expenses || [])].sort((a, b) => a.day.localeCompare(b.day))) g.set(x.day, [...(g.get(x.day) || []), x]);
    return [...g.entries()];
  }, [t]);
  const setStatus = async (ids: string[], status: TripStatus) => {
    await tag.mutateAsync({ txn_ids: ids, status });
    toast(ids.length > 1 ? `${ids.length} marked ${ST[status].label.toLowerCase()}` : `Marked ${ST[status].label.toLowerCase()}`);
    setSel([]); setSelecting(false);
  };
  const open = t ? t.totals.missed.minor + t.totals.unreviewed.minor : 0;
  const spent = t ? fmt(t.totals.spent) : '';
  const code = t?.totals.spent.currency || '';
  return (
    <Page title={t?.name || 'Trip'} back="/more/trips"
      trail={t && <button className="icon-btn" aria-label={selecting ? 'Done selecting' : 'Select expenses'} onClick={() => { setSelecting(!selecting); setSel([]); }}><Icon name={selecting ? 'close' : 'check'} /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : t && (
        <div className="grid-desktop stack">
          <section className="glass hero span-2" aria-label="Trip totals">
            <span className="caption"><Icon name="globe" size={13} /> {t.city} · {range(t)} · {nights(t)} night{nights(t) === 1 ? '' : 's'}</span>
            <div className="hero-label" style={{ marginTop: 12 }}>Spent</div>
            <div className="hero-amount">{spent.startsWith(code + ' ') ? <><span className="cur">{code}</span>{spent.slice(code.length + 1)}</> : spent}</div>
            <p className="caption">{t.count} expense{t.count === 1 ? '' : 's'}{t.totals_base && t.currency !== t.totals_base.spent.currency ? <> · ≈ <Money m={t.totals_base.spent} /></> : null}</p>
            <SplitBar t={t} />
            <div className="legend three">
              {parts(t).map(p => <div key={p.k} className="stat"><span className="k"><i className="dot" style={{ background: p.c }} />{p.k}</span><span className="v"><Money m={p.v} /></span></div>)}
            </div>
            {t.totals.missed.minor > 0 && <p className="caption" style={{ marginTop: 12 }}><span className="neg">{fmt(t.totals.missed)} not claimed yet</span> — counted in your cost until you claim it.</p>}
            {t.kind === 'business' && (
              <div className="grid-2" style={{ marginTop: 16 }}>
                <button className="btn" style={{ fontSize: 15, padding: '0 12px', whiteSpace: 'nowrap' }} disabled={!open} onClick={() => setClaiming(true)}><Icon name="briefcase" size={18} />Claim {open ? fmt({ ...t.totals.missed, minor: open }) : ''}</button>
                <button className="btn glassy" style={{ fontSize: 15, padding: '0 12px', whiteSpace: 'nowrap' }} onClick={() => setImporting(true)}><Icon name="upload" size={18} />Import Excel</button>
              </div>
            )}
          </section>

          {t.by_category.length > 0 && (
            <Section title="By category">
              <List>{t.by_category.map(c => (
                <ListRow key={c.category} icon={<CategoryTile category={c.category} />} title={c.category}
                  sub={c.claimed.minor ? <>Claimed <Money m={c.claimed} /></> : 'Not claimed'}
                  end={<Money m={c.spent} />} endSub={c.claimed.minor > 0 && c.burden.minor > 0 && <>you pay <Money m={c.burden} /></>} />
              ))}</List>
            </Section>
          )}

          <Section title="Expenses" action={t.expenses.length > 0 && <button onClick={() => { setSelecting(!selecting); setSel([]); }}>{selecting ? 'Cancel' : 'Select'}</button>}>
            {!days.length && <EmptyState icon="receipt" title="Nothing spent yet" text="Card payments between the trip dates show up here." />}
            {days.map(([day, xs]) => {
              const d = t.by_day.find(b => b.day === day);
              return (
                <section key={day} aria-label={dayHead(t, day)}>
                  <h3 className="day-head sticky"><span>{dayHead(t, day)}</span>{d && <span className="num">{fmt(d.spent)}{d.burden.minor > 0 && <span className="day-you"> · you {fmt(d.burden)}</span>}</span>}</h3>
                  <List>{xs.map(x => {
                    const on = sel.includes(x.id);
                    const partial = x.trip_status === 'claimed' && x.burden.minor > 0;
                    return (
                      <div key={x.id} className="list-row" style={{ flexWrap: 'wrap', rowGap: 8 }}>
                        {selecting
                          ? <button type="button" className="icon-tile" aria-pressed={on} aria-label={`Select ${x.merchant}`} onClick={() => setSel(on ? sel.filter(i => i !== x.id) : [...sel, x.id])}
                              style={{ background: on ? 'var(--tint-fill)' : 'var(--fill)', border: 0, borderRadius: '50%', color: '#fff' }}>{on && <Icon name="check" />}</button>
                          : <CategoryTile category={x.category} merchant={x.merchant} />}
                        <div className="body"><div className="title">{x.merchant}</div><div className="sub">{[x.category, x.account_name].filter(Boolean).join(' · ')}</div></div>
                        <div className="end"><span className="amt"><Money m={x.amount} /></span><span className={`badge ${ST[x.trip_status].badge}`}>{ST[x.trip_status].label}</span></div>
                        {partial && <div className="caption" style={{ flexBasis: '100%', paddingLeft: 50 }}>Claimed <b className="pos"><Money m={x.claimed} /></b> · You pay <b><Money m={x.burden} /></b></div>}
                        {!selecting && x.trip_status !== 'claimed' && (
                          <div className="chips" style={{ flexBasis: '100%', paddingLeft: 50, paddingBottom: 0 }} role="group" aria-label={`Status of ${x.merchant}`}>
                            {(['personal', 'missed', 'claimed'] as TripStatus[]).map(s => (
                              <button key={s} type="button" className="chip" aria-pressed={x.trip_status === s} onClick={() => setStatus([x.id], s)} style={{ minHeight: 32, fontSize: 13 }}>
                                {s === 'missed' ? 'Claim it' : s === 'claimed' ? 'Claimed' : 'Personal'}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}</List>
                </section>
              );
            })}
          </Section>

          {t.claims.length > 0 && (
            <Section title="Claims">
              <List>{t.claims.map(c => (
                <ListRow key={c.id} icon={<Tile icon="briefcase" color="#0a84ff" />} title={c.name} sub={`${c.items.length} item${c.items.length === 1 ? "" : "s"} · ${c.status}`} end={<Money m={c.expected} />}
                  onClick={() => nav(`/people?tab=claims&claim=${c.id}`)} />
              ))}</List>
            </Section>
          )}
        </div>
      )}
      {selecting && (
        <div className="glass glass-strong" style={{ position: 'fixed', zIndex: 45, left: '50%', transform: 'translateX(-50%)', bottom: 'calc(max(calc(var(--safe-b) - 6px), 14px) + var(--tabbar-h) + 10px)', width: 'min(calc(100% - 32px), 440px)', padding: 10, borderRadius: 999, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="caption" style={{ padding: '0 8px', whiteSpace: 'nowrap' }}>{sel.length} selected</span>
          {(['personal', 'missed', 'claimed'] as TripStatus[]).map(s => <button key={s} className="btn small secondary" style={{ flex: 1, padding: '0 8px' }} disabled={!sel.length} onClick={() => setStatus(sel, s)}>{s === 'missed' ? 'Claim' : ST[s].label}</button>)}
        </div>
      )}
      {t && <ClaimTripSheet open={claiming} onClose={() => setClaiming(false)} trip={t} />}
      {t && <ImportClaimSheet open={importing} onClose={() => setImporting(false)} tripId={t.id} />}
    </Page>
  );
}

function ClaimTripSheet({ open, onClose, trip }: { open: boolean; onClose: () => void; trip: TripDetail }) {
  const [name, setName] = useState(`${trip.name} — expenses`);
  const make = useWrite<{ name: string }, Claim>('POST', `/trips/${trip.id}/claim`);
  const toast = useToast();
  const items = trip.expenses.filter(x => x.trip_status === 'missed' || x.trip_status === 'unreviewed');
  return (
    <Sheet open={open} onClose={onClose} title="Create claim">
      <div className="stack">
        <Field label="Claim name"><input className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
        <List>{items.map(x => <ListRow key={x.id} icon={<CategoryTile category={x.category} merchant={x.merchant} />} title={x.merchant} sub={shortDate(x.day)} end={<Money m={x.amount} />} />)}</List>
        <p className="caption" style={{ textAlign: 'center' }}>Everything marked <b>should claim</b> or <b>to sort</b>. Mark personal ones first.</p>
        {make.error && <p className="error" role="alert">{make.error.message}</p>}
        <button className="btn block" disabled={!name || make.isPending} onClick={async () => { const c = await make.mutateAsync({ name }); toast(`Claim made — ${fmt(c.expected)} expected`); onClose(); }}>Create claim</button>
      </div>
    </Sheet>
  );
}

/* ---------- New trip: name, place, a tap-tap date range ---------- */
const COUNTRIES = [['SA', 'Saudi Arabia'], ['AE', 'UAE'], ['IN', 'India'], ['QA', 'Qatar'], ['BH', 'Bahrain']];
function NewTripSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('AE');
  const [kind, setKind] = useState<'business' | 'personal'>('business');
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [name, setName] = useState('');
  const add = useWrite<Record<string, unknown>, Trip>('POST', '/trips');
  const toast = useToast();
  const nav = useNavigate();
  const save = async () => {
    const t = await add.mutateAsync({ name: name || `${city} ${kind === 'business' ? 'business trip' : 'trip'}`, city, country, start_on: from, end_on: to || from, kind });
    toast('Trip added'); onClose(); nav(`/more/trips/${t.id}`);
  };
  return (
    <Sheet open={open} onClose={onClose} title="New trip" detent="large">
      <div className="stack">
        <Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: 'business', label: 'Work' }, { value: 'personal', label: 'Personal' }]} />
        <Field label="City"><input className="input" value={city} onChange={e => setCity(e.target.value)} placeholder="Dubai" autoFocus /></Field>
        <div className="chips" style={{ flexWrap: 'wrap' }}>{COUNTRIES.map(([c, l]) => <Chip key={c} on={country === c} onClick={() => setCountry(c)}>{l}</Chip>)}</div>
        <RangePicker from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
        <Field label="Name (optional)"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={city ? `${city} ${kind === 'business' ? 'business trip' : 'trip'}` : 'Client workshop'} /></Field>
        {add.error && <p className="error" role="alert">{add.error.message}</p>}
        <button className="btn block" disabled={!city || !from || add.isPending} onClick={save}>Add trip</button>
      </div>
    </Sheet>
  );
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function RangePicker({ from, to, onChange }: { from: string | null; to: string | null; onChange: (from: string | null, to: string | null) => void }) {
  const [view, setView] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const first = (view.getDay() + 6) % 7; // Monday first
  const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => iso(new Date(view.getFullYear(), view.getMonth(), i + 1)))];
  const tap = (d: string) => (!from || to || d < from ? onChange(d, null) : onChange(from, d));
  const move = (n: number) => setView(new Date(view.getFullYear(), view.getMonth() + n, 1));
  return (
    <div className="glass card" style={{ padding: 12 }}>
      <div className="between">
        <button type="button" className="icon-btn" style={{ boxShadow: 'none', background: 'none' }} onClick={() => move(-1)} aria-label="Previous month"><Icon name="chevL" size={18} /></button>
        <b aria-live="polite">{view.toLocaleString('en', { month: 'long', year: 'numeric' })}</b>
        <button type="button" className="icon-btn" style={{ boxShadow: 'none', background: 'none' }} onClick={() => move(1)} aria-label="Next month"><Icon name="chevR" size={18} /></button>
      </div>
      <div role="grid" aria-label="Dates" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="footnote" style={{ padding: 4 }}>{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const end = to || from;
          const inRange = from && end && d >= from && d <= end;
          const edge = d === from || d === to;
          return (
            <button key={d} type="button" onClick={() => tap(d)} aria-pressed={!!inRange} aria-label={shortDate(d)}
              style={{ minHeight: 40, border: 0, borderRadius: edge ? 999 : 8, fontWeight: edge ? 700 : 500, background: edge ? 'var(--tint-fill)' : inRange ? 'var(--tint-soft)' : 'transparent', color: edge ? '#fff' : d === today() ? 'var(--tint)' : 'inherit' }}>
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
      <p className="caption" style={{ textAlign: 'center', marginTop: 6 }}>{from ? `${shortDate(from)}${to ? ' – ' + shortDate(to) : ' — now tap the last day'}` : 'Tap the first day'}</p>
    </div>
  );
}
