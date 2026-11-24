"""Insights for v3: loads the household's rows into the plain shapes engine.py works on (the math stays there), and
serves /insights/*. load() is shared with api/plan.py and api/mcp.py. Amounts in the household's base currency."""
import json
import math
from collections import defaultdict
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import domain
import engine
from api.app import ApiError, route

FALLBACK_SAR_INR = 24.9  # used only when no rate service answers and none was ever stored
SETTINGS = {'salary_minor': None, 'salary_currency': None, 'salary_day': None, 'emergency_months': 6,
            'debt_strategy': 'avalanche', 'extra_to_debt_minor': None,
            'fd_rates_bp': {'INR': engine.NRE_FD_RATE_BP, 'SAR': 500}}  # what "a safe deposit" pays, per currency: the asset verdict's yardstick
TXN_SQL = ('SELECT t.*, m.purpose, m.confidence, m.set_by, m.person_member_id, m.person_contact_id, m.liability_id, m.asset_id, '
           'm.commitment_id, m.claim_id, m.fund_id, a.name AS account_name, a.visibility, a.owner_member_id '
           'FROM transactions t LEFT JOIN txn_meta m ON m.txn_id = t.id AND m.household_id = t.household_id '
           'LEFT JOIN accounts a ON a.id = t.account_id AND a.household_id = t.household_id '
           'WHERE t.household_id = :hid AND t.deleted_at IS NULL ORDER BY t.day, t.occurred_at, t.id')


CARD_KINDS = ('credit_card', 'bnpl')
CARD_RATE_BP = {'INR': 3600, 'SAR': 3000}  # a card's yearly rate when the card has none: Indian ~3%/month, Saudi ~2.5%
LOSS_CATEGORIES = {'Interest & late fees', 'FX markup & VAT', 'Bank fees', 'Fees & interest'}


