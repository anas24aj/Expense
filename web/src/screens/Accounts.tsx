import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useApi, useWrite } from '../api/client';
import type { Account, Asset, Coverage, HouseholdFull, Liability, Member, NetWorth, Person, Txn, UsedBy } from '../api/types';
import { fmt, monthLabel, shortDate } from '../lib/format';
import { Avatar, BrandTile, brandOf, EmptyState, Field, logoOf, Sheet, ErrorCard, Icon, List, ListRow, Meter, Money, Page, PageSkeleton, Section, Tile } from '../ui';
import { TxnRow, TxnSheet } from './Activity';
import { FLAG } from './Home';
import { AddAccountSheet, AddAssetSheet, ASSET_TILE, EditAccountSheet, KIND_LABEL, KIND_TILE, countryOf } from './More';
import { PersonAvatar } from './People';

/** The next date a card's due day falls on, from today. */
export function nextDue(dom: number | null) {
  if (!dom) return null;
  const t = new Date(), d = new Date(t.getFullYear(), t.getMonth(), dom);
  if (d < new Date(t.getFullYear(), t.getMonth(), t.getDate())) d.setMonth(d.getMonth() + 1);
  return d.toLocaleDateString('en', { day: 'numeric', month: 'short' });
}
const owed = (a: Account) => Math.max(0, -(a.balance?.minor || 0));
const AccountTile = ({ a }: { a: Account }) => (brandOf(a.institution) || logoOf(a.institution) ? <BrandTile name={a.institution} />
  : <Tile icon={(KIND_TILE[a.kind] || KIND_TILE.bank)[0]} color={(KIND_TILE[a.kind] || KIND_TILE.bank)[1]} />);
const HOLD = ['bank', 'wallet', 'debit_card', 'investment', 'cash'];
const CARD = ['credit_card', 'bnpl'];
const ACOUNTRY: Record<string, string> = { SAR: 'SA', INR: 'IN' };
const cc = (a: Account) => (['IN', 'SA'].includes(countryOf(a)) ? countryOf(a) : 'OTHER');

function AccountLine({ a }: { a: Account }) {
  const card = CARD.includes(a.kind);
  const due = card ? nextDue(a.due_day) : null;
  return (
    <Link to={`/accounts/${a.id}`} className="list-row">
      <AccountTile a={a} />
      <div className="body">
        <div className="title">{a.institution || a.name}{a.last4 && <span className="caption"> ··{a.last4}</span>}</div>
        <div className="sub">{card ? (owed(a) ? <>Owed now{due ? ` · due ${due}` : ' · due date not set'}</> : 'Nothing owed') : a.name !== a.institution ? a.name : KIND_LABEL[a.kind]?.replace(/s$/, '')}</div>
      </div>
      <div className="end">
        <span className={`amt ${card && owed(a) ? 'neg' : a.balance && a.balance.minor < 0 ? 'neg' : ''}`}>{card ? <Money m={a.balance ? { ...a.balance, minor: owed(a) } : null} /> : <Money m={a.balance} />}</span>
        {card && a.credit_limit ? <span className="footnote">of <Money m={a.credit_limit} compact /></span> : a.balance_at ? <span className="footnote">{shortDate(a.balance_at.slice(0, 10))}</span> : null}
      </div>
      <Icon name="chevR" className="chev" />
    </Link>
  );
}

/** One owner's rows under a heading; the account owner's photo beside other members' names. */
function OwnerLists({ items, members, me, empty }: { items: Account[]; members: Member[]; me: string; empty?: React.ReactNode }) {
  const owners = [...new Set(items.map(a => a.owner_member_id || ''))].sort((x, y) => (x === me ? -1 : y === me ? 1 : x.localeCompare(y)));
  if (!items.length) return <>{empty}</>;
  return <>{owners.map(o => {
    const who = members.find(m => m.id === o);
    const mine = !o || o === me;
    return (
      <div key={o} className="stack-sm">
        {!mine && <div className="owner-h"><Avatar name={who?.display_name || '?'} photo={who?.photo} size={22} />{who?.display_name || 'Someone'}’s</div>}
        <List>{items.filter(a => (a.owner_member_id || '') === o).map(a => <AccountLine key={a.id} a={a} />)}</List>
      </div>
    );
  })}</>;
}

