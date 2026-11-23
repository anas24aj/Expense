import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, qs, useApi, useWrite } from '../api/client';
import type { Account, Asset, Category, Money as M, Claim, Fund, HouseholdFull, Liability, MerchantGroup, Person, Purpose, Txn, TxnDetail } from '../api/types';
import { dayLabel, fmt, monthLabel, shiftMonth, shortDate, sumByCurrency, thisMonth, today, toMinor } from '../lib/format';
import {
  AmountInput, Avatar, CategoryTile, Chip, EmptyState, ErrorCard, Field, Icon, List, ListRow, Money, Monies, Page, PageSkeleton, Segmented, Sheet, Skeleton, Toggle, useToast,
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

type FilterKey = 'account_id' | 'category' | 'purpose' | 'member_id';
const FILTER_KEYS: FilterKey[] = ['account_id', 'category', 'purpose', 'member_id'];
type TxnPage = { items: Txn[]; next_before: string | null; total?: number; days?: Record<string, M[]> };

export default function ActivityPage() {
  // month, search and filters live in the URL: they survive tab switches, back and reloads
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | undefined>) => setParams(p => {
    for (const [k, v] of Object.entries(patch)) if (v) p.set(k, v); else p.delete(k);
    return p;
  }, { replace: true });
  const month = params.get('month') || thisMonth();
  const q = params.get('q') || '';
  const review = params.get('review') === '1';
  const f = Object.fromEntries(FILTER_KEYS.map(k => [k, params.get(k) || undefined])) as Record<FilterKey, string | undefined>;
  const [text, setText] = useState(q);
  useEffect(() => { // debounced: one request per pause in typing, not per letter
    const t = setTimeout(() => { if (text.trim() !== q) set({ q: text.trim() || undefined }); }, 250);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picking, setPicking] = useState<FilterKey | null>(null);
  const [open, setOpen] = useState<Txn | null>(null);
  const [adding, setAdding] = useState(false);
  // a search covers every month; otherwise one month, paged 200 rows at a time as you scroll
  const filters = { ...(q ? { q } : { month }), ...f, review: review ? 1 : undefined };
  const list = useInfiniteQuery<TxnPage, ApiError>({
    queryKey: ['/transactions', { ...filters, paged: 1 }],
    queryFn: ({ pageParam }) => api<TxnPage>('/transactions' + qs({ ...filters, limit: 200, before: pageParam as string | undefined })),
    initialPageParam: undefined,
    getNextPageParam: p => p.next_before ?? undefined,
  });
  const accounts = useApi<{ items: Account[]; recent_ids?: string[] }>('/accounts');
  const cats = useApi<{ items: Category[] }>('/categories');
  const hh = useApi<HouseholdFull>('/households/current');
  const nav = useNavigate();
  const first = list.data?.pages[0];
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = more.current;
    if (!el || !list.hasNextPage) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !list.isFetchingNextPage) list.fetchNextPage(); }, { rootMargin: '1200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [list.hasNextPage, list.isFetchingNextPage, list.fetchNextPage, list.data]);

  const groups = useMemo(() => {
    const g = new Map<string, Txn[]>();
    for (const p of list.data?.pages || []) for (const t of p.items) g.set(t.day, [...(g.get(t.day) || []), t]);
    return [...g.entries()];
  }, [list.data]);
  const loaded = groups.reduce((n, [, xs]) => n + xs.length, 0);
  const count = first?.total ?? loaded;
  const year = thisMonth().slice(0, 4);

  const options: Record<FilterKey, { label: string; items: { value: string; label: string }[] }> = {
    account_id: { label: 'Account', items: (accounts.data?.items || []).map(a => ({ value: a.id, label: `${a.institution} · ${a.name}` })) },
    category: { label: 'Category', items: (cats.data?.items || []).filter(c => c.kind !== 'excluded').map(c => ({ value: c.name, label: c.name })) },
    purpose: { label: 'Purpose', items: PURPOSES },
    member_id: { label: 'Member', items: (hh.data?.members || []).map(m => ({ value: m.id, label: m.display_name })) },
  };
  const chipLabel = (k: FilterKey) => (f[k] ? options[k].items.find(i => i.value === f[k])?.label || f[k] : options[k].label);
  const setMonth = (m: string) => set({ month: m === thisMonth() ? undefined : m });

  return (
    <Page title="Activity" trail={<>
      <button className="icon-btn" onClick={() => nav(`/month/${month}`)} aria-label="Month overview by category"><Icon name="chart" /></button>
      <button className="icon-btn" onClick={() => nav('/activity/review')} aria-label="To sort"><Icon name="tag" /></button>
      <button className="icon-btn" onClick={() => setAdding(true)} aria-label="Add a transaction"><Icon name="plus" /></button>
    </>}>
      <div className="between">
        {q ? <strong style={{ padding: '6px 4px' }}>Searching all months</strong> : (
          <div className="month-switch" role="group" aria-label="Month">
            <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="chevL" /></button>
            <strong aria-live="polite">{monthLabel(month, true)}</strong>
            <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth()} aria-label="Next month" style={{ opacity: month >= thisMonth() ? .3 : 1 }}><Icon name="chevR" /></button>
          </div>
        )}
        {count > 0 && <span className="caption">{count}{first?.total === undefined && list.hasNextPage ? '+' : ''} {count === 1 ? 'item' : 'items'}</span>}
      </div>
      <div className="search">
        <Icon name="search" />
        <input className="input" type="search" placeholder="Search all months" value={text} onChange={e => setText(e.target.value)} aria-label="Search" />
      </div>
      <div className="chips" role="toolbar" aria-label="Filters">
        <Chip on={review} onClick={() => set({ review: review ? undefined : '1' })} icon="sparkle">To check</Chip>
        {FILTER_KEYS.map(k => (
          <Chip key={k} on={!!f[k]} onClick={() => (f[k] ? set({ [k]: undefined }) : setPicking(k))}>
            {chipLabel(k)}{f[k] ? <Icon name="close" /> : <Icon name="chevD" />}
          </Chip>
        ))}
      </div>

      {list.isLoading ? <div className="glass list" style={{ padding: 16 }}><div className="stack">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} h={40} />)}</div></div>
        : list.error ? <ErrorCard error={list.error} retry={list.refetch} />
        : !groups.length ? (q || review || Object.values(f).some(Boolean) ? <EmptyState icon="search" title="No matches" text="Try clearing the search or filters." />
          : <EmptyState icon="activity" title={`Nothing in ${monthLabel(month, true)}`} text="Every payment shows up here, tagged to the account it came from. Import a bank statement, or connect your phone so bank SMS arrive by themselves."
              action={<div className="row-flex" style={{ justifyContent: 'center' }}><Link to="/more/import" className="btn small">Import statement</Link><Link to="/more/devices" className="btn small secondary">Connect phone</Link></div>} />)
        : groups.map(([day, items]) => {
          // the server's per-day totals cover rows not paged in yet; summed here only when it sent none
          const out = first?.days ? first.days[day] || [] : sumByCurrency(items.filter(t => t.direction === 'debit' && ['spend', 'fee', 'support'].includes(t.purpose)).map(t => t.split_mine || t.amount));
          return (
            <section key={day} className="day-section" aria-label={dayLabel(day)}>
              <h2 className="day-head"><span>{dayLabel(day)}{day.slice(0, 4) !== year ? ` ${day.slice(0, 4)}` : ''}</span>{out.length > 0 && <span className="num"><Monies items={out} /></span>}</h2>
              <List>{items.map(t => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</List>
            </section>
          );
        })}
      {list.hasNextPage && <div ref={more} aria-busy={list.isFetchingNextPage}><Skeleton h={56} r={18} /></div>}

      <Sheet open={!!picking} onClose={() => setPicking(null)} title={picking ? options[picking].label : ''} detent="medium">
        {picking && (
          <List>{options[picking].items.map(o => <ListRow key={o.value} title={o.label} onClick={() => { set({ [picking]: o.value }); setPicking(null); }} chevron={false} />)}</List>
        )}
      </Sheet>
      <TxnSheet txn={open} onClose={() => setOpen(null)} />
      <AddTxnSheet open={adding} onClose={() => setAdding(false)} accounts={accounts.data?.items || []} recent={accounts.data?.recent_ids || []} />
    </Page>
  );
}