def card_rate(rate_bp, currency):
    """(rate_bp, assumed): the card's own rate, else the usual one for its country."""
    return (rate_bp, False) if rate_bp else (CARD_RATE_BP.get(currency, engine.CARD_RATE_BP), True)


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
    items = hh.run('SELECT claim_id, txn_id, claimed_minor, claimed_currency FROM claim_items WHERE household_id = :hid')
    claimed = {c['txn_id']: c['claim_id'] for c in items}
    claim_part = {}  # txn id -> the part a claim covers (in the txn's currency) when it is not the whole amount
    for c in items:
        t = by_id.get(c['txn_id'])
        src = c['claimed_currency'] or (t or {}).get('currency')
        if t and c['claimed_minor'] is not None and (src == t['currency'] or {src, t['currency']} <= engine.SUPPORTED):  # no rate: the whole amount
            claim_part[t['id']] = min(t['amount_minor'], round(engine.conv(c['claimed_minor'], src, t['currency'], r)))
    theirs = defaultdict(int)
    splits = hh.run('SELECT txn_id, member_id, contact_id, share_minor FROM splits WHERE household_id = :hid')
    for s in splits:
        t = by_id.get(s['txn_id'])
        if t and (s['member_id'] is None or s['member_id'] != t['member_id']):  # rows are other people's shares
            theirs[s['txn_id']] += s['share_minor']
    liabs = hh.run('SELECT * FROM liabilities WHERE household_id = :hid ORDER BY created_at, id')
    for l in liabs:  # a loan you share with its holder: your share is what you owe (the whole loan stays in l['loan'])
        l['loan'] = {k: l[k] for k in ('principal_minor', 'opening_balance_minor', 'emi_minor')}
        l.update({k: round(v * (l.get('my_share_pct') or 100) / 100) for k, v in l['loan'].items()})
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
    from api import plan
    costs = plan.asset_cost_rows(hh)
    for c in costs:
        asset_share[c['txn_id']] += sum(s['share_pct'] for s in sharers[c['asset_id']] if s['cost_type'] in (c['cost_type'], '*'))
    debt_rows = [l for l in liabs if l['kind'] not in ('credit_card',) and not l['closed_at']]
    contact_names = {c['id']: c['name'].strip().lower() for c in hh.run('SELECT id, name FROM contacts WHERE household_id = :hid')}
    holders = [(l, contact_names.get(l['holder_contact_id'])) for l in debt_rows if l.get('holder_contact_id') and l['emi_minor']]
    lent = plan.borrowed(hh)  # a card lent for a period: its plain spending then is theirs
    commit_share = {c['id']: sum(s['share_minor'] for s in shares[c['id']]) for c in commits}

    pot_pct = defaultdict(int)  # fund id -> % of it the co-owners hold
    for s in hh.run('SELECT fund_id, share_pct FROM fund_shares WHERE household_id = :hid'):
        pot_pct[s['fund_id']] += s['share_pct']
    trip_tags = hh.run('SELECT * FROM trip_txns WHERE household_id = :hid')
    expected = {r['txn_id'] for r in trip_tags if r['status'] in ('missed', 'claimed')}  # money expected back: not spending
    txns = []
    for t in rows:
        debit = t['direction'] == 'debit'
        purpose = t['purpose'] or ('spend' if debit else 'income')
        user = t['set_by'] == 'user'
        if t['id'] in lent:
            b = lent[t['id']]
            t = {**t, 'purpose': b['purpose'], 'person_member_id': b['member_id'], 'person_contact_id': b['contact_id']}
            purpose = b['purpose']
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
            if not e['liability_id'] and e['purpose'] == 'spend':  # your part of a shared loan, sent to its holder
                text = _text(t)
                e['liability_id'] = next((l['id'] for l, name in holders if name and name in text and l['currency'] == t['currency']
                                          and l['emi_minor'] / 2 <= t['amount_minor'] <= l['emi_minor'] * 2), None)
                if e['liability_id']:
                    e['purpose'] = 'loan_payment'
            if not e['asset_id'] and (aid := _match(assets, t)):
                e.update(asset_id=aid, purpose='asset')
            if not e['commitment_id']:
                e['commitment_id'] = _match(commits, t)
        if e['commitment_id'] and commit_share.get(e['commitment_id']) and debit:
            e['theirs_minor'] = max(e['theirs_minor'], min(t['amount_minor'], commit_share[e['commitment_id']]))
        if t['fund_id'] in pot_pct:  # a shared pot: only the household's part of its rent and groceries is ours
            if debit:
                e['theirs_minor'] = max(e['theirs_minor'], round(t['amount_minor'] * pot_pct[t['fund_id']] / 100))
            else:
                e['amount_minor'] -= round(t['amount_minor'] * pot_pct[t['fund_id']] / 100)
        if asset_share[t['id']]:
            e['theirs_minor'] = max(e['theirs_minor'], round(t['amount_minor'] * min(100, asset_share[t['id']]) / 100))
        txns.append(e)

    milestones = hh.run('SELECT * FROM asset_milestones WHERE household_id = :hid ORDER BY due_on, id')
    asset_cur = {a['id']: a['currency'] for a in hh.run('SELECT id, currency FROM assets WHERE household_id = :hid')}
    tranches = defaultdict(list)  # liability id -> its milestones: a construction loan, paid out in tranches
    for m in milestones:
        if m['liability_id']:
            tranches[m['liability_id']].append(m)
    for l in liabs:
        stones = [(m['disbursed_on'], round(engine.conv(m['amount_minor'], asset_cur.get(m['asset_id'], l['currency']), l['currency'], r)), m)
                  for m in tranches[l['id']] if m['disbursed_on']] if l['id'] in tranches else None
        l.update(_liability_calc(l, txns, r, stones, today))
    from api import ledger
    accts = ledger.account_views(hh, me)
    for l in liabs:  # a card with its account owes what the account's balance says (statements and SMS state it)
        b = next((a['balance'] for a in accts if a['id'] == l['account_id']), None)
        if l['kind'] in CARD_KINDS and b is not None:
            l['outstanding_minor'] = max(0, round(-engine.conv(b['minor'], b['currency'], l['currency'], r)))
    interest ={tid: i for l in liabs for tid, i in l['interest_by_txn'].items()}
    eng_txns = []  # an EMI's interest part is spending (a fee); the rest pays the loan down
    for e in txns:
        i = interest.get(e['id'], 0)
        own = e['amount_minor'] - claim_part[e['id']] if e['purpose'] == 'claim' and e['id'] in claim_part else 0
        if i and e['purpose'] == 'loan_payment':
            eng_txns += [{**e, 'id': e['id'] + ':interest', 'amount_minor': i, 'purpose': 'fee', 'category': 'Fees & interest'},
                         {**e, 'amount_minor': e['amount_minor'] - i}]
        elif own:  # the part of a bill the claim doesn't cover is your spending
            eng_txns += [{**e, 'id': e['id'] + ':own', 'amount_minor': own, 'purpose': 'spend'}, {**e, 'amount_minor': e['amount_minor'] - own}]
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
              'rate_bp': l['rate_bp'], 'emi_minor': l['emi_minor'], 'currency': l['currency'], 'pattern': l['match_pattern'], 'liability_kind': l['kind'],
              'pre_emi_minor': (l['construction'] or {}).get('pre_emi', 0), 'emi_from': l['emi_from'] if l['construction'] else '',
              'account_id': l['account_id']}
             for l in liabs if not l['closed_at'] and l['outstanding_minor'] > 0]
    tracked = {l['account_id'] for l in liabs if l['account_id'] and not l['closed_at']}
    loans += [{'id': a['id'], 'name': ledger.label(a['institution'], a['name'], a['last4']),
               'kind': 'card', 'balance_now': -a['balance']['minor'], 'rate_bp': a['rate_bp'], 'emi_minor': 0, 'currency': a['currency'],
               'pattern': '', 'liability_kind': 'credit_card', 'pre_emi_minor': 0, 'emi_from': '', 'account_id': a['id']}
              for a in accts if a['kind'] == 'credit_card' and a['id'] not in tracked and a['balance'] and a['balance']['minor'] < 0]
    acct_rate = {a['id']: a['rate_bp'] for a in accts}
    for l in loans:
        l.update(interest_of(l, acct_rate.get(l['account_id']), l['account_id'], txns, today, r))
    s = settings(hh)
    eng_settings = {'salary': s['salary_minor'] / 100 if s['salary_minor'] else None, 'salary_currency': s['salary_currency'] or cur,
                    'emergency_months': s['emergency_months'], 'debt_strategy': s['debt_strategy'],
                    'extra_to_debt': s['extra_to_debt_minor'], 'extra_currency': cur,
                    'salary_history': hh.run('SELECT * FROM salary_history WHERE household_id = :hid ORDER BY from_month, created_at')}
    return {'hh': hh, 'cur': cur, 'rate': rate, 'r': r, 'today': today, 'house': house, 'rows': rows, 'by_id': by_id, 'txns': eng_txns,
            'raw_txns': txns, 'status_txns': status_txns, 'liabs': liabs, 'commits': eng_commits, 'status': status, 'shares': shares,
            'payments': pays, 'funds': funds, 'loans': loans, 'assets': assets, 'costs': costs, 'asset_sharers': sharers,
            'settings': s, 'eng_settings': eng_settings, 'claimed': claimed, 'splits': splits, 'claim_part': claim_part,
            'trips': hh.run('SELECT * FROM trips WHERE household_id = :hid ORDER BY start_on DESC, id'), 'trip_tags': trip_tags,
            'claim_table': hh.run('SELECT * FROM claims WHERE household_id = :hid ORDER BY created_at DESC, id'),
            'milestones': milestones, 'accounts': accts,
            'accounts_cash': hh.run("SELECT currency, last_balance_minor FROM accounts WHERE household_id = :hid AND archived_at IS NULL "
                                    "AND kind IN ('bank', 'wallet', 'cash')")}


