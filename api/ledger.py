"""Accounts, transactions, splits, links, review and categories (docs/brain/api-v3.md, "Ledger").

Private accounts (visibility = 'private') and their transactions are seen only by the account's owner member.
plan.py / insights.py / mcp.py may call: txn_views, visible_txns, get_txn, account_views, categories_list."""
import json
from collections import defaultdict
from pathlib import Path

from api import classify, households, valid
from api.app import ApiError, route
from api.db import new_id, now

KINDS = {'bank', 'wallet', 'credit_card', 'debit_card', 'bnpl', 'loan', 'cash', 'investment'}
PURPOSES = {'spend', 'fee', 'transfer', 'income', 'support', 'lend', 'repaid', 'borrow', 'repay', 'loan_payment', 'claim',
            'reimbursement', 'asset', 'saving', 'refund', 'ignore'}
LINK_KINDS = {'transfer', 'refund', 'repayment'}
MAX_PAGE = 200
TXN_SELECT = ('SELECT t.*, m.purpose, m.confidence, m.set_by, m.person_member_id, m.person_contact_id, m.claim_id, m.commitment_id, m.liability_id, '
              'a.name AS account_name FROM transactions t '
              'LEFT JOIN txn_meta m ON m.txn_id = t.id AND m.household_id = t.household_id '
              'LEFT JOIN accounts a ON a.id = t.account_id AND a.household_id = t.household_id ')
VISIBLE = "(t.account_id IS NULL OR a.visibility = 'household' OR a.owner_member_id = :me)"


# ---------- transactions: shapes ----------

def _names(hh):
    return ({m['id']: m['display_name'] for m in hh.run('SELECT id, display_name FROM members WHERE household_id = :hid')},
            {c['id']: c['name'] for c in hh.run('SELECT id, name FROM contacts WHERE household_id = :hid')})


def txn_views(hh, rows):
    """API Txn objects for TXN_SELECT rows."""
    if not rows:
        return []
    members, contacts = _names(hh)
    sql, p = valid.inlist('s', [r['id'] for r in rows])
    shared = defaultdict(int)
    for s in hh.run(f'SELECT txn_id, share_minor FROM splits WHERE household_id = :hid AND txn_id IN {sql}', **p):
        shared[s['txn_id']] += s['share_minor']
    out = []
    for r in rows:
        person = ({'kind': 'member', 'id': r['person_member_id'], 'name': members.get(r['person_member_id'], '')} if r['person_member_id'] else
                  {'kind': 'contact', 'id': r['person_contact_id'], 'name': contacts.get(r['person_contact_id'], '')} if r['person_contact_id'] else None)
        out.append({'id': r['id'], 'day': r['day'], 'occurred_at': r['occurred_at'], 'amount': valid.money(r['amount_minor'], r['currency']),
                    'direction': r['direction'], 'merchant': r['merchant'], 'category': r['category'] or 'Uncategorized',
                    'purpose': r['purpose'] or ('spend' if r['direction'] == 'debit' else 'income'),
                    'confidence': float(r['confidence']) if r['confidence'] is not None else 0.0,
                    'account_id': r['account_id'], 'account_name': r['account_name'], 'member_id': r['member_id'], 'note': r['note'],
                    'source': r['source'], 'person': person,
                    'split_mine': valid.money(r['amount_minor'] - shared[r['id']], r['currency']) if r['id'] in shared else None,
                    'claim_id': r['claim_id'], 'commitment_id': r['commitment_id'], 'liability_id': r['liability_id']})
    return out


def visible_txns(hh, member_id, where='', order='ORDER BY t.day DESC, t.id DESC', limit=None, **params):
    """TXN_SELECT rows the member may see (not deleted), with extra SQL conditions `where` ('AND ...')."""
    sql = TXN_SELECT + f'WHERE t.household_id = :hid AND t.deleted_at IS NULL AND {VISIBLE} {where} {order}' + (f' LIMIT {int(limit)}' if limit else '')
    return hh.run(sql, me=member_id or '', **params)


