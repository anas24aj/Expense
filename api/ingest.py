"""SMS and statements in (docs/brain/api-v3.md, "Ingestion"). Per message: keep it in raw_messages (deduped by hash,
with its outcome for /ingest/log) → parse.py → the account it names (made on first sight, so nobody types accounts)
→ dedupe → classify.reclassify."""
import base64
import binascii
import hashlib
import re
from datetime import datetime, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import server  # v2 SMS knowledge: SECRET, AD_SENDER, account-kind words, balance and card-reminder patterns
from api import classify, ledger, valid
from api.app import ApiError, route
from api.db import new_id, now
from parse import ARABIC_DIGITS, BRACKETED, CURRENCIES, account_of, merchant_of, parse
from statement import StatementError, read_statement, span

MAX_BODY = 2000
MAX_BATCH = 500
MAX_FILE = 4_400_000
STATEMENT_SMS_DAYS = 1  # a statement row and the SMS for it may be a day apart (posting vs. transaction date)


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _local_day(db, hid, at):
    tz = db.one('SELECT timezone FROM households WHERE id = :id', id=hid)['timezone']
    try:
        return at.astimezone(ZoneInfo(tz)).date().isoformat()
    except (ZoneInfoNotFoundError, ValueError):
        return at.date().isoformat()


def institution_of(sender):
    """'VM-HDFCBK' / 'JD-HDFCBK-S' → 'HDFCBK': Indian operator prefixes and suffixes change per SMS."""
    return re.sub(r'^[A-Za-z]{2}-|-[A-Za-z]$', '', sender.strip())[:40] or 'Bank'


def kind_of(sender, body):
    if server.BNPL.search(sender) or server.BNPL.search(body):
        return 'bnpl'
    if server.WALLETS.search(sender):
        return 'wallet'
    if server.CREDIT_CARD.search(body):
        return 'credit_card'
    if server.DEBIT_CARD.search(body):
        return 'debit_card'
    return 'bank'


def find_account(hh, institution, last4, kind, currency, member_id, create=True):
    """The household's account an SMS is about (last-4 digits, then the sender), made if it's new."""
    rows = hh.run('SELECT * FROM accounts WHERE household_id = :hid AND archived_at IS NULL AND last4 = :d ORDER BY created_at', d=last4)
    same = [a for a in rows if a['institution'].lower() == institution.lower()]
    hit = same[0] if same else rows[0] if last4 and len(rows) == 1 else None
    if hit or not create:
        return hit
    a = hh.insert('accounts', owner_member_id=member_id, kind=kind, institution=institution, currency=currency,
                  name=f'{institution} ••{last4}' if last4 else institution, country={'SAR': 'SA', 'INR': 'IN'}.get(currency, ''),
                  last4=last4, visibility='household', created_at=now())
    return hh.get('accounts', a['id'])


def stated_balance(body):
    """('balance' | 'limit', minor) an SMS states after the transaction, or None (server.balances for one message)."""
    from parse import ARABIC_DIGITS
    body = body.translate(ARABIC_DIGITS)
    for m in server.BALANCE.finditer(body):
        n = server.BAL_NUM.search(body[m.end():m.end() + 30])
        if n and not re.match(r'\s*(?:as\s+on|on)\b', body[m.end():m.end() + 8], re.I):
            return ('limit' if (m.group(1) or '').lower() in ('limit', 'lmt') else 'balance'), round(float(n.group(1).replace(',', '')) * 100)
    return None


def _set_balance(hh, a, minor, at):
    if at >= (a['last_balance_at'] or ''):
        hh.update('accounts', a['id'], last_balance_minor=minor, last_balance_at=at)


def _card_reminder(hh, sender, body, at, member_id):
    """A card's due reminder: what's owed and the due day go on the card account. True if it was one."""
    total = server.CARD_TOTAL.search(body) if re.search(r'\bcard\b', body, re.I) else None
    if not total:
        return False
    digits = server.CARD_DIGITS.search(body)
    cur = 'INR' if total.group(1).upper().startswith(('INR', 'RS', '₹')) else 'SAR'
    a = find_account(hh, institution_of(sender), digits.group(1) if digits else '', 'credit_card', cur, member_id)
    _set_balance(hh, a, -round(float(total.group(2).replace(',', '')) * 100), at)
    day = server.CARD_DUE_DAY.search(body)
    if day and 1 <= int(day.group(1)) <= 31:
        hh.update('accounts', a['id'], due_day=int(day.group(1)))
    return True


