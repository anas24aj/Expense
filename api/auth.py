"""Accounts, sessions, password reset, device keys and personal MCP keys (docs/brain/api-v3.md, "Auth & account").

Session cookie `session` = '<user id>.<expiry>.<hmac>'. The HMAC signs the tail of the user's password hash, so a
password change or reset ends every other session. The signing key is made on first use and kept in app_secrets.
Tokens that a link carries (reset, invite, MCP) are '<row id>.<hmac of the id>': only their sha256 is stored, yet the
server can show the link again (to the owner when no mail is set up) without keeping the token itself."""
import hashlib
import hmac
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

from api import emailer, valid
from api.app import ApiError, route
from api.db import DB, new_id, now
from server import hash_password, password_matches  # PBKDF2, shared with v2 so old hashes keep working

SESSION_DAYS = 365
MAX_FAILURES, LOCKOUT_SECONDS = 10, 15 * 60
RESET_MINUTES = 30
INVITE_DAYS = 14
MIN_PASSWORD = 8
EMAIL = re.compile(r'[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}\Z')
USERNAME = re.compile(r'[a-z0-9][a-z0-9._-]{2,29}\Z')
_secret = {}  # database url -> signing key


def secret(db):
    if db.url not in _secret:
        db.run("INSERT INTO app_secrets (name, value) VALUES ('signing', :v) ON CONFLICT (name) DO NOTHING", v=secrets.token_hex(32))
        _secret[db.url] = db.one("SELECT value FROM app_secrets WHERE name = 'signing'")['value']  # the first writer wins
    return _secret[db.url]


def _mac(db, what):
    return hmac.new(secret(db).encode(), what.encode(), hashlib.sha256).hexdigest()


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def link_token(db, kind, rid):
    """The token a reset/invite/MCP link carries for row `rid`; store sha(token)."""
    return f'{rid}.{_mac(db, kind + ":" + rid)[:32]}'


def base_url(req):
    return (os.environ.get('PUBLIC_URL') or f"https://{req.environ.get('HTTP_HOST') or 'localhost'}").rstrip('/')


def _ip(req):
    # Vercel overwrites X-Forwarded-For with the real client address.
    return (req.environ.get('HTTP_X_FORWARDED_FOR') or req.environ.get('REMOTE_ADDR') or '?').split(',')[0].strip()


# ---------- sessions ----------

def _session_value(db, user):
    expires = int(time.time()) + SESSION_DAYS * 86400
    return f"{user['id']}.{expires}.{_mac(db, 'session:' + user['id'] + ':' + str(expires) + ':' + user['pw_hash'][-24:])}"


def _sign_in(req, user, household_id=None):
    req.set_cookie('session', _session_value(req.db, user), SESSION_DAYS * 86400)
    if household_id:
        req.set_cookie('hh', household_id, SESSION_DAYS * 86400)
    req.db.run('UPDATE users SET last_seen = :t WHERE id = :id', t=now(), id=user['id'])
    req.user = user


def current_user(req):
    parts = req.cookies.get('session', '').split('.')
    if len(parts) != 3 or not valid.ID.match(parts[0]) or not parts[1].isdigit() or int(parts[1]) < time.time():
        return None
    user = req.db.one('SELECT * FROM users WHERE id = :id', id=parts[0])
    good = user and hmac.compare_digest(parts[2], _mac(req.db, f"session:{user['id']}:{parts[1]}:{user['pw_hash'][-24:]}"))
    return user if good else None


def memberships(db, user_id):
    return db.run('SELECT m.*, h.name AS household_name FROM members m JOIN households h ON h.id = m.household_id '
                  'WHERE m.user_id = :u AND m.removed_at IS NULL ORDER BY m.created_at, m.id', u=user_id)


def current_household(req, user):
    """(household_id, member row) for the `hh` cookie if the user belongs to it, else their first household."""
    rows = memberships(req.db, user['id'])
    want = req.cookies.get('hh', '')
    m = next((r for r in rows if r['household_id'] == want), rows[0] if rows else None)
    return (m['household_id'], m) if m else (None, None)


