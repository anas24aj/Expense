import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useApi, useWrite } from '../api/client';
import type { Account, Category, Claim, HouseholdFull, Person, Purpose, ReviewTxn, Txn, TxnDetail } from '../api/types';
import { dayLabel, fmt, monthLabel, shiftMonth, shortDate, thisMonth, today, toMinor } from '../lib/format';
import {
  AmountInput, Avatar, CategoryTile, Chip, EmptyState, ErrorCard, Field, Icon, List, ListRow, Money, Page, PageSkeleton, Segmented, Sheet, Skeleton, Toggle, useToast,
} from '../ui';

export const PURPOSES: { value: Purpose; label: string }[] = [
  { value: 'spend', label: 'Spending' }, { value: 'fee', label: 'Fees & interest' }, { value: 'transfer', label: 'Transfer' }, { value: 'income', label: 'Income' },
  { value: 'support', label: 'Family support' }, { value: 'lend', label: 'Lent' }, { value: 'repaid', label: 'Paid back to me' }, { value: 'borrow', label: 'Borrowed' },
  { value: 'repay', label: 'I paid back' }, { value: 'loan_payment', label: 'Loan EMI' }, { value: 'claim', label: 'Company claim' },
  { value: 'reimbursement', label: 'Reimbursement' }, { value: 'refund', label: 'Refund' }, { value: 'ignore', label: 'Ignored' }, { value: 'asset', label: 'Property / vehicle' }, { value: 'saving', label: 'Saving / investing' },
];
const purposeLabel = (p: string) => PURPOSES.find(x => x.value === p)?.label || p;

export function TxnRow({ t, onOpen }: { t: Txn; onOpen: (t: Txn) => void }) {
  const credit = t.direction === 'credit';
  const sub = [t.account_name, t.purpose !== 'spend' ? purposeLabel(t.purpose) : t.category, t.person?.name && `· ${t.person.name}`].filter(Boolean).join(' · ').replace('· ·', '·');
  return (
    <ListRow icon={<CategoryTile category={t.category} purpose={t.purpose === 'spend' ? undefined : t.purpose} merchant={t.merchant} />} title={t.merchant} sub={sub}
      end={<span className={credit ? 'pos' : ''}>{credit ? '+' : ''}{fmt(t.amount)}</span>}
      endSub={t.split_mine ? <>yours <Money m={t.split_mine} /></> : t.confidence < 0.7 ? <span className="badge orange">Check</span> : t.claim_id ? <span className="badge blue">Claim</span> : undefined}
      onClick={() => onOpen(t)} chevron={false} label={`${t.merchant}, ${fmt(t.amount)}`} />
  );
}

type Filters = { account_id?: string; category?: string; purpose?: string; member_id?: string; review?: boolean };
type FilterKey = 'account_id' | 'category' | 'purpose' | 'member_id';

