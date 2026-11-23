import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Claim, ClaimImport, Commitment, HouseholdFull, Me, Money as M, Person, Trip } from '../api/types';
import { dueLabel, fmt, shortDate } from '../lib/format';
import {
  Avatar, Chip, EmptyState, ErrorCard, Field, Icon, List, ListRow, Meter, Money, Monies, Page, PageSkeleton, Section, Segmented, Sheet, useToast,
} from '../ui';
import { TxnRow, TxnSheet } from './Activity';
import { readFile } from './files';

type Tab = 'family' | 'friends' | 'shared' | 'claims';
const RELATIONS = ['spouse', 'mother', 'father', 'child', 'sibling', 'other'];

export default function PeoplePage({ me }: { me: Me }) {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'family';
  const people = useApi<{ items: Person[] }>('/people');
  return (
    <Page title="People">
      <Segmented label="Section" value={tab} onChange={v => setParams({ tab: v }, { replace: true })}
        options={[{ value: 'family', label: 'Family' }, { value: 'friends', label: 'Friends' }, { value: 'shared', label: 'Shared' }, { value: 'claims', label: 'Claims' }]} />
      {people.isLoading ? <PageSkeleton /> : people.error ? <ErrorCard error={people.error} retry={people.refetch} />
        : tab === 'family' ? <Family people={people.data!.items} me={me} />
        : tab === 'friends' ? <Friends people={people.data!.items} />
        : tab === 'shared' ? <Shared /> : <Claims />}
    </Page>
  );
}

function Family({ people, me }: { people: Person[]; me: Me }) {
  const hh = useApi<HouseholdFull>('/households/current');
  const [inviting, setInviting] = useState(false);
  const support = people.filter(p => p.kind === 'member' && (p.support_plan || p.support_month));
  const admin = me.member.role === 'owner' || me.member.role === 'admin';
  return (
    <>
      {support.length > 0 && (
        <Section title="Family support">
          <div className="glass card stack">
            {support.map(p => {
              const plan = p.support_plan?.minor || 0, got = p.support_month?.minor || 0;
              const over = plan && got > plan;
              return (
                <div key={p.id} className="stack-sm">
                  <div className="between">
                    <span className="row-flex"><Avatar name={p.name} size={32} /><b>{p.name}</b></span>
                    <span className="num"><Money m={p.support_month} /> <span className="caption">of <Money m={p.support_plan} /></span></span>
                  </div>
                  <Meter pct={plan ? (got / plan) * 100 : 100} color={over ? 'var(--orange-fill)' : 'var(--green-fill)'} />
                  {over ? <span className="caption warn">{fmt({ minor: got - plan, currency: p.support_month!.currency })} extra this month</span>
                    : got >= plan ? <span className="caption pos">Sent for this month</span> : <span className="caption">{fmt({ minor: plan - got, currency: p.support_plan!.currency })} still to send</span>}
                </div>
              );
            })}
          </div>
        </Section>
      )}
      <Section title="Household" action={admin && <button onClick={() => setInviting(true)}>Add</button>}>
        <List>
          <ListRow icon={<Avatar name={me.user.name} />} title={<>{me.user.name} <span className="caption">(you)</span></>} sub={me.member.role} chevron={false} />
          {(hh.data?.members || []).filter(m => m.id !== me.member.id).map(m => (
            <ListRow key={m.id} icon={<Avatar name={m.display_name} />} title={m.display_name} sub={`${m.relation} · ${m.user_id ? 'on the app' : 'no login'}`}
              end={<span className={`badge ${m.role === 'admin' || m.role === 'owner' ? 'blue' : ''}`}>{m.role}</span>} chevron={false} />
          ))}
        </List>
        {(hh.data?.invites || []).map(i => <p key={i.id} className="caption" style={{ marginLeft: 4 }}><Icon name="mail" size={13} /> Invite sent to {i.email}</p>)}
      </Section>
      <InviteSheet open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}

export function InviteSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('spouse');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState('');
  const toast = useToast();
  const add = useWrite<Record<string, unknown>, { invite?: { link: string } }>('POST', '/members');
  const save = async () => {
    const r = await add.mutateAsync({ display_name: name, relation, email: email || undefined, role: relation === 'spouse' ? 'admin' : 'member' });
    if (r.invite?.link) setLink(r.invite.link); else { toast(`${name} added`); close(); }
  };
  const close = () => { setName(''); setEmail(''); setLink(''); onClose(); };
  return (
    <Sheet open={open} onClose={close} title={link ? 'Invite ready' : 'Add family'}>
      {link ? (
        <div className="stack">
          <p className="muted">We emailed {email}. You can also send this link on WhatsApp:</p>
          <p className="code">{link}</p>
          <button className="btn block" onClick={() => copy(link, toast)}><Icon name="copy" />Copy link</button>
        </div>
      ) : (
        <div className="stack">
          <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="Priya" /></Field>
          <div className="chips" style={{ flexWrap: 'wrap' }}>{RELATIONS.map(r => <Chip key={r} on={relation === r} onClick={() => setRelation(r)}>{r}</Chip>)}</div>
          <Field label="Email (optional — only if they’ll use the app)"><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
          <button className="btn block" disabled={!name || add.isPending} onClick={save}>{email ? 'Add and invite' : 'Add'}</button>
          {add.error && <p className="error">{add.error.message}</p>}
        </div>
      )}
    </Sheet>
  );
}