def device_from_bearer(req):
    header = req.header('Authorization')
    if not header.startswith('Bearer ') or len(header) > 200:
        return None
    d = req.db.one('SELECT * FROM devices WHERE key_hash = :h AND revoked_at IS NULL', h=sha(header[7:].strip()))
    if d:
        req.db.run('UPDATE devices SET last_seen = :t WHERE id = :id', t=now(), id=d['id'])
    return d


def mcp_user(key, db=None):
    """For api/mcp.py: {'user', 'household_id', 'member'} for a personal MCP key, or None."""
    own = db is None
    db = db or DB()
    try:
        if not isinstance(key, str) or len(key) > 100:
            return None
        k = db.one('SELECT * FROM mcp_keys WHERE key_hash = :h', h=sha(key.strip()))
        member = k and db.one('SELECT * FROM members WHERE household_id = :h AND user_id = :u AND removed_at IS NULL',
                              h=k['household_id'], u=k['user_id'])
        if not member:
            return None
        db.run('UPDATE mcp_keys SET last_used = :t WHERE id = :id', t=now(), id=k['id'])
        return {'user': public_user(db.one('SELECT * FROM users WHERE id = :id', id=k['user_id'])),
                'household_id': k['household_id'], 'member': member}
    finally:
        if own:
            db.close()


# ---------- shapes ----------

def public_user(u):
    return {'id': u['id'], 'email': u['email'], 'username': u['username'], 'name': u['name']}


def household_view(h):
    return {k: h[k] for k in ('id', 'name', 'base_currency', 'home_currency', 'timezone')}


def me(req):
    user = req.user
    hid, member = current_household(req, user)
    h = hid and req.db.one('SELECT * FROM households WHERE id = :id', id=hid)
    return {'user': public_user(user), 'household': household_view(h) if h else None,
            'member': {k: member[k] for k in ('id', 'display_name', 'role', 'relation')} if member else None,
            'households': [{'id': m['household_id'], 'name': m['household_name'], 'role': m['role']} for m in memberships(req.db, user['id'])]}


# ---------- households and invites (used by households.py too) ----------

def create_household(db, user, name):
    h = {'id': new_id(), 'name': name, 'created_at': now()}
    db.run('INSERT INTO households (id, name, created_at) VALUES (:id, :name, :created_at)', **h)
    db.run("INSERT INTO members (id, household_id, user_id, display_name, relation, role, created_at) "
           "VALUES (:id, :h, :u, :n, 'self', 'owner', :t)", id=new_id(), h=h['id'], u=user['id'], n=user['name'] or user['email'].split('@')[0], t=now())
    return db.one('SELECT * FROM households WHERE id = :id', id=h['id'])


def invite_by_token(db, token):
    if not isinstance(token, str) or len(token) > 100:
        return None
    inv = db.one('SELECT * FROM invites WHERE token_hash = :h AND accepted_at IS NULL', h=sha(token))
    return inv if inv and inv['expires_at'] > now() else None


def _join(db, user, token):
    """Accept an invite for `user`: they become its member (the login-less member it was made for, if any)."""
    inv = invite_by_token(db, token)
    if not inv:
        raise ApiError(404, 'this invite link has expired or was already used')
    hid = inv['household_id']
    if db.one('SELECT id FROM members WHERE household_id = :h AND user_id = :u AND removed_at IS NULL', h=hid, u=user['id']):
        pass
    elif inv['member_id'] and db.one('SELECT id FROM members WHERE id = :m AND household_id = :h AND user_id IS NULL AND removed_at IS NULL', m=inv['member_id'], h=hid):
        db.run('UPDATE members SET user_id = :u WHERE id = :m', u=user['id'], m=inv['member_id'])
    else:
        db.run('DELETE FROM members WHERE household_id = :h AND user_id = :u', h=hid, u=user['id'])  # a removed membership comes back fresh
        db.run('INSERT INTO members (id, household_id, user_id, display_name, relation, role, created_at) VALUES (:id, :h, :u, :n, :r, :role, :t)',
               id=new_id(), h=hid, u=user['id'], n=user['name'] or user['email'].split('@')[0], r='other', role=inv['role'], t=now())
    db.run('UPDATE invites SET accepted_at = :t WHERE id = :id', t=now(), id=inv['id'])
    return hid


