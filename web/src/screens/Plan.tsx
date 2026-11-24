import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api, useApi, useWrite } from '../api/client';
import type { Account, Advice, Commitment, Fund, HouseholdFull, Liability, Lookahead, MonthPlan, Money as MoneyT, PlanLine, PlanMonth, Pot, WhatIf } from '../api/types';
import { fmt, monthLabel, sumByCurrency, today, toMinor } from '../lib/format';
import {
  AmountInput, Avatar, BarChart, Chip, ErrorCard, Field, Icon, List, ListRow, Meter, Money, Page, PageSkeleton, ProgressRing, Section, Segmented, Sheet, Tile, Toggle, useToast,
} from '../ui';
import { PersonAvatar } from './People';


export default function PlanPage() {
  const look = useApi<Lookahead>('/insights/lookahead', { months: 12 });
  const commits = useApi<{ items: Commitment[] }>('/commitments');
  const { hash } = useLocation();
  useEffect(() => {
    if (hash && look.data && commits.data) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash, look.data, commits.data]);
  return (
    <Page title="Plan">
      <div className="grid-desktop stack">
        <div className="span-2"><MonthPlanner /></div>
        <List className="span-2">
          <ListRow to="/recurring" icon={<Tile icon="repeat" color="#af52de" />} title="Recurring payments" sub="Rent, bills, subscriptions, EMIs, family: all feed this plan"
            end={commits.data ? sumByCurrency(commits.data.items.filter(c => c.cycle_months).map(c => ({ ...c.amount, minor: Math.round(c.amount.minor / c.cycle_months) }))).map(m => fmt(m, { compact: true })).join(' + ') + '/mo' : undefined} />
          <ListRow to="/payoff" icon={<Tile icon="target" color="#ff453a" />} title="Debt-free plan" sub="Months to clear the cards, then the loans" />
        </List>
        <Debts />
        <Funds />
        <Section title="Next 12 months">
          <div id="lookahead" style={{ scrollMarginTop: 80 }} />
          {look.isLoading ? <PageSkeleton /> : look.error ? <ErrorCard error={look.error} retry={look.refetch} /> : <LookaheadCard l={look.data!} />}
        </Section>
        <Afford />
        <AdviceCard />
      </div>
    </Page>
  );
}

const LINE_GROUPS: [PlanLine['kind'], string][] = [['commitment', 'Bills & commitments'], ['emi', 'Loan EMIs'], ['card', 'Credit card bills'], ['person', 'Owed to people'], ['fund', 'Set aside']];
const when = (d: string | null) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en', { day: 'numeric', month: 'short' }) : '');

