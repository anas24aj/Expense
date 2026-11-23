"""Plan for v3: liabilities, commitments (bills, rent, subscriptions, EMIs) with sharers, sinking funds, assets
(property, vehicles, investments), company claims and settings. Numbers come from api/insights.load() + engine.py."""
import base64
import binascii
import json
import re
from collections import defaultdict
from datetime import date

import engine
from api import insights
from api.app import ApiError, route
from api.db import now

M = engine.money
LIAB_KINDS = ('loan', 'credit_card', 'bnpl', 'person', 'other')
COMMIT_KINDS = ('rent', 'bill', 'subscription', 'emi', 'insurance', 'school', 'support', 'milestone', 'other')
ASSET_KINDS = ('property', 'vehicle', 'investment', 'gold', 'other')
CLAIM_STATUS = ('draft', 'submitted', 'paid', 'partly', 'rejected')
REFS = {'account_id': 'accounts', 'contact_id': 'contacts', 'member_id': 'members', 'for_member_id': 'members',
        'liability_id': 'liabilities', 'asset_id': 'assets', 'paid_txn_id': 'transactions'}
SPECS = {
    'liabilities': ({'kind': LIAB_KINDS, 'name': 'text', 'lender': 'text', 'currency': 'cur', 'principal_minor': 'int',
                     'opening_balance_minor': 'int', 'as_of': 'day', 'rate_bp': 'int', 'emi_minor': 'int', 'due_day': 'int',
                     'start_on': 'day', 'end_on': 'day', 'match_pattern': 'text', 'account_id': 'ref', 'contact_id': 'ref', 'member_id': 'ref'},
                    ('kind', 'name', 'currency')),
    'commitments': ({'name': 'text', 'kind': COMMIT_KINDS, 'amount_minor': 'int', 'currency': 'cur', 'cycle_months': (0, 1, 3, 6, 12),
                     'next_due': 'day', 'end_on': 'day', 'country': 'text', 'match_pattern': 'text', 'account_id': 'ref',
                     'liability_id': 'ref', 'asset_id': 'ref', 'for_member_id': 'ref'},
                    ('name', 'kind', 'amount_minor', 'currency', 'next_due')),
    'funds': ({'name': 'text', 'target_minor': 'int', 'currency': 'cur', 'due_on': 'day'}, ('name', 'target_minor', 'currency', 'due_on')),
    'assets': ({'kind': ASSET_KINDS, 'name': 'text', 'currency': 'cur', 'cost_minor': 'int', 'value_minor': 'int', 'value_as_of': 'day',
                'liability_id': 'ref', 'match_pattern': 'text', 'details': 'json'}, ('kind', 'name', 'currency')),
    'asset_milestones': ({'name': 'text', 'due_on': 'day', 'amount_minor': 'int', 'paid_txn_id': 'ref', 'paid_on': 'day'},
                         ('name', 'due_on', 'amount_minor')),
    'trips': ({'name': 'text', 'city': 'text', 'country': 'text', 'start_on': 'day', 'end_on': 'day', 'kind': ('business', 'personal')},
              ('name', 'start_on', 'end_on')),
    'claims': ({'name': 'text', 'payer': 'text', 'status': CLAIM_STATUS, 'submitted_on': 'day', 'member_id': 'ref'}, ('name',)),
}


# ---------- validation ----------

def clean(hh, table, b, create):
    """The body's known fields, checked; on create the required ones must be there."""
    spec, required = SPECS[table]
    out = {}
    for k, kind in spec.items():
        if k not in b:
            if create and k in required:
                raise ApiError(400, f'{k} is required')
            continue
        v = b[k]
        if v is None or v == '':
            if k in required or kind in ('int', 'cur', 'json') or isinstance(kind, tuple):
                raise ApiError(400, f'{k} is required')
            out[k] = None if kind == 'ref' else ''
            continue
        if isinstance(kind, tuple):
            if v not in kind:
                raise ApiError(400, f'{k} must be one of {", ".join(map(str, kind))}')
        elif kind == 'text':
            if not isinstance(v, str) or len(v) > 200:
                raise ApiError(400, f'{k} must be text up to 200 characters')
            v = v.strip()
        elif kind == 'int':
            if not isinstance(v, int) or isinstance(v, bool) or abs(v) > 10 ** 15:
                raise ApiError(400, f'{k} must be a whole number')
        elif kind == 'cur':
            if not isinstance(v, str) or len(v) != 3 or not v.isalpha():
                raise ApiError(400, f'{k} must be a 3-letter currency code')
            v = v.upper()
        elif kind == 'day':
            try:
                date.fromisoformat(v)
            except (TypeError, ValueError):
                raise ApiError(400, f'{k} must be a date YYYY-MM-DD')
        elif kind == 'ref':
            if not isinstance(v, str) or not hh.get(REFS[k], v):
                raise ApiError(400, f'{k}: no such {REFS[k][:-1]} in this household')
        elif kind == 'json':
            if not isinstance(v, dict):
                raise ApiError(400, f'{k} must be an object')
            v = json.dumps(v)
        out[k] = v
    return out


def _get(hh, table, id, what):
    row = hh.get(table, id)
    if not row:
        raise ApiError(404, f'no such {what}')
    return row


def _txn(hh, id):
    if not isinstance(id, str) or not hh.one('SELECT id FROM transactions WHERE id = :id AND household_id = :hid AND deleted_at IS NULL', id=id):
        raise ApiError(400, f'no such transaction: {id}')
    return id


def set_meta(hh, txn_id, **cols):
    """Upsert a transaction's meaning (txn_meta has no id column, so not Scoped.insert/update)."""
    cols['updated_at'] = now()
    if hh.one('SELECT txn_id FROM txn_meta WHERE txn_id = :t AND household_id = :hid', t=txn_id):
        sets = ', '.join(f'{k} = :{k}' for k in cols)
        hh.run(f'UPDATE txn_meta SET {sets} WHERE txn_id = :t AND household_id = :hid', t=txn_id, **cols)
    else:
        cols = {'purpose': 'spend', 'confidence': 1.0, 'set_by': 'rule', **cols}
        names = ', '.join(cols)
        hh.run(f'INSERT INTO txn_meta (txn_id, household_id, {names}) VALUES (:t, :hid, {", ".join(":" + k for k in cols)})', t=txn_id, **cols)


def reclassify(hh, txn_ids=None):
    """Let the classifier re-tag transactions after a rule-bearing change (commitment/liability/asset patterns)."""
    from api import classify
    classify.reclassify(hh, txn_ids)


def deleted(id):
    return {'id': id, 'deleted': True}


