"""Insights for v3: loads the household's rows into the plain shapes engine.py works on (the math stays there), and
serves /insights/*. load() is shared with api/plan.py and api/mcp.py. Amounts in the household's base currency."""
import json
from collections import defaultdict
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import engine
from api.app import ApiError, route

FALLBACK_SAR_INR = 24.9  # used only when no rate service answers and none was ever stored
SETTINGS = {'salary_minor': None, 'salary_currency': None, 'salary_day': None, 'emergency_months': 6,
            'debt_strategy': 'avalanche', 'extra_to_debt_minor': None}
TXN_SQL = ('SELECT t.*, m.purpose, m.confidence, m.set_by, m.person_member_id, m.person_contact_id, m.liability_id, m.asset_id, '
           'm.commitment_id, m.claim_id, m.fund_id, a.name AS account_name, a.visibility, a.owner_member_id '
           'FROM transactions t LEFT JOIN txn_meta m ON m.txn_id = t.id AND m.household_id = t.household_id '
           'LEFT JOIN accounts a ON a.id = t.account_id AND a.household_id = t.household_id '
           'WHERE t.household_id = :hid AND t.deleted_at IS NULL ORDER BY t.day, t.occurred_at, t.id')


def today_in(tz):
    try:
        return datetime.now(ZoneInfo(tz or 'Asia/Riyadh')).date().isoformat()
    except Exception:  # an unknown zone name: UTC rather than a 500
        return datetime.now(timezone.utc).date().isoformat()


def fx(db, day):
    """₹ per SAR for `day`: the stored row, else today's from the rate services (stored once a day), else the last known."""
    q = "SELECT day, rate FROM fx_rates WHERE base = 'SAR' AND quote = 'INR'"
    r = db.one(q + ' AND day = :d', d=day)
    if not r:
        import server
        got = server.inr_per_sar()
        if got:
            db.run("INSERT INTO fx_rates (day, base, quote, rate) VALUES (:d, 'SAR', 'INR', :r) ON CONFLICT DO NOTHING", d=day, r=got['rate'])
            r = {'day': day, 'rate': got['rate']}
        else:
            r = db.one(q + ' ORDER BY day DESC LIMIT 1') or {'day': None, 'rate': FALLBACK_SAR_INR}
    return {'SAR_INR': float(r['rate']), 'at': r['day']}


def settings(hh):
    s = dict(SETTINGS)
    for r in hh.run('SELECT key, value FROM settings WHERE household_id = :hid'):
        if r['key'] in s:
            s[r['key']] = json.loads(r['value'])
    return s


def _text(t):
    return f"{t.get('merchant') or ''} {t.get('merchant_raw') or ''}".lower()


def _match(rows, t):
    """The first row whose match_pattern is in the transaction's merchant text."""
    text = _text(t)
    return next((r['id'] for r in rows if r['match_pattern'] and r['match_pattern'].strip().lower() in text), None)


