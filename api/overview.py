"""Reads for the redesigned app (docs/brain/api-v3.md "Overview"): net worth by country with fees as losses, the month
planner, money movement between accounts and people, one person's ledger, and the review queue grouped by merchant."""
import math
from collections import defaultdict
from datetime import date, timedelta

import engine
from api import classify, households, insights, ledger, plan, valid
from api.app import ApiError, route

CASH_KINDS = ('bank', 'wallet', 'cash', 'debit_card', 'investment')
CARD_KINDS = ('credit_card', 'bnpl')
CUR_COUNTRY = {'SAR': 'SA', 'INR': 'IN'}
COUNTRY_CUR = {'SA': 'SAR', 'IN': 'INR'}


def country_of(code, cur):
    c = (code or CUR_COUNTRY.get(cur) or '').upper()
    return c if c in COUNTRY_CUR else 'OTHER'


def _conv(ctx, minor, cur, to=None):
    return engine.conv(minor, cur, to or ctx['cur'], ctx['r'])


def _M(minor, cur):
    return engine.money(minor, cur)


# ---------- net worth, by country; fees and interest as losses ----------

def networth_view(req, ctx):
    """Assets (cash in accounts, property and vehicles at today's value) minus liabilities (loans at what is outstanding,
    cards at what is owed), per country in its own currency and together in the base currency. A card or loan account
    that a liability row tracks is counted once, through the liability."""
    base = ctx['cur']
    tracked = {l['account_id'] for l in ctx['liabs'] if l['account_id'] and not l['closed_at']}
    g = defaultdict(lambda: defaultdict(float))  # country -> part -> base minor
    for a in ledger.account_views(req.hh, req.member['id']):
        if a['balance'] is None:
            continue
        c, v = country_of(a['country'], a['currency']), _conv(ctx, a['balance']['minor'], a['currency'])
        if a['kind'] in CASH_KINDS:
            g[c]['cash' if v >= 0 else 'cards'] += abs(v)  # an overdrawn account is owed like a card
        elif a['id'] not in tracked and v < 0:
            g[c]['cards' if a['kind'] in CARD_KINDS else 'loans'] -= v
    for l in ctx['liabs']:
        if not l['closed_at'] and l['outstanding_minor'] > 0:
            g[country_of('', l['currency'])]['cards' if l['kind'] in CARD_KINDS else 'loans'] += _conv(ctx, l['outstanding_minor'], l['currency'])
    names = plan._people(req.hh)
    for a in ctx['assets']:
        v = plan.asset_json(a, ctx, names)['value']
        g[country_of('', a['currency'])]['property'] += _conv(ctx, v['minor'], v['currency'])
    countries = []
    for code in ('SA', 'IN', 'OTHER'):
        if code not in g and code == 'OTHER':
            continue
        parts, cur = g[code], COUNTRY_CUR.get(code, base)
        local = lambda k: _M(_conv(ctx, parts[k], base, cur), cur)
        assets, liab = parts['cash'] + parts['property'], parts['cards'] + parts['loans']
        countries.append({'code': code, 'currency': cur, 'cash': local('cash'), 'property': local('property'), 'cards': local('cards'),
                          'loans': local('loans'), 'assets': _M(_conv(ctx, assets, base, cur), cur), 'liabilities': _M(_conv(ctx, liab, base, cur), cur),
                          'net': _M(_conv(ctx, assets - liab, base, cur), cur), 'net_base': _M(assets - liab, base)})
    assets = sum(p['cash'] + p['property'] for p in g.values())
    liab = sum(p['cards'] + p['loans'] for p in g.values())
    return {'currency': base, 'fx': ctx['rate'], 'assets': _M(assets, base), 'liabilities': _M(liab, base), 'net': _M(assets - liab, base),
            'countries': countries, 'losses': losses(ctx)}


def losses(ctx):
    """Money lost to charges: card interest, bank and FX fees (purpose fee), this month and over the last 12 months,
    with the interest part of loan EMIs kept apart (it is the price of the loan, not a mistake)."""
    month, since = ctx['today'][:7], engine.add_months(ctx['today'], -12)
    fees = [t for t in ctx['txns'] if t['purpose'] == 'fee' and t['direction'] == 'debit' and t['day'] > since]
    charge = [t for t in fees if not t['id'].endswith(':interest')]
    total = lambda rows: _M(sum(_conv(ctx, t['amount_minor'], t['currency']) for t in rows), ctx['cur'])
    recent = sorted(charge, key=lambda t: (t['day'], t['id']), reverse=True)[:10]
    return {'month': total([t for t in charge if t['day'][:7] == month]), 'year': total(charge),
            'loan_interest_month': total([t for t in fees if t['id'].endswith(':interest') and t['day'][:7] == month]),
            'items': plan.txn_views(ctx, [ctx['by_id'][t['id']] for t in recent if t['id'] in ctx['by_id']])}


