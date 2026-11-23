import { Fragment, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, useApi, useWrite } from '../api/client';
import type { Account, Asset, Coverage, DeviceCreated, Device, HouseholdFull, Liability, Me, Milestone, Money as MoneyT, SalaryEntry, Settings, Statement, Txn } from '../api/types';
import { fmt, major, monthLabel, shortDate, thisMonth, toMinor, today } from '../lib/format';
import {
  AmountInput, Avatar, BrandTile, brandOf, CategoryTile, logoOf, Chip, EmptyState, ErrorCard, Field, Icon, List, ListRow, Meter, Money, Page, PageSkeleton, ProgressRing, Section, Segmented, Sheet, Tile, useToast,
} from '../ui';
import { copy, InviteSheet } from './People';
import { readFile } from './files';

export function MorePage({ me }: { me: Me }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const signOut = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); qc.clear(); nav('/signin', { replace: true }); };
  const rows: [string, string, string, string, string?][][] = [
    [['/more/accounts', 'Accounts & cards', 'bank', '#0a84ff', 'Balances and card limits'], ['/more/flows', 'Money flow', 'chart', '#bf5af2', 'Income → accounts → spending'], ['/more/trips', 'Trips', 'plane', '#32ade6', 'Business trips and what to claim']],
    [['/more/import', 'Import statements', 'upload', '#30b0c7', 'PDF, Excel or CSV'], ['/more/devices', 'Phones & Shortcut', 'phone', '#34c759', 'Send bank SMS automatically'], ['/more/claude', 'Connect Claude', 'sparkle', '#d97757', 'Ask questions about your money']],
    [['/more/household', 'Household & members', 'family', '#ff375f', me.household.name], ['/more/profile', 'Profile & password', 'person', '#8e8e93'], ['/more/settings', 'Settings', 'gear', '#636366', 'Salary, currencies, timezone']],
  ];
  return (
    <Page title="More">
      <div className="glass card row-flex">
        <Avatar name={me.user.name} size={56} />
        <div style={{ minWidth: 0 }}><b style={{ fontSize: 19 }}>{me.user.name}</b><p className="caption">{me.user.email} · {me.member.role}</p></div>
      </div>
      {rows.map((g, i) => <List key={i}>{g.map(([to, t, icon, color, sub]) => <ListRow key={to} to={to} icon={<Tile icon={icon} color={color} />} title={t} sub={sub} />)}</List>)}
      <List><button className="list-row" onClick={signOut} style={{ color: 'var(--red)', justifyContent: 'center', fontWeight: 600 }}>Sign out</button></List>
    </Page>
  );
}

/* ---------- Accounts ---------- */
export const KIND_LABEL: Record<string, string> = { bank: 'Bank accounts', wallet: 'Wallets', credit_card: 'Credit cards', debit_card: 'Debit cards', bnpl: 'Pay later', loan: 'Loans', cash: 'Cash', investment: 'Investments' };
export const KIND_TILE: Record<string, [string, string]> = { bank: ['bank', '#0a84ff'], wallet: ['wallet', '#5e5ce6'], credit_card: ['card', '#ff9f0a'], debit_card: ['card', '#30b0c7'], bnpl: ['wallet', '#bf5af2'], loan: ['bank', '#8e8e93'], cash: ['coin', '#34c759'], investment: ['chart', '#30d158'] };

const COUNTRIES = [{ code: 'SA', name: 'Saudi Arabia', flag: '🇸🇦' }, { code: 'IN', name: 'India', flag: '🇮🇳' }, { code: 'QA', name: 'Qatar', flag: '🇶🇦' },
  { code: 'AE', name: 'UAE', flag: '🇦🇪' }, { code: 'XX', name: 'Other', flag: '🌍' }];
const CUR_COUNTRY: Record<string, string> = { SAR: 'SA', INR: 'IN', QAR: 'QA', AED: 'AE' };
const countryOf = (a: Account) => { const c = (a.country || CUR_COUNTRY[a.currency] || 'XX').toUpperCase(); return COUNTRIES.some(x => x.code === c) ? c : 'XX'; };
const CASH = ['bank', 'wallet', 'cash', 'debit_card', 'investment'], DEBT = ['credit_card', 'bnpl', 'loan'];

// One card per country: what you hold there and what you owe there, in that country's currency. Tap to show only that country.
function CountryCards({ items, country, onPick }: { items: Account[]; country: string; onPick: (c: string) => void }) {
  const live = items.filter(a => !a.archived);
  const cards = COUNTRIES.map(c => {
    const here = live.filter(a => countryOf(a) === c.code);
    const cur = here[0]?.currency;
    const sum = (kinds: string[]) => here.filter(a => kinds.includes(a.kind) && a.balance?.currency === cur).reduce((s, a) => s + (a.balance?.minor || 0), 0);
    return { ...c, n: here.length, cur, held: sum(CASH), owed: -sum(DEBT) };
  }).filter(c => c.n);
  return (
    <div className="grid-2">
      {cards.map(c => (
        <button key={c.code} className={`glass card stat country-card${country === c.code ? ' on' : ''}`} onClick={() => onPick(c.code)} aria-pressed={country === c.code}>
          <span className="k">{c.flag} {c.name} · {c.n} account{c.n > 1 ? 's' : ''}</span>
          <span className="v"><Money m={{ minor: c.held, currency: c.cur! }} /></span>
          {c.owed > 0 && <span className="caption neg">owed <Money m={{ minor: c.owed, currency: c.cur! }} /></span>}
        </button>
      ))}
    </div>
  );
}

export function AccountsPage() {
  const q = useApi<{ items: Account[] }>('/accounts');
  const cov = useApi<{ items: Coverage[] }>('/accounts/coverage');
  const hh = useApi<HouseholdFull>('/households/current');
  const [adding, setAdding] = useState(false);
  const items = q.data?.items || [];
  const ownerName = (id: string | null) => hh.data?.members.find(m => m.id === id)?.display_name || '';
  const owners = new Set(items.map(a => a.owner_member_id));
  const covOf = (id: string) => cov.data?.items.find(c => c.account_id === id);
  const needs = (cov.data?.items || []).filter(c => c.status !== 'ok').length;
  const [country, setCountry] = useState<string>('all');
  return (
    <Page title="Accounts" back="/more" trail={<button className="icon-btn" onClick={() => setAdding(true)} aria-label="Add account"><Icon name="plus" /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !items.length ? (
        <EmptyState icon="bank" title="No accounts yet" text="Add each bank account, card, wallet and loan you use, in Saudi Arabia and India. Balances, card limits and missing statements show up here, grouped by country."
          action={<button className="btn small" onClick={() => setAdding(true)}><Icon name="plus" size={16} />Add account</button>} />
      ) : (
        <>
          <CountryCards items={items} country={country} onPick={c => setCountry(country === c ? 'all' : c)} />
          <Link to="/more/coverage" className="glass pill-cta">
            <Tile icon={needs ? 'warn' : 'check'} color={needs ? '#ff9f0a' : '#30d158'} />
            <span style={{ flex: 1 }}><b>Up to date?</b><br /><span className="caption">{cov.data ? (needs ? `${needs} account${needs > 1 ? 's' : ''} with gaps or gone quiet` : 'Every account covered, no gaps') : 'Checking statements and SMS…'}</span></span>
            <Icon name="chevR" className="chev" size={14} />
          </Link>
          {COUNTRIES.filter(c => country === 'all' || c.code === country).map(c => {
            const here = items.filter(a => countryOf(a) === c.code && !a.archived);
            if (!here.length) return null;
            return (<Fragment key={c.code}>{country === 'all' && <h2 className="country-h">{c.flag} {c.name}</h2>}
          {Object.keys(KIND_LABEL).map(kind => {
            const list = here.filter(a => a.kind === kind)
              .sort((x, y) => ownerName(x.owner_member_id).localeCompare(ownerName(y.owner_member_id)) || x.institution.localeCompare(y.institution));
            if (!list.length) return null;
            return (
              <Section key={kind} title={KIND_LABEL[kind]}>
                <List>
                  {list.map(a => (
                    <Link key={a.id} to={`/more/accounts/${a.id}`} className="list-row" style={a.credit_limit ? { flexWrap: 'wrap' } : undefined}>
                      {brandOf(a.institution) || logoOf(a.institution) ? <BrandTile name={a.institution} /> : <Tile icon={KIND_TILE[kind][0]} color={KIND_TILE[kind][1]} />}
                      <div className="body"><div className="title">{a.institution} {a.last4 && <span className="caption">··{a.last4}</span>}</div>
                        <div className="sub">{a.name.startsWith(a.institution) ? KIND_LABEL[a.kind].replace(/s$/, "") : a.name}{owners.size > 1 && a.owner_member_id ? ` · ${ownerName(a.owner_member_id)}` : ''}{covOf(a.id) && covOf(a.id)!.status !== 'ok' ? <span className="warn"> · {covOf(a.id)!.status === 'gaps' ? `${covOf(a.id)!.missing_months.length} month gap` : covOf(a.id)!.status === 'stale' ? 'quiet' : 'no data'}</span> : null}</div></div>
                      <div className="end"><span className={`amt ${a.balance && a.balance.minor < 0 ? 'neg' : ''}`}><Money m={a.balance} /></span>
                        {a.balance_at && <span className="footnote">{shortDate(a.balance_at.slice(0, 10))}</span>}</div>
                      {a.credit_limit && a.used_pct !== null && (
                        <div style={{ flexBasis: '100%', paddingLeft: 50 }} className="stack-sm">
                          <Meter pct={a.used_pct} color={a.used_pct > 70 ? 'var(--red-fill)' : a.used_pct > 30 ? 'var(--orange-fill)' : 'var(--green-fill)'} />
                          <span className="caption">{a.used_pct}% of <Money m={a.credit_limit} /> used{a.due_day ? ` · due on the ${a.due_day}th` : ''}</span>
                        </div>
                      )}
                    </Link>
                  ))}
                </List>
              </Section>
            );
          })}</Fragment>);
          })}
        </>
      )}
      <AddAccountSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

function AddAccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState('bank');
  const [institution, setInstitution] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [country, setCountry] = useState('SA');
  const [last4, setLast4] = useState('');
  const add = useWrite('POST', '/accounts');
  const toast = useToast();
  const save = async () => {
    await add.mutateAsync({ kind, institution, name: institution, currency, country, last4: last4 || undefined });
    toast(`${institution} added`); setInstitution(''); setLast4(''); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add account">
      <div className="stack">
        <div className="chips" style={{ flexWrap: 'wrap' }}>{['bank', 'credit_card', 'wallet', 'bnpl', 'cash'].map(k => <Chip key={k} on={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k].replace(/s$/, '')}</Chip>)}</div>
        <Field label="Bank or app"><input className="input" value={institution} onChange={e => setInstitution(e.target.value)} placeholder="Al Rajhi, HDFC, STC Pay…" autoFocus /></Field>
        <Segmented label="Currency" value={currency} onChange={v => { setCurrency(v); setCountry(CUR_COUNTRY[v] || 'XX'); }} options={[{ value: 'SAR', label: 'SAR' }, { value: 'INR', label: 'INR ₹' }]} />
        <CountryChips value={country} onChange={setCountry} />
        <Field label="Last 4 digits (helps match SMS)"><input className="input" inputMode="numeric" maxLength={4} value={last4} onChange={e => setLast4(e.target.value.replace(/\D/g, ''))} /></Field>
        <button className="btn block" disabled={!institution || add.isPending} onClick={save}>Add</button>
        <p className="footnote" style={{ textAlign: 'center' }}>Usually not needed — accounts appear on their own from your bank SMS.</p>
      </div>
    </Sheet>
  );
}