def interest_of(l, acct_rate_bp, account_id, txns, today, r):
    """One debt's interest a month, the one figure Home, Month, Wealth and the debt plan show, and the yearly rate the
    plan runs on. A card: the interest and fees actually charged on its account, averaged over the 3 full months before
    this one (months with no activity on it are left out); its rate is its own (rate_bp), else charges × 12 ÷ balance,
    else the usual one for its country (rate_assumed). A loan: its schedule (outstanding × rate ÷ 12)."""
    bal = max(0, l['balance_now'])
    if l['liability_kind'] not in CARD_KINDS:
        return {'interest_minor': round(bal * (l['rate_bp'] or 0) / 120000), 'rate_assumed': False, 'interest_source': 'schedule'}
    months = {engine.add_months(today[:7], -k) for k in (1, 2, 3)}
    rows = [t for t in txns if account_id and t['account_id'] == account_id and t['day'][:7] in months]
    seen = {t['day'][:7] for t in rows}
    charged = sum(engine.conv(t['amount_minor'], t['currency'], l['currency'], r) for t in rows if t['direction'] == 'debit' and is_loss(t)) / max(1, len(seen))
    own = l['rate_bp'] or acct_rate_bp
    if own:
        rate, source = own, 'rate'
    elif charged and bal:
        rate, source = min(100000, round(charged * 120000 / bal)), 'charges'
    else:
        rate, source = card_rate(None, l['currency'])[0], 'assumed'
    if seen:  # what the bank really charged
        return {'interest_minor': round(charged), 'rate_bp': rate, 'rate_assumed': source == 'assumed', 'interest_source': 'charges'}
    return {'interest_minor': round(bal * rate / 120000), 'rate_bp': rate, 'rate_assumed': source == 'assumed', 'interest_source': source}


