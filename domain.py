"""Domain model v2 and the money engine's HTTP surface. See docs/brain/domain-model.md and docs/brain/api.md.
Tables are created on first use; the math lives in engine.py. server.py is imported inside functions (it imports
this module lazily, so a top-level import would be circular)."""
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
import json
import os
import re

import engine
from engine import money

SCHEMAS = [
    '''CREATE TABLE IF NOT EXISTS people (id {id} PRIMARY KEY, name TEXT NOT NULL, relation TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
       support_minor BIGINT NOT NULL DEFAULT 0, support_currency TEXT NOT NULL DEFAULT 'INR')''',
    '''CREATE TABLE IF NOT EXISTS commitments (id {id} PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, amount_minor BIGINT NOT NULL,
       currency TEXT NOT NULL, cycle_months INTEGER NOT NULL, next_due TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', match TEXT NOT NULL DEFAULT '')''',
    '''CREATE TABLE IF NOT EXISTS commitment_sharers (commitment_id BIGINT NOT NULL, person_id BIGINT NOT NULL, share_minor BIGINT NOT NULL,
       PRIMARY KEY (commitment_id, person_id))''',
    '''CREATE TABLE IF NOT EXISTS funds (id {id} PRIMARY KEY, name TEXT NOT NULL, target_minor BIGINT NOT NULL, currency TEXT NOT NULL,
       due TEXT NOT NULL, saved_minor BIGINT NOT NULL DEFAULT 0, commitment_id BIGINT)''',
    '''CREATE TABLE IF NOT EXISTS assets (id {id} PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL,
       cost_minor BIGINT NOT NULL DEFAULT 0, value_minor BIGINT NOT NULL DEFAULT 0, paid_cash_minor BIGINT NOT NULL DEFAULT 0,
       loan_liability BIGINT, match TEXT NOT NULL DEFAULT '')''',
    '''CREATE TABLE IF NOT EXISTS asset_milestones (id {id} PRIMARY KEY, asset_id BIGINT NOT NULL, name TEXT NOT NULL, due TEXT NOT NULL,
       amount_minor BIGINT NOT NULL)''',
    '''CREATE TABLE IF NOT EXISTS asset_sharers (asset_id BIGINT NOT NULL, person_id BIGINT NOT NULL, cost_type TEXT NOT NULL,
       share_pct REAL NOT NULL, PRIMARY KEY (asset_id, person_id, cost_type))''',
    'CREATE TABLE IF NOT EXISTS asset_costs (txn_id BIGINT PRIMARY KEY, asset_id BIGINT NOT NULL, cost_type TEXT NOT NULL)',
    '''CREATE TABLE IF NOT EXISTS claims (id {id} PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
       paid_txn_id BIGINT)''',
    'CREATE TABLE IF NOT EXISTS claim_items (txn_id BIGINT PRIMARY KEY, claim_id BIGINT NOT NULL)',
    # Your purpose for one transaction (confidence 1), and for every transaction from a merchant (learned).
    'CREATE TABLE IF NOT EXISTS txn_purposes (txn_id BIGINT PRIMARY KEY, purpose TEXT NOT NULL, person_id BIGINT)',
    'CREATE TABLE IF NOT EXISTS merchant_purposes (merchant TEXT PRIMARY KEY, purpose TEXT NOT NULL, person_id BIGINT)',
]
V2_SETTINGS = 'v2'  # one JSON row in the existing settings table

PURPOSES = {'spend', 'fee', 'transfer', 'income', 'support', 'lend', 'repaid', 'borrow', 'repay', 'loan_payment', 'claim',
            'reimbursement', 'asset', 'saving'}
RELATIONS = {'family', 'friend', 'colleague', 'other'}
KINDS = {'rent', 'bill', 'subscription', 'emi', 'insurance', 'school', 'support', 'milestone', 'other'}
ASSET_KINDS = {'property', 'vehicle', 'investment'}
COST_TYPES = {'fuel', 'service', 'insurance', 'registration', 'parking', 'other'}
CLAIM_STATUS = {'draft', 'submitted', 'paid', 'partly'}
CURRENCIES = {'SAR', 'INR', 'USD'}
MAX_NAME = 60

FEE = re.compile(r'\binterest\b(?![- ]?free)|\bfinance charges?\b|\b(?:late(?: payment)?|annual|joining|processing|over-?limit|renewal|'
                 r'cash advance|forex|markup) fees?\b|\bcharges\b|\bgst on charges\b|\bvat on fees?\b|\bservice charges?\b|فوائد|رسوم', re.I)
CARD_PAY = re.compile(r'\b(?:credit ?card|cc|card) ?(?:bill )?payment\b|\bpayment\b[^.\n]{0,40}\bto (?:your )?credit ?card\b|'
                      r'\bpayment (?:received|thank)|\btop ?-?up\b|سداد بطاقة|\bcredit cards? transactions? t', re.I)  # Al Rajhi: "Debit - Credit Cards Transactions T…" pays the card
LOAN = re.compile(r'\b(?:emi|loan|instal+ments?)\b|قسط', re.I)
CK_PURPOSE = {'emi': 'loan_payment', 'support': 'support', 'milestone': 'asset'}


class NotFound(KeyError):  # a KeyError so MCP's error handling reports it
    pass