/* ---------- transaction detail with one-tap actions ---------- */
type Mode = null | 'category' | 'person' | 'split' | 'claim' | 'note' | 'loan' | 'asset' | 'pot' | 'link' | 'account' | 'trip';
type PersonDir = 'give' | 'repay' | 'repaid' | 'borrow';
// Which way money moved with a person: debits are "I paid for them" or "paying back"; credits "they paid me back" or "they lent me".
const PERSON_DIRS: Record<'debit' | 'credit', { value: PersonDir; label: string }[]> = {
  debit: [{ value: 'give', label: 'I paid for them / lent' }, { value: 'repay', label: 'Paying them back' }],
  credit: [{ value: 'repaid', label: 'They paid me back' }, { value: 'borrow', label: 'They lent / paid for me' }],
};
const personPurpose = (d: PersonDir, p: Person): Purpose => (d === 'give' ? (p.kind === 'member' ? 'support' : 'lend') : d);
const personToast = (purpose: Purpose, name: string) => ({
  support: `Counted as support for ${name}`, lend: `${name} owes you this`, repay: `Paid back to ${name}`, repaid: `${name} paid you back`, borrow: `You owe ${name} this`,
} as Record<string, string>)[purpose] || name;
export function TxnSheet({ txn, onClose }: { txn: Txn | null; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>(null);
  const [all, setAll] = useState(false);
  const detail = useApi<TxnDetail>(txn ? `/transactions/${txn.id}` : null);
  const assets = useApi<{ items: Asset[] }>(txn ? '/assets' : null);
  const pots = (useApi<{ items: Fund[] }>(txn ? '/funds' : null).data?.items || []).filter(f => f.pot && f.pot.rent.currency === txn?.amount.currency);
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
    ...(t.direction === 'debit' ? [{ k: 'loan', icon: 'bank', label: 'Loan payment', on: !!t.liability_id, run: () => setMode('loan') }] : []),
    ...(pots.length ? [{ k: 'pot', icon: 'house', label: t.direction === 'debit' ? 'Paid from pot' : 'Into pot', on: !!t.fund_id, run: () => setMode('pot') }] : []),
    ...(assets.data?.items.length ? [{ k: 'asset', icon: 'car', label: 'Vehicle / home', run: () => setMode('asset') }] : []),
    { k: 'link', icon: 'link', label: 'Link transfer', on: !!detail.data?.links.some(l => l.kind === 'transfer'), run: () => setMode('link') },
    { k: 'account', icon: 'bank', label: 'Account', run: () => setMode('account') },
    { k: 'trip', icon: 'plane', label: 'Trip', on: !!detail.data?.trips?.length, run: () => setMode('trip') },
  ];
  const titles: Record<string, string> = { category: 'Category', person: 'Who was it with?', split: 'Split with', claim: 'Add to claim', note: 'Note', loan: 'Which loan?', asset: 'Vehicle / home cost', pot: 'Shared pot',
    link: 'The other side of this transfer', account: 'Which account?', trip: 'Trip' };
  return (
    <Sheet open={!!txn} onClose={close} title={mode ? titles[mode] : undefined} detent={mode ? 'medium' : 'auto'}
      lead={mode && <button className="link-btn" onClick={() => setMode(null)}><Icon name="chevL" size={16} /> Back</button>}>
      {mode === 'category' ? <CategoryPicker onPick={c => apply({ category: c, purpose: t.purpose === 'transfer' ? 'spend' : undefined }, `Moved to ${c}`, { category: t.category })} />
        : mode === 'person' ? <PersonPicker direction={t.direction} onPick={(p, purpose) => apply({ person: { kind: p.kind, id: p.id }, purpose }, personToast(purpose, p.name))} />
        : mode === 'loan' ? <LoanPicker t={t} onPick={l => (l ? apply({ liability_id: l.id }, `Counted as a ${l.name} payment`, { liability_id: t.liability_id ?? null, purpose: t.purpose })
          : apply({ liability_id: null, purpose: 'spend' }, 'Unlinked from the loan'))} />
        : mode === 'pot' ? (
          <List>
            {pots.map(f => <ListRow key={f.id} icon={<Icon name="home" size={22} />} title={f.name} sub={`Shared with ${f.pot!.shares.map(x => x.name).join(', ') || 'no one'}`}
              end={t.fund_id === f.id ? <Icon name="check" size={22} className="pos" /> : undefined} chevron={false}
              onClick={() => apply({ fund_id: f.id }, t.direction === 'debit' ? `Paid from ${f.name}` : `Added to ${f.name}`, { fund_id: t.fund_id ?? null })} />)}
            {t.fund_id && <ListRow icon={<Icon name="close" size={22} />} title="Not from a pot" chevron={false} onClick={() => apply({ fund_id: null }, 'Taken out of the pot', { fund_id: t.fund_id })} />}
          </List>)
        : mode === 'link' && detail.data ? <LinkPicker t={detail.data} onDone={close} />
        : mode === 'account' ? <AccountPicker t={t} onPick={id => apply({ account_id: id }, id ? 'Account changed' : 'Marked as cash', { account_id: t.account_id })} />
        : mode === 'trip' && detail.data ? <TripPicker t={detail.data} onDone={close} />
        : mode === 'asset' ? <AssetCostPicker t={t} assets={assets.data?.items || []} onDone={close} />
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
function PersonPicker({ direction, onPick }: { direction: 'debit' | 'credit'; onPick: (p: Person, purpose: Purpose) => void }) {
  const people = usePeople();
  const [d, setD] = useState<PersonDir>(PERSON_DIRS[direction][0].value);
  const hint = d === 'give' ? ['Family — counts as support', 'Friends — they owe you'] : d === 'borrow' ? ['Family — you owe them', 'Friends — you owe them'] : ['Family', 'Friends'];
  return (
    <div className="stack">
      <Segmented label="Which way" value={d} onChange={setD} options={PERSON_DIRS[direction]} />
      {(['member', 'contact'] as const).map((kind, i) => (
        <div key={kind} className="stack-sm">
          <div className="caption" style={{ marginLeft: 4 }}>{hint[i]}</div>
          <List>{people.filter(p => p.kind === kind).map(p => <ListRow key={p.id} icon={<Avatar name={p.name} photo={p.photo} />} title={p.name} sub={p.relation} onClick={() => onPick(p, personPurpose(d, p))} chevron={false} />)}</List>
        </div>
      ))}
    </div>
  );
}
function LoanPicker({ t, onPick }: { t: Txn; onPick: (l: Liability | null) => void }) {
  const q = useApi<{ items: Liability[] }>('/liabilities');
  if (!q.data) return <PageSkeleton />;
  const open = q.data.items.filter(l => !l.closed || l.id === t.liability_id);
  return (
    <div className="stack">
      {open.length ? <List>{open.map(l => (
        <ListRow key={l.id} icon={<Icon name={l.kind === 'credit_card' ? 'card' : l.kind === 'bnpl' ? 'wallet' : l.kind === 'person' ? 'person' : 'bank'} size={22} />} title={l.name}
          sub={[l.lender, l.emi.minor ? `EMI ${fmt(l.emi)}` : ''].filter(Boolean).join(' · ') || undefined}
          end={l.id === t.liability_id ? <Icon name="check" size={22} className="pos" /> : <Money m={l.outstanding} compact />}
          onClick={() => onPick(l)} chevron={false} />
      ))}</List> : <EmptyState icon="bank" title="No loans yet" text="Add one in Plan, under What you owe." />}
      {t.liability_id && <button className="btn block danger" onClick={() => onPick(null)}>Unlink from loan</button>}
      <p className="footnote" style={{ textAlign: 'center' }}>For a catch-up or bounced EMI paid another way: it counts toward the loan.</p>
    </div>
  );
}
const COST_TYPES = ['fuel', 'service', 'insurance', 'emi', 'other'];
const HOME_COSTS = ['rent', 'electricity', 'internet', 'maid', 'groceries', 'furnishing'];

/** Pair this with the other leg of a transfer (money out of one own account, into another) that the matcher missed. */
function LinkPicker({ t, onDone }: { t: TxnDetail; onDone: () => void }) {
  const near = (d: number) => { const x = new Date(t.day + 'T00:00:00'); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
  const q = useApi<{ items: Txn[] }>('/transactions', { limit: 200, before: `${near(8)}_~` });
  const link = useWrite<{ to_txn_id: string; kind: string }>('POST', `/transactions/${t.id}/link`);
  const unlink = useWrite<{ id: string }>('DELETE', b => `/transactions/${t.id}/link/${b.id}`);
  const toast = useToast();
  const linked = t.links.find(l => l.kind === 'transfer');
  const from = near(-7);
  const other = (q.data?.items || []).filter(x => x.id !== t.id && x.direction !== t.direction && x.day >= from && x.account_id !== t.account_id);
  return (
    <div className="stack">
      {linked && <button className="btn block danger" disabled={unlink.isPending} onClick={async () => { await unlink.mutateAsync({ id: linked.id }); toast('Unlinked'); onDone(); }}>Unlink the current pair</button>}
      {q.isLoading ? <PageSkeleton /> : other.length ? (
        <List>{other.map(x => (
          <ListRow key={x.id} icon={<CategoryTile category={x.category} merchant={x.merchant} />} title={x.merchant} sub={`${shortDate(x.day)} · ${x.account_name || 'No account'}`}
            end={<span className={x.direction === 'credit' ? 'pos' : ''}><Money m={x.amount} /></span>} endSub={linked?.other_txn_id === x.id ? <span className="badge green">Linked</span> : undefined}
            onClick={async () => { if (link.isPending) return; await link.mutateAsync({ to_txn_id: x.id, kind: 'transfer' }); toast('Linked: neither side counts as spending'); onDone(); }} chevron={false} />
        ))}</List>
      ) : <EmptyState icon="transfer" title="Nothing to pair" text={`No money ${t.direction === 'debit' ? 'coming into' : 'going out of'} another account within a week of this.`} />}
      {link.error && <p className="error" role="alert">{link.error.message}</p>}
      <p className="footnote" style={{ textAlign: 'center' }}>Shows the other direction on your other accounts, a week either side. Amounts may differ across currencies.</p>
    </div>
  );
}

/** Move the transaction to the account it really came from (or to cash). */
function AccountPicker({ t, onPick }: { t: Txn; onPick: (id: string | null) => void }) {
  const q = useApi<{ items: Account[] }>('/accounts');
  if (!q.data) return <PageSkeleton />;
  return (
    <List>
      {q.data.items.map(a => <ListRow key={a.id} icon={<Icon name={a.kind === 'credit_card' || a.kind === 'debit_card' ? 'card' : a.kind === 'wallet' ? 'wallet' : 'bank'} size={22} />}
        title={`${a.institution || a.name}${a.last4 ? ' ··' + a.last4 : ''}`} sub={`${a.name} · ${a.currency}`}
        end={a.id === t.account_id ? <Icon name="check" size={22} className="pos" /> : undefined} onClick={() => a.id !== t.account_id && onPick(a.id)} chevron={false} />)}
      <ListRow icon={<Icon name="coin" size={22} />} title="Cash" sub="No bank account" end={!t.account_id ? <Icon name="check" size={22} className="pos" /> : undefined} onClick={() => t.account_id && onPick(null)} chevron={false} />
    </List>
  );
}

/** Put the transaction on a trip, or take it off one it counts on by its dates. */
function TripPicker({ t, onDone }: { t: TxnDetail; onDone: () => void }) {
  const q = useApi<{ items: { id: string; name: string; start_on: string; end_on: string; city: string }[] }>('/trips');
  const tag = useWrite<{ id: string; status: string }>('POST', b => `/trips/${b.id}/tag`);
  const toast = useToast();
  const on = new Map((t.trips || []).map(x => [x.id, x.status]));
  const run = async (id: string, status: string, msg: string) => { if (tag.isPending) return; await tag.mutateAsync({ id, status, txn_ids: [t.id] } as never); toast(msg); onDone(); };
  if (!q.data) return <PageSkeleton />;
  return (
    <div className="stack">
      {q.data.items.length ? <List>{q.data.items.map(x => (
        <ListRow key={x.id} icon={<Icon name="plane" size={22} />} title={x.name} sub={`${x.city ? x.city + ' · ' : ''}${shortDate(x.start_on)} – ${shortDate(x.end_on)}`}
          end={on.has(x.id) ? <span className="badge green">On it</span> : undefined}
          onClick={() => (on.has(x.id) ? run(x.id, 'excluded', `Taken off ${x.name}`) : run(x.id, 'unreviewed', `Added to ${x.name}`))} chevron={false} />
      ))}</List> : <EmptyState icon="plane" title="No trips yet" text="Add one under More › Trips." />}
      {tag.error && <p className="error" role="alert">{tag.error.message}</p>}
      <p className="footnote" style={{ textAlign: 'center' }}>Tap a trip to add this to it; tap one it’s on to take it off.</p>
    </div>
  );
}
const costLabel = (c: string) => (c === 'emi' ? 'EMI' : c[0].toUpperCase() + c.slice(1));
function AssetCostPicker({ t, assets, onDone }: { t: Txn; assets: Asset[]; onDone: () => void }) {
  const [type, setType] = useState('fuel');
  const types = assets.some(a => a.kind === 'home') ? [...COST_TYPES, ...HOME_COSTS] : COST_TYPES;
  const toast = useToast();
  const add = useWrite<{ id: string; txn_id: string; cost_type: string }>('POST', b => `/assets/${b.id}/costs`);
  const pick = async (a: Asset) => { await add.mutateAsync({ id: a.id, txn_id: t.id, cost_type: type }); toast(`Counted as ${a.name} ${costLabel(type).toLowerCase()}`); onDone(); };
  return (
    <div className="stack">
      <div className="chips" style={{ flexWrap: 'wrap' }} role="group" aria-label="Cost type">
        {types.map(c => <Chip key={c} on={type === c} onClick={() => setType(c)}>{costLabel(c)}</Chip>)}
      </div>
      <List>{assets.map(a => <ListRow key={a.id} icon={<Icon name={a.kind === 'vehicle' ? 'car' : a.kind === 'property' ? 'building' : a.kind === 'home' ? 'house' : 'chart'} size={22} />} title={a.name}
        sub={a.monthly_cost.minor ? <>≈ <Money m={a.monthly_cost} />/mo to run</> : a.kind} onClick={() => { if (!add.isPending) pick(a); }} chevron={false} />)}</List>
      <p className="footnote" style={{ textAlign: 'center' }}>Pick the type, then the vehicle or home. Costs split with anyone who shares them; mark it “For someone › They paid for me” if a friend paid it.</p>
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
          <ListRow key={p.id} icon={<Avatar name={p.name} photo={p.photo} />} title={p.name} sub={p.relation}
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
const SPEND_KINDS = ['bank', 'credit_card', 'debit_card', 'wallet'];
/** The account a new entry starts on (as the API picks it): the last one used in that currency, else a bank account or card. */
export function defaultAccount(accounts: Account[], recent: string[], currency: string) {
  const ok = accounts.filter(a => a.currency === currency && SPEND_KINDS.includes(a.kind));
  return recent.map(id => ok.find(a => a.id === id)).find(Boolean)
    || [...ok].sort((a, b) => SPEND_KINDS.indexOf(a.kind) - SPEND_KINDS.indexOf(b.kind))[0];
}

function AddTxnSheet({ open, onClose, accounts, recent }: { open: boolean; onClose: () => void; accounts: Account[]; recent: string[] }) {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [merchant, setMerchant] = useState('');
  const [dir, setDir] = useState<'debit' | 'credit'>('debit');
  const [picked, setAccount] = useState<string | null>(null);  // null: not chosen yet, '' : cash
  const account = picked ?? defaultAccount(accounts, recent, currency)?.id ?? '';
  const [day, setDay] = useState(today());
  const [who, setWho] = useState('');
  const [pd, setPd] = useState<PersonDir>('give');
  const people = usePeople();
  const person = people.find(p => p.id === who);
  const toast = useToast();
  const save = useWrite<Record<string, unknown>, Txn>('POST', '/transactions');
  const tag = useWrite<Record<string, unknown>>('PATCH', b => `/transactions/${b.id}`);
  const submit = async () => {
    const t = await save.mutateAsync({ day, amount_minor: toMinor(Number(amount), currency), currency, direction: dir,
      merchant: merchant || (person ? person.name : dir === 'debit' ? 'Cash' : 'Money in'), account_id: account || null });
    if (person) {  // an IOU: POST /transactions takes no person, so tag it straight after
      const purpose = personPurpose(pd, person);
      await tag.mutateAsync({ id: t.id, person: { kind: person.kind, id: person.id }, purpose });
      toast(personToast(purpose, person.name));
    } else toast('Added');
    setAmount(''); setMerchant(''); setWho(''); setDay(today()); setAccount(null); onClose();
  };
  const setDirection = (d: 'debit' | 'credit') => { setDir(d); setPd(PERSON_DIRS[d][0].value); };
  return (
    // Add sits in the header, where the keyboard can't cover it
    <Sheet open={open} onClose={onClose} title="Add" detent="auto" lead={<button className="link-btn" onClick={onClose}>Cancel</button>}
      trail={<button className="link-btn" style={{ fontWeight: 700 }} disabled={!Number(amount) || !day || save.isPending || tag.isPending} onClick={submit}>Add</button>}>
      <div className="stack">
        <Segmented label="Direction" value={dir} onChange={setDirection} options={[{ value: 'debit', label: 'Money out' }, { value: 'credit', label: 'Money in' }]} />
        <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={c => { setCurrency(c); setAccount(null); }} autoFocus />
        <Field label="Where"><input className="input" value={merchant} onChange={e => setMerchant(e.target.value)} placeholder="e.g. Panda, taxi, car EMI share" /></Field>
        <Field label={dir === 'debit' ? 'Paid from' : 'Paid into'}>
          <select className="input" value={account} onChange={e => setAccount(e.target.value)}>
            {accounts.filter(a => a.currency === currency && a.kind !== 'loan').map(a => <option key={a.id} value={a.id}>{a.institution} · {a.name}</option>)}
            <option value="">Cash (no account)</option>
          </select>
        </Field>
        <Field label="Date"><input className="input" type="date" value={day} max={today()} onChange={e => setDay(e.target.value)} /></Field>
        <Field label="With someone (optional)">
          <select className="input" value={who} onChange={e => setWho(e.target.value)}>
            <option value="">No one</option>
            {(['member', 'contact'] as const).map(k => (
              <optgroup key={k} label={k === 'member' ? 'Family' : 'Friends'}>{people.filter(p => p.kind === k).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
            ))}
          </select>
        </Field>
        {person && <Segmented label="Which way" value={pd} onChange={setPd} options={PERSON_DIRS[dir]} />}
        <p className="footnote" style={{ textAlign: 'center' }}>{person ? 'With no account it’s just an IOU between you, e.g. they paid your share of a bill.' : 'We’ll guess the category — tap it later to change.'}</p>
      </div>
    </Sheet>
  );
}

/* ---------- To sort: the review queue grouped by shop, one tap sorts every one of them ---------- */
const QUICK = ['Groceries', 'Food', 'Dining', 'Shopping', 'Transport', 'Fuel', 'Bills & Utilities', 'Health', 'Travel', 'Personal care', 'Education', 'Entertainment'];
type Answer = { label: string; category?: string; purpose?: Purpose };

export function ReviewPage() {
  const q = useApi<{ items: MerchantGroup[]; count: number }>('/review/merchants');
  const cats = useApi<{ items: Category[] }>('/categories');
  const [done, setDone] = useState<string[]>([]);
  const [shown, setShown] = useState(40);
  const [more, setMore] = useState<MerchantGroup | null>(null);
  const toast = useToast();
  const sort = useWrite<{ merchant: string; category?: string; purpose?: string }, { updated: number; left: number }>('POST', '/review/merchant');
  const names = new Set((cats.data?.items || []).filter(c => c.kind === 'spend').map(c => c.name));
  const quick = QUICK.filter(c => !cats.data || names.has(c));
  const groups = (q.data?.items || []).filter(g => !done.includes(g.merchant));
  const left = (q.data?.count || 0) - (q.data?.items || []).filter(g => done.includes(g.merchant)).reduce((n, g) => n + g.count, 0);
  const answer = (g: MerchantGroup, a: Answer) => {
    setDone(d => [...d, g.merchant]);
    sort.mutate({ merchant: g.merchant, category: a.category, purpose: a.purpose }, {
      onSuccess: r => toast(`${r.updated} × ${g.merchant} → ${a.label}`),
      onError: e => { setDone(d => d.filter(m => m !== g.merchant)); toast(`Not saved: ${e.message}`); },
    });
  };
  const answers = (g: MerchantGroup): Answer[] => g.direction === 'credit'
    ? [{ label: 'Income', category: 'Income', purpose: 'income' }, { label: 'Refund', purpose: 'refund' }, { label: 'My own transfer', purpose: 'transfer' }, { label: 'Ignore', purpose: 'ignore' }]
    : [...(g.category && g.category !== 'Uncategorized' ? [g.category] : []), ...quick.filter(c => c !== g.category).slice(0, 5)].map((c): Answer => ({ label: c, category: c, purpose: 'spend' }))
      .concat([{ label: 'My own transfer', purpose: 'transfer' }, { label: 'Ignore', purpose: 'ignore' }]);
  return (
    <Page title="To sort" back="/activity" subtitle={q.data ? (left > 0 ? `${left.toLocaleString()} payments from ${groups.length.toLocaleString()} shops. One tap sorts every payment from a shop, and the ones still to come.` : 'All sorted') : ' '}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !groups.length ? (
        <EmptyState icon="check" title="All sorted" text="New ones show up here when we’re not sure." action={<button className="btn small" onClick={() => { setDone([]); q.refetch(); }}>Refresh</button>} />
      ) : (
        <>
          {groups.slice(0, shown).map(g => (
            <article key={g.merchant || '(none)'} className="glass card stack-sm sort-card" aria-label={g.merchant || 'No shop name'}>
              <div className="row-flex">
                <CategoryTile category={g.category} merchant={g.merchant} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b className="ellipsis">{g.merchant || 'No shop name'}</b>
                  <div className="caption">{g.count} payment{g.count === 1 ? '' : 's'} · last {shortDate(g.last_day)} · {g.account_name}</div>
                </div>
                <span className="num" style={{ fontWeight: 600 }}><Monies items={g.totals} /></span>
              </div>
              {g.merchant ? (
                <div className="chips wrap" role="group" aria-label={`Sort ${g.merchant}`}>
                  {answers(g).map(a => <button key={a.label} type="button" className="chip" onClick={() => answer(g, a)}>{a.label}</button>)}
                  <button type="button" className="chip" onClick={() => setMore(g)}>More…<Icon name="chevD" /></button>
                </div>
              ) : <Link to="/activity?review=1" className="caption">Open them one by one in Activity</Link>}
            </article>
          ))}
          {groups.length > shown && <button className="btn block secondary" onClick={() => setShown(shown + 40)}>Show {Math.min(40, groups.length - shown)} more shops</button>}
        </>
      )}
      <Sheet open={!!more} onClose={() => setMore(null)} title={more ? `All ${more.count} from ${more.merchant}` : ''} detent="medium">
        {more && <CategoryPicker onPick={c => { answer(more, { label: c, category: c, purpose: 'spend' }); setMore(null); }} />}
      </Sheet>
    </Page>
  );
}