def get_txn(hh, member_id, tid):
    rows = visible_txns(hh, member_id, 'AND t.id = :tid', tid=valid.ident(tid, 'transaction'))
    if not rows:
        raise ApiError(404, 'transaction not found')
    return rows[0]


def _view(req, tid):
    return txn_views(req.hh, [get_txn(req.hh, req.member['id'], tid)])[0]


# ---------- accounts ----------

def _balance(hh, a):
    """(minor, at): the last balance an SMS stated, else the opening balance plus movements since; (None, None) unknown."""
    if a['last_balance_minor'] is not None:
        return a['last_balance_minor'], a['last_balance_at']
    if not a['opening_as_of']:
        return None, None
    r = hh.one("SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS n, MAX(day) AS last "
               "FROM transactions WHERE household_id = :hid AND account_id = :a AND deleted_at IS NULL AND day >= :d", a=a['id'], d=a['opening_as_of'])
    return a['opening_balance_minor'] + int(r['n']), r['last'] or a['opening_as_of']


def account_view(hh, a):
    bal, at = _balance(hh, a)
    limit = a['credit_limit_minor'] or None
    used = round(100 * max(0, -bal) / limit) if limit and bal is not None and a['kind'] in ('credit_card', 'bnpl') else None
    return {'id': a['id'], 'kind': a['kind'], 'institution': a['institution'], 'name': a['name'], 'currency': a['currency'], 'country': a['country'],
            'last4': a['last4'], 'owner_member_id': a['owner_member_id'], 'visibility': a['visibility'],
            'balance': valid.money(bal, a['currency']), 'balance_at': at, 'credit_limit': valid.money(limit, a['currency']), 'used_pct': used,
            'due_day': a['due_day'], 'statement_day': a['statement_day'], 'rate_bp': a['rate_bp'], 'archived': bool(a['archived_at'])}


def account_rows(hh, member_id, archived=False):
    return hh.run("SELECT * FROM accounts WHERE household_id = :hid AND (visibility = 'household' OR owner_member_id = :me) "
                  + ('' if archived else 'AND archived_at IS NULL ') + 'ORDER BY kind, name', me=member_id or '')


def account_views(hh, member_id, archived=False):
    return [account_view(hh, a) for a in account_rows(hh, member_id, archived)]


def get_account(hh, member_id, aid):
    a = hh.one("SELECT * FROM accounts WHERE id = :id AND household_id = :hid AND (visibility = 'household' OR owner_member_id = :me)",
               id=valid.ident(aid, 'account'), me=member_id or '')
    if not a:
        raise ApiError(404, 'account not found')
    return a


def _account_fields(req, b, partial):
    cols = {}
    need = lambda k: k in b or not partial
    if need('kind'):
        cols['kind'] = valid.choice(b.get('kind'), KINDS, 'kind')
    if need('name'):
        cols['name'] = valid.text(b.get('name'), 'name')
    if need('currency'):
        cols['currency'] = valid.currency(b.get('currency'))
    for k, n in (('institution', 60), ('country', 2)):
        if k in b:
            cols[k] = valid.text(b[k], k, n, required=False)
    if 'last4' in b:
        v = b['last4'] or ''
        if not isinstance(v, str) or not (v == '' or v.isdigit() and 3 <= len(v) <= 4):
            raise ApiError(400, 'last4 must be the last 3-4 digits')
        cols['last4'] = v
    if 'visibility' in b:
        cols['visibility'] = valid.choice(b['visibility'], {'household', 'private'}, 'visibility')
    for k in ('credit_limit_minor', 'opening_balance_minor'):
        if k in b:
            cols[k] = valid.minor(b[k], k)
    for k, lo, hi in (('due_day', 0, 31), ('statement_day', 0, 31), ('rate_bp', 0, 100000)):
        if k in b:
            cols[k] = valid.integer(b[k], k, lo, hi)
    if 'opening_as_of' in b:
        cols['opening_as_of'] = valid.day(b['opening_as_of'], 'opening_as_of', required=False)
    if 'owner_member_id' in b:
        cols['owner_member_id'] = households._member(req, b['owner_member_id'])['id'] if b['owner_member_id'] else None
    return cols