def ensure(db):
    """Create the v2 tables once per process and database (kept with server.DB's own marker, so a test that resets
    that resets this too)."""
    import server
    key = ('domain', getattr(db, 'main_file', db.url), db.space)
    if key not in server.DB._schema_ready:
        with db.ddl_lock():
            for s in SCHEMAS:
                db.run(s.format(id='BIGSERIAL' if db.pg else 'INTEGER'))
        server.DB._schema_ready.add(key)


def today():
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo(os.environ.get('EXPENSE_TZ') or 'Asia/Riyadh')).date().isoformat()


# ---------- purpose inference ----------

def annotate(db, rows):
    """Give every transaction from server.transactions() a purpose and a confidence (0-1), in place:
    your choice > claim > reimbursement > own transfer > commitment > asset > learned merchant > friend tag >
    fee words > card payment / top-up words > loan words > income > spend."""
    ensure(db)
    try:
        mine = {r['txn_id']: r for r in db.run('SELECT * FROM txn_purposes')}
    except Exception:  # the data space was dropped and made again in this process (server.drop_space): tables anew
        import server
        server.DB._schema_ready.discard(('domain', getattr(db, 'main_file', db.url), db.space))
        ensure(db)
        mine = {}
    learned = {r['merchant']: r for r in db.run('SELECT * FROM merchant_purposes')}
    items = {r['txn_id']: r['claim_id'] for r in db.run('SELECT * FROM claim_items')}
    claims = db.run('SELECT * FROM claims')
    paid = {c['paid_txn_id']: c['id'] for c in claims if c['paid_txn_id']}
    commits = db.run("SELECT id, kind, currency, amount_minor, match FROM commitments WHERE match != ''")
    assets = db.run("SELECT id, match FROM assets WHERE match != ''")
    people = {p['name'].strip().lower(): p['id'] for p in db.run('SELECT id, name FROM people')}
    import server
    by_id = {t['id']: t for t in rows}
    # A claim waiting for its money: the first later credit of exactly its total is the reimbursement.
    for c in claims:
        if c['paid_txn_id'] or c['status'] == 'paid':
            continue
        its = [by_id[i] for i, cid in items.items() if cid == c['id'] and i in by_id]
        if not its or len({t['currency'] for t in its}) > 1:
            continue
        total, last = round(sum(t['amount'] for t in its) * 100), max(t['received_at'] for t in its)
        hit = next((t for t in sorted(rows, key=lambda t: t['received_at']) if t['direction'] == 'credit' and t['currency'] == its[0]['currency']
                    and round(t['amount'] * 100) == total and t['received_at'] > last and t['id'] not in paid and t['id'] not in mine
                    and t['category'] != server.OWN_TRANSFER), None)
        if hit:
            paid[hit['id']] = c['id']
    for t in rows:
        t['purpose'], t['confidence'], t['person_id'] = infer(t, mine, learned, items, paid, commits, assets, people, server)


def infer(t, mine, learned, items, paid, commits, assets, people, server):
    """(purpose, confidence, person_id) for one transaction; also sets t['commitment_id'] / t['claim_id'] / t['asset_id']."""
    text = f"{t.get('merchant') or ''} {t['body']}".lower()
    debit, minor = t['direction'] == 'debit', round(t['amount'] * 100)
    friend = people.get((t.get('friend') or '').strip().lower())
    if t['id'] in mine:
        return mine[t['id']]['purpose'], 1.0, mine[t['id']]['person_id']
    if t['id'] in items:
        t['claim_id'] = items[t['id']]
        return 'claim', 1.0, None
    if t['id'] in paid:
        t['claim_id'] = paid[t['id']]
        return 'reimbursement', 0.9, None
    if t['category'] == server.OWN_TRANSFER or t.get('linked'):
        return 'transfer', 0.95, None
    if debit:
        for c in commits:
            if c['match'].lower() in text and c['currency'] == t['currency'] and c['amount_minor'] / 2 <= minor <= c['amount_minor'] * 2:
                t['commitment_id'] = c['id']
                return CK_PURPOSE.get(c['kind'], 'spend'), 0.9, None
        for a in assets:
            if a['match'].lower() in text:
                t['asset_id'] = a['id']
                return 'asset', 0.85, None
    m = (t.get('merchant') or '').strip().lower()
    if m and m in learned:
        return learned[m]['purpose'], 0.9, learned[m]['person_id']
    if t.get('friend'):
        if not debit:
            return 'repaid', 0.9, friend
        if round(t.get('theirs', 0) * 100) >= minor:
            return 'lend', 0.85, friend
        return 'spend', 0.9, friend  # split: only your share counts
    if debit and FEE.search(t['body']):
        return 'fee', 0.9, None
    if CARD_PAY.search(t['body']):
        return 'transfer', 0.8, None
    if debit and LOAN.search(t['body']):
        return 'loan_payment', 0.7, None
    if not debit:
        if server.REFUND.search(t['body']):
            return 'spend', 0.8, None  # a refund: negative spending
        return 'income', 0.95 if t['category'] == 'Salary' else 0.6, None
    if t['category'] == 'Family':
        return 'support', 0.7, None
    return 'spend', 0.4 if t['category'] == 'Uncategorized' else 0.8, None