def _people(hh):
    names = {m['id']: m['display_name'] for m in hh.run('SELECT id, display_name FROM members WHERE household_id = :hid')}
    names.update({c['id']: c['name'] for c in hh.run('SELECT id, name FROM contacts WHERE household_id = :hid')})
    return names


def txn_views(ctx, rows):
    """API Txn objects (the ledger's shape) for insights rows, which carry every column ledger.TXN_SELECT has."""
    from api import ledger
    return ledger.txn_views(ctx['hh'], rows)


# ---------- liabilities ----------

def liability_json(l, ctx):
    cur, out = l['currency'], l['outstanding_minor']
    payoff = None
    if out <= 0:
        payoff = (l['payments'][-1]['day'] if l['payments'] else ctx['today'])[:7]
    elif l['emi_minor'] and not l['closed_at']:
        import server
        months = server.plan([{'id': 1, 'balance_now': out, 'rate_bp': l['rate_bp'], 'emi_minor': l['emi_minor']}], 0)['months']
        payoff = engine.add_months(ctx['today'][:7], months) if months is not None else None
    principal = l['principal_minor'] or l['opening_balance_minor']
    return {'id': l['id'], 'kind': l['kind'], 'name': l['name'], 'lender': l['lender'], 'currency': cur, 'principal': M(principal, cur),
            'opening_balance': M(l['opening_balance_minor'], cur), 'as_of': l['as_of'], 'outstanding': M(out, cur), 'rate_bp': l['rate_bp'],
            'emi': M(l['emi_minor'], cur), 'due_day': l['due_day'], 'start_on': l['start_on'], 'end_on': l['end_on'],
            'paid_pct': round(100 * (principal - out) / principal) if principal else None, 'payoff_month': payoff,
            'interest_month': M(out * l['rate_bp'] / 120000, cur), 'account_id': l['account_id'], 'contact_id': l['contact_id'],
            'member_id': l['member_id'], 'match_pattern': l['match_pattern'], 'closed': bool(l['closed_at']),
            'payments': [{'txn_id': p['txn_id'], 'day': p['day'], 'amount': M(p['amount'], cur), 'interest': M(p['interest'], cur),
                          'principal': M(p['amount'] - p['interest'], cur)} for p in l['payments']]}


def _one_liability(req, id):
    ctx = insights.load(req)
    l = next((l for l in ctx['liabs'] if l['id'] == id), None)
    if not l:
        raise ApiError(404, 'no such liability')
    return liability_json(l, ctx)


@route('GET', '/api/liabilities')
def liabilities(req):
    ctx = insights.load(req)
    items = [liability_json(l, ctx) for l in ctx['liabs']]
    open_ = [l for l in ctx['liabs'] if not l['closed_at']]
    cur = ctx['cur']
    return {'items': items, 'emi_total': M(sum(insights.to_cur(l['emi_minor'], l['currency'], ctx) for l in open_ if l['outstanding_minor'] > 0), cur),
            'outstanding_total': M(sum(insights.to_cur(l['outstanding_minor'], l['currency'], ctx) for l in open_), cur)}


@route('GET', '/api/liabilities/{id}')
def liability(req):
    return _one_liability(req, req.params['id'])


@route('POST', '/api/liabilities')
def liability_add(req):
    cols = clean(req.hh, 'liabilities', req.json, True)
    cols.setdefault('opening_balance_minor', cols.get('principal_minor', 0))
    cols.setdefault('as_of', insights.today_in(None))
    row = req.hh.insert('liabilities', created_at=now(), **cols)
    reclassify(req.hh)
    return 201, _one_liability(req, row['id'])


@route('PATCH', '/api/liabilities/{id}')
def liability_edit(req):
    _get(req.hh, 'liabilities', req.params['id'], 'liability')
    cols = clean(req.hh, 'liabilities', req.json, False)
    if 'closed' in req.json:
        cols['closed_at'] = now() if req.json['closed'] else None
    req.hh.update('liabilities', req.params['id'], **cols)
    reclassify(req.hh)
    return _one_liability(req, req.params['id'])


@route('DELETE', '/api/liabilities/{id}')
def liability_delete(req):
    _get(req.hh, 'liabilities', req.params['id'], 'liability')
    req.hh.run('UPDATE txn_meta SET liability_id = NULL WHERE liability_id = :id AND household_id = :hid', id=req.params['id'])
    req.hh.run('DELETE FROM liabilities WHERE id = :id AND household_id = :hid', id=req.params['id'])
    return deleted(req.params['id'])


# ---------- commitments ----------

def commitment_json(c, ctx, names=None):
    st, cur, cycle = ctx['status'][c['id']], c['currency'], c['cycle_months']
    start = engine.add_months(st['next_due'], -max(1, cycle)) if cycle else '0000'
    pays = ctx['payments'][c['id']]
    names = names if names is not None else ctx.setdefault('names', {})

    def paid(s):
        if any((p['payer_member_id'], p['payer_contact_id']) == (s['member_id'], s['contact_id']) and p['paid_on'] >= start for p in pays):
            return True
        who = s['member_id'] or s['contact_id']
        return any(t['person_id'] == who and t['direction'] == 'credit' and t['day'] >= start and t['currency'] == cur
                   and t['amount_minor'] >= s['share_minor'] * 0.9 for t in ctx['raw_txns'])

    mine = [(t['day'], t['id']) for t in ctx['raw_txns'] if t['commitment_id'] == c['id'] and t['direction'] == 'debit']
    sharer_keys = {(s['member_id'], s['contact_id']) for s in ctx['shares'][c['id']]}
    mine += [(p['paid_on'], p['txn_id']) for p in pays if (p['payer_member_id'], p['payer_contact_id']) not in sharer_keys]
    last = max(mine, default=None)
    fund = next((f['id'] for f in ctx['funds'] if f['commitment_id'] == c['id']), None)
    return {'id': c['id'], 'name': c['name'], 'kind': c['kind'], 'amount': M(c['amount_minor'], cur), 'my_share': M(engine.your_share(c), cur),
            'cycle_months': cycle, 'next_due': st['next_due'], 'end_on': c['end_on'], 'country': c['country'], 'match_pattern': c['match_pattern'],
            'account_id': c['account_id'], 'liability_id': c['liability_id'], 'asset_id': c['asset_id'], 'for_member_id': c['for_member_id'],
            'shares': [{'member_id': s['member_id'], 'contact_id': s['contact_id'], 'name': names.get(s['member_id'] or s['contact_id'], ''),
                        'share': M(s['share_minor'], cur), 'paid_this_cycle': paid(s)} for s in ctx['shares'][c['id']]],
            'status': st['status'], 'last_paid': {'day': last[0], 'txn_id': last[1]} if last else None, 'fund_id': fund}