@route('GET', '/api/insights/networth')
def networth(req):
    return networth_view(req, insights.load(req))


# ---------- the month planner ----------

def _main_bank(accts, cur):
    """The account bills in `cur` are paid from when none is named: the bank account in that currency with the most in it."""
    banks = [a for a in accts if a['kind'] == 'bank' and a['currency'] == cur]
    return max(banks, key=lambda a: (a['balance'] or {}).get('minor') or 0, default=None)


def _card_spend(ctx, aid, month):
    """Average monthly spending on a card over the 3 full months before `month`: next month's bill, as a guess."""
    months = {engine.add_months(month, -k) for k in (2, 3, 4)}
    rows = [t for t in ctx['raw_txns'] if t['account_id'] == aid and t['direction'] == 'debit' and t['day'][:7] in months and t['purpose'] != 'transfer']
    return sum(t['amount_minor'] for t in rows) / 3


def _plan_month(req, ctx, accts, m, look, india_cash, people):
    today, base = ctx['today'], ctx['cur']
    by_id = {a['id']: a for a in accts}
    loan_ids = {l['id'] for l in ctx['loans']}
    lines = []

    def line(kind, name, minor, cur, day, account_id, link, paid=False, counted=True, country=None, note=None):
        payer = by_id.get(account_id) if account_id in by_id and by_id[account_id]['kind'] in CASH_KINDS else _main_bank(accts, cur)
        lines.append({'kind': kind, 'name': name, 'amount': _M(minor, cur), 'base': _M(_conv(ctx, minor, cur), base), 'day': day,
                      'country': country or country_of('', cur), 'account_id': payer and payer['id'],
                      'account_name': payer and ledger.bank_label({'account_institution': payer['institution'], 'account_last4': payer['last4'], 'account_name': payer['name']}),
                      'paid': paid, 'counted': counted and not paid, 'link': link, 'note': note})

    funded = {f['commitment_id'] for f in ctx['funds'] if f['commitment_id']}
    for c in ctx['commits']:
        if c['liability_id'] in loan_ids:
            continue  # paid as the loan's EMI below
        cj = plan.commitment_json(c, ctx)
        due = engine.dues({**c, 'next_due': cj['next_due']}, m, m)
        overdue = m == today[:7] and cj['next_due'] < m + '-01'
        last = (cj['last_paid'] or {}).get('day') or ''
        if due or overdue:
            line('commitment', c['name'], engine.your_share(c), c['currency'], today if overdue else due[0], c['account_id'],
                 f"/recurring?commitment={c['id']}", counted=c['id'] not in funded, country=c['country'])
        elif last[:7] == m:
            line('commitment', c['name'], engine.your_share(c), c['currency'], last, c['account_id'], f"/recurring?commitment={c['id']}", paid=True,
                 country=c['country'])
    for l in ctx['liabs']:
        cons = l['construction']
        emi = cons['pre_emi'] if cons and cons['phase'] == 'pre_emi' else l['emi_minor']
        if l['closed_at'] or l['outstanding_minor'] <= 0 or not emi or l['kind'] == 'credit_card' or (l['end_on'] and l['end_on'][:7] < m):
            continue
        day = f"{m}-{min(28, l['due_day'] or 1):02d}"
        paid = any(p['day'][:7] == m for p in l['payments'])
        line('emi', l['name'], emi, l['currency'], day, l['account_id'], '/plan#debts', paid=paid)
    card_liab = {l['account_id'] for l in ctx['liabs'] if l['account_id']}
    for a in accts:
        if a['kind'] != 'credit_card':
            continue
        owed = max(0, -((a['balance'] or {}).get('minor') or 0)) if m == today[:7] else round(_card_spend(ctx, a['id'], m))
        day = f"{m}-{min(28, a['due_day']):02d}" if a['due_day'] else None
        note = None
        if m == today[:7] and a['statement_due'] and a['statement_due_on'] and a['statement_due_on'] >= today:
            # the statement says what is due and by when; what was paid since takes the balance below it
            owed, day = min(owed, a['statement_due']['minor']), a['statement_due_on']
            if a['min_due']:
                note = (f"Minimum due {engine.fmt(a['min_due']['minor'], a['currency'])}. Paying only the minimum leaves the rest "
                        'charging interest (about 3% a month): pay it in full.')
        if owed:
            line('card', f"{a['institution'] or a['name']} card{' ··' + a['last4'] if a['last4'] else ''}", owed, a['currency'], day, None,
                 f"/accounts/{a['id']}", country=country_of(a['country'], a['currency']), note=note)
    for l in ctx['liabs']:  # a card tracked only as a liability (no account)
        if l['kind'] == 'credit_card' and not l['closed_at'] and l['outstanding_minor'] > 0 and l['account_id'] not in by_id and m == today[:7]:
            line('card', l['name'], l['outstanding_minor'], l['currency'], f"{m}-{min(28, l['due_day'] or 28):02d}", None, '/plan#debts')
    for p in people:
        for owe in p['you_owe']:
            line('person', f"Pay back {p['name']}", owe['minor'], owe['currency'], None, None, f"/people/{p['kind']}/{p['id']}")
    if look['funds']['minor']:
        line('fund', 'Set aside for funds', look['funds']['minor'], base, None, None, '/plan#funds')
    lines.sort(key=lambda x: (x['paid'], x['day'] or '9999', x['kind']))

    out = sum(x['base']['minor'] for x in lines if x['counted'])
    surplus = look['income']['minor'] - out
    inr_due = sum(x['amount']['minor'] for x in lines if x['counted'] and x['amount']['currency'] == 'INR')
    need = max(0, inr_due - india_cash)
    move = None
    if need:
        sar = math.ceil(_conv(ctx, need, 'INR', base) / 100_00) * 100_00  # whole hundreds of the base currency
        days = [x['day'] for x in lines if x['counted'] and x['amount']['currency'] == 'INR' and x['day']]
        by = max(today, (date.fromisoformat(min(days)) - timedelta(days=3)).isoformat()) if days else None
        frm, to = _main_bank(accts, base), _main_bank(accts, 'INR')
        move = {'amount': _M(sar, base), 'inr': _M(need, 'INR'), 'by': by, 'from': frm and frm['id'], 'to': to and to['id']}
    by_account = defaultdict(list)
    for x in lines:
        if x['counted'] and x['account_id']:
            by_account[x['account_id']].append(x)
    pay = [{'account_id': aid, 'account_name': xs[0]['account_name'], 'currency': xs[0]['amount']['currency'],
            'total': _M(sum(x['amount']['minor'] for x in xs if x['amount']['currency'] == xs[0]['amount']['currency']), xs[0]['amount']['currency']),
            'items': [{'name': x['name'], 'amount': x['amount'], 'day': x['day']} for x in xs]}
           for aid, xs in sorted(by_account.items(), key=lambda kv: min(x['day'] or '9999' for x in kv[1]))]
    return {'month': m, 'income': look['income'], 'out': _M(out, base), 'surplus': _M(surplus, base), 'short': _M(-surplus, base) if surplus < 0 else None,
            'lines': lines, 'pay_from': pay, 'move_to_india': move,
            'india': {'due': _M(inr_due, 'INR'), 'cash': _M(india_cash, 'INR')}}


