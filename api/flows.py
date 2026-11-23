"""Money flow between accounts (for a Sankey view) and statement coverage per account (gaps, staleness)."""
from collections import defaultdict
from datetime import date

import engine
from api import ledger, valid
from api.app import ApiError, route
from api.insights import fx, today_in

STALE_DAYS = 45  # no movement for this long on an active account: probably a statement or SMS is missing


def _month(day):
    return day[:7]


def _months(first, last):
    out, m = [], first
    while m <= last:
        out.append(m)
        m = engine.add_months(m, 1)
    return out


@route('GET', '/api/insights/flows')
def flows(req):
    """Nodes: income sources, accounts, and where money finally went (categories, people, loans, claims…).
    Links: summed in the household's base currency for the period [from, to] (default: this month)."""
    hh = req.hh
    house = req.db.one('SELECT * FROM households WHERE id = :id', id=hh.hid)
    base, today = house['base_currency'], today_in(house['timezone'])
    start = valid.day(req.query['from'], 'from') if req.query.get('from') else today[:8] + '01'
    end = valid.day(req.query['to'], 'to') if req.query.get('to') else today
    if start > end:
        raise ApiError(400, 'from must be before to')
    rate = fx(req.db, end)['SAR_INR']
    rows = ledger.visible_txns(hh, req.member['id'], 'AND t.day >= :s AND t.day <= :e', s=start, e=end)
    paired = {}  # both directions: either side of a linked transfer finds the other
    for r in hh.run("SELECT from_txn, to_txn FROM txn_links WHERE household_id = :hid AND kind = 'transfer'"):
        paired[r['from_txn']], paired[r['to_txn']] = r['to_txn'], r['from_txn']
    by_id = {r['id']: r for r in rows}
    links, nodes = defaultdict(int), {}

    def node(key, name, kind):
        nodes.setdefault(key, {'id': key, 'name': name, 'kind': kind})
        return key

    def amount(r):
        try:
            return round(engine.conv(r['amount_minor'], r['currency'], base, rate))
        except ValueError:  # a currency with no rate: leave it out rather than guess
            return 0

    for r in rows:
        acc = node('acc:' + (r['account_id'] or 'none'), ledger.bank_label(r) or 'Unknown account', 'account')
        purpose, v = r['purpose'] or 'spend', amount(r)
        if not v or purpose == 'ignore':
            continue
        if purpose == 'transfer' or r['id'] in paired:  # a linked pair is a transfer even if one side was retagged
            other = by_id.get(paired.get(r['id']))
            if other and r['direction'] == 'debit':  # each pair drawn once, from the sending side
                links[(acc, node('acc:' + (other['account_id'] or 'none'), ledger.bank_label(other) or 'Unknown account', 'account'))] += v
            elif other:
                pass  # the credit side: already drawn from its debit
            elif r['direction'] == 'debit':  # the other side isn't found, or falls outside this period
                links[(acc, node('out:transfer', 'Moved to other accounts', 'outflow'))] += v
            else:
                links[(node('in:transfer', 'Moved in from other accounts', 'inflow'), acc)] += v
            continue
        if r['direction'] == 'credit':
            src = node('in:' + purpose, {'income': 'Income', 'reimbursement': 'Reimbursements', 'repaid': 'Paid back to you',
                                         'borrow': 'Borrowed', 'refund': 'Refunds'}.get(purpose, purpose.title()), 'inflow')
            links[(src, acc)] += v
        else:
            if purpose in ('spend', 'fee'):
                dest = node('cat:' + (r['category'] or 'Uncategorized'), r['category'] or 'Uncategorized', 'spending')
            else:
                dest = node('out:' + purpose, {'loan_payment': 'Loan payments', 'support': 'Family support', 'lend': 'Lent',
                                               'repay': 'Repaid', 'claim': 'Company claims', 'asset': 'Property & assets',
                                               'saving': 'Savings'}.get(purpose, purpose.title()), 'outflow')
            links[(acc, dest)] += v
    return {'from': start, 'to': end, 'currency': base, 'nodes': list(nodes.values()),
            'links': [{'source': s, 'target': t, 'amount': valid.money(v, base)} for (s, t), v in sorted(links.items(), key=lambda kv: -kv[1])]}


@route('GET', '/api/accounts/coverage')
def coverage(req):
    """Per account: months with data and where it came from (SMS / statement), missing months between the first and
    this month, and whether it has gone quiet. Answers "is every account up to date with no gaps?"."""
    hh = req.hh
    house = req.db.one('SELECT * FROM households WHERE id = :id', id=hh.hid)
    this_month = _month(today_in(house['timezone']))
    seen = defaultdict(lambda: defaultdict(set))  # account -> month -> sources
    last = {}
    for r in hh.run('SELECT account_id, day, source FROM transactions WHERE household_id = :hid AND deleted_at IS NULL AND account_id IS NOT NULL'):
        seen[r['account_id']][_month(r['day'])].add(r['source'])
        last[r['account_id']] = max(last.get(r['account_id'], ''), r['day'])
    periods = defaultdict(list)
    for s in hh.run('SELECT account_id, period_from, period_to FROM statements WHERE household_id = :hid'):
        if s['period_from'] and s['period_to']:
            periods[s['account_id']].append((s['period_from'], s['period_to']))
    items = []
    for a in ledger.account_rows(hh, req.member['id']):
        months = seen.get(a['id'], {})
        span = _months(min(months), this_month) if months else []
        covered = {m for m in span if m in months or any(f[:7] <= m <= t[:7] for f, t in periods[a['id']])}
        missing = [m for m in span if m not in covered]
        quiet = (date.fromisoformat(today_in(house['timezone'])) - date.fromisoformat(last[a['id']])).days if a['id'] in last else None
        items.append({'account_id': a['id'], 'name': a['name'], 'kind': a['kind'], 'currency': a['currency'],
                      'first_month': span[0] if span else None, 'last_day': last.get(a['id']),
                      'months': [{'month': m, 'sources': sorted(months.get(m, ())), 'covered': m in covered} for m in span],
                      'missing_months': missing, 'days_quiet': quiet,
                      'status': 'no_data' if not span else 'gaps' if missing else 'stale' if quiet is not None and quiet > STALE_DAYS else 'ok'})
    return {'items': items, 'this_month': this_month}