def _pay_later(hh, body, day):
    """A pay-later confirmation ('Split in 4 … Order: 400 SAR') becomes a 0% bnpl liability. True if it was one."""
    parts, total, store = server.PAY_LATER.search(body), server.PAY_LATER_TOTAL.search(body), server.PAY_LATER_STORE.search(body)
    n = parts and int(parts.group(1) or parts.group(2))
    if not (total and n and 2 <= n <= 24):
        return False
    cur, amount = (total.group(1), total.group(2)) if total.group(1) else (total.group(4), total.group(3))
    owed = round(float(amount.replace(',', '')) * 100)
    part = round(owed / n)
    name = f"Pay later · {' '.join(store.group(1).split()) if store else 'purchase'}"[:60]
    if not hh.one("SELECT id FROM liabilities WHERE household_id = :hid AND kind = 'bnpl' AND name = :n AND as_of = :d", n=name, d=day):
        hh.insert('liabilities', kind='bnpl', name=name, lender=store and ' '.join(store.group(1).split())[:60] or '',
                  currency='INR' if cur.upper().startswith(('INR', 'RS', '₹')) else 'SAR', principal_minor=owed,
                  opening_balance_minor=owed - part, as_of=day, emi_minor=part, due_day=min(28, int(day[8:])), start_on=day, created_at=now())
    return True


def ingest_sms(hh, sender, body, at, device_id=None, member_id=None):
    """Store one SMS. Returns (stored, reason, txn_id)."""
    db = hh.db
    h = _sha(sender.strip().lower() + '\n' + ' '.join(body.split()))
    if hh.one('SELECT id FROM raw_messages WHERE household_id = :hid AND hash = :h', h=h):
        return False, 'duplicate', None
    raw = {'id': new_id(), 'device_id': device_id, 'member_id': member_id, 'sender': sender, 'body': body,
           'received_at': at.isoformat(timespec='seconds'), 'hash': h, 'created_at': now()}
    when, day = raw['received_at'], _local_day(db, hh.hid, at)
    parsed = parse(body)
    if not parsed:
        outcome = ('skipped: security code' if server.SECRET.search(body) else 'skipped: advert' if server.AD_SENDER.search(sender) or server.AD.search(body)
                   else 'card statement' if _card_reminder(hh, sender, body, when, member_id)
                   else 'pay later plan' if _pay_later(hh, body, day) else 'not a transaction')
        if outcome == 'skipped: security code':
            raw['body'] = ''  # never keep a one-time code
        hh.insert('raw_messages', outcome=outcome, **raw)
        return False, outcome, None
    last4 = account_of(body)[-4:].lstrip('•')
    account = find_account(hh, institution_of(sender), last4, kind_of(sender, body), parsed['currency'], member_id)
    note, doubt = '', False
    if parsed['currency'] != account['currency']:  # 'USD 10.00 spent … (SAR 37.50)' on a SAR card: the statement bills SAR
        shown = f"{parsed['currency']} {parsed['amount_minor'] / 100:,.2f}"
        billed = next((m for m in BRACKETED.finditer(body.translate(ARABIC_DIGITS)) if CURRENCIES[m.group(1).lower().rstrip('.')] == account['currency']), None)
        if billed:
            parsed = {**parsed, 'currency': account['currency'], 'amount_minor': int(Decimal(billed.group(2).replace(',', '')) * 100)}
            note = f'Spent as {shown}'
        else:  # no billed amount: the statement row will come in another currency and not match this one
            note, doubt = f"{shown} on a {account['currency']} account: probably also on the statement in {account['currency']}", True
    lo, hi = (datetime.fromordinal(datetime.fromisoformat(day).toordinal() + k).date().isoformat() for k in (-STATEMENT_SMS_DAYS, STATEMENT_SMS_DAYS))
    in_statement = hh.one("SELECT id FROM transactions WHERE household_id = :hid AND account_id = :a AND source = 'statement' AND deleted_at IS NULL "
                          "AND amount_minor = :m AND direction = :d AND day >= :lo AND day <= :hi AND raw_message_id IS NULL",
                          a=account['id'], m=parsed['amount_minor'], d=parsed['direction'], lo=lo, hi=hi)
    if in_statement:
        hh.insert('raw_messages', outcome='already in a statement', **raw)
        hh.update('transactions', in_statement['id'], raw_message_id=raw['id'])
        return False, 'already in a statement', in_statement['id']
    hh.insert('raw_messages', outcome='stored', **raw)
    merchant = parsed['merchant'] or merchant_of(body)
    t = hh.insert('transactions', account_id=account['id'], member_id=member_id, occurred_at=when, day=day, amount_minor=parsed['amount_minor'],
                  currency=parsed['currency'], direction=parsed['direction'], merchant_raw=merchant, merchant=merchant[:80], source='sms',
                  raw_message_id=raw['id'], dedupe_key='sms.' + h, note=note, created_at=now())
    if (bal := stated_balance(body)) and account['currency'] == parsed['currency']:
        kind, minor = bal
        if kind == 'balance' and account['kind'] not in ('credit_card', 'bnpl'):
            _set_balance(hh, account, minor, when)
        elif kind == 'limit' and account['credit_limit_minor']:
            _set_balance(hh, account, minor - account['credit_limit_minor'], when)  # owed = limit - available
    classify.reclassify(hh, [t['id']])
    if doubt:  # a probable duplicate goes to Review
        hh.run('UPDATE txn_meta SET confidence = 0 WHERE txn_id = :t AND household_id = :hid', t=t['id'])
    return True, 'stored', t['id']