def debt_of(ctx, id):
    """The debt (ctx['loans'] entry) for a liability id or a card's account id, else None."""
    return next((l for l in ctx['loans'] if id in (l['id'], l.get('account_id'))), None)


def interest_total(ctx, kind=None):
    """The debts' interest a month (interest_of), in the base currency; kind 'card' or 'loan' for one side."""
    return sum(to_cur(l['interest_minor'], l['currency'], ctx) for l in ctx['loans'] if kind in (None, l['kind']))


def _liability_calc(l, txns, r, tranches=None, today=''):
    """Outstanding from the opening balance and the payments after it. A loan payment pays the month's interest
    (outstanding × rate / 12) first and the rest is principal (engine.loan_walk). A card with its account follows that
    account's lines. A construction loan (`tranches`: milestones disbursed from it) owes what was disbursed, not the
    opening balance, and every payment counts (pre-EMI payments are interest only)."""
    bal, interest, pays, cons = l['opening_balance_minor'], {}, [], None
    after = [t for t in txns if t['day'] > l['as_of']]
    if l['kind'] in ('credit_card', 'bnpl') and l['account_id']:
        for t in after:
            if t['account_id'] == l['account_id']:
                amt = round(engine.conv(t['amount_minor'], t['currency'], l['currency'], r))
                bal += amt if t['direction'] == 'debit' else -amt
                if t['direction'] == 'credit':
                    pays.append({'txn_id': t['id'], 'day': t['day'], 'amount': amt, 'interest': 0})
    else:
        mine = [t for t in (txns if tranches is not None else after) if t['liability_id'] == l['id'] and t['direction'] == 'debit']
        walk = [{'id': t['id'], 'day': t['day'], 'amount': round(engine.conv(t['amount_minor'], t['currency'], l['currency'], r))} for t in mine]
        out = [(d, a) for d, a, _ in tranches or () if d <= today]
        bal, split = engine.loan_walk(0 if tranches is not None else bal, l['rate_bp'], walk, out)
        for t, w in zip(mine, walk):
            if t['currency'] == l['currency']:
                interest[t['id']] = split[t['id']]
            pays.append({'txn_id': t['id'], 'day': t['day'], 'amount': w['amount'], 'interest': split[t['id']]})
        if tranches is not None:
            cons = engine.construction(l['principal_minor'] or l['opening_balance_minor'], out, max(0, bal), l['rate_bp'], l['emi_minor'],
                                       l['emi_from'], today)
            cons['tranches'] = sorted(({'milestone_id': m['id'], 'asset_id': m['asset_id'], 'name': m['name'], 'day': d, 'amount_minor': a,
                                        'future': d > today} for d, a, m in tranches), key=lambda x: x['day'])
    return {'outstanding_minor': max(0, bal), 'interest_by_txn': interest, 'payments': pays, 'construction': cons}


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
    """(owed to you, owed by you) by people, in the base currency: households.balances(), so Home and People agree."""
    from api import households
    owes = owed = 0.0
    for bal in households.balances(hh).values():
        for c, v in bal.items():
            if v > 0:
                owes += to_cur(v, c, ctx)
            elif v < 0:
                owed += to_cur(-v, c, ctx)
    return owes, owed


