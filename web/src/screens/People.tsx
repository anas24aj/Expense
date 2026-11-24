import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Contact, HouseholdFull, Member, Money as M, Person, PersonLedger, SharedSpend, Txn } from '../api/types';
import { fmt, shortDate, sumByCurrency } from '../lib/format';
import {
  Avatar, Chip, EmptyState, ErrorCard, Field, Icon, List, ListRow, Meter, Money, Monies, Page, PageSkeleton, Section, Segmented, Sheet, Toggle, useToast,
} from '../ui';
import { TxnRow, TxnSheet } from './Activity';
import { photoDataUrl } from './files';

const RELATIONS = ['spouse', 'parent', 'child', 'sibling', 'other'];  // the API's set (api/households.py)
const ROLES: { value: 'admin' | 'member' | 'viewer'; label: string }[] = [{ value: 'admin', label: 'Admin' }, { value: 'member', label: 'Member' }, { value: 'viewer', label: 'Viewer' }];
const first = (name: string) => name.split(' ')[0];

/** Anyone's avatar by id, with their photo from /people (one cached request): every place that shows a person uses it. */
export function PersonAvatar({ id, name, size }: { id?: string | null; name: string; size?: number }) {
  const people = useApi<{ items: Person[] }>('/people').data?.items;
  return <Avatar name={name} size={size} photo={people?.find(p => p.id === id)?.photo} />;
}

const balance = (p: Person) => p.owes_you.length ? <span className="pos"><Monies items={p.owes_you} /></span>
  : p.you_owe.length ? <span className="neg"><Monies items={p.you_owe} /></span> : <span className="caption">Settled</span>;

