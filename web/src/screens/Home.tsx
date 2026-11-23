import { Link, Navigate } from 'react-router-dom';
import { useApi } from '../api/client';
import type { Commitment, Home, Settings, Trip } from '../api/types';
import { dueLabel, fmt, monthLabel, today } from '../lib/format';
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
  let onboarded = true;
  try { onboarded = localStorage.getItem('onboarded') === '1'; } catch { /* storage blocked */ }
  if (settings.data && !settings.data.salary && !onboarded) return <Navigate to="/welcome" replace />;
  const fx = q.data?.month.fx.SAR_INR;

  return (
    <Page title="Home" subtitle={q.data ? <>{monthLabel(q.data.month.month, true)}{fx ? ` · 1 SAR = ₹${fx.toFixed(2)}` : ''}</> : ' '}
      trail={<Link to="/more/profile" className="icon-btn" aria-label="Profile"><Icon name="person" /></Link>}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : <HomeBody h={q.data!} payday={daysTo(settings.data?.salary_day ?? null)} trip={trips.data?.items.find(t => t.start_on <= today() && today() <= t.end_on)} />}
    </Page>
  );
}

function HomeBody({ h, payday, trip }: { h: Home; payday: number | null; trip?: Trip }) {
  const m = h.month;
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
      <section className="glass hero span-2" aria-label="Free this month">
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
      </section>

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

      <div className="grid-2">
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

      <Link to="/plan#debts" className="glass card row-flex" style={{ color: 'inherit' }}>
        <ProgressRing pct={df.months ? Math.max(4, 100 - df.months / 2.4) : 100} size={64} stroke={7} color="var(--green-fill)" label={<Icon name="target" size={22} />} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="caption">Debt-free</div>
          <div style={{ font: '700 22px var(--font-display)', letterSpacing: '-.02em' }}>{df.month ? monthLabel(df.month, true) : m.owed_by_you.total.minor ? 'Not in sight yet' : 'No debt'}</div>
          <div className="caption">{span(df.months)} · interest costs you <b className="neg"><Money m={h.lookahead.interest_per_month} />/mo</b></div>
        </div>
      </Link>

      <Section title="Coming up" action={<Link to="/plan">See all</Link>}>
        {h.next_dues.length ? <List>{h.next_dues.map(c => <DueRow key={c.id} c={c} />)}</List>
          : <div className="glass card caption">Nothing due — enjoy it.</div>}
      </Section>

      <Section title="Next 6 months" action={<Link to="/plan#lookahead">Plan</Link>}>
        <div className="glass card">
          <div className="caption" style={{ marginBottom: 8 }}>Free money each month</div>
          <AreaChart data={h.lookahead.months.map(x => ({ month: x.month, value: x.free.minor / 100 }))} />
          {h.lookahead.months.some(x => x.warnings.length) && (
            <p className="caption" style={{ marginTop: 8 }}><Icon name="info" size={14} /> {h.lookahead.months.filter(x => x.warnings.length).map(x => `${monthLabel(x.month)}: ${x.warnings[0]}`).join(' · ')}</p>
          )}
        </div>
      </Section>

      {h.alerts.length > 0 && (
        <Section title="Heads-up">
          <List>
            {h.alerts.map((a, i) => (
              <Link key={i} to={a.link || '/'} className="alert-row" style={{ color: 'inherit' }}>
                <Icon name={a.level === 'info' ? 'info' : 'warn'} className={a.level === 'info' ? '' : a.level === 'bad' ? 'neg' : 'warn'} />
                <span style={{ flex: 1 }}>{a.text}</span>
              </Link>
            ))}
          </List>
        </Section>
      )}
    </div>
  );
}