def plan_view(req, ctx):
    """This month and next: salary (as Plan expects it), minus commitments, loan EMIs, card bills and what you owe people
    (this month), and the fund set-asides → surplus or gap. Then who pays what from which account, and how much to move
    to India: rupee dues not covered by what the Indian accounts hold."""
    accts = ledger.account_views(req.hh, req.member['id'])
    look = insights.lookahead(ctx, 2)['months']
    india = sum(a['balance']['minor'] for a in accts if a['kind'] in CASH_KINDS and a['currency'] == 'INR' and a['balance'] and a['balance']['minor'] > 0)
    people = [p for p in households.people(req.hh, req.db) if p['you_owe']]
    first = _plan_month(req, ctx, accts, look[0]['month'], look[0], india, people)
    second = _plan_month(req, ctx, accts, look[1]['month'], look[1], max(0, india - first['india']['due']['minor']), [])
    return {'currency': ctx['cur'], 'fx': ctx['rate'], 'months': [first, second]}


@route('GET', '/api/insights/plan')
def month_plan(req):
    return plan_view(req, insights.load(req))


# ---------- money movement ----------

GROUPS = [('remit', 'Saudi → India'), ('cards', 'Card payments'), ('own', 'Between my accounts'), ('family', 'Family support'),
          ('to_people', 'To people'), ('from_people', 'From people')]


