import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import type { Account, Asset, Liability, Money as M, NetWorth, Payoff } from '../api/types';
import { fmt, monthLabel, sumByCurrency, today } from '../lib/format';
import { ErrorCard, Icon, List, ListRow, Meter, Money, Monies, Page, PageSkeleton, Section, Tile } from '../ui';
import { FLAG } from './Home';
import { DebtFreeLine } from './Month';

const ASSET_GROUPS: [Asset['kind'][], string, string, string][] = [
  [['property'], 'Property', 'building', '#a2845e'], [['vehicle'], 'Vehicles', 'car', '#5ac8fa'],
  [['home'], 'Rented homes · running costs, not owned', 'house', '#5856d6'], [['investment'], 'Investments', 'chart', '#30d158'],
];
const LIAB_GROUPS: [(l: Liability) => boolean, string][] = [
  [l => l.kind === 'loan' && !l.shared && /home|housing/i.test(l.name), 'Home loans'],
  [l => !!l.shared, 'Shared loans · your part'],
  [l => l.kind === 'loan' && !l.shared && !/home|housing/i.test(l.name), 'Loans & finance'],
  [l => l.kind === 'bnpl' || l.kind === 'person' || l.kind === 'other', 'Other'],
];
const monthsLeft = (end: string | null) => {
  if (!end) return null;
  const [y, m] = end.split('-').map(Number), [ty, tm] = today().split('-').map(Number);
  return Math.max(0, (y - ty) * 12 + m - tm);
};
const total = (ms: M[]) => sumByCurrency(ms);

/** Assets & liabilities: net worth, then what you own (property, vehicles, cash by country, investments) and what you owe
 * (loans with months left, shared loans, cards). Every row opens its own page. */
