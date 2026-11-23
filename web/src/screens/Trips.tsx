import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Claim, ClaimImport, Money as M, Trip, TripDetail, TripExpense, TripStatus } from '../api/types';
import { fmt, shortDate, today } from '../lib/format';
import { Chip, CategoryTile, EmptyState, ErrorCard, Field, Icon, List, ListRow, Money, Monies, Page, PageSkeleton, Section, Segmented, Sheet, Tile, useToast } from '../ui';
import { TxnRow, TxnSheet } from './Activity';
import { readFile } from './files';

const ST: Record<TripStatus, { label: string; badge: string }> = {
  claimed: { label: 'Claimed', badge: 'green' },
  personal: { label: 'Mine', badge: '' },
  missed: { label: 'To claim', badge: 'red' },
  unreviewed: { label: 'To review', badge: 'orange' },
  excluded: { label: 'Not this trip', badge: '' },
};
const range = (t: Trip) => `${shortDate(t.start_on).replace(/,? \d{4}$/, '')} – ${shortDate(t.end_on)}`;
const md = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
const shortRange = (t: Trip) => t.start_on.slice(0, 7) === t.end_on.slice(0, 7) ? `${md(t.start_on)} – ${Number(t.end_on.slice(8))}, ${t.start_on.slice(0, 4)}` : `${md(t.start_on)} – ${md(t.end_on)}, ${t.end_on.slice(0, 4)}`;
const nights = (t: Trip) => Math.round((new Date(t.end_on).getTime() - new Date(t.start_on).getTime()) / 864e5);
const zero = (t: Trip): M => ({ minor: 0, currency: t.totals.spent.currency });

/** The four numbers a trip is about, each named: spent, claimed, paid back, and what it cost you. */
function Figures({ t, big }: { t: Trip; big?: boolean }) {
  const work = t.kind === 'business';
  const rows: [string, M, string][] = work ? [
    ['Total spent', t.totals.spent, ''], ['Claimed', t.totals.claimed, 'pos'], ['Reimbursed', t.totals.reimbursed || zero(t), 'pos'], ['My own cost (unclaimed)', t.totals.burden, 'neg'],
  ] : [['Total spent', t.totals.spent, ''], ['My cost', t.totals.burden, 'neg']];
  return (
    <div className={big ? 'figures big' : 'figures'}>
      {rows.map(([k, v, tone]) => <div key={k} className="stat"><span className="k">{k}</span><span className={`v ${v.minor ? tone : ''}`}><Money m={v} /></span></div>)}
    </div>
  );
}

function TripRow({ t }: { t: Trip }) {
  const now = t.start_on <= today() && today() <= t.end_on;
  const { unreviewed, missed } = t.totals;
  return (
    <Link to={`/trips/${t.id}`} className="list-row" style={{ flexWrap: 'wrap', rowGap: 10 }}>
      <Tile icon="plane" color={t.kind === 'business' ? '#32ade6' : '#ff9f0a'} />
      <div className="body"><div className="title">{t.name}</div><div className="sub">{t.city} · {shortRange(t)}</div></div>
      <div className="end">
        {now ? <span className="badge blue">Now</span> : missed.minor ? <span className="badge red">To claim</span>
          : unreviewed.minor ? <span className="badge orange">To review</span> : t.count ? <span className="badge green">Done</span> : null}
      </div>
      {t.count > 0 && <div style={{ flexBasis: '100%', paddingLeft: 50 }}><Figures t={t} /></div>}
    </Link>
  );
}

