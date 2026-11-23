import { Link, Navigate } from 'react-router-dom';
import { useApi } from '../api/client';
import type { Account, Commitment, Home, HouseholdFull, Items, Money as MoneyT, Settings, Statement, Trip } from '../api/types';
import { CASH, COUNTRIES, countryOf, DEBT } from './More';
import { dueLabel, fmt, monthLabel, shortDate, today } from '../lib/format';
import { AreaChart, ErrorCard, Icon, List, ListRow, Money, PageSkeleton, Page, ProgressRing, Section, StatusBadge, Tile } from '../ui';

export const KIND_ICON: Record<string, [string, string]> = {
  rent: ['house', '#5856d6'], bill: ['bolt', '#ff9f0a'], subscription: ['tv', '#af52de'], emi: ['bank', '#5e5ce6'], support: ['heart', '#ff375f'],
  insurance: ['shield', '#30b0c7'], school: ['school', '#0a84ff'], milestone: ['building', '#a2845e'],
};
export const DueRow = ({ c, onClick }: { c: Commitment; onClick?: () => void }) => {
  const [icon, color] = KIND_ICON[c.kind] || ['calendar', '#8e8e93'];
  return <ListRow icon={<Tile icon={icon} color={color} />} title={c.name} sub={<>{dueLabel(c.next_due)}{c.cycle_months > 1 ? ` · every ${c.cycle_months} months` : ''}</>}
    end={<Money m={c.amount} />} endSub={<StatusBadge status={c.status} />} onClick={onClick} chevron={false} />;
};

function daysTo(dom: number | null) {
  if (!dom) return null;
  const t = new Date(), d = new Date(t.getFullYear(), t.getMonth(), dom);
  if (d <= t) d.setMonth(d.getMonth() + 1);
  return Math.ceil((d.getTime() - t.getTime()) / 864e5);
}
function span(months: number | null) {
  if (months === null) return '';
  const y = Math.floor(months / 12), m = months % 12;
  return [y && `${y} yr`, m && `${m} mo`].filter(Boolean).join(' ');
}

export default function HomePage() {
  const q = useApi<Home>('/insights/home');
  const settings = useApi<Settings>('/settings');
  const trips = useApi<{ items: Trip[] }>('/trips');
  const accounts = useApi<Items<Account>>('/accounts');
  const stmts = useApi<Items<Statement>>('/ingest/statements');
  const hh = useApi<HouseholdFull>('/households/current');
  let onboarded = true;
  try { onboarded = localStorage.getItem('onboarded') === '1'; } catch { /* storage blocked */ }
  if (settings.data && !settings.data.salary && !onboarded) return <Navigate to="/welcome" replace />;
  const steps: Step[] = [
    { done: !!accounts.data?.items.length, to: '/more/accounts', icon: 'bank', color: '#0a84ff', title: 'Add your accounts', sub: 'Saudi and Indian banks, cards and loans' },
    { done: !!stmts.data?.items.length || !!q.data?.month.spent.minor, to: '/more/import', icon: 'upload', color: '#30b0c7', title: 'Bring in your history', sub: 'Import statements or connect your phone' },
    { done: !!settings.data?.salary, to: '/more/settings', icon: 'coin', color: '#30d158', title: 'Set your salary', sub: 'To see what’s free each month' },
    { done: (hh.data?.members.length ?? 0) > 1, to: '/more/household', icon: 'family', color: '#ff375f', title: 'Add your household', sub: 'Family and anyone you share costs with' },
  ];
  const loaded = accounts.data && stmts.data && settings.data;
  // the household step is optional: a single person is set up once the first three are done
  const setup = loaded && steps.slice(0, 3).some(x => !x.done) ? steps : null;

  return (
    <Page title="Home" subtitle={q.data ? monthLabel(q.data.month.month, true) : ' '}
      trail={<Link to="/more/profile" className="icon-btn" aria-label="Profile"><Icon name="person" /></Link>}>
      {q.isLoading || accounts.isLoading || stmts.isLoading || settings.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : <HomeBody h={q.data!} setup={setup} accounts={(accounts.data?.items || []).filter(a => !a.archived)} homeCur={hh.data?.household.home_currency || 'INR'} payday={daysTo(settings.data?.salary_day ?? null)} trips={trips.data?.items || []} />}
    </Page>
  );
}

