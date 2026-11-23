import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Account, Commitment, DetectedCommitment, HouseholdFull, Money as M, MonthPlan, Person } from '../api/types';
import { dueLabel, fmt, monthLabel, shortDate, sumByCurrency, today, toMinor } from '../lib/format';
import { AmountInput, Avatar, Chip, ErrorCard, Field, Icon, List, ListRow, Money, Page, PageSkeleton, Section, Segmented, Sheet, StatusBadge, Tile, useToast } from '../ui';
import { KIND_ICON } from './Home';
import { PersonAvatar } from './People';

const KINDS: [string, string][] = [['rent', 'Rent'], ['bill', 'Bills'], ['subscription', 'Subscriptions'], ['emi', 'EMIs'], ['support', 'Family support'],
  ['insurance', 'Insurance'], ['school', 'School'], ['milestone', 'Property milestones'], ['other', 'Other']];
const CYCLES = [{ v: 1, l: 'Monthly' }, { v: 3, l: 'Every 3 months' }, { v: 6, l: 'Every 6 months' }, { v: 12, l: 'Yearly' }, { v: 0, l: 'Once' }];
const cycleLabel = (n: number) => CYCLES.find(c => c.v === n)?.l || `Every ${n} months`;
// grouped by who it is for: family first, then what you share with a roommate or friend, then by kind
const GROUPS: [string, string][] = [['family', 'Family'], ['shared', 'Shared with others'], ['subscription', 'Subscriptions'], ['emi', 'EMIs'],
  ['rent', 'Rent'], ['bill', 'Bills'], ['other', 'Others']];
const groupOf = (c: Commitment) => (c.kind === 'support' || c.for_member_id ? 'family' : c.shares.length ? 'shared'
  : ['subscription', 'emi', 'rent', 'bill'].includes(c.kind) ? c.kind : 'other');
const perMonth = (c: Commitment, m: M = c.amount): M => ({ ...m, minor: Math.round(m.minor / Math.max(1, c.cycle_months)) });
const mine = (c: Commitment): M => ({ ...c.amount, minor: c.amount.minor - c.shares.reduce((a, s) => a + s.share.minor, 0) });
const country = (c: Commitment) => c.country || (c.amount.currency === 'INR' ? 'IN' : 'SA');