@route('GET', '/api/accounts')
def list_accounts(req):
    return {'items': account_views(req.hh, req.member['id'], archived=req.query.get('archived') == '1')}


@route('POST', '/api/accounts')
def add_account(req):
    cols = {'owner_member_id': req.member['id'], **_account_fields(req, req.json, partial=False)}
    a = req.hh.insert('accounts', created_at=now(), **cols)
    return 201, account_view(req.hh, req.hh.get('accounts', a['id']))


@route('PATCH', '/api/accounts/{id}')
def patch_account(req):
    a = get_account(req.hh, req.member['id'], req.params['id'])
    cols = _account_fields(req, req.json, partial=True)
    if 'archived' in req.json:
        cols['archived_at'] = now() if req.json['archived'] else None
    req.hh.update('accounts', a['id'], **cols)
    return account_view(req.hh, req.hh.get('accounts', a['id']))


@route('DELETE', '/api/accounts/{id}')
def archive_account(req):
    a = get_account(req.hh, req.member['id'], req.params['id'])
    req.hh.update('accounts', a['id'], archived_at=now())
    return {'id': a['id'], 'deleted': True}


# ---------- transactions ----------

@route('GET', '/api/transactions')
def list_transactions(req):
    q, where, p = req.query, '', {}
    if q.get('month'):
        m = valid.month(q['month'])
        where += ' AND t.day >= :m0 AND t.day <= :m1'
        p.update(m0=m + '-01', m1=m + '-31')
    if q.get('account_id'):
        where += ' AND t.account_id = :acc'
        p['acc'] = q['account_id'][:32]
    if q.get('category'):
        where += ' AND t.category = :cat'
        p['cat'] = q['category'][:60]
    if q.get('purpose'):
        where += ' AND m.purpose = :pur'
        p['pur'] = valid.choice(q['purpose'], PURPOSES, 'purpose')
    if q.get('member_id'):
        where += ' AND t.member_id = :mem'
        p['mem'] = q['member_id'][:32]
    if q.get('q'):
        where += ' AND (LOWER(t.merchant) LIKE :q OR LOWER(t.note) LIKE :q OR LOWER(t.merchant_raw) LIKE :q)'
        p['q'] = '%' + q['q'][:60].lower().replace('\\', '').replace('%', '').replace('_', '') + '%'
    if q.get('review') == '1':
        where += " AND (m.txn_id IS NULL OR (m.confidence < :rb AND m.set_by != 'user'))"
        p['rb'] = classify.REVIEW_BELOW
    if q.get('before'):
        d, _, i = q['before'].partition('_')
        valid.day(d, 'before')
        where += ' AND (t.day < :bd OR (t.day = :bd AND t.id < :bi))'
        p.update(bd=d, bi=i[:32])
    try:
        limit = min(MAX_PAGE, max(1, int(q.get('limit', 50))))
    except ValueError:
        raise ApiError(400, 'limit must be a number')
    rows = visible_txns(req.hh, req.member['id'], where, limit=limit + 1, **p)
    more = len(rows) > limit
    rows = rows[:limit]
    return {'items': txn_views(req.hh, rows), 'next_before': f"{rows[-1]['day']}_{rows[-1]['id']}" if more else None}


