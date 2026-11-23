"""Household, members, invites, contacts, people balances and phones (docs/brain/api-v3.md, "Household & people")."""
import json
import os
import re
import secrets
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from api import auth, emailer, valid
from api.app import DIST, ApiError, route
from api.db import Scoped, new_id, now

RELATIONS = {'self', 'spouse', 'parent', 'child', 'sibling', 'other'}
ROLES = {'admin', 'member', 'viewer'}  # 'owner' is only the household's creator
PLATFORMS = {'iphone', 'android', 'other'}
# How a purpose moves a person's balance: + they owe you more, - less (or you owe them).
PERSON_SIGN = {'lend': 1, 'repaid': -1, 'borrow': -1, 'repay': 1}


# ---------- shapes ----------

def member_view(db, m):
    email = None
    if m['user_id']:
        u = db.one('SELECT email FROM users WHERE id = :id', id=m['user_id'])
        email = u and u['email']
    else:
        inv = db.one('SELECT email FROM invites WHERE member_id = :m AND household_id = :h AND accepted_at IS NULL ORDER BY expires_at DESC',
                     m=m['id'], h=m['household_id'])
        email = inv and inv['email']
    return {'id': m['id'], 'display_name': m['display_name'], 'relation': m['relation'], 'role': m['role'], 'user_id': m['user_id'], 'email': email,
            'photo': m.get('photo')}


def _photo(v):
    """A small inline image only: no remote URLs (they'd leak who views the page), at most ~64 KB."""
    if not v:
        return None
    if not isinstance(v, str) or len(v) > 90_000 or not re.fullmatch(r'data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+', v):
        raise ApiError(400, 'photo must be a data:image/jpeg|png|webp;base64 URL under 64 KB')
    return v


def on_app(db, email):
    return bool(email) and bool(db.one('SELECT id FROM users WHERE email = :e', e=email.lower()))


def contact_view(db, c):
    return {'id': c['id'], 'name': c['name'], 'email': c['email'], 'phone': c['phone'], 'on_app': on_app(db, c['email']), 'photo': c.get('photo')}


def invite_view(req, inv):
    token = auth.link_token(req.db, 'invite', inv['id'])
    return {'id': inv['id'], 'email': inv['email'], 'role': inv['role'], 'member_id': inv['member_id'], 'expires_at': inv['expires_at'],
            'link': f'{auth.base_url(req)}/join?t={token}'}


def _member(req, mid):
    m = req.hh.one('SELECT * FROM members WHERE id = :id AND household_id = :hid AND removed_at IS NULL', id=valid.ident(mid, 'member'))
    if not m:
        raise ApiError(404, 'member not found')
    return m


def _contact(req, cid):
    c = req.hh.one('SELECT * FROM contacts WHERE id = :id AND household_id = :hid AND removed_at IS NULL', id=valid.ident(cid, 'contact'))
    if not c:
        raise ApiError(404, 'contact not found')
    return c


def person_of(req, p):
    """Validate {kind: member|contact, id} against the current household; returns (member_id, contact_id)."""
    if not isinstance(p, dict):
        raise ApiError(400, 'person must be {kind, id}')
    kind = valid.choice(p.get('kind'), {'member', 'contact'}, 'person.kind')
    return (_member(req, p.get('id'))['id'], None) if kind == 'member' else (None, _contact(req, p.get('id'))['id'])


# ---------- household ----------

@route('GET', '/api/households/current')
def current(req):
    db, admin = req.db, req.member['role'] in ('owner', 'admin')
    h = db.one('SELECT * FROM households WHERE id = :id', id=req.hh.hid)
    out = {'household': auth.household_view(h),
           'members': [member_view(db, m) for m in req.hh.run('SELECT * FROM members WHERE household_id = :hid AND removed_at IS NULL ORDER BY created_at, id')],
           'contacts': [contact_view(db, c) for c in req.hh.run('SELECT * FROM contacts WHERE household_id = :hid AND removed_at IS NULL ORDER BY name')],
           'invites': [invite_view(req, i) for i in req.hh.run('SELECT * FROM invites WHERE household_id = :hid AND accepted_at IS NULL AND expires_at > :t ORDER BY expires_at', t=now())]
           if admin else []}
    if admin and not emailer.configured():
        out['resets'] = auth.pending_resets(db, req.hh.hid)  # no mail: the owner passes the link on
    return out