@route('GET', '/api/insights/movements')
def movements(req):
    """Every movement that is not spending, for one month, as from → to lines with totals: transfers between your own
    accounts (remittances to India and card payments apart), family support, and money to and from people.
    A linked transfer is one line, from its sending side; an unlinked one names the side it has."""
    ctx = insights.load(req)
    m = valid.month(req.query['month']) if req.query.get('month') else ctx['today'][:7]
    accts = {a['id']: a for a in ledger.account_views(req.hh, req.member['id'], archived=True)}
    rows = ledger.visible_txns(req.hh, req.member['id'], 'AND t.day >= :a AND t.day <= :b', a=m + '-01', b=m + '-31')
    views = {v['id']: v for v in ledger.txn_views(req.hh, rows)}
    paired = {}
    for r in req.hh.run("SELECT from_txn, to_txn FROM txn_links WHERE household_id = :hid AND kind = 'transfer'"):
        paired[r['from_txn']], paired[r['to_txn']] = r['to_txn'], r['from_txn']
    osql, oprm = valid.inlist('o', [paired[r['id']] for r in rows if r['id'] in paired])
    others = {r['id']: r for r in ledger.visible_txns(req.hh, req.member['id'], f'AND t.id IN {osql}', **oprm)}
    lines = {}

    def side(aid):
        a = accts.get(aid)
        if not a:
            return {'kind': 'account', 'id': aid, 'name': 'Cash' if not aid else 'Account', 'country': None}
        label = ledger.bank_label({'account_institution': a['institution'], 'account_last4': a['last4'], 'account_name': a['name']})
        return {'kind': 'account', 'id': aid, 'name': label, 'country': country_of(a['country'], a['currency']), 'account_kind': a['kind']}

    def add(group, frm, to, r, received=None):
        key = (group, frm['kind'], frm['id'], to['kind'], to['id'], r['currency'])
        x = lines.setdefault(key, {'group': group, 'from': frm, 'to': to, 'amount': _M(0, r['currency']), 'received': None, 'count': 0, 'txn_ids': []})
        x['amount']['minor'] += r['amount_minor']
        x['count'] += 1
        x['txn_ids'].append(r['id'])
        if received:
            x['received'] = _M(((x['received'] or {}).get('minor') or 0) + received['amount_minor'], received['currency'])

    for r in rows:
        v = views[r['id']]
        purpose = v['purpose']
        if purpose == 'transfer' or r['id'] in paired:
            other = others.get(paired.get(r['id']))
            if other and r['direction'] == 'credit':
                continue  # drawn from its sending side
            frm, to = (side(r['account_id']), side(other['account_id'])) if other else \
                (side(r['account_id']), {'kind': 'other', 'id': None, 'name': 'Another account', 'country': None}) if r['direction'] == 'debit' else \
                ({'kind': 'other', 'id': None, 'name': 'Another account', 'country': None}, side(r['account_id']))
            group = ('remit' if frm['country'] == 'SA' and to['country'] == 'IN' else
                     'cards' if to.get('account_kind') in CARD_KINDS else 'own')
            add(group, frm, to, r, other if other and other['currency'] != r['currency'] else None)
        elif v['person'] and purpose in ('support', 'lend', 'repay') and r['direction'] == 'debit':
            add('family' if purpose == 'support' else 'to_people', side(r['account_id']), {'kind': v['person']['kind'], 'id': v['person']['id'],
                                                                                          'name': v['person']['name'], 'country': None}, r)
        elif v['person'] and purpose in ('repaid', 'borrow') and r['direction'] == 'credit':
            add('from_people', {'kind': v['person']['kind'], 'id': v['person']['id'], 'name': v['person']['name'], 'country': None}, side(r['account_id']), r)
    out = []
    for key, title in GROUPS:
        items = sorted((x for x in lines.values() if x['group'] == key), key=lambda x: -_conv(ctx, x['amount']['minor'], x['amount']['currency']))
        if items:
            out.append({'key': key, 'title': title, 'items': items,
                        'total': _M(sum(_conv(ctx, x['amount']['minor'], x['amount']['currency']) for x in items), ctx['cur'])})
    return {'month': m, 'currency': ctx['cur'], 'groups': out}


# ---------- one person ----------

