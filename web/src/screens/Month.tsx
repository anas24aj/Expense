import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, qs, useApi } from '../api/client';
import type { MonthInsight, Payoff, Txn } from '../api/types';
import { fmt, monthLabel, shiftMonth, thisMonth } from '../lib/format';
import { BarRow, CHART_COLORS, Donut, EmptyState, ErrorCard, Icon, List, ListRow, MiniBars, Money, Page, PageSkeleton, Section, Toggle } from '../ui';
import type { ChartItem } from '../ui';
import { TxnRow, TxnSheet } from './Activity';

const LOSS = 'var(--red-fill)';

const pct = (now: number, then: number) => (then ? Math.round(100 * (now - then) / then) : null);
function Delta({ now, then, good = 'down' }: { now: number; then: number; good?: 'up' | 'down' }) {
  const p = pct(now, then);
  if (p === null) return null;
  const bad = good === 'down' ? p > 0 : p < 0;
  return <span className={`caption ${p === 0 ? '' : bad ? 'neg' : 'pos'}`}>{p > 0 ? '▲' : p < 0 ? '▼' : ''}{Math.abs(p)}%</span>;
}

/** The monthly overview: income, spent, saved and last month; spending by category (losses apart); the 12-month trend. */
export default function MonthPage() {
  const { ym = thisMonth() } = useParams();
  const nav = useNavigate();
  const go = (n: number) => { const m = shiftMonth(ym, n); if (m <= thisMonth()) nav(`/month/${m}`, { replace: true }); };
  const q = useApi<MonthInsight>('/insights/month', { month: ym });
  const touch = useRef<number | null>(null);
  return (
    <Page title="Month" back="/" trail={<Link to={`/activity${ym === thisMonth() ? '' : '?month=' + ym}`} className="icon-btn" aria-label="All transactions"><Icon name="activity" /></Link>}>
      <div onTouchStart={e => { touch.current = e.touches[0].clientX; }}
        onTouchEnd={e => { const s = touch.current; touch.current = null; if (s === null) return; const dx = e.changedTouches[0].clientX - s; if (Math.abs(dx) > 60) go(dx > 0 ? -1 : 1); }}>
        <div style={{ textAlign: 'center', marginBottom: 8 }}><div className="month-switch" role="group" aria-label="Month">
          <button onClick={() => go(-1)} aria-label="Previous month"><Icon name="chevL" /></button>
          <strong aria-live="polite">{monthLabel(ym, true)}</strong>
          <button onClick={() => go(1)} disabled={ym >= thisMonth()} aria-label="Next month" style={{ opacity: ym >= thisMonth() ? .3 : 1 }}><Icon name="chevR" /></button>
        </div></div>
        {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : <MonthBody m={q.data!} ym={ym} />}
      </div>
    </Page>
  );
}