def _commit_ctx(req):
    ctx = insights.load(req)
    ctx['names'] = _people(req.hh)
    return ctx


def _one_commitment(req, id):
    ctx = _commit_ctx(req)
    c = next((c for c in ctx['commits'] if c['id'] == id), None)
    if not c:
        raise ApiError(404, 'no such commitment')
    return commitment_json(c, ctx)


def _save_shares(req, cid):
    items = req.json.get('shares')
    if items is None:
        return
    if not isinstance(items, list):
        raise ApiError(400, 'shares must be a list')
    rows = []
    for s in items:
        if not isinstance(s, dict) or not isinstance(s.get('share_minor'), int) or s['share_minor'] < 0:
            raise ApiError(400, 'each share needs member_id or contact_id and share_minor')
        refs = clean(req.hh, 'liabilities', {k: s[k] for k in ('member_id', 'contact_id') if s.get(k)}, False)
        if len(refs) != 1:
            raise ApiError(400, 'each share needs exactly one of member_id or contact_id')
        rows.append({'member_id': refs.get('member_id'), 'contact_id': refs.get('contact_id'), 'share_minor': s['share_minor']})
    req.hh.run('DELETE FROM commitment_shares WHERE commitment_id = :c AND household_id = :hid', c=cid)
    for r in rows:
        req.hh.insert('commitment_shares', commitment_id=cid, **r)


def _sync_fund(hh, cid):
    """A commitment paid every 3, 6 or 12 months gets a sinking fund: your share, by its next due date."""
    c = hh.get('commitments', cid)
    f = hh.one('SELECT id FROM funds WHERE household_id = :hid AND commitment_id = :c AND closed_at IS NULL', c=cid)
    if c and c['cycle_months'] > 1 and not c['ended_at']:
        mine = c['amount_minor'] - sum(s['share_minor'] for s in hh.run('SELECT share_minor FROM commitment_shares WHERE household_id = :hid AND commitment_id = :c', c=cid))
        cols = {'name': c['name'], 'target_minor': max(0, mine), 'currency': c['currency'], 'due_on': c['next_due']}
        if f:
            hh.update('funds', f['id'], **cols)
        else:
            hh.insert('funds', commitment_id=cid, created_at=now(), **cols)
    elif f:
        hh.update('funds', f['id'], closed_at=now())


@route('GET', '/api/commitments')
def commitments(req):
    ctx = _commit_ctx(req)
    items = [commitment_json(c, ctx) for c in ctx['commits']]
    monthly = sum(insights.to_cur(engine.your_share(c), c['currency'], ctx) / c['cycle_months'] for c in ctx['commits'] if c['cycle_months'])
    return {'items': items, 'monthly_total': M(monthly, ctx['cur'])}


@route('GET', '/api/commitments/detect')
def commitments_detect(req):
    ctx = insights.load(req)
    known = [(c['match_pattern'] or c['name']).strip().lower() for c in ctx['commits']]
    out = []
    for d in engine.detect_commitments(ctx['txns'], ctx['today'], known):
        out.append({'name': d['name'], 'kind': d['kind'], 'amount': d['amount'], 'cycle_months': d['cycle_months'], 'next_due': d['next_due'],
                    'end_on': '', 'country': '', 'match_pattern': d['match'], 'account_id': None, 'liability_id': None, 'asset_id': None,
                    'for_member_id': None, 'shares': [], 'evidence_txn_ids': d['evidence_txn_ids']})
    return {'items': out}


@route('GET', '/api/commitments/{id}')
def commitment(req):
    return _one_commitment(req, req.params['id'])


@route('POST', '/api/commitments')
def commitment_add(req):
    cols = clean(req.hh, 'commitments', req.json, True)
    with req.db.tx():
        row = req.hh.insert('commitments', created_at=now(), **cols)
        _save_shares(req, row['id'])
        _sync_fund(req.hh, row['id'])
    reclassify(req.hh)
    return 201, _one_commitment(req, row['id'])


@route('PATCH', '/api/commitments/{id}')
def commitment_edit(req):
    cid = req.params['id']
    _get(req.hh, 'commitments', cid, 'commitment')
    cols = clean(req.hh, 'commitments', req.json, False)
    with req.db.tx():
        req.hh.update('commitments', cid, **cols)
        _save_shares(req, cid)
        _sync_fund(req.hh, cid)
    reclassify(req.hh)
    return _one_commitment(req, cid)


@route('DELETE', '/api/commitments/{id}')
def commitment_delete(req):
    cid = req.params['id']
    _get(req.hh, 'commitments', cid, 'commitment')
    req.hh.update('commitments', cid, ended_at=now())
    _sync_fund(req.hh, cid)
    return deleted(cid)


@route('POST', '/api/commitments/{id}/paid')
def commitment_paid(req):
    """Mark this cycle paid: by me (optionally with the payment's transaction) or by a sharer."""
    cid, b = req.params['id'], req.json
    c = _get(req.hh, 'commitments', cid, 'commitment')
    ctx = insights.load(req)
    if cid not in ctx['status']:
        raise ApiError(409, 'this commitment has ended')
    due = ctx['status'][cid]['next_due']
    payer, member_id, contact_id, share = b.get('payer') or {}, None, None, None
    if payer:
        if payer.get('kind') not in ('member', 'contact') or not isinstance(payer.get('id'), str):
            raise ApiError(400, 'payer must be {kind: member|contact, id}')
        key = payer['kind'] + '_id'
        share = next((s for s in ctx['shares'][cid] if s[key] == payer['id']), None)
        member_id, contact_id = (payer['id'], None) if key == 'member_id' else (None, payer['id'])
        if not share and contact_id:
            raise ApiError(400, 'that contact does not share this commitment')
        if not share:
            _get(req.hh, 'members', member_id, 'member')  # another member paid the whole of it
    amount = b.get('amount_minor')
    if amount is not None and (not isinstance(amount, int) or amount <= 0):
        raise ApiError(400, 'amount_minor must be a whole number above 0')
    txn_id = _txn(req.hh, b['txn_id']) if b.get('txn_id') else None
    if txn_id and not share:
        set_meta(req.hh, txn_id, commitment_id=cid)
    req.hh.insert('commitment_payments', commitment_id=cid, cycle_due=due, txn_id=txn_id, payer_member_id=member_id,
                  payer_contact_id=contact_id, amount_minor=amount or (share['share_minor'] if share else c['amount_minor']),
                  paid_on=insights.today_in(ctx['house'].get('timezone')))
    return _one_commitment(req, cid)


# ---------- funds ----------