@route('PATCH', '/api/households/current', auth='admin')
def patch_household(req):
    b, cols = req.json, {}
    if 'name' in b:
        cols['name'] = valid.text(b['name'], 'name')
    for k in ('base_currency', 'home_currency'):
        if k in b:
            cols[k] = valid.currency(b[k], k)
    if 'timezone' in b:
        try:
            ZoneInfo(b['timezone'] if isinstance(b['timezone'], str) and len(b['timezone']) < 60 else '')
        except (ZoneInfoNotFoundError, ValueError):
            raise ApiError(400, 'timezone must be like Asia/Riyadh')
        cols['timezone'] = b['timezone']
    if cols:
        req.db.run(f'UPDATE households SET {", ".join(f"{k} = :{k}" for k in cols)} WHERE id = :id', id=req.hh.hid, **cols)
    return auth.household_view(req.db.one('SELECT * FROM households WHERE id = :id', id=req.hh.hid))


@route('POST', '/api/households', auth='user')
def new_household(req):
    with req.db.tx():
        h = auth.create_household(req.db, req.user, valid.text(req.json.get('name'), 'name'))
    return 201, auth.household_view(h)


@route('POST', '/api/households/switch', auth='user')
def switch(req):
    hid = req.json.get('household_id')
    if not any(m['household_id'] == hid for m in auth.memberships(req.db, req.user['id'])):
        raise ApiError(404, 'household not found')
    req.set_cookie('hh', hid, auth.SESSION_DAYS * 86400)
    req.cookies['hh'] = hid
    return auth.me(req)


# ---------- members and invites ----------

def _invite(req, email, role, member_id=None):
    inv = req.hh.insert('invites', email=email, role=role, member_id=member_id, token_hash='', created_by=req.user['id'],
                        expires_at=(datetime.now(timezone.utc) + timedelta(days=auth.INVITE_DAYS)).isoformat(timespec='seconds'))
    req.hh.update('invites', inv['id'], token_hash=auth.sha(auth.link_token(req.db, 'invite', inv['id'])))
    return _send_invite(req, inv)


def _send_invite(req, inv):
    view = invite_view(req, inv)
    h = req.db.one('SELECT name FROM households WHERE id = :id', id=req.hh.hid)
    emailer.send(inv['email'], f"Join {h['name']}", f"{req.user['name']} invited you to share money with {h['name']}.\n{view['link']}")
    return view


@route('POST', '/api/members', auth='admin')
def add_member(req):
    b = req.json
    name, relation = valid.text(b.get('display_name'), 'display_name'), valid.choice(b.get('relation'), RELATIONS, 'relation', 'other')
    role = valid.choice(b.get('role'), ROLES, 'role', 'member')
    email = auth._email(b['email']) if b.get('email') else None
    m = req.hh.insert('members', display_name=name, relation=relation, role=role, user_id=None, created_at=now())
    out = member_view(req.db, req.hh.get('members', m['id']))
    if email:
        out['invite'] = _invite(req, email, role, m['id'])
        out['email'] = email
    return 201, out


@route('PATCH', '/api/members/{id}', auth='admin')
def patch_member(req):
    m, b, cols = _member(req, req.params['id']), req.json, {}
    if 'display_name' in b:
        cols['display_name'] = valid.text(b['display_name'], 'display_name')
    if 'relation' in b:
        cols['relation'] = valid.choice(b['relation'], RELATIONS, 'relation')
    if 'role' in b:
        if m['role'] == 'owner':
            raise ApiError(403, "the owner's role can't change")
        cols['role'] = valid.choice(b['role'], ROLES, 'role')
    if 'photo' in b:
        cols['photo'] = _photo(b['photo'])
    req.hh.update('members', m['id'], **cols)
    out = member_view(req.db, req.hh.get('members', m['id']))
    if b.get('email') and not m['user_id']:
        out['invite'] = _invite(req, auth._email(b['email']), cols.get('role', m['role']), m['id'])
    return out