@route('GET', '/api/people/{kind}/{id}')
def person(req):
    """Everything between you and one person: spends shared with them (the bill, their part, and every share on it, so
    the app can drop or take over a split), money you sent them and they sent you, shared costs, and the balance."""
    kind = valid.choice(req.params['kind'], {'member', 'contact'}, 'kind')
    pid = valid.ident(req.params['id'], 'person')
    p = next((x for x in households.people(req.hh, req.db) if x['kind'] == kind and x['id'] == pid), None)
    if not p:
        raise ApiError(404, 'no such person')
    hh, me, col = req.hh, req.member['id'], 'member_id' if kind == 'member' else 'contact_id'
    splits = hh.run(f'SELECT * FROM splits WHERE household_id = :hid AND {col} = :p', p=pid)
    shared = []
    if splits:
        sql, prm = valid.inlist('s', [s['txn_id'] for s in splits])
        rows = {r['id']: r for r in ledger.visible_txns(hh, me, f'AND t.id IN {sql}', **prm)}
        views = {v['id']: v for v in ledger.txn_views(hh, list(rows.values()))}
        every = defaultdict(list)
        for s in hh.run(f'SELECT * FROM splits WHERE household_id = :hid AND settled_at IS NULL AND txn_id IN {sql}', **prm):
            every[s['txn_id']].append({'member_id': s['member_id'], 'contact_id': s['contact_id'], 'share_minor': s['share_minor']})
        for s in splits:
            if s['txn_id'] in views:
                v = views[s['txn_id']]
                shared.append({'txn': v, 'share': _M(s['share_minor'], v['amount']['currency']), 'settled': bool(s['settled_at']),
                               'splits': every[s['txn_id']]})
        shared.sort(key=lambda x: (x['txn']['day'], x['txn']['id']), reverse=True)
    lent = [tid for tid, b in plan.borrowed(hh).items() if (b['member_id'] if kind == 'member' else b['contact_id']) == pid]
    bsql, bprm = valid.inlist('b', lent)
    moved = ledger.visible_txns(hh, me, f"AND (m.person_{col} = :p OR t.id IN {bsql})", p=pid, **bprm)
    sent, received = [], []
    for v in ledger.txn_views(hh, moved):
        if (v['person'] or {}).get('id') != pid:
            continue
        if v['purpose'] in ('lend', 'support', 'repay') and v['direction'] == 'debit':
            sent.append(v)
        elif v['purpose'] in ('repaid', 'borrow'):
            received.append(v)
    costs = [{'day': c['day'], 'what': c['what'], 'amount': _M(c['minor'], c['currency'])}
             for c in plan.shared_costs(hh) if c['key'] == (kind, pid)]
    costs.sort(key=lambda c: c['day'], reverse=True)
    tot = lambda ms: [_M(v, c) for c, v in sorted(_sum(ms).items())]
    return {'person': p, 'shared': shared, 'sent': sent, 'received': received, 'shared_costs': costs,
            'totals': {'shared': tot([(x['txn']['amount'], 1) for x in shared]), 'their_part': tot([(x['share'], 1) for x in shared if not x['settled']]),
                       'sent': tot([(v['amount'], 1) for v in sent]), 'received': tot([(v['amount'], 1) for v in received])}}


def _sum(pairs):
    out = defaultdict(int)
    for m, sign in pairs:
        out[m['currency']] += sign * m['minor']
    return out


# ---------- review, by merchant ----------

REVIEW_WHERE = " AND (m.txn_id IS NULL OR (m.confidence < :rb AND m.set_by != 'user'))"


@route('GET', '/api/review/merchants')
def review_merchants(req):
    """The whole review queue grouped by merchant, biggest group first: one tap then sorts every row of a merchant."""
    rows = ledger.visible_txns(req.hh, req.member['id'], REVIEW_WHERE, rb=classify.REVIEW_BELOW)
    groups = {}
    for r in rows:
        key = classify.merchant_key(r['merchant'])
        g = groups.setdefault(key, {'merchant': r['merchant'] or '', 'count': 0, 'debits': 0, 'totals': defaultdict(int), 'last_day': r['day'],
                                    'category': None, 'account_name': ledger.bank_label(r), 'txn_ids': []})
        g['count'] += 1
        g['debits'] += r['direction'] == 'debit'
        g['totals'][r['currency']] += r['amount_minor'] if r['direction'] == 'debit' else -r['amount_minor']
        if r['category'] and r['category'] != 'Uncategorized':
            g['category'] = g['category'] or r['category']
        if len(g['txn_ids']) < 50:
            g['txn_ids'].append(r['id'])
    items = [{**{k: v for k, v in g.items() if k not in ('totals', 'debits')}, 'direction': 'debit' if g['debits'] * 2 >= g['count'] else 'credit',
              'totals': [_M(v, c) for c, v in sorted(g['totals'].items())]} for g in groups.values()]
    items.sort(key=lambda g: (g['merchant'] == '', -g['count'], g['merchant'].lower()))
    return {'items': items, 'count': len(rows)}