/** Trips: work and personal, each with what it cost; the company's claims at the bottom. */
export function TripsPage() {
  const q = useApi<{ items: Trip[] }>('/trips');
  const [adding, setAdding] = useState(false);
  const all = [...(q.data?.items || [])].sort((a, b) => b.start_on.localeCompare(a.start_on));
  return (
    <Page title="Trips & claims" back="/more" subtitle="Spending between a trip’s dates lands in it. Rent and home bills paid meanwhile stay out."
      trail={<button className="icon-btn" onClick={() => setAdding(true)} aria-label="New trip"><Icon name="plus" /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !all.length
        ? <EmptyState icon="plane" title="No trips yet" text="Add one before you fly — expenses file themselves." action={<button className="btn small" onClick={() => setAdding(true)}>New trip</button>} />
        : (['business', 'personal'] as const).map(k => {
          const items = all.filter(t => t.kind === k);
          return items.length ? <Section key={k} title={k === 'business' ? 'Work trips' : 'Personal trips'}><List>{items.map(t => <TripRow key={t.id} t={t} />)}</List></Section> : null;
        })}
      <Claims />
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
  const setStatus = async (x: TripExpense, status: TripStatus) => {
    const was = x.trip_status;
    await tag.mutateAsync({ txn_ids: [x.id], status });
    toast(status === 'excluded' ? `${x.merchant} taken off the trip` : `Marked ${ST[status].label.toLowerCase()}`, () => tag.mutate({ txn_ids: [x.id], status: was }));
  };
  const open = t ? t.totals.missed.minor + t.totals.unreviewed.minor : 0;
  return (
    <Page title={t?.name || 'Trip'} back="/trips">
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : t && (
        <div className="grid-desktop stack">
          <section className="glass card span-2 stack-sm" aria-label="Trip totals">
            <span className="caption"><Icon name="globe" size={13} /> {t.kind === 'business' ? 'Work' : 'Personal'} · {t.city} · {range(t)} · {nights(t)} night{nights(t) === 1 ? '' : 's'} · {t.count} expense{t.count === 1 ? '' : 's'}</span>
            <Figures t={t} big />
            {t.totals.fees && t.totals.fees.minor > 0 && <div className="between fee-line"><span>Bank &amp; FX fees (incl. VAT on markup)</span><b className="neg num"><Money m={t.totals.fees} /></b></div>}
            {t.totals_base && t.currency !== t.totals_base.spent.currency && <p className="footnote">≈ <Money m={t.totals_base.spent} /> spent in total, at today’s rate.</p>}
            {t.totals.missed.minor > 0 && <p className="caption"><span className="neg">{fmt(t.totals.missed)} not claimed yet</span> — counted in your cost until you claim it.</p>}
            {t.kind === 'business' && (
              <div className="grid-2" style={{ marginTop: 8 }}>
                <button className="btn" style={{ fontSize: 15, padding: '0 12px', whiteSpace: 'nowrap' }} disabled={!open} onClick={() => setClaiming(true)}><Icon name="briefcase" size={18} />Claim {open ? fmt({ ...t.totals.missed, minor: open }) : ''}</button>
                <button className="btn secondary" style={{ fontSize: 15, padding: '0 12px', whiteSpace: 'nowrap' }} onClick={() => setImporting(true)}><Icon name="upload" size={18} />Import Excel</button>
              </div>
            )}
          </section>

          <Section title="Expenses">
            {!days.length && <EmptyState icon="receipt" title="Nothing spent yet" text="Card payments between the trip dates show up here." />}
            {days.map(([day, xs]) => {
              const d = t.by_day.find(b => b.day === day);
              return (
                <section key={day} aria-label={dayHead(t, day)}>
                  <h3 className="day-head sticky"><span>{dayHead(t, day)}</span>{d && <span className="num">{fmt(d.spent)}</span>}</h3>
                  <List>{xs.map(x => {
                    const partial = x.trip_status === 'claimed' && x.burden.minor > 0;
                    return (
                      <div key={x.id} className="list-row" style={{ flexWrap: 'wrap', rowGap: 8 }}>
                        <CategoryTile category={x.category} merchant={x.merchant} />
                        <div className="body"><div className="title">{x.merchant}</div><div className="sub">{[x.category, x.account_name].filter(Boolean).join(' · ')}</div></div>
                        <div className="end"><span className="amt"><Money m={x.amount} /></span><span className={`badge ${ST[x.trip_status].badge}`}>{ST[x.trip_status].label}</span></div>
                        {partial && <div className="caption" style={{ flexBasis: '100%', paddingLeft: 50 }}>Claimed <b className="pos"><Money m={x.claimed} /></b> · You pay <b><Money m={x.burden} /></b></div>}
                        <div className="chips" style={{ flexBasis: '100%', paddingLeft: 50, paddingBottom: 0 }} role="group" aria-label={`What ${x.merchant} was`}>
                          {(t.kind === 'business' && x.trip_status !== 'claimed' ? ['personal', 'missed'] as TripStatus[] : []).map(s => (
                            <button key={s} type="button" className="chip" aria-pressed={x.trip_status === s} onClick={() => setStatus(x, s)} style={{ minHeight: 32, fontSize: 13 }}>
                              {s === 'missed' ? 'Claim it' : 'Mine'}
                            </button>
                          ))}
                          {x.trip_status !== 'claimed' && <button type="button" className="chip" onClick={() => setStatus(x, 'excluded')} style={{ minHeight: 32, fontSize: 13 }}>Not trip spend</button>}
                        </div>
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
                <ListRow key={c.id} icon={<Tile icon="briefcase" color="#0a84ff" />} title={c.name} sub={`${c.items.length} item${c.items.length === 1 ? '' : 's'} · ${c.status}`} end={<Money m={c.expected} />}
                  endSub={c.received.minor ? <>paid back <Money m={c.received} /></> : undefined} onClick={() => nav(`/trips?claim=${c.id}`)} />
              ))}</List>
            </Section>
          )}
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
    toast('Trip added'); onClose(); nav(`/trips/${t.id}`);
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

/** Company claims: what's still owed, each claim's items and status, and importing the Excel you sent. */
function Claims() {
  const q = useApi<{ items: Claim[]; pending: M[] }>('/claims');
  const [open, setOpen] = useState<Claim | null>(null);
  const [importing, setImporting] = useState(false);
  const [txn, setTxn] = useState<Claim['items'][number] | null>(null);
  const [params] = useSearchParams();
  const deep = params.get('claim');
  useEffect(() => { if (deep && q.data) setOpen(q.data.items.find(c => c.id === deep) || null); }, [deep, q.data]);
  const paid = useWrite<{ id: string; txn_id?: string }>('POST', b => `/claims/${b.id}/paid`);
  const move = useWrite<{ id: string; status: string; submitted_on?: string }, Claim>('PATCH', b => `/claims/${b.id}`);
  const toast = useToast();
  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorCard error={q.error} retry={q.refetch} />;
  const items = q.data!.items;
  return (
    <>
      <div className="glass card between">
        <div className="stat"><span className="k">Waiting from the company</span><span className="v" style={{ fontSize: 26 }}><Monies items={q.data!.pending} empty="Nothing" /></span></div>
        <button className="btn small secondary" onClick={() => setImporting(true)}><Icon name="upload" size={16} />Import Excel</button>
      </div>
      <Section title="Claims">
        {items.length ? (
          <List>
            {items.map(c => (
              <ListRow key={c.id} icon={<span className="icon-tile" style={{ background: 'linear-gradient(160deg,#5ac8fa,#0a84ff)' }}><Icon name="briefcase" /></span>}
                title={c.name} sub={`${c.items.length} item${c.items.length === 1 ? "" : "s"} · ${c.status === 'paid' ? 'paid' : `${c.age_days} days`}`}
                end={<Money m={c.expected} />} endSub={<span className={`badge ${c.status === 'paid' ? 'green' : c.status === 'draft' ? '' : 'orange'}`}>{c.status}</span>} onClick={() => setOpen(c)} />
            ))}
          </List>
        ) : <EmptyState icon="briefcase" title="No claims" text="Tap Claim on any work expense in Activity." />}
      </Section>
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.name} detent="medium">
        {open && (
          <div className="stack">
            <dl className="kv glass card">
              <dt>Status</dt><dd>{open.status}</dd><dt>Expected</dt><dd><Money m={open.expected} /></dd><dt>Received</dt><dd><Money m={open.received} /></dd>
              {open.submitted_on && <><dt>Submitted</dt><dd>{shortDate(open.submitted_on)}</dd></>}
            </dl>
            {open.status !== 'paid' && (
              <Segmented label="Claim status" value={open.status === 'draft' ? 'draft' : 'submitted'} onChange={async v => {
                if (v === 'submitted' && open.status === 'draft') { setOpen(await move.mutateAsync({ id: open.id, status: 'submitted', submitted_on: today() })); toast('Marked submitted'); }
                if (v === 'draft' && open.status !== 'draft') { setOpen(await move.mutateAsync({ id: open.id, status: 'draft', submitted_on: '' })); toast('Back to draft'); }
              }} options={[{ value: 'draft', label: 'Draft' }, { value: 'submitted', label: 'Submitted' }]} />
            )}
            {move.error && <p className="error" role="alert">{move.error.message}</p>}
            {open.suggestion && open.status !== 'paid' && (
              <div className="glass card stack-sm" style={{ boxShadow: 'inset 0 0 0 1.5px var(--green-fill)' }}>
                <b><Icon name="sparkle" size={15} /> Looks like it was paid</b>
                <span className="caption"><Money m={open.suggestion.amount} /> arrived on {shortDate(open.suggestion.day)}.</span>
                <button className="btn small" onClick={async () => { await paid.mutateAsync({ id: open.id, txn_id: open.suggestion!.txn_id }); toast('Claim closed'); setOpen(null); }}>Yes, that’s it</button>
              </div>
            )}
            <List>{open.items.map(t => <TxnRow key={t.id} t={t} onOpen={setTxn} />)}</List>
            {open.status !== 'paid' && !open.suggestion && <button className="btn block secondary" onClick={async () => { await paid.mutateAsync({ id: open.id }); toast('Marked as received'); setOpen(null); }}><Icon name="check" size={16} />Money received</button>}
            <p className="footnote">When the reimbursement lands in your bank, we match it and close this claim.</p>
          </div>
        )}
      </Sheet>
      <TxnSheet txn={txn} onClose={() => setTxn(null)} />
      <ImportClaimSheet open={importing} onClose={() => setImporting(false)} />
    </>
  );
}

export function ImportClaimSheet({ open, onClose, tripId }: { open: boolean; onClose: () => void; tripId?: string }) {
  const trips = useApi<{ items: Trip[] }>('/trips');
  const [trip, setTrip] = useState(tripId || '');
  const [result, setResult] = useState<ClaimImport | null>(null);
  const up = useWrite<Record<string, unknown>, ClaimImport>('POST', '/claims/import');
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const data_base64 = await readFile(f);
    setResult(await up.mutateAsync({ file_name: f.name, data_base64, trip_id: trip || undefined }));
  };
  const close = () => { setResult(null); onClose(); };
  return (
    <Sheet open={open} onClose={close} title="Import claim Excel" detent={result ? 'large' : 'auto'}>
      {result ? (
        <div className="stack">
          <div className="grid-2">
            {result.claim && <p className="muted"><Icon name="check" size={14} className="pos" /> Claim “{result.claim.name}” created for <Money m={result.claim.expected} />.</p>}
          <div className="glass card stat"><span className="k">Matched</span><span className="v pos">{result.matched.length} rows</span></div>
            <div className="glass card stat"><span className="k">Not found</span><span className={`v ${result.unmatched.length ? 'warn' : ''}`}>{result.unmatched.length} rows</span></div>
          </div>
          <Section title="Matched to your transactions">
            {result.matched.length ? <List>{result.matched.map(r => <ListRow key={r.row} icon={<Icon name="check" size={22} className="pos" />} title={r.description} sub={`Row ${r.row} · ${shortDate(r.day)}`} end={<Money m={r.claimed || r.amount} />} />)}</List> : <p className="caption">None of the rows matched a transaction.</p>}
          </Section>
          {result.unmatched.length > 0 && (
            <Section title="No matching transaction">
              <List>{result.unmatched.map(r => <ListRow key={r.row} icon={<Icon name="warn" size={22} className="warn" />} title={r.description} sub={`${shortDate(r.day)} · cash, per diem or another card?`} end={<Money m={r.claimed || r.amount} />} />)}</List>
            </Section>
          )}
          <button className="btn block" onClick={close}>Done</button>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">Upload the Excel you submitted to the company. We match each row to a transaction and track the claim until it’s paid.</p>
          {!tripId && (
            <Field label="Trip (optional)">
              <select className="input" value={trip} onChange={e => setTrip(e.target.value)}>
                <option value="">No trip</option>
                {(trips.data?.items || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
          <label className="btn block" style={{ cursor: 'pointer' }}>
            <Icon name="upload" />{up.isPending ? 'Matching…' : 'Choose file'}
            <input type="file" accept=".xlsx,.xls,.csv" className="sr-only" onChange={e => pick(e.target.files?.[0])} />
          </label>
          {up.error && <p className="error" role="alert">{up.error.message}</p>}
        </div>
      )}
    </Sheet>
  );
}