def fund_json(f, ctx):
    cur, now_ = f['currency'], ctx['today']
    monthly = engine.fund_projection(f, now_[:7], 1)[0]
    left = engine.months_between(now_, f['due'])
    if f['cycle_months'] > 1:  # where a commitment's fund should be by now
        on_track = f['saved_minor'] >= f['target_minor'] * (f['cycle_months'] - max(0, left) - 1) / f['cycle_months']
    else:
        on_track = f['saved_minor'] >= f['target_minor'] or f['saved_minor'] >= f['target_minor'] - monthly * (max(0, left) + 1) - 1
    return {'id': f['id'], 'name': f['name'], 'target': M(f['target_minor'], cur), 'due_on': f['due'], 'saved': M(f['saved_minor'], cur),
            'monthly': M(monthly, cur), 'on_track': bool(on_track), 'commitment_id': f['commitment_id']}


def _one_fund(req, id):
    ctx = insights.load(req)
    f = next((f for f in ctx['funds'] if f['id'] == id), None)
    if not f:
        raise ApiError(404, 'no such fund')
    return fund_json(f, ctx)


@route('GET', '/api/funds')
def funds(req):
    ctx = insights.load(req)
    items = [fund_json(f, ctx) for f in ctx['funds']]
    return {'items': items, 'monthly_total': M(sum(insights.to_cur(f['monthly']['minor'], f['monthly']['currency'], ctx) for f in items), ctx['cur'])}


@route('GET', '/api/funds/{id}')
def fund(req):
    return _one_fund(req, req.params['id'])


@route('POST', '/api/funds')
def fund_add(req):
    row = req.hh.insert('funds', created_at=now(), **clean(req.hh, 'funds', req.json, True))
    return 201, _one_fund(req, row['id'])


@route('PATCH', '/api/funds/{id}')
def fund_edit(req):
    _get(req.hh, 'funds', req.params['id'], 'fund')
    req.hh.update('funds', req.params['id'], **clean(req.hh, 'funds', req.json, False))
    return _one_fund(req, req.params['id'])


@route('DELETE', '/api/funds/{id}')
def fund_delete(req):
    _get(req.hh, 'funds', req.params['id'], 'fund')
    req.hh.update('funds', req.params['id'], closed_at=now())
    return deleted(req.params['id'])


@route('POST', '/api/funds/{id}/move')
def fund_move(req):
    """Put money in (positive) or take it out (negative)."""
    _get(req.hh, 'funds', req.params['id'], 'fund')
    amount, b = req.json.get('amount_minor'), req.json
    if not isinstance(amount, int) or isinstance(amount, bool) or not amount:
        raise ApiError(400, 'amount_minor must be a whole number, not 0')
    txn_id = _txn(req.hh, b['txn_id']) if b.get('txn_id') else None
    day = clean(req.hh, 'funds', {'due_on': b['on_day']}, False)['due_on'] if b.get('on_day') else None
    ctx_day = insights.today_in((req.db.one('SELECT timezone FROM households WHERE id = :id', id=req.hh.hid) or {}).get('timezone'))
    req.hh.insert('fund_moves', fund_id=req.params['id'], on_day=day or ctx_day, amount_minor=amount, txn_id=txn_id)
    return _one_fund(req, req.params['id'])


# ---------- assets ----------

def asset_json(a, ctx, names):
    hh_cur, cur, r = ctx['cur'], a['currency'], ctx['r']
    conv = lambda minor, c: engine.conv(minor, c, cur, r)
    stones = [m for m in ctx['milestones'] if m['asset_id'] == a['id']]
    details = json.loads(a['details'] or '{}')
    counted = {t['id'] for t in ctx['raw_txns'] if t['asset_id'] == a['id'] and t['direction'] == 'debit'}
    counted |= {m['paid_txn_id'] for m in stones if m['paid_txn_id'] and m['paid_txn_id'] in ctx['by_id']}
    paid = (details.get('paid_cash_minor') or 0) + sum(conv(ctx['by_id'][i]['amount_minor'], ctx['by_id'][i]['currency']) for i in counted)
    paid += sum(m['amount_minor'] for m in stones if m['paid_on'] and not m['paid_txn_id'])
    loan = next((l for l in ctx['liabs'] if l['id'] == a['liability_id']), None)
    financed = conv(loan['principal_minor'] or loan['opening_balance_minor'], loan['currency']) if loan else 0
    emi = conv(loan['emi_minor'], loan['currency']) if loan and loan['outstanding_minor'] > 0 and not loan['closed_at'] else 0
    months = {engine.add_months(ctx['today'][:7], -k) for k in (1, 2, 3)}  # running costs: average of the last 3 full months
    by_type = defaultdict(float)
    for c in ctx['costs']:
        t = ctx['by_id'].get(c['txn_id'])
        if c['asset_id'] == a['id'] and t and t['day'][:7] in months and t['direction'] == 'debit':
            by_type[c['cost_type']] += conv(t['amount_minor'], t['currency']) / 3
    sharers = ctx['asset_sharers'][a['id']]
    pct = lambda k: min(100, sum(s['share_pct'] for s in sharers if s['cost_type'] in (k, '*')))
    mine = sum(v * (100 - pct(k)) / 100 for k, v in by_type.items())
    unpaid = [m for m in stones if not (m['paid_on'] or m['paid_txn_id'])]
    nxt = unpaid[0] if unpaid else None
    ms = lambda m: {'id': m['id'], 'name': m['name'], 'due_on': m['due_on'], 'amount': M(m['amount_minor'], cur),
                    'paid': bool(m['paid_on'] or m['paid_txn_id']), 'paid_on': m['paid_on'], 'paid_txn_id': m['paid_txn_id']}
    return {'id': a['id'], 'kind': a['kind'], 'name': a['name'], 'currency': cur, 'cost': M(a['cost_minor'], cur),
            'value': M(a['value_minor'] or a['cost_minor'], cur), 'value_as_of': a['value_as_of'], 'paid': M(paid, cur), 'financed': M(financed, cur),
            'remaining': M(max(0, a['cost_minor'] - paid - financed), cur), 'milestones': [ms(m) for m in stones],
            'next_milestone': ms(nxt) if nxt else None, 'monthly_cost': M(sum(by_type.values()) + emi, cur), 'my_monthly_cost': M(mine + emi, cur),
            'costs_by_type': {k: M(v, cur) for k, v in sorted(by_type.items())},
            'sharers': [{'id': s['id'], 'cost_type': s['cost_type'], 'member_id': s['member_id'], 'contact_id': s['contact_id'],
                         'name': names.get(s['member_id'] or s['contact_id'], ''), 'share_pct': s['share_pct']} for s in sharers],
            'liability_id': a['liability_id'], 'match_pattern': a['match_pattern'], 'details': details}