/** Saudi and India side by side, each in its own currency; then both together in the home currency. */
function CountrySplit({ accounts, spent, fx, homeCur }: { accounts: Account[]; spent: MoneyT[]; fx: number; homeCur: string }) {
  const conv = (x: MoneyT): number | null => (x.currency === homeCur ? x.minor : !fx ? null
    : x.currency === 'SAR' && homeCur === 'INR' ? x.minor * fx : x.currency === 'INR' && homeCur === 'SAR' ? x.minor / fx : null);
  const sides = COUNTRIES.map(c => {
    const here = accounts.filter(a => countryOf(a) === c.code);
    const cur = here[0]?.currency || spent.find(x => countryOf({ currency: x.currency, country: '' } as Account) === c.code)?.currency;
    if (!cur) return null;
    const bal = (kinds: string[]): MoneyT | null => { // null: no balance known yet (it arrives with SMS or a statement), shown as —
      const known = here.filter(a => kinds.includes(a.kind) && a.balance?.currency === cur);
      return known.length ? { minor: known.reduce((s, a) => s + Math.abs(a.balance!.minor), 0), currency: cur } : null;
    };
    const owing = (k: string) => here.some(a => a.kind === k && a.balance?.minor);
    return { ...c, cur, held: bal(CASH), owed: bal(DEBT),
      owedLabel: owing('loan') ? (owing('credit_card') || owing('bnpl') ? 'Loans & cards' : 'Loans') : owing('credit_card') || owing('bnpl') ? 'Card dues' : 'Owed', spent: spent.find(x => x.currency === cur) || { minor: 0, currency: cur } as MoneyT };
  }).filter(Boolean) as { code: string; name: string; flag: string; held: MoneyT | null; owed: MoneyT | null; owedLabel: string; spent: MoneyT }[];
  const total = (k: 'held' | 'owed' | 'spent') => {
    const known = sides.map(x => x[k]).filter(Boolean) as MoneyT[], v = known.map(conv);
    return !known.length || v.some(x => x === null) ? null : { minor: Math.round(v.reduce((a, b) => a! + b!, 0)!), currency: homeCur } as MoneyT;
  };
  const rows: ['held' | 'owed' | 'spent', string][] = [['held', 'In accounts'], ['owed', ''], ['spent', 'Spent this month']];
  return (
    <section className="glass card span-2 stack-sm" aria-label="By country">
      <div className="split">
        {sides.map(x => (
          <Link key={x.code} to={`/more/accounts?country=${x.code}`} className="split-col" style={{ color: 'inherit' }}>
            <div className="card-title">{x.flag} {x.name}</div>
            {rows.map(([k, label]) => (
              <div key={k} className="stat"><span className="k">{label || x.owedLabel}</span>
                <span className={`v ${k === 'owed' && x.owed?.minor ? 'neg' : ''}`}><Money m={x[k]} compact /></span></div>
            ))}
          </Link>
        ))}
      </div>
      {sides.length > 1 && (
        <div className="split-total">
          <span className="caption">Together, in {homeCur}{fx ? ` · 1 SAR = ₹${fx.toFixed(2)}` : ''}</span>
          <div className="legend three">
            {rows.map(([k, label]) => <div key={k} className="stat"><span className="k">{label ? label.replace(' this month', '') : 'Owed'}</span><span className="v"><Money m={total(k)} compact /></span></div>)}
          </div>
        </div>
      )}
    </section>
  );
}

type Step = { done: boolean; to: string; icon: string; color: string; title: string; sub: string };
function GetStarted({ steps }: { steps: Step[] }) {
  const left = steps.filter(x => !x.done).length;
  return (
    <Section title="Get started">
      <List>
        {steps.map(x => <ListRow key={x.to} to={x.to} icon={<Tile icon={x.done ? 'check' : x.icon} color={x.done ? '#8e8e93' : x.color} />}
          title={x.done ? <s className="muted">{x.title}</s> : x.title} sub={x.done ? 'Done' : x.sub} />)}
      </List>
      <p className="footnote" style={{ margin: '0 4px' }}>{left} step{left === 1 ? '' : 's'} left. Your month, debts and what’s coming up fill in here as each one is done.</p>
    </Section>
  );
}