function CountryChips({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="stack-sm"><span className="caption">Country (groups it on the Accounts page)</span>
      <div className="chips" style={{ flexWrap: 'wrap' }} role="radiogroup" aria-label="Country">{COUNTRIES.map(c => <Chip key={c.code} on={value === c.code} onClick={() => onChange(c.code)}>{c.flag} {c.name}</Chip>)}</div>
    </div>
  );
}

const dayOf = (v: string) => Math.min(31, Math.max(0, Math.round(Number(v) || 0)));
/** Edit an account's name, bank, last 4, country, card limit, statement/due day and owner; or archive it. */
export function EditAccountSheet({ a, open, onClose }: { a: Account; open: boolean; onClose: () => void }) {
  const hh = useApi<HouseholdFull>('/households/current');
  const [f, setF] = useState(() => ({ name: a.name, institution: a.institution, last4: a.last4 || '', country: countryOf(a), owner: a.owner_member_id || '',
    limit: a.credit_limit ? String(major(a.credit_limit)) : '', statement_day: a.statement_day ? String(a.statement_day) : '', due_day: a.due_day ? String(a.due_day) : '' }));
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const save = useWrite<Record<string, unknown>>('PATCH', `/accounts/${a.id}`);
  const nav = useNavigate();
  const toast = useToast();
  const card = a.kind === 'credit_card' || a.kind === 'bnpl';
  const submit = async () => {
    try {
      await save.mutateAsync({ name: f.name, institution: f.institution, last4: f.last4, country: f.country, owner_member_id: f.owner || null,
        statement_day: dayOf(f.statement_day), due_day: dayOf(f.due_day), ...(card ? { credit_limit_minor: toMinor(Number(f.limit) || 0, a.currency) } : {}) });
      toast('Saved'); onClose();
    } catch { /* shown below */ }
  };
  const archive = async () => {
    if (!confirm(`Archive ${a.institution || a.name}? It leaves your lists and totals; its transactions stay.`)) return;
    await save.mutateAsync({ archived: true }); toast('Archived'); nav('/more/accounts');
  };
  return (
    <Sheet open={open} onClose={onClose} title="Edit account">
      <div className="stack">
        <Field label="Bank or app"><input className="input" value={f.institution} onChange={e => set('institution')(e.target.value)} /></Field>
        <Field label="Name"><input className="input" value={f.name} onChange={e => set('name')(e.target.value)} placeholder="Current account, Platinum card…" /></Field>
        <Field label="Last 4 digits"><input className="input" inputMode="numeric" maxLength={4} value={f.last4} onChange={e => set('last4')(e.target.value.replace(/\D/g, ''))} /></Field>
        <CountryChips value={f.country} onChange={set('country')} />
        {card && <Field label={`Credit limit (${a.currency})`}><input className="input" inputMode="decimal" value={f.limit} onChange={e => set('limit')(e.target.value.replace(/[^\d.]/g, ''))} /></Field>}
        <div className="grid-2">
          <Field label="Statement day"><input className="input" inputMode="numeric" maxLength={2} value={f.statement_day} onChange={e => set('statement_day')(e.target.value.replace(/\D/g, ''))} placeholder="—" /></Field>
          <Field label="Due day"><input className="input" inputMode="numeric" maxLength={2} value={f.due_day} onChange={e => set('due_day')(e.target.value.replace(/\D/g, ''))} placeholder="—" /></Field>
        </div>
        <Field label="Owner">
          <select className="input" value={f.owner} onChange={e => set('owner')(e.target.value)}>
            <option value="">Nobody in particular</option>
            {(hh.data?.members || []).map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
          </select>
        </Field>
        {save.error && <p className="error" role="alert">{save.error.message}</p>}
        <button className="btn block" disabled={!f.name || save.isPending} onClick={submit}>Save</button>
        <button className="btn block danger" disabled={save.isPending} onClick={archive}>Archive account</button>
      </div>
    </Sheet>
  );
}

/* ---------- Assets ---------- */
const ASSET_TILE: Record<string, [string, string]> = { property: ['building', '#a2845e'], vehicle: ['car', '#0a84ff'], investment: ['chart', '#30d158'] };
const COST_TYPES = ['fuel', 'service', 'insurance', 'registration', 'parking', 'tolls', 'repairs', 'other'];
const pctOf = (a: MoneyT, b: MoneyT) => (a.minor / Math.max(1, b.minor)) * 100;

export function AssetsPage() {
  const q = useApi<{ items: Asset[] }>('/assets');
  const [adding, setAdding] = useState(false);
  return (
    <Page title="Assets" trail={<button className="icon-btn" onClick={() => setAdding(true)} aria-label="Add property, vehicle or investment"><Icon name="plus" /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !q.data!.items.length
        ? <EmptyState icon="building" title="Nothing yet" text="Property, vehicles and investments show here." action={<button className="btn" onClick={() => setAdding(true)}><Icon name="plus" />Add one</button>} /> : (
        (['property', 'vehicle', 'investment'] as const).map(k => {
          const items = q.data!.items.filter(a => a.kind === k);
          if (!items.length) return null;
          return (
            <Section key={k} title={{ property: 'Property', vehicle: 'Vehicles', investment: 'Investments' }[k]}>
              <List>{items.map(a => (
                <ListRow key={a.id} to={`/assets/${a.id}`} icon={<Tile icon={ASSET_TILE[k][0]} color={ASSET_TILE[k][1]} />} title={a.name}
                  sub={a.status && a.status !== 'owned' ? <>{STATUS_LABEL[a.status]} · net cost <Money m={a.verdict?.net_cost} compact /></>
                    : k === 'property' ? `${Math.round(pctOf(a.paid, a.cost))}% paid · next: ${a.next_milestone?.name || '—'}` : k === 'vehicle' ? <>Costs <Money m={a.my_monthly_cost} />/mo (your share)</> : <>Invested <Money m={a.cost} compact /></>}
                  end={<Money m={a.value} compact />} endSub={k === 'investment' && a.cost.minor ? <span className={a.value.minor >= a.cost.minor ? 'pos' : 'neg'}>{a.value.minor >= a.cost.minor ? '+' : ''}{(((a.value.minor - a.cost.minor) / a.cost.minor) * 100).toFixed(1)}%</span>
                    : a.verdict?.annual_pct != null && a.verdict.cost.minor ? <span className={a.verdict.annual_pct >= 0 ? 'pos' : 'neg'}>{a.verdict.annual_pct > 0 ? '+' : ''}{a.verdict.annual_pct}% a yr</span> : 'value'} />
              ))}</List>
            </Section>
          );
        })
      )}
      <AddAssetSheet open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}

function AddAssetSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<'vehicle' | 'property' | 'investment'>('vehicle');
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [cost, setCost] = useState('');
  const [value, setValue] = useState('');
  const [asOf, setAsOf] = useState(today());
  const add = useWrite<Record<string, unknown>, Asset>('POST', '/assets');
  const nav = useNavigate();
  const toast = useToast();
  const save = async () => {
    try {
      const a = await add.mutateAsync({ kind, name, currency, cost_minor: toMinor(Number(cost) || 0, currency), value_minor: toMinor(Number(value || cost) || 0, currency), value_as_of: asOf,
        // a vehicle or investment is bought outright (a car loan is linked later); a property is paid in stages
        details: { bought_on: asOf, ...(kind !== 'property' ? { paid_cash_minor: toMinor(Number(cost) || 0, currency) } : {}),
          ...(value ? { market_value: { minor: toMinor(Number(value) || 0, currency), as_of: today(), source: 'Entered when added' } } : {}) } });
      toast(`${name} added`); setName(''); setCost(''); setValue(''); onClose(); nav(`/assets/${a.id}`);
    } catch { /* shown below */ }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add what you own">
      <div className="stack">
        <Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: 'vehicle', label: 'Vehicle' }, { value: 'property', label: 'Property' }, { value: 'investment', label: 'Investment' }]} />
        <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={{ vehicle: 'Camry 2022', property: 'Flat in Kochi', investment: 'Index fund SIP' }[kind]} /></Field>
        <Segmented label="Currency" value={currency} onChange={setCurrency} options={[{ value: 'SAR', label: 'SAR' }, { value: 'INR', label: 'INR ₹' }]} />
        <div className="grid-2">
          <Field label={kind === 'investment' ? 'Invested' : kind === 'property' ? 'Total cost' : 'Bought for'}><input className="input" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></Field>
          <Field label="Worth now"><input className="input" inputMode="decimal" value={value} onChange={e => setValue(e.target.value.replace(/[^\d.]/g, ''))} placeholder={cost || '0'} /></Field>
        </div>
        <Field label="Bought on"><input className="input" type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></Field>
        {add.error && <p className="error" role="alert">{add.error.message}</p>}
        <button className="btn block" disabled={!name.trim() || add.isPending} onClick={save}>Add</button>
      </div>
    </Sheet>
  );
}