def is_loss(t):
    return t['purpose'] == 'fee' or t['category'] in LOSS_CATEGORIES


def spend_split(ctx, m):
    """({category: spent}, {loss category: lost}) for month m, your share, in the base currency. Only what
    engine.counted() counts is spending: transfers, card bill payments, loan principal and lending are not.
    An EMI's interest part is lost as 'Loan interest'."""
    cats, loss = defaultdict(float), defaultdict(float)
    for t in ctx['txns']:
        if t['day'].startswith(m) and (c := engine.counted(t)):
            v = engine.conv(c, t['currency'], ctx['cur'], ctx['r'])
            if is_loss(t):
                loss['Loan interest' if t['id'].endswith(':interest') else 'Card instalment interest' if t['category'] == domain.CARD_EMI_CATEGORY
                     else t['category'] if t['category'] in LOSS_CATEGORIES else 'Bank fees'] += v
            else:
                cats[t['category']] += v
    return cats, loss


def month(req, ctx, m):
    cur = ctx['cur']
    owes, owed = people_totals(ctx, req.hh)
    pending = sum(to_cur(v, c, ctx) for c, v in claims_pending(ctx).items())
    v = engine.month_view(ctx['txns'], ctx['commits'], ctx['funds'], ctx['loans'], ctx['eng_settings'], m, ctx['today'], cur, ctx['r'],
                          owes, owed, pending)
    by_ccy = defaultdict(int)
    for t in ctx['txns']:
        if t['day'].startswith(m) and engine.counted(t):
            by_ccy[t['currency']] += engine.counted(t)
    by_cat, loss = spend_split(ctx, m)
    last = engine.add_months(m, -1)
    last_cat, last_loss = spend_split(ctx, last)
    last_in, last_out = engine.income_of(ctx['txns'], last, cur, ctx['r']), engine.spent(ctx['txns'], last, cur, ctx['r'])
    kinds = defaultdict(float)
    for l in ctx['loans']:
        kinds[{'credit_card': 'cards', 'bnpl': 'bnpl'}.get(l['liability_kind'], 'loans')] += to_cur(l['balance_now'], l['currency'], ctx)
    kinds['people'] = owed
    v['owed_by_you'] = {**{k: M(kinds[k], cur) for k in ('loans', 'cards', 'bnpl', 'people')}, 'total': M(sum(kinds.values()), cur)}
    # spending by category without the losses; the losses (fees, interest, FX markup and VAT) as their own group
    v['by_category'] = [{'category': k, 'amount': M(x, cur), 'last': M(last_cat.get(k, 0), cur)} for k, x in sorted(by_cat.items(), key=lambda kv: -kv[1])]
    v['loss'] = {'total': M(sum(loss.values()), cur), 'last': M(sum(last_loss.values()), cur),
                 'by_category': [{'category': k, 'amount': M(x, cur)} for k, x in sorted(loss.items(), key=lambda kv: -kv[1])]}
    v['saved'] = M(v['income']['minor'] - v['spent']['minor'], cur)
    v['last_month'] = {'month': last, 'income': M(last_in, cur), 'spent': M(last_out, cur), 'saved': M(last_in - last_out, cur)}
    v['trend'] = [{'month': x, 'spent': M(engine.spent(ctx['txns'], x, cur, ctx['r']), cur), 'income': M(engine.income_of(ctx['txns'], x, cur, ctx['r']), cur)}
                  for x in (engine.add_months(m, -k) for k in range(11, -1, -1))]
    v['spent_by_currency'] = [M(x, c) for c, x in sorted(by_ccy.items())]  # as spent, never converted: the Saudi / India split
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