@route('POST', '/api/review/merchant')
def review_merchant(req):
    """Sort every transaction of one merchant at once (and the ones still to come): a learned rule with the category and/or
    purpose given, applied to all of that merchant's rows except those set one by one."""
    b = req.json
    merchant = valid.text(b.get('merchant'), 'merchant', 80)
    category = valid.text(b.get('category'), 'category', 40, required=False) or ''
    purpose = valid.choice(b['purpose'], ledger.PURPOSES, 'purpose') if b.get('purpose') else ''
    if not (category or purpose):
        raise ApiError(400, 'send a category or a purpose')
    pm, pc = households.person_of(req, b['person']) if b.get('person') else (None, None)
    ids = classify.apply_rule(req.hh, merchant, category, purpose, pm, pc)
    left = ledger.visible_txns(req.hh, req.member['id'], REVIEW_WHERE, rb=classify.REVIEW_BELOW)
    return {'merchant': merchant, 'updated': len(ids), 'left': len(left)}


# ---------- one credit card ----------

@route('GET', '/api/insights/card/{id}')
def card(req):
    """One card: owed now, the last statement (billed in its cycle, paid since it closed; None without a statement day),
    six months of spending, payments and money lost to interest and fees, utilisation and the next due date. A field
    that is not known is None, for the app to say "unknown"."""
    ctx = insights.load(req)
    aid = valid.ident(req.params['id'], 'account')
    a = next((x for x in ctx['accounts'] if x['id'] == aid), None)
    if not a or a['kind'] not in CARD_KINDS:
        raise ApiError(404, 'no such card')
    cur, today = a['currency'], ctx['today']
    rows = [t for t in ctx['raw_txns'] if t['account_id'] == aid and t['currency'] == cur and t['category'] != 'Ignored']

    def total(keep, after, upto):
        return _M(sum(t['amount_minor'] for t in rows if keep(t) and after < t['day'] <= upto), cur)
    lost = lambda t: t['direction'] == 'debit' and insights.is_loss(t)
    spend = lambda t: t['direction'] == 'debit' and t['purpose'] != 'transfer' and not insights.is_loss(t)
    credit = lambda t: t['direction'] == 'credit'
    months = [{'month': m, 'spent': total(spend, m, m + '-99'), 'paid': total(credit, m, m + '-99'), 'lost': total(lost, m, m + '-99')}
              for m in (engine.add_months(today[:7], -k) for k in range(5, -1, -1))]
    statement = None
    if a['statement_day']:
        close = f"{today[:7]}-{min(28, a['statement_day']):02d}"
        close = close if close <= today else engine.add_months(close, -1)
        opened = engine.add_months(close, -1)
        billed = total(lambda t: t['direction'] == 'debit', opened, close)['minor'] - total(credit, opened, close)['minor']
        paid = total(credit, close, '9999')['minor']
        statement = {'from': opened, 'to': close, 'billed': _M(max(0, billed), cur), 'paid': _M(paid, cur), 'left': _M(max(0, billed - paid), cur)}
    due = None
    if a['due_day']:
        due = f"{today[:7]}-{min(28, a['due_day']):02d}"
        due = due if due >= today else engine.add_months(due, 1)
    owed = None if a['balance'] is None else max(0, -a['balance']['minor'])
    rate, assumed = insights.card_rate(a['rate_bp'], cur)
    return {'id': aid, 'currency': cur, 'owed': None if owed is None else _M(owed, cur), 'limit': a['credit_limit'], 'used_pct': a['used_pct'],
            'due_day': a['due_day'] or None, 'next_due': a['statement_due_on'] or due, 'statement': statement, 'months': months,
            'statement_due': a['statement_due'], 'min_due': a['min_due'], 'statement_due_on': a['statement_due_on'],
            'rate_bp': rate, 'rate_assumed': assumed, 'interest_month': None if owed is None else _M(owed * rate / 120000, cur)}
