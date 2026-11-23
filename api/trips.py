"""Trips, trip expenses, and reconciling a trip against its company claims. Routes for the household ('member' auth)."""
import base64
import binascii
import os
import tempfile
from datetime import date

from api.app import ApiError, route
from api.claims import import_claim
from api.db import now

DAY_SLACK = 2        # a claimed item matches a transaction up to this many days away
TAGS = ('personal', 'missed_claim')


def _day(v, what):
    try:
        return date.fromisoformat(str(v)).isoformat()
    except ValueError:
        raise ApiError(422, f'{what} must be a date like 2026-08-23')


def _fields(body, partial=False):
    out = {}
    for k in ('name', 'city', 'country'):
        if k in body or not partial:
            out[k] = str(body.get(k) or '').strip()
    if not partial and not out['name']:
        raise ApiError(422, 'give the trip a name')
    for k in ('start_on', 'end_on'):
        if k in body or not partial:
            out[k] = _day(body.get(k), k)
    if 'currency' in body:
        out['currency'] = str(body['currency'] or '').strip().upper()
        if out['currency'] and not (len(out['currency']) == 3 and out['currency'].isalpha()):
            raise ApiError(422, 'currency is a 3-letter code like QAR')
    return out


def _trip(req):
    t = req.hh.get('trips', req.params['id'])
    if not t:
        raise ApiError(404, 'no such trip')
    return t


def _gap(a, b):
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def fits(item, t):
    """Does transaction t pay for claim item: within DAY_SLACK days, and the QAR amount (claimed or on the receipt) or the SAR amount."""
    if _gap(item['day'], t['day']) > DAY_SLACK:
        return False
    amounts = {'QAR': (item['qar_minor'], item['receipt_minor'] if item['receipt_currency'] == 'QAR' else 0), 'SAR': (item['sar_minor'],)}
    return any(a and a == t['amount_minor'] for a in amounts.get(t['currency'], ()))


def reconcile(txns, items, tags):
    """txns: the trip's debits; items: claim lines; tags: {txn_id: status}. Each transaction pays for one item at most, the closest day first."""
    free, matched, unmatched = list(txns), [], []
    for it in sorted(items, key=lambda i: i['day']):
        cands = [t for t in free if fits(it, t)]
        if cands:
            t = min(cands, key=lambda t: _gap(it['day'], t['day']))
            free.remove(t)
            matched.append({'item': it, 'txn': t})
        else:
            unmatched.append(it)
    unclaimed = [dict(t, tag=tags.get(t['id'], '')) for t in free]
    totals = {'spent': {}, 'claimed': {}, 'personal': {}, 'missed': {}}

    def add(key, cur, minor):
        totals[key][cur] = totals[key].get(cur, 0) + minor
    for t in txns:
        add('spent', t['currency'], t['amount_minor'])
    for t in unclaimed:
        if t['tag'] == 'personal':
            add('personal', t['currency'], t['amount_minor'])
        elif t['tag'] == 'missed_claim':
            add('missed', t['currency'], t['amount_minor'])
    for it in items:
        add('claimed', 'QAR', it['qar_minor'])
        add('claimed', 'SAR', it['sar_minor'])
    return {'matched': matched, 'unclaimed': unclaimed, 'unmatched_items': unmatched, 'totals': totals}


def trip_txns(hh, trip):
    """Every non-deleted debit dated within the trip; a trip currency narrows it to that currency."""
    sql = ('SELECT id, day, amount_minor, currency, merchant, merchant_raw, account_id FROM transactions WHERE household_id = :hid '
           "AND deleted_at IS NULL AND direction = 'debit' AND day >= :a AND day <= :b")
    if trip['currency']:
        return hh.run(sql + ' AND currency = :c ORDER BY day, id', a=trip['start_on'], b=trip['end_on'], c=trip['currency'])
    return hh.run(sql + ' ORDER BY day, id', a=trip['start_on'], b=trip['end_on'])