export async function copy(text: string, toast: (s: string) => void, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Select and copy the text above'); }
}

function sumBy(list: M[][]) {
  const by: Record<string, number> = {};
  for (const m of list.flat()) by[m.currency] = (by[m.currency] || 0) + m.minor;
  return Object.entries(by).map(([currency, minor]) => ({ currency, minor }));
}

function Friends({ people }: { people: Person[] }) {
  const friends = people.filter(p => p.kind === 'contact');
  const [open, setOpen] = useState<Person | null>(null);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <div className="grid-2">
        <div className="glass card"><div className="card-title">Owed to you</div><div className="stat"><span className="v pos"><Monies items={sumBy(friends.map(f => f.owes_you))} empty="Nothing" /></span></div></div>
        <div className="glass card"><div className="card-title">You owe</div><div className="stat"><span className="v"><Monies items={sumBy(friends.map(f => f.you_owe))} empty="Nothing" /></span></div></div>
      </div>
      <Section title="Friends" action={<button onClick={() => setAdding(true)}>Add</button>}>
        {friends.length ? (
          <List>
            {friends.map(p => (
              <ListRow key={p.id} icon={<Avatar name={p.name} />} title={p.name} sub={p.on_app ? 'On the app — splits sync' : p.relation || 'friend'}
                end={p.owes_you.length ? <span className="pos"><Monies items={p.owes_you} /></span> : p.you_owe.length ? <span className="neg"><Monies items={p.you_owe} /></span> : <span className="caption">Settled</span>}
                endSub={p.owes_you.length ? 'owes you' : p.you_owe.length ? 'you owe' : undefined} onClick={() => setOpen(p)} />
            ))}
          </List>
        ) : <EmptyState icon="people" title="No friends yet" text="Split a bill from Activity and they’ll show up here." />}
      </Section>
      <SettleSheet person={open} onClose={() => setOpen(null)} />
      <AddContactSheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function SettleSheet({ person, onClose }: { person: Person | null; onClose: () => void }) {
  const settle = useWrite('POST', '/settle');
  const toast = useToast();
  if (!person) return null;
  const rows = [...person.owes_you.map(m => ({ m, dir: 'owes you' })), ...person.you_owe.map(m => ({ m, dir: 'you owe' }))];
  return (
    <Sheet open onClose={onClose} title={person.name}>
      <div className="stack" style={{ textAlign: 'center' }}>
        <div style={{ display: 'grid', placeItems: 'center' }}><Avatar name={person.name} size={64} /></div>
        {rows.length ? rows.map(({ m, dir }) => (
          <div key={m.currency + dir} className="glass card stack-sm">
            <span className="caption">{dir === 'owes you' ? `${person.name.split(' ')[0]} owes you` : `You owe ${person.name.split(' ')[0]}`}</span>
            <span style={{ font: '700 32px var(--font-display)' }} className={dir === 'owes you' ? 'pos num' : 'num'}>{fmt(m)}</span>
            <button className="btn block" disabled={settle.isPending} onClick={async () => {
              await settle.mutateAsync({ person: { kind: person.kind, id: person.id }, currency: m.currency });
              toast(`Settled with ${person.name.split(' ')[0]}`); onClose();
            }}><Icon name="check" />Mark settled</button>
          </div>
        )) : <p className="muted">All square.</p>}
        <p className="footnote">Settling marks it paid without a matching bank SMS — use it for cash.</p>
      </div>
    </Sheet>
  );
}

function AddContactSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [reach, setReach] = useState('');
  const add = useWrite('POST', '/contacts');
  const toast = useToast();
  const save = async () => {
    await add.mutateAsync(reach.includes('@') ? { name, email: reach } : { name, phone: reach || undefined });
    toast(`${name} added`); setName(''); setReach(''); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add friend">
      <div className="stack">
        <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
        <Field label="Email or phone (optional)"><input className="input" value={reach} onChange={e => setReach(e.target.value)} placeholder="So splits show on their side too" /></Field>
        <button className="btn block" disabled={!name || add.isPending} onClick={save}>Add</button>
      </div>
    </Sheet>
  );
}