def eng(t):
    """A server.transactions() row in engine.py's shape."""
    return {'id': t['id'], 'day': t['received_at'][:10], 'amount_minor': round(t['amount'] * 100), 'currency': t['currency'],
            'direction': t['direction'], 'purpose': t['purpose'], 'theirs_minor': round((t.get('theirs') or 0) * 100),
            'category': t['category'], 'merchant': t.get('merchant') or '', 'commitment_id': t.get('commitment_id'),
            'person_id': t.get('person_id'), 'friend': t.get('friend') or '', 'settled': t.get('settled'), 'asset_id': t.get('asset_id'),
            'claim_id': t.get('claim_id')}


# ---------- input checks (trust boundary) ----------

def _text(v, field, required=True, n=MAX_NAME):
    s = ' '.join(str(v or '').split())[:n]
    if required and not s:
        raise ValueError(f'{field} is required')
    return s


def _one(v, allowed, field):
    if v not in allowed:
        raise ValueError(f'{field} must be one of {sorted(allowed)}')
    return v


def _cur(v, default=None):
    c = str(v or default or '').strip().upper()
    return _one(c, CURRENCIES, 'currency')


def _minor(v, field, required=True):
    if isinstance(v, dict):  # {"minor": 123, "currency": "SAR"} as sent back
        v = Decimal(int(v.get('minor'))) / 100
    if v in (None, ''):
        if required:
            raise ValueError(f'{field} is required')
        return 0
    m = int(Decimal(str(v).replace(',', '').strip()) * 100)
    if not 0 <= m < 10 ** 13:
        raise ValueError(f'{field} must be 0 or more')
    return m


def _day(v, field):
    return date.fromisoformat(str(v or '').strip()).isoformat() if v else _required(field)


def _required(field):
    raise ValueError(f'{field} is required (YYYY-MM-DD)')


def _month(v):
    m = str(v or '').strip() or today()[:7]
    if not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', m):
        raise ValueError('month must look like 2026-10')
    return m


def _int(v, field):
    try:
        return int(v)
    except (TypeError, ValueError):
        raise ValueError(f'{field} must be a number')


def _exists(db, table, i, what):
    if not db.run(f'SELECT id FROM {table} WHERE id = :i', i=i):
        raise NotFound(f'no such {what}')
    return i


def _person(db, v):
    return None if v in (None, '') else _exists(db, 'people', _int(v, 'person_id'), 'person')


def _insert(db, table, row, i=None):
    """Update row `i` or insert a new one; returns its id."""
    if i:
        _exists(db, table, i, table.rstrip('s'))
        db.run(f'UPDATE {table} SET ' + ', '.join(f'{k} = :{k}' for k in row) + ' WHERE id = :id', id=i, **row)
        return i
    return db.run(f'INSERT INTO {table} ({", ".join(row)}) VALUES ({", ".join(":" + k for k in row)}) RETURNING id', **row)[0]['id']


# ---------- context ----------

def rate_now():
    import server
    r = server.inr_per_sar() or {}
    return {'SAR_INR': r.get('rate') or 24.9, 'at': r.get('at')}


def context(db, cur):
    """Everything the engine needs, read once: transactions (with purposes), commitments, funds, loans, settings."""
    import server
    ensure(db)
    rows = server.transactions(db)
    rate = rate_now()
    held = server.money(db, cur, every=rows, rate=rate['SAR_INR'])['holdings']
    loans = [h for h in held if h['kind'] in server.DEBTS]
    savings = sum(engine.conv(h['balance_minor'], h['currency'], cur, rate['SAR_INR']) for h in held
                  if h['kind'] == 'saving' and h['currency'] in CURRENCIES)
    txns = [eng(t) for t in rows]
    return {'rows': rows, 'txns': txns, 'rate': rate, 'r': rate['SAR_INR'], 'loans': loans, 'savings': savings,
            'commitments': _commitments(db), 'funds': _funds(db, txns), 'settings': settings_get(db, {}), 'cur': cur, 'today': today()}


def _commitments(db):
    sharers = defaultdict(list)
    for s in db.run('SELECT * FROM commitment_sharers'):
        sharers[s['commitment_id']].append({'person_id': s['person_id'], 'share_minor': s['share_minor']})
    return [{**c, 'sharers': sharers[c['id']]} for c in db.run('SELECT * FROM commitments ORDER BY next_due, id')]


def _funds(db, txns):
    """Funds; a commitment's fund follows it: its due date is the commitment's next one, emptied when that is paid."""
    commits = {c['id']: c for c in _commitments(db)}
    out, now = [], today()
    for f in db.run('SELECT * FROM funds ORDER BY due, id'):
        c = commits.get(f['commitment_id'])
        if c:
            nd = engine.commitment_status(c, txns, now)['next_due']
            target = engine.your_share(c)
            if nd != f['due'] or target != f['target_minor']:
                saved = 0 if nd > f['due'] else f['saved_minor']
                db.run('UPDATE funds SET due = :d, saved_minor = :s, target_minor = :t WHERE id = :id', d=nd, s=saved, t=target, id=f['id'])
                f = {**f, 'due': nd, 'saved_minor': saved, 'target_minor': target}
        out.append({**f, 'cycle_months': c['cycle_months'] if c else 0})
    return out


