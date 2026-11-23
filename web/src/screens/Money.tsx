import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/client';
import type { MoveLine, MoveSide, Movements } from '../api/types';
import { monthLabel, shiftMonth, thisMonth } from '../lib/format';
import { EmptyState, ErrorCard, Icon, List, Money, Page, PageSkeleton, Section } from '../ui';
import { PersonAvatar } from './People';

const GROUP_HINT: Record<string, string> = {
  remit: 'Sent home from Saudi accounts to Indian ones', cards: 'Paying off credit cards', own: 'Moved between your own accounts',
  family: 'Support sent to family', to_people: 'Lent, or paid back, to people', from_people: 'Paid back to you, or lent to you',
};
const sideLink = (s: MoveSide) => (s.kind === 'account' && s.id ? `/accounts/${s.id}` : s.kind === 'member' || s.kind === 'contact' ? `/people/${s.kind}/${s.id}` : null);

function Side({ s }: { s: MoveSide }) {
  const to = sideLink(s);
  const inner = <>{(s.kind === 'member' || s.kind === 'contact') && <PersonAvatar id={s.id} name={s.name} size={22} />}<span>{s.name}</span></>;
  return to ? <Link to={to} className="move-side">{inner}</Link> : <span className="move-side muted">{inner}</span>;
}

function MoveRow({ x }: { x: MoveLine }) {
  return (
    <div className="list-row no-icon move-row">
      <div className="body">
        <div className="move-path"><Side s={x.from} /><Icon name="chevR" size={14} className="muted" /><Side s={x.to} /></div>
        <div className="sub">{x.count} payment{x.count === 1 ? '' : 's'}{x.received ? <> · arrived as <Money m={x.received} /></> : null}</div>
      </div>
      <div className="end"><span className="amt"><Money m={x.amount} /></span></div>
    </div>
  );
}

/** Money movement: everything that left one of your accounts without being spending, as plain from → to lines with totals. */
export default function MoneyPage() {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || thisMonth();
  const q = useApi<Movements>('/insights/movements', { month });
  const go = (m: string) => setParams(m === thisMonth() ? {} : { month: m }, { replace: true });
  return (
    <Page title="Money moved" back="/" subtitle="Transfers between your accounts and to and from people. Spending is in Activity.">
      <div className="month-switch" role="group" aria-label="Month">
        <button onClick={() => go(shiftMonth(month, -1))} aria-label="Previous month"><Icon name="chevL" /></button>
        <strong aria-live="polite">{monthLabel(month, true)}</strong>
        <button onClick={() => go(shiftMonth(month, 1))} disabled={month >= thisMonth()} style={{ opacity: month >= thisMonth() ? .3 : 1 }} aria-label="Next month"><Icon name="chevR" /></button>
      </div>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !q.data!.groups.length ? (
        <EmptyState icon="transfer" title={`Nothing moved in ${monthLabel(month, true)}`} text="Transfers, card payments and money sent to people show here." />
      ) : (
        <>
          <div className="glass card figures">
            {q.data!.groups.map(g => <div key={g.key} className="stat"><span className="k">{g.title}</span><span className="v"><Money m={g.total} compact /></span></div>)}
          </div>
          {q.data!.groups.map(g => (
            <Section key={g.key} title={g.title} action={<span className="caption num">{g.items.length > 1 ? 'Total ' : ''}<Money m={g.total} /></span>}>
              <p className="caption" style={{ margin: '-4px 4px 0' }}>{GROUP_HINT[g.key]}</p>
              <List>{g.items.map((x, i) => <MoveRow key={i} x={x} />)}</List>
            </Section>
          ))}
          <p className="footnote" style={{ margin: '0 4px' }}>Totals in {q.data!.currency}; rupee lines counted at today’s rate. Each line keeps its own currency.</p>
        </>
      )}
    </Page>
  );
}