def _splits(hh, tid, cur):
    members, contacts = _names(hh)
    return [{'id': s['id'], 'member_id': s['member_id'], 'contact_id': s['contact_id'],
             'name': members.get(s['member_id']) if s['member_id'] else contacts.get(s['contact_id'], ''),
             'share': valid.money(s['share_minor'], cur), 'settled': bool(s['settled_at'])}
            for s in hh.run('SELECT * FROM splits WHERE household_id = :hid AND txn_id = :t ORDER BY id', t=tid)]


@route('GET', '/api/transactions/{id}')
def get_transaction(req):
    row = get_txn(req.hh, req.member['id'], req.params['id'])
    out = txn_views(req.hh, [row])[0]
    raw = row['raw_message_id'] and req.hh.one('SELECT sender, body FROM raw_messages WHERE id = :id AND household_id = :hid', id=row['raw_message_id'])
    links = req.hh.run('SELECT * FROM txn_links WHERE household_id = :hid AND (from_txn = :t OR to_txn = :t) ORDER BY created_at', t=row['id'])
    claim = row['claim_id'] and req.hh.one('SELECT id, name, status FROM claims WHERE id = :id AND household_id = :hid', id=row['claim_id'])
    out.update(raw={'sender': raw['sender'], 'body': raw['body']} if raw else None,
               links=[{'id': l['id'], 'kind': l['kind'], 'other_txn_id': l['to_txn'] if l['from_txn'] == row['id'] else l['from_txn'],
                       'role': 'from' if l['from_txn'] == row['id'] else 'to', 'set_by': l['set_by']} for l in links],
               splits=_splits(req.hh, row['id'], row['currency']), claim=claim or None)
    return out


@route('POST', '/api/transactions')
def add_transaction(req):
    b = req.json
    account = get_account(req.hh, req.member['id'], b['account_id']) if b.get('account_id') else None
    d = valid.day(b.get('day'))
    cols = {'account_id': account and account['id'], 'member_id': req.member['id'], 'occurred_at': d + 'T12:00:00+00:00', 'day': d,
            'amount_minor': valid.minor(b.get('amount_minor'), 'amount_minor', positive=True), 'currency': valid.currency(b.get('currency')),
            'direction': valid.choice(b.get('direction'), {'debit', 'credit'}, 'direction', 'debit'),
            'merchant': valid.text(b.get('merchant'), 'merchant', 80), 'note': valid.text(b.get('note'), 'note', 500, required=False),
            'category': valid.text(b.get('category'), 'category', 40, required=False), 'source': 'manual', 'created_at': now()}
    cols['merchant_raw'] = cols['merchant']
    purpose = valid.choice(b['purpose'], PURPOSES, 'purpose') if b.get('purpose') else None
    t = req.hh.insert('transactions', dedupe_key='', **cols)
    req.hh.update('transactions', t['id'], dedupe_key='manual.' + t['id'])
    classify.reclassify(req.hh, [t['id']])
    if purpose or cols['category']:  # what the user said wins over the guess
        meta = req.hh.one('SELECT * FROM txn_meta WHERE txn_id = :t AND household_id = :hid', t=t['id'])
        classify.save_meta(req.hh, t['id'], {**meta, 'purpose': purpose or meta['purpose'], 'category': cols['category'] or None, 'confidence': 1.0}, 'user')
    return 201, _view(req, t['id'])