/** Accounts: India and Saudi, each totalled; inside, what you hold, cards (with what's owed and when), loans and property. */
export function AccountsPage() {
  const q = useApi<{ items: Account[] }>('/accounts');
  const nw = useApi<NetWorth>('/insights/networth');
  const liabs = useApi<{ items: Liability[] }>('/liabilities');
  const assets = useApi<{ items: Asset[] }>('/assets');
  const hh = useApi<HouseholdFull>('/households/current');
  const me = useApi<{ member: Member }>('/auth/me').data?.member.id || '';
  const cov = useApi<{ items: Coverage[] }>('/accounts/coverage');
  const [adding, setAdding] = useState<string | null>(null);
  const [addingAsset, setAddingAsset] = useState(false);
  const { hash } = useLocation();
  useEffect(() => { if (hash && q.data) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' }); }, [hash, q.data]);
  const items = (q.data?.items || []).filter(a => !a.archived);
  const members = hh.data?.members || [];
  const tracked = new Set((liabs.data?.items || []).map(l => l.account_id).filter(Boolean));
  const needs = (cov.data?.items || []).filter(c => c.status !== 'ok').length;
  const codes = ['IN', 'SA', ...(items.some(a => cc(a) === 'OTHER') ? ['OTHER'] : [])];
  return (
    <Page title="Accounts" back="/" trail={<button className="icon-btn" onClick={() => setAdding('SA')} aria-label="Add account"><Icon name="plus" /></button>}>
      {q.isLoading || nw.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : (
        <>
          {nw.data && (
            <div className="glass card grid-3" aria-label="Net worth">
              <div className="stat"><span className="k">Net worth</span><span className={`v ${nw.data.net.minor < 0 ? 'neg' : ''}`}><Money m={nw.data.net} compact /></span></div>
              <div className="stat"><span className="k">Own</span><span className="v"><Money m={nw.data.assets} compact /></span></div>
              <div className="stat"><span className="k">Owe</span><span className="v neg"><Money m={nw.data.liabilities} compact /></span></div>
            </div>
          )}
          {codes.map(code => {
            const here = items.filter(a => cc(a) === code);
            const tot = nw.data?.countries.find(c => c.code === code);
            const loans = (liabs.data?.items || []).filter(l => !l.closed && l.kind !== 'credit_card' && !(l.kind === 'bnpl' && l.account_id) && (ACOUNTRY[l.currency] || 'OTHER') === code && l.outstanding.minor > 0);
            const owned = (assets.data?.items || []).filter(a => (ACOUNTRY[a.currency] || 'OTHER') === code && a.status !== 'sold' && a.status !== 'written_off');
            const loanAccts = here.filter(a => a.kind === 'loan' && !tracked.has(a.id));
            const [flag, name] = FLAG[code];
            return (
              <section key={code} id={code} className="stack" style={{ scrollMarginTop: 70 }} aria-label={name}>
                <div className="country-head">
                  <h2>{flag} {name}</h2>
                  {tot && <div className="end"><span className={`num ${tot.net.minor < 0 ? 'neg' : ''}`} style={{ fontWeight: 700, fontSize: 20 }}><Money m={tot.net} /></span>
                    <span className="caption">own <Money m={tot.assets} compact /> · owe <Money m={tot.liabilities} compact /></span></div>}
                </div>
                <Section title="Bank accounts & wallets">
                  <OwnerLists items={here.filter(a => HOLD.includes(a.kind))} members={members} me={me}
                    empty={<button className="glass empty-row" onClick={() => setAdding(code)}><Icon name="plus" size={18} />Add a {name} bank account</button>} />
                </Section>
                <Section title="Credit cards">
                  <OwnerLists items={here.filter(a => CARD.includes(a.kind))} members={members} me={me}
                    empty={<button className="glass empty-row" onClick={() => setAdding(code)}><Icon name="card" size={18} />No {name === 'Saudi' ? 'Saudi' : 'Indian'} credit card yet · add one</button>} />
                </Section>
                {(loans.length > 0 || loanAccts.length > 0) && (
                  <Section title="Loans" action={<Link to="/plan#debts">Manage</Link>}>
                    <List>
                      {loans.map(l => <ListRow key={l.id} to={l.account_id ? `/accounts/${l.account_id}` : '/plan#debts'} icon={<BrandTile name={l.lender || l.name} />} title={l.name}
                        sub={<>EMI <Money m={l.emi} />{l.due_day ? ` · on the ${l.due_day}th` : ''}{l.paid_pct != null ? ` · ${l.paid_pct}% paid` : ''}</>} end={<span className="neg"><Money m={l.outstanding} /></span>} endSub="left to pay" />)}
                      {loanAccts.map(a => <AccountLine key={a.id} a={a} />)}
                    </List>
                  </Section>
                )}
                {owned.length > 0 && (
                  <Section title="Property & vehicles" action={<button onClick={() => setAddingAsset(true)}>Add</button>}>
                    <List>{owned.map(a => (
                      <ListRow key={a.id} to={`/assets/${a.id}`} icon={<Tile icon={ASSET_TILE[a.kind][0]} color={ASSET_TILE[a.kind][1]} />} title={a.name}
                        sub={a.kind === 'home' ? <>Rented home · costs <Money m={a.my_monthly_cost} />/mo yours</> : a.kind === 'property' && a.under_construction ? `Being built · ${Math.round((a.paid.minor / Math.max(1, a.cost.minor)) * 100)}% paid` : { property: 'Property', vehicle: 'Vehicle', investment: 'Investment', home: 'Home' }[a.kind]}
                        end={a.kind === 'home' ? <span className="caption">not owned</span> : <Money m={a.value} />} endSub={a.kind === 'home' ? undefined : 'worth now'} />
                    ))}</List>
                  </Section>
                )}
              </section>
            );
          })}
          <Link to="/accounts/coverage" className="glass pill-cta">
            <Tile icon={needs ? 'warn' : 'check'} color={needs ? '#ff9f0a' : '#30d158'} />
            <span style={{ flex: 1 }}><b>Up to date?</b><br /><span className="caption">{cov.data ? (needs ? `${needs} account${needs > 1 ? 's' : ''} with gaps or gone quiet` : 'Every account covered, no gaps') : 'Checking statements and SMS…'}</span></span>
            <Icon name="chevR" className="chev" size={14} />
          </Link>
        </>
      )}
      <AddAccountSheet open={!!adding} country={adding || 'SA'} onClose={() => setAdding(null)} />
      <AddAssetSheet open={addingAsset} onClose={() => setAddingAsset(false)} />
    </Page>
  );
}

/* ---------- Coverage: is every account up to date? ---------- */
const SRC_COLOR: Record<string, string> = { sms: 'var(--green-fill)', statement: 'var(--tint-fill)', manual: 'var(--orange-fill)', shortcut: 'var(--green-fill)', peer: '#bf5af2' };
const STATUS: Record<Coverage['status'], [string, string]> = { ok: ['green', 'Up to date'], gaps: ['red', 'Gaps'], stale: ['orange', 'Gone quiet'], no_data: ['', 'No data'] };

export function CoverageStrip({ c, size = 14 }: { c: Coverage; size?: number }) {
  const months = c.months.slice(-12);
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end' }} role="img"
      aria-label={months.map(m => `${monthLabel(m.month)}: ${m.covered ? m.sources.join(' and ') || 'covered' : 'missing'}`).join('; ')}>
      {months.map(m => {
        const src = m.sources.length ? m.sources : m.covered ? ['statement'] : [];
        return (
          <span key={m.month} title={`${monthLabel(m.month, true)} · ${m.covered ? src.join(' + ') : 'missing'}`}
            style={{ width: size, height: size + 4, borderRadius: 4, display: 'flex', flexDirection: 'column', overflow: 'hidden', flex: 'none',
              boxShadow: m.covered ? undefined : 'inset 0 0 0 1.5px var(--red-fill)', background: m.covered ? undefined : 'transparent' }}>
            {src.map(s => <i key={s} style={{ flex: 1, background: SRC_COLOR[s] || 'var(--fill-2)' }} />)}
          </span>
        );
      })}
    </div>
  );
}
const quiet = (c: Coverage) => (c.days_quiet === null ? 'No movements yet' : c.days_quiet === 0 ? 'Last movement today' : `Last movement ${c.days_quiet} day${c.days_quiet === 1 ? '' : 's'} ago`);

export function CoverageCard({ c }: { c: Coverage }) {
  return (
    <div className="stack-sm">
      <div className="between"><span className="caption">{quiet(c)}</span><span className={`badge ${STATUS[c.status][0]}`}>{STATUS[c.status][1]}</span></div>
      {c.months.length > 0 && <CoverageStrip c={c} size={18} />}
      {c.missing_months.length > 0 && (
        <p className="caption neg"><Icon name="warn" size={13} /> Missing {c.missing_months.map(m => monthLabel(m, true)).join(', ')} — import that statement to fill the gap.</p>
      )}
    </div>
  );
}

export function CoveragePage() {
  const q = useApi<{ items: Coverage[]; this_month: string }>('/accounts/coverage');
  const items = q.data?.items || [];
  const bad = items.filter(c => c.status !== 'ok');
  return (
    <Page title="Up to date?" back="/accounts" subtitle="Every account, every month — from SMS or a statement.">
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !items.length ? (
        <EmptyState icon="calendar" title="No accounts to check yet" text="Once you add accounts, each one gets a month-by-month strip showing which months came in by SMS or statement, and which are missing."
          action={<Link to="/accounts" className="btn small">Add account</Link>} />
      ) : (
        <>
          <div className="glass card row-flex">
            <Tile icon={bad.length ? 'warn' : 'check'} color={bad.length ? '#ff9f0a' : '#30d158'} />
            <div style={{ flex: 1 }}><b>{bad.length ? `${bad.length} of ${items.length} accounts need a look` : 'Everything is up to date'}</b>
              <p className="caption">Filled = covered · <span style={{ color: 'var(--green)' }}>green SMS</span> · <span style={{ color: 'var(--tint)' }}>blue statement</span> · hollow red = missing</p></div>
          </div>
          <List>
            {[...items].sort((a, b) => (a.status === 'ok' ? 1 : 0) - (b.status === 'ok' ? 1 : 0)).map(c => (
              <Link key={c.account_id} to={`/accounts/${c.account_id}`} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingTop: 14, paddingBottom: 14 }}>
                <div className="between">
                  <span className="row-flex" style={{ minWidth: 0 }}><Tile icon={(KIND_TILE[c.kind] || KIND_TILE.bank)[0]} color={(KIND_TILE[c.kind] || KIND_TILE.bank)[1]} /><span style={{ minWidth: 0 }}><b>{c.name}</b><br /><span className="caption">{KIND_LABEL[c.kind]?.replace(/s$/, '')} · {c.currency}</span></span></span>
                  <span className={`badge ${STATUS[c.status][0]}`}>{STATUS[c.status][1]}</span>
                </div>
                {c.months.length > 0 && <CoverageStrip c={c} />}
                <span className="caption">{quiet(c)}{c.missing_months.length ? <span className="neg"> · missing {c.missing_months.map(m => monthLabel(m)).join(', ')}</span> : null}</span>
              </Link>
            ))}
          </List>
          <Link to="/more/import" className="btn block secondary"><Icon name="upload" />Import a statement</Link>
        </>
      )}
    </Page>
  );
}