def _sync_fund(db, cid):
    """A commitment with a cycle over a month gets a fund: its amount (your share) by its next due date."""
    c = next((c for c in _commitments(db) if c['id'] == cid), None)
    have = db.run('SELECT id FROM funds WHERE commitment_id = :c', c=cid)
    if not c or c['cycle_months'] <= 1:
        db.run('DELETE FROM funds WHERE commitment_id = :c', c=cid)
    elif have:
        db.run('UPDATE funds SET name = :n, target_minor = :t, currency = :cur, due = :d WHERE commitment_id = :c',
               n=c['name'], t=engine.your_share(c), cur=c['currency'], d=c['next_due'], c=cid)
    else:
        _insert(db, 'funds', {'name': c['name'], 'target_minor': engine.your_share(c), 'currency': c['currency'], 'due': c['next_due'],
                              'saved_minor': 0, 'commitment_id': cid})


def _balances(txns, people):
    """What each person owes you and you owe them, per currency: friend tags (unsettled) and purposes with a person."""
    by_name = {p['name'].strip().lower(): p['id'] for p in people}
    owes, owed = defaultdict(lambda: defaultdict(int)), defaultdict(lambda: defaultdict(int))
    for t in txns:
        if t['friend']:
            if t['settled']:
                continue
            pid = by_name.get(t['friend'].strip().lower(), t['friend'].strip())
            owes[pid][t['currency']] += min(t['theirs_minor'], t['amount_minor']) if t['direction'] == 'debit' else -t['amount_minor']
        elif t['person_id'] is not None:
            sign = {'lend': 1, 'repaid': -1}.get(t['purpose'])
            if sign:
                owes[t['person_id']][t['currency']] += sign * t['amount_minor']
            sign = {'borrow': 1, 'repay': -1}.get(t['purpose'])
            if sign:
                owed[t['person_id']][t['currency']] += sign * t['amount_minor']
    return owes, owed


def _total(d, cur, r):
    return sum(engine.conv(v, c, cur, r) for per in d.values() for c, v in per.items() if v > 0)


# ---------- GET handlers (db, query dict) → JSON ----------

def people_list(db, q):
    ensure(db)
    import server
    rows = server.transactions(db)
    txns, people = [eng(t) for t in rows], db.run('SELECT * FROM people ORDER BY name')
    owes, owed = _balances(txns, people)
    m = today()[:7]
    contacts = {c['name'].strip().lower(): c['email'] for c in db.run('SELECT name, email FROM contacts')}
    out = []
    for p in people:
        support = sum(t['amount_minor'] for t in txns if t['person_id'] == p['id'] and t['purpose'] == 'support'
                      and t['day'].startswith(m) and t['currency'] == p['support_currency'])
        out.append({'id': p['id'], 'name': p['name'], 'relation': p['relation'], 'email': p['email'] or contacts.get(p['name'].lower(), ''),
                    'on_app': bool(p['email'] and server.on_app(db, p['email'])),
                    'owes_you': [money(v, c) for c, v in sorted(owes[p['id']].items()) if v],
                    'you_owe': [money(v, c) for c, v in sorted(owed[p['id']].items()) if v],
                    'support_plan': money(p['support_minor'], p['support_currency']) if p['support_minor'] else None,
                    'support_this_month': money(support, p['support_currency'])})
    for name, per in owes.items():  # friends tagged on transactions but not added as people yet
        if isinstance(name, str) and any(per.values()):
            out.append({'id': None, 'name': name, 'relation': 'friend', 'email': contacts.get(name.lower(), ''), 'on_app': False,
                        'owes_you': [money(v, c) for c, v in sorted(per.items()) if v], 'you_owe': [], 'support_plan': None,
                        'support_this_month': money(0, 'INR')})
    return out


def commitments_list(db, q, ctx=None):
    ctx = ctx or context(db, 'SAR')
    now, out = ctx['today'], []
    credits = [t for t in ctx['txns'] if t['direction'] == 'credit']
    names = {p['id']: p['name'].strip().lower() for p in db.run('SELECT id, name FROM people')}
    for c in ctx['commitments']:
        st = engine.commitment_status(c, ctx['txns'], now)
        start = engine.add_months(st['next_due'], -max(1, c['cycle_months']))
        sharers = [{'person_id': s['person_id'], 'share_minor': s['share_minor'],
                    'paid_this_cycle': any(t['day'] >= start and t['currency'] == c['currency'] and t['amount_minor'] >= s['share_minor'] * 0.9
                                           and (t['person_id'] == s['person_id'] or t['friend'].strip().lower() == names.get(s['person_id']))
                                           for t in credits)}
                   for s in c['sharers']]
        out.append({'id': c['id'], 'name': c['name'], 'kind': c['kind'], 'amount': money(c['amount_minor'], c['currency']),
                    'cycle_months': c['cycle_months'], 'next_due': st['next_due'], 'country': c['country'], 'match': c['match'],
                    'sharers': sharers, 'status_this_cycle': st['status'], 'last_paid_txn': st['last_paid_txn']})
    return out


def detect(db, q):
    ctx = context(db, 'SAR')
    known = [c['match'].lower() or c['name'].lower() for c in ctx['commitments']]
    return engine.detect_commitments(ctx['txns'], ctx['today'], known)


