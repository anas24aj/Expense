import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, useApi, useWrite } from '../api/client';
import type { Advice, Commitment, DetectedCommitment, Fund, Liability, Lookahead, Person, WhatIf } from '../api/types';
import { fmt, monthLabel, shortDate, today, toMinor } from '../lib/format';
import {
  AmountInput, Avatar, BarChart, Chip, ErrorCard, Field, Icon, List, ListRow, Meter, Money, Page, PageSkeleton, ProgressRing, Section, Segmented, Sheet, Tile, useToast,
} from '../ui';
import { DueRow, KIND_ICON } from './Home';

const GROUPS: [string, string][] = [['rent', 'Rent'], ['bill', 'Bills'], ['subscription', 'Subscriptions'], ['emi', 'EMIs'], ['support', 'Family support'],
  ['insurance', 'Insurance'], ['school', 'School'], ['milestone', 'Property milestones']];
const CYCLES = [{ v: 1, l: 'Monthly' }, { v: 3, l: 'Every 3 months' }, { v: 6, l: 'Every 6 months' }, { v: 12, l: 'Yearly' }];

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
        <Afford />
        <Section title="Next 12 months">
          <div id="lookahead" style={{ scrollMarginTop: 80 }} />
          {look.isLoading ? <PageSkeleton /> : look.error ? <ErrorCard error={look.error} retry={look.refetch} /> : <LookaheadCard l={look.data!} />}
        </Section>
        <div className="span-2"><Commitments q={commits} /></div>
        <Funds />
        <Debts />
        <AdviceCard />
      </div>
    </Page>
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
          </dl>
        </div>
      )}
    </section>
  );
}