export default function ActivityPage() {
  const [month, setMonth] = useState(thisMonth());
  const [q, setQ] = useState('');
  const [params] = useSearchParams();
  const [f, setF] = useState<Filters>(() => ({ account_id: params.get('account_id') || undefined, category: params.get('category') || undefined }));
  const [picking, setPicking] = useState<FilterKey | null>(null);
  const [open, setOpen] = useState<Txn | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useApi<{ items: Txn[] }>('/transactions', { month, q, ...f, review: f.review ? 1 : undefined });
  const accounts = useApi<{ items: Account[] }>('/accounts');
  const cats = useApi<{ items: Category[] }>('/categories');
  const hh = useApi<HouseholdFull>('/households/current');
  const nav = useNavigate();

  const groups = useMemo(() => {
    const g = new Map<string, Txn[]>();
    for (const t of list.data?.items || []) g.set(t.day, [...(g.get(t.day) || []), t]);
    return [...g.entries()];
  }, [list.data]);

  const options: Record<FilterKey, { label: string; items: { value: string; label: string }[] }> = {
    account_id: { label: 'Account', items: (accounts.data?.items || []).map(a => ({ value: a.id, label: `${a.institution} · ${a.name}` })) },
    category: { label: 'Category', items: (cats.data?.items || []).filter(c => c.kind !== 'excluded').map(c => ({ value: c.name, label: c.name })) },
    purpose: { label: 'Purpose', items: PURPOSES },
    member_id: { label: 'Member', items: (hh.data?.members || []).map(m => ({ value: m.id, label: m.display_name })) },
  };
  const chipLabel = (k: FilterKey) => (f[k] ? options[k].items.find(i => i.value === f[k])?.label || f[k] : options[k].label);

  return (
    <Page title="Activity" trail={<>
      <button className="icon-btn" onClick={() => nav('/activity/review')} aria-label="Review"><Icon name="sparkle" /></button>
      <button className="icon-btn" onClick={() => setAdding(true)} aria-label="Add a transaction"><Icon name="plus" /></button>
    </>}>
      <div className="between">
        <div className="month-switch" role="group" aria-label="Month">
          <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="chevL" /></button>
          <strong aria-live="polite">{monthLabel(month, true)}</strong>
          <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth()} aria-label="Next month" style={{ opacity: month >= thisMonth() ? .3 : 1 }}><Icon name="chevR" /></button>
        </div>
        {list.data && <span className="caption">{list.data.items.length} items</span>}
      </div>
      <div className="search">
        <Icon name="search" />
        <input className="input" type="search" placeholder="Search merchants, categories" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
      </div>
      <div className="chips" role="toolbar" aria-label="Filters">
        <Chip on={f.review} onClick={() => setF({ ...f, review: !f.review })} icon="sparkle">To check</Chip>
        {(Object.keys(options) as FilterKey[]).map(k => (
          <Chip key={k} on={!!f[k]} onClick={() => (f[k] ? setF({ ...f, [k]: undefined }) : setPicking(k))}>
            {chipLabel(k)}{f[k] ? <Icon name="close" /> : <Icon name="chevD" />}
          </Chip>
        ))}
      </div>

      {list.isLoading ? <div className="glass list" style={{ padding: 16 }}><div className="stack">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} h={40} />)}</div></div>
        : list.error ? <ErrorCard error={list.error} retry={list.refetch} />
        : !groups.length ? <EmptyState icon="search" title="Nothing here" text={q || Object.values(f).some(Boolean) ? 'Try clearing the filters.' : 'Transactions arrive from your phone’s bank SMS.'} />
        : groups.map(([day, items]) => {
          const out = items.filter(t => t.direction === 'debit' && ['spend', 'fee', 'support'].includes(t.purpose)).reduce((s, t) => s + (t.split_mine || t.amount).minor * (t.amount.currency === 'INR' ? 0 : 1), 0);
          return (
            <section key={day} aria-label={dayLabel(day)}>
              <h2 className="day-head"><span>{dayLabel(day)}</span>{out > 0 && <span className="num">{fmt({ minor: out, currency: 'SAR' })}</span>}</h2>
              <List>{items.map(t => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</List>
            </section>
          );
        })}

      <Sheet open={!!picking} onClose={() => setPicking(null)} title={picking ? options[picking].label : ''} detent="medium">
        {picking && (
          <List>{options[picking].items.map(o => <ListRow key={o.value} title={o.label} onClick={() => { setF({ ...f, [picking]: o.value }); setPicking(null); }} chevron={false} />)}</List>
        )}
      </Sheet>
      <TxnSheet txn={open} onClose={() => setOpen(null)} />
      <AddTxnSheet open={adding} onClose={() => setAdding(false)} accounts={accounts.data?.items || []} />
    </Page>
  );
}