def load(req):
    """Everything the engine needs, read once per request (shortcut: reads all transactions; page by date when histories grow)."""
    hh, db = req.hh, req.db
    house = db.one('SELECT * FROM households WHERE id = :id', id=hh.hid) or {}
    cur, today = house.get('base_currency') or 'SAR', today_in(house.get('timezone'))
    rate = fx(db, today)
    r = rate['SAR_INR']
    me = (getattr(req, 'member', None) or {}).get('id')
    rows = [t for t in hh.run(TXN_SQL) if not (t['visibility'] == 'private' and t['owner_member_id'] != me)]
    by_id = {t['id']: t for t in rows}
    claimed = {c['txn_id']: c['claim_id'] for c in hh.run('SELECT claim_id, txn_id FROM claim_items WHERE household_id = :hid')}
    theirs = defaultdict(int)
    for s in hh.run('SELECT txn_id, member_id, share_minor FROM splits WHERE household_id = :hid'):
        t = by_id.get(s['txn_id'])
        if t and (s['member_id'] is None or s['member_id'] != t['member_id']):  # rows are other people's shares
            theirs[s['txn_id']] += s['share_minor']
    liabs = hh.run('SELECT * FROM liabilities WHERE household_id = :hid ORDER BY created_at, id')
    commits = hh.run('SELECT * FROM commitments WHERE household_id = :hid AND ended_at IS NULL ORDER BY next_due, id')
    assets = hh.run('SELECT * FROM assets WHERE household_id = :hid AND sold_at IS NULL ORDER BY created_at, id')
    shares = defaultdict(list)
    for s in hh.run('SELECT * FROM commitment_shares WHERE household_id = :hid ORDER BY id'):
        shares[s['commitment_id']].append(s)
    pays = defaultdict(list)
    for p in hh.run('SELECT * FROM commitment_payments WHERE household_id = :hid ORDER BY paid_on, id'):
        pays[p['commitment_id']].append(p)
    asset_share = defaultdict(int)  # txn id -> % of it that is someone else's (a shared vehicle cost)
    sharers = defaultdict(list)
    for s in hh.run('SELECT * FROM asset_sharers WHERE household_id = :hid'):
        sharers[s['asset_id']].append(s)
    costs = hh.run('SELECT * FROM asset_costs WHERE household_id = :hid')
    for c in costs:
        asset_share[c['txn_id']] += sum(s['share_pct'] for s in sharers[c['asset_id']] if s['cost_type'] in (c['cost_type'], '*'))
    debt_rows = [l for l in liabs if l['kind'] not in ('credit_card',) and not l['closed_at']]
    commit_share = {c['id']: sum(s['share_minor'] for s in shares[c['id']]) for c in commits}

    trip_tags = hh.run('SELECT * FROM trip_txns WHERE household_id = :hid')
    expected = {r['txn_id'] for r in trip_tags if r['status'] in ('missed', 'claimed')}  # money expected back: not spending
    txns = []
    for t in rows:
        debit = t['direction'] == 'debit'
        purpose = t['purpose'] or ('spend' if debit else 'income')
        user = t['set_by'] == 'user'
        e = {'id': t['id'], 'day': t['day'], 'amount_minor': t['amount_minor'], 'currency': t['currency'], 'direction': t['direction'],
             'purpose': purpose, 'theirs_minor': theirs[t['id']], 'category': t['category'] or 'Uncategorized', 'merchant': t['merchant'] or t['merchant_raw'],
             'commitment_id': t['commitment_id'], 'person_id': t['person_member_id'] or t['person_contact_id'],
             'liability_id': t['liability_id'], 'asset_id': t['asset_id'], 'claim_id': t['claim_id'], 'account_id': t['account_id']}
        if t['id'] in claimed:
            e.update(purpose='claim', claim_id=claimed[t['id']])
        elif t['id'] in expected and debit:
            e['purpose'] = 'claim'
        if debit and not user and e['purpose'] not in ('transfer', 'claim'):
            if not e['liability_id'] and (lid := _match(debt_rows, t)):
                e.update(liability_id=lid, purpose='loan_payment')
            if not e['asset_id'] and (aid := _match(assets, t)):
                e.update(asset_id=aid, purpose='asset')
            if not e['commitment_id']:
                e['commitment_id'] = _match(commits, t)
        if e['commitment_id'] and commit_share.get(e['commitment_id']) and debit:
            e['theirs_minor'] = max(e['theirs_minor'], min(t['amount_minor'], commit_share[e['commitment_id']]))
        if asset_share[t['id']]:
            e['theirs_minor'] = max(e['theirs_minor'], round(t['amount_minor'] * min(100, asset_share[t['id']]) / 100))
        txns.append(e)

    for l in liabs:
        l.update(_liability_calc(l, txns, r))
    interest = {tid: i for l in liabs for tid, i in l['interest_by_txn'].items()}
    eng_txns = []  # an EMI's interest part is spending (a fee); the rest pays the loan down
    for e in txns:
        i = interest.get(e['id'], 0)
        if i and e['purpose'] == 'loan_payment':
            eng_txns += [{**e, 'id': e['id'] + ':interest', 'amount_minor': i, 'purpose': 'fee', 'category': 'Fees & interest'},
                         {**e, 'amount_minor': e['amount_minor'] - i}]
        else:
            eng_txns.append(e)

    eng_commits = []
    for c in commits:
        eng_commits.append({**c, 'match': (c['match_pattern'] or '').strip().lower(),
                            'sharers': [{'person_id': s['member_id'] or s['contact_id'], 'share_minor': s['share_minor']} for s in shares[c['id']]]})
    status_txns = list(txns)  # what ticks commitments off: payments, plus "mark paid" without a transaction
    for c in commits:
        sharer_keys = {(s['member_id'], s['contact_id']) for s in shares[c['id']]}
        for p in pays[c['id']]:
            if (p['payer_member_id'], p['payer_contact_id']) in sharer_keys or p['txn_id']:
                continue
            status_txns.append({'id': 'pay:' + p['id'], 'day': p['cycle_due'], 'amount_minor': p['amount_minor'], 'currency': c['currency'],
                                'direction': 'debit', 'purpose': 'ignore', 'category': 'Ignored', 'merchant': '', 'commitment_id': c['id']})
    status = {c['id']: engine.commitment_status(c, status_txns, today) for c in eng_commits}

    funds = []
    by_commit = {c['id']: c for c in eng_commits}
    moves = defaultdict(list)
    for m in hh.run('SELECT * FROM fund_moves WHERE household_id = :hid ORDER BY on_day, id'):
        moves[m['fund_id']].append(m)
    for f in hh.run('SELECT * FROM funds WHERE household_id = :hid AND closed_at IS NULL ORDER BY due_on, id'):
        c = by_commit.get(f['commitment_id'])
        due, cycle, since = f['due_on'], 0, ''
        if c:  # a commitment's fund follows it: due on its next date; only this cycle's moves count (the last payment used the rest)
            due, cycle = status[c['id']]['next_due'], c['cycle_months']
            since = engine.add_months(due, -cycle) if cycle else ''
        funds.append({'id': f['id'], 'name': f['name'], 'target_minor': engine.your_share(c) if c else f['target_minor'], 'currency': f['currency'],
                      'due': due, 'commitment_id': f['commitment_id'], 'cycle_months': cycle,
                      'saved_minor': sum(m['amount_minor'] for m in moves[f['id']] if m['on_day'] > since)})

    loans = [{'id': l['id'], 'name': l['name'], 'kind': 'card' if l['kind'] == 'credit_card' else 'loan', 'balance_now': l['outstanding_minor'],
              'rate_bp': l['rate_bp'], 'emi_minor': l['emi_minor'], 'currency': l['currency'], 'pattern': l['match_pattern'], 'liability_kind': l['kind']}
             for l in liabs if not l['closed_at'] and l['outstanding_minor'] > 0]
    s = settings(hh)
    eng_settings = {'salary': s['salary_minor'] / 100 if s['salary_minor'] else None, 'salary_currency': s['salary_currency'] or cur,
                    'emergency_months': s['emergency_months'], 'debt_strategy': s['debt_strategy'],
                    'extra_to_debt': s['extra_to_debt_minor'], 'extra_currency': cur}
    return {'hh': hh, 'cur': cur, 'rate': rate, 'r': r, 'today': today, 'house': house, 'rows': rows, 'by_id': by_id, 'txns': eng_txns,
            'raw_txns': txns, 'status_txns': status_txns, 'liabs': liabs, 'commits': eng_commits, 'status': status, 'shares': shares,
            'payments': pays, 'funds': funds, 'loans': loans, 'assets': assets, 'costs': costs, 'asset_sharers': sharers,
            'settings': s, 'eng_settings': eng_settings, 'claimed': claimed,
            'trips': hh.run('SELECT * FROM trips WHERE household_id = :hid ORDER BY start_on DESC, id'), 'trip_tags': trip_tags,
            'claim_table': hh.run('SELECT * FROM claims WHERE household_id = :hid ORDER BY created_at DESC, id'),
            'milestones': hh.run('SELECT * FROM asset_milestones WHERE household_id = :hid ORDER BY due_on, id'),
            'accounts_cash': hh.run("SELECT currency, last_balance_minor FROM accounts WHERE household_id = :hid AND archived_at IS NULL "
                                    "AND kind IN ('bank', 'wallet', 'cash')")}