@route('PATCH', '/api/transactions/{id}')
def patch_transaction(req):
    row, b = get_txn(req.hh, req.member['id'], req.params['id']), req.json
    meta = req.hh.one('SELECT * FROM txn_meta WHERE txn_id = :t AND household_id = :hid', t=row['id']) or {
        'purpose': 'spend' if row['direction'] == 'debit' else 'income'}
    meta = dict(meta)
    changed = {}
    if 'category' in b:
        changed['category'] = valid.text(b['category'], 'category', 40)
    if 'purpose' in b:
        changed['purpose'] = valid.choice(b['purpose'], PURPOSES, 'purpose')
    if 'person' in b:
        changed['person_member_id'], changed['person_contact_id'] = households.person_of(req, b['person']) if b['person'] else (None, None)
    if 'liability_id' in b:  # pay a loan by hand: a catch-up EMI the match rule missed
        lid = b['liability_id'] and valid.ident(b['liability_id'], 'liability_id')
        if lid and not req.hh.one('SELECT id FROM liabilities WHERE id = :l AND household_id = :hid', l=lid):
            raise ApiError(400, 'unknown liability_id')
        changed['liability_id'] = lid or None
        if lid and 'purpose' not in b:
            changed['purpose'] = 'loan_payment'
    if 'note' in b:
        req.hh.update('transactions', row['id'], note=valid.text(b['note'], 'note', 500, required=False))
    if changed:
        classify.save_meta(req.hh, row['id'], {**meta, **changed, 'confidence': 1.0}, 'user')
        if b.get('apply_to_merchant') and row['merchant']:
            classify.apply_rule(req.hh, row['merchant'], changed.get('category', ''), changed.get('purpose', ''),
                                changed.get('person_member_id'), changed.get('person_contact_id'))
    return _view(req, row['id'])


@route('POST', '/api/transactions/{id}/split')
def split(req):
    row, shares = get_txn(req.hh, req.member['id'], req.params['id']), req.json.get('shares')
    if not isinstance(shares, list) or len(shares) > 20:
        raise ApiError(400, 'shares must be a list (at most 20)')
    clean = []
    for s in shares:
        if not isinstance(s, dict) or bool(s.get('member_id')) == bool(s.get('contact_id')):
            raise ApiError(400, 'each share needs member_id or contact_id')
        who = households._member(req, s['member_id'])['id'] if s.get('member_id') else households._contact(req, s['contact_id'])['id']
        clean.append((s.get('member_id') and who, s.get('contact_id') and who, valid.minor(s.get('share_minor'), 'share_minor', positive=True)))
    if sum(c[2] for c in clean) > row['amount_minor']:
        raise ApiError(400, 'the shares add up to more than the amount')
    with req.db.tx():
        req.hh.run('DELETE FROM splits WHERE household_id = :hid AND txn_id = :t AND settled_at IS NULL', t=row['id'])
        for m, c, share in clean:
            req.hh.insert('splits', txn_id=row['id'], member_id=m or None, contact_id=c or None, share_minor=share)
    return _view(req, row['id'])


@route('POST', '/api/transactions/{id}/link')
def link(req):
    row, b = get_txn(req.hh, req.member['id'], req.params['id']), req.json
    other = get_txn(req.hh, req.member['id'], b.get('to_txn_id'))
    kind = valid.choice(b.get('kind'), LINK_KINDS, 'kind')
    if other['id'] == row['id']:
        raise ApiError(400, 'pick another transaction')
    if kind == 'transfer' and row['direction'] == other['direction']:
        raise ApiError(400, 'a transfer links money going out with money coming in')
    first, second = sorted((row, other), key=lambda t: (t['occurred_at'], t['id']))
    with req.db.tx():
        req.hh.run('DELETE FROM txn_links WHERE household_id = :hid AND ((from_txn = :a AND to_txn = :b) OR (from_txn = :b AND to_txn = :a))', a=row['id'], b=other['id'])
        if kind == 'transfer':
            req.hh.run("DELETE FROM txn_links WHERE household_id = :hid AND kind = 'transfer' AND (from_txn IN (:a, :b) OR to_txn IN (:a, :b))", a=row['id'], b=other['id'])
        frm, to = (row, other) if kind != 'transfer' or row['direction'] == 'debit' else (other, row)
        req.hh.insert('txn_links', kind=kind, from_txn=frm['id'], to_txn=to['id'], set_by='user', created_at=now(),
                      fx_rate=None if frm['currency'] == to['currency'] else round(to['amount_minor'] / frm['amount_minor'], 6))
        if kind == 'transfer':
            for t in (row, other):
                classify.save_meta(req.hh, t['id'], {'purpose': 'transfer', 'category': classify.OWN_TRANSFER, 'confidence': 1.0}, 'user')
        elif kind == 'refund':
            back = row if row['direction'] == 'credit' else other
            orig = other if back is row else row
            classify.save_meta(req.hh, back['id'], {'purpose': 'refund', 'category': orig['category'] or 'Income', 'confidence': 1.0}, 'user')
        else:  # repayment: the later one settles the earlier, with the same person
            purpose = 'repaid' if second['direction'] == 'credit' else 'repay'
            classify.save_meta(req.hh, second['id'], {'purpose': purpose, 'confidence': 1.0, 'person_member_id': first['person_member_id'],
                                                      'person_contact_id': first['person_contact_id']}, 'user')
    return _view(req, row['id'])


