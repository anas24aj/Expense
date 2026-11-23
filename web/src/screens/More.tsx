import { Fragment, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, useApi, useWrite } from '../api/client';
import type { Account, Asset, Coverage, DeviceCreated, Device, HouseholdFull, Me, Settings, Statement } from '../api/types';
import { fmt, major, shortDate, toMinor } from '../lib/format';
import {
  AmountInput, Avatar, brandOf, CategoryTile, Chip, EmptyState, ErrorCard, Field, Icon, List, ListRow, Meter, Money, Page, PageSkeleton, ProgressRing, Section, Segmented, Sheet, Tile, useToast,
} from '../ui';
import { copy, InviteSheet } from './People';
import { readFile } from './files';

export function MorePage({ me }: { me: Me }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const signOut = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); qc.clear(); nav('/signin', { replace: true }); };
  const rows: [string, string, string, string, string?][][] = [
    [['/more/accounts', 'Accounts & cards', 'bank', '#0a84ff', 'Balances and card limits'], ['/more/assets', 'Property, vehicles & investments', 'building', '#a2845e'], ['/more/flows', 'Money flow', 'chart', '#bf5af2', 'Income → accounts → spending'], ['/more/trips', 'Trips', 'plane', '#32ade6', 'Business trips and what to claim']],
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
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : (
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
                      {brandOf(a.institution) ? <CategoryTile category={null} merchant={a.institution} /> : <Tile icon={KIND_TILE[kind][0]} color={KIND_TILE[kind][1]} />}
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
  const [last4, setLast4] = useState('');
  const add = useWrite('POST', '/accounts');
  const toast = useToast();
  const save = async () => {
    await add.mutateAsync({ kind, institution, name: institution, currency, country: currency === 'INR' ? 'IN' : 'SA', last4: last4 || undefined });
    toast(`${institution} added`); setInstitution(''); setLast4(''); onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add account">
      <div className="stack">
        <div className="chips" style={{ flexWrap: 'wrap' }}>{['bank', 'credit_card', 'wallet', 'bnpl', 'cash'].map(k => <Chip key={k} on={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k].replace(/s$/, '')}</Chip>)}</div>
        <Field label="Bank or app"><input className="input" value={institution} onChange={e => setInstitution(e.target.value)} placeholder="Al Rajhi, HDFC, STC Pay…" autoFocus /></Field>
        <Segmented label="Currency" value={currency} onChange={setCurrency} options={[{ value: 'SAR', label: 'SAR' }, { value: 'INR', label: 'INR ₹' }]} />
        <Field label="Last 4 digits (helps match SMS)"><input className="input" inputMode="numeric" maxLength={4} value={last4} onChange={e => setLast4(e.target.value.replace(/\D/g, ''))} /></Field>
        <button className="btn block" disabled={!institution || add.isPending} onClick={save}>Add</button>
        <p className="footnote" style={{ textAlign: 'center' }}>Usually not needed — accounts appear on their own from your bank SMS.</p>
      </div>
    </Sheet>
  );
}

/* ---------- Assets ---------- */
const ASSET_TILE: Record<string, [string, string]> = { property: ['building', '#a2845e'], vehicle: ['car', '#0a84ff'], investment: ['chart', '#30d158'] };
export function AssetsPage() {
  const q = useApi<{ items: Asset[] }>('/assets');
  return (
    <Page title="What you own" back="/more">
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !q.data!.items.length ? <EmptyState icon="building" title="Nothing yet" text="Property, vehicles and investments show here." /> : (
        (['property', 'vehicle', 'investment'] as const).map(k => {
          const items = q.data!.items.filter(a => a.kind === k);
          if (!items.length) return null;
          return (
            <Section key={k} title={{ property: 'Property', vehicle: 'Vehicles', investment: 'Investments' }[k]}>
              <List>{items.map(a => (
                <ListRow key={a.id} to={`/more/assets/${a.id}`} icon={<Tile icon={ASSET_TILE[k][0]} color={ASSET_TILE[k][1]} />} title={a.name}
                  sub={k === 'property' ? `${Math.round((a.paid.minor / a.cost.minor) * 100)}% paid · next: ${a.next_milestone?.name || '—'}` : k === 'vehicle' ? <>Costs <Money m={a.my_monthly_cost} />/mo (your share)</> : <>Invested <Money m={a.cost} compact /></>}
                  end={<Money m={a.value} compact />} endSub={k === 'investment' ? <span className="pos">+{(((a.value.minor - a.cost.minor) / a.cost.minor) * 100).toFixed(1)}%</span> : 'value'} />
              ))}</List>
            </Section>
          );
        })
      )}
    </Page>
  );
}