/** This month or next: salary minus everything due → left over or short; then who pays what, from which account, and what to send home. */
function MonthPlanner() {
  const q = useApi<MonthPlan>('/insights/plan');
  const accounts = useApi<{ items: Account[] }>('/accounts');
  const [params, setParams] = useSearchParams();
  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorCard error={q.error} retry={q.refetch} />;
  const months = q.data!.months;
  const pick = params.get('month');
  const m: PlanMonth = months.find(x => x.month === pick) || months[0];
  const name = (id: string | null) => { const a = accounts.data?.items.find(x => x.id === id); return a ? `${a.institution}${a.last4 ? ' ··' + a.last4 : ''}` : ''; };
  const short = !!m.short;
  return (
    <section className="stack" aria-label="Month plan" id="month">
      <Segmented label="Month" value={m.month} onChange={v => setParams(v === months[0].month ? {} : { month: v }, { replace: true })}
        options={months.map((x, i) => ({ value: x.month, label: `${i ? 'Next' : 'This'} month · ${monthLabel(x.month)}` }))} />
      <div className="glass card stack-sm">
        <div className="between plan-line"><span><b>Salary</b></span><b className="num pos">+{fmt(m.income)}</b></div>
        {LINE_GROUPS.map(([kind, label]) => {
          const xs = m.lines.filter(l => l.kind === kind);
          if (!xs.length) return null;
          const total = xs.filter(l => l.counted).reduce((a, l) => a + l.base.minor, 0);
          return (
            <details key={kind} className="plan-group" open={kind !== 'fund'}>
              <summary className="between plan-line"><span>{label} <span className="caption">· {xs.length}</span></span><span className="num neg">−{fmt({ minor: total, currency: m.out.currency })}</span></summary>
              <List>{xs.map((l, i) => (
                <Link key={i} to={l.link} className="list-row no-icon" style={{ minHeight: 48, color: l.paid ? 'var(--text-2)' : undefined }}>
                  <div className="body"><div className="title">{l.paid ? <s>{l.name}</s> : l.name}</div>
                    <div className="sub" style={{ color: 'var(--text-2)' }}>{[l.paid ? 'paid' : l.day ? `due ${when(l.day)}` : '', l.account_name ? `from ${l.account_name}` : '', l.counted || l.paid ? '' : 'from its fund'].filter(Boolean).join(' · ')}</div>
                    {l.note && <div className="sub wrap warn">{l.note}</div>}</div>
                  <div className="end"><span className="amt"><Money m={l.amount} /></span></div>
                </Link>
              ))}</List>
            </details>
          );
        })}
        <div className={`between plan-total ${short ? 'neg' : 'pos'}`}><b>{short ? 'Short by' : 'Left over'}</b><b className="num">{fmt(short ? m.short : m.surplus)}</b></div>
      </div>

      <Section title={`The plan for ${monthLabel(m.month, true)}`}>
        <List>
          {m.move_to_india && (
            <div className="list-row plan-step">
              <span className="step-n">1</span>
              <div className="body"><div className="title">Move <Money m={m.move_to_india.amount} /> to India</div>
                <div className="sub wrap">≈ <Money m={m.move_to_india.inr} />{m.move_to_india.from ? ` from ${name(m.move_to_india.from)}` : ''}{m.move_to_india.to ? ` to ${name(m.move_to_india.to)}` : ''}{m.move_to_india.by ? ` by ${when(m.move_to_india.by)}` : ''}.
                  Covers <Money m={m.india.due} /> of Indian dues; <Money m={m.india.cash} /> is already there.</div></div>
            </div>
          )}
          {m.pay_from.map((p, i) => (
            <div key={p.account_id} className="list-row plan-step">
              <span className="step-n">{i + 1 + (m.move_to_india ? 1 : 0)}</span>
              <div className="body"><div className="title">Pay <Money m={p.total} /> from {p.account_name}</div>
                <div className="sub wrap">{p.items.map(x => `${x.name}${x.day ? ' ' + when(x.day) : ''}`).join(' · ')}</div></div>
            </div>
          ))}
          <div className={`list-row plan-step ${short ? 'bad' : 'good'}`}>
            <span className="step-n"><Icon name={short ? 'warn' : 'check'} size={16} /></span>
            <div className="body"><div className="title">{short ? <>Short by <Money m={m.short} /></> : <>Keep <Money m={m.surplus} /> free</>}</div>
              <div className="sub wrap">{short ? 'Move a fund’s set-aside, delay a big buy, or pay the card in part.' : 'After every bill, EMI and card above. Card spending this month shows up as next month’s card bill.'}</div></div>
          </div>
        </List>
      </Section>
    </section>
  );
}

function Afford() {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [pay, setPay] = useState<'cash' | 'card' | 'emi'>('cash');
  const [res, setRes] = useState<WhatIf | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try { setRes(await api<WhatIf>(`/insights/whatif?amount_minor=${toMinor(Number(amount), currency)}&currency=${currency}&pay=${pay}`)); } finally { setBusy(false); }
  };
  const tone = res && { ok: ['var(--green-fill)', 'Go for it', 'check'], tight: ['var(--orange-fill)', 'Tight', 'warn'], no: ['var(--red-fill)', 'Not now', 'close'] }[res.verdict];
  return (
    <section className="glass hero span-2" aria-label="Can I afford it?">
      <div className="hero-label">Can I afford it?</div>
      <AmountInput value={amount} onChange={v => { setAmount(v); setRes(null); }} currency={currency} onCurrency={c => { setCurrency(c); setRes(null); }} label="Price" />
      <div className="stack-sm" style={{ marginTop: 12 }}>
        <Segmented label="How you’d pay" value={pay} onChange={v => { setPay(v); setRes(null); }} options={[{ value: 'cash', label: 'Cash / debit' }, { value: 'card', label: 'Credit card' }, { value: 'emi', label: 'EMI' }]} />
        <button className="btn block" disabled={!Number(amount) || busy} onClick={check}>{busy ? 'Thinking…' : 'Check'}</button>
      </div>
      {res && tone && (
        <div className="glass card page-enter" style={{ marginTop: 14, boxShadow: `inset 0 0 0 1.5px ${tone[0]}` }} role="status">
          <div className="row-flex" style={{ marginBottom: 8 }}>
            <span className="icon-tile" style={{ background: tone[0] }}><Icon name={tone[2]} /></span>
            <b style={{ fontSize: 20 }}>{tone[1]}</b>
          </div>
          <p>{res.why}</p>
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Free this month after</dt><dd className={res.month_free_after.minor < 0 ? 'neg' : ''}><Money m={res.month_free_after} /></dd>
            <dt>Debt-free</dt><dd>{(() => { const d = res.debt_free_after, m = typeof d === 'string' ? d : d?.month; return m ? monthLabel(m, true) : '—'; })()}{res.delay_months > 0 && <span className="neg"> (+{res.delay_months} mo)</span>}</dd>
            {res.extra_interest.minor > 0 && <><dt>Extra interest</dt><dd className="neg"><Money m={res.extra_interest} /></dd></>}
            {res.recover_months !== undefined && <><dt>Earned back in</dt><dd>{res.recover_months === null ? 'no free money to recover it' : `${res.recover_months} ${res.recover_months === 1 ? 'month' : 'months'}`}</dd></>}
          </dl>
          {res.free_per_month && res.recover_months != null && <p className="footnote" style={{ marginTop: 8 }}>At your average free money of <Money m={res.free_per_month} /> a month over the next year.</p>}
        </div>
      )}
    </section>
  );
}