function MonthBody({ m, ym }: { m: MonthInsight; ym: string }) {
  const cur = m.currency, loss = m.loss, last = m.last_month;
  const cats = m.by_category.filter(c => c.amount.minor > 0);
  const nav = useNavigate();
  const color = (i: number) => CHART_COLORS[Math.min(i, 8)];
  const LOST = 'Lost to fees & interest';
  const items: ChartItem[] = [...cats.slice(0, 8).map((c, i) => ({ label: c.category, value: c.amount.minor / 100, color: color(i) })),
    ...(cats.length > 8 ? [{ label: 'Other', value: cats.slice(8).reduce((a, c) => a + c.amount.minor, 0) / 100, color: CHART_COLORS[9] }] : []),
    ...(loss && loss.total.minor ? [{ label: LOST, value: loss.total.minor / 100, color: LOSS }] : [])];
  const money = (v: number) => fmt({ minor: Math.round(v * 100), currency: cur }, { compact: true });
  const open = (label: string) => label === LOST ? document.getElementById('lost')?.scrollIntoView({ behavior: 'smooth' }) : nav(label === 'Other' ? `/activity?month=${ym}` : `/month/${ym}/${encodeURIComponent(label)}`);
  const saved = m.saved ?? { minor: m.income.minor - m.spent.minor, currency: cur };
  if (!m.spent.minor && !m.income.minor) return <EmptyState icon="chart" title={`Nothing in ${monthLabel(ym, true)}`} text="Spending shows here by category once transactions arrive." />;
  return (
    <div className="grid-desktop stack">
      <section className="glass hero span-2" aria-label="Month totals">
        <div className="grid-3">
          <div className="stat"><span className="k">Income</span><span className="v pos"><Money m={m.income} compact /></span>{last && <Delta now={m.income.minor} then={last.income.minor} good="up" />}</div>
          <div className="stat"><span className="k">Spent</span><span className="v"><Money m={m.spent} compact /></span>{last && <Delta now={m.spent.minor} then={last.spent.minor} />}</div>
          <div className="stat"><span className="k">Saved</span><span className={`v ${saved.minor < 0 ? 'neg' : ''}`}><Money m={saved} compact /></span>{last && <Delta now={saved.minor} then={last.saved.minor} good="up" />}</div>
        </div>
        {last && <p className="footnote" style={{ marginTop: 8 }}>{monthLabel(last.month)}: spent <Money m={last.spent} compact />, saved <Money m={last.saved} compact />.
          {ym === thisMonth() ? ' This month’s income includes the salary still expected.' : ''}</p>}
      </section>

      <Section title="Where it went">
        <div className="glass card stack">
          <Donut items={items} legend={false} format={money} onSelect={it => open(it.label)} label="Spending by category"
            center={<div><div className="caption">Spent</div><b className="num count-up" style={{ fontSize: 20 }}>{fmt(m.spent, { compact: true })}</b></div>} />
          <BarRow format={money} onSelect={it => open(it.label)} label="Spending by category, tap for its transactions"
            items={[...cats.map((c, i) => ({ label: c.category, value: c.amount.minor / 100, color: color(i), hint: c.last ? <Delta now={c.amount.minor} then={c.last.minor} /> : undefined })),
              ...(loss && loss.total.minor ? [{ label: LOST, value: loss.total.minor / 100, color: LOSS }] : [])]} />
        </div>
      </Section>

      {loss && loss.total.minor > 0 && (
        <Section title="Money lost">
          <div id="lost" className="glass card stack-sm" style={{ boxShadow: `inset 0 0 0 1.5px ${LOSS}`, scrollMarginTop: 80 }}>
            <div className="between"><span>Interest, late fees, FX markup &amp; VAT, bank charges</span><b className="num neg">{fmt(loss.total)}</b></div>
            <p className="caption">Gone for nothing: kept apart from your spending categories. {loss.last.minor ? <>Last month <Money m={loss.last} />.</> : null}</p>
            <List>{loss.by_category.map(c => (
              <ListRow key={c.category} title={c.category} to={c.category === 'Loan interest' ? '/plan#debts' : `/month/${ym}/${encodeURIComponent(c.category)}`}
                end={<span className="neg"><Money m={c.amount} /></span>} />
            ))}</List>
          </div>
        </Section>
      )}

      {m.trend && (
        <Section title="Spending, last 12 months">
          <div className="glass card"><MiniBars items={m.trend.map(t => ({ label: monthLabel(t.month), value: t.spent.minor / 100 }))} format={money}
            onSelect={(_, i) => nav(`/month/${m.trend![i].month}`)} label="Spending by month" /></div>
        </Section>
      )}

      <Section title="Not spending">
        <List>
          <ListRow icon={<Icon name="transfer" />} title="Transfers, card bills, EMIs, lending" to={`/money?month=${ym}`}
            sub="Not counted as spent"
            end={m.other_out ? <Money m={m.other_out} /> : undefined} />
        </List>
      </Section>
    </div>
  );
}