def _message(m):
    if not isinstance(m, dict):
        raise ApiError(400, 'each message must be {sender, body, received_at}')
    body = m.get('body')
    if not isinstance(body, str) or not body.strip() or len(body) > MAX_BODY:
        raise ApiError(400, f'body must be the SMS text (at most {MAX_BODY} characters)')
    at = valid.when(m['received_at']) if m.get('received_at') else datetime.now(timezone.utc)
    return valid.text(m.get('sender') or 'SMS', 'sender', 60), body.strip(), at  # an iOS Shortcut may not pass the sender


@route('POST', '/api/ingest/sms', auth='device')
def sms(req):
    sender, body, at = _message(req.json)
    with req.db.tx():
        stored, reason, tid = ingest_sms(req.hh, sender, body, at, req.device['id'], req.device['member_id'])
    if not stored:
        return {'stored': False, 'reason': reason}
    return 201, {'stored': True, 'transaction': ledger.txn_views(req.hh, ledger.visible_txns(req.hh, req.device['member_id'], 'AND t.id = :tid', tid=tid))[0]}


@route('POST', '/api/ingest/sms/batch', auth='phone')  # the web paste (cookie) or a phone (device key)
def sms_batch(req):
    msgs = req.json.get('messages', [req.json] if 'body' in req.json else None)  # one flat {sender, body, received_at} too (iOS Shortcut)
    if not isinstance(msgs, list) or len(msgs) > MAX_BATCH:
        raise ApiError(400, f'messages must be a list of at most {MAX_BATCH}')
    checked = [_message(m) for m in msgs]
    stored = 0
    device_id, member_id = (req.device['id'], req.device['member_id']) if req.device else (None, req.member['id'])
    for s, b, at in checked:
        with req.db.tx():
            stored += ingest_sms(req.hh, s, b, at, device_id, member_id)[0]
    return {'received': len(msgs), 'stored': stored}


# ---------- statements ----------

def statement_view(s):
    return {k: s[k] for k in ('id', 'account_id', 'file_name', 'period_from', 'period_to', 'rows', 'imported_at')}


