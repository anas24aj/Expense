"""Statement coverage per account (gaps, staleness). Money movement between accounts is api/overview.py."""
from collections import defaultdict
from datetime import date

import engine
from api import ledger
from api.app import route
from api.insights import today_in

STALE_DAYS = 45  # no movement for this long on an active account: probably a statement or SMS is missing


def _month(day):
    return day[:7]


def _months(first, last):
    out, m = [], first
    while m <= last:
        out.append(m)
        m = engine.add_months(m, 1)
    return out


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