export default function WealthPage() {
  const nw = useApi<NetWorth>('/insights/networth');
  const assets = useApi<{ items: Asset[] }>('/assets');
  const liabs = useApi<{ items: Liability[] }>('/liabilities');
  const accounts = useApi<{ items: Account[] }>('/accounts');
  const payoff = useApi<Payoff>('/insights/payoff').data;
  if (nw.isLoading || assets.isLoading || liabs.isLoading || accounts.isLoading) return <Page title="Wealth"><PageSkeleton /></Page>;
  const err = nw.error || assets.error || liabs.error || accounts.error;
  if (err) return <Page title="Wealth"><ErrorCard error={err} retry={() => { nw.refetch(); assets.refetch(); liabs.refetch(); accounts.refetch(); }} /></Page>;
  const n = nw.data!, as = assets.data!.items, ls = liabs.data!.items.filter(l => !l.closed && l.outstanding.minor > 0 && l.kind !== 'credit_card');
  const accts = accounts.data!.items.filter(a => !a.archived);
  const cards = accts.filter(a => a.kind === 'credit_card' || a.kind === 'bnpl');
  const cash = accts.filter(a => ['bank', 'wallet', 'cash', 'debit_card'].includes(a.kind) && a.balance);
  const ownPct = n.assets.minor + n.liabilities.minor ? 100 * n.assets.minor / (n.assets.minor + n.liabilities.minor) : 50;
  return (
    <Page title="Wealth" subtitle="Assets & liabilities">
      <div className="grid-desktop stack">
        <section className="glass hero span-2" aria-label="Net worth">
          <div className="hero-label">Net worth</div>
          <div className={`hero-amount ${n.net.minor < 0 ? 'neg' : ''}`}>{fmt(n.net)}</div>
          <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', margin: '12px 0 6px' }} role="img" aria-label={`Own ${fmt(n.assets)}, owe ${fmt(n.liabilities)}`}>
            <i style={{ width: `${ownPct}%`, background: 'var(--green-fill)' }} /><i style={{ flex: 1, background: 'var(--red-fill)' }} />
          </div>
          <div className="between caption"><span>Own <b className="pos"><Money m={n.assets} compact /></b></span><span>Owe <b className="neg"><Money m={n.liabilities} compact /></b></span></div>
          <div className="split" style={{ marginTop: 12 }}>
            {n.countries.filter(c => c.code !== 'OTHER' || c.assets.minor || c.liabilities.minor).map(c => (
              <Link key={c.code} to={`/accounts#${c.code}`} className="split-col" style={{ color: 'inherit' }}>
                <span className="caption">{FLAG[c.code][0]} {FLAG[c.code][1]}</span>
                <b className={`num ${c.net.minor < 0 ? 'neg' : ''}`}><Money m={c.net} compact /></b>
                <span className="footnote">own <Money m={c.assets} compact /> · owe <Money m={c.liabilities} compact /></span>
              </Link>
            ))}
          </div>
        </section>

        {payoff && payoff.debts.length > 0 && (
          <Link to="/payoff" className="glass card span-2 between" style={{ color: 'inherit' }}>
            <span className="row-flex"><Tile icon="target" color="#ff453a" /><span><b>Debt-free plan</b><br /><span className="caption"><DebtFreeLine p={payoff} /></span></span></span>
            <Icon name="chevR" size={14} />
          </Link>
        )}

        <h2 className="section-title span-2"><span>Assets</span><span className="num pos">{fmt(n.assets)}</span></h2>
        {ASSET_GROUPS.map(([kinds, label, icon, color]) => {
          const xs = as.filter(a => kinds.includes(a.kind) && a.status !== 'sold');
          if (!xs.length) return null;
          const rented = kinds[0] === 'home';
          return (
            <Section key={label} title={label} action={<span className="caption num">{rented ? <><Monies items={total(xs.map(a => a.monthly_cost))} />/mo</> : <Monies items={total(xs.map(a => a.value))} />}</span>}>
              <List>{xs.map(a => (
                <ListRow key={a.id} to={`/assets/${a.id}`} icon={<Tile icon={icon} color={color} />} title={a.name}
                  sub={rented ? <>Running costs <Money m={a.my_monthly_cost} />/mo (your part)</>
                    : <>Cost <Money m={a.cost} compact />{a.funding ? <> · own <Money m={a.funding.own} compact /> · loan <Money m={a.funding.loan} compact />
                      {a.funding.interest.minor ? <> · interest so far <span className="neg"><Money m={a.funding.interest} compact /></span></> : null}</> : null}
                      {a.under_construction ? ' · under construction' : ''}</>}
                  end={rented ? <><Money m={a.monthly_cost} compact />/mo</> : <Money m={a.value} compact />} />
              ))}</List>
            </Section>
          );
        })}
        <Section title="Cash in accounts" action={<span className="caption num"><Monies items={total(cash.map(a => a.balance!))} /></span>}>
          <List>{n.countries.filter(c => c.cash.minor).map(c => (
            <ListRow key={c.code} to={`/accounts#${c.code}`} icon={<Tile icon="bank" color="#0a84ff" />} title={`${FLAG[c.code][0]} ${FLAG[c.code][1]}`}
              sub={`${cash.filter(a => (a.country || (a.currency === 'INR' ? 'IN' : 'SA')) === c.code).length} accounts`} end={<Money m={c.cash} />} />
          ))}</List>
        </Section>

        <h2 className="section-title span-2"><span>Liabilities</span><span className="num neg">{fmt(n.liabilities)}</span></h2>
        {LIAB_GROUPS.map(([match, label]) => {
          const xs = ls.filter(match);
          if (!xs.length) return null;
          return (
            <Section key={label} title={label} action={<span className="caption num"><Monies items={total(xs.map(l => l.outstanding))} /></span>}>
              <List>{xs.map(l => {
                const left = monthsLeft(l.end_on || l.payoff_month);
                return (
                  <Link key={l.id} to={l.account_id ? `/accounts/${l.account_id}` : '/plan#debts'} className="list-row" style={{ color: 'inherit', display: 'block' }}>
                    <div className="between"><b>{l.name}</b><b className="num"><Money m={l.outstanding} compact /></b></div>
                    <div className="between caption"><span>{[l.lender, `${(l.rate_bp / 100).toFixed(2)}%`].filter(Boolean).join(' · ')} · EMI <Money m={l.emi} compact /></span>
                      <span>{left === null ? 'end unknown' : `${left} months left`}</span></div>
                    {l.shared && <div className="caption">{l.my_share_pct}% yours{l.shared.holder ? ` · in ${l.shared.holder.name}’s name` : ''}</div>}
                    <div style={{ marginTop: 6 }}><Meter pct={l.paid_pct ?? 0} /></div>
                    <div className="between footnote"><span>{l.paid_pct ?? 0}% paid</span><span>{l.end_on ? `ends ${monthLabel(l.end_on.slice(0, 7), true)}` : l.payoff_month ? `done ${monthLabel(l.payoff_month, true)}` : ''}</span></div>
                  </Link>
                );
              })}</List>
            </Section>
          );
        })}
        <Section title="Credit cards" action={<span className="caption num neg"><Monies items={total(cards.filter(a => a.balance && a.balance.minor < 0).map(a => ({ ...a.balance!, minor: -a.balance!.minor })))} /></span>}>
          <List>{cards.map(a => (
            <ListRow key={a.id} to={`/accounts/${a.id}`} icon={<Tile icon="card" color="#ff453a" />} title={`${a.institution}${a.last4 ? ' ··' + a.last4 : ''}`}
              sub={!a.balance ? 'No balance yet' : a.statement_due && a.statement_due_on ? <>Statement <Money m={a.statement_due} /> due {a.statement_due_on}</> : a.used_pct !== null ? `${a.used_pct}% of limit used` : a.name}
              end={a.balance ? <span className={a.balance.minor < 0 ? 'neg' : ''}><Money m={{ ...a.balance, minor: Math.max(0, -a.balance.minor) }} /></span> : <span className="muted">—</span>} />
          ))}</List>
        </Section>
      </div>
    </Page>
  );
}