function Shared() {
  const q = useApi<{ items: Commitment[] }>('/commitments');
  const paid = useWrite<{ id: string; payer: { kind: string; id: string } }>('POST', b => `/commitments/${b.id}/paid`);
  const toast = useToast();
  if (!q.data) return <PageSkeleton />;
  const subs = q.data.items.filter(c => c.shares.length);
  if (!subs.length) return <EmptyState icon="tv" title="Nothing shared yet" text="Open a subscription in Plan and add who shares it." />;
  return (
    <Section title="Shared bills & subscriptions">
      {subs.map(c => (
        <div key={c.id} className="glass card stack-sm">
          <div className="between"><b>{c.name}</b><Money m={c.amount} /></div>
          <span className="caption">Next {dueLabel(c.next_due)} · tap someone when they pay</span>
          <div className="chips" style={{ flexWrap: 'wrap' }}>
            {c.shares.map(s => (
              <button key={s.name} type="button" className="chip" aria-pressed={s.paid_this_cycle} disabled={s.paid_this_cycle}
                onClick={async () => { await paid.mutateAsync({ id: c.id, payer: { kind: s.member_id ? 'member' : 'contact', id: (s.member_id || s.contact_id)! } }); toast(`${s.name} paid`); }}>
                {s.paid_this_cycle ? <Icon name="check" /> : <Icon name="person" />}{s.name} · {fmt(s.share)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}

export function Claims() {
  const q = useApi<{ items: Claim[]; pending: M[] }>('/claims');
  const [open, setOpen] = useState<Claim | null>(null);
  const [importing, setImporting] = useState(false);
  const [txn, setTxn] = useState<Claim['items'][number] | null>(null);
  const [params] = useSearchParams();
  const deep = params.get('claim');
  useEffect(() => { if (deep && q.data) setOpen(q.data.items.find(c => c.id === deep) || null); }, [deep, q.data]);
  const paid = useWrite<{ id: string; txn_id?: string }>('POST', b => `/claims/${b.id}/paid`);
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
            {open.suggestion && open.status !== 'paid' && (
              <div className="glass card stack-sm" style={{ boxShadow: 'inset 0 0 0 1.5px var(--green-fill)' }}>
                <b><Icon name="sparkle" size={15} /> Looks like it was paid</b>
                <span className="caption"><Money m={open.suggestion.amount} /> arrived on {shortDate(open.suggestion.day)}.</span>
                <button className="btn small" onClick={async () => { await paid.mutateAsync({ id: open.id, txn_id: open.suggestion!.txn_id }); toast('Claim closed'); setOpen(null); }}>Yes, that’s it</button>
              </div>
            )}
            <List>{open.items.map(t => <TxnRow key={t.id} t={t} onOpen={setTxn} />)}</List>
            {open.status !== 'paid' && !open.suggestion && <button className="btn block secondary" onClick={async () => { await paid.mutateAsync({ id: open.id }); toast('Marked as paid'); setOpen(null); }}>Mark as paid</button>}
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