function LookaheadCard({ l }: { l: Lookahead }) {
  const [table, setTable] = useState(false);
  return (
    <div className="glass card stack-sm">
      <div className="between"><span className="caption">Free money per month</span><button className="link-btn" onClick={() => setTable(!table)} aria-expanded={table}>{table ? 'Chart' : 'Table'}</button></div>
      {table ? (
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

function Commitments({ q }: { q: ReturnType<typeof useApi<{ items: Commitment[] }>> }) {
  const detect = useApi<{ items: DetectedCommitment[] }>('/commitments/detect');
  const add = useWrite('POST', '/commitments');
  const markPaid = useWrite<{ id: string }>('POST', b => `/commitments/${b.id}/paid`);
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Commitment | null>(null);
  const deep = new URLSearchParams(useLocation().search).get('commitment');
  useEffect(() => { if (deep && q.data) setOpen(q.data.items.find(c => c.id === deep) || null); }, [deep, q.data]);
  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorCard error={q.error} retry={q.refetch} />;
  const all = q.data!.items;
  const sugg = detect.data?.items || [];
  return (
    <Section title="Commitments" action={<button onClick={() => setCreating(true)}>Add</button>}>
      {sugg.length > 0 && (
        <div className="stack-sm">
          <span className="caption" style={{ marginLeft: 4 }}><Icon name="sparkle" size={13} /> We found these in your spending — add?</span>
          <div className="hscroll">
            {sugg.map(s => {
              const [icon, color] = KIND_ICON[s.kind] || ['repeat', '#8e8e93'];
              return (
                <div key={s.name} className="glass card stack-sm" style={{ width: 200 }}>
                  <Tile icon={icon} color={color} />
                  <b>{s.name}</b>
                  <span className="caption"><Money m={s.amount} /> · {s.cycle_months === 1 ? 'monthly' : `every ${s.cycle_months} mo`}</span>
                  <button className="btn small secondary" onClick={async () => {
                    await add.mutateAsync({ name: s.name, kind: s.kind, amount_minor: s.amount.minor, currency: s.amount.currency, cycle_months: s.cycle_months, next_due: s.next_due, match_pattern: s.match_pattern, evidence_txn_ids: s.evidence_txn_ids });
                    toast(`${s.name} added`);
                  }}><Icon name="plus" size={16} />Add</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="grid-desktop stack">
        {GROUPS.map(([kind, label]) => {
          const items = all.filter(c => c.kind === kind);
          if (!items.length) return null;
          const monthly = items.reduce((s, c) => (c.amount.currency === items[0].amount.currency ? s + c.amount.minor / Math.max(1, c.cycle_months) : s), 0);
          return (
            <div key={kind} className="stack-sm">
              <div className="between" style={{ margin: '4px 4px 0' }}><b>{label}</b><span className="caption">≈ {fmt({ minor: monthly, currency: items[0].amount.currency })}/mo</span></div>
              <List>{items.map(c => <DueRow key={c.id} c={c} onClick={() => setOpen(c)} />)}</List>
            </div>
          );
        })}
      </div>
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.name}>
        {open && (
          <div className="stack">
            <dl className="kv glass card">
              <dt>Amount</dt><dd><Money m={open.amount} /></dd>
              <dt>Repeats</dt><dd>{CYCLES.find(c => c.v === open.cycle_months)?.l || 'Once'}</dd>
              <dt>Next due</dt><dd>{shortDate(open.next_due)}</dd>
              <dt>Last paid</dt><dd>{open.last_paid ? shortDate(open.last_paid.day) : '—'}</dd>
              {open.shares.length > 0 && <><dt>Shared with</dt><dd>{open.shares.map(s => s.name).join(', ')}</dd></>}
            </dl>
            {open.status !== 'paid' && <button className="btn block" onClick={async () => { await markPaid.mutateAsync({ id: open.id }); toast('Marked paid for this cycle'); setOpen(null); }}><Icon name="check" />Mark paid</button>}
            <p className="footnote" style={{ textAlign: 'center' }}>Payments tick this off automatically when the bank SMS matches.</p>
          </div>
        )}
      </Sheet>
      <NewCommitmentSheet open={creating} onClose={() => setCreating(false)} />
    </Section>
  );
}

function NewCommitmentSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('bill');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [cycle, setCycle] = useState(1);
  const [due, setDue] = useState(today());
  const [country, setCountry] = useState<'SA' | 'IN' | 'other'>('SA');
  const [sharers, setSharers] = useState<string[]>([]);
  const [equal, setEqual] = useState<'equal' | 'custom'>('equal');
  const [custom, setCustom] = useState<Record<string, string>>({});
  const people = (useApi<{ items: Person[] }>(open ? '/people' : null).data?.items || []).filter(p => p.relation !== 'self');
  const add = useWrite<Record<string, unknown>>('POST', '/commitments');
  const toast = useToast();
  const total = toMinor(Number(amount) || 0, currency);
  const each = Math.floor(total / (sharers.length + 1));  // you're one of the equal shares
  const shareOf = (id: string) => (equal === 'equal' ? each : toMinor(Number(custom[id]) || 0, currency));
  const others = sharers.reduce((s, id) => s + shareOf(id), 0);
  const pickCurrency = (c: string) => { setCurrency(c); setCountry(c === 'INR' ? 'IN' : c === 'SAR' ? 'SA' : 'other'); };
  const save = async () => {
    const shares = sharers.map(id => { const p = people.find(x => x.id === id)!; return { [p.kind === 'member' ? 'member_id' : 'contact_id']: id, share_minor: shareOf(id) }; });
    await add.mutateAsync({ name, kind, amount_minor: total, currency, cycle_months: cycle, next_due: due, country: country === 'other' ? '' : country, shares });
    toast(`${name} added`); setName(''); setAmount(''); setSharers([]); setCustom({}); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="New commitment" detent="large">
      <div className="stack">
        <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={pickCurrency} />
        <Field label="What"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Rent, DEWA, Amma…" /></Field>
        <div className="chips" style={{ flexWrap: 'wrap' }}>{GROUPS.map(([k, l]) => <Chip key={k} on={kind === k} onClick={() => setKind(k)}>{l}</Chip>)}</div>
        <div className="chips" style={{ flexWrap: 'wrap' }}>{CYCLES.map(c => <Chip key={c.v} on={cycle === c.v} onClick={() => setCycle(c.v)}>{c.l}</Chip>)}</div>
        <Field label="Next due"><input className="input" type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
        <Segmented label="Country" value={country} onChange={setCountry} options={[{ value: 'SA', label: 'Saudi' }, { value: 'IN', label: 'India' }, { value: 'other', label: 'Other' }]} />
        <div className="stack-sm">
          <div className="between" style={{ margin: '0 4px' }}><b>Shared with</b>{sharers.length > 0 && <span className="caption">yours {fmt({ minor: total - others, currency })}</span>}</div>
          {sharers.length > 0 && <Segmented label="Split" value={equal} onChange={setEqual} options={[{ value: 'equal', label: 'Equal split' }, { value: 'custom', label: 'Custom amounts' }]} />}
          <List>
            {people.map(p => {
              const on = sharers.includes(p.id);
              return (
                <div key={p.id} className="list-row">
                  <button type="button" className="row-flex" style={{ flex: 1, minWidth: 0, background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left', minHeight: 44 }}
                    aria-pressed={on} onClick={() => setSharers(on ? sharers.filter(x => x !== p.id) : [...sharers, p.id])}>
                    <Avatar name={p.name} size={32} /><span style={{ flex: 1, minWidth: 0 }}>{p.name}<br /><span className="caption">{p.kind === 'member' ? p.relation : 'friend'}</span></span>
                    {on && equal === 'equal' && <span className="num caption">{fmt({ minor: each, currency })}</span>}
                    {on ? <Icon name="check" size={22} className="pos" /> : <Icon name="plus" size={20} className="muted" />}
                  </button>
                  {on && equal === 'custom' && <input className="input" inputMode="decimal" aria-label={`${p.name}’s share`} style={{ width: 96, flex: 'none' }} placeholder="0"
                    value={custom[p.id] || ''} onChange={e => setCustom({ ...custom, [p.id]: e.target.value.replace(/[^\d.]/g, '') })} />}
                </div>
              );
            })}
          </List>
          {!people.length && <p className="caption" style={{ marginLeft: 4 }}>Add family or friends in People to share a bill.</p>}
        </div>
        <button className="btn block" disabled={!name || !Number(amount) || others > total || add.isPending} onClick={save}>Add</button>
        {others > total && <p className="error" role="alert">Shares add up to more than the bill.</p>}
        {add.error && <p className="error" role="alert">{add.error.message}</p>}
        {cycle > 1 && <p className="footnote" style={{ textAlign: 'center' }}>We’ll make a fund and suggest a monthly set-aside.</p>}
      </div>
    </Sheet>
  );
}

function Funds() {
  const q = useApi<{ items: Fund[] }>('/funds');
  const [open, setOpen] = useState<Fund | null>(null);
  const [amt, setAmt] = useState('');
  const move = useWrite<{ id: string; amount_minor: number }>('POST', b => `/funds/${b.id}/move`);
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  return (
    <Section title="Funds" action={<button onClick={() => setCreating(true)}>Add</button>}>
      <NewFundSheet open={creating} onClose={() => setCreating(false)} />
      {!q.data ? <PageSkeleton /> : !q.data.items.length ? <p className="caption" style={{ marginLeft: 4 }}>Funds appear for anything due every few months (rent, school fees), or tap Add to save toward a goal.</p> : (
        <List>
          {q.data.items.map(f => {
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

function NewFundSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
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
        <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={setCurrency} label="Target" />
        <Field label="Saving for"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Emergency, car service, Onam trip…" /></Field>
        <Field label="Needed by"><input className="input" type="date" min={today()} value={due} onChange={e => setDue(e.target.value)} /></Field>
        <button className="btn block" disabled={!name.trim() || !Number(amount) || !due || add.isPending} onClick={save}>Start fund</button>
        {add.error && <p className="error" role="alert">{add.error.message}</p>}
        <p className="footnote" style={{ textAlign: 'center' }}>We work out how much to set aside each month to get there on time.</p>
      </div>
    </Sheet>
  );
}

function Debts() {
  const q = useApi<{ items: Liability[] }>('/liabilities');
  const [open, setOpen] = useState<Liability | 'new' | null>(null);
  return (
    <Section title="What you owe" action={<button onClick={() => setOpen('new')}>Add</button>}>
      <div id="debts" style={{ scrollMarginTop: 80 }} />
      {!q.data ? <PageSkeleton /> : !q.data.items.length ? <div className="glass card caption"><Icon name="check" size={14} className="pos" /> No loans or card debt tracked. Card and BNPL balances appear from your SMS.</div> : (
        <List>
          {q.data.items.map(l => (
            <button key={l.id} type="button" className="list-row" onClick={() => setOpen(l)} aria-label={`${l.name}, edit`}
              style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingTop: 14, paddingBottom: 14, width: '100%', textAlign: 'left', opacity: l.closed ? .55 : 1 }}>
              <div className="between">
                <span className="row-flex" style={{ minWidth: 0 }}><Tile icon={LOAN_ICON[l.kind] || 'bank'} color={l.rate_bp > 1500 ? '#ff453a' : '#5e5ce6'} />
                  <span style={{ minWidth: 0 }}><b>{l.name}</b><br /><span className="caption">{[l.lender, `${(l.rate_bp / 100).toFixed(2)}%`, l.closed && 'closed'].filter(Boolean).join(' · ')}</span></span></span>
                <span style={{ textAlign: 'right' }}><b className="num"><Money m={l.outstanding} compact /></b><br /><span className="caption"><Money m={l.emi} compact />/mo</span></span>
              </div>
              <Meter pct={l.paid_pct ?? 0} color={l.rate_bp > 1500 ? 'var(--red-fill)' : undefined} />
              <div className="between caption"><span>{l.paid_pct ?? 0}% paid · interest <Money m={l.interest_month} />/mo</span><span>Done {l.payoff_month ? monthLabel(l.payoff_month, true) : '—'}</span></div>
            </button>
          ))}
        </List>
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
    setF(l ? { kind: l.kind, name: l.name, lender: l.lender || '', currency: l.currency, principal: major(l.principal), opening: major(l.opening_balance), as_of: l.as_of || '',
      rate: l.rate_bp ? String(l.rate_bp / 100) : '', emi: major(l.emi), start_on: l.start_on || '', end_on: l.end_on || '', match_pattern: l.match_pattern || '' }
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
      match_pattern: f.match_pattern || '' };
    if (l) await edit.mutateAsync(body); else await add.mutateAsync(body);
    toast(l ? `${body.name} saved` : `${body.name} added`); onClose();
  };
  const busy = add.isPending || edit.isPending || del.isPending;
  const err = add.error || edit.error || del.error;
  const badRate = !!f.rate && !(Number(f.rate) >= 0 && Number(f.rate) <= 1000);
  return (
    <Sheet open={!!loan} onClose={onClose} title={l ? l.name : 'Add a loan'} detent="large">
      {loan && (
        <div className="stack">
          <Segmented label="Kind" value={(f.kind || 'loan') as Liability['kind']} onChange={set('kind')} options={LOAN_KINDS} />
          <Field label="Name"><input className="input" {...input('name')} placeholder={f.kind === 'person' ? 'Loan from Harish' : 'Camry auto finance'} /></Field>
          <Field label={f.kind === 'person' ? 'Who lent it' : 'Lender'}><input className="input" {...input('lender')} placeholder={f.kind === 'person' ? 'Harish' : 'Al Rajhi Bank'} /></Field>
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
          <Field label="Match bank SMS containing"><input className="input" {...input('match_pattern')} placeholder="e.g. AUTO LOAN 3302" /></Field>
          <button className="btn block" disabled={!f.name?.trim() || badRate || busy} onClick={save}>{l ? 'Save' : 'Add loan'}</button>
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