const SPENDING = ['spend', 'fee', 'support'];
/** One category's transactions in a month (what the month view counted: spending, fees and family support). */
export function CategoryMonthPage() {
  const { ym = thisMonth(), category = '' } = useParams();
  const q = useApi<{ items: Txn[] }>('/transactions', { month: ym, category, limit: 200 });
  const [open, setOpen] = useState<Txn | null>(null);
  const items = (q.data?.items || []).filter(t => SPENDING.includes(t.purpose));
  const totals = new Map<string, number>();
  for (const t of items) { const v = (t.split_mine || t.amount); totals.set(v.currency, (totals.get(v.currency) || 0) + (t.direction === 'debit' ? v.minor : -v.minor)); }
  return (
    <Page title={category} subtitle={monthLabel(ym, true)} back={`/month/${ym}`}>
      {q.isLoading ? <PageSkeleton /> : q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : !items.length ? <EmptyState icon="search" title="Nothing here" /> : (
        <div className="stack">
          <div className="glass card between"><span>{items.length} {items.length === 1 ? 'payment' : 'payments'}</span>
            <b className="num">{[...totals].map(([currency, minor]) => fmt({ minor, currency })).join(' + ')}</b></div>
          <List>{items.map(t => <TxnRow key={t.id} t={t} onOpen={setOpen} />)}</List>
          <p className="footnote">Your share where a bill is split. Tap one to change its category or mark it as not spending.</p>
        </div>
      )}
      <TxnSheet txn={open} onClose={() => setOpen(null)} />
    </Page>
  );
}

/* ---------- debt payoff: how many months to recover ---------- */
function usePayoff(spend: number, prepay: boolean) {
  return useQuery<Payoff, ApiError>({
    queryKey: ['/insights/payoff', { spend_minor: spend, prepay }],
    queryFn: () => api<Payoff>('/insights/payoff' + qs({ spend_minor: spend || undefined, prepay: prepay ? 1 : undefined })),
    placeholderData: keepPreviousData,
  });
}
const months = (n: number | null) => (n === null ? 'not at this pace' : n === 0 ? 'now' : `${n} month${n === 1 ? '' : 's'}`);