export function AssetPage() {
  const { id } = useParams();
  const q = useApi<Asset>(`/assets/${id}`);
  const a = q.data;
  const [stone, setStone] = useState<Milestone | 'new' | null>(null);
  const done = a?.milestones.filter(m => m.paid).length || 0;
  const byLoan = a?.milestones.filter(m => m.disbursed_on).reduce((s, m) => s + m.amount.minor, 0) || 0;
  // free-form labels (Plate, Odometer…); the keys the page reads itself are shown in their own cards
  const labels = Object.entries(a?.details || {}).filter(([k, v]) => !DETAIL_KEYS.includes(k) && (typeof v !== 'object' || v === null));
  return (
    <Page title={a?.name || 'Asset'} back="/assets">
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : a && (
        <div className="grid-desktop stack">
          <AssetHeader a={a} />
          <section className="glass hero span-2 row-flex" style={{ gap: 18 }}>
            <ProgressRing pct={pctOf(a.paid, a.cost)} size={96} stroke={10} color="var(--green-fill)" />
            <div className="stack-sm" style={{ flex: 1, minWidth: 0 }}>
              <span className="hero-label">{a.kind === 'investment' ? 'Current value' : 'Paid so far'}</span>
              <span style={{ font: '700 30px var(--font-display)', letterSpacing: '-.03em' }} className="num">{fmt(a.kind === 'investment' ? a.value : a.paid)}</span>
              <span className="caption">of <Money m={a.cost} /> {a.kind === 'investment' ? 'invested' : 'total cost'}{a.kind === 'vehicle' ? <> · worth <Money m={a.value} /></> : null}</span>
            </div>
          </section>
          {a.kind !== 'investment' && (
            <div className="grid-2 span-2">
              <div className="glass card stat"><span className="k">By loan</span><span className="v"><Money m={a.financed} compact /></span></div>
              <div className="glass card stat"><span className="k">Still to pay</span><span className="v warn"><Money m={a.remaining} compact /></span></div>
            </div>
          )}
          {a.verdict && a.kind !== 'investment' && <VerdictCard a={a} />}
          {a.funding && a.kind !== 'investment' && <FundingCard a={a} />}
          {a.valuation && <ValueCard a={a} />}
          {a.kind === 'property' && <LoanCard a={a} />}
          {(a.kind === 'property' || a.milestones.length > 0) && (
            <Section title="Stages & tranches" action={<button className="link-btn" onClick={() => setStone('new')}>Add</button>}>
              {a.milestones.length ? (
                <>
                  <p className="caption" style={{ marginLeft: 4 }}>{done} of {a.milestones.length} done{byLoan ? <> · <Money m={{ minor: byLoan, currency: a.currency }} /> from the loan</> : null}</p>
                  <List>{a.milestones.map(m => {
                    const next = m.id === a.next_milestone?.id;
                    const [icon, color] = m.disbursed_on ? ['bank', '#0a84ff'] : m.paid ? ['check', '#30d158'] : next ? ['calendar', '#ff9f0a'] : ['calendar', '#8e8e93'];
                    return (
                      <ListRow key={m.id} icon={<Tile icon={icon} color={color} />} title={m.name} onClick={() => setStone(m)}
                        sub={m.disbursed_on ? `Bank paid ${shortDate(m.disbursed_on)}` : m.paid ? `You paid${m.paid_on ? ' ' + shortDate(m.paid_on) : ''}` : `Due ${shortDate(m.due_on)}`}
                        end={<Money m={m.amount} compact />}
                        endSub={m.disbursed_on ? <span className="badge blue">Disbursed</span> : m.paid ? <span className="badge green">Paid</span> : next ? <span className="badge orange">Next</span> : undefined} />
                    );
                  })}</List>
                </>
              ) : <p className="caption" style={{ marginLeft: 4 }}>Add the builder’s stages: each is paid by you or disbursed by the bank.</p>}
            </Section>
          )}
          {a.kind === 'vehicle' && <VehicleCosts a={a} />}
          {a.kind !== 'vehicle' && Object.keys(a.costs_by_type).length > 0 && (
            <Section title="Monthly costs">
              <div className="glass card stack-sm">
                {Object.entries(a.costs_by_type).map(([k, v]) => (
                  <div key={k} className="stack-sm"><div className="between"><span>{k}</span><Money m={v} /></div><Meter pct={pctOf(v, a.monthly_cost)} /></div>
                ))}
                <div className="between" style={{ marginTop: 6 }}><b>Your share</b><b><Money m={a.my_monthly_cost} />/mo</b></div>
              </div>
            </Section>
          )}
          {labels.length > 0 && (
            <Section title="Details">
              <dl className="kv glass card">{labels.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{String(v ?? '—')}</dd></Fragment>)}</dl>
            </Section>
          )}
          {a.kind !== 'investment' && <DisposalCard a={a} />}
        </div>
      )}
      {a && <MilestoneSheet key={stone === 'new' ? 'new' : stone?.id || 'none'} a={a} m={stone === 'new' ? null : stone} open={stone !== null} onClose={() => setStone(null)} />}
    </Page>
  );
}