def funds_list(db, q, ctx=None):
    ctx = ctx or context(db, 'SAR')
    now, out = ctx['today'], []
    for f in ctx['funds']:
        monthly = engine.fund_projection(f, now[:7], 1)[0]
        left = engine.months_between(now, f['due'])
        if f['cycle_months'] > 1:  # where a commitment's fund should be by now
            on_track = f['saved_minor'] >= f['target_minor'] * (f['cycle_months'] - max(0, left) - 1) / f['cycle_months']
        else:
            on_track = f['saved_minor'] >= f['target_minor'] or f['due'] >= now
        out.append({'id': f['id'], 'name': f['name'], 'target': money(f['target_minor'], f['currency']), 'due': f['due'],
                    'saved': money(f['saved_minor'], f['currency']), 'monthly': money(monthly, f['currency']),
                    'commitment_id': f['commitment_id'], 'on_track': bool(on_track)})
    return out


def assets_list(db, q):
    import server
    ensure(db)
    rows = server.transactions(db)
    by_id = {t['id']: t for t in rows}
    holdings = {h['id']: h for h in db.run('SELECT * FROM holdings')}
    tagged = defaultdict(list)
    for r in db.run('SELECT * FROM asset_costs'):
        if r['txn_id'] in by_id:
            tagged[r['asset_id']].append((r['cost_type'], by_id[r['txn_id']]))
    stones, sharers = defaultdict(list), defaultdict(list)
    for m in db.run('SELECT * FROM asset_milestones ORDER BY due, id'):
        stones[m['asset_id']].append(m)
    for s in db.run('SELECT * FROM asset_sharers'):
        sharers[s['asset_id']].append({'person_id': s['person_id'], 'cost_type': s['cost_type'], 'share_pct': s['share_pct']})
    now = today()
    last3 = {engine.add_months(now[:7], -k) for k in (1, 2, 3)}
    out = []
    for a in db.run('SELECT * FROM assets ORDER BY id'):
        cur, r = a['currency'], rate_now()['SAR_INR']
        conv = lambda t: engine.conv(round(t['amount'] * 100), t['currency'], cur, r)
        loan = holdings.get(a['loan_liability'])
        financed = round(engine.conv(loan['balance_minor'], loan['currency'], cur, r)) if loan else 0
        paid_cash = a['paid_cash_minor'] + sum(conv(t) for t in rows if t.get('asset_id') == a['id'] and t['direction'] == 'debit')
        by_type = defaultdict(float)
        for kind, t in tagged[a['id']]:
            if t['received_at'][:7] in last3 and t['direction'] == 'debit':
                by_type[kind] += conv(t) / 3
        emi = engine.conv(loan['emi_minor'], loan['currency'], cur, r) if loan else 0
        yours = sum(v * (1 - sum(s['share_pct'] for s in sharers[a['id']] if s['cost_type'] == k) / 100) for k, v in by_type.items())
        nxt = next((m for m in stones[a['id']] if m['due'] >= now), None)
        out.append({'id': a['id'], 'kind': a['kind'], 'name': a['name'], 'currency': cur, 'value': money(a['value_minor'] or a['cost_minor'], cur),
                    'cost': money(a['cost_minor'], cur), 'paid_cash': money(paid_cash, cur), 'financed': money(financed, cur),
                    'remaining': money(max(0, a['cost_minor'] - paid_cash - financed), cur),
                    'next_milestone': {'name': nxt['name'], 'due': nxt['due'], 'amount': money(nxt['amount_minor'], cur)} if nxt else None,
                    'milestones': [{'name': m['name'], 'due': m['due'], 'amount': money(m['amount_minor'], cur)} for m in stones[a['id']]],
                    'monthly_cost': money(sum(by_type.values()) + emi, cur), 'your_monthly_cost': money(yours + emi, cur),
                    'costs_by_type': {k: money(v, cur) for k, v in sorted(by_type.items())}, 'sharers': sharers[a['id']],
                    'loan_liability': a['loan_liability'], 'match': a['match']})
    return out


def claims_view(db, q):
    import server
    ensure(db)
    rows = server.transactions(db)
    items = defaultdict(list)
    for r in db.run('SELECT * FROM claim_items'):
        items[r['claim_id']].append(r['txn_id'])
    by_id = {t['id']: t for t in rows}
    now, out, pending = date.fromisoformat(today()), [], defaultdict(int)
    for c in db.run('SELECT * FROM claims ORDER BY id DESC'):
        its = [by_id[i] for i in items[c['id']] if i in by_id]
        expected = defaultdict(int)
        for t in its:
            expected[t['currency']] += round(t['amount'] * 100)
        cur = next(iter(expected), 'SAR')
        received = sum(round(t['amount'] * 100) for t in rows if t['purpose'] == 'reimbursement' and t.get('claim_id') == c['id'])
        status = c['status'] if not received else 'paid' if received >= expected[cur] else 'partly'
        if status != 'paid':
            pending[cur] += max(0, expected[cur] - received)
        out.append({'id': c['id'], 'name': c['name'], 'status': status,
                    'items': [{'txn_id': t['id'], 'amount': money(round(t['amount'] * 100), t['currency']), 'merchant': t['merchant'],
                               'day': t['received_at'][:10]} for t in its],
                    'expected': money(expected[cur], cur), 'received': money(received, cur),
                    'age_days': (now - date.fromisoformat(c['created_at'][:10])).days})
    return {'claims': out, 'pending_total': [money(v, c) for c, v in sorted(pending.items()) if v]}