# ---------- routes ----------

def _password(v, field='password'):
    if not isinstance(v, str) or len(v) < MIN_PASSWORD or len(v) > 200:
        raise ApiError(400, f'{field} needs {MIN_PASSWORD} to 200 characters')
    return v


def _email(v):
    v = v.strip().lower() if isinstance(v, str) else ''
    if not EMAIL.match(v):
        raise ApiError(400, 'enter a valid email')
    return v


@route('POST', '/api/auth/signup', auth='public')
def signup(req):
    b = req.json
    email, password, name = _email(b.get('email')), _password(b.get('password')), valid.text(b.get('name'), 'name')
    invite = b.get('invite')
    db = req.db
    with db.tx():
        if db.one('SELECT id FROM users WHERE email = :e', e=email):
            raise ApiError(409, 'that email already has an account: sign in instead')
        user = {'id': new_id(), 'email': email, 'name': name, 'pw_hash': hash_password(password), 'created_at': now()}
        db.run('INSERT INTO users (id, email, name, pw_hash, created_at) VALUES (:id, :email, :name, :pw_hash, :created_at)', **user)
        user = db.one('SELECT * FROM users WHERE id = :id', id=user['id'])
        hid = _join(db, user, invite) if invite else create_household(db, user, f"{name}'s family")['id']
    _sign_in(req, user, hid)
    return 201, {'user': public_user(user), 'household': household_view(db.one('SELECT * FROM households WHERE id = :id', id=hid))}


@route('POST', '/api/auth/login', auth='public')
def login(req):
    b, db, ip, t = req.json, req.db, _ip(req), int(time.time())
    if db.one('SELECT COUNT(*) AS n FROM login_failures WHERE ip = :ip AND at > :since', ip=ip, since=t - LOCKOUT_SECONDS)['n'] >= MAX_FAILURES:
        raise ApiError(429, 'too many wrong tries: wait 15 minutes')
    who = b.get('login') if isinstance(b.get('login'), str) else ''
    who, password = who.strip().lower()[:254], b.get('password') if isinstance(b.get('password'), str) else ''
    user = who and db.one('SELECT * FROM users WHERE email = :w OR username = :w', w=who)
    if not user or not password_matches(password[:200], user['pw_hash']):
        db.run('DELETE FROM login_failures WHERE at <= :since', since=t - LOCKOUT_SECONDS)
        db.run('INSERT INTO login_failures (ip, at) VALUES (:ip, :at)', ip=ip, at=t)
        raise ApiError(401, 'wrong email or password')
    hid = _join(db, user, b['invite']) if b.get('invite') else None
    _sign_in(req, user, hid)
    return {'user': public_user(user)}


@route('POST', '/api/auth/logout', auth='public')
def logout(req):
    req.set_cookie('session', '', 0)
    req.set_cookie('hh', '', 0)
    return {'ok': True}


@route('GET', '/api/auth/me', auth='user')
def get_me(req):
    return me(req)


@route('PATCH', '/api/auth/me', auth='user')
def patch_me(req):
    b, u = req.json, req.user
    if 'name' in b:
        req.db.run('UPDATE users SET name = :n WHERE id = :id', n=valid.text(b['name'], 'name'), id=u['id'])
    if 'username' in b:
        name = (b['username'] or '').strip().lower() if isinstance(b['username'], str) or b['username'] is None else None
        if name is None or name and not USERNAME.match(name):
            raise ApiError(400, 'username: 3 to 30 letters, digits, dot, dash or underscore')
        if name and req.db.one('SELECT id FROM users WHERE username = :n AND id != :id', n=name, id=u['id']):
            raise ApiError(409, 'that username is taken')
        req.db.run('UPDATE users SET username = :n WHERE id = :id', n=name or None, id=u['id'])
    return public_user(req.db.one('SELECT * FROM users WHERE id = :id', id=u['id']))