@route('DELETE', '/api/members/{id}', auth='admin')
def remove_member(req):
    m = _member(req, req.params['id'])
    if m['role'] == 'owner':
        raise ApiError(403, "the household's owner can't be removed")
    req.hh.update('members', m['id'], removed_at=now())
    req.hh.run('UPDATE devices SET revoked_at = :t WHERE household_id = :hid AND member_id = :m AND revoked_at IS NULL', t=now(), m=m['id'])
    req.hh.run('DELETE FROM mcp_keys WHERE household_id = :hid AND user_id = :u', u=m['user_id'] or '')
    return {'id': m['id'], 'deleted': True}


def _open_invite(req):
    inv = req.hh.one('SELECT * FROM invites WHERE id = :id AND household_id = :hid AND accepted_at IS NULL', id=valid.ident(req.params['id'], 'invite'))
    if not inv:
        raise ApiError(404, 'invite not found')
    return inv


@route('POST', '/api/invites/{id}/resend', auth='admin')
def resend_invite(req):
    inv = _open_invite(req)
    exp = (datetime.now(timezone.utc) + timedelta(days=auth.INVITE_DAYS)).isoformat(timespec='seconds')
    req.hh.update('invites', inv['id'], expires_at=exp)
    return _send_invite(req, {**inv, 'expires_at': exp})


@route('DELETE', '/api/invites/{id}', auth='admin')
def delete_invite(req):
    inv = _open_invite(req)
    req.hh.run('DELETE FROM invites WHERE id = :id AND household_id = :hid', id=inv['id'])
    return {'id': inv['id'], 'deleted': True}


@route('GET', '/api/invites/{token}/preview', auth='public')
def preview_invite(req):
    inv = auth.invite_by_token(req.db, req.params['token'])
    if not inv:
        raise ApiError(404, 'this invite link has expired or was already used')
    h = req.db.one('SELECT name FROM households WHERE id = :id', id=inv['household_id'])
    u = req.db.one('SELECT name FROM users WHERE id = :id', id=inv['created_by'])
    return {'household_name': h['name'], 'invited_by': u['name'] if u else '', 'email': inv['email']}


# ---------- contacts ----------

def _contact_fields(b, partial=False):
    cols = {}
    if 'name' in b or not partial:
        cols['name'] = valid.text(b.get('name'), 'name')
    if 'email' in b:
        cols['email'] = auth._email(b['email']) if b['email'] else ''
    if 'phone' in b:
        cols['phone'] = valid.text(b['phone'], 'phone', 30, required=False)
    if 'photo' in b:
        cols['photo'] = _photo(b['photo'])
    return cols


@route('POST', '/api/contacts')
def add_contact(req):
    cols = {'email': '', 'phone': '', **_contact_fields(req.json)}
    c = req.hh.insert('contacts', created_at=now(), **cols)
    return 201, contact_view(req.db, req.hh.get('contacts', c['id']))


@route('PATCH', '/api/contacts/{id}')
def patch_contact(req):
    c = _contact(req, req.params['id'])
    req.hh.update('contacts', c['id'], **_contact_fields(req.json, partial=True))
    return contact_view(req.db, req.hh.get('contacts', c['id']))


@route('DELETE', '/api/contacts/{id}')
def delete_contact(req):
    c = _contact(req, req.params['id'])
    req.hh.update('contacts', c['id'], removed_at=now())
    return {'id': c['id'], 'deleted': True}