def review(db, q):
    import server
    ensure(db)
    out = []
    for t in server.transactions(db):
        if (t['confidence'] < 0.6 or t['category'] == 'Uncategorized') and t['category'] not in server.NOT_COUNTED:
            ways = ['spend', 'lend', 'claim', 'transfer'] if t['direction'] == 'debit' else ['income', 'repaid', 'reimbursement', 'transfer']
            out.append({**t, 'suggestions': [{'purpose': w, 'category': t['category'] if w == 'spend' else None, 'person_id': None} for w in ways]})
            if len(out) >= 100:
                break
    return out


def month(db, q):
    cur, m = _cur(q.get('currency'), 'SAR'), _month(q.get('month'))
    ctx = context(db, cur)
    people = db.run('SELECT id, name FROM people')
    owes, owed = _balances(ctx['txns'], people)
    pending = sum(engine.conv(p['minor'], p['currency'], cur, ctx['r']) for p in claims_view(db, {})['pending_total'])
    v = engine.month_view(ctx['txns'], ctx['commitments'], ctx['funds'], ctx['loans'], ctx['settings'], m, ctx['today'], cur, ctx['r'],
                          _total(owes, cur, ctx['r']), _total(owed, cur, ctx['r']), pending)
    return {**v, 'rate': ctx['rate']}


def _lookahead(ctx, n=12):
    return engine.lookahead(ctx['txns'], ctx['commitments'], ctx['funds'], ctx['loans'], ctx['settings'], ctx['today'], ctx['cur'], ctx['r'], n)


def lookahead(db, q):
    n = _int(q.get('months') or 12, 'months')
    if not 1 <= n <= 36:
        raise ValueError('months must be 1-36')
    return _lookahead(context(db, _cur(q.get('currency'), 'SAR')), n)


def whatif(db, q):
    cur = _cur(q.get('currency'), 'SAR')
    amount = _minor(q.get('amount'), 'amount')
    pay = _one(q.get('pay') or 'cash', {'cash', 'card'}, 'pay')
    ctx = context(db, cur)
    la = _lookahead(ctx, 12)
    loans = engine.to_cur(ctx['loans'], cur, ctx['r'])
    return engine.what_if(loans, la['extra_to_debt']['minor'], la['months'][0]['free']['minor'], amount, cur, pay, ctx['today'])


def advice(db, q):
    cur = _cur(q.get('currency'), 'SAR')
    ctx = context(db, cur)
    la = _lookahead(ctx, 12)
    first = la['months'][0]
    essentials = first['everyday']['minor'] + first['commitments']['minor'] + first['funds']['minor']
    free = first['free']['minor']
    return engine.advice(engine.to_cur(ctx['loans'], cur, ctx['r']), ctx['savings'], essentials, free + first['funds']['minor'],
                         first['funds']['minor'], ctx['settings'], cur)


def settings_get(db, q):
    ensure(db)
    got = {r['key']: json.loads(r['value']) for r in db.run("SELECT key, value FROM settings WHERE key IN ('v2', 'salary')")}
    old = got.get('salary') if isinstance(got.get('salary'), dict) else {}
    s = {'salary': old.get('amount') or None, 'salary_currency': old.get('currency') or 'SAR', 'salary_day': None,
         'home_currency': 'INR', 'emergency_months': 6}
    return {**s, **got.get(V2_SETTINGS, {})}


# ---------- POST handlers (db, body) → saved object ----------

def save_person(db, b):
    ensure(db)
    row = {'name': _text(b.get('name'), 'name'), 'relation': _one(b.get('relation') or 'other', RELATIONS, 'relation'),
           'email': _text(b.get('email'), 'email', False, 200).lower(),
           'support_minor': _minor(b.get('support_amount'), 'support_amount', False),
           'support_currency': _cur(b.get('support_currency'), 'INR')}
    i = _insert(db, 'people', row, b.get('id') and _int(b['id'], 'id'))
    return next(p for p in people_list(db, {}) if p['id'] == i)


def save_commitment(db, b):
    ensure(db)
    cycle = _int(b.get('cycle_months') if b.get('cycle_months') is not None else 1, 'cycle_months')
    if not 0 <= cycle <= 120:
        raise ValueError('cycle_months must be 0 (one-off) to 120')
    row = {'name': _text(b.get('name'), 'name'), 'kind': _one(b.get('kind') or 'other', KINDS, 'kind'), 'amount_minor': _minor(b.get('amount'), 'amount'),
           'currency': _cur(b.get('currency'), 'SAR'), 'cycle_months': cycle, 'next_due': _day(b.get('next_due'), 'next_due'),
           'country': _text(b.get('country'), 'country', False, 2).upper(), 'match': _text(b.get('match'), 'match', False).lower()}
    sharers = [(_person(db, s.get('person_id')), _minor(s.get('share'), 'share')) for s in b.get('sharers') or []]
    if any(p is None for p, _ in sharers):
        raise ValueError('each sharer needs a person_id')
    i = _insert(db, 'commitments', row, b.get('id') and _int(b['id'], 'id'))
    if 'sharers' in b:
        db.run('DELETE FROM commitment_sharers WHERE commitment_id = :c', c=i)
        for p, share in sharers:
            db.run('INSERT INTO commitment_sharers (commitment_id, person_id, share_minor) VALUES (:c, :p, :s)', c=i, p=p, s=share)
    _sync_fund(db, i)
    return next(c for c in commitments_list(db, {}) if c['id'] == i)