@route('DELETE', '/api/transactions/{id}/link/{link_id}')
def unlink(req):
    row = get_txn(req.hh, req.member['id'], req.params['id'])
    l = req.hh.one('SELECT * FROM txn_links WHERE id = :id AND household_id = :hid AND (from_txn = :t OR to_txn = :t)',
                   id=valid.ident(req.params['link_id'], 'link'), t=row['id'])
    if not l:
        raise ApiError(404, 'link not found')
    req.hh.run('DELETE FROM txn_links WHERE id = :id AND household_id = :hid', id=l['id'])
    if l['kind'] == 'transfer':  # guess again without pairing, and keep it so the pair doesn't come back
        ids = [l['from_txn'], l['to_txn']]
        sql, p = valid.inlist('u', ids)
        req.hh.run(f'DELETE FROM txn_meta WHERE household_id = :hid AND txn_id IN {sql}', **p)
        classify.reclassify(req.hh, ids, pair=False)
        req.hh.run(f"UPDATE txn_meta SET set_by = 'user' WHERE household_id = :hid AND txn_id IN {sql}", **p)
    return _view(req, row['id'])


@route('DELETE', '/api/transactions/{id}')
def delete_transaction(req):
    row = get_txn(req.hh, req.member['id'], req.params['id'])
    req.hh.update('transactions', row['id'], deleted_at=now())
    return {'id': row['id'], 'deleted': True}


# ---------- review ----------

def suggestions(t, parents, contacts):
    p = lambda kind, x: {'kind': kind, 'id': x['id'], 'name': x['name']}
    if t['direction'] == 'debit':
        out = [{'purpose': 'spend', 'category': t['category'] if t['category'] != 'Uncategorized' else None, 'person': None, 'label': 'Spending'},
               {'purpose': 'transfer', 'category': classify.OWN_TRANSFER, 'person': None, 'label': 'Moved to my own account'}]
        out += [{'purpose': 'support', 'category': 'Family', 'person': p('member', m), 'label': f"Support for {m['name']}"} for m in parents]
        out += [{'purpose': 'lend', 'category': None, 'person': p('contact', c), 'label': f"Lent to {c['name']}"} for c in contacts]
    else:
        out = [{'purpose': 'income', 'category': 'Income', 'person': None, 'label': 'Income'},
               {'purpose': 'refund', 'category': None, 'person': None, 'label': 'A refund'},
               {'purpose': 'transfer', 'category': classify.OWN_TRANSFER, 'person': None, 'label': 'From my own account'}]
        out += [{'purpose': 'repaid', 'category': None, 'person': p('contact', c), 'label': f"{c['name']} paid me back"} for c in contacts]
    return out