function LookaheadCard({ l }: { l: Lookahead }) {
  const [table, setTable] = useState(false);
  const empty = l.months.every(m => !m.income.minor && !m.free.minor);
  return (
    <div className="glass card stack-sm">
      <div className="between"><span className="caption">Free money per month</span>{!empty && <button className="link-btn" onClick={() => setTable(!table)} aria-expanded={table}>{table ? 'Chart' : 'Table'}</button>}</div>
      {empty ? <p className="caption">Set your salary in <Link to="/more/settings">Settings</Link> and add your commitments to see what’s free in each of the next 12 months.</p>
      : table ? (
        <div className="table-wrap">
          <table className="look">
            <thead><tr><th>Month</th><th>In</th><th>Due</th><th>Funds</th><th>Living</th><th>Free</th></tr></thead>
            <tbody>
              {l.months.map(m => (
                <tr key={m.month} title={m.warnings.join(', ')}>
                  <td>{monthLabel(m.month)} {m.warnings.length > 0 && <Icon name="warn" size={12} className="warn" />}</td>
                  <td>{fmt(m.income, { compact: true })}</td><td>{fmt(m.commitments, { compact: true })}</td><td>{fmt(m.funds, { compact: true })}</td>
                  <td>{fmt(m.everyday, { compact: true })}</td><td className={m.free.minor < 0 ? 'neg' : 'pos'}><b>{fmt(m.free, { compact: true })}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <BarChart data={l.months.map(m => ({ month: m.month, value: m.free.minor / 100 }))} highlight={0} />}
      {l.months.filter(m => m.warnings.length).slice(0, 3).map(m => <p key={m.month} className="caption"><Icon name="info" size={13} /> <b>{monthLabel(m.month, true)}</b> — {m.warnings[0]}</p>)}
    </div>
  );
}

function Funds() {
  const q = useApi<{ items: Fund[] }>('/funds');
  const [open, setOpen] = useState<Fund | null>(null);
  const [pot, setPot] = useState<Fund | null>(null);
  const [amt, setAmt] = useState('');
  const move = useWrite<{ id: string; amount_minor: number }>('POST', b => `/funds/${b.id}/move`);
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  return (
    <Section title="Funds" action={<button onClick={() => setCreating(true)}>Add</button>}>
      <div id="funds" style={{ scrollMarginTop: 80 }} />
      <NewFundSheet open={creating} onClose={() => setCreating(false)} />
      {!q.data ? <PageSkeleton /> : !q.data.items.length ? <div className="glass card caption">Money set aside each month for bills that come every few months, like rent or school fees, appears here. Tap Add to save toward a goal.</div> : (
        <List>
          {q.data.items.map(f => {
            if (f.pot) return <ListRow key={f.id} icon={<Tile icon="house" color="var(--green-fill)" />} title={f.name}
              sub={`Rent from ${f.pot.tenant.name} · ${fmt(f.pot.rent)}/mo`} end={<Money m={f.pot.balance} />} endSub={<PotNote p={f.pot} />} onClick={() => setPot(f)} />;
            const pct = (f.saved.minor / Math.max(1, f.target.minor)) * 100;
            return (
              <ListRow key={f.id} icon={<ProgressRing pct={pct} size={44} stroke={5} color={f.on_track ? 'var(--green-fill)' : 'var(--orange-fill)'} label={<span style={{ fontSize: 11 }}>{Math.round(pct)}%</span>} />}
                title={f.name} sub={<><Money m={f.saved} /> of <Money m={f.target} /> · by {monthLabel(f.due_on.slice(0, 7), true)}</>}
                end={<Money m={f.monthly} />} endSub={f.on_track ? <span className="caption">/month</span> : <span className="badge orange">Behind</span>}
                onClick={() => { setOpen(f); setAmt(String(f.monthly.minor / 100)); }} />
            );
          })}
        </List>
      )}
      <PotSheet fund={pot} onClose={() => setPot(null)} />
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? `Set aside for ${open.name}` : ''}>
        {open && (
          <div className="stack">
            <AmountInput value={amt} onChange={setAmt} currency={open.target.currency} />
            <p className="caption" style={{ textAlign: 'center' }}>Suggested <Money m={open.monthly} /> a month to reach <Money m={open.target} /> on time.</p>
            <button className="btn block" disabled={!Number(amt)} onClick={async () => {
              await move.mutateAsync({ id: open.id, amount_minor: toMinor(Number(amt), open.target.currency) }); toast(`Set aside for ${open.name}`); setOpen(null);
            }}>Set aside</button>
          </div>
        )}
      </Sheet>
    </Section>
  );
}

/** Who owes whom in a pot, signed from your side: + they owe you. */
const owing = (p: Pot) => p.shares.filter(s => s.owes_you.minor !== 0);
function PotNote({ p }: { p: Pot }) {
  const o = owing(p)[0];
  if (p.pending_months.length) return <span className="badge orange">{fmt(p.rent_due)} rent due</span>;
  if (o) return <span className="caption">{o.owes_you.minor > 0 ? `${o.name} owes ${fmt(o.owes_you)}` : `you owe ${o.name} ${fmt({ ...o.owes_you, minor: -o.owes_you.minor })}`}</span>;
  return <span className="caption">in the pot</span>;
}

function PotSheet({ fund, onClose }: { fund: Fund | null; onClose: () => void }) {
  const q = useApi<Fund>(fund ? `/funds/${fund.id}` : null);
  const f = q.data || fund;
  const mark = useWrite<{ month: string; status: 'received' | 'waived' | 'due' }, Fund>('POST', () => `/funds/${fund!.id}/months`);
  const toast = useToast();
  const p = f?.pot;
  const set = async (month: string, status: 'received' | 'waived' | 'due') => {
    await mark.mutateAsync({ month, status });
    toast(status === 'due' ? `${monthLabel(month, true)} is due again` : `${monthLabel(month, true)} marked ${status}`);
  };
  const stat = (label: string, m: Pot['balance'], cls = '') => (
    <div className="glass card"><div className="card-title">{label}</div><div className="stat"><span className={`v ${cls}`}><Money m={m} /></span></div></div>);
  return (
    <Sheet open={!!fund} onClose={onClose} title={f?.name}>
      {f && p && (
        <div className="stack">
          <div className="grid-2">
            {stat('Rent received', p.received, 'pos')}{stat('Groceries paid', p.spent)}
            {stat('In the pot', p.balance)}{stat('Paid from pocket', p.from_pocket, p.from_pocket.minor ? 'neg' : '')}
          </div>
          {p.from_pocket.minor > 0 && <p className="caption">Groceries ran {fmt(p.from_pocket)} over the rent in some months. You paid that, so each co-owner owes their share of it; it shows in People with them.</p>}
          <Section title="Each person’s part">
            <List>
              <ListRow icon={<Avatar name="You" />} title="You" sub={`${p.mine.share_pct}% share`} end={<Money m={p.mine.part} />} chevron={false} />
              {p.shares.map(s => (
                <ListRow key={s.member_id || s.contact_id} icon={<PersonAvatar id={s.member_id || s.contact_id} name={s.name} />} title={s.name} sub={`${s.share_pct}% share`} chevron={false}
                  end={<Money m={s.part} />}
                  endSub={s.owes_you.minor > 0 ? <span className="pos">owes you {fmt(s.owes_you)}</span>
                    : s.owes_you.minor < 0 ? <span className="neg">you owe {fmt({ ...s.owes_you, minor: -s.owes_you.minor })}</span> : <span className="caption">settled</span>} />
              ))}
            </List>
          </Section>
          <Section title={p.pending_months.length ? `Rent due from ${p.tenant.name} · ${fmt(p.rent_due)}` : `Rent from ${p.tenant.name}`}>
            {p.pending_months.length ? (
              <List>
                {p.pending_months.map(m => (
                  <ListRow key={m} icon={<Tile icon="calendar" color="var(--orange-fill)" />} title={monthLabel(m)} sub={fmt(p.rent)} chevron={false}
                    end={<span className="row-flex" style={{ gap: 6 }}>
                      <button className="btn secondary small" disabled={mark.isPending} onClick={() => set(m, 'received')}>Received</button>
                      <button className="btn secondary small" disabled={mark.isPending} onClick={() => set(m, 'waived')}>Waive</button>
                    </span>} />
                ))}
              </List>
            ) : <p className="caption" style={{ marginLeft: 4 }}>All paid up since {monthLabel(p.rent_from.slice(0, 7), true)}.</p>}
            {p.waived_months.map(m => (
              <p key={m} className="caption between" style={{ marginLeft: 4 }}>{monthLabel(m, true)} waived<button className="link-btn" onClick={() => set(m, 'due')}>Undo</button></p>
            ))}
          </Section>
          <p className="footnote">Money in that mentions “{p.match_pattern}” is added to the pot by itself. To pay groceries from it, open the spend in Activity and tap “Paid from pot”.</p>
        </div>
      )}
    </Sheet>
  );
}

function RentForm({ onDone }: { onDone: () => void }) {
  const hh = useApi<HouseholdFull>('/households/current').data;
  const [name, setName] = useState('House groceries');
  const [tenant, setTenant] = useState('');  // a contact id, or '' for a new person
  const [tName, setTName] = useState('');
  const [tEmail, setTEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const [owners, setOwners] = useState<string[]>([]);
  const [words, setWords] = useState('');
  const [invite, setInvite] = useState(true);
  const add = useWrite<Record<string, unknown>, Fund>('POST', '/funds');
  const toast = useToast();
  const people = [...(hh?.members || []).filter(m => m.relation !== 'self').map(m => ({ id: m.id, name: m.display_name, kind: 'member_id' })),
    ...(hh?.contacts || []).map(c => ({ id: c.id, name: c.name, kind: 'contact_id' }))].filter(x => x.id !== tenant);
  const each = Math.floor(100 / (owners.length + 1));
  const email = tenant ? hh?.contacts.find(c => c.id === tenant)?.email || '' : tEmail.trim();
  const tenantName = tenant ? hh?.contacts.find(c => c.id === tenant)?.name || '' : tName.trim();
  const save = async () => {
    const f = await add.mutateAsync({ name: name.trim(), currency, rent: {
      tenant: tenant ? { contact_id: tenant } : { name: tName.trim(), ...(tEmail.trim() ? { email: tEmail.trim() } : {}) },
      amount_minor: toMinor(Number(amount), currency), from, match_pattern: words.trim() || undefined,
      shares: owners.map(id => ({ [people.find(x => x.id === id)!.kind]: id, share_pct: each })) } });
    const sent = invite && email ? (await api<{ sent: boolean }>(`/contacts/${f.pot!.tenant.id}/invite`, { method: 'POST', body: {} }).catch(() => null))?.sent : false;
    toast(`${f.name} set up${sent ? ` — invite sent to ${email}` : invite && email ? ' — mail is off; invite them from People' : ''}`); onDone();
  };
  return (
    <div className="stack">
      <Field label="Tenant">
        <select className="input" value={tenant} onChange={e => setTenant(e.target.value)}>
          <option value="">New person…</option>
          {(hh?.contacts || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      {!tenant && <div className="grid-2">
        <Field label="Name"><input className="input" value={tName} onChange={e => setTName(e.target.value)} placeholder="Faisal" /></Field>
        <Field label="Email (optional)"><input className="input" type="email" value={tEmail} onChange={e => setTEmail(e.target.value)} placeholder="name@example.com" /></Field>
      </div>}
      <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={setCurrency} label="Rent each month" />
      <Field label="First month"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
      <Field label="Owned with">
        <div className="chips" style={{ flexWrap: 'wrap' }}>
          {people.map(x => <Chip key={x.id} on={owners.includes(x.id)} onClick={() => setOwners(owners.includes(x.id) ? owners.filter(o => o !== x.id) : [...owners, x.id])}>{x.name}</Chip>)}
        </div>
      </Field>
      <p className="caption">{owners.length ? <>Split equally: you {100 - each * owners.length}% · {owners.map(o => `${people.find(x => x.id === o)?.name} ${each}%`).join(' · ')}</> : 'Just yours — pick anyone it belongs to as well.'}</p>
      <Field label="Fund it feeds"><input className="input" value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="Bank text to look for (optional)"><input className="input" value={words} onChange={e => setWords(e.target.value)} placeholder={tenantName || 'their name as the bank shows it'} /></Field>
      {email && <List><Toggle label={`Invite ${tenantName || 'them'} to the app`} sub={`A sign-up link to ${email}; they see only what you share`} checked={invite} onChange={setInvite} /></List>}
      <button className="btn block" disabled={!name.trim() || !(tenant || tName.trim()) || !Number(amount) || !from || add.isPending} onClick={save}>Set up rent</button>
      {add.error && <p className="error" role="alert">{add.error.message}</p>}
    </div>
  );
}

function NewFundSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<'goal' | 'rent'>('goal');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [due, setDue] = useState('');
  const add = useWrite<Record<string, unknown>>('POST', '/funds');
  const toast = useToast();
  const save = async () => {
    await add.mutateAsync({ name: name.trim(), target_minor: toMinor(Number(amount), currency), currency, due_on: due });
    toast(`${name.trim()} fund started`); setName(''); setAmount(''); setDue(''); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="New fund">
      <div className="stack">
        <Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: 'goal', label: 'Saving goal' }, { value: 'rent', label: 'Rent from a tenant' }]} />
        {kind === 'rent' ? <RentForm onDone={onClose} /> : <>
        <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={setCurrency} label="Target" />
        <Field label="Saving for"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Emergency, car service, Onam trip…" /></Field>
        <Field label="Needed by"><input className="input" type="date" min={today()} value={due} onChange={e => setDue(e.target.value)} /></Field>
        <button className="btn block" disabled={!name.trim() || !Number(amount) || !due || add.isPending} onClick={save}>Start fund</button>
        {add.error && <p className="error" role="alert">{add.error.message}</p>}
        <p className="footnote" style={{ textAlign: 'center' }}>We work out how much to set aside each month to get there on time.</p>
        </>}
      </div>
    </Sheet>
  );
}

function Debts() {
  const q = useApi<{ items: Liability[]; emi_total: MoneyT; outstanding_total: MoneyT }>('/liabilities');
  const [open, setOpen] = useState<Liability | 'new' | null>(null);
  const items = q.data?.items || [];
  const done = items.filter(l => l.closed || l.outstanding.minor <= 0).length;
  return (
    <Section title="Loans & cards" action={<button onClick={() => setOpen('new')}>Add</button>}>
      <div id="debts" style={{ scrollMarginTop: 80 }} />
      {!q.data ? <PageSkeleton /> : !q.data.items.length ? <div className="glass card caption"><Icon name="check" size={14} className="pos" /> No loans or card debt tracked. Card and BNPL balances appear from your SMS.</div> : (
        <>
        <div className="glass card stack-sm" aria-label="Loans summary">
          <div className="grid-2">
            <div className="stat"><span className="k">EMIs a month</span><span className="v"><Money m={q.data.emi_total} compact /></span></div>
            <div className="stat"><span className="k">Still owed</span><span className="v warn"><Money m={q.data.outstanding_total} compact /></span></div>
          </div>
          <div className="between caption"><span>{items.length - done} pending · {done} closed</span><span>your share where a loan is shared</span></div>
        </div>
        <List>
          {q.data.items.map(l => (
            <button key={l.id} type="button" className="list-row" onClick={() => setOpen(l)} aria-label={`${l.name}, edit`}
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingTop: 14, paddingBottom: 14, width: '100%', textAlign: 'left', opacity: l.closed ? .55 : 1 }}>
              <div className="between">
                <span className="row-flex" style={{ minWidth: 0 }}><Tile icon={LOAN_ICON[l.kind] || 'bank'} color={l.rate_bp > 1500 ? '#ff453a' : '#5e5ce6'} />
                  <span style={{ minWidth: 0 }}><b>{l.name}</b><br /><span className="caption">{[l.lender, `${(l.rate_bp / 100).toFixed(2)}%`, l.closed && 'closed'].filter(Boolean).join(' · ')}</span>
                    {l.shared && <><br /><span className="caption">{l.my_share_pct}% yours{l.shared.holder ? ` · in ${l.shared.holder.name}’s name` : ''} </span>
                      <span className={`badge ${l.shared.sent_this_month ? 'green' : 'orange'}`}>{l.shared.sent_this_month ? 'Sent this month' : 'Not sent yet'}</span></>}</span></span>
                <span style={{ textAlign: 'right' }}><b className="num"><Money m={l.outstanding} compact /></b><br /><span className="caption"><Money m={l.emi} compact />/mo</span></span>
              </div>
              <Meter pct={l.paid_pct ?? 0} color={l.rate_bp > 1500 ? 'var(--red-fill)' : undefined} />
              <div className="between caption"><span>{l.paid_pct ?? 0}% paid · interest <Money m={l.interest_month} />/mo</span><span>Done {l.payoff_month ? monthLabel(l.payoff_month, true) : '—'}</span></div>
            </button>
          ))}
        </List>
        </>
      )}
      <LoanSheet loan={open} onClose={() => setOpen(null)} />
    </Section>
  );
}

