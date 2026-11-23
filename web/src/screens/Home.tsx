import { Link, Navigate } from 'react-router-dom';
import { useApi } from '../api/client';
import type { Account, Commitment, Home, HouseholdFull, Items, MonthPlan, NetWorth, Payoff, Settings, Statement, Trip } from '../api/types';
import { dueLabel, fmt, monthLabel, today } from '../lib/format';
import { ErrorCard, Icon, List, ListRow, Money, PageSkeleton, Page, Section, StatusBadge, Tile } from '../ui';
import { DebtFreeLine } from './Month';

export const KIND_ICON: Record<string, [string, string]> = {
  rent: ['house', '#5856d6'], bill: ['bolt', '#ff9f0a'], subscription: ['tv', '#af52de'], emi: ['bank', '#5e5ce6'], support: ['heart', '#ff375f'],
  insurance: ['shield', '#30b0c7'], school: ['school', '#0a84ff'], milestone: ['building', '#a2845e'],
};
export const DueRow = ({ c, onClick }: { c: Commitment; onClick?: () => void }) => {
  const [icon, color] = KIND_ICON[c.kind] || ['calendar', '#8e8e93'];
  return <ListRow icon={<Tile icon={icon} color={color} />} title={c.name} sub={<>{dueLabel(c.next_due)}{c.cycle_months > 1 ? ` · every ${c.cycle_months} months` : ''}</>}
    end={<Money m={c.amount} />} endSub={<StatusBadge status={c.status} />} onClick={onClick} chevron={false} />;
};
export const FLAG: Record<string, [string, string]> = { SA: ['🇸🇦', 'Saudi'], IN: ['🇮🇳', 'India'], OTHER: ['🌍', 'Elsewhere'] };

function daysTo(dom: number | null) {
  if (!dom) return null;
  const t = new Date(), d = new Date(t.getFullYear(), t.getMonth(), dom);
  if (d <= t) d.setMonth(d.getMonth() + 1);
  return Math.ceil((d.getTime() - t.getTime()) / 864e5);
}

/** Home: what you're worth, Saudi vs India, what's free this month, what fees cost you. Everything else is one tap away. */
export default function HomePage() {
  const q = useApi<Home>('/insights/home');
  const nw = useApi<NetWorth>('/insights/networth');
  const settings = useApi<Settings>('/settings');
  const trips = useApi<{ items: Trip[] }>('/trips');
  const accounts = useApi<Items<Account>>('/accounts');
  const stmts = useApi<Items<Statement>>('/ingest/statements');
  const hh = useApi<HouseholdFull>('/households/current');
  const payoff = useApi<Payoff>('/insights/payoff');
  const plan = useApi<MonthPlan>('/insights/plan');
  let onboarded = true;
  try { onboarded = localStorage.getItem('onboarded') === '1'; } catch { /* storage blocked */ }
  if (settings.data && !settings.data.salary && !onboarded) return <Navigate to="/welcome" replace />;
  const steps: Step[] = [
    { done: !!accounts.data?.items.length, to: '/accounts', icon: 'bank', color: '#0a84ff', title: 'Add your accounts', sub: 'Saudi and Indian banks, cards and loans' },
    { done: !!stmts.data?.items.length || !!q.data?.month.spent.minor, to: '/more/import', icon: 'upload', color: '#30b0c7', title: 'Bring in your history', sub: 'Import statements or connect your phone' },
    { done: !!settings.data?.salary, to: '/more/settings', icon: 'coin', color: '#30d158', title: 'Set your salary', sub: 'To see what’s free each month' },
    { done: (hh.data?.members.length ?? 0) > 1, to: '/more/household', icon: 'family', color: '#ff375f', title: 'Add your household', sub: 'Family and anyone you share costs with' },
  ];
  const loaded = accounts.data && stmts.data && settings.data;
  const setup = loaded && steps.slice(0, 3).some(x => !x.done) ? steps : null;
  const trip = trips.data?.items.find(t => t.start_on <= today() && today() <= t.end_on);
  const busy = q.isLoading || nw.isLoading || accounts.isLoading || stmts.isLoading || settings.isLoading;
  return (
    <Page title="Home" subtitle={q.data ? monthLabel(q.data.month.month, true) : ' '}
      trail={<Link to="/more" className="icon-btn" aria-label="More: people, trips, settings"><Icon name="person" /></Link>}>
      {busy ? <PageSkeleton /> : q.error || nw.error ? <ErrorCard error={q.error || nw.error} retry={() => { q.refetch(); nw.refetch(); }} />
        : <HomeBody h={q.data!} n={nw.data!} setup={setup} payday={daysTo(settings.data?.salary_day ?? null)} trip={trip} hasAccounts={!!accounts.data?.items.length} payoff={payoff.data} plan={plan.data} />}
    </Page>
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
      <p className="footnote" style={{ margin: '0 4px' }}>{left} step{left === 1 ? '' : 's'} left. Your net worth and month fill in here as each one is done.</p>
    </Section>
  );
}