/** People: family and friends with who owes whom; tap anyone for everything between you. */
export default function PeoplePage() {
  const q = useApi<{ items: Person[] }>('/people');
  const [adding, setAdding] = useState(false);
  const people = (q.data?.items || []).filter(p => p.relation !== 'self');
  const fam = people.filter(p => p.kind === 'member'), friends = people.filter(p => p.kind === 'contact');
  const row = (p: Person) => (
    <ListRow key={p.kind + p.id} to={`/people/${p.kind}/${p.id}`} icon={<Avatar name={p.name} photo={p.photo} />} title={p.name}
      sub={p.support_plan ? <>Support <Money m={p.support_month} /> of <Money m={p.support_plan} /> this month</> : p.rent_due ? <span className="warn">Rent due {fmt(p.rent_due)}</span> : p.kind === 'member' ? p.relation : 'friend'}
      end={balance(p)} endSub={p.owes_you.length ? 'owes you' : p.you_owe.length ? 'you owe' : undefined} />
  );
  return (
    <Page title="People" trail={<button className="icon-btn" onClick={() => setAdding(true)} aria-label="Add friend"><Icon name="plus" /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : (
        <>
          <div className="grid-2">
            <div className="glass card stat"><span className="k">Owed to you</span><span className="v pos"><Monies items={sumByCurrency(people.flatMap(p => p.owes_you))} empty="Nothing" /></span></div>
            <div className="glass card stat"><span className="k">You owe</span><span className="v neg"><Monies items={sumByCurrency(people.flatMap(p => p.you_owe))} empty="Nothing" /></span></div>
          </div>
          {fam.length > 0 && <Section title="Family" action={<Link to="/more/household">Manage</Link>}><List>{fam.map(row)}</List></Section>}
          <Section title="Friends & roommates">
            {friends.length ? <List>{friends.map(row)}</List> : <EmptyState icon="people" title="No friends yet" text="Split a bill from Activity and they show up here." />}
          </Section>
          <SharedWithMe />
        </>
      )}
      <AddContactSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

/** One person: shared spends (with "not split" / "fully theirs"), money each way, shared costs, and the balance to settle. */
export function PersonPage() {
  const { kind = '', id = '' } = useParams();
  const q = useApi<PersonLedger>(`/people/${kind}/${id}`);
  const hh = useApi<HouseholdFull>('/households/current');
  const [tab, setTab] = useState<'shared' | 'money'>('shared');
  const [open, setOpen] = useState<Txn | null>(null);
  const [editing, setEditing] = useState(false);
  const split = useWrite<{ id: string; shares: Record<string, unknown>[] }>('POST', b => `/transactions/${b.id}/split`);
  const settle = useWrite('POST', '/settle');
  const dues = useWrite<{ count_in_dues: boolean }>('PUT', `/people/${kind}/${id}/dues`);
  const toast = useToast();
  const d = q.data, p = d?.person;
  const col = kind === 'member' ? 'member_id' : 'contact_id';
  const others = (x: SharedSpend) => x.splits.filter(s => s[col] !== id).map(s => ({ [s.member_id ? 'member_id' : 'contact_id']: s.member_id || s.contact_id, share_minor: s.share_minor }));
  const act = async (x: SharedSpend, how: 'none' | 'all') => {
    await split.mutateAsync({ id: x.txn.id, shares: how === 'none' ? others(x) : [{ [col]: id, share_minor: x.txn.amount.minor }] });
    toast(how === 'none' ? `${x.txn.merchant}: not split with ${first(p!.name)}` : `${x.txn.merchant}: all ${first(p!.name)}’s`);
  };
  const member = hh.data?.members.find(m => m.id === id), contact = hh.data?.contacts.find(c => c.id === id);
  return (
    <Page title={p?.name || 'Person'} back="/people" trail={p && (member || contact) && <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : d && p && (
        <div className="grid-desktop stack">
          <section className="glass card span-2 stack" style={{ alignItems: 'center', textAlign: 'center' }} aria-label="Balance">
            <Avatar name={p.name} photo={p.photo} size={84} />
            <span className="caption">{p.kind === 'member' ? p.relation : 'Friend'}{p.on_app ? ' · on the app' : ''}</span>
            {!p.owes_you.length && !p.you_owe.length && <b style={{ fontSize: 20 }}>All square</b>}
            {[...p.owes_you.map(m => ({ m, theirs: true })), ...p.you_owe.map(m => ({ m, theirs: false }))].map(({ m, theirs }) => (
              <div key={m.currency + theirs} className="stack-sm" style={{ width: '100%', maxWidth: 360 }}>
                <span className="caption">{theirs ? `${first(p.name)} owes you` : `You owe ${first(p.name)}`}</span>
                <span className={`num ${theirs ? 'pos' : 'neg'}`} style={{ font: '700 34px var(--font-display)' }}>{fmt(m)}</span>
                <button className="btn block secondary" disabled={settle.isPending} onClick={async () => {
                  if (!confirm(`Mark everything in ${m.currency} with ${first(p.name)} as settled?`)) return;
                  await settle.mutateAsync({ person: { kind: p.kind, id: p.id }, currency: m.currency }); toast(`Settled with ${first(p.name)}`);
                }}><Icon name="check" size={18} />Settle up</button>
              </div>
            ))}
            {p.you_owe.length > 0 && <div style={{ width: '100%', maxWidth: 360, textAlign: 'left' }}>
              <List><Toggle label="Pay back this month" checked={!!p.count_in_dues} onChange={async v => { await dues.mutateAsync({ count_in_dues: v }); toast(v ? `Counted in this month’s dues` : 'No rush: left out of this month’s dues'); }}
                sub={p.count_in_dues ? 'Counted in this month’s plan' : 'No due date, so no rush: left out of this month’s plan'} /></List>
            </div>}
            {p.support_plan && <div style={{ width: '100%' }} className="stack-sm">
              <div className="between"><span className="caption">Support this month</span><span className="num"><Money m={p.support_month} /> of <Money m={p.support_plan} /></span></div>
              <Meter pct={((p.support_month?.minor || 0) / Math.max(1, p.support_plan.minor)) * 100} color="var(--green-fill)" />
            </div>}
          </section>

          <div className="span-2"><Segmented label="Show" value={tab} onChange={setTab} options={[
            { value: 'shared', label: `Shared spends ${d.shared.length}` }, { value: 'money', label: `Money sent ${d.sent.length + d.received.length}` }]} /></div>

          {tab === 'shared' ? <>
            <Section title="Shared spends" action={d.totals.their_part.length > 0 ? <span className="caption">their part <Monies items={d.totals.their_part} /></span> : undefined}>
              {!d.shared.length ? <div className="glass card caption">Nothing split with {first(p.name)} yet. Open a payment in Activity and tap Split.</div> : (
                <List>{d.shared.map(x => (
                  <div key={x.txn.id} className="list-row" style={{ flexWrap: 'wrap', rowGap: 8, opacity: x.settled ? .55 : 1 }}>
                    <button type="button" className="row-flex" style={{ flex: 1, minWidth: 0, background: 'none', border: 0, padding: 0, color: 'inherit', textAlign: 'left' }} onClick={() => setOpen(x.txn)}>
                      <span className="body" style={{ minWidth: 0 }}><span className="title" style={{ display: 'block' }}>{x.txn.merchant}</span>
                        <span className="sub" style={{ display: 'block' }}>{shortDate(x.txn.day)} · bill <Money m={x.txn.amount} /></span></span>
                    </button>
                    <div className="end"><span className="amt"><Money m={x.share} /></span><span className="caption">{x.settled ? 'settled' : `${first(p.name)}’s part`}</span></div>
                    {!x.settled && <div className="chips" style={{ flexBasis: '100%', paddingBottom: 0 }} role="group" aria-label={`Split of ${x.txn.merchant}`}>
                      <button type="button" className="chip" disabled={split.isPending} onClick={() => act(x, 'none')}>Not split</button>
                      <button type="button" className="chip" disabled={split.isPending || x.share.minor === x.txn.amount.minor} aria-pressed={x.share.minor === x.txn.amount.minor} onClick={() => act(x, 'all')}>Fully theirs</button>
                    </div>}
                  </div>
                ))}</List>
              )}
            </Section>
            {d.shared_costs.length > 0 && (
              <Section title="Shared costs (car, home, bills)">
                <List>{d.shared_costs.slice(0, 30).map((c, i) => <ListRow key={i} title={c.what} sub={shortDate(c.day)}
                  end={<span className={c.amount.minor < 0 ? 'neg' : ''}><Money m={c.amount} /></span>} endSub={c.amount.minor < 0 ? 'you owe' : 'their part'} chevron={false} />)}</List>
              </Section>
            )}
          </> : <>
            <Section title={`You sent ${first(p.name)}`} action={<span className="caption"><Monies items={d.totals.sent} empty="Nothing" /></span>}>
              {d.sent.length ? <List>{d.sent.map(t => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</List> : <p className="caption" style={{ marginLeft: 4 }}>Nothing yet.</p>}
            </Section>
            <Section title={`${first(p.name)} sent you`} action={<span className="caption"><Monies items={d.totals.received} empty="Nothing" /></span>}>
              {d.received.length ? <List>{d.received.map(t => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</List> : <p className="caption" style={{ marginLeft: 4 }}>Nothing yet.</p>}
            </Section>
          </>}
          <p className="footnote span-2" style={{ margin: '0 4px' }}>The balance counts unsettled splits, money lent and paid back, and shared costs since you last settled. Settle up when it’s paid in cash or outside the app.</p>
        </div>
      )}
      <TxnSheet txn={open} onClose={() => setOpen(null)} />
      {editing && member && <EditMemberSheet member={member} onClose={() => setEditing(false)} />}
      {editing && contact && <EditContactSheet contact={contact} onClose={() => setEditing(false)} />}
    </Page>
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

/** Profile photo: pick one (resized on the phone to a small JPEG), or remove it. Saves straight away. */
export function PhotoField({ name, photo, path, size = 128, maxChars = 60_000, field = 'photo' }: { name: string; photo?: string | null; path: string; size?: number; maxChars?: number; field?: 'photo' | 'details' }) {
  const save = useWrite<Record<string, unknown>>('PATCH', path);
  const toast = useToast();
  const [err, setErr] = useState('');
  const put = async (v: string | null) => {
    setErr('');
    try { await save.mutateAsync(field === 'details' ? { details: { photo: v } } : { photo: v }); toast(v ? 'Photo saved' : 'Photo removed'); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="row-flex" style={{ gap: 12 }}>
      {field === 'photo' ? <Avatar name={name} photo={photo} size={56} /> : photo ? <img src={photo} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 12 }} /> : null}
      <label className="btn small secondary" style={{ cursor: 'pointer' }}>
        <Icon name="upload" size={16} />{photo ? 'Change photo' : 'Add photo'}
        <input type="file" accept="image/*" hidden disabled={save.isPending} onChange={async e => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          try { await put(await photoDataUrl(f, size, maxChars)); } catch (x) { setErr((x as Error).message); }
        }} />
      </label>
      {photo && <button className="link-btn" style={{ color: 'var(--red)' }} disabled={save.isPending} onClick={() => put(null)}>Remove</button>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

function EditMemberSheet({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [relation, setRelation] = useState('other');
  const [role, setRole] = useState<Member['role']>('member');
  const [email, setEmail] = useState('');
  useEffect(() => { if (member) { setName(member.display_name); setRelation(member.relation); setRole(member.role); setEmail(member.email || ''); } }, [member]);
  const toast = useToast();
  const save = useWrite<Record<string, unknown>, { invite?: { link: string } }>('PATCH', () => `/members/${member!.id}`);
  const del = useWrite('DELETE', () => `/members/${member!.id}`);
  if (!member) return null;
  const owner = member.role === 'owner';
  const invite = !member.user_id && !!email.trim() && email.trim() !== (member.email || '');
  const submit = async () => {
    const r = await save.mutateAsync({ display_name: name.trim(), relation, ...(owner ? {} : { role }), ...(invite ? { email: email.trim() } : {}) });
    toast(r.invite ? `Saved — invite sent to ${email.trim()}` : `${name.trim()} saved`); onClose();
  };
  return (
    <Sheet open onClose={onClose} title={member.display_name}>
      <div className="stack">
        <PhotoField name={member.display_name} photo={member.photo} path={`/members/${member.id}`} />
        <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
        <div className="chips" style={{ flexWrap: 'wrap' }} role="group" aria-label="Relation">
          {[...new Set([...RELATIONS, member.relation])].filter(r => r !== 'self').map(r => <Chip key={r} on={relation === r} onClick={() => setRelation(r)}>{r}</Chip>)}
        </div>
        {!owner && <Segmented label="Role" value={role as 'admin' | 'member' | 'viewer'} onChange={setRole} options={ROLES} />}
        {member.user_id ? <p className="caption" style={{ marginLeft: 4 }}><Icon name="check" size={13} className="pos" /> On the app{member.email ? ` as ${member.email}` : ''}</p>
          : <Field label="Email (sends an invite to use the app)"><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" /></Field>}
        <button className="btn block" disabled={!name.trim() || save.isPending} onClick={submit}>{invite ? 'Save and invite' : 'Save'}</button>
        {(save.error || del.error) && <p className="error" role="alert">{(save.error || del.error)!.message}</p>}
        {!owner && <button className="btn block danger" disabled={del.isPending} onClick={async () => {
          if (!confirm(`Remove ${member.display_name} from the household? Their past transactions stay.`)) return;
          await del.mutateAsync(undefined); toast(`${member.display_name} removed`); onClose();
        }}><Icon name="trash" size={16} />Remove from household</button>}
      </div>
    </Sheet>
  );
}

function EditContactSheet({ contact, onClose }: { contact: Contact | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  useEffect(() => { if (contact) { setName(contact.name); setEmail(contact.email || ''); setPhone(contact.phone || ''); } }, [contact]);
  const toast = useToast();
  const save = useWrite<Record<string, unknown>>('PATCH', () => `/contacts/${contact!.id}`);
  const del = useWrite('DELETE', () => `/contacts/${contact!.id}`);
  const invite = useWrite<undefined, { email: string; link: string; sent: boolean }>('POST', () => `/contacts/${contact!.id}/invite`);
  if (!contact) return null;
  return (
    <Sheet open onClose={onClose} title={`Edit ${contact.name}`}>
      <div className="stack">
        <PhotoField name={contact.name} photo={contact.photo} path={`/contacts/${contact.id}`} />
        <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Email (matches them when they join the app)"><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
        <Field label="Phone"><input className="input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} /></Field>
        <button className="btn block" disabled={!name.trim() || save.isPending} onClick={async () => {
          await save.mutateAsync({ name: name.trim(), email: email.trim(), phone: phone.trim() }); toast(`${name.trim()} saved`); onClose();
        }}>Save</button>
        {contact.email && !contact.on_app && <button className="btn block secondary" disabled={invite.isPending} onClick={async () => {
          const r = await invite.mutateAsync(undefined);
          if (r.sent) toast(`Invite sent to ${r.email}`); else await copy(r.link, toast, 'Mail is off — sign-up link copied');
        }}><Icon name="mail" size={16} />Invite to the app</button>}
        {(save.error || del.error) && <p className="error" role="alert">{(save.error || del.error)!.message}</p>}
        <button className="btn block danger" disabled={del.isPending} onClick={async () => {
          if (!confirm(`Remove ${contact.name}? Past splits with them stay.`)) return;
          await del.mutateAsync(undefined); toast(`${contact.name} removed`); onClose();
        }}><Icon name="trash" size={16} />Remove friend</button>
      </div>
    </Sheet>
  );
}

export async function copy(text: string, toast: (s: string) => void, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Select and copy the text above'); }
}

type SharedItem = { household: string; you_owe: M[]; owed_to_you: M[]; lines: { day: string; what: string; your_share: M }[] };

// Splits other households recorded with you (as their contact with your email): appears once you join the app.
function SharedWithMe() {
  const q = useApi<{ items: SharedItem[] }>('/shared');
  const items = q.data?.items.filter(i => i.lines.length || i.you_owe.length || i.owed_to_you.length) ?? [];
  if (!items.length) return null;
  return (
    <>{items.map(i => (
      <Section key={i.household} title={`Shared with you by ${i.household}`}>
        <List>
          {i.lines.slice(0, 20).map((l, n) => <ListRow key={n} icon={<Icon name="people" size={22} />} title={l.what || 'Shared expense'} sub={shortDate(l.day)} end={<Money m={l.your_share} />} chevron={false} />)}
        </List>
        <p className="caption">{i.you_owe.length ? <>You owe <Monies items={i.you_owe} /></> : i.owed_to_you.length ? <>They owe you <Monies items={i.owed_to_you} /></> : 'Settled'}</p>
      </Section>
    ))}</>
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