@route('POST', '/api/contacts/{id}/invite')
def invite_contact(req):
    """Email a contact a sign-up link. They get their own household; what they share with this one shows under Shared
    once they sign up or sign in through this link (its token links the contact to their account; an email address
    alone proves nothing), so it never opens this household's books to them."""
    c = _contact(req, req.params['id'])
    if not c['email']:
        raise ApiError(400, 'add their email first')
    token = auth.contact_token(req.db, c['id'])
    link = f"{auth.base_url(req)}/signup?invite={token}"
    sent = emailer.send(c['email'], f"{req.user['name']} shares money with you", f"{req.user['name']} added you to share costs on the app. "
                        f"Sign up through this link to see what you share:\n{link}\n\nAlready on the app? Sign in here instead:\n"
                        f"{auth.base_url(req)}/signin?invite={token}")
    return {'email': c['email'], 'link': link, 'sent': sent}


# ---------- people and what they owe ----------

def settle_key(kind, pid, cur):
    return f'settled.{kind}.{pid}.{cur}'


def after_settle(cutoff, day, created_at, tz=None):
    """Whether a movement counts after the last settle-up (`cutoff`, when it was done, UTC): by the transaction's day
    (in the household's timezone), so an old loan imported later stays settled; on the settle-up day itself, only what
    was recorded after it."""
    if not cutoff:
        return True
    try:
        local = datetime.fromisoformat(cutoff).astimezone(ZoneInfo(tz or 'Asia/Riyadh')).date().isoformat()
    except (ValueError, ZoneInfoNotFoundError):
        local = cutoff[:10]
    return day > local or (day == local and (created_at or '') > cutoff)


def _tz(hh):
    return (hh.db.one('SELECT timezone FROM households WHERE id = :id', id=hh.hid) or {}).get('timezone')


def balances(hh):
    """{(kind, id): {currency: net minor}}: + they owe the household, - it owes them. Unsettled splits of the household's
    payments, lend/repaid/borrow/repay movements and shared costs (plan.shared_costs: asset sharers, commitment sharers)
    after the last settle-up with that person, spending on a card they used (plan.borrowed), and rent pots."""
    from api import plan
    out, tz = defaultdict(lambda: defaultdict(int)), _tz(hh)
    for s in hh.run('SELECT s.member_id, s.contact_id, s.share_minor, t.currency, t.direction FROM splits s JOIN transactions t ON t.id = s.txn_id '
                    'WHERE s.household_id = :hid AND t.household_id = :hid AND s.settled_at IS NULL AND t.deleted_at IS NULL'):
        key = ('member', s['member_id']) if s['member_id'] else ('contact', s['contact_id'])
        out[key][s['currency']] += s['share_minor'] if s['direction'] == 'debit' else -s['share_minor']
    cutoffs = {r['key']: r['value'] for r in hh.run("SELECT key, value FROM settings WHERE household_id = :hid AND key LIKE 'settled.%'")}
    for r in hh.run("SELECT m.purpose, m.person_member_id, m.person_contact_id, t.amount_minor, t.currency, t.day, t.created_at FROM txn_meta m "
                    "JOIN transactions t ON t.id = m.txn_id WHERE m.household_id = :hid AND t.household_id = :hid AND t.deleted_at IS NULL "
                    "AND m.purpose IN ('lend', 'repaid', 'borrow', 'repay')"):
        key = ('member', r['person_member_id']) if r['person_member_id'] else ('contact', r['person_contact_id']) if r['person_contact_id'] else None
        if key and after_settle(cutoffs.get(settle_key(*key, r['currency'])), r['day'], r['created_at'], tz):
            out[key][r['currency']] += PERSON_SIGN[r['purpose']] * r['amount_minor']
    for r in plan.borrowed(hh).values():
        key = ('member', r['member_id']) if r['member_id'] else ('contact', r['contact_id'])
        if r['purpose'] == 'lend' and after_settle(cutoffs.get(settle_key(*key, r['currency'])), r['day'], r['txn_created_at'], tz):
            out[key][r['currency']] += r['amount_minor']
    for c in plan.shared_costs(hh):
        if after_settle(cutoffs.get(settle_key(*c['key'], c['currency'])), c['day'], c['created_at'], tz):
            out[c['key']][c['currency']] += c['minor']
    for p in _pots(hh):  # a co-owner's part of what a shared pot overspent (the household paid it)
        for s in p['shares']:
            out[('member', s['member_id']) if s['member_id'] else ('contact', s['contact_id'])][p['fund']['currency']] += p['owes'][s['member_id'] or s['contact_id']]
    return out