function HomeBody({ h, setup, accounts, homeCur, payday, trips }: { h: Home; setup: Step[] | null; accounts: Account[]; homeCur: string; payday: number | null; trips: Trip[] }) {
  const trip = trips.find(t => t.start_on <= today() && today() <= t.end_on);
  const urgent = h.alerts.filter(a => a.level !== 'info'), info = h.alerts.filter(a => a.level === 'info');
  const m = h.month;
  const fresh = !m.income.minor && !m.spent.minor && !m.owed_by_you.total.minor && !m.owed_to_you.total.minor && !h.next_dues.length;
  if (setup && fresh) return <div className="stack"><GetStarted steps={setup} /></div>;
  const fx = m.fx.SAR_INR;
  const parts = [
    { k: 'Spent', v: m.spent, c: 'var(--orange-fill)' },
    { k: 'Still due', v: m.committed_due, c: '#af52de' },
    { k: 'Set aside', v: m.set_aside, c: '#30b0c7' },
    { k: 'Free', v: m.free, c: 'var(--green-fill)' },
  ];
  const total = Math.max(1, m.income.minor);
  const free = fmt(m.free).replace(/^SAR /, '');
  const df = h.lookahead.debt_free;
  return (
    <div className="grid-desktop stack">
      {setup && <div className="span-2"><GetStarted steps={setup} /></div>}
      {!m.income.minor ? (
        <section className="glass hero span-2" aria-label="Spent this month">
          <span className="hero-label">Spent this month</span>
          <div className="hero-amount">{fmt(m.spent)}</div>
          <p className="caption"><Link to="/more/settings">Add your salary</Link> to see what’s free after bills, EMIs and savings.</p>
        </section>
      ) : <section className="glass hero span-2" aria-label="Free this month">
        <div className="between">
          <span className="hero-label">Free this month</span>
          {payday !== null && <span className="badge blue"><Icon name="calendar" size={12} />Payday in {payday} {payday === 1 ? 'day' : 'days'}</span>}
        </div>
        <div className={`hero-amount ${m.free.minor < 0 ? 'neg' : ''}`}>{m.free.currency === 'SAR' && <span className="cur">SAR</span>}{m.free.currency === 'SAR' ? free : fmt(m.free)}</div>
        <p className="caption">of <Money m={m.income} /> income, after everything that’s due and set aside</p>
        <div className="stackbar" role="img" aria-label={parts.map(p => `${p.k} ${fmt(p.v)}`).join(', ')}>
          {parts.map(p => <span key={p.k} style={{ flexGrow: Math.max(0, p.v.minor) / total, background: p.c }} />)}
        </div>
        <div className="legend">
          {parts.map(p => (
            <div key={p.k} className="stat"><span className="k"><i className="dot" style={{ background: p.c }} />{p.k}</span><span className="v"><Money m={p.v} compact /></span></div>
          ))}
        </div>
      </section>}

      {urgent.length > 0 && <List className="span-2"><Alerts items={urgent} /></List>}

      {!accounts.length && m.currency !== 'INR' && fx ? <p className="footnote span-2" style={{ margin: '-4px 4px 0' }}>Totals in {m.currency}. Rupee amounts are counted at 1 SAR = ₹{fx.toFixed(2)}; each account and transaction keeps its own currency.</p> : null}

      {trip && (
        <Link to={`/more/trips/${trip.id}`} className="glass pill-cta span-2" aria-label={`Current trip: ${trip.name}`}>
          <Tile icon="plane" color="#32ade6" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="caption">You’re on a trip · {trip.city}</div>
            <div style={{ fontWeight: 600 }}>{trip.name}</div>
            <div className="caption"><Money m={trip.totals.total} /> so far{trip.totals.unreviewed.minor > 0 && <> · <span className="warn"><Money m={trip.totals.unreviewed} /> to sort</span></>}</div>
          </div>
          <Icon name="chevR" className="chev" size={14} />
        </Link>
      )}

      {h.review_count > 0 && (
        <Link to="/activity/review" className="glass pill-cta span-2">
          <span className="count">{h.review_count}</span>
          <span style={{ flex: 1 }}><b>to check</b><br /><span className="caption">One tap each — we’ve guessed the rest</span></span>
          <span className="btn small">Review</span>
        </Link>
      )}

      {accounts.length > 0 && <CountrySplit accounts={accounts} spent={m.spent_by_currency || []} fx={fx} homeCur={homeCur} />}
      {accounts.length > 0 && m.owed_to_you.total.minor > 0 && (
        <Link to="/people?tab=claims" className="glass pill-cta span-2">
          <Tile icon="arrowDown" color="#30d158" />
          <span style={{ flex: 1, minWidth: 0 }}><b>Owed to you</b><br /><span className="caption">Friends <Money m={m.owed_to_you.people} compact /> · Claims <Money m={m.owed_to_you.claims} compact /></span></span>
          <span className="num pos" style={{ fontWeight: 600 }}><Money m={m.owed_to_you.total} compact /></span>
        </Link>
      )}
      {!accounts.length && (m.owed_by_you.total.minor !== 0 || m.owed_to_you.total.minor !== 0) && <div className="span-2 stack-sm"><div className="grid-2">
        <Link to="/plan#debts" className="glass card" style={{ color: 'inherit' }}>
          <div className="card-title" style={{ marginBottom: 6 }}>You owe</div>
          <div className="stat"><span className="v" style={{ fontSize: 22 }}><Money m={m.owed_by_you.total} compact /></span>
            <span className="caption">Loans <Money m={m.owed_by_you.loans} compact /></span>
            <span className="caption">Cards <Money m={m.owed_by_you.cards} compact /></span></div>
        </Link>
        <Link to="/people" className="glass card" style={{ color: 'inherit' }}>
          <div className="card-title" style={{ marginBottom: 6 }}>Owed to you</div>
          <div className="stat"><span className="v pos" style={{ fontSize: 22 }}><Money m={m.owed_to_you.total} compact /></span>
            <span className="caption">Friends <Money m={m.owed_to_you.people} compact /></span>
            <span className="caption">Claims <Money m={m.owed_to_you.claims} compact /></span></div>
        </Link>
      </div>
      </div>}

      {m.owed_by_you.total.minor > 0 && <Link to="/plan#debts" className="glass card row-flex" style={{ color: 'inherit' }}>
        <ProgressRing pct={df.months ? Math.max(4, 100 - df.months / 2.4) : 100} size={64} stroke={7} color="var(--green-fill)" label={<Icon name="target" size={22} />} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="caption">Debt-free</div>
          <div style={{ font: '700 22px var(--font-display)', letterSpacing: '-.02em' }}>{df.month ? monthLabel(df.month, true) : 'Not in sight yet'}</div>
          <div className="caption">{df.months ? `${span(df.months)} · ` : ''}interest costs you <b className="neg"><Money m={h.lookahead.interest_per_month} />/mo</b></div>
        </div>
      </Link>}

      {trips.length > 0 && <div className="span-2"><TripStrip trips={trips} /></div>}

      <Section title="Coming up" action={<Link to="/plan">See all</Link>}>
        {h.next_dues.length ? <List>{h.next_dues.map(c => <DueRow key={c.id} c={c} />)}</List>
          : <div className="glass card caption">Nothing due — enjoy it.</div>}
      </Section>

      {h.lookahead.months.some(x => x.free.minor) && <Section title="Next 6 months" action={<Link to="/plan#lookahead">Plan</Link>}>
        <div className="glass card">
          <div className="caption" style={{ marginBottom: 8 }}>Free money each month</div>
          <AreaChart data={h.lookahead.months.map(x => ({ month: x.month, value: x.free.minor / 100 }))} />
          {h.lookahead.months.some(x => x.warnings.length) && (
            <p className="caption" style={{ marginTop: 8 }}><Icon name="info" size={14} /> {h.lookahead.months.filter(x => x.warnings.length).map(x => `${monthLabel(x.month)}: ${x.warnings[0]}`).join(' · ')}</p>
          )}
        </div>
      </Section>}

      {info.length > 0 && <Section title="Heads-up"><List><Alerts items={info} /></List></Section>}
    </div>
  );
}