def _liability_calc(l, txns, r):
    """Outstanding from the opening balance and the payments after it. A loan payment pays the month's interest
    (outstanding × rate / 12) first and the rest is principal. A card with its account follows that account's lines."""
    bal, rate, interest, pays = l['opening_balance_minor'], l['rate_bp'] / 120000, {}, []
    after = [t for t in txns if t['day'] > l['as_of']]
    if l['kind'] in ('credit_card', 'bnpl') and l['account_id']:
        for t in after:
            if t['account_id'] == l['account_id']:
                amt = round(engine.conv(t['amount_minor'], t['currency'], l['currency'], r))
                bal += amt if t['direction'] == 'debit' else -amt
                if t['direction'] == 'credit':
                    pays.append({'txn_id': t['id'], 'day': t['day'], 'amount': amt, 'interest': 0})
    else:
        for t in after:
            if t['liability_id'] == l['id'] and t['direction'] == 'debit':
                amt = round(engine.conv(t['amount_minor'], t['currency'], l['currency'], r))
                i = min(amt, round(max(bal, 0) * rate))
                if t['currency'] == l['currency']:
                    interest[t['id']] = i
                bal -= amt - i
                pays.append({'txn_id': t['id'], 'day': t['day'], 'amount': amt, 'interest': i})
    return {'outstanding_minor': max(0, bal), 'interest_by_txn': interest, 'payments': pays}