def _one_asset(req, id):
    ctx = insights.load(req)
    a = next((a for a in ctx['assets'] if a['id'] == id), None)
    if not a:
        raise ApiError(404, 'no such asset')
    return asset_json(a, ctx, _people(req.hh))


@route('GET', '/api/assets')
def assets(req):
    ctx, names = insights.load(req), _people(req.hh)
    return {'items': [asset_json(a, ctx, names) for a in ctx['assets']]}


@route('GET', '/api/assets/{id}')
def asset(req):
    return _one_asset(req, req.params['id'])


@route('POST', '/api/assets')
def asset_add(req):
    row = req.hh.insert('assets', created_at=now(), **clean(req.hh, 'assets', req.json, True))
    return 201, _one_asset(req, row['id'])


@route('PATCH', '/api/assets/{id}')
def asset_edit(req):
    _get(req.hh, 'assets', req.params['id'], 'asset')
    req.hh.update('assets', req.params['id'], **clean(req.hh, 'assets', req.json, False))
    return _one_asset(req, req.params['id'])


@route('DELETE', '/api/assets/{id}')
def asset_delete(req):
    _get(req.hh, 'assets', req.params['id'], 'asset')
    req.hh.update('assets', req.params['id'], sold_at=now())
    return deleted(req.params['id'])


@route('POST', '/api/assets/{id}/milestones')
def milestone_add(req):
    _get(req.hh, 'assets', req.params['id'], 'asset')
    req.hh.insert('asset_milestones', asset_id=req.params['id'], **clean(req.hh, 'asset_milestones', req.json, True))
    return 201, _one_asset(req, req.params['id'])


def _milestone(req):
    m = req.hh.get('asset_milestones', req.params['mid'])
    if not m or m['asset_id'] != req.params['id']:
        raise ApiError(404, 'no such milestone')
    return m


@route('PATCH', '/api/assets/{id}/milestones/{mid}')
def milestone_edit(req):
    _milestone(req)
    cols = clean(req.hh, 'asset_milestones', req.json, False)
    if cols.get('paid_txn_id') and not cols.get('paid_on'):
        cols['paid_on'] = req.hh.get('transactions', cols['paid_txn_id'])['day']
    req.hh.update('asset_milestones', req.params['mid'], **cols)
    return _one_asset(req, req.params['id'])


@route('DELETE', '/api/assets/{id}/milestones/{mid}')
def milestone_delete(req):
    _milestone(req)
    req.hh.run('DELETE FROM asset_milestones WHERE id = :id AND household_id = :hid', id=req.params['mid'])
    return deleted(req.params['mid'])


@route('POST', '/api/assets/{id}/costs')
def asset_cost(req):
    _get(req.hh, 'assets', req.params['id'], 'asset')
    txn_id, kind = _txn(req.hh, req.json.get('txn_id')), req.json.get('cost_type')
    if not isinstance(kind, str) or not kind.strip() or len(kind) > 40:
        raise ApiError(400, 'cost_type is required (fuel, service, insurance…)')
    req.hh.run('DELETE FROM asset_costs WHERE txn_id = :t AND household_id = :hid', t=txn_id)  # a cost belongs to one asset
    req.hh.insert('asset_costs', asset_id=req.params['id'], txn_id=txn_id, cost_type=kind.strip().lower())
    return _one_asset(req, req.params['id'])


@route('PUT', '/api/assets/{id}/sharers')
def asset_sharers(req):
    aid = req.params['id']
    _get(req.hh, 'assets', aid, 'asset')
    items = req.json.get('items')
    if not isinstance(items, list):
        raise ApiError(400, 'items must be a list')
    rows = []
    for s in items:
        if not isinstance(s, dict) or not isinstance(s.get('share_pct'), int) or not 0 < s['share_pct'] <= 100 or not isinstance(s.get('cost_type'), str):
            raise ApiError(400, 'each sharer needs cost_type, member_id or contact_id, and share_pct 1-100')
        refs = clean(req.hh, 'liabilities', {k: s[k] for k in ('member_id', 'contact_id') if s.get(k)}, False)
        if len(refs) != 1:
            raise ApiError(400, 'each sharer needs exactly one of member_id or contact_id')
        rows.append({'cost_type': s['cost_type'].strip().lower() or '*', 'member_id': refs.get('member_id'), 'contact_id': refs.get('contact_id'),
                     'share_pct': s['share_pct']})
    with req.db.tx():
        req.hh.run('DELETE FROM asset_sharers WHERE asset_id = :a AND household_id = :hid', a=aid)
        for r in rows:
            req.hh.insert('asset_sharers', asset_id=aid, **r)
    return _one_asset(req, aid)


# ---------- claims ----------

def claim_rows(ctx):
    """Claims with items, expected (items' total), received (reimbursements), status, age and a suggested reimbursement."""
    if 'claim_rows' in ctx:
        return ctx['claim_rows']
    ctx['claim_rows'] = out = []
    items = defaultdict(list)
    for tid, cid in ctx['claimed'].items():
        if tid in ctx['by_id']:
            items[cid].append(ctx['by_id'][tid])
    linked = {t['id'] for t in ctx['raw_txns'] if t['claim_id']}
    today = date.fromisoformat(ctx['today'])
    for c in ctx['claim_table']:
        its = sorted(items[c['id']], key=lambda t: t['day'])
        cur = its[0]['currency'] if its else ctx['cur']
        expected = sum(engine.conv(t['amount_minor'], t['currency'], cur, ctx['r']) for t in its)
        got = [t for t in ctx['raw_txns'] if t['claim_id'] == c['id'] and t['direction'] == 'credit']
        received = sum(engine.conv(t['amount_minor'], t['currency'], cur, ctx['r']) for t in got)
        status = c['status'] if not received else 'paid' if received >= expected - 1 else 'partly'
        suggestion = None
        if its and status not in ('paid', 'rejected'):
            first, last = its[0]['day'], (date.fromisoformat(its[-1]['day'][:10]).toordinal())
            hits = [t for t in ctx['raw_txns'] if t['direction'] == 'credit' and t['currency'] == cur and t['id'] not in linked
                    and t['purpose'] not in ('transfer',) and first <= t['day'] and date.fromisoformat(t['day']).toordinal() - last <= 90
                    and abs(t['amount_minor'] - (expected - received)) <= max(100, (expected - received) * 0.01)]
            if hits:
                h = hits[0]
                suggestion = {'txn_id': h['id'], 'day': h['day'], 'amount': M(h['amount_minor'], h['currency'])}
        since = c['submitted_on'] or c['created_at'][:10]
        out.append({'id': c['id'], 'name': c['name'], 'payer': c['payer'], 'status': status, 'member_id': c['member_id'],
                    'items': txn_views(ctx, its), 'expected': M(expected, cur), 'received': M(received, cur),
                    'age_days': (today - date.fromisoformat(since)).days, 'submitted_on': c['submitted_on'], 'suggestion': suggestion,
                    'reimbursement_txn_ids': [t['id'] for t in got]})
    return out