const LOAN_ICON: Record<string, string> = { loan: 'bank', credit_card: 'card', bnpl: 'wallet', person: 'person' };
const LOAN_KINDS: { value: Liability['kind']; label: string }[] = [{ value: 'loan', label: 'Loan' }, { value: 'credit_card', label: 'Card' }, { value: 'bnpl', label: 'BNPL' }, { value: 'person', label: 'Person' }];
const major = (m?: { minor: number } | null) => (m && m.minor ? String(m.minor / 100) : '');

function LoanSheet({ loan, onClose }: { loan: Liability | 'new' | null; onClose: () => void }) {
  const l = loan && loan !== 'new' ? loan : null;
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!loan) return;
    // a shared loan is edited as the whole loan (the list shows your share)
    setF(l ? { kind: l.kind, name: l.name, lender: l.lender || '', currency: l.currency, principal: major(l.shared?.loan_principal || l.principal),
      opening: major(l.shared?.loan_opening_balance || l.opening_balance), as_of: l.as_of || '', rate: l.rate_bp ? String(l.rate_bp / 100) : '',
      emi: major(l.shared?.loan_emi || l.emi), start_on: l.start_on || '', end_on: l.end_on || '', match_pattern: l.match_pattern || '',
      holder: l.holder_contact_id || '', share: String(l.my_share_pct ?? 100) }
      : { kind: 'loan', currency: 'SAR', as_of: today() });
  }, [loan]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (v: string) => setF(x => ({ ...x, [k]: v }));
  const input = (k: string) => ({ value: f[k] || '', onChange: (e: { target: { value: string } }) => set(k)(e.target.value) });
  const toast = useToast();
  const add = useWrite<Record<string, unknown>>('POST', '/liabilities');
  const edit = useWrite<Record<string, unknown>>('PATCH', () => `/liabilities/${l!.id}`);
  const del = useWrite('DELETE', () => `/liabilities/${l!.id}`);
  const cur = f.currency || 'SAR';
  const amt = (k: string) => (f[k] && Number(f[k]) >= 0 ? toMinor(Number(f[k]), cur) : undefined);
  const save = async () => {
    const day = (k: string) => f[k] || (l ? null : undefined);  // editing: an emptied date clears it
    const body = { kind: f.kind, name: f.name.trim(), lender: f.lender || '', currency: cur, principal_minor: amt('principal'), opening_balance_minor: amt('opening'),
      as_of: f.as_of || undefined, rate_bp: f.rate ? Math.round(Number(f.rate) * 100) : 0, emi_minor: amt('emi') ?? 0, start_on: day('start_on'), end_on: day('end_on'),
      match_pattern: f.match_pattern || '', holder_contact_id: f.holder || (l ? null : undefined), my_share_pct: Math.round(Number(f.share) || 100) };
    if (l) await edit.mutateAsync(body); else await add.mutateAsync(body);
    toast(l ? `${body.name} saved` : `${body.name} added`); onClose();
  };
  const busy = add.isPending || edit.isPending || del.isPending;
  const err = add.error || edit.error || del.error;
  const badRate = !!f.rate && !(Number(f.rate) >= 0 && Number(f.rate) <= 1000);
  const badShare = !!f.share && !(Number(f.share) >= 1 && Number(f.share) <= 100);
  const contacts = useApi<HouseholdFull>(loan ? '/households/current' : null).data?.contacts || [];
  return (
    <Sheet open={!!loan} onClose={onClose} title={l ? l.name : 'Add a loan'} detent="large">
      {loan && (
        <div className="stack">
          <Segmented label="Kind" value={(f.kind || 'loan') as Liability['kind']} onChange={set('kind')} options={LOAN_KINDS} />
          <Field label="Name"><input className="input" {...input('name')} placeholder={f.kind === 'person' ? 'Loan from Rohan' : 'Camry auto finance'} /></Field>
          <Field label={f.kind === 'person' ? 'Who lent it' : 'Lender'}><input className="input" {...input('lender')} placeholder={f.kind === 'person' ? 'Rohan' : 'Al Rajhi Bank'} /></Field>
          <AmountInput value={f.principal || ''} onChange={set('principal')} currency={cur} onCurrency={set('currency')} label="Amount borrowed" />
          <p className="caption" style={{ textAlign: 'center', marginTop: -8 }}>Amount borrowed</p>
          <div className="grid-2">
            <Field label="Balance left"><input className="input" inputMode="decimal" {...input('opening')} placeholder={f.principal || '0'} /></Field>
            <Field label="As of"><input className="input" type="date" {...input('as_of')} /></Field>
          </div>
          <div className="grid-2">
            <Field label="Rate (% a year)"><input className="input" inputMode="decimal" {...input('rate')} placeholder="4.5" /></Field>
            <Field label={`EMI (${cur} a month)`}><input className="input" inputMode="decimal" {...input('emi')} placeholder="0" /></Field>
          </div>
          <div className="grid-2">
            <Field label="Started"><input className="input" type="date" {...input('start_on')} /></Field>
            <Field label="Ends"><input className="input" type="date" {...input('end_on')} /></Field>
          </div>
          <div className="glass card stack-sm">
            <b>In someone else’s name?</b>
            <div className="grid-2">
              <Field label="Held by"><select className="input" {...input('holder')}><option value="">Me</option>{contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="My share (%)"><input className="input" inputMode="numeric" maxLength={3} {...input('share')} placeholder="100" /></Field>
            </div>
            <p className="footnote">Enter the whole loan above. Your share sets your EMI, balance and payoff; what you send them each month counts as your payment.</p>
          </div>
          <Field label="Match bank SMS containing"><input className="input" {...input('match_pattern')} placeholder="e.g. AUTO LOAN 3302" /></Field>
          <button className="btn block" disabled={!f.name?.trim() || badRate || badShare || busy} onClick={save}>{l ? 'Save' : 'Add loan'}</button>
          {err && <p className="error" role="alert">{err.message}</p>}
          {l && (
            <div className="grid-2">
              <button className="btn secondary" disabled={busy} onClick={async () => { await edit.mutateAsync({ closed: !l.closed }); toast(l.closed ? 'Reopened' : `${l.name} closed`); onClose(); }}>
                <Icon name={l.closed ? 'repeat' : 'check'} size={16} />{l.closed ? 'Reopen' : 'Mark closed'}</button>
              <button className="btn danger" disabled={busy} onClick={async () => {
                if (!confirm(`Delete ${l.name}? Payments linked to it are kept but unlinked.`)) return;
                await del.mutateAsync(undefined); toast(`${l.name} deleted`); onClose();
              }}><Icon name="trash" size={16} />Delete</button>
            </div>
          )}
          <p className="footnote" style={{ textAlign: 'center' }}>Balance left and its date let you start mid-loan; payments after that date bring it down.</p>
        </div>
      )}
    </Sheet>
  );
}