@route('GET', '/api/review')
def review(req):
    where = " AND (m.txn_id IS NULL OR (m.confidence < :rb AND m.set_by != 'user'))"
    rows = visible_txns(req.hh, req.member['id'], where, order='ORDER BY COALESCE(m.confidence, 0), t.day DESC, t.id DESC', rb=classify.REVIEW_BELOW)
    parents = [{'id': m['id'], 'name': m['display_name']} for m in
               req.hh.run("SELECT id, display_name FROM members WHERE household_id = :hid AND removed_at IS NULL AND relation = 'parent'")]
    contacts = [{'id': c['id'], 'name': c['name']} for c in req.hh.run(
        'SELECT c.id, c.name, COUNT(m.txn_id) AS n FROM contacts c LEFT JOIN txn_meta m ON m.person_contact_id = c.id AND m.household_id = c.household_id '
        'WHERE c.household_id = :hid AND c.removed_at IS NULL GROUP BY c.id, c.name ORDER BY n DESC, c.name LIMIT 2')]
    items = txn_views(req.hh, rows[:100])
    for v, r in zip(items, rows):
        v['suggestions'] = suggestions(r, parents, contacts)
    return {'items': items, 'count': len(rows)}


# ---------- categories ----------

def _seed_categories(db):
    if db.one('SELECT id FROM categories WHERE household_id IS NULL LIMIT 1'):
        return
    with db.lock('categories-seed'):
        if db.one('SELECT id FROM categories WHERE household_id IS NULL LIMIT 1'):
            return
        tree = json.loads((Path(__file__).parent.parent / 'data' / 'categories.json').read_text(encoding='utf-8'))
        seen = set()
        rows = []
        for name, c in tree.items():
            if name.startswith('_'):
                continue
            rows.append((name, c.get('parent'), c.get('kind', 'spend'), c.get('icon', '')))
            seen.add(name)
        for name, c in tree.items():
            for child in (c.get('children') or []) if not name.startswith('_') else []:
                if child not in seen:
                    seen.add(child)
                    rows.append((child, name, c.get('kind', 'spend'), ''))
        with db.tx():
            for name, parent, kind, icon in rows:
                db.run('INSERT INTO categories (id, household_id, parent_id, name, kind, icon) VALUES (:id, NULL, :p, :n, :k, :i)',
                       id=new_id(), p=parent, n=name, k=kind, i=icon)


def categories_list(hh):
    _seed_categories(hh.db)
    return [{'id': c['id'], 'name': c['name'], 'parent': c['parent_id'], 'kind': c['kind'], 'icon': c['icon']}
            for c in hh.run('SELECT * FROM categories WHERE household_id IS NULL OR household_id = :hid ORDER BY name')]


@route('GET', '/api/categories')
def get_categories(req):
    return {'items': categories_list(req.hh)}


# ---------- settle up ----------

@route('POST', '/api/settle')
def settle(req):
    b = req.json
    mid, cid = households.person_of(req, b.get('person'))
    cur = valid.currency(b.get('currency'))
    kind, pid = ('member', mid) if mid else ('contact', cid)
    with req.db.tx():
        if b.get('txn_id'):
            t = get_txn(req.hh, req.member['id'], b['txn_id'])
            classify.save_meta(req.hh, t['id'], {'purpose': 'repaid' if t['direction'] == 'credit' else 'repay', 'confidence': 1.0,
                                                 'person_member_id': mid, 'person_contact_id': cid}, 'user')
        col = 'member_id' if mid else 'contact_id'
        req.hh.run(f'UPDATE splits SET settled_at = :t, settled_txn_id = :st WHERE household_id = :hid AND {col} = :p AND settled_at IS NULL '
                   'AND txn_id IN (SELECT id FROM transactions WHERE household_id = :hid AND currency = :c)',
                   t=now(), st=b.get('txn_id') if isinstance(b.get('txn_id'), str) else None, p=pid, c=cur)
        req.hh.run('INSERT INTO settings (household_id, key, value) VALUES (:hid, :k, :v) ON CONFLICT (household_id, key) DO UPDATE SET value = :v',
                   k=households.settle_key(kind, pid, cur), v=now())
    item = next(p for p in households.people(req.hh, req.db) if p['kind'] == kind and p['id'] == pid)
    return {'ok': True, 'person': item}