def _one_claim(req, id):
    c = next((c for c in claim_rows(insights.load(req)) if c['id'] == id), None)
    if not c:
        raise ApiError(404, 'no such claim')
    return c


def _add_items(req, cid, ids):
    if not isinstance(ids, list):
        raise ApiError(400, 'txn_ids must be a list')
    for tid in ids:
        _txn(req.hh, tid)
        if not req.hh.one('SELECT txn_id FROM claim_items WHERE txn_id = :t AND household_id = :hid', t=tid):
            req.db.run('INSERT INTO claim_items (claim_id, household_id, txn_id) VALUES (:c, :h, :t)', c=cid, h=req.hh.hid, t=tid)
        set_meta(req.hh, tid, purpose='claim', claim_id=cid, set_by='user', confidence=1.0)


@route('GET', '/api/claims')
def claims(req):
    rows = claim_rows(insights.load(req))
    pending = defaultdict(int)
    for c in rows:
        if c['status'] not in ('paid', 'rejected'):
            pending[c['expected']['currency']] += max(0, c['expected']['minor'] - c['received']['minor'])
    return {'items': rows, 'pending': [M(v, k) for k, v in sorted(pending.items()) if v]}


@route('GET', '/api/claims/{id}')
def claim(req):
    return _one_claim(req, req.params['id'])


@route('POST', '/api/claims')
def claim_add(req):
    b = dict(req.json)
    b.setdefault('status', 'submitted' if b.get('txn_ids') else 'draft')
    cols = clean(req.hh, 'claims', b, True)
    if cols['status'] == 'submitted' and not cols.get('submitted_on'):
        cols['submitted_on'] = insights.today_in(None)
    with req.db.tx():
        row = req.hh.insert('claims', created_at=now(), member_id=cols.pop('member_id', None) or (req.member or {}).get('id'), **cols)
        _add_items(req, row['id'], b.get('txn_ids') or [])
    return 201, _one_claim(req, row['id'])


@route('PATCH', '/api/claims/{id}')
def claim_edit(req):
    _get(req.hh, 'claims', req.params['id'], 'claim')
    req.hh.update('claims', req.params['id'], **clean(req.hh, 'claims', req.json, False))
    return _one_claim(req, req.params['id'])


@route('DELETE', '/api/claims/{id}')
def claim_delete(req):
    cid = req.params['id']
    _get(req.hh, 'claims', cid, 'claim')
    ids = [r['txn_id'] for r in req.hh.run('SELECT txn_id FROM txn_meta WHERE claim_id = :c AND household_id = :hid', c=cid)]
    with req.db.tx():
        req.hh.run("UPDATE txn_meta SET claim_id = NULL, purpose = 'spend', set_by = 'rule', confidence = 0 "
                   "WHERE claim_id = :c AND household_id = :hid AND purpose = 'claim'", c=cid)
        req.hh.run("UPDATE txn_meta SET claim_id = NULL, purpose = 'income', set_by = 'rule', confidence = 0 "
                   "WHERE claim_id = :c AND household_id = :hid", c=cid)
        req.hh.run('DELETE FROM claim_items WHERE claim_id = :c AND household_id = :hid', c=cid)
        req.hh.run('DELETE FROM claims WHERE id = :c AND household_id = :hid', c=cid)
    reclassify(req.hh, ids)
    return deleted(cid)


@route('POST', '/api/claims/{id}/items')
def claim_items(req):
    _get(req.hh, 'claims', req.params['id'], 'claim')
    with req.db.tx():
        _add_items(req, req.params['id'], req.json.get('txn_ids'))
    return _one_claim(req, req.params['id'])


@route('POST', '/api/claims/{id}/paid')
def claim_paid(req):
    """The reimbursement arrived: `txn_id`, else the suggested matching credit, else just mark it paid."""
    cid = req.params['id']
    _get(req.hh, 'claims', cid, 'claim')
    tid = req.json.get('txn_id') or ((_one_claim(req, cid)['suggestion'] or {}).get('txn_id'))
    if tid:
        _txn(req.hh, tid)
        set_meta(req.hh, tid, purpose='reimbursement', claim_id=cid, set_by='user', confidence=1.0)
    else:
        req.hh.update('claims', cid, status='paid')
    return _one_claim(req, cid)


# ---------- trips ----------

TRIP_STATUS = ('personal', 'missed', 'claimed', 'unreviewed')
COUNTRY_CUR = {'sa': 'SAR', 'saudi arabia': 'SAR', 'ksa': 'SAR', 'in': 'INR', 'india': 'INR', 'ae': 'AED', 'uae': 'AED',
               'united arab emirates': 'AED', 'us': 'USD', 'usa': 'USD', 'united states': 'USD', 'gb': 'GBP', 'uk': 'GBP',
               'united kingdom': 'GBP', 'qa': 'QAR', 'qatar': 'QAR', 'bh': 'BHD', 'bahrain': 'BHD', 'kw': 'KWD', 'kuwait': 'KWD',
               'om': 'OMR', 'oman': 'OMR', 'eg': 'EGP', 'egypt': 'EGP'}
NOT_EXPENSE = {'transfer', 'income', 'ignore', 'loan_payment', 'saving', 'asset', 'repaid', 'reimbursement', 'borrow', 'repay', 'lend'}


def trip_currency(trip):
    return COUNTRY_CUR.get((trip['country'] or '').strip().lower())


def trip_expenses(trip, ctx):
    """[(txn, status)]: debits in the trip's window (in its country's currency; on a trip abroad also in the base currency, so
    flights and hotels billed in SAR count, while on a trip home, base-currency spending back in Saudi does not) plus anything tagged to it.
    In a claim → claimed; else the tag; else unreviewed."""
    cur, home = trip_currency(trip), ctx['house'].get('home_currency') or 'INR'
    tags = {r['txn_id']: r['status'] for r in ctx['trip_tags'] if r['trip_id'] == trip['id']}
    out = []
    for t in ctx['raw_txns']:
        inside = (t['direction'] == 'debit' and trip['start_on'] <= t['day'] <= trip['end_on'] and t['purpose'] not in NOT_EXPENSE
                  and (not cur or t['currency'] == cur or (t['currency'] == ctx['cur'] and cur != home)))
        if inside or t['id'] in tags:
            out.append((t, 'claimed' if t['id'] in ctx['claimed'] else tags.get(t['id'], 'unreviewed')))
    return out