def save_fund(db, b):
    ensure(db)
    row = {'name': _text(b.get('name'), 'name'), 'target_minor': _minor(b.get('target'), 'target'), 'currency': _cur(b.get('currency'), 'SAR'),
           'due': _day(b.get('due'), 'due'), 'saved_minor': _minor(b.get('saved'), 'saved', False)}
    i = _insert(db, 'funds', row, b.get('id') and _int(b['id'], 'id'))
    return next(f for f in funds_list(db, {}) if f['id'] == i)


def contribute(db, b):
    ensure(db)
    i = _exists(db, 'funds', _int(b.get('id'), 'id'), 'fund')
    db.run('UPDATE funds SET saved_minor = saved_minor + :a WHERE id = :i', a=_minor(b.get('amount'), 'amount'), i=i)
    return next(f for f in funds_list(db, {}) if f['id'] == i)


def save_asset(db, b):
    ensure(db)
    cur = _cur(b.get('currency'), 'SAR')
    loan = b.get('loan_liability')
    if loan not in (None, ''):
        loan = _exists(db, 'holdings', _int(loan, 'loan_liability'), 'loan')
    row = {'kind': _one(b.get('kind'), ASSET_KINDS, 'kind'), 'name': _text(b.get('name'), 'name'), 'currency': cur,
           'cost_minor': _minor(b.get('cost'), 'cost', False), 'value_minor': _minor(b.get('value'), 'value', False),
           'paid_cash_minor': _minor(b.get('paid_cash'), 'paid_cash', False), 'loan_liability': loan or None,
           'match': _text(b.get('match'), 'match', False).lower()}
    stones = [(_text(m.get('name'), 'milestone name'), _day(m.get('due'), 'milestone due'), _minor(m.get('amount'), 'milestone amount'))
              for m in b.get('milestones') or []]
    sharers = [(_person(db, s.get('person_id')), _one(s.get('cost_type'), COST_TYPES, 'cost_type'), float(s.get('share_pct')))
               for s in b.get('sharers') or []]
    if any(p is None or not 0 <= pct <= 100 for p, _, pct in sharers):
        raise ValueError('each sharer needs a person_id and a share_pct of 0-100')
    i = _insert(db, 'assets', row, b.get('id') and _int(b['id'], 'id'))
    if 'milestones' in b:
        db.run('DELETE FROM asset_milestones WHERE asset_id = :a', a=i)
        for n, d, amt in stones:
            db.run('INSERT INTO asset_milestones (asset_id, name, due, amount_minor) VALUES (:a, :n, :d, :m)', a=i, n=n, d=d, m=amt)
    if 'sharers' in b:
        db.run('DELETE FROM asset_sharers WHERE asset_id = :a', a=i)
        for p, k, pct in sharers:
            db.run('INSERT INTO asset_sharers (asset_id, person_id, cost_type, share_pct) VALUES (:a, :p, :k, :s)', a=i, p=p, k=k, s=pct)
    return next(a for a in assets_list(db, {}) if a['id'] == i)


def _txn(db, v):
    i = _int(v, 'txn_id')
    if not db.run('SELECT id FROM transactions WHERE id = :i', i=i):
        raise NotFound('no such transaction')
    return i


def asset_cost(db, b):
    ensure(db)
    a = _exists(db, 'assets', _int(b.get('asset_id'), 'asset_id'), 'asset')
    t, k = _txn(db, b.get('txn_id')), _one(b.get('cost_type'), COST_TYPES, 'cost_type')
    db.run('INSERT INTO asset_costs (txn_id, asset_id, cost_type) VALUES (:t, :a, :k) ON CONFLICT (txn_id) DO UPDATE '
           'SET asset_id = excluded.asset_id, cost_type = excluded.cost_type', t=t, a=a, k=k)
    return next(x for x in assets_list(db, {}) if x['id'] == a)


def save_claim(db, b):
    ensure(db)
    ids = [_txn(db, t) for t in b.get('txn_ids') or []]
    if not ids and not b.get('id'):
        raise ValueError('txn_ids are required')
    i = b.get('id') and _int(b['id'], 'id')
    row = {'name': _text(b.get('name'), 'name'), 'status': _one(b.get('status') or 'submitted', CLAIM_STATUS, 'status')}
    if not i:
        row['created_at'] = today()
    i = _insert(db, 'claims', row, i)
    if 'txn_ids' in b:
        db.run('DELETE FROM claim_items WHERE claim_id = :c', c=i)
        for t in ids:
            db.run('INSERT INTO claim_items (txn_id, claim_id) VALUES (:t, :c) ON CONFLICT (txn_id) DO UPDATE SET claim_id = excluded.claim_id', t=t, c=i)
    return next(c for c in claims_view(db, {})['claims'] if c['id'] == i)