/* ---------- transaction detail with one-tap actions ---------- */
type Mode = null | 'category' | 'person' | 'split' | 'claim' | 'note';
export function TxnSheet({ txn, onClose }: { txn: Txn | null; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>(null);
  const [all, setAll] = useState(false);
  const detail = useApi<TxnDetail>(txn ? `/transactions/${txn.id}` : null);
  const t = detail.data || (txn as TxnDetail | null);
  const toast = useToast();
  const patch = useWrite<Record<string, unknown>, Txn>('PATCH', () => `/transactions/${txn!.id}`);
  const close = () => { setMode(null); setAll(false); onClose(); };
  const apply = async (body: Record<string, unknown>, msg: string, undo?: Record<string, unknown>) => {
    await patch.mutateAsync({ ...body, apply_to_merchant: all || undefined });
    toast(all ? `${msg} — and all ${t!.merchant}` : msg, undo ? () => patch.mutate(undo) : undefined);
    close();
  };
  if (!t) return null;
  const actions: { k: string; icon: string; label: string; on?: boolean; run: () => void }[] = [
    { k: 'split', icon: 'split', label: 'Split', on: !!t.split_mine, run: () => setMode('split') },
    { k: 'person', icon: 'person', label: 'For someone', on: !!t.person, run: () => setMode('person') },
    { k: 'claim', icon: 'briefcase', label: 'Claim', on: t.purpose === 'claim', run: () => setMode('claim') },
    { k: 'transfer', icon: 'transfer', label: 'Transfer', on: t.purpose === 'transfer', run: () => apply({ purpose: 'transfer' }, 'Marked as a transfer — not spending', { purpose: t.purpose }) },
    { k: 'category', icon: 'tag', label: 'Category', run: () => setMode('category') },
    { k: 'ignore', icon: 'eyeOff', label: 'Ignore', on: t.purpose === 'ignore', run: () => apply({ purpose: 'ignore' }, 'Ignored — left out of totals', { purpose: t.purpose }) },
    { k: 'note', icon: 'note', label: 'Note', on: !!t.note, run: () => setMode('note') },
    { k: 'spend', icon: 'cart', label: 'Spending', on: t.purpose === 'spend', run: () => apply({ purpose: 'spend' }, 'Counted as spending', { purpose: t.purpose }) },
  ];
  const titles: Record<string, string> = { category: 'Category', person: 'Who was it for?', split: 'Split with', claim: 'Add to claim', note: 'Note' };
  return (
    <Sheet open={!!txn} onClose={close} title={mode ? titles[mode] : undefined} detent={mode ? 'medium' : 'auto'}
      lead={mode && <button className="link-btn" onClick={() => setMode(null)}><Icon name="chevL" size={16} /> Back</button>}>
      {mode === 'category' ? <CategoryPicker onPick={c => apply({ category: c, purpose: t.purpose === 'transfer' ? 'spend' : undefined }, `Moved to ${c}`, { category: t.category })} />
        : mode === 'person' ? <PersonPicker onPick={p => apply({ person: { kind: p.kind, id: p.id }, purpose: p.kind === 'member' ? 'support' : 'lend' }, p.kind === 'member' ? `Counted as support for ${p.name}` : `${p.name} owes you this`)} />
        : mode === 'split' ? <SplitPicker t={t} onDone={close} />
        : mode === 'claim' ? <ClaimPicker t={t} onDone={close} />
        : mode === 'note' ? <NoteEditor initial={t.note || ''} onSave={note => apply({ note }, 'Note saved')} />
        : (
          <div className="stack">
            <div style={{ textAlign: 'center', padding: '4px 0 6px' }}>
              <div style={{ display: 'grid', placeItems: 'center', marginBottom: 10 }}><CategoryTile category={t.category} purpose={t.purpose === 'spend' ? undefined : t.purpose} merchant={t.merchant} /></div>
              <div style={{ font: '700 40px var(--font-display)', letterSpacing: '-.03em' }} className={`num ${t.direction === 'credit' ? 'pos' : ''}`}>{t.direction === 'credit' ? '+' : ''}{fmt(t.amount, { cents: true })}</div>
              <div style={{ fontWeight: 600, fontSize: 18 }}>{t.merchant}</div>
              <div className="caption">{shortDate(t.day)} · {t.account_name || 'No account'}</div>
              <div className="chips" style={{ justifyContent: 'center', marginTop: 8 }}>
                <span className="badge blue">{purposeLabel(t.purpose)}</span>{t.category && <span className="badge">{t.category}</span>}
                {t.split_mine && <span className="badge green">Yours: {fmt(t.split_mine)}</span>}
              </div>
            </div>
            <div className="actions-grid" role="group" aria-label="Actions">
              {actions.map(a => <button key={a.k} type="button" className={`action ${a.on ? 'on' : ''}`} onClick={a.run} aria-pressed={!!a.on}><Icon name={a.icon} />{a.label}</button>)}
            </div>
            <List><Toggle label={`Apply to all from ${t.merchant}`} sub="Future ones too — we’ll remember" checked={all} onChange={setAll} /></List>
            {t.note && <div className="glass card caption"><Icon name="note" size={14} /> {t.note}</div>}
            {detail.data?.raw && (
              <details className="caption">
                <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Original message from {detail.data.raw.sender}</summary>
                <p className="code">{detail.data.raw.body}</p>
              </details>
            )}
          </div>
        )}
    </Sheet>
  );
}

function CategoryPicker({ onPick }: { onPick: (name: string) => void }) {
  const cats = useApi<{ items: Category[] }>('/categories');
  if (!cats.data) return <PageSkeleton />;
  return <List>{cats.data.items.filter(c => c.kind === 'spend').map(c => <ListRow key={c.id} icon={<CategoryTile category={c.name} />} title={c.name} onClick={() => onPick(c.name)} chevron={false} />)}</List>;
}
function usePeople() { return (useApi<{ items: Person[] }>('/people').data?.items || []).filter(p => p.relation !== 'self'); }
function PersonPicker({ onPick }: { onPick: (p: Person) => void }) {
  const people = usePeople();
  return (
    <div className="stack">
      {(['member', 'contact'] as const).map(kind => (
        <div key={kind} className="stack-sm">
          <div className="caption" style={{ marginLeft: 4 }}>{kind === 'member' ? 'Family — counts as support' : 'Friends — they owe you'}</div>
          <List>{people.filter(p => p.kind === kind).map(p => <ListRow key={p.id} icon={<Avatar name={p.name} />} title={p.name} sub={p.relation} onClick={() => onPick(p)} chevron={false} />)}</List>
        </div>
      ))}
    </div>
  );
}
function SplitPicker({ t, onDone }: { t: Txn; onDone: () => void }) {
  const people = usePeople();
  const [picked, setPicked] = useState<string[]>(t.person ? [t.person.id] : []);
  const toast = useToast();
  const split = useWrite<{ shares: Record<string, unknown>[] }>('POST', `/transactions/${t.id}/split`);
  const each = Math.floor(t.amount.minor / (picked.length + 1));
  const save = async () => {
    await split.mutateAsync({ shares: picked.map(id => { const p = people.find(x => x.id === id)!; return { [p.kind === 'member' ? 'member_id' : 'contact_id']: id, share_minor: each }; }) });
    toast(`Split ${picked.length + 1} ways — yours ${fmt({ minor: t.amount.minor - each * picked.length, currency: t.amount.currency })}`);
    onDone();
  };
  return (
    <div className="stack">
      <List>
        {people.map(p => (
          <ListRow key={p.id} icon={<Avatar name={p.name} />} title={p.name} sub={p.relation}
            end={picked.includes(p.id) ? <Icon name="check" size={22} className="pos" /> : undefined}
            onClick={() => setPicked(picked.includes(p.id) ? picked.filter(x => x !== p.id) : [...picked, p.id])} chevron={false} />
        ))}
      </List>
      <p className="caption" style={{ textAlign: 'center' }}>{picked.length ? <>Equal split · each pays <b>{fmt({ minor: each, currency: t.amount.currency })}</b></> : 'Pick who shared it'}</p>
      <button className="btn block" disabled={!picked.length || split.isPending} onClick={save}>Split</button>
    </div>
  );
}
function ClaimPicker({ t, onDone }: { t: Txn; onDone: () => void }) {
  const claims = useApi<{ items: Claim[] }>('/claims');
  const toast = useToast();
  const add = useWrite<{ id: string }>('POST', b => `/claims/${b.id}/items`);
  const [name, setName] = useState('');
  const put = async (id: string, label: string) => { await add.mutateAsync({ id, txn_ids: [t.id] } as never); toast(`Added to “${label}” — not your spending`); onDone(); };
  const create = async () => { const c = await api<Claim>('/claims', { method: 'POST', body: { name: name || `${t.merchant} — ${monthLabel(t.day.slice(0, 7))}` } }); await put(c.id, c.name); };
  const open = (claims.data?.items || []).filter(c => c.status === 'draft' || c.status === 'submitted');
  return (
    <div className="stack">
      {open.length > 0 && <List>{open.map(c => <ListRow key={c.id} icon={<CategoryTile category={null} purpose="claim" />} title={c.name} sub={`${c.items.length} item${c.items.length === 1 ? "" : "s"} · ${c.status}`} end={<Money m={c.expected} />} onClick={() => put(c.id, c.name)} chevron={false} />)}</List>}
      <Field label="Or start a new claim"><input className="input" placeholder={`${t.merchant} — ${monthLabel(t.day.slice(0, 7))}`} value={name} onChange={e => setName(e.target.value)} /></Field>
      <button className="btn block secondary" onClick={create} disabled={add.isPending}><Icon name="plus" />New claim</button>
    </div>
  );
}
function NoteEditor({ initial, onSave }: { initial: string; onSave: (n: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="stack">
      <textarea className="input" value={v} onChange={e => setV(e.target.value)} aria-label="Note" autoFocus placeholder="What was this?" />
      <button className="btn block" onClick={() => onSave(v)}>Save note</button>
    </div>
  );
}

/* ---------- manual add: amount first, everything else guessed ---------- */
function AddTxnSheet({ open, onClose, accounts }: { open: boolean; onClose: () => void; accounts: Account[] }) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [merchant, setMerchant] = useState('');
  const [dir, setDir] = useState<'debit' | 'credit'>('debit');
  const [account, setAccount] = useState('');
  const toast = useToast();
  const save = useWrite('POST', '/transactions');
  const submit = async () => {
    await save.mutateAsync({ day: today(), amount_minor: toMinor(Number(amount), currency), currency, direction: dir, merchant: merchant || (dir === 'debit' ? 'Cash' : 'Money in'), account_id: account || undefined });
    toast('Added'); setAmount(''); setMerchant(''); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add" detent="auto">
      <div className="stack">
        <Segmented label="Direction" value={dir} onChange={setDir} options={[{ value: 'debit', label: 'Money out' }, { value: 'credit', label: 'Money in' }]} />
        <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={setCurrency} autoFocus />
        <Field label="Where"><input className="input" value={merchant} onChange={e => setMerchant(e.target.value)} placeholder="e.g. Panda, taxi, cash to Amma" /></Field>
        <Field label="Paid from">
          <select className="input" value={account} onChange={e => setAccount(e.target.value)}>
            <option value="">Cash / not sure</option>
            {accounts.filter(a => a.currency === currency && a.kind !== 'loan').map(a => <option key={a.id} value={a.id}>{a.institution} · {a.name}</option>)}
          </select>
        </Field>
        <button className="btn block" disabled={!Number(amount) || save.isPending} onClick={submit}>Add</button>
        <p className="footnote" style={{ textAlign: 'center' }}>We’ll guess the category — tap it later to change.</p>
      </div>
    </Sheet>
  );
}

/* ---------- Review: one card at a time, one tap per answer, swipe to skip ---------- */
export function ReviewPage() {
  const q = useApi<{ items: ReviewTxn[]; count: number }>('/review');
  const [done, setDone] = useState<string[]>([]);
  const [dx, setDx] = useState(0);
  const [more, setMore] = useState<Txn | null>(null);
  const start = useRef<number | null>(null);
  const toast = useToast();
  const items = (q.data?.items || []).filter(t => !done.includes(t.id));
  const t = items[0];
  const skip = () => { setDone(d => [...d, t.id]); setDx(0); };
  const answer = async (s: ReviewTxn['suggestions'][number]) => {
    setDone(d => [...d, t.id]);
    await api(`/transactions/${t.id}`, { method: 'PATCH', body: { purpose: s.purpose, category: s.category ?? undefined, person: s.person ? { kind: s.person.kind, id: s.person.id } : undefined } });
    toast(s.label);
  };
  return (
    <Page title="Review" back="/activity" subtitle={q.data ? (items.length ? `${items.length} left · swipe to skip` : 'All caught up') : ' '}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !t ? (
        <EmptyState icon="check" title="All caught up" text="Everything has a home. New ones show up here when we’re not sure." action={<button className="btn small" onClick={() => { setDone([]); q.refetch(); }}>Refresh</button>} />
      ) : (
        <div className="review-stage" style={{ maxWidth: 480, width: '100%', margin: '8px auto 0' }}>
          {items.slice(0, 3).reverse().map((x, ri, arr) => {
            const depth = arr.length - 1 - ri;
            const top = depth === 0;
            return (
              <article key={x.id} className={`glass glass-strong review-card ${depth === 1 ? 'back' : depth === 2 ? 'back2' : ''}`} aria-hidden={!top}
                style={top ? { transform: `translateX(${dx}px) rotate(${dx / 30}deg)`, transition: start.current !== null ? 'none' : undefined } : undefined}
                onPointerDown={top ? e => { if ((e.target as HTMLElement).closest('button')) return; start.current = e.clientX; } : undefined}
                onPointerMove={top ? e => { if (start.current !== null) setDx(e.clientX - start.current); } : undefined}
                onPointerUp={top ? () => { start.current = null; if (Math.abs(dx) > 110) skip(); else setDx(0); } : undefined}>
                <div className="between">
                  <CategoryTile category={x.category} merchant={x.merchant} />
                  <span className="caption">{dayLabel(x.day)} · {x.account_name}</span>
                </div>
                <div>
                  <div className="amt">{fmt(x.amount, { cents: true })}</div>
                  <div style={{ fontWeight: 600, fontSize: 19 }}>{x.merchant}</div>
                  <div className="caption">What was this?</div>
                </div>
                <div className="stack-sm" style={{ marginTop: 'auto' }}>
                  {x.suggestions.map((s, i) => (
                    <button key={i} className="suggest" onClick={() => answer(s)} tabIndex={top ? 0 : -1}>{s.label}<Icon name={i === 0 ? 'check' : 'chevR'} size={18} /></button>
                  ))}
                  <div className="between">
                    <button className="link-btn" onClick={() => setMore(x)} tabIndex={top ? 0 : -1}>Something else…</button>
                    <button className="link-btn" onClick={skip} tabIndex={top ? 0 : -1}>Skip</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <TxnSheet txn={more} onClose={() => { if (more) setDone(d => [...d, more.id]); setMore(null); }} />
    </Page>
  );
}