def trip_json(trip, ctx, full=False):
    cur, base = trip_currency(trip) or ctx['cur'], ctx['cur']
    exp = trip_expenses(trip, ctx)
    sums, sums_base = defaultdict(float), defaultdict(float)
    for t, st in exp:
        for d, c in ((sums, cur), (sums_base, base)):
            v = engine.conv(t['amount_minor'], t['currency'], c, ctx['r'])
            d[st] += v
            d['total'] += v
    keys = ('total', 'claimed', 'personal', 'missed', 'unreviewed')
    claim_ids = sorted({ctx['claimed'][t['id']] for t, _ in exp if t['id'] in ctx['claimed']})
    out = {'id': trip['id'], 'name': trip['name'], 'city': trip['city'], 'country': trip['country'], 'start_on': trip['start_on'],
           'end_on': trip['end_on'], 'kind': trip['kind'], 'currency': cur, 'claim_ids': claim_ids,
           'totals': {k: M(sums[k], cur) for k in keys}, 'totals_base': {k: M(sums_base[k], base) for k in keys}, 'count': len(exp)}
    if full:
        out['expenses'] = [{**v, 'trip_status': st} for v, (_, st) in zip(txn_views(ctx, [ctx['by_id'][t['id']] for t, _ in exp]), exp)]
        out['claims'] = [c for c in claim_rows(ctx) if c['id'] in claim_ids]
    return out


def _trip(req, ctx=None):
    ctx = ctx or insights.load(req)
    trip = next((t for t in ctx['trips'] if t['id'] == req.params['id']), None)
    if not trip:
        raise ApiError(404, 'no such trip')
    return trip, ctx


@route('GET', '/api/trips')
def trips(req):
    ctx = insights.load(req)
    return {'items': [trip_json(t, ctx) for t in ctx['trips']]}


@route('GET', '/api/trips/{id}')
def trip(req):
    t, ctx = _trip(req)
    return trip_json(t, ctx, full=True)


@route('POST', '/api/trips')
def trip_add(req):
    cols = clean(req.hh, 'trips', req.json, True)
    if cols['end_on'] < cols['start_on']:
        raise ApiError(400, 'end_on must be on or after start_on')
    req.params['id'] = req.hh.insert('trips', created_at=now(), **cols)['id']
    return 201, trip(req)


@route('PATCH', '/api/trips/{id}')
def trip_edit(req):
    t = _get(req.hh, 'trips', req.params['id'], 'trip')
    cols = clean(req.hh, 'trips', req.json, False)
    if cols.get('end_on', t['end_on']) < cols.get('start_on', t['start_on']):
        raise ApiError(400, 'end_on must be on or after start_on')
    req.hh.update('trips', req.params['id'], **cols)
    return trip(req)


@route('DELETE', '/api/trips/{id}')
def trip_delete(req):
    _get(req.hh, 'trips', req.params['id'], 'trip')
    req.hh.run('DELETE FROM trip_txns WHERE trip_id = :t AND household_id = :hid', t=req.params['id'])
    req.hh.run('DELETE FROM trips WHERE id = :t AND household_id = :hid', t=req.params['id'])
    return deleted(req.params['id'])


@route('POST', '/api/trips/{id}/tag')
def trip_tag(req):
    _get(req.hh, 'trips', req.params['id'], 'trip')
    ids, status = req.json.get('txn_ids'), req.json.get('status')
    if status not in TRIP_STATUS or not isinstance(ids, list) or not ids:
        raise ApiError(400, 'send txn_ids and status: personal, missed, claimed or unreviewed')
    with req.db.tx():
        for tid in ids:
            _txn(req.hh, tid)
            req.hh.run('DELETE FROM trip_txns WHERE trip_id = :t AND txn_id = :x AND household_id = :hid', t=req.params['id'], x=tid)
            req.hh.run("INSERT INTO trip_txns (trip_id, household_id, txn_id, status, set_by) VALUES (:t, :hid, :x, :s, 'user')",
                       t=req.params['id'], x=tid, s=status)
    return trip(req)


@route('POST', '/api/trips/{id}/claim')
def trip_claim(req):
    """A claim from the trip: the given expenses, else every unreviewed or missed one."""
    t, ctx = _trip(req)
    ids = req.json.get('txn_ids')
    if ids is None:
        ids = [x['id'] for x, st in trip_expenses(t, ctx) if st in ('unreviewed', 'missed')]
    if not ids:
        raise ApiError(400, 'nothing on this trip is left to claim')
    req._json = {'name': req.json.get('name') or t['name'], 'payer': req.json.get('payer') or '', 'txn_ids': ids}
    return claim_add(req)


# ---------- claim import (the company's Excel) ----------

HEADS = [('claimed', r'claim|approv|reimburs'), ('date', r'date|\bday\b'), ('currency', r'curr|ccy'),
         ('amount', r'amount|amt|total|value|cost|price'), ('description', r'desc|detail|merchant|particular|item|narrat|vendor|expense|purpose|remark')]


CASH = re.compile(r'\b(%s)\s*([\d,]+(?:\.\d+)?)' % '|'.join(['INR', *engine.USD_PEGS]))  # only codes we can convert


def _money(v):
    """(minor, currency) from a cell; 'QAR 200.00 = SAR 216.00' is the first amount and its currency."""
    import statement
    m = CASH.search(v) if isinstance(v, str) else None
    if m:
        return statement.minor_of(m.group(2)), m.group(1)
    if isinstance(v, str) and re.search(r'[a-z]{3}', v, re.I):  # words ('Return flight — QR 117'), not an amount
        return None, None
    return statement.minor_of(v), None


def _claim_cards(grids):
    """The per-day 'manager view' layout: label | value rows ('Vendor', 'Claimed | QAR x = SAR y') in blocks,
    dated by the last heading line above them (the sheet's day, or a flight or stay heading)."""
    import statement
    out = []
    for grid in grids:
        day, desc, receipt = None, '', (None, None)
        for n, r in enumerate(grid, 1):
            cells = [(j, c) for j, c in enumerate(r) if c not in (None, '')]
            if len(cells) == 1:
                day = statement.day_of(cells[0][1]) or day
                desc, receipt = '', (None, None)
            elif len(cells) >= 2:
                label, value = str(cells[0][1]).strip().lower(), cells[1][1]
                if label in ('vendor', 'what / amount') and not desc:
                    desc = str(value).strip()[:200]
                elif label == 'receipt total':
                    receipt = _money(value)
                elif label == 'claimed' and day:
                    claimed, cur = _money(value)
                    amount = receipt[0] if receipt[0] and receipt[1] == cur else claimed  # the bill is what the card paid
                    if amount:
                        out.append({'row': n, 'day': day, 'description': desc, 'amount_minor': abs(amount),
                                    'claimed_minor': abs(claimed or amount), 'currency': cur})
    return out