def _pots(hh):
    from api import insights, plan
    h = hh.db.one('SELECT timezone FROM households WHERE id = :id', id=hh.hid) or {}
    return plan.pots(hh, insights.today_in(h.get('timezone')))


def _monthly(rows):
    """One Money from {currency: minor}: the biggest currency (a person is supported in one currency in practice)."""
    rows = {c: m for c, m in rows.items() if m}
    if not rows:
        return None
    cur = max(rows, key=rows.get)
    return valid.money(rows[cur], cur)


def people(hh, db):
    bal, month = balances(hh), now()[:7]
    rent_due = defaultdict(lambda: defaultdict(int))  # tenant -> rent still owed for past months
    for p in _pots(hh):
        rent_due[p['fund']['tenant_contact_id']][p['fund']['currency']] += len(p['calc']['missing']) * p['fund']['rent_minor']
    support, plan = defaultdict(lambda: defaultdict(int)), defaultdict(lambda: defaultdict(int))
    for r in hh.run("SELECT m.person_member_id AS p, t.amount_minor, t.currency FROM txn_meta m JOIN transactions t ON t.id = m.txn_id "
                    "WHERE m.household_id = :hid AND t.household_id = :hid AND m.purpose = 'support' AND t.deleted_at IS NULL "
                    "AND t.day >= :a AND t.day <= :b AND t.direction = 'debit'", a=month + '-01', b=month + '-31'):
        if r['p']:
            support[r['p']][r['currency']] += r['amount_minor']
    for c in hh.run("SELECT for_member_id, amount_minor, currency, cycle_months FROM commitments WHERE household_id = :hid AND kind = 'support' "
                    "AND ended_at IS NULL AND cycle_months > 0"):
        if c['for_member_id']:
            plan[c['for_member_id']][c['currency']] += c['amount_minor'] // c['cycle_months']

    def owe(key, sign):
        return [valid.money(sign * v, c) for c, v in sorted(bal[key].items()) if sign * v > 0]
    items = []
    for m in hh.run('SELECT * FROM members WHERE household_id = :hid AND removed_at IS NULL ORDER BY created_at, id'):
        k = ('member', m['id'])
        items.append({'kind': 'member', 'id': m['id'], 'name': m['display_name'], 'relation': m['relation'], 'role': m['role'],
                      'on_app': bool(m['user_id']), 'owes_you': owe(k, 1), 'you_owe': owe(k, -1),
                      'support_month': _monthly(support[m['id']]), 'support_plan': _monthly(plan[m['id']]), 'photo': m.get('photo')})
    for c in hh.run('SELECT * FROM contacts WHERE household_id = :hid AND removed_at IS NULL ORDER BY name'):
        k = ('contact', c['id'])
        items.append({'kind': 'contact', 'id': c['id'], 'name': c['name'], 'relation': 'other', 'role': None, 'on_app': on_app(db, c['email']),
                      'owes_you': owe(k, 1), 'you_owe': owe(k, -1), 'support_month': None, 'support_plan': None,
                      'rent_due': _monthly(rent_due[c['id']]), 'photo': c.get('photo')})
    return items


@route('GET', '/api/people')
def get_people(req):
    return {'items': people(req.hh, req.db)}


# ---------- phones ----------

def device_view(d):
    return {k: d[k] for k in ('id', 'name', 'platform', 'member_id', 'created_at', 'last_seen')}