function HomeBody({ h, n, setup, payday, trip, hasAccounts, payoff, plan }: { h: Home; n: NetWorth; setup: Step[] | null; payday: number | null; trip?: Trip; hasAccounts: boolean; payoff?: Payoff; plan?: MonthPlan }) {
  const m = h.month;
  const top = m.by_category.slice(0, 3), topMax = Math.max(1, ...top.map(c => c.amount.minor));
  const urgent = h.alerts.filter(a => a.level !== 'info');
  if (setup && !hasAccounts && !m.spent.minor && !m.income.minor) return <div className="stack"><GetStarted steps={setup} /></div>;
  const countries = n.countries.filter(c => c.code !== 'OTHER' || c.assets.minor || c.liabilities.minor);
  return (
    <div className="grid-desktop stack">
      {setup && <div className="span-2"><GetStarted steps={setup} /></div>}

      <Link to="/wealth" className="glass hero span-2" style={{ color: 'inherit' }} aria-label="Net worth, open assets and liabilities">
        <div className="between"><span className="hero-label">Net worth</span><Icon name="chevR" className="chev" size={14} /></div>
        <div className={`hero-amount ${n.net.minor < 0 ? 'neg' : ''}`}>{fmt(n.net)}</div>
        <div className="grid-2" style={{ marginTop: 10 }}>
          <div className="stat"><span className="k">You own</span><span className="v"><Money m={n.assets} /></span></div>
          <div className="stat"><span className="k">You owe</span><span className="v neg"><Money m={n.liabilities} /></span></div>
        </div>
      </Link>


      <Link to={`/month/${m.month}`} className="glass card span-2" style={{ color: 'inherit' }} aria-label={`${monthLabel(m.month, true)} overview`}>
        <div className="between"><span className="card-title" style={{ margin: 0 }}>{monthLabel(m.month, true)}</span><Icon name="chevR" className="chev" size={14} /></div>
        <div className="between" style={{ marginTop: 6, alignItems: 'baseline' }}>
          <div><span className="caption">Spent </span><b className="num" style={{ font: '700 30px var(--font-display)', letterSpacing: '-.02em' }}>{fmt(m.spent)}</b></div>
          {m.last_month && <span className="caption">{monthLabel(m.last_month.month)} <Money m={m.last_month.spent} compact /></span>}
        </div>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          {top.map(c => (
            <div key={c.category}><div className="between caption"><span>{c.category}</span><Money m={c.amount} /></div>
              <div className="meter"><i style={{ width: `${Math.max(2, 100 * c.amount.minor / topMax)}%` }} /></div></div>
          ))}
        </div>
        <p className="caption" style={{ marginTop: 8 }}>Income <Money m={m.income} compact />{m.saved ? <> · saved <Money m={m.saved} compact /></> : null}{m.loss && m.loss.total.minor ? <> · <span className="neg">lost <Money m={m.loss.total} compact /></span></> : null} · all categories</p>
      </Link>

      <section className="glass card span-2" aria-label="Saudi and India">
        <div className="split">
          {countries.map(c => (
            <Link key={c.code} to={`/accounts#${c.code}`} className="split-col" style={{ color: 'inherit' }}>
              <div className="card-title">{FLAG[c.code][0]} {FLAG[c.code][1]}</div>
              <div className="stat"><span className="k">Net</span><span className={`v ${c.net.minor < 0 ? 'neg' : ''}`}><Money m={c.net} compact /></span></div>
              <span className="caption">Own <Money m={c.assets} compact /> · Owe <Money m={c.liabilities} compact /></span>
            </Link>
          ))}
        </div>
        <p className="footnote" style={{ marginTop: 10 }}>Each country in its own currency. Together in SAR at 1 SAR = ₹{n.fx.SAR_INR.toFixed(2)}.</p>
      </section>

      <section className="glass card span-2" aria-label="This month and next">
        <div className="between"><span className="card-title" style={{ margin: 0 }}>Expected</span>
          {payday !== null && <span className="badge blue"><Icon name="calendar" size={12} />Payday in {payday}d</span>}</div>
        {plan ? <div className="split" style={{ marginTop: 6 }}>
          {plan.months.map((pm, i) => (
            <Link key={pm.month} to={i ? `/plan?month=${pm.month}` : '/plan'} className="split-col" style={{ color: 'inherit' }}>
              <span className="caption"><b>{i ? 'Next month' : 'This month'}</b> · {monthLabel(pm.month)}</span>
              <span className="caption">In <span className="pos"><Money m={pm.income} compact /></span></span>
              <span className="caption">Out <Money m={pm.out} compact /> <span className="footnote">bills, EMIs, cards</span></span>
              <b className={`num ${pm.short ? 'neg' : 'pos'}`} style={{ fontSize: 20 }}>{pm.short ? <>Short <Money m={pm.short} compact /></> : <>+<Money m={pm.surplus} compact /></>}</b>
            </Link>
          ))}
        </div> : <p className="caption">{m.income.minor ? <>Free this month <Money m={m.free} /></> : 'Set your salary to see what’s free'}</p>}
      </section>

      {payoff && payoff.debts.length > 0 && (
        <Link to="/payoff" className="glass card" style={{ color: 'inherit' }}>
          <span className="card-title" style={{ margin: 0 }}>Debt-free plan</span>
          <div style={{ font: '700 30px var(--font-display)', letterSpacing: '-.02em', marginTop: 6 }} className={`num ${payoff.cards.months === null ? 'neg' : ''}`}>
            {payoff.cards.months === null ? 'Cards growing' : payoff.cards.months ? `${payoff.cards.months} mo` : 'Cards clear'}</div>
          <p className="caption"><DebtFreeLine p={payoff} /> · interest <span className="neg"><Money m={payoff.interest_now.total} compact />/mo</span></p>
        </Link>
      )}

      <Link to="/activity?purpose=fee" className="glass card" style={{ color: 'inherit' }}>
        <span className="card-title" style={{ margin: 0 }}>Lost to fees &amp; interest</span>
        <div style={{ font: '700 30px var(--font-display)', letterSpacing: '-.02em', marginTop: 6 }} className={`num ${n.losses.month.minor ? 'neg' : ''}`}>{fmt(n.losses.month)}</div>
        <p className="caption">this month · <Money m={n.losses.year} /> in 12 months{n.losses.loan_interest_month.minor ? <> · loan interest <Money m={n.losses.loan_interest_month} /> extra</> : null}</p>
      </Link>

      {urgent.length > 0 && <List className="span-2">{urgent.map((a, i) => (
        <Link key={i} to={a.link || '/'} className="alert-row" style={{ color: 'inherit' }}>
          <Icon name="warn" className={a.level === 'bad' ? 'neg' : 'warn'} /><span style={{ flex: 1 }}>{a.text}</span>
        </Link>
      ))}</List>}

      <nav className="tiles span-2" aria-label="Go to">
        <Shortcut to="/more" icon="more" color="#8e8e93" title="More" sub="Settings, import, household" />
        <Shortcut to="/people" icon="people" color="#ff9f0a" title="People" sub="Who owes whom" />
        <Shortcut to={trip ? `/trips/${trip.id}` : '/trips'} icon="plane" color="#32ade6" title={trip ? trip.city : 'Trips'} sub={trip ? 'On a trip now' : 'Work & personal'} />
        <Shortcut to="/activity/review" icon="tag" color={h.review_count ? '#ff9f0a' : '#30d158'} title={h.review_count ? `${h.review_count.toLocaleString()} to sort` : 'All sorted'} sub="Group by shop, one tap" />
      </nav>
    </div>
  );
}

const Shortcut = ({ to, icon, color, title, sub }: { to: string; icon: string; color: string; title: string; sub: string }) => (
  <Link to={to} className="glass tile" style={{ color: 'inherit' }}>
    <Tile icon={icon} color={color} />
    <b>{title}</b>
    <span className="caption">{sub}</span>
  </Link>
);