def _claim_rows(grids):
    """Rows under the first header of each sheet that names a date and an amount; header words are matched loosely.
    Without such a header, the per-day card layout."""
    import statement
    found = []
    for grid in grids:
        for i, row in enumerate(grid[:20]):
            cols = {}
            for j, cell in enumerate(row):
                text = str(cell or '').strip().lower()
                key = next((k for k, rx in HEADS if k not in cols and text and re.search(rx, text)), None)
                if key:
                    cols[key] = j
            if 'date' not in cols or not ({'amount', 'claimed'} & set(cols)):
                continue
            out = []
            for n, r in enumerate(grid[i + 1:], i + 2):
                cell = lambda k: r[cols[k]] if k in cols and cols[k] < len(r) else None
                day = statement.day_of(cell('date'))
                (amount, c1), (claimed, c2) = _money(cell('amount')), _money(cell('claimed'))
                if not day or not (amount or claimed):
                    continue  # totals, notes and blank lines
                cur = str(cell('currency') or (c1 if amount else c2) or '').strip().upper()[:3]
                out.append({'row': n, 'day': day, 'description': str(cell('description') or '').strip()[:200], 'amount_minor': abs(amount or claimed),
                            'claimed_minor': abs(claimed) if claimed is not None else None, 'currency': cur if cur.isalpha() and len(cur) == 3 else None})
            found += out  # a header with nothing under it is a summary sheet
            break
    found = found or _claim_cards(grids)
    if found:
        return found
    raise ApiError(422, 'could not find the date and amount columns in that file')


@route('POST', '/api/claims/import')
def claims_import(req):
    """The company's claim sheet → a claim whose items are the matching transactions (date ± 3 days, amount within 1%,
    3% across currencies); rows with no match come back as `unmatched`."""
    import statement
    b = req.json
    name = b.get('file_name') if isinstance(b.get('file_name'), str) else ''
    try:
        data = base64.b64decode(b.get('data_base64') or '', validate=True)
    except (binascii.Error, ValueError, TypeError):
        raise ApiError(400, 'data_base64 must be base64')
    if not data:
        raise ApiError(400, 'data_base64 is required')
    ctx, trip = insights.load(req), None
    if b.get('trip_id'):
        req.params['id'] = b['trip_id']
        trip, ctx = _trip(req, ctx)
    ext = name.lower().rsplit('.', 1)[-1]
    try:
        grids = statement._csv(data) if ext == 'csv' else statement._xls(data) if ext == 'xls' else statement._xlsx(data)
    except Exception:  # a broken or locked file is the user's to fix, not a 500
        raise ApiError(422, 'could not read that file: send the claim as .xlsx, .xls or .csv')
    rows = _claim_rows(grids)
    default_cur = (trip_currency(trip) if trip else None) or ctx['cur']
    pool = [t for t, _ in trip_expenses(trip, ctx)] if trip else [t for t in ctx['raw_txns'] if t['direction'] == 'debit']
    pool = [t for t in pool if t['id'] not in ctx['claimed']]
    used, matched, unmatched = set(), [], []
    for r in rows:
        cur, best = r['currency'] or default_cur, None
        for t in pool:
            if t['id'] in used:
                continue
            days = abs((date.fromisoformat(t['day']) - date.fromisoformat(r['day'])).days)
            try:
                diff = abs(engine.conv(t['amount_minor'], t['currency'], cur, ctx['r']) - r['amount_minor'])
            except ValueError:  # a currency we have no rate for: that row stays unmatched
                continue
            tol = max(100, r['amount_minor'] * (0.01 if t['currency'] == cur else 0.03))  # FX moves a little between card and claim
            if days <= 3 and diff <= tol and (best is None or (days, diff) < best[0]):
                best = ((days, diff), t)
        out = {'row': r['row'], 'day': r['day'], 'description': r['description'], 'amount': M(r['amount_minor'], cur),
               'claimed': M(r['claimed_minor'], cur) if r['claimed_minor'] is not None else None}
        if best:
            used.add(best[1]['id'])
            matched.append({**out, 'txn_id': best[1]['id']})
        else:
            unmatched.append(out)
    claim = None
    if matched:
        stem = re.sub(r'\.[^.]+$', '', name).strip()
        req._json = {'name': (trip['name'] if trip else stem or 'Imported claim')[:200], 'txn_ids': [m['txn_id'] for m in matched]}
        claim = claim_add(req)[1]
    return (201 if claim else 200), {'claim': claim, 'matched': matched, 'unmatched': unmatched}


# ---------- settings ----------

def settings_json(s):
    return {'salary': M(s['salary_minor'], s['salary_currency'] or 'SAR') if s['salary_minor'] else None, 'salary_day': s['salary_day'],
            'emergency_months': s['emergency_months'], 'debt_strategy': s['debt_strategy'], 'extra_to_debt_minor': s['extra_to_debt_minor']}


@route('GET', '/api/settings')
def settings_get(req):
    return settings_json(insights.settings(req.hh))


@route('PUT', '/api/settings')
def settings_put(req):
    b = dict(req.json)
    if isinstance(b.get('salary'), dict):  # accept the Money shape back as well as salary_minor + salary_currency
        b.setdefault('salary_minor', b['salary'].get('minor'))
        b.setdefault('salary_currency', b['salary'].get('currency'))
    elif 'salary' in b and b['salary'] is None:
        b['salary_minor'] = None
    checks = {'salary_minor': lambda v: isinstance(v, int) and v >= 0, 'salary_currency': lambda v: isinstance(v, str) and len(v) == 3 and v.isalpha(),
              'salary_day': lambda v: isinstance(v, int) and 1 <= v <= 31, 'emergency_months': lambda v: isinstance(v, (int, float)) and 0 <= v <= 24,
              'debt_strategy': lambda v: v in ('avalanche', 'snowball'), 'extra_to_debt_minor': lambda v: isinstance(v, int) and v >= 0}
    with req.db.tx():
        for k, ok in checks.items():
            if k not in b:
                continue
            v = b[k].upper() if k == 'salary_currency' and isinstance(b[k], str) else b[k]
            if v is not None and not ok(v):
                raise ApiError(400, f'{k} is not valid')
            req.hh.run('DELETE FROM settings WHERE household_id = :hid AND key = :k', k=k)
            req.hh.run('INSERT INTO settings (household_id, key, value) VALUES (:hid, :k, :v)', k=k, v=json.dumps(v))
    return settings_json(insights.settings(req.hh))