def detail(hh, trip):
    items = hh.run('SELECT l.*, c.name AS claim FROM claim_lines l JOIN claims c ON c.id = l.claim_id AND c.household_id = l.household_id '
                   'WHERE l.household_id = :hid AND c.trip_id = :t ORDER BY l.day, l.id', t=trip['id'])
    tags = {r['txn_id']: r['status'] for r in hh.run('SELECT txn_id, status FROM trip_tags WHERE household_id = :hid AND trip_id = :t', t=trip['id'])}
    return dict(trip, **reconcile(trip_txns(hh, trip), items, tags))


@route('GET', '/trips')
def list_trips(req):
    out = []
    for t in req.hh.run('SELECT * FROM trips WHERE household_id = :hid ORDER BY start_on DESC'):
        d = detail(req.hh, t)
        out.append({**t, 'totals': d['totals'], 'counts': {k: len(d[k]) for k in ('matched', 'unclaimed', 'unmatched_items')}})
    return {'items': out}


@route('POST', '/trips')
def create_trip(req):
    f = _fields(req.json)
    if f['end_on'] < f['start_on']:
        raise ApiError(422, 'the trip ends before it starts')
    return 201, req.hh.insert('trips', currency=f.pop('currency', ''), created_at=now(), **f)


@route('PATCH', '/trips/{id}')
def update_trip(req):
    t = _trip(req)
    f = _fields(req.json, partial=True)
    merged = {**t, **f}
    if merged['end_on'] < merged['start_on']:
        raise ApiError(422, 'the trip ends before it starts')
    req.hh.update('trips', t['id'], **f)
    return req.hh.get('trips', t['id'])


@route('DELETE', '/trips/{id}')
def delete_trip(req):
    t = _trip(req)
    for c in req.hh.run('SELECT id FROM claims WHERE household_id = :hid AND trip_id = :t', t=t['id']):
        req.hh.run('DELETE FROM claim_lines WHERE household_id = :hid AND claim_id = :c', c=c['id'])
    req.hh.run('DELETE FROM claims WHERE household_id = :hid AND trip_id = :t', t=t['id'])
    req.hh.run('DELETE FROM trip_tags WHERE household_id = :hid AND trip_id = :t', t=t['id'])
    req.hh.run('DELETE FROM trips WHERE household_id = :hid AND id = :t', t=t['id'])
    return {'id': t['id'], 'deleted': True}


@route('GET', '/trips/{id}')
def get_trip(req):
    return detail(req.hh, _trip(req))


@route('POST', '/trips/{id}/tag')
def tag(req):
    """{txn_id, status: personal | missed_claim | '' (clear)}"""
    t, b = _trip(req), req.json
    if b.get('status') not in (*TAGS, ''):
        raise ApiError(422, 'status is personal, missed_claim or empty')
    if not any(x['id'] == b.get('txn_id') for x in trip_txns(req.hh, t)):
        raise ApiError(404, 'that transaction is not in this trip')
    req.hh.run('DELETE FROM trip_tags WHERE household_id = :hid AND trip_id = :t AND txn_id = :x', t=t['id'], x=b['txn_id'])
    if b['status']:
        req.hh.insert('trip_tags', trip_id=t['id'], txn_id=b['txn_id'], status=b['status'])
    return detail(req.hh, t)


@route('POST', '/trips/{id}/claims/import')
def import_file(req):
    """{file_name, data_base64}: a claim workbook, uploaded."""
    t, b = _trip(req), req.json
    try:
        data = base64.b64decode(b.get('data_base64') or '', validate=True)
    except (binascii.Error, ValueError):
        raise ApiError(400, 'data_base64 is not valid base64')
    name = os.path.splitext(os.path.basename(str(b.get('file_name') or 'claim.xlsx')))[0]
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'claim.xlsx')
        with open(path, 'wb') as f:
            f.write(data)
        try:
            return 201, import_claim(req.hh, t['id'], path, name=name)
        except Exception as e:  # a corrupt or unknown workbook is the sender's problem, not a 500
            raise ApiError(422, f'could not read the workbook: {e}')