const DETAIL_KEYS = ['market_value', 'disposal', 'area_sqft', 'depreciation_pct', 'bought_on', 'builder', 'photo_url', 'paid_cash_minor'];
const TONE: Record<string, [string, string]> = { good: ['check', '#30d158'], warn: ['warn', '#ff9f0a'], bad: ['warn', '#ff453a'], info: ['info', '#0a84ff'] };
const STATUS_LABEL = { sold: 'Sold', written_off: 'Written off' } as const;
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/** Builder or maker as its logo (monogram if unknown), your own photo if you added a link, and the status. */
function AssetHeader({ a }: { a: Asset }) {
  const [editing, setEditing] = useState(false);
  const d = a.details, maker = d.builder || '';
  const [tileIcon, tileColor] = ASSET_TILE[a.kind] || ['building', '#a2845e'];
  return (
    <section className="glass card span-2 stack-sm" style={{ padding: 0, overflow: 'hidden' }}>
      {d.photo_url && <img src={d.photo_url} alt={`Photo of ${a.name}`} referrerPolicy="no-referrer" loading="lazy" style={{ width: '100%', height: 168, objectFit: 'cover', display: 'block' }} />}
      <div className="row-flex" style={{ padding: '14px 16px', gap: 12 }}>
        {maker && (brandOf(maker) || logoOf(maker)) ? <BrandTile name={maker} /> : maker ? <span className="icon-tile brand-tile" aria-hidden style={{ background: tileColor, color: '#fff', fontSize: 15 }}>{initials(maker)}</span> : <Tile icon={tileIcon} color={tileColor} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{maker || a.name}</b>
          <span className="caption">{a.kind === 'property' ? (a.under_construction ? 'Under construction' : 'Property') : a.kind === 'vehicle' ? 'Vehicle' : 'Investment'}
            {a.valuation?.bought_on ? ` · bought ${shortDate(a.valuation.bought_on)}` : ''}</span>
        </div>
        {a.status && a.status !== 'owned' ? <span className="badge red">{STATUS_LABEL[a.status]}</span> : <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {editing && <HeaderSheet a={a} onClose={() => setEditing(false)} />}
    </section>
  );
}

function HeaderSheet({ a, onClose }: { a: Asset; onClose: () => void }) {
  const [builder, setBuilder] = useState(a.details.builder || '');
  const [photo, setPhoto] = useState(a.details.photo_url || '');
  const [bought, setBought] = useState(a.details.bought_on || a.valuation?.bought_on || '');
  const save = useWrite<Record<string, unknown>>('PATCH', `/assets/${a.id}`);
  const toast = useToast();
  const submit = async () => {
    try { await save.mutateAsync({ details: { builder: builder.trim() || null, photo_url: photo.trim() || null, bought_on: bought || null } }); toast('Saved'); onClose(); } catch { /* shown below */ }
  };
  return (
    <Sheet open onClose={onClose} title="About this asset">
      <div className="stack">
        <Field label={a.kind === 'vehicle' ? 'Make' : 'Builder'}><input className="input" value={builder} onChange={e => setBuilder(e.target.value)} placeholder={a.kind === 'vehicle' ? 'Toyota' : 'Shriram Properties'} /></Field>
        <Field label="Bought on"><input className="input" type="date" value={bought} onChange={e => setBought(e.target.value)} /></Field>
        <Field label="Photo link (https, optional)"><input className="input" type="url" inputMode="url" value={photo} onChange={e => setPhoto(e.target.value)} placeholder="https://…/my-flat.jpg" /></Field>
        <p className="footnote">Use a photo you took and host yourself (an iCloud or Google Photos share link, for example). Uploading photos here isn’t supported yet.</p>
        {save.error && <p className="error" role="alert">{save.error.message}</p>}
        <button className="btn block" disabled={save.isPending || (!!photo.trim() && !photo.trim().startsWith('https://'))} onClick={submit}>Save</button>
      </div>
    </Sheet>
  );
}

/** "Was it a good buy": the server's verdict, gain against an FD on the same money, and what it assumes. */
function VerdictCard({ a }: { a: Asset }) {
  const v = a.verdict!;
  const [icon, color] = TONE[v.tone];
  const ended = a.status && a.status !== 'owned';
  return (
    <Section title={a.kind === 'vehicle' || ended ? 'How it worked out' : 'Was it a good buy?'}>
      <div className="glass card stack">
        <div className="row-flex" style={{ gap: 12, alignItems: 'flex-start' }}>
          <Tile icon={icon} color={color} />
          <p style={{ margin: 0, flex: 1, minWidth: 0 }}>{v.text}</p>
        </div>
        <div className="grid-2">
          <div className="stat"><span className="k">{v.gain.minor < 0 ? 'Loss' : 'Gain'}</span><span className={`v ${v.gain.minor < 0 ? 'neg' : 'pos'}`}><Money m={v.gain} compact sign /></span>
            <span className="caption">{v.annual_pct === null ? '—' : `${v.annual_pct > 0 ? '+' : ''}${v.annual_pct}% a year`}</span></div>
          <div className="stat"><span className="k">{(v.fd_rate_bp / 100).toFixed(1)}% FD instead</span><span className="v"><Money m={v.fd_gain} compact sign /></span>
            <span className={`caption ${v.edge.minor < 0 ? 'neg' : 'pos'}`}>{v.edge.minor < 0 ? 'FD ahead by ' : 'ahead by '}{fmt({ ...v.edge, minor: Math.abs(v.edge.minor) }, { compact: true })}</span></div>
        </div>
        {(a.kind === 'vehicle' || ended) && <div className="between"><span>Net cost to you</span><b><Money m={v.net_cost} /></b></div>}
        {v.provisional && <span className="badge orange" style={{ alignSelf: 'flex-start' }}>Provisional until handover</span>}
        <details className="caption">
          <summary>What this assumes</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{v.assumptions.map(t => <li key={t}>{t}</li>)}</ul>
          <p className="footnote" style={{ marginTop: 6 }}>Change the FD rate in <Link to="/more/settings">Settings</Link>.</p>
        </details>
      </div>
    </Section>
  );
}

/** What it has cost so far: your own money (by account) and the loan's, plus interest paid on the loan. */
function FundingCard({ a }: { a: Asset }) {
  const f = a.funding!;
  const paidIn = f.own.minor + f.loan.minor;
  return (
    <Section title="What it has cost">
      <div className="glass card stack">
        <div className="between"><span className="caption">Cost to date, with interest</span><span className="caption">Price <Money m={a.cost} compact /></span></div>
        <b className="num" style={{ fontSize: 26, letterSpacing: '-.02em' }}><Money m={f.cost_to_date} /></b>
        <div className="meter" style={{ display: 'flex' }} role="img" aria-label={`Own money ${Math.round(pctOf(f.own, { ...f.own, minor: paidIn }))}%, loan the rest`}>
          <i style={{ width: `${pctOf(f.own, { ...f.own, minor: paidIn })}%`, background: 'var(--green-fill)', borderRadius: 0 }} />
          <i style={{ flex: 1, background: 'var(--tint-fill)', borderRadius: 0 }} />
        </div>
        <div className="grid-2">
          <div className="stat"><span className="k"><i className="dot" style={{ background: 'var(--green-fill)' }} />Your money</span><span className="v"><Money m={f.own} compact /></span></div>
          <div className="stat"><span className="k"><i className="dot" style={{ background: 'var(--tint-fill)' }} />By the loan</span><span className="v"><Money m={f.loan} compact /></span></div>
        </div>
        <div className="between"><span>Interest{a.kind === 'property' ? ' & pre-EMI' : ''} paid</span><b><Money m={f.interest} /></b></div>
        {f.own_sources.length > 0 && (
          <dl className="kv" style={{ fontSize: 14 }}>{f.own_sources.map(s => <Fragment key={s.name}><dt>{s.name}</dt><dd><Money m={s.amount} compact /></dd></Fragment>)}</dl>
        )}
        <p className="footnote">Your money is the stages you paid (from the linked payments, or marked paid) and payments tagged to this {a.kind}. The loan part is what the bank disbursed. Interest comes from the loan’s payments.</p>
      </div>
    </Section>
  );
}

const BASIS: Record<string, string> = { market: 'Your market estimate', depreciation: 'Estimated by depreciation', recorded: 'Value you recorded', cost: 'At cost (no value yet)', sold: 'Sold for', written_off: 'Paid out (written off)' };

/** Today's value and where it comes from, editable: a market value (with a price per sq ft helper) or, for a vehicle, a depreciation rate. */
function ValueCard({ a }: { a: Asset }) {
  const [editing, setEditing] = useState(false);
  const v = a.valuation!;
  const ended = a.status && a.status !== 'owned';
  return (
    <Section title={ended ? 'What it brought back' : 'Worth now'} action={ended ? undefined : <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>}>
      <div className="glass card stack-sm">
        <div className="between"><span className="caption">{BASIS[v.basis]}</span><span className="caption">{shortDate(v.as_of)}</span></div>
        <b className="num" style={{ fontSize: 26, letterSpacing: '-.02em' }}><Money m={v.value} /></b>
        {v.note && <span className="caption">{v.note}</span>}
        {a.details.area_sqft ? <span className="caption">{a.details.area_sqft.toLocaleString()} sq ft · <Money m={{ ...v.value, minor: Math.round(v.value.minor / a.details.area_sqft) }} /> a sq ft</span> : null}
        {!ended && v.basis !== 'market' && <span className="footnote">{a.kind === 'vehicle' ? 'Set your own value (a dealer quote or a Haraj listing) if you know it.' : 'Add a market value from recent sale prices nearby: nothing is looked up for you.'}</span>}
      </div>
      {editing && <ValueSheet a={a} onClose={() => setEditing(false)} />}
    </Section>
  );
}

function ValueSheet({ a, onClose }: { a: Asset; onClose: () => void }) {
  const mv = a.details.market_value;
  const [mode, setMode] = useState<'market' | 'depreciation'>(a.kind === 'vehicle' && !mv ? 'depreciation' : 'market');
  const [value, setValue] = useState(mv ? String(major({ minor: mv.minor, currency: a.currency })) : '');
  const [asOf, setAsOf] = useState(mv?.as_of || today());
  const [source, setSource] = useState(mv?.source || '');
  const [area, setArea] = useState(a.details.area_sqft ? String(a.details.area_sqft) : '');
  const [rate, setRate] = useState('');
  const [dep, setDep] = useState(String(a.details.depreciation_pct ?? a.valuation?.depreciation_pct ?? 15));
  const save = useWrite<Record<string, unknown>>('PATCH', `/assets/${a.id}`);
  const toast = useToast();
  const useRate = () => { const v = Number(rate) * Number(area); if (v > 0) { setValue(String(Math.round(v))); if (!source) setSource(`${a.currency} ${Number(rate).toLocaleString()} a sq ft × ${Number(area).toLocaleString()} sq ft`); } };
  const submit = async () => {
    const details: Record<string, unknown> = { area_sqft: Number(area) > 0 ? Number(area) : null };
    if (mode === 'market') details.market_value = { minor: toMinor(Number(value) || 0, a.currency), as_of: asOf, source: source.trim() };
    else { details.market_value = null; details.depreciation_pct = Math.min(100, Math.max(0, Number(dep) || 0)); }
    try { await save.mutateAsync({ details }); toast('Value saved'); onClose(); } catch { /* shown below */ }
  };
  return (
    <Sheet open onClose={onClose} title="What it’s worth">
      <div className="stack">
        {a.kind === 'vehicle' && <Segmented label="Value from" value={mode} onChange={setMode} options={[{ value: 'depreciation', label: 'Depreciation' }, { value: 'market', label: 'My value' }]} />}
        {mode === 'depreciation' ? (
          <>
            <Field label="Loses a year (%)"><input className="input" inputMode="decimal" value={dep} onChange={e => setDep(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
            <p className="footnote">The price less this much each year since it was bought. 15% suits most cars; set the bought-on date under Edit at the top.</p>
          </>
        ) : (
          <>
            {a.kind === 'property' && (
              <div className="glass card stack-sm">
                <span className="caption">Helper: price per sq ft × area</span>
                <div className="grid-2">
                  <Field label="Area (sq ft)"><input className="input" inputMode="decimal" value={area} onChange={e => setArea(e.target.value.replace(/[^\d.]/g, ''))} placeholder="1250" /></Field>
                  <Field label={`${a.currency} a sq ft`}><input className="input" inputMode="decimal" value={rate} onChange={e => setRate(e.target.value.replace(/[^\d.]/g, ''))} placeholder="7500" /></Field>
                </div>
                <button className="btn block secondary" disabled={!(Number(rate) > 0 && Number(area) > 0)} onClick={useRate}>Use {Number(rate) > 0 && Number(area) > 0 ? fmt({ minor: toMinor(Number(rate) * Number(area), a.currency), currency: a.currency }, { compact: true }) : 'this'}</button>
              </div>
            )}
            <Field label={`Worth now (${a.currency})`}><input className="input" inputMode="decimal" value={value} onChange={e => setValue(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></Field>
            <Field label="As of"><input className="input" type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></Field>
            <Field label="Source"><input className="input" value={source} onChange={e => setSource(e.target.value)} placeholder="Resale listings in the same project, broker quote…" maxLength={200} /></Field>
          </>
        )}
        {save.error && <p className="error" role="alert">{save.error.message}</p>}
        <button className="btn block" disabled={save.isPending || (mode === 'market' && !(Number(value) > 0))} onClick={submit}>Save</button>
      </div>
    </Sheet>
  );
}

/** Mark it sold or written off (an insurance payout after an accident), or undo that: the final net cost shows above. */
function DisposalCard({ a }: { a: Asset }) {
  const d = a.details.disposal;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'sold' | 'written_off'>(d?.status || 'written_off');
  const [on, setOn] = useState(d?.on || today());
  const [amount, setAmount] = useState(d ? String(major({ minor: d.proceeds_minor, currency: a.currency })) : '');
  const [note, setNote] = useState(d?.note || '');
  const save = useWrite<Record<string, unknown>>('PATCH', `/assets/${a.id}`);
  const toast = useToast();
  const submit = async (disposal: Record<string, unknown> | null) => {
    try { await save.mutateAsync({ details: { disposal } }); toast(disposal ? 'Saved' : 'Marked as still owned'); setOpen(false); } catch { /* shown below */ }
  };
  return (
    <div className="span-2 stack-sm">
      {d ? (
        <List><ListRow icon={<Tile icon="receipt" color="#8e8e93" />} title={`${STATUS_LABEL[d.status]} ${shortDate(d.on)}`} sub={d.note || undefined}
          end={<Money m={{ minor: d.proceeds_minor, currency: a.currency }} />} endSub={d.status === 'sold' ? 'sale price' : 'paid out'} onClick={() => setOpen(true)} /></List>
      ) : <button className="btn block secondary" onClick={() => setOpen(true)}>Mark sold or written off</button>}
      <Sheet open={open} onClose={() => setOpen(false)} title={d ? 'Sold or written off' : 'No longer yours'}>
        <div className="stack">
          <Segmented label="What happened" value={status} onChange={setStatus} options={[{ value: 'written_off', label: 'Written off' }, { value: 'sold', label: 'Sold' }]} />
          <div className="grid-2">
            <Field label={status === 'sold' ? `Sold for (${a.currency})` : `Payout (${a.currency})`}><input className="input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></Field>
            <Field label="On"><input className="input" type="date" value={on} onChange={e => setOn(e.target.value)} /></Field>
          </div>
          <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={status === 'sold' ? 'Sold on Haraj' : 'Insurance payout after the accident'} maxLength={200} /></Field>
          <p className="footnote">It stays here with its final net cost: what it cost with interest and running costs, less what came back. The loan stays on Plan until it’s repaid.</p>
          {save.error && <p className="error" role="alert">{save.error.message}</p>}
          <button className="btn block" disabled={save.isPending || amount === ''} onClick={() => submit({ status, on, proceeds_minor: toMinor(Number(amount) || 0, a.currency), note: note.trim() })}>Save</button>
          {d && <button className="btn block danger" onClick={() => submit(null)}>Still own it (undo)</button>}
        </div>
      </Sheet>
    </div>
  );
}

/** The property's loan: for a construction loan, disbursed vs sanctioned, today's pre-EMI and when the full EMI starts. */
function LoanCard({ a }: { a: Asset }) {
  const l = useApi<Liability>(a.liability_id ? `/liabilities/${a.liability_id}` : null);
  const all = useApi<{ items: Liability[] }>(a.liability_id ? null : '/liabilities');
  const link = useWrite<Record<string, unknown>>('PATCH', `/assets/${a.id}`);
  const edit = useWrite<Record<string, unknown>>('PATCH', `/liabilities/${a.liability_id}`);
  const toast = useToast();
  if (!a.liability_id) {
    const loans = (all.data?.items || []).filter(x => x.kind === 'loan');
    return (
      <Section title="Home loan">
        <div className="glass card stack-sm">
          <Field label="Paid with a loan?">
            <select className="input" value="" onChange={e => e.target.value && link.mutateAsync({ liability_id: e.target.value }).then(() => toast('Loan linked'))}>
              <option value="">{loans.length ? 'Link a loan…' : 'Add the loan under Plan first'}</option>
              {loans.map(x => <option key={x.id} value={x.id}>{x.name}{x.lender ? ` · ${x.lender}` : ''}</option>)}
            </select>
          </Field>
          <p className="footnote">Linked, the bank’s tranches show here with the pre-EMI you pay until full EMIs start.</p>
        </div>
      </Section>
    );
  }
  const x = l.data;
  if (!x) return l.error ? <ErrorCard error={l.error} retry={l.refetch} /> : <div className="skel" style={{ height: 160 }} />;
  const c = x.construction;
  return (
    <Section title={x.name}>
      <div className="glass card stack">
        {c ? (
          <>
            <div className="between"><span className="caption">Disbursed</span><span className="caption">Sanctioned <Money m={c.sanctioned} /></span></div>
            <b className="num" style={{ fontSize: 26, letterSpacing: '-.02em' }}><Money m={c.disbursed} /></b>
            <Meter pct={pctOf(c.disbursed, c.sanctioned)} color="var(--tint-fill)" />
            <span className="caption">{Math.round(pctOf(c.disbursed, c.sanctioned))}% out · <Money m={c.undisbursed} /> still with the bank · {c.tranches.length} tranche{c.tranches.length === 1 ? '' : 's'}</span>
            <div className="grid-2">
              <div className="stat"><span className="k">{c.phase === 'pre_emi' ? 'Pre-EMI now' : 'EMI now'}</span><span className="v"><Money m={c.monthly} /></span><span className="caption">a month</span></div>
              <div className="stat"><span className="k">Full EMI</span><span className="v"><Money m={x.emi} /></span><span className="caption">{c.emi_from ? `from ${monthLabel(c.emi_from.slice(0, 7), true)}` : 'start not set'}</span></div>
            </div>
            <Field label="Full EMI starts on">
              <input className="input" type="date" defaultValue={x.emi_from || ''} onBlur={e => e.target.value !== (x.emi_from || '') && edit.mutateAsync({ emi_from: e.target.value }).then(() => toast('Saved'))} />
            </Field>
            <p className="footnote">Pre-EMI is interest only: disbursed × {(x.rate_bp / 100).toFixed(2)}% ÷ 12. It rises with each tranche; nothing is repaid until full EMIs start.</p>
          </>
        ) : (
          <>
            <div className="between"><span className="caption">Outstanding</span><span className="caption">{x.paid_pct ?? 0}% repaid</span></div>
            <b className="num" style={{ fontSize: 26 }}><Money m={x.outstanding} /></b>
            <Meter pct={x.paid_pct ?? 0} color="var(--green-fill)" />
            <span className="caption">EMI <Money m={x.emi} />{x.due_day ? ` on the ${x.due_day}th` : ''} · {(x.rate_bp / 100).toFixed(2)}%{x.payoff_month ? ` · done ${monthLabel(x.payoff_month, true)}` : ''}</span>
            <p className="footnote">Mark a stage “Disbursed by the loan” to track this as a construction loan with pre-EMI.</p>
          </>
        )}
      </div>
    </Section>
  );
}

/** Add or change a stage: due date and amount, and who paid it (you, or the bank as a loan tranche). */
function MilestoneSheet({ a, m, open, onClose }: { a: Asset; m: Milestone | null; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(m?.name || '');
  const [due, setDue] = useState(m?.due_on || today());
  const [amount, setAmount] = useState(m ? String(major(m.amount)) : '');
  const [how, setHow] = useState<'open' | 'paid' | 'loan'>(m?.disbursed_on ? 'loan' : m?.paid ? 'paid' : 'open');
  const [on, setOn] = useState(m?.disbursed_on || m?.paid_on || today());
  const save = useWrite<Record<string, unknown>>(m ? 'PATCH' : 'POST', m ? `/assets/${a.id}/milestones/${m.id}` : `/assets/${a.id}/milestones`);
  const del = useWrite('DELETE', `/assets/${a.id}/milestones/${m?.id}`);
  const toast = useToast();
  const submit = async () => {
    try {
      await save.mutateAsync({ name, due_on: due, amount_minor: toMinor(Number(amount) || 0, a.currency), paid_on: how === 'paid' ? on : '',
        disbursed_on: how === 'loan' ? on : '', ...(how !== 'paid' && m?.paid_txn_id ? { paid_txn_id: null } : {}) });
      toast('Saved'); onClose();
    } catch { /* shown below */ }
  };
  return (
    <Sheet open={open} onClose={onClose} title={m ? m.name : 'Add a stage'}>
      <div className="stack">
        <Field label="Stage"><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Plinth, 3rd slab, possession…" /></Field>
        <div className="grid-2">
          <Field label={`Amount (${a.currency})`}><input className="input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></Field>
          <Field label="Due"><input className="input" type="date" value={due} onChange={e => setDue(e.target.value)} /></Field>
        </div>
        <Segmented label="Paid" value={how} onChange={setHow} options={[{ value: 'open', label: 'Not yet' }, { value: 'paid', label: 'I paid' }, { value: 'loan', label: 'Loan paid' }]} />
        {how !== 'open' && <Field label={how === 'loan' ? 'Disbursed on' : 'Paid on'}><input className="input" type="date" value={on} onChange={e => setOn(e.target.value)} /></Field>}
        {how === 'loan' && !a.liability_id && <p className="caption warn">Link the home loan to this property first (above).</p>}
        {save.error && <p className="error" role="alert">{save.error.message}</p>}
        <button className="btn block" disabled={!name.trim() || !amount || save.isPending} onClick={submit}>Save</button>
        {m && <button className="btn block danger" onClick={async () => { if (confirm(`Delete ${m.name}?`)) { await del.mutateAsync(undefined); toast('Deleted'); onClose(); } }}>Delete stage</button>}
      </div>
    </Sheet>
  );
}

/** A vehicle's running costs by type, each cost, and who shares them (and their part so far). */
function VehicleCosts({ a }: { a: Asset }) {
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const totals = Object.entries(a.cost_totals || {}).sort((x, y) => y[1].minor - x[1].minor);
  const people = [...new Map(a.sharers.map(s => [s.member_id || s.contact_id || '', s])).values()];
  const keyOf = (s: { member_id?: string | null; contact_id?: string | null }) => s.member_id || s.contact_id;
  return (
    <>
      <Section title="Costs" action={<button className="link-btn" onClick={() => setAdding(true)}>Add</button>}>
        {totals.length ? (
          <div className="glass card stack-sm">
            {totals.map(([k, v]) => (
              <div key={k} className="stack-sm"><div className="between"><span style={{ textTransform: 'capitalize' }}>{k}</span><Money m={v} /></div><Meter pct={pctOf(v, a.cost_total!)} /></div>
            ))}
            <div className="between" style={{ marginTop: 6 }}><b>All costs</b><b><Money m={a.cost_total} /></b></div>
            {(a.sharer_totals || []).length > 0 && <div className="between"><span>Your part</span><span><Money m={a.my_cost_total} /></span></div>}
            {a.monthly_cost.minor > 0 && <span className="caption">Last 3 months: <Money m={a.my_monthly_cost} /> a month is yours{a.financed.minor ? ' (with the EMI)' : ''}.</span>}
          </div>
        ) : <p className="caption" style={{ marginLeft: 4 }}>Tag fuel, service, insurance and other payments to see what this vehicle costs.</p>}
        {!!a.costs?.length && (
          <List>{a.costs.slice(0, 25).map(c => (
            <ListRow key={c.txn_id} icon={<CategoryTile category={c.cost_type === 'fuel' ? 'Fuel' : null} merchant={c.merchant} />} title={c.merchant}
              sub={<><span style={{ textTransform: 'capitalize' }}>{c.cost_type}</span> · {shortDate(c.day)}</>} end={<Money m={c.amount} />} />
          ))}</List>
        )}
      </Section>
      <Section title="Shared with" action={<button className="link-btn" onClick={() => setSharing(true)}>{a.sharers.length ? 'Edit' : 'Add'}</button>}>
        {people.length ? (
          <List>{people.map(p => (
            <ListRow key={keyOf(p)} icon={<Avatar name={p.name || '?'} />} title={p.name}
              sub={a.sharers.filter(s => keyOf(s) === keyOf(p)).map(s => `${s.share_pct}% of ${s.cost_type === '*' ? 'all costs' : s.cost_type}`).join(' · ')}
              end={<Money m={a.sharer_totals?.find(t => keyOf(t) === keyOf(p))?.amount || { minor: 0, currency: a.currency }} />} endSub="their part" />
          ))}</List>
        ) : <p className="caption" style={{ marginLeft: 4 }}>Share fuel or every cost with family or friends: their part leaves your spending.</p>}
      </Section>
      <AddCostSheet a={a} open={adding} onClose={() => setAdding(false)} />
      {sharing && <SharersSheet a={a} onClose={() => setSharing(false)} />}
    </>
  );
}

function AddCostSheet({ a, open, onClose }: { a: Asset; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('fuel');
  const txns = useApi<{ items: Txn[] }>(open ? '/transactions' : null, { q, limit: 40 });
  const add = useWrite<{ txn_id: string; cost_type: string }>('POST', `/assets/${a.id}/costs`);
  const toast = useToast();
  const tagged = new Set((a.costs || []).map(c => c.txn_id));
  const pick = async (t: Txn) => { await add.mutateAsync({ txn_id: t.id, cost_type: type }); toast(`${t.merchant} added as ${type}`); };
  return (
    <Sheet open={open} onClose={onClose} title="Add a cost" detent="large">
      <div className="stack">
        <div className="chips" style={{ flexWrap: 'wrap' }} aria-label="Cost type">{COST_TYPES.map(k => <Chip key={k} on={type === k} onClick={() => setType(k)}>{k[0].toUpperCase() + k.slice(1)}</Chip>)}</div>
        <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search payments (Aldrees, Toyota, Tawuniya…)" aria-label="Search payments" />
        {add.error && <p className="error" role="alert">{add.error.message}</p>}
        {txns.isLoading ? <PageSkeleton /> : (
          <List>{(txns.data?.items || []).filter(t => t.direction === 'debit').map(t => (
            <ListRow key={t.id} icon={<CategoryTile category={t.category} merchant={t.merchant} />} title={t.merchant} sub={`${shortDate(t.day)}${t.account_name ? ' · ' + t.account_name : ''}`}
              end={<Money m={t.amount} />} endSub={tagged.has(t.id) ? <span className="badge green">Added</span> : undefined} onClick={tagged.has(t.id) ? undefined : () => pick(t)} chevron={false} />
          ))}</List>
        )}
      </div>
    </Sheet>
  );
}

function SharersSheet({ a, onClose }: { a: Asset; onClose: () => void }) {
  const hh = useApi<HouseholdFull>('/households/current');
  const [rows, setRows] = useState(() => a.sharers.map(s => ({ who: s.member_id ? 'member_id:' + s.member_id : 'contact_id:' + s.contact_id, type: s.cost_type, pct: String(s.share_pct) })));
  const put = useWrite<{ items: Record<string, unknown>[] }>('PUT', `/assets/${a.id}/sharers`);
  const toast = useToast();
  const types = [...new Set(['*', ...COST_TYPES, ...Object.keys(a.cost_totals || {}), ...rows.map(r => r.type)])];
  const setRow = (i: number, k: 'who' | 'type' | 'pct', v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const ready = rows.filter(r => r.who && Number(r.pct) > 0);
  const save = async () => {
    try {
      await put.mutateAsync({ items: ready.map(r => { const [k, id] = r.who.split(':'); return { [k]: id, cost_type: r.type, share_pct: Math.min(100, Math.round(Number(r.pct))) }; }) });
      toast('Sharing saved'); onClose();
    } catch { /* shown below */ }
  };
  return (
    <Sheet open onClose={onClose} title="Who shares the costs">
      <div className="stack">
        {rows.map((r, i) => (
          <div key={i} className="glass card stack-sm">
            <Field label="Person">
              <select className="input" value={r.who} onChange={e => setRow(i, 'who', e.target.value)}>
                <option value="">Choose…</option>
                <optgroup label="Family">{(hh.data?.members || []).map(m => <option key={m.id} value={'member_id:' + m.id}>{m.display_name}</option>)}</optgroup>
                <optgroup label="Friends">{(hh.data?.contacts || []).map(c => <option key={c.id} value={'contact_id:' + c.id}>{c.name}</option>)}</optgroup>
              </select>
            </Field>
            <div className="grid-2">
              <Field label="Of"><select className="input" value={r.type} onChange={e => setRow(i, 'type', e.target.value)}>{types.map(t => <option key={t} value={t}>{t === '*' ? 'All costs' : t}</option>)}</select></Field>
              <Field label="Share %"><input className="input" inputMode="numeric" maxLength={3} value={r.pct} onChange={e => setRow(i, 'pct', e.target.value.replace(/\D/g, ''))} /></Field>
            </div>
            <button className="link-btn" style={{ color: 'var(--red)', alignSelf: 'flex-start' }} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button className="btn block secondary" onClick={() => setRows([...rows, { who: '', type: 'fuel', pct: '50' }])}><Icon name="plus" />Add a person</button>
        <p className="footnote">Add friends under People first. Their share of each tagged cost is left out of your spending.</p>
        {put.error && <p className="error" role="alert">{put.error.message}</p>}
        <button className="btn block" disabled={put.isPending || ready.length !== rows.length} onClick={save}>Save</button>
      </div>
    </Sheet>
  );
}

/* ---------- Import statements ---------- */
export function ImportPage() {
  const accounts = useApi<{ items: Account[] }>('/accounts');
  const list = useApi<{ items: Statement[] }>('/ingest/statements');
  const [params] = useSearchParams();
  const [account, setAccount] = useState(params.get('account') || '');
  const [password, setPassword] = useState('');
  const [res, setRes] = useState<{ rows: number; new: number; duplicates: number } | null>(null);
  const up = useWrite<Record<string, unknown>, { rows: number; new: number; duplicates: number }>('POST', '/ingest/statement');
  const pick = async (f?: File) => {
    if (!f) return;
    if (f.size > 4 * 1024 * 1024) return alert('That file is over 4 MB. Split it by year and try again.');
    setRes(await up.mutateAsync({ account_id: account, file_name: f.name, data_base64: await readFile(f), password: password || undefined }));
  };
  const name = (id: string) => accounts.data?.items.find(a => a.id === id)?.institution || '';
  return (
    <Page title="Import statements" back="/more" subtitle="Years of history in one go. Duplicates of SMS are skipped.">
      {accounts.data && !accounts.data.items.length ? <EmptyState icon="bank" title="Add an account first" text="Each statement belongs to an account, so its transactions are tagged to the right bank or card."
        action={<Link to="/more/accounts" className="btn small">Add account</Link>} /> : <div className="glass card stack">
        <Field label="Account">
          <select className="input" value={account} onChange={e => setAccount(e.target.value)}>
            <option value="">Choose…</option>
            {(accounts.data?.items || []).filter(a => a.kind !== 'loan').map(a => <option key={a.id} value={a.id}>{a.institution} · {a.name}{a.last4 ? ` ··${a.last4}` : ''}</option>)}
          </select>
        </Field>
        <Field label="PDF password (if any)"><input className="input" type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} placeholder="Often your customer ID or DOB" /></Field>
        <label className="btn block" aria-disabled={!account} style={{ cursor: account ? 'pointer' : 'default', opacity: account ? 1 : .5 }}>
          <Icon name="upload" />{up.isPending ? 'Reading…' : 'Choose PDF, Excel or CSV'}
          <input type="file" accept=".pdf,.xlsx,.xls,.csv" className="sr-only" disabled={!account} onChange={e => pick(e.target.files?.[0])} />
        </label>
        {up.error && <p className="error" role="alert">{up.error.message}</p>}
        {res && <p className="pos" role="status"><Icon name="check" size={16} /> {res.new} new transactions · {res.duplicates} already known · {res.rows} rows read</p>}
      </div>}
      <Section title="Imported">
        {list.data?.items.length ? (
          <List>{list.data.items.map(s => <ListRow key={s.id} icon={<Tile icon="receipt" color="#30b0c7" />} title={s.file_name} sub={`${name(s.account_id)} · ${shortDate(s.period_from)} – ${shortDate(s.period_to)}`} end={`${s.rows}`} endSub="rows" />)}</List>
        ) : <p className="caption" style={{ marginLeft: 4 }}>Nothing imported yet. Each statement you add is listed here with its dates, so you can see which months are covered.</p>}
      </Section>
    </Page>
  );
}

/* ---------- Phones & Shortcut ---------- */
export function DevicesPage() {
  const q = useApi<{ items: Device[] }>('/devices');
  const log = useApi<{ items: { at: string; device: string; sender: string; outcome: string }[] }>('/ingest/log');
  const [platform, setPlatform] = useState<'iphone' | 'android'>(/android/i.test(navigator.userAgent) ? 'android' : 'iphone');
  const [made, setMade] = useState<DeviceCreated | null>(null);
  const add = useWrite<Record<string, unknown>, DeviceCreated>('POST', '/devices');
  const del = useWrite<{ id: string }>('DELETE', b => `/devices/${b.id}`);
  const toast = useToast();
  const create = async () => {
    const r = await add.mutateAsync({ name: platform === 'iphone' ? 'iPhone' : 'Android phone', platform });
    setMade(r);
    copy(r.setup, toast, 'Setup copied — now open the Shortcut');
  };
  return (
    <Page title="Phones" back="/more" subtitle="Bank SMS go straight in. Each phone gets its own key.">
      <Segmented label="Phone type" value={platform} onChange={setPlatform} options={[{ value: 'iphone', label: 'iPhone' }, { value: 'android', label: 'Android' }]} />
      {platform === 'iphone' ? (
        <div className="glass card stack">
          <div className="steps">
            <div className="step"><span className="n">1</span><div><b>Copy your setup</b><p className="caption">Tap below — it copies a private key for this phone.</p></div></div>
            <div className="step"><span className="n">2</span><div><b>Install the Shortcut</b><p className="caption">It reads the setup from your clipboard once.</p></div></div>
            <div className="step"><span className="n">3</span><div><b>Add a Messages automation</b><p className="caption">Shortcuts → Automation → New → <b>Message</b> → Sender contains your bank (e.g. <i>AlRajhi</i>, <i>HDFCBK</i>) → Run Immediately → <b>Ledger: Send SMS</b>.</p>
              <div className="illus row-flex" aria-hidden><Icon name="bubble" size={20} /><Icon name="chevR" size={14} /><Icon name="sparkle" size={20} /><Icon name="chevR" size={14} /><img src="/icon.svg" width={22} height={22} alt="" style={{ borderRadius: 6 }} /><span className="caption">SMS → Shortcut → Ledger</span></div></div></div>
          </div>
          {made ? (
            <>
              <button className="btn block secondary" onClick={() => copy(made.setup, toast, 'Setup copied')}><Icon name="copy" />Copy setup again</button>
              {made.shortcut_url && <a className="btn block" href={made.shortcut_url}><Icon name="download" />Install Shortcut</a>}
              <p className="footnote">The key is shown once. If you lose it, remove this phone and add it again.</p>
            </>
          ) : <button className="btn block" onClick={create} disabled={add.isPending}><Icon name="copy" />Copy setup for this iPhone</button>}
        </div>
      ) : (
        <div className="glass card stack">
          <div className="steps">
            <div className="step"><span className="n">1</span><div><b>Install the Ledger SMS app</b><p className="caption">From the link your household owner shares (APK).</p></div></div>
            <div className="step"><span className="n">2</span><div><b>Paste the setup</b><p className="caption">Open the app → Paste setup. Allow SMS access when asked.</p></div></div>
            <div className="step"><span className="n">3</span><div><b>That’s it</b><p className="caption">New bank SMS arrive here within seconds. Old ones: tap “Send last 90 days”.</p></div></div>
          </div>
          {made ? <button className="btn block secondary" onClick={() => copy(made.setup, toast, 'Setup copied')}><Icon name="copy" />Copy setup again</button>
            : <button className="btn block" onClick={create} disabled={add.isPending}><Icon name="copy" />Copy setup for this phone</button>}
        </div>
      )}
      <Section title="Connected phones">
        {q.data?.items.length ? (
          <List>{q.data.items.map(d => (
            <ListRow key={d.id} icon={<Tile icon="phone" color={d.platform === 'iphone' ? '#0a84ff' : '#34c759'} />} title={d.name}
              sub={d.last_seen ? `Last sent ${new Date(d.last_seen).toLocaleString('en', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Waiting for the first SMS'}
              end={<button className="link-btn" style={{ color: 'var(--red)' }} onClick={async () => { if (confirm(`Remove ${d.name}? It stops sending.`)) { await del.mutateAsync({ id: d.id }); toast('Removed'); } }}>Remove</button>} />
          ))}</List>
        ) : <p className="caption" style={{ marginLeft: 4 }}>No phones yet.</p>}
      </Section>
      {log.data && log.data.items.length > 0 && (
        <Section title="Recent deliveries">
          <List>{log.data.items.slice(0, 8).map((l, i) => <ListRow key={i} title={l.sender} sub={`${l.device} · ${new Date(l.at).toLocaleString('en', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}`} end={<span className={`badge ${l.outcome === 'stored' ? 'green' : ''}`}>{l.outcome}</span>} />)}</List>
        </Section>
      )}
    </Page>
  );
}

/* ---------- Connect Claude ---------- */
export function ClaudePage() {
  const q = useApi<{ url: string }>('/mcp-key');
  const rotate = useWrite('POST', '/mcp-key');
  const toast = useToast();
  return (
    <Page title="Connect Claude" back="/more" subtitle="Ask “can I afford a trip home in March?” and get answers from your real numbers.">
      <div className="glass card stack">
        <div className="steps">
          <div className="step"><span className="n">1</span><div><b>Copy your link</b><p className="caption">It’s private — anyone with it can read your household’s money.</p></div></div>
          <div className="step"><span className="n">2</span><div><b>Add it in Claude</b><p className="caption">Settings → Connectors → Add custom connector → paste.</p></div></div>
          <div className="step"><span className="n">3</span><div><b>Ask away</b><p className="caption">“What did we spend on groceries this month?” · “When am I debt-free if I add SAR 1,000 a month?”</p></div></div>
        </div>
        {q.data ? <p className="code">{q.data.url}</p> : <div className="skel" style={{ height: 40 }} />}
        <button className="btn block" disabled={!q.data} onClick={() => copy(q.data!.url, toast, 'Link copied')}><Icon name="copy" />Copy link</button>
        <button className="btn block danger" onClick={async () => { if (confirm('Make a new link? The old one stops working.')) { await rotate.mutateAsync(undefined); toast('New link made'); } }}>Make a new link</button>
      </div>
    </Page>
  );
}

/* ---------- Household ---------- */
export function HouseholdPage({ me }: { me: Me }) {
  const q = useApi<HouseholdFull>('/households/current');
  const [inviting, setInviting] = useState(false);
  const del = useWrite<{ id: string }>('DELETE', b => `/invites/${b.id}`);
  const switchTo = useWrite<{ household_id: string }>('POST', '/households/switch');
  const toast = useToast();
  const admin = me.member.role === 'owner' || me.member.role === 'admin';
  return (
    <Page title="Household" back="/more" trail={admin && <button className="icon-btn" onClick={() => setInviting(true)} aria-label="Add member"><Icon name="plus" /></button>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : (
        <>
          <Section title={q.data!.household.name}>
            <List>{q.data!.members.map(m => (
              <ListRow key={m.id} icon={<Avatar name={m.display_name} photo={m.photo} />} title={m.display_name} sub={`${m.relation}${m.email ? ' · ' + m.email : ''}`} end={<span className="badge">{m.role}</span>} endSub={m.user_id ? 'on app' : 'no login'} />
            ))}</List>
          </Section>
          {q.data!.invites.length > 0 && (
            <Section title="Pending invites">
              <List>{q.data!.invites.map(i => (
                <ListRow key={i.id} icon={<Tile icon="mail" color="#ff9f0a" />} title={i.email} sub={i.expires_at ? `Expires ${shortDate(i.expires_at.slice(0, 10))}` : undefined}
                  end={<span className="row-flex" style={{ gap: 0 }}>
                    {i.link && <button className="link-btn" onClick={() => copy(i.link!, toast, 'Invite link copied')}>Copy</button>}
                    <button className="link-btn" style={{ color: 'var(--red)' }} onClick={() => del.mutate({ id: i.id })}>Cancel</button></span>} />
              ))}</List>
            </Section>
          )}
          {!!q.data!.resets?.length && (
            <Section title="Password reset links">
              <p className="caption" style={{ marginLeft: 4 }}>Email isn’t set up, so send these yourself.</p>
              <List>{q.data!.resets.map(r => <ListRow key={r.link} icon={<Tile icon="key" color="#8e8e93" />} title={r.name} sub={r.email} end={<button className="link-btn" onClick={() => copy(r.link, toast, 'Reset link copied')}>Copy</button>} />)}</List>
            </Section>
          )}
          {me.households.length > 1 && (
            <Section title="Your households">
              <List>{me.households.map(h => (
                <ListRow key={h.id} icon={<Tile icon="family" color="#ff375f" />} title={h.name} sub={h.role}
                  end={h.id === me.household.id ? <Icon name="check" size={20} className="pos" /> : undefined}
                  onClick={h.id === me.household.id ? undefined : async () => { await switchTo.mutateAsync({ household_id: h.id }); toast(`Switched to ${h.name}`); }} chevron={false} />
              ))}</List>
            </Section>
          )}
        </>
      )}
      <InviteSheet open={inviting} onClose={() => setInviting(false)} />
    </Page>
  );
}

/* ---------- Profile & password ---------- */
export function ProfilePage({ me }: { me: Me }) {
  const [name, setName] = useState(me.user.name);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const save = useWrite('PATCH', '/auth/me');
  const pw = useWrite('POST', '/auth/password');
  const toast = useToast();
  return (
    <Page title="Profile" back="/more">
      <div className="glass card stack">
        <div style={{ display: 'grid', placeItems: 'center' }}><Avatar name={name || '?'} size={72} /></div>
        <Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></Field>
        <Field label="Email"><input className="input" value={me.user.email} disabled /></Field>
        <button className="btn block secondary" disabled={!name || name === me.user.name || save.isPending} onClick={async () => { await save.mutateAsync({ name }); toast('Saved'); }}>Save</button>
      </div>
      <Section title="Change password">
        <form className="glass card stack" onSubmit={async e => {
          e.preventDefault();
          try { await pw.mutateAsync({ current: cur, new: next }); toast('Password changed — other devices signed out'); setCur(''); setNext(''); } catch { /* shown below */ }
        }}>
          <input type="text" autoComplete="username" value={me.user.email} readOnly hidden />
          <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} required /></Field>
          <Field label="New password"><input className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={e => setNext(e.target.value)} required placeholder="At least 8 characters" /></Field>
          {pw.error && <p className="error" role="alert">{pw.error.status === 403 ? 'Current password is wrong.' : pw.error.message}</p>}
          <button className="btn block" disabled={pw.isPending || !cur || next.length < 8}>Change password</button>
        </form>
      </Section>
    </Page>
  );
}

/* ---------- Settings ---------- */
const DAYS = [1, 25, 27, 28, 30];
const ZONES = ['Asia/Riyadh', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Qatar', 'Europe/London'];
export function SettingsPage({ me }: { me: Me }) {
  const q = useApi<Settings>('/settings');
  const hist = useApi<{ items: SalaryEntry[]; expected_this_month: MoneyT }>('/salary');
  const [addingPay, setAddingPay] = useState(false);
  const put = useWrite('PUT', '/settings');
  const hh = useWrite('PATCH', '/households/current');
  const toast = useToast();
  const [salary, setSalary] = useState<string | null>(null);
  const s = q.data;
  const cur = s?.salary?.currency || me.household.base_currency;
  const set = async (body: Record<string, unknown>) => { await put.mutateAsync(body); toast('Saved'); };
  return (
    <Page title="Settings" back="/more">
      {!s ? <PageSkeleton /> : (
        <>
          <Section title="Salary">
            <div className="glass card stack">
              {hist.data?.items.length ? (
                <div className="between"><span>Expected this month</span><b><Money m={hist.data.expected_this_month} /></b></div>
              ) : (
                <>
                  <AmountInput value={salary ?? (s.salary ? String(major(s.salary)) : '')} onChange={setSalary} currency={cur} label="Monthly salary" />
                  {salary !== null && <button className="btn block" onClick={() => set({ salary_minor: toMinor(Number(salary), cur), salary_currency: cur })}>Save salary</button>}
                </>
              )}
              <span className="caption">Paid on day</span>
              <div className="chips" style={{ flexWrap: 'wrap' }}>{DAYS.map(d => <Chip key={d} on={s.salary_day === d} onClick={() => set({ salary_day: d })}>{d === 1 ? '1st' : d}</Chip>)}</div>
            </div>
          </Section>
          <Section title="Salary history" action={<button className="link-btn" onClick={() => setAddingPay(true)}>Add</button>}>
            {hist.data?.items.length ? (
              <List>{hist.data.items.map(e => <SalaryRow key={e.id} e={e} />)}</List>
            ) : <p className="caption" style={{ marginLeft: 4 }}>A raise from a month on, or arrears and bonuses paid once: plans use the right pay for each month.</p>}
          </Section>
          <Section title="Paying off debt">
            <div className="glass card stack">
              <Segmented label="Strategy" value={s.debt_strategy} onChange={v => set({ debt_strategy: v })} options={[{ value: 'avalanche', label: 'Highest rate first' }, { value: 'snowball', label: 'Smallest first' }]} />
              <span className="caption">Emergency fund target: months of expenses</span>
              <div className="chips">{[3, 6, 9, 12].map(n => <Chip key={n} on={s.emergency_months === n} onClick={() => set({ emergency_months: n })}>{n} months</Chip>)}</div>
            </div>
          </Section>
          <Section title="Comparing purchases">
            <div className="glass card stack">
              <div className="grid-2">{['INR', 'SAR'].map(c => (
                <Field key={c} label={`${c} FD rate (% a year)`}>
                  <input className="input" inputMode="decimal" defaultValue={((s.fd_rates_bp?.[c] ?? (c === 'INR' ? 700 : 500)) / 100).toString()}
                    onBlur={e => { const bp = Math.round(Number(e.target.value) * 100); if (bp >= 0 && bp <= 3000 && bp !== s.fd_rates_bp?.[c]) set({ fd_rates_bp: { INR: 700, SAR: 500, ...s.fd_rates_bp, [c]: bp } }); }} />
                </Field>
              ))}</div>
              <span className="footnote">Your assets are compared with a fixed deposit at this rate on the same money: “was it a good buy?”</span>
            </div>
          </Section>
          <Section title="Household">
            <div className="glass card stack">
              <span className="caption">Main currency (where you earn)</span>
              <Segmented label="Base currency" value={me.household.base_currency} onChange={v => hh.mutateAsync({ base_currency: v }).then(() => toast('Saved'))} options={[{ value: 'SAR', label: 'SAR' }, { value: 'AED', label: 'AED' }, { value: 'INR', label: 'INR' }]} />
              <span className="caption">Home currency</span>
              <Segmented label="Home currency" value={me.household.home_currency} onChange={v => hh.mutateAsync({ home_currency: v }).then(() => toast('Saved'))} options={[{ value: 'INR', label: 'INR' }, { value: 'SAR', label: 'SAR' }]} />
              <Field label="Timezone">
                <select className="input" value={me.household.timezone} onChange={e => hh.mutateAsync({ timezone: e.target.value }).then(() => toast('Saved'))}>
                  {[...new Set([me.household.timezone, ...ZONES])].map(z => <option key={z}>{z}</option>)}
                </select>
              </Field>
            </div>
          </Section>
        </>
      )}
      <AddSalarySheet me={me} open={addingPay} onClose={() => setAddingPay(false)} />
    </Page>
  );
}

const PAY_KIND = { base: ['Base pay', 'briefcase', '#0a84ff', 'From'], arrears: ['Arrears', 'coin', '#30d158', 'Paid in'], bonus: ['Bonus', 'sparkle', '#ff9f0a', 'Paid in'] } as const;
function SalaryRow({ e }: { e: SalaryEntry }) {
  const del = useWrite<{ id: string }>('DELETE', b => `/salary/${b.id}`);
  const toast = useToast();
  const [label, icon, color, when] = PAY_KIND[e.kind];
  return (
    <ListRow icon={<Tile icon={icon} color={color} />} title={<>{label} <Money m={e.amount} /></>} chevron={false}
      sub={`${when} ${monthLabel(e.from_month, true)}${e.member_name ? ' · ' + e.member_name : ''}${e.note ? ' · ' + e.note : ''}`}
      end={<button className="link-btn" style={{ color: 'var(--red)' }} aria-label={`Remove ${label} from ${e.from_month}`}
        onClick={async () => { if (confirm(`Remove ${label.toLowerCase()} from ${monthLabel(e.from_month, true)}?`)) { await del.mutateAsync({ id: e.id }); toast('Removed'); } }}>Remove</button>} />
  );
}

function AddSalarySheet({ me, open, onClose }: { me: Me; open: boolean; onClose: () => void }) {
  const hh = useApi<HouseholdFull>(open ? '/households/current' : null);
  const [kind, setKind] = useState<SalaryEntry['kind']>('base');
  const [month, setMonth] = useState(thisMonth());
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(me.household.base_currency);
  const [member, setMember] = useState(me.member.id);
  const [note, setNote] = useState('');
  const add = useWrite<Record<string, unknown>>('POST', '/salary');
  const toast = useToast();
  const save = async () => {
    try {
      await add.mutateAsync({ kind, from_month: month, amount_minor: toMinor(Number(amount), currency), currency, member_id: member, note });
      toast('Salary saved'); setAmount(''); setNote(''); onClose();
    } catch { /* shown below */ }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add salary">
      <div className="stack">
        <Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: 'base', label: 'Base pay' }, { value: 'arrears', label: 'Arrears' }, { value: 'bonus', label: 'Bonus' }]} />
        <AmountInput value={amount} onChange={setAmount} currency={currency} onCurrency={setCurrency} label="Amount" />
        <Field label={kind === 'base' ? 'From month (each month after, until the next raise)' : 'Paid in month (once)'}>
          <input className="input" type="month" value={month} onChange={e => setMonth(e.target.value)} />
        </Field>
        {(hh.data?.members.length || 0) > 1 && (
          <Field label="Whose pay">
            <select className="input" value={member} onChange={e => setMember(e.target.value)}>{hh.data!.members.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>
          </Field>
        )}
        <Field label="Note"><input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="New grade, annual raise…" maxLength={200} /></Field>
        {add.error && <p className="error" role="alert">{add.error.message}</p>}
        <button className="btn block" disabled={!(Number(amount) > 0) || !/^\d{4}-\d\d$/.test(month) || add.isPending} onClick={save}>Save</button>
      </div>
    </Sheet>
  );
}