function AdviceCard() {
  const q = useApi<Advice>('/insights/advice');
  if (!q.data) return null;
  const a = q.data;
  return (
    <Section title="Where to put money">
      <div className="glass card stack">
        <div className="row-flex">
          <ProgressRing pct={((a.emergency.months_covered ?? 0) / 6) * 100} size={60} stroke={7} color="var(--green-fill)" label={a.emergency.months_covered === null ? '—' : a.emergency.months_covered.toFixed(1)} />
          <div><b>Months of safety</b><p className="caption">Emergency fund target <Money m={a.emergency.target} /></p></div>
        </div>
        <ol className="steps" style={{ padding: 0, margin: 0, listStyle: 'none' }}>
          {a.steps.map((s, i) => (
            <li key={i} className="step">
              <span className="n">{i + 1}</span>
              <div style={{ flex: 1 }}>
                <div className="between"><b>{s.title}</b>{s.amount && <span className="num" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}><Money m={s.amount} compact /></span>}</div>
                <p className="caption">{s.why}</p>
              </div>
            </li>
          ))}
        </ol>
        {!a.steps.length && <p className="caption">Add your salary and a few months of transactions, and steps show up here.</p>}
        <p className="footnote">{a.note || 'Rules of thumb, not financial advice.'}</p>
      </div>
    </Section>
  );
}