def lookahead(ctx, n=12, dues=False):
    """Free money per month (after everyday spending). dues: each month also carries the planner's dues and gap
    (overview.plan_months), and its "Short by" warning is that gap, the same figure Home and Plan show."""
    # EMI commitments tied to a liability are counted through the loan (until its payoff), not twice
    commits = [c for c in ctx['commits'] if not (c['liability_id'] and any(l['id'] == c['liability_id'] for l in ctx['loans']))]
    out = engine.lookahead(ctx['txns'], commits, ctx['funds'], ctx['loans'], ctx['eng_settings'], ctx['today'], ctx['cur'], ctx['r'], n)
    out['interest_per_month'] = M(interest_total(ctx), ctx['cur'])
    if dues:
        from api import overview
        for x, pm in zip(out['months'], overview.plan_months(ctx, n)):
            x.update(dues=pm['out'], surplus=pm['surplus'], short=pm['short'])
            x['warnings'] = [w for w in x['warnings'] if not w.startswith('Short by')]
            if pm['short']:
                x['warnings'].append(f"Short by {engine.fmt(pm['short']['minor'], ctx['cur'])}: dues are more than the salary")
    return out


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
    out = engine.what_if(loans, la['extra_to_debt']['minor'], la['months'][0]['free']['minor'], amount, cur, pay, ctx['today'], months, rate_bp)
    free = sum(m['free']['minor'] for m in la['months']) / len(la['months'])  # average free money a month, next 12 months
    out['free_per_month'] = M(free, cur)
    out['recover_months'] = math.ceil(amount / free) if free > 0 else None  # months of free money to earn it back
    return out