@route('POST', '/api/auth/password', auth='user')
def change_password(req):
    b = req.json
    if not isinstance(b.get('current'), str) or not password_matches(b['current'][:200], req.user['pw_hash']):
        raise ApiError(403, 'the current password is wrong')
    h = hash_password(_password(b.get('new'), 'new password'))
    req.db.run('UPDATE users SET pw_hash = :h WHERE id = :id', h=h, id=req.user['id'])
    _sign_in(req, req.db.one('SELECT * FROM users WHERE id = :id', id=req.user['id']))  # this session stays, the others end
    return {'ok': True}


@route('POST', '/api/auth/forgot', auth='public')
def forgot(req):
    email = req.json.get('email')
    user = isinstance(email, str) and req.db.one('SELECT * FROM users WHERE email = :e', e=email.strip().lower()[:254])
    if user:
        rid = new_id()
        token = link_token(req.db, 'reset', rid)
        req.db.run('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (:id, :u, :h, :e)', id=rid, u=user['id'], h=sha(token),
                   e=(datetime.now(timezone.utc) + timedelta(minutes=RESET_MINUTES)).isoformat(timespec='seconds'))
        emailer.send(user['email'], 'Reset your password',
                     f'Open this link within {RESET_MINUTES} minutes to choose a new password:\n{base_url(req)}/reset?t={token}\n\n'
                     'If you did not ask for this, ignore this email.')
    return {'ok': True}  # the same answer either way: it never tells whether an email has an account


def pending_resets(db, household_id):
    """Open reset links of a household's members, for its owner when no mail is set up (households.py)."""
    rows = db.run('SELECT r.id, r.expires_at, m.id AS member_id, m.display_name, u.email FROM password_resets r '
                  'JOIN members m ON m.user_id = r.user_id JOIN users u ON u.id = r.user_id '
                  'WHERE m.household_id = :h AND m.removed_at IS NULL AND r.used_at IS NULL AND r.expires_at > :t ORDER BY r.expires_at DESC',
                  h=household_id, t=now())
    return [{'member_id': r['member_id'], 'name': r['display_name'], 'email': r['email'], 'expires_at': r['expires_at'],
             'link': f"/reset?t={link_token(db, 'reset', r['id'])}"} for r in rows]


@route('POST', '/api/auth/reset', auth='public')
def reset(req):
    b, db = req.json, req.db
    token = b.get('token') if isinstance(b.get('token'), str) else ''
    password = _password(b.get('password'))
    r = token and len(token) < 100 and db.one('SELECT * FROM password_resets WHERE token_hash = :h', h=sha(token))
    if not r or r['used_at'] or r['expires_at'] <= now():
        raise ApiError(400, 'this reset link has expired or was already used: ask for a new one')
    with db.tx():
        db.run('UPDATE password_resets SET used_at = :t WHERE user_id = :u AND used_at IS NULL', t=now(), u=r['user_id'])
        db.run('UPDATE users SET pw_hash = :h WHERE id = :id', h=hash_password(password), id=r['user_id'])
    user = db.one('SELECT * FROM users WHERE id = :id', id=r['user_id'])
    _sign_in(req, user)
    return {'user': public_user(user)}


# ---------- personal MCP key ----------

def _mcp_url(req, kid):
    return f"{base_url(req)}/mcp/{link_token(req.db, 'mcp', kid)}"


@route('GET', '/api/mcp-key')
def get_mcp_key(req):
    k = req.hh.one('SELECT id FROM mcp_keys WHERE household_id = :hid AND user_id = :u', u=req.user['id'])
    return {'url': _mcp_url(req, k['id'])} if k else new_mcp_key(req)


@route('POST', '/api/mcp-key')
def new_mcp_key(req):
    """Make (or rotate) this user's key for the current household; the old link stops working."""
    req.hh.run('DELETE FROM mcp_keys WHERE household_id = :hid AND user_id = :u', u=req.user['id'])
    kid = new_id()
    req.hh.insert('mcp_keys', id=kid, user_id=req.user['id'], key_hash=sha(link_token(req.db, 'mcp', kid)), created_at=now())
    return {'url': _mcp_url(req, kid)}