const Alerts = ({ items }: { items: Home['alerts'] }) => <>{items.map((a, i) => (
  <Link key={i} to={a.link || '/'} className="alert-row" style={{ color: 'inherit' }}>
    <Icon name={a.level === 'info' ? 'info' : 'warn'} className={a.level === 'info' ? '' : a.level === 'bad' ? 'neg' : 'warn'} />
    <span style={{ flex: 1 }}>{a.text}</span>
  </Link>
))}</>;

/** Recent trips as cards: work or personal, and what claims cover against what you pay yourself. */
function TripStrip({ trips }: { trips: Trip[] }) {
  const recent = [...trips].sort((a, b) => b.start_on.localeCompare(a.start_on)).slice(0, 6);
  return (
    <Section title="Trips" action={<Link to="/more/trips">See all</Link>}>
      <div className="hscroll">
        {recent.map(t => (
          <Link key={t.id} to={`/more/trips/${t.id}`} className="glass trip-card">
            <div className="between"><span className={`badge ${t.kind === 'business' ? 'blue' : 'green'}`}>{t.kind === 'business' ? 'Work' : 'Personal'}</span>
              <span className="caption">{shortDate(t.start_on)}</span></div>
            <div className="name">{t.name}</div>
            <div className="legend">
              {t.kind === 'business' && <div className="stat"><span className="k">Claimed</span><span className="v pos"><Money m={t.totals.claimed} compact /></span></div>}
              <div className="stat"><span className="k">{t.kind === 'business' ? 'Your cost' : 'Spent'}</span><span className="v"><Money m={t.totals.burden} compact /></span></div>
            </div>
          </Link>
        ))}
      </div>
    </Section>
  );
}