@route('POST', '/api/ingest/statement')
def import_statement(req):
    b, hh = req.json, req.hh
    account = ledger.get_account(hh, req.member['id'], b.get('account_id'))
    name = valid.text(b.get('file_name'), 'file_name', 120)
    data = b.get('data_base64')
    if not isinstance(data, str) or len(data) > MAX_FILE * 4 // 3 + 4:
        raise ApiError(413 if isinstance(data, str) else 400, 'data_base64 must be the file, at most about 4 MB')
    try:
        data = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise ApiError(400, 'data_base64 is not valid base64')
    password = b.get('password') if isinstance(b.get('password'), str) else None
    try:
        rows = read_statement(data, password)['rows']
    except StatementError as e:
        raise ApiError(422, str(e))
    except (ValueError, KeyError, IndexError, TypeError):
        raise ApiError(422, "couldn't read this file: download the statement again as PDF, Excel or CSV")
    if parts := sorted({r['account'] for r in rows if r.get('account')}):  # a combined statement: only this account's section
        if account['last4'] not in parts:
            raise ApiError(422, f"this statement covers accounts ending {', '.join(parts)}: import it into one of those")
        rows = [r for r in rows if r.get('account') == account['last4']]
    first, last = span(rows)
    with req.db.tx():
        st = hh.insert('statements', account_id=account['id'], file_name=name, period_from=first or '', period_to=last or '', rows=len(rows), imported_at=now())
        new, dup, used, seen = [], 0, set(), {}
        for r in rows:
            base = f"stmt.{account['id']}.{r['day']}.{r['direction']}.{r['amount_minor']}.{_sha(r['desc'])[:12]}"
            seen[base] = seen.get(base, 0) + 1
            key = f'{base}.{seen[base]}'  # two identical rows in one file are two real movements
            if hh.one('SELECT id FROM transactions WHERE household_id = :hid AND dedupe_key = :k', k=key):
                dup += 1
                continue
            lo, hi = (datetime.fromordinal(datetime.fromisoformat(r['day']).toordinal() + k).date().isoformat() for k in (-STATEMENT_SMS_DAYS, STATEMENT_SMS_DAYS))
            sms_rows = [t for t in hh.run("SELECT id FROM transactions WHERE household_id = :hid AND account_id = :a AND source = 'sms' AND deleted_at IS NULL "
                                          "AND amount_minor = :m AND direction = :d AND day >= :lo AND day <= :hi ORDER BY day",
                                          a=account['id'], m=r['amount_minor'], d=r['direction'], lo=lo, hi=hi) if t['id'] not in used]
            if sms_rows:
                used.add(sms_rows[0]['id'])
                dup += 1
                continue
            merchant = (merchant_of(r['desc']) or r['desc'])[:80]
            t = hh.insert('transactions', account_id=account['id'], member_id=req.member['id'], occurred_at=r['day'] + 'T00:00:00+00:00', day=r['day'],
                          amount_minor=r['amount_minor'], currency=account['currency'], direction=r['direction'], merchant_raw=r['desc'],
                          merchant=merchant, source='statement', statement_id=st['id'], dedupe_key=key, created_at=now())
            new.append(t['id'])
        with_bal = [r for r in rows if r.get('balance_minor') is not None]
        if with_bal and account['kind'] not in ('credit_card', 'bnpl'):
            _set_balance(hh, account, with_bal[-1 if with_bal[-1]['day'] >= with_bal[0]['day'] else 0]['balance_minor'], max(r['day'] for r in with_bal) + 'T23:59:59+00:00')
    classify.reclassify(hh, new)
    return 201, {'statement': statement_view(hh.get('statements', st['id'])), 'rows': len(rows), 'new': len(new), 'duplicates': dup}


@route('GET', '/api/ingest/statements')
def list_statements(req):
    visible = {a['id'] for a in ledger.account_rows(req.hh, req.member['id'], archived=True)}
    return {'items': [statement_view(s) for s in req.hh.run('SELECT * FROM statements WHERE household_id = :hid ORDER BY imported_at DESC')
                      if s['account_id'] in visible]}


@route('DELETE', '/api/ingest/statements/{id}')
def delete_statement(req):
    s = req.hh.get('statements', valid.ident(req.params['id'], 'statement'))
    if not s:
        raise ApiError(404, 'statement not found')
    ledger.get_account(req.hh, req.member['id'], s['account_id'])  # 404 for someone else's private account
    with req.db.tx():
        req.hh.run("UPDATE transactions SET deleted_at = :t, dedupe_key = dedupe_key || '.del.' || id "  # frees the key for a re-import
                   "WHERE household_id = :hid AND statement_id = :s AND source = 'statement' AND deleted_at IS NULL",
                   t=now(), s=s['id'])
        req.hh.run('DELETE FROM txn_links WHERE household_id = :hid AND (from_txn IN (SELECT id FROM transactions WHERE household_id = :hid AND statement_id = :s) '
                   'OR to_txn IN (SELECT id FROM transactions WHERE household_id = :hid AND statement_id = :s))', s=s['id'])  # the other leg can pair again
        req.hh.run('DELETE FROM statements WHERE id = :id AND household_id = :hid', id=s['id'])
    return {'id': s['id'], 'deleted': True}


@route('GET', '/api/ingest/log')
def log(req):
    rows = req.hh.run('SELECT r.created_at, r.sender, r.outcome, d.name AS device FROM raw_messages r '
                      'LEFT JOIN devices d ON d.id = r.device_id AND d.household_id = r.household_id '
                      'WHERE r.household_id = :hid ORDER BY r.created_at DESC, r.id DESC LIMIT 50')
    return {'items': [{'at': r['created_at'], 'device': r['device'], 'sender': r['sender'], 'outcome': r['outcome']} for r in rows]}