export function AssetPage() {
  const { id } = useParams();
  const q = useApi<Asset>(`/assets/${id}`);
  const a = q.data;
  return (
    <Page title={a?.name || 'Asset'} back="/more/assets">
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : a && (
        <div className="grid-desktop stack">
          <section className="glass hero span-2 row-flex" style={{ gap: 18 }}>
            <ProgressRing pct={(a.paid.minor / Math.max(1, a.cost.minor)) * 100} size={96} stroke={10} color="var(--green-fill)" />
            <div className="stack-sm" style={{ flex: 1, minWidth: 0 }}>
              <span className="hero-label">{a.kind === 'investment' ? 'Current value' : 'Paid so far'}</span>
              <span style={{ font: '700 30px var(--font-display)', letterSpacing: '-.03em' }} className="num">{fmt(a.kind === 'investment' ? a.value : a.paid)}</span>
              <span className="caption">of <Money m={a.cost} /> {a.kind === 'investment' ? 'invested' : 'total cost'}</span>
            </div>
          </section>
          {a.kind !== 'investment' && (
            <div className="grid-2 span-2">
              <div className="glass card stat"><span className="k">By loan</span><span className="v"><Money m={a.financed} compact /></span></div>
              <div className="glass card stat"><span className="k">Still to pay</span><span className="v warn"><Money m={a.remaining} compact /></span></div>
            </div>
          )}
          {a.milestones.length > 0 && (
            <Section title="Milestones">
              <List>{a.milestones.map(m => (
                <ListRow key={m.id} icon={<span className="icon-tile" style={{ background: m.paid ? 'var(--green-fill)' : m === a.next_milestone || m.id === a.next_milestone?.id ? 'var(--orange-fill)' : 'var(--fill-2)' }}><Icon name={m.paid ? 'check' : 'calendar'} /></span>}
                  title={m.name} sub={shortDate(m.due_on)} end={<Money m={m.amount} compact />} endSub={m.paid ? <span className="badge green">Paid</span> : m.id === a.next_milestone?.id ? <span className="badge orange">Next</span> : undefined} />
              ))}</List>
            </Section>
          )}
          {Object.keys(a.costs_by_type).length > 0 && (
            <Section title="Monthly costs">
              <div className="glass card stack-sm">
                {Object.entries(a.costs_by_type).map(([k, v]) => {
                  const sh = a.sharers.find(s => s.cost_type === k);
                  return (
                    <div key={k} className="stack-sm">
                      <div className="between"><span>{k}{sh && <span className="caption"> · {sh.share_pct}% {sh.name.split(' ')[0]}</span>}</span><Money m={v} /></div>
                      <Meter pct={(v.minor / Math.max(1, a.monthly_cost.minor)) * 100} />
                    </div>
                  );
                })}
                <div className="between" style={{ marginTop: 6 }}><b>Your share</b><b><Money m={a.my_monthly_cost} />/mo</b></div>
              </div>
            </Section>
          )}
          <Section title="Details">
            <dl className="kv glass card">{Object.entries(a.details).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v ?? '—'}</dd></Fragment>)}</dl>
          </Section>
        </div>
      )}
    </Page>
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
      <div className="glass card stack">
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
      </div>
      <Section title="Imported">
        {list.data?.items.length ? (
          <List>{list.data.items.map(s => <ListRow key={s.id} icon={<Tile icon="receipt" color="#30b0c7" />} title={s.file_name} sub={`${name(s.account_id)} · ${shortDate(s.period_from)} – ${shortDate(s.period_to)}`} end={`${s.rows}`} endSub="rows" />)}</List>
        ) : <p className="caption" style={{ marginLeft: 4 }}>Nothing imported yet.</p>}
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
              <ListRow key={m.id} icon={<Avatar name={m.display_name} />} title={m.display_name} sub={`${m.relation}${m.email ? ' · ' + m.email : ''}`} end={<span className="badge">{m.role}</span>} endSub={m.user_id ? 'on app' : 'no login'} />
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
              <AmountInput value={salary ?? (s.salary ? String(major(s.salary)) : '')} onChange={setSalary} currency={cur} label="Monthly salary" />
              {salary !== null && <button className="btn block" onClick={() => set({ salary_minor: toMinor(Number(salary), cur), salary_currency: cur })}>Save salary</button>}
              <span className="caption">Paid on day</span>
              <div className="chips" style={{ flexWrap: 'wrap' }}>{DAYS.map(d => <Chip key={d} on={s.salary_day === d} onClick={() => set({ salary_day: d })}>{d === 1 ? '1st' : d}</Chip>)}</div>
            </div>
          </Section>
          <Section title="Paying off debt">
            <div className="glass card stack">
              <Segmented label="Strategy" value={s.debt_strategy} onChange={v => set({ debt_strategy: v })} options={[{ value: 'avalanche', label: 'Highest rate first' }, { value: 'snowball', label: 'Smallest first' }]} />
              <span className="caption">Emergency fund target: months of expenses</span>
              <div className="chips">{[3, 6, 9, 12].map(n => <Chip key={n} on={s.emergency_months === n} onClick={() => set({ emergency_months: n })}>{n} months</Chip>)}</div>
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
    </Page>
  );
}