def payoff(ctx, q):
    """How many months to recover: loan EMIs continue as scheduled, the average free money a month (after EMIs, from the
    look-ahead, or the extra you set) clears the cards first, costliest first, then (prepay=1) the loans. spend_minor:
    'what if I spend this much this month' and how many months it delays. Base currency."""
    try:
        spend = int(q.get('spend_minor') or 0)
    except ValueError:
        raise ApiError(400, 'spend_minor must be a whole number')
    if spend < 0:
        raise ApiError(400, 'spend_minor must not be negative')
    cur, r, today = ctx['cur'], ctx['r'], ctx['today']
    spend = round(engine.conv(spend, (q.get('currency') or cur).upper(), cur, r))
    prepay = q.get('prepay') in ('1', 'true')
    surplus = lookahead(ctx, 12)['extra_to_debt']['minor']
    debts = [{'id': l['id'], 'name': l['name'], 'kind': l['kind'], 'balance': round(engine.conv(l['balance_now'], l['currency'], cur, r)),
              'rate_bp': l['rate_bp'], 'rate_assumed': l.get('rate_assumed', False), 'local': M(l['balance_now'], l['currency']),
              'emi': round(engine.conv(engine.emi_in(l, today[:7]), l['currency'], cur, r))} for l in ctx['loans']]
    plan = engine.payoff(debts, surplus, prepay, spend)
    try:
        extra = int(q.get('extra_minor') or 1000_00)  # "paying extra": this much a month on top of the free money
    except ValueError:
        raise ApiError(400, 'extra_minor must be a whole number')
    fast = engine.payoff(debts, max(0, surplus) + max(0, extra), prepay, spend)
    base = engine.payoff(debts, surplus, prepay) if spend else plan
    month = lambda n: engine.add_months(today[:7], n) if n is not None else None
    names = {d['id']: d['name'] for d in debts}
    cards = [d for d in debts if d['kind'] == 'card']
    slow = engine.min_due_interest(cards)
    now = lambda kind: interest_total(ctx, kind)
    delay = lambda k: None if plan[k] is None or base[k] is None else plan[k] - base[k]
    notes = [f"{d['name']}: no rate set and no interest charged yet, assumed {d['rate_bp'] / 100:g}% a year (usual for {'Indian' if d['local']['currency'] == 'INR' else 'Saudi'} cards)"
             for d in cards if d['rate_assumed']]
    notes.append('Interest a month is what the cards really charged (average of the last 3 months) and the loans’ schedules.')
    notes.append(f'Free money for debt: {engine.fmt(surplus, cur)} a month, the next 12 months’ average after EMIs, bills and everyday spending.')
    if surplus <= 0:
        notes.append('Nothing is left after EMIs and bills, so the cards only grow. Cut spending or move a set-aside to start.')
    return {'currency': cur, 'surplus': M(surplus, cur), 'prepay': prepay, 'spend': M(spend, cur),
            'cards': {'months': plan['cards_months'], 'month': month(plan['cards_months'])},
            'debt_free': {'months': plan['debt_months'], 'month': month(plan['debt_months'])},
            'delay': {'cards': delay('cards_months'), 'debt_free': delay('debt_months'), 'interest': M(plan['interest'] - base['interest'], cur)},
            'interest_now': {'cards': M(now('card'), cur), 'loans': M(now('loan'), cur), 'total': M(now('card') + now('loan'), cur)},
            'interest_total': M(plan['interest'], cur), 'card_interest': M(plan['card_interest'], cur),
            'card_interest_min_due': M(slow, cur), 'interest_saved': M(max(0, slow - plan['card_interest']), cur),
            'debts': [{'id': d['id'], 'name': d['name'], 'kind': d['kind'], 'balance': M(d['balance'], cur), 'local': d['local'],
                       'rate_bp': d['rate_bp'], 'rate_assumed': d['rate_assumed'], 'emi': M(d['emi'], cur),
                       'cleared': month(plan['cleared'].get(d['id'])), 'months': plan['cleared'].get(d['id'])}
                      for d in sorted(debts, key=lambda d: (d['kind'] != 'card', -d['rate_bp']))],
            'timeline': [{'month': month(x['n']), 'interest': M(x['interest'], cur), 'cards': M(x['cards'], cur), 'loans': M(x['loans'], cur),
                          'cleared': [names.get(i, 'This purchase') for i in x['cleared']], 'by': x['by']} for x in plan['timeline']],
            'extra': M(extra, cur), 'with_extra': {'debt_free': month(fast['debt_months']), 'months': fast['debt_months'], 'interest': M(fast['interest'], cur),
                                                   'timeline': [{'month': month(x['n']), 'total': M(x['cards'] + x['loans'], cur)} for x in fast['timeline']]},
            'assumptions': notes}


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


def loan_alerts(ctx):
    """A loan whose EMI (or pre-EMI, before a construction loan's full EMIs) for one of the last months has no payment
    linked to it: bounced, returned or forgotten. Months before the loan was tracked (as_of) are not checked."""
    out = []
    for l in ctx['liabs']:
        cons = l['construction']
        pre = cons and cons['phase'] == 'pre_emi'
        due = cons['pre_emi'] if pre else l['emi_minor']
        if l['kind'] != 'loan' or l['closed_at'] or l['outstanding_minor'] <= 0 or not due:
            continue
        asset = next((a['id'] for a in ctx['assets'] if a['liability_id'] == l['id']), None)
        for m in engine.missed_months(l['due_day'], [p['day'] for p in l['payments']], l['as_of'], ctx['today']):
            out.append({'level': 'bad', 'link': f'/assets/{asset}' if asset else '/plan', 'liability_id': l['id'], 'month': m,
                        'text': f"{l['name']}: no {'pre-EMI' if pre else 'EMI'} payment seen for {m} ({engine.fmt(due, l['currency'])}). "
                                'Bounced? Pay it and link the payment to the loan.'})
    return out