/* ---------- One account ---------- */
export function AccountPage() {
  const { id = '' } = useParams();
  const me = useApi<{ member: Member }>('/auth/me').data?.member.id || '';
  const accounts = useApi<{ items: Account[] }>('/accounts');
  const cov = useApi<{ items: Coverage[] }>('/accounts/coverage');
  const txns = useApi<{ items: Txn[] }>('/transactions', { account_id: id, limit: 15 });
  const hh = useApi<HouseholdFull>('/households/current');
  const [open, setOpen] = useState<Txn | null>(null);
  const [editing, setEditing] = useState(false);
  const [lending, setLending] = useState(false);
  const a = accounts.data?.items.find(x => x.id === id);
  const c = cov.data?.items.find(x => x.account_id === id);
  const ownerM = hh.data?.members.find(m => m.id === a?.owner_member_id);
  const owner = ownerM?.display_name;
  const card = !!a && CARD.includes(a.kind);
    return (
    <Page title={a ? `${a.institution}${a.last4 ? ' ··' + a.last4 : ''}` : 'Account'} back="/accounts"
      trail={a && <button className="link-btn" onClick={() => setEditing(true)}>Edit</button>}>
      {accounts.isLoading ? <PageSkeleton /> : !a ? <EmptyState icon="bank" title="Account not found" /> : (
        <div className="grid-desktop stack">
          <section className="glass hero span-2">
            <div className="row-flex"><AccountTile a={a} /><div><b>{a.name}</b><p className="caption">{KIND_LABEL[a.kind]?.replace(/s$/, '')} · {a.country} · {a.currency}{owner ? ` · ${owner}` : ''}{a.visibility === 'private' ? ' · private' : ''}</p></div></div>
            {card && <div className="hero-label" style={{ marginTop: 12 }}>Owed now</div>}
            <div className={`hero-amount ${a.balance && a.balance.minor < 0 ? 'neg' : ''}`} style={{ fontSize: 40 }}>{card && a.balance ? fmt({ ...a.balance, minor: owed(a) }) : fmt(a.balance)}</div>
            <p className="caption">{card && a.due_day ? <b>Due {nextDue(a.due_day)} · </b> : null}{a.balance_at ? `Balance as of ${shortDate(a.balance_at.slice(0, 10))}` : 'No balance seen yet — it appears from the next SMS or statement'}</p>
            {ownerM && ownerM.id !== me && <p className="row-flex caption" style={{ marginTop: 8, gap: 8 }}><Avatar name={ownerM.display_name} photo={ownerM.photo} size={24} />{ownerM.display_name}’s account</p>}
            {a.credit_limit && a.used_pct !== null && (
              <div className="stack-sm" style={{ marginTop: 14 }}>
                <Meter pct={a.used_pct} color={a.used_pct > 70 ? 'var(--red-fill)' : a.used_pct > 30 ? 'var(--orange-fill)' : 'var(--green-fill)'} />
                <span className="caption">{a.used_pct}% of <Money m={a.credit_limit} /> used{a.due_day ? ` · pay by the ${a.due_day}th` : ''}{a.rate_bp ? ` · ${(a.rate_bp / 100).toFixed(1)}% a year` : ''}</span>
              </div>
            )}
          </section>
          <Section title="Statement coverage" action={<Link to="/accounts/coverage">All accounts</Link>}>
            <div className="glass card">{c ? <CoverageCard c={c} /> : <div className="skel" style={{ height: 40 }} />}</div>
          </Section>
          <Section title="Links">
            <List>
              <ListRow to={`/activity?account_id=${a.id}`} icon={<Tile icon="activity" color="#0a84ff" />} title="All transactions" />
              <ListRow to={`/more/import?account=${a.id}`} icon={<Tile icon="upload" color="#30b0c7" />} title="Import a statement" sub="Fills any missing months" />
              <ListRow onClick={() => setLending(true)} icon={<Tile icon="person" color="#ff9f0a" />} title="Someone else used it" sub="Spending between two dates is theirs, now and when imported later" />
              <ListRow to="/money" icon={<Tile icon="transfer" color="#5e5ce6" />} title="Money moved" sub="Transfers in and out, by month" />
            </List>
          </Section>
          <UsedByRanges a={a} />
          <Section title="Recent">
            {txns.data?.items.length ? <List>{txns.data.items.slice(0, 15).map(t => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</List>
              : txns.isLoading ? <PageSkeleton /> : <p className="caption" style={{ marginLeft: 4 }}>No transactions yet.</p>}
          </Section>
        </div>
      )}
      <TxnSheet txn={open} onClose={() => setOpen(null)} />
      {a && <EditAccountSheet key={a.id} a={a} open={editing} onClose={() => setEditing(false)} />}
      {a && <UsedBySheet a={a} open={lending} onClose={() => setLending(false)} />}
    </Page>
  );
}

/** The saved "someone else used it" ranges, each removable (what it tagged goes back to being yours). */
function UsedByRanges({ a }: { a: Account }) {
  const q = useApi<{ items: UsedBy[] }>(`/accounts/${a.id}/used-by`);
  const del = useWrite<{ id: string }>('DELETE', b => `/accounts/${a.id}/used-by/${b.id}`);
  if (!q.data?.items.length) return null;
  return (
    <Section title="Lent to someone">
      <List>{q.data.items.map(r => (
        <ListRow key={r.id} icon={<PersonAvatar id={r.person.id} name={r.person.name || '?'} />} title={r.person.name} sub={`${shortDate(r.from)} – ${shortDate(r.to)} · ${r.purpose === 'support' ? 'family support' : 'they owe you'}`}
          end={<button className="link-btn" style={{ color: 'var(--red)' }} disabled={del.isPending} aria-label={`Remove ${r.person.name}’s range`}
            onClick={() => confirm(`Remove this range? Its spending goes back to being yours.`) && del.mutate({ id: r.id })}>Remove</button>} chevron={false} />
      ))}</List>
    </Section>
  );
}

/** A card lent to someone for a stretch (e.g. a roommate's trip): every money-out row in the dates becomes theirs. */
function UsedBySheet({ a, open, onClose }: { a: Account; open: boolean; onClose: () => void }) {
  const people = (useApi<{ items: Person[] }>(open ? '/people' : null).data?.items || []).filter(p => p.relation !== 'self');
  const [who, setWho] = useState<Person | null>(null);
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const save = useWrite<object, { tagged: number }>('POST', `/accounts/${a.id}/used-by`);
  const [done, setDone] = useState<number | null>(null);
  const close = () => { setDone(null); setWho(null); save.reset(); onClose(); };
  return (
    <Sheet open={open} onClose={close} title="Someone else used it">
      {done !== null ? <div className="stack"><p>{done} spend{done === 1 ? '' : 's'} marked as {who?.name}’s.</p><button className="btn block" onClick={close}>Done</button></div> : (
        <div className="stack">
          <p className="caption">Spending on {a.name} between these days becomes {who ? who.name + '’s' : 'theirs'}, including statements and SMS that arrive later: friends then owe you, family counts as support. Fees, interest and card charges stay yours.</p>
          <div className="row-flex" style={{ gap: 8 }}>
            <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
            <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
          </div>
          <List>{people.map(p => <ListRow key={p.kind + p.id} icon={<Avatar name={p.name} photo={p.photo} />} title={p.name} sub={p.kind === 'member' ? 'Family' : 'Friend'}
            end={who?.id === p.id ? <Icon name="check" size={22} className="pos" /> : undefined} onClick={() => setWho(p)} chevron={false} />)}</List>
          {save.error && <p className="caption neg">{save.error.message}</p>}
          <button className="btn block" disabled={!who || !from || !to || to < from || save.isPending}
            onClick={async () => setDone((await save.mutateAsync({ person: { kind: who!.kind, id: who!.id }, from, to })).tagged)}>Mark as theirs</button>
        </div>
      )}
    </Sheet>
  );
}
