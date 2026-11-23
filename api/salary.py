"""Salary history (migration 006): base pay from a month on (each member's latest wins), and arrears or bonuses paid once
in their month. engine.salary_in reads it for expected income (month view, look-ahead, what-if); without entries the old
single salary setting still applies."""
import re

import engine
from api import insights
from api.app import ApiError, route
from api.db import now

KINDS = ('base', 'arrears', 'bonus')


def view(r, names):
    return {'id': r['id'], 'member_id': r['member_id'], 'member_name': names.get(r['member_id'], ''), 'from_month': r['from_month'],
            'amount': engine.money(r['amount_minor'], r['currency']), 'kind': r['kind'], 'note': r['note']}


def _names(hh):
    return {m['id']: m['display_name'] for m in hh.run('SELECT id, display_name FROM members WHERE household_id = :hid')}


@route('GET', '/api/salary')
def salary_list(req):
    ctx = insights.load(req)
    month, names = ctx['today'][:7], _names(req.hh)
    rows = sorted(ctx['eng_settings']['salary_history'], key=lambda r: (r['from_month'], r['created_at']), reverse=True)
    expected = engine.expected_income(ctx['eng_settings'], ctx['txns'], month, ctx['cur'], ctx['r'])
    return {'items': [view(r, names) for r in rows], 'month': month, 'expected_this_month': engine.money(expected, ctx['cur'])}


@route('POST', '/api/salary')
def salary_add(req):
    b = req.json
    month, amount, cur, kind = b.get('from_month'), b.get('amount_minor'), b.get('currency'), b.get('kind') or 'base'
    if not isinstance(month, str) or not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', month):
        raise ApiError(400, 'from_month must be YYYY-MM')
    if not isinstance(amount, int) or isinstance(amount, bool) or not 0 < amount <= 10 ** 13:
        raise ApiError(400, 'amount_minor must be a whole number above 0')
    if not isinstance(cur, str) or not re.fullmatch(r'[A-Za-z]{3}', cur):
        raise ApiError(400, 'currency must be a 3-letter code')
    if kind not in KINDS:
        raise ApiError(400, 'kind must be base, arrears or bonus')
    note = b.get('note') or ''
    if not isinstance(note, str) or len(note) > 200:
        raise ApiError(400, 'note must be text up to 200 characters')
    member = b.get('member_id') or req.member['id']
    if not isinstance(member, str) or not req.hh.get('members', member):
        raise ApiError(400, 'member_id: no such member in this household')
    row = req.hh.insert('salary_history', member_id=member, from_month=month, amount_minor=amount, currency=cur.upper(), kind=kind,
                        note=note.strip(), created_at=now())
    return 201, view(req.hh.get('salary_history', row['id']), _names(req.hh))


@route('DELETE', '/api/salary/{id}')
def salary_delete(req):
    if not req.hh.get('salary_history', req.params['id']):
        raise ApiError(404, 'no such salary entry')
    req.hh.run('DELETE FROM salary_history WHERE id = :id AND household_id = :hid', id=req.params['id'])
    return {'id': req.params['id'], 'deleted': True}
