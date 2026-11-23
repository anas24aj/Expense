import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Claim, Trip, TripDetail, TripStatus } from '../api/types';
import { fmt, shortDate, today } from '../lib/format';
import { Chip, CategoryTile, EmptyState, ErrorCard, Field, Icon, List, ListRow, Money, Page, PageSkeleton, Section, Segmented, Sheet, Tile, useToast } from '../ui';
import { ImportClaimSheet } from './People';

const ST: Record<TripStatus, { label: string; color: string; badge: string }> = {
  claimed: { label: 'Claimed', color: 'var(--green-fill)', badge: 'green' },
  personal: { label: 'Personal', color: '#8e8e93', badge: '' },
  missed: { label: 'Missed', color: 'var(--red-fill)', badge: 'red' },
  unreviewed: { label: 'To sort', color: 'var(--orange-fill)', badge: 'orange' },
};
const ORDER: TripStatus[] = ['claimed', 'personal', 'missed', 'unreviewed'];
const range = (t: Trip) => `${shortDate(t.start_on).replace(/,? \d{4}$/, '')} – ${shortDate(t.end_on)}`;
const nights = (t: Trip) => Math.round((new Date(t.end_on).getTime() - new Date(t.start_on).getTime()) / 864e5);

/** Donut split by trip status. */
function StatusRing({ t, size = 120 }: { t: Trip; size?: number }) {
  const stroke = 12, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const total = Math.max(1, t.totals.total.minor);
  let off = 0;
  return (
    <span className="ring-wrap" style={{ width: size, height: size }} role="img" aria-label={ORDER.map(s => `${ST[s].label} ${fmt(t.totals[s])}`).join(', ')}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill)" strokeWidth={stroke} />
        {ORDER.map(s => {
          const len = (t.totals[s].minor / total) * c;
          const el = len > 0 && <circle key={s} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ST[s].color} strokeWidth={stroke} strokeDasharray={`${Math.max(0, len - 3)} ${c}`} strokeDashoffset={-off} strokeLinecap="butt" />;
          off += len;
          return el;
        })}
      </svg>
      <span className="ring-label" style={{ textAlign: 'center', lineHeight: 1.15 }}>
        <span style={{ fontSize: 18 }}>{Math.round((t.totals.claimed.minor / total) * 100)}%</span><br /><span className="footnote">claimed</span>
      </span>
    </span>
  );
}

export function TripsPage() {
  const q = useApi<{ items: Trip[] }>('/trips');
  const [adding, setAdding] = useState(false);
  return (
    <Page title="Trips" back="/more" subtitle="Everything you spend between the dates lands in the trip. Claim what’s work."
      trail={<button className="icon-btn" onClick={() => setAdding(true)} aria-label="New trip"><Icon name="plus" /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !q.data!.items.length
        ? <EmptyState icon="plane" title="No trips yet" text="Add one before you fly — expenses file themselves." action={<button className="btn small" onClick={() => setAdding(true)}>New trip</button>} />
        : (
          <List>{q.data!.items.map(t => {
            const now = t.start_on <= today() && today() <= t.end_on;
            return (
              <ListRow key={t.id} to={`/more/trips/${t.id}`} icon={<Tile icon="plane" color={t.kind === 'business' ? '#32ade6' : '#ff9f0a'} />}
                title={t.name} sub={`${t.city} · ${range(t)}`}
                end={<Money m={t.totals.total} />}
                endSub={now ? <span className="badge blue">Now</span> : t.totals.unreviewed.minor || t.totals.missed.minor ? <span className="badge orange">{fmt({ ...t.totals.missed, minor: t.totals.missed.minor + t.totals.unreviewed.minor })} open</span> : <span className="badge green">Done</span>} />
            );
          })}</List>
        )}
      <NewTripSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

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
  const setStatus = async (ids: string[], status: TripStatus) => {
    await tag.mutateAsync({ txn_ids: ids, status });
    toast(ids.length > 1 ? `${ids.length} marked ${ST[status].label.toLowerCase()}` : `Marked ${ST[status].label.toLowerCase()}`);
    setSel([]); setSelecting(false);
  };
  const open = t ? t.totals.missed.minor + t.totals.unreviewed.minor : 0;
  return (
    <Page title={t?.name || 'Trip'} back="/more/trips"
      trail={t && <button className="icon-btn" aria-label={selecting ? 'Done selecting' : 'Select expenses'} onClick={() => { setSelecting(!selecting); setSel([]); }}><Icon name={selecting ? 'close' : 'check'} /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : t && (
        <div className="grid-desktop stack">
          <section className="glass hero span-2">
            <div className="row-flex" style={{ gap: 18, alignItems: 'center' }}>
              <StatusRing t={t} />
              <div className="stack-sm" style={{ flex: 1, minWidth: 0 }}>
                <span className="caption"><Icon name="globe" size={13} /> {t.city} · {range(t)} · {nights(t)} nights</span>
                <span style={{ font: '700 30px var(--font-display)', letterSpacing: '-.03em' }} className="num">{fmt(t.totals.total)}</span>
                <span className="caption">{t.count} expenses{t.totals_base && t.currency !== t.totals_base.total.currency ? <> · ≈ <Money m={t.totals_base.total} /></> : null}</span>
              </div>
            </div>
            <div className="legend" style={{ marginTop: 16 }}>
              {ORDER.map(s => <div key={s} className="stat"><span className="k"><i className="dot" style={{ background: ST[s].color }} />{ST[s].label}</span><span className="v" style={{ fontSize: 17 }}><Money m={t.totals[s]} /></span></div>)}
            </div>
            {t.kind === 'business' && (
              <div className="grid-2" style={{ marginTop: 16 }}>
                <button className="btn" style={{ fontSize: 15, padding: '0 12px', whiteSpace: 'nowrap' }} disabled={!open} onClick={() => setClaiming(true)}><Icon name="briefcase" size={18} />Claim {open ? fmt({ ...t.totals.missed, minor: open }) : ''}</button>
                <button className="btn glassy" style={{ fontSize: 15, padding: '0 12px', whiteSpace: 'nowrap' }} onClick={() => setImporting(true)}><Icon name="upload" size={18} />Import Excel</button>
              </div>
            )}
          </section>

          <Section title="Expenses" action={<button onClick={() => { setSelecting(!selecting); setSel([]); }}>{selecting ? 'Cancel' : 'Select'}</button>}>
            <List>
              {t.expenses.map(x => {
                const on = sel.includes(x.id);
                return (
                  <div key={x.id} className="list-row" style={{ flexWrap: 'wrap', rowGap: 8 }}>
                    {selecting
                      ? <button type="button" className="icon-tile" aria-pressed={on} aria-label={`Select ${x.merchant}`} onClick={() => setSel(on ? sel.filter(i => i !== x.id) : [...sel, x.id])}
                          style={{ background: on ? 'var(--tint-fill)' : 'var(--fill)', border: 0, borderRadius: '50%', color: '#fff' }}>{on && <Icon name="check" />}</button>
                      : <CategoryTile category={x.category} />}
                    <div className="body"><div className="title">{x.merchant}</div><div className="sub">{shortDate(x.day)} · {x.account_name}</div></div>
                    <div className="end"><span className="amt"><Money m={x.amount} /></span><span className={`badge ${ST[x.trip_status].badge}`}>{ST[x.trip_status].label}</span></div>
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
              })}
            </List>
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
        <List>{items.map(x => <ListRow key={x.id} icon={<CategoryTile category={x.category} />} title={x.merchant} sub={shortDate(x.day)} end={<Money m={x.amount} />} />)}</List>
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
