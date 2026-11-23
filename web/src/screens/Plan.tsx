import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, useApi, useWrite } from '../api/client';
import type { Advice, Commitment, DetectedCommitment, Fund, Liability, Lookahead, WhatIf } from '../api/types';
import { fmt, monthLabel, shortDate, today, toMinor } from '../lib/format';
import {
  AmountInput, BarChart, Chip, ErrorCard, Field, Icon, List, ListRow, Meter, Money, Page, PageSkeleton, ProgressRing, Section, Segmented, Sheet, Tile, useToast,
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
  const add = useWrite('POST', '/commitments');
  const toast = useToast();
  const save = async () => {
    await add.mutateAsync({ name, kind, amount_minor: toMinor(Number(amount), currency), currency, cycle_months: cycle, next_due: due, country: currency === 'INR' ? 'IN' : 'SA' });
    toast(`${name} added`); setName(''); setAmount(''); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="New commitment" detent="large">
      <div className="stack">
        <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={setCurrency} />
        <Field label="What"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Rent, DEWA, Amma…" /></Field>
        <div className="chips" style={{ flexWrap: 'wrap' }}>{GROUPS.map(([k, l]) => <Chip key={k} on={kind === k} onClick={() => setKind(k)}>{l}</Chip>)}</div>
        <div className="chips" style={{ flexWrap: 'wrap' }}>{CYCLES.map(c => <Chip key={c.v} on={cycle === c.v} onClick={() => setCycle(c.v)}>{c.l}</Chip>)}</div>
        <Field label="Next due"><input className="input" type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
        <button className="btn block" disabled={!name || !Number(amount) || add.isPending} onClick={save}>Add</button>
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
  return (
    <Section title="Funds">
      {!q.data ? <PageSkeleton /> : !q.data.items.length ? <p className="caption" style={{ marginLeft: 4 }}>Funds appear for anything due every few months (rent, school fees) — add one under Commitments.</p> : (
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

function Debts() {
  const q = useApi<{ items: Liability[] }>('/liabilities');
  return (
    <Section title="What you owe">
      <div id="debts" style={{ scrollMarginTop: 80 }} />
      {!q.data ? <PageSkeleton /> : !q.data.items.length ? <div className="glass card caption"><Icon name="check" size={14} className="pos" /> No loans or card debt tracked. Card and BNPL balances appear from your SMS.</div> : (
        <List>
          {q.data.items.map(l => (
            <div key={l.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingTop: 14, paddingBottom: 14 }}>
              <div className="between">
                <span className="row-flex" style={{ minWidth: 0 }}><Tile icon={l.kind === 'card' ? 'card' : l.kind === 'bnpl' ? 'wallet' : 'bank'} color={l.rate_bp > 1500 ? '#ff453a' : '#5e5ce6'} />
                  <span style={{ minWidth: 0 }}><b>{l.name}</b><br /><span className="caption">{l.lender} · {(l.rate_bp / 100).toFixed(2)}%</span></span></span>
                <span style={{ textAlign: 'right' }}><b className="num"><Money m={l.outstanding} compact /></b><br /><span className="caption"><Money m={l.emi} compact />/mo</span></span>
              </div>
              <Meter pct={l.paid_pct} color={l.rate_bp > 1500 ? 'var(--red-fill)' : undefined} />
              <div className="between caption"><span>{l.paid_pct}% paid · interest <Money m={l.interest_month} />/mo</span><span>Done {l.payoff_month ? monthLabel(l.payoff_month, true) : '—'}</span></div>
            </div>
          ))}
        </List>
      )}
    </Section>
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