/** Every recurring payment, by who it is for, with its share and whether the others paid; the monthly total feeds Plan. */
export default function RecurringPage() {
  const q = useApi<{ items: Commitment[] }>('/commitments');
  const detect = useApi<{ items: DetectedCommitment[] }>('/commitments/detect');
  const plan = useApi<MonthPlan>('/insights/plan');
  const accounts = useApi<{ items: Account[] }>('/accounts').data?.items || [];
  const hh = useApi<HouseholdFull>('/households/current').data;
  const add = useWrite('POST', '/commitments');
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Commitment | null>(null);
  const [editing, setEditing] = useState<Commitment | null>(null);
  const deep = new URLSearchParams(useLocation().search).get('commitment');
  useEffect(() => { if (deep && q.data) setOpen(q.data.items.find(c => c.id === deep) || null); }, [deep, q.data]);
  const memberName = (id: string | null) => hh?.members.find(m => m.id === id)?.display_name;
  const acctName = (id: string | null) => { const a = accounts.find(x => x.id === id); return a ? `${a.institution}${a.last4 ? ' ··' + a.last4 : ''}` : null; };
  const all = q.data?.items || [];
  const sugg = detect.data?.items || [];
  const byCountry = (code: string) => sumByCurrency(all.filter(c => country(c) === code).map(c => perMonth(c, mine(c))));
  const months = plan.data?.months.map(m => monthLabel(m.month)).join('/') || 'this and next month’s';
  return (
    <Page title="Recurring" trail={<button className="icon-btn" onClick={() => setCreating(true)} aria-label="Add a recurring payment"><Icon name="plus" /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : (
        <div className="grid-desktop stack">
          {sugg.length > 0 && (
            <section className="stack-sm span-2" aria-label="Found in your spending">
              <span className="caption" style={{ marginLeft: 4 }}><Icon name="sparkle" size={13} /> Found in your spending: add with one tap</span>
              <div className="hscroll">
                {sugg.map(s => {
                  const [icon, color] = KIND_ICON[s.kind] || ['repeat', '#8e8e93'];
                  return (
                    <div key={s.name} className="glass card stack-sm" style={{ width: 200 }}>
                      <Tile icon={icon} color={color} />
                      <b>{s.name}</b>
                      <span className="caption"><Money m={s.amount} /> · {cycleLabel(s.cycle_months).toLowerCase()}</span>
                      <button className="btn small secondary" onClick={async () => {
                        await add.mutateAsync({ name: s.name, kind: s.kind, amount_minor: s.amount.minor, currency: s.amount.currency, cycle_months: s.cycle_months, next_due: s.next_due, match_pattern: s.match_pattern, evidence_txn_ids: s.evidence_txn_ids });
                        toast(`${s.name} added`);
                      }}><Icon name="check" size={16} />Confirm</button>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <Link to="/plan" className="glass hero span-2" style={{ color: 'inherit' }} aria-label="Monthly committed, open the plan">
            <div className="between"><span className="hero-label">Committed each month · your share</span><Icon name="chevR" size={14} /></div>
            <div className="grid-2" style={{ marginTop: 8 }}>
              <div className="stat"><span className="k">🇸🇦 Saudi</span><span className="v">{byCountry('SA').map(m => fmt(m)).join(' + ') || '—'}</span></div>
              <div className="stat"><span className="k">🇮🇳 India</span><span className="v">{byCountry('IN').map(m => fmt(m)).join(' + ') || '—'}</span></div>
            </div>
            <p className="caption" style={{ marginTop: 8 }}>This feeds your {months} plan · longer cycles (rent every 6 months) are saved for monthly in a fund.</p>
          </Link>

          {!all.length && !sugg.length && <div className="glass card caption span-2">Rent, bills, EMIs, school fees and money sent home: anything you pay on a schedule. We spot them in your transactions, or tap +.</div>}
          {GROUPS.map(([key, label]) => {
            const items = all.filter(c => groupOf(c) === key);
            if (!items.length) return null;
            return (
              <Section key={key} title={label} action={<span className="caption">≈ {sumByCurrency(items.map(c => perMonth(c, mine(c)))).map(m => fmt(m, { compact: true })).join(' + ')}/mo</span>}>
                <List>{items.map(c => {
                  const [icon, color] = KIND_ICON[c.kind] || ['calendar', '#8e8e93'];
                  const forWho = memberName(c.for_member_id), from = acctName(c.account_id);
                  return (
                    <ListRow key={c.id} icon={<Tile icon={icon} color={color} />} title={c.name} onClick={() => setOpen(c)} chevron={false}
                      sub={<>{[cycleLabel(c.cycle_months), `next ${dueLabel(c.next_due)}`, forWho && `for ${forWho}`, from && `from ${from}`].filter(Boolean).join(' · ')}
                        {c.shares.length > 0 && <><br />{c.shares.map(s => <span key={s.member_id || s.contact_id} className={`badge ${s.paid_this_cycle ? 'green' : 'orange'}`} style={{ marginRight: 4 }}>
                          {s.name} <Money m={s.share} /> {s.paid_this_cycle ? 'paid' : 'not paid'}</span>)}</>}</>}
                      end={<Money m={c.amount} />} endSub={c.shares.length ? <>yours <Money m={mine(c)} /></> : <StatusBadge status={c.status} />} />
                  );
                })}</List>
              </Section>
            );
          })}
        </div>
      )}

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.name}>
        {open && <Detail c={open} forWho={memberName(open.for_member_id)} from={acctName(open.account_id)} onEdit={() => { setEditing(open); setOpen(null); }} onDone={() => setOpen(null)} />}
      </Sheet>
      <CommitmentSheet open={creating} onClose={() => setCreating(false)} />
      {editing && <CommitmentSheet open edit={editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function Detail({ c, forWho, from, onEdit, onDone }: { c: Commitment; forWho?: string; from: string | null; onEdit: () => void; onDone: () => void }) {
  const markPaid = useWrite<{ id: string; payer?: { kind: string; id: string } }>('POST', b => `/commitments/${b.id}/paid`);
  const stop = useWrite<{ id: string }>('DELETE', b => `/commitments/${b.id}`);
  const toast = useToast();
  return (
    <div className="stack">
      <dl className="kv glass card">
        <dt>Amount</dt><dd><Money m={c.amount} /></dd>
        {c.shares.length > 0 && <><dt>Your share</dt><dd><Money m={mine(c)} /></dd></>}
        <dt>Repeats</dt><dd>{cycleLabel(c.cycle_months)}</dd>
        <dt>Next due</dt><dd>{shortDate(c.next_due)}</dd>
        <dt>Last paid</dt><dd>{c.last_paid ? shortDate(c.last_paid.day) : '—'}</dd>
        {forWho && <><dt>For</dt><dd>{forWho}</dd></>}
        {from && <><dt>Paid from</dt><dd>{from}</dd></>}
      </dl>
      {c.shares.length > 0 && (
        <Section title="Shared with">
          <List>{c.shares.map(s => (
            <ListRow key={s.member_id || s.contact_id} icon={<PersonAvatar id={s.member_id || s.contact_id} name={s.name || '?'} size={32} />} title={s.name}
              sub={<>Share <Money m={s.share} /> ({Math.round(100 * s.share.minor / Math.max(1, c.amount.minor))}%){s.paid_this_cycle ? '' : ' · tap when they pay'}</>}
              end={s.paid_this_cycle ? <span className="badge green">Paid</span> : <span className="badge orange">Not paid</span>} chevron={false}
              onClick={s.paid_this_cycle ? undefined : async () => {
                await markPaid.mutateAsync({ id: c.id, payer: { kind: s.member_id ? 'member' : 'contact', id: (s.member_id || s.contact_id)! } });
                toast(`${s.name} paid`); onDone();
              }} />
          ))}</List>
        </Section>
      )}
      {c.status !== 'paid' && <button className="btn block" onClick={async () => { await markPaid.mutateAsync({ id: c.id }); toast('Marked paid for this cycle'); onDone(); }}><Icon name="check" />Mark paid</button>}
      <div className="grid-2">
        <button className="btn secondary" onClick={onEdit}><Icon name="note" size={16} />Edit</button>
        <button className="btn danger" disabled={stop.isPending} onClick={async () => {
          if (!confirm(`Stop ${c.name}? It leaves your plan; past payments stay in your transactions.`)) return;
          await stop.mutateAsync({ id: c.id }); toast(`${c.name} stopped`); onDone();
        }}><Icon name="close" size={16} />Stop</button>
      </div>
      <p className="footnote" style={{ textAlign: 'center' }}>Payments tick this off automatically when the bank SMS matches.</p>
    </div>
  );
}

/** Add a recurring payment, or change one (`edit`): the same form, saved with PATCH. */
function CommitmentSheet({ open, onClose, edit }: { open: boolean; onClose: () => void; edit?: Commitment }) {
  const [name, setName] = useState(edit?.name || '');
  const [kind, setKind] = useState<string>(edit?.kind || 'bill');
  const [amount, setAmount] = useState(edit ? String(edit.amount.minor / 100) : '');
  const [currency, setCurrency] = useState<string>(edit?.amount.currency || 'SAR');
  const [cycle, setCycle] = useState(edit?.cycle_months ?? 1);
  const [due, setDue] = useState(edit?.next_due || today());
  const [where, setWhere] = useState<'SA' | 'IN' | 'other'>(edit ? (edit.country === 'IN' ? 'IN' : edit.country === 'SA' ? 'SA' : 'other') : 'SA');
  const [forWho, setForWho] = useState<string | null>(edit?.for_member_id || null);
  const [account, setAccount] = useState<string | null>(edit?.account_id || null);
  const editShares = (edit?.shares || []).map(s => [s.member_id || s.contact_id || '', s] as const);
  const [sharers, setSharers] = useState<string[]>(editShares.map(([id]) => id));
  const [split, setSplit] = useState<'equal' | 'pct'>(editShares.length ? 'pct' : 'equal');
  const [pct, setPct] = useState<Record<string, string>>(Object.fromEntries(editShares.map(([id, s]) => [id, String(Math.round(100 * s.share.minor / Math.max(1, edit!.amount.minor)))])));
  const people = (useApi<{ items: Person[] }>(open ? '/people' : null).data?.items || []).filter(p => p.relation !== 'self');
  const accounts = (useApi<{ items: Account[] }>(open ? '/accounts' : null).data?.items || []).filter(a => ['bank', 'credit_card', 'wallet'].includes(a.kind));
  const save = useWrite<Record<string, unknown>>(edit ? 'PATCH' : 'POST', edit ? `/commitments/${edit.id}` : '/commitments');
  const toast = useToast();
  const total = toMinor(Number(amount) || 0, currency);
  const shareOf = (id: string) => (split === 'equal' ? Math.floor(total / (sharers.length + 1)) : Math.round(total * (Number(pct[id]) || 0) / 100));
  const others = sharers.reduce((s, id) => s + shareOf(id), 0);
  const pickCurrency = (c: string) => { setCurrency(c); setWhere(c === 'INR' ? 'IN' : c === 'SAR' ? 'SA' : 'other'); };
  const submit = async () => {
    const shares = sharers.map(id => { const p = people.find(x => x.id === id)!; return { [p.kind === 'member' ? 'member_id' : 'contact_id']: id, share_minor: shareOf(id) }; });
    await save.mutateAsync({ name, kind, amount_minor: total, currency, cycle_months: cycle, next_due: due, country: where === 'other' ? '' : where, shares,
      for_member_id: forWho, account_id: account });
    toast(edit ? `${name} saved` : `${name} added`); if (!edit) { setName(''); setAmount(''); setSharers([]); setPct({}); } onClose();
  };
  const family = people.filter(p => p.kind === 'member');
  return (
    <Sheet open={open} onClose={onClose} title={edit ? `Edit ${edit.name}` : 'New recurring payment'} detent="large">
      <div className="stack">
        <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={pickCurrency} />
        <Field label="What"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Rent, SEC, Netflix, Umma…" /></Field>
        <div className="chips" style={{ flexWrap: 'wrap' }}>{KINDS.map(([k, l]) => <Chip key={k} on={kind === k} onClick={() => setKind(k)}>{l}</Chip>)}</div>
        <div className="chips" style={{ flexWrap: 'wrap' }}>{CYCLES.map(c => <Chip key={c.v} on={cycle === c.v} onClick={() => setCycle(c.v)}>{c.l}</Chip>)}</div>
        <Field label="Next due"><input className="input" type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
        <Segmented label="Country" value={where} onChange={setWhere} options={[{ value: 'SA', label: 'Saudi' }, { value: 'IN', label: 'India' }, { value: 'other', label: 'Other' }]} />
        {family.length > 0 && <div className="stack-sm"><b style={{ margin: '0 4px' }}>For</b>
          <div className="chips" style={{ flexWrap: 'wrap' }}><Chip on={!forWho} onClick={() => setForWho(null)}>Me / household</Chip>
            {family.map(p => <Chip key={p.id} on={forWho === p.id} onClick={() => setForWho(p.id)}>{p.name}</Chip>)}</div></div>}
        {accounts.length > 0 && <div className="stack-sm"><b style={{ margin: '0 4px' }}>Paid from</b>
          <div className="chips" style={{ flexWrap: 'wrap' }}><Chip on={!account} onClick={() => setAccount(null)}>Not set</Chip>
            {accounts.map(a => <Chip key={a.id} on={account === a.id} onClick={() => setAccount(a.id)}>{a.institution}{a.last4 ? ' ··' + a.last4 : ''}</Chip>)}</div></div>}
        <div className="stack-sm">
          <div className="between" style={{ margin: '0 4px' }}><b>Shared with</b>{sharers.length > 0 && <span className="caption">yours {fmt({ minor: total - others, currency })}</span>}</div>
          {sharers.length > 0 && <Segmented label="Split" value={split} onChange={setSplit} options={[{ value: 'equal', label: 'Equal split' }, { value: 'pct', label: 'By %' }]} />}
          <List>
            {people.map(p => {
              const on = sharers.includes(p.id);
              return (
                <div key={p.id} className="list-row">
                  <button type="button" className="row-flex" style={{ flex: 1, minWidth: 0, background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left', minHeight: 44 }}
                    aria-pressed={on} onClick={() => setSharers(on ? sharers.filter(x => x !== p.id) : [...sharers, p.id])}>
                    <Avatar name={p.name} photo={p.photo} size={32} /><span style={{ flex: 1, minWidth: 0 }}>{p.name}<br /><span className="caption">{p.kind === 'member' ? p.relation : 'friend'}</span></span>
                    {on && <span className="num caption">{fmt({ minor: shareOf(p.id), currency })}</span>}
                    {on ? <Icon name="check" size={22} className="pos" /> : <Icon name="plus" size={20} className="muted" />}
                  </button>
                  {on && split === 'pct' && <input className="input" inputMode="decimal" aria-label={`${p.name}’s share in %`} style={{ width: 72, flex: 'none' }} placeholder="%"
                    value={pct[p.id] || ''} onChange={e => setPct({ ...pct, [p.id]: e.target.value.replace(/[^\d.]/g, '') })} />}
                </div>
              );
            })}
          </List>
          {!people.length && <p className="caption" style={{ marginLeft: 4 }}>Add family or friends in People to share a bill.</p>}
        </div>
        <button className="btn block" disabled={!name || !Number(amount) || others > total || save.isPending} onClick={submit}>{edit ? 'Save' : 'Add'}</button>
        {others > total && <p className="error" role="alert">Shares add up to more than the bill.</p>}
        {save.error && <p className="error" role="alert">{save.error.message}</p>}
        {cycle > 1 && <p className="footnote" style={{ textAlign: 'center' }}>We’ll make a fund and suggest a monthly set-aside.</p>}
      </div>
    </Sheet>
  );
}