@route('GET', '/api/shared', auth='user')
def shared_with_me(req):
    """What other households recorded with me as their contact (linked through their contact invite link, never by an
    email nobody verified): the balance and the unsettled split lines, from my side. Read-only; each side settles in its own household."""
    items = []
    for c in req.db.run('SELECT c.id, c.household_id, h.name FROM contacts c JOIN households h ON h.id = c.household_id '
                        'WHERE c.linked_user_id = :u AND c.removed_at IS NULL', u=req.user['id']):
        hh = Scoped(req.db, c['household_id'])
        bal = balances(hh)[('contact', c['id'])]
        lines = hh.run('SELECT t.day, t.merchant, t.merchant_raw, t.direction, t.currency, s.share_minor FROM splits s JOIN transactions t ON t.id = s.txn_id '
                       'WHERE s.household_id = :hid AND t.household_id = :hid AND s.contact_id = :c AND s.settled_at IS NULL AND t.deleted_at IS NULL '
                       'ORDER BY t.day DESC', c=c['id'])
        from api import plan
        cut = {r['key']: r['value'] for r in hh.run("SELECT key, value FROM settings WHERE household_id = :hid AND key LIKE 'settled.contact.%'")}
        costs = [x for x in plan.shared_costs(hh) if x['key'] == ('contact', c['id'])
                 and after_settle(cut.get(settle_key('contact', c['id'], x['currency'])), x['day'], x['created_at'], _tz(hh))]
        items.append({'household': c['name'], 'you_owe': [valid.money(v, k) for k, v in sorted(bal.items()) if v > 0],
                      'owed_to_you': [valid.money(-v, k) for k, v in sorted(bal.items()) if v < 0],
                      'lines': [{'day': r['day'], 'what': r['merchant'] or r['merchant_raw'],
                                 'your_share': valid.money(r['share_minor'] if r['direction'] == 'debit' else -r['share_minor'], r['currency'])}
                                for r in lines] + [{'day': x['day'], 'what': x['what'], 'your_share': valid.money(x['minor'], x['currency'])}
                                                   for x in sorted(costs, key=lambda x: x['day'], reverse=True)]})
    return {'items': items}


def shortcut_url():
    """The iOS Shortcut to install: SHORTCUT_URL (e.g. an iCloud link), else the signed file in web/public when it was built in."""
    return os.environ.get('SHORTCUT_URL', '') or ('/ledger-sms.shortcut' if (DIST / 'ledger-sms.shortcut').is_file() else '')


@route('GET', '/api/devices')
def list_devices(req):
    return {'items': [device_view(d) for d in req.hh.run('SELECT * FROM devices WHERE household_id = :hid AND revoked_at IS NULL ORDER BY created_at')],
            'shortcut_url': shortcut_url()}


@route('POST', '/api/devices')
def add_device(req):
    b = req.json
    name, platform = valid.text(b.get('name'), 'name'), valid.choice(b.get('platform'), PLATFORMS, 'platform', 'other')
    key = secrets.token_urlsafe(32)
    d = req.hh.insert('devices', user_id=req.user['id'], member_id=req.member['id'], name=name, platform=platform,
                      key_hash=auth.sha(key), created_at=now(), last_seen='')
    url = auth.base_url(req) + '/api/ingest/sms/batch'  # phones post {messages: [...]} here with the key
    return 201, {'device': device_view(req.hh.get('devices', d['id'])), 'key': key, 'sms_url': url,
                 'setup': json.dumps({'url': url, 'key': key}), 'shortcut_url': shortcut_url()}


@route('DELETE', '/api/devices/{id}')
def revoke_device(req):
    d = req.hh.one('SELECT * FROM devices WHERE id = :id AND household_id = :hid AND revoked_at IS NULL', id=valid.ident(req.params['id'], 'device'))
    if not d:
        raise ApiError(404, 'device not found')
    if d['user_id'] != req.user['id'] and req.member['role'] not in ('owner', 'admin'):
        raise ApiError(403, "only its owner or an admin can remove this phone")
    req.hh.update('devices', d['id'], revoked_at=now())
    return {'id': d['id'], 'deleted': True}