export function PayoffPage() {
  const [prepay, setPrepay] = useState(false);
  const [slide, setSlide] = useState(0);
  const [spend, setSpend] = useState(0);
  useEffect(() => { const t = setTimeout(() => setSpend(slide), 250); return () => clearTimeout(t); }, [slide]);
  const q = usePayoff(spend, prepay);
  const base = usePayoff(0, prepay).data;
  const p = q.data;
  return (
    <Page title="Debt-free plan" back="/">
      {q.isLoading || !p ? (q.error ? <ErrorCard error={q.error} retry={q.refetch} /> : <PageSkeleton />) : !p.debts.length
        ? <EmptyState icon="check" title="No debt" text="No card balance or loan is owed. Card balances come from your statements and SMS." /> : (
        <div className="grid-desktop stack">
          <section className="glass hero span-2" aria-label="Months to recover">
            <div className="hero-label">Cards cleared in</div>
            <div className={`hero-amount ${p.cards.months === null ? 'neg' : ''}`}>{months(base?.cards.months ?? p.cards.months)}</div>
            <p className="caption">{base?.cards.month ? monthLabel(base.cards.month, true) + ' · ' : ''}paying <Money m={p.surplus} /> a month on the cards, costliest first. EMIs carry on as scheduled.</p>
            <div className="grid-2" style={{ marginTop: 12 }}>
              <div className="stat"><span className="k">Debt-free in</span><span className="v">{months(base?.debt_free.months ?? p.debt_free.months)}</span>
                <span className="caption">{(base || p).debt_free.month ? monthLabel((base || p).debt_free.month!, true) : ''}</span></div>
              <div className="stat"><span className="k">Interest lost now</span><span className="v neg"><Money m={p.interest_now.total} />/mo</span>
                <span className="caption">cards <Money m={p.interest_now.cards} compact /> · loans <Money m={p.interest_now.loans} compact /></span></div>
            </div>
          </section>

          {p.interest_saved.minor > 0 && (
            <div className="glass card span-2" role="note">
              <b className="pos">Clearing the cards fast saves <Money m={p.interest_saved} /> in interest</b>
              <p className="caption">Paying only the 5% minimum due would cost <Money m={p.card_interest_min_due} /> in card interest; this plan costs <Money m={p.card_interest} />.</p>
            </div>
          )}

          <section className="glass card span-2 stack-sm" aria-label="What if I spend">
            <div className="between"><b>What if I spend this month…</b><b className="num">{fmt({ minor: slide, currency: p.currency })}</b></div>
            <input type="range" min={0} max={Math.max(500000, p.surplus.minor * 3)} step={10000} value={slide} onChange={e => setSlide(Number(e.target.value))}
              aria-label="Extra spending this month" style={{ width: '100%' }} />
            <p className={`caption ${p.delay.cards ? 'neg' : ''}`} aria-live="polite">
              {!spend ? 'Slide to see how a purchase moves your debt-free date.'
                : p.delay.cards === null ? 'The cards would not clear at this pace.'
                : <>Cards cleared {p.delay.cards ? <b>{p.delay.cards} month{p.delay.cards === 1 ? '' : 's'} later</b> : 'in the same month'} ({months(p.cards.months)}),{' '}
                  <Money m={p.delay.interest} /> more interest.</>}
            </p>
          </section>

          <Section title="In this order">
            <List>{p.debts.map((d, i) => (
              <ListRow key={d.id} icon={<span className="step-n">{i + 1}</span>} title={d.name}
                sub={<>{(d.rate_bp / 100).toFixed(d.rate_bp % 100 ? 1 : 0)}%{d.rate_assumed ? ' (assumed)' : ''}{d.kind === 'loan' ? <> · EMI <Money m={d.emi} compact /></> : ' · card'}</>}
                end={<Money m={d.local} compact />} endSub={<span className="caption">{d.cleared ? `done ${monthLabel(d.cleared)} ${d.cleared.slice(2, 4)}` : 'not at this pace'}</span>} chevron={false} />
            ))}</List>
            <Toggle label="Prepay loans after the cards" checked={prepay} onChange={setPrepay} sub="Off: once the cards are clear, loans just keep their EMIs" />
          </Section>

          <Section title="Month by month">
            <div className="glass card stack-sm">
              {/* what is still owed: monthly for a short plan, once a year for a long one */}
              <MiniBars label="Still owed" format={v => fmt({ minor: Math.round(v * 100), currency: p.currency }, { compact: true })}
                items={p.timeline.filter((_, i) => p.timeline.length <= 12 || i % Math.ceil(p.timeline.length / 12) === 0)
                  .map(t => ({ label: p.timeline.length <= 12 ? monthLabel(t.month) : `’${t.month.slice(2, 4)}`, value: (t.cards.minor + t.loans.minor) / 100 }))} highlight={0} />
              <div className="table-wrap">
                <table className="look">
                  <thead><tr><th>Month</th><th>Cards</th><th>Loans</th><th>Interest</th></tr></thead>
                  <tbody>{p.timeline.filter((t, i) => i < 12 || t.cleared.length).map(t => (
                    <tr key={t.month}><td>{monthLabel(t.month)} {t.month.slice(2, 4)}{t.cleared.length ? <><br /><span className="pos caption">✓ {t.cleared.join(', ')}</span></> : null}</td>
                      <td>{fmt(t.cards, { compact: true })}</td><td>{fmt(t.loans, { compact: true })}</td><td className="neg">{fmt(t.interest, { compact: true })}</td></tr>
                  ))}</tbody>
                </table>
              </div>
              {p.timeline.length > 12 &&<p className="caption">…then the loans run on their EMIs until {(base || p).debt_free.month ? monthLabel((base || p).debt_free.month!, true) : 'beyond 50 years'}.</p>}
            </div>
          </Section>
          <div className="span-2">{p.assumptions.map(a => <p key={a} className="footnote">{a}</p>)}</div>
        </div>
      )}
    </Page>
  );
}

export const DebtFreeLine = ({ p }: { p: Payoff }) => <>{p.cards.months ? `Cards clear in ${months(p.cards.months)}` : p.debts.length ? 'Cards clear' : 'No debt'}{p.debts.some(d => d.kind === 'loan') ? ` · debt-free ${p.debt_free.month ? monthLabel(p.debt_free.month, true) : 'not at this pace'}` : ''}</>;