def M(minor, cur):
    return engine.money(minor, cur)


def to_cur(minor, cur, ctx):
    return engine.conv(minor, cur, ctx['cur'], ctx['r'])


def claims_pending(ctx):
    """{currency: still expected} over open claims."""
    from api import plan
    out = defaultdict(int)
    for c in plan.claim_rows(ctx):
        if c['status'] not in ('paid', 'rejected'):
            out[c['expected']['currency']] += max(0, c['expected']['minor'] - c['received']['minor'])
    return out


def people_totals(ctx, hh):
    """(owed to you, owed by you) by people, in the base currency: lent − repaid, borrowed − repaid, unsettled split shares."""
    owes, owed = defaultdict(float), defaultdict(float)
    for t in ctx['raw_txns']:
        if t['person_id']:
            v = to_cur(t['amount_minor'], t['currency'], ctx)
            owes[t['person_id']] += {'lend': v, 'repaid': -v}.get(t['purpose'], 0)
            owed[t['person_id']] += {'borrow': v, 'repay': -v}.get(t['purpose'], 0)
    for s in hh.run('SELECT txn_id, member_id, contact_id, share_minor FROM splits WHERE household_id = :hid AND settled_at IS NULL'):
        t = ctx['by_id'].get(s['txn_id'])
        if t and t['direction'] == 'debit' and (s['member_id'] or s['contact_id']) != t['member_id']:
            owes[s['member_id'] or s['contact_id']] += to_cur(s['share_minor'], t['currency'], ctx)
    return sum(v for v in owes.values() if v > 0), sum(v for v in owed.values() if v > 0)


def month(req, ctx, m):
    cur = ctx['cur']
    owes, owed = people_totals(ctx, req.hh)
    pending = sum(to_cur(v, c, ctx) for c, v in claims_pending(ctx).items())
    v = engine.month_view(ctx['txns'], ctx['commits'], ctx['funds'], ctx['loans'], ctx['eng_settings'], m, ctx['today'], cur, ctx['r'],
                          owes, owed, pending)
    by_cat = defaultdict(float)
    for t in ctx['txns']:
        if t['day'].startswith(m) and engine.counted(t):
            by_cat[t['category']] += engine.conv(engine.counted(t), t['currency'], cur, ctx['r'])
    kinds = defaultdict(float)
    for l in ctx['loans']:
        kinds[{'credit_card': 'cards', 'bnpl': 'bnpl'}.get(l['liability_kind'], 'loans')] += to_cur(l['balance_now'], l['currency'], ctx)
    kinds['people'] = owed
    v['owed_by_you'] = {**{k: M(kinds[k], cur) for k in ('loans', 'cards', 'bnpl', 'people')}, 'total': M(sum(kinds.values()), cur)}
    v['by_category'] = [{'category': k, 'amount': M(x, cur)} for k, x in sorted(by_cat.items(), key=lambda kv: -kv[1])]
    v['interest_month'] = v.pop('interest_this_month')
    v['fx'] = ctx['rate']
    return v


def _months(q, default):
    try:
        n = int(q.get('months') or default)
    except ValueError:
        raise ApiError(400, 'months must be a number')
    if not 1 <= n <= 36:
        raise ApiError(400, 'months must be 1-36')
    return n