def card_alerts(ctx, days=7):
    """A card with money owed whose due day is in the next `days` days: pay it in full to keep the interest off."""
    today = date.fromisoformat(ctx['today'])
    out = []
    for a in ctx['accounts']:
        owed = -(a['balance'] or {}).get('minor', 0)
        if a['kind'] != 'credit_card' or owed <= 0 or not a['due_day']:
            continue
        due = today.replace(day=min(a['due_day'], 28))
        if due < today:
            due = date.fromisoformat(engine.add_months(due.isoformat(), 1))
        if (due - today).days <= days:
            out.append({'level': 'bad' if due == today else 'warn', 'link': f"/accounts/{a['id']}", 'account_id': a['id'],
                        'text': f"{a['institution'] or a['name']} card: {engine.fmt(owed, a['currency'])} due {'today' if due == today else due.strftime('%d %b')}. "
                                'Pay it in full to avoid interest.'})
    return out


def home(req, ctx):
    from api import overview, plan
    m = month(req, ctx, ctx['today'][:7])
    la = lookahead(ctx, 6, dues=True)
    commits = sorted((plan.commitment_json(c, ctx) for c in ctx['commits']), key=lambda c: c['next_due'])
    alerts = []
    for c in overview.cash_vs_due(ctx):  # cash in the accounts against the next 30 days: at the top of Home
        if c['short']['minor']:
            move = f", move {engine.fmt(c['move']['minor'], ctx['cur'])}" if c['country'] != 'SA' else f", short {engine.fmt(c['short']['minor'], c['due']['currency'])}"
            alerts.append({'level': 'bad', 'top': True, 'country': c['country'], 'link': '/plan',
                           'text': f"Due in 30 days {engine.fmt(c['due']['minor'], c['due']['currency'])}, in accounts {engine.fmt(c['cash']['minor'], c['cash']['currency'])}{move}"})
    missed = loan_alerts(ctx)
    flagged = {a['liability_id'] for a in missed if a['month'] == ctx['today'][:7]}
    for x in overview.plan_months(ctx, 1)[0]['lines']:  # an unpaid instalment or recurring payment past its due date
        if x['overdue'] and x['ref'] not in flagged:
            alerts.append({'level': 'bad', 'overdue': True, 'link': x['link'], 'ref': x['ref'],
                           'text': f"{x['name']} is overdue: {engine.fmt(x['amount']['minor'], x['amount']['currency'])} was due {x['day']}"})
    short = [(r['month'], w) for r in la['months'] for w in r['warnings'] if w.startswith('Short')]
    if short:  # one alert, not one per month
        more = f" (and {len(short) - 1} more month{'s' if len(short) > 2 else ''})" if len(short) > 1 else ''
        alerts.append({'level': 'warn', 'text': f"{short[0][0]}: {short[0][1]}{more}", 'link': '/plan/lookahead'})
    alerts += [{'level': 'warn', 'text': f"Claim {c['name']} pending for {c['age_days']} days: follow up with {c['payer'] or 'the company'}",
                'link': f"/plan/claims/{c['id']}"} for c in plan.claim_rows(ctx) if c['status'] not in ('paid', 'rejected') and c['age_days'] > 30]
    alerts += card_alerts(ctx)
    alerts += missed
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
    return lookahead(load(req), _months(req.query, 12), dues=True)


@route('GET', '/api/insights/whatif')
def whatif_route(req):
    return whatif(load(req), req.query)


@route('GET', '/api/insights/payoff')
def payoff_route(req):
    return payoff(load(req), req.query)


@route('GET', '/api/insights/advice')
def advice_route(req):
    return advice(load(req))


@route('GET', '/api/insights/home')
def home_route(req):
    return home(req, load(req))


@route('GET', '/api/alerts')
def alerts_route(req):
    return {'items': home(req, load(req))['alerts']}