def claim_paid(db, b):
    ensure(db)
    i = _exists(db, 'claims', _int(b.get('id'), 'id'), 'claim')
    db.run('UPDATE claims SET paid_txn_id = :t WHERE id = :i', t=_txn(db, b.get('txn_id')), i=i)
    return next(c for c in claims_view(db, {})['claims'] if c['id'] == i)


def set_purpose(db, b):
    import server
    ensure(db)
    p = _one(b.get('purpose'), PURPOSES, 'purpose')
    t = _txn(db, b.get('txn_id'))
    person = _person(db, b.get('person_id'))
    db.run('INSERT INTO txn_purposes (txn_id, purpose, person_id) VALUES (:t, :p, :w) ON CONFLICT (txn_id) DO UPDATE '
           'SET purpose = excluded.purpose, person_id = excluded.person_id', t=t, p=p, w=person)
    row = next(x for x in server.transactions(db) if x['id'] == t)
    if b.get('all_from_merchant') and row['merchant'].strip():
        db.run('INSERT INTO merchant_purposes (merchant, purpose, person_id) VALUES (:m, :p, :w) ON CONFLICT (merchant) DO UPDATE '
               'SET purpose = excluded.purpose, person_id = excluded.person_id', m=row['merchant'].strip().lower(), p=p, w=person)
    return row


def save_settings(db, b):
    ensure(db)
    s = settings_get(db, {})
    if 'salary' in b:
        s['salary'] = float(Decimal(_minor(b['salary'], 'salary', False)) / 100) or None
    if 'salary_currency' in b:
        s['salary_currency'] = _cur(b['salary_currency'])
    if 'home_currency' in b:
        s['home_currency'] = _cur(b['home_currency'])
    if b.get('salary_day') not in (None, ''):
        s['salary_day'] = _int(b['salary_day'], 'salary_day')
        if not 1 <= s['salary_day'] <= 31:
            raise ValueError('salary_day must be 1-31')
    if 'emergency_months' in b:
        s['emergency_months'] = float(b['emergency_months'])
        if not 0 <= s['emergency_months'] <= 24:
            raise ValueError('emergency_months must be 0-24')
    put = 'INSERT INTO settings (key, value) VALUES (:k, :v) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    db.run(put, k=V2_SETTINGS, v=json.dumps(s))
    # The old Plan tab and salary detection in server.transactions() read 'salary' {amount, currency}.
    old = db.run("SELECT value FROM settings WHERE key = 'salary'")
    old = json.loads(old[0]['value']) if old else {}
    db.run(put, k='salary', v=json.dumps({**(old if isinstance(old, dict) else {}), 'amount': s['salary'] or 0, 'currency': s['salary_currency']}))
    return s


def _deleter(table, *children):
    def delete(db, b):
        ensure(db)
        i = _exists(db, table, _int(b.get('id'), 'id'), table.rstrip('s'))
        db.run(f'DELETE FROM {table} WHERE id = :i', i=i)
        for child, col in children:
            db.run(f'DELETE FROM {child} WHERE {col} = :i', i=i)
        return {'id': i, 'deleted': True}
    return delete


GETS = {'/people': people_list, '/commitments': commitments_list, '/commitments/detect': detect, '/funds': funds_list,
        '/assets': assets_list, '/claims': claims_view, '/review': review, '/month': month, '/lookahead': lookahead,
        '/whatif': whatif, '/advice': advice, '/settings': settings_get}
POSTS = {'/people': save_person, '/people/delete': _deleter('people', ('commitment_sharers', 'person_id'), ('asset_sharers', 'person_id')),
         '/commitments': save_commitment,
         '/commitments/delete': _deleter('commitments', ('commitment_sharers', 'commitment_id'), ('funds', 'commitment_id')),
         '/funds': save_fund, '/funds/contribute': contribute, '/funds/delete': _deleter('funds'),
         '/assets': save_asset, '/assets/cost': asset_cost,
         '/assets/delete': _deleter('assets', ('asset_milestones', 'asset_id'), ('asset_sharers', 'asset_id'), ('asset_costs', 'asset_id')),
         '/claims': save_claim, '/claims/paid': claim_paid, '/claims/delete': _deleter('claims', ('claim_items', 'claim_id')),
         '/purpose': set_purpose, '/settings': save_settings}


def handle(db, environ, method, path, query, respond):
    import server
    sub = path[len('/api/v2'):].rstrip('/') or '/'
    fn = (GETS if method == 'GET' else POSTS if method == 'POST' else {}).get(sub)
    if not fn:
        return respond('404 Not Found', {'error': 'not found'})
    try:
        if method == 'POST':
            body = server.read_json(environ, server.MAX_BODY)
            if not isinstance(body, dict):
                raise ValueError('expected a JSON object')
            return respond('200 OK', fn(db, body))
        return respond('200 OK', fn(db, query))
    except NotFound as e:
        return respond('404 Not Found', {'error': e.args[0]})
    except (ValueError, KeyError, TypeError, ArithmeticError, AttributeError) as e:
        return respond('400 Bad Request', {'error': f'bad request: {e}'})