def lookahead(ctx, n=12):
    # EMI commitments tied to a liability are counted through the loan (until its payoff), not twice
    commits = [c for c in ctx['commits'] if not (c['liability_id'] and any(l['id'] == c['liability_id'] for l in ctx['loans']))]
    return engine.lookahead(ctx['txns'], commits, ctx['funds'], ctx['loans'], ctx['eng_settings'], ctx['today'], ctx['cur'], ctx['r'], n)


def whatif(ctx, q):
    try:
        amount = int(q.get('amount_minor') or 0)
        months, rate_bp = int(q.get('months') or 12), int(q.get('rate_bp') or 0)
    except ValueError:
        raise ApiError(400, 'amount_minor, months and rate_bp must be whole numbers')
    if amount <= 0:
        raise ApiError(400, 'amount_minor must be more than 0')
    pay = q.get('pay') or 'cash'
    if pay not in ('cash', 'card', 'emi'):
        raise ApiError(400, 'pay must be cash, card or emi')
    cur = ctx['cur']
    amount = round(engine.conv(amount, (q.get('currency') or cur).upper(), cur, ctx['r']))
    la = lookahead(ctx, 12)
    loans = engine.to_cur(ctx['loans'], cur, ctx['r'])
    return engine.what_if(loans, la['extra_to_debt']['minor'], la['months'][0]['free']['minor'], amount, cur, pay, ctx['today'], months, rate_bp)


def advice(ctx):
    cur, la = ctx['cur'], lookahead(ctx, 12)
    first = la['months'][0]
    essentials = first['everyday']['minor'] + first['commitments']['minor'] + first['funds']['minor']
    cash = sum(to_cur(a['last_balance_minor'] or 0, a['currency'], ctx) for a in ctx['accounts_cash'])  # the emergency fund is cash at hand
    out = engine.advice(engine.to_cur(ctx['loans'], cur, ctx['r']), cash, essentials, first['free']['minor'] + first['funds']['minor'],
                        first['funds']['minor'], ctx['eng_settings'], cur)
    return {'emergency': out['emergency_fund'], 'steps': out['steps'],
            'note': 'Guidance from simple rules on your own numbers, not financial advice.'}


def review_count(ctx):
    return sum(1 for t in ctx['rows'] if t['purpose'] is None or (t['set_by'] != 'user' and (t['confidence'] or 0) < 0.6))


def home(req, ctx):
    from api import plan
    m = month(req, ctx, ctx['today'][:7])
    la = lookahead(ctx, 6)
    commits = sorted((plan.commitment_json(c, ctx) for c in ctx['commits']), key=lambda c: c['next_due'])
    alerts = [{'level': 'warn', 'text': f"{c['name']} is overdue ({c['next_due']})", 'link': f"/plan/commitments/{c['id']}"}
              for c in commits if c['status'] == 'overdue']
    alerts += [{'level': 'warn', 'text': f"{r['month']}: {w}", 'link': '/plan/lookahead'} for r in la['months'] for w in r['warnings'] if w.startswith('Short')]
    alerts += [{'level': 'info', 'text': f"Claim {c['name']} pending for {c['age_days']} days", 'link': f"/plan/claims/{c['id']}"}
               for c in plan.claim_rows(ctx) if c['status'] not in ('paid', 'rejected') and c['age_days'] > 30]
    return {'month': m, 'next_dues': [c for c in commits if c['status'] != 'paid'][:5], 'lookahead': la,
            'review_count': review_count(ctx), 'alerts': alerts}


@route('GET', '/api/insights/month')
def month_route(req):
    ctx = load(req)
    m = req.query.get('month') or ctx['today'][:7]
    try:
        date.fromisoformat(m + '-01')
    except ValueError:
        raise ApiError(400, 'month must be YYYY-MM')
    return month(req, ctx, m)


@route('GET', '/api/insights/lookahead')
def lookahead_route(req):
    return lookahead(load(req), _months(req.query, 12))


@route('GET', '/api/insights/whatif')
def whatif_route(req):
    return whatif(load(req), req.query)


@route('GET', '/api/insights/advice')
def advice_route(req):
    return advice(load(req))


@route('GET', '/api/insights/home')
def home_route(req):
    return home(req, load(req))
