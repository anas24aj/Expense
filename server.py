"""Expense server: receives SMS from the phone, stores transactions, serves analytics.

A plain WSGI app (`app`), so the same code runs on Vercel and locally:
    EXPENSE_TOKEN=some-long-secret python3 server.py                   # local, SQLite file
    DATABASE_URL=postgresql://... EXPENSE_TOKEN=... python3 server.py   # local, Postgres
"""
import hashlib
import hmac
import json
import os
import re
import sqlite3
import ssl
import sys
from collections import defaultdict
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import urlopen
from zoneinfo import ZoneInfo

import base64
from bisect import bisect_left
from datetime import date

from parse import AD, ARABIC_DIGITS, account_of, categorize, compile_rules, merchant_of, parse
from statement import StatementError, read_statement, span

HERE = Path(__file__).parent
RULES = HERE / 'rules.json'
MAX_BODY = 16 * 1024
VERSION = os.environ.get('VERCEL_GIT_COMMIT_SHA', 'local')[:7]  # which commit is live; Vercel sets this
MAX_IMPORT_BODY, MAX_IMPORT_BATCH = 2 * 1024 * 1024, 500  # one upload batch from the import page
MAX_STATEMENT_BODY = 4_400_000  # Vercel refuses request bodies over 4.5 MB; the file arrives base64 (a 3.2 MB file)
SESSION_DAYS = 30
PAGES = {'/': 'dashboard.html', '/import': 'import.html'}
# What Android needs to install the site as an app. No personal data, and Chrome fetches the manifest without
# your login cookie, so these are served to anyone.
PUBLIC = {'/manifest.webmanifest': 'application/manifest+json', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png'}
MIN_PASSWORD = 6
MAX_FAILURES, LOCKOUT_SECONDS = 10, 15 * 60  # wrong guesses per IP before it is locked out, and for how long

SCHEMA = '''CREATE TABLE IF NOT EXISTS transactions (
    id {id} PRIMARY KEY,
    received_at TEXT NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL UNIQUE,  -- shortcut: dedupes phone retries; two byte-identical SMS count once. Add a phone-side message id if that bites.
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    direction TEXT NOT NULL,
    merchant TEXT NOT NULL
)'''
FAILURES_SCHEMA = 'CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at INTEGER NOT NULL)'
# Your corrections: a category for every transaction from a merchant, or for one transaction.
LEARNED_SCHEMAS = ['CREATE TABLE IF NOT EXISTS merchant_categories (merchant TEXT PRIMARY KEY, category TEXT NOT NULL)',
                   'CREATE TABLE IF NOT EXISTS txn_categories (txn_id BIGINT PRIMARY KEY, category TEXT NOT NULL)']
MAX_CATEGORY = 40
# A purchase made for a friend: their part of it (theirs_minor) isn't your spending, and a credit tagged with a
# friend is them paying you back, not income. settled: paid back outside the bank, or squared up by hand.
FRIENDS_SCHEMA = 'CREATE TABLE IF NOT EXISTS txn_friends (txn_id BIGINT PRIMARY KEY, friend TEXT NOT NULL, theirs_minor BIGINT NOT NULL, settled INTEGER NOT NULL DEFAULT 0)'
MAX_FRIEND = 40
# Your loans and savings, entered by hand. A loan's balance is as of `as_of`; EMI SMS after that whose text
# contains `pattern` (e.g. the loan account's last digits) bring it down. rate_bp: yearly rate in hundredths of a %.
HOLDINGS_SCHEMA = '''CREATE TABLE IF NOT EXISTS holdings (id {id} PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  currency TEXT NOT NULL, balance_minor BIGINT NOT NULL, rate_bp INTEGER NOT NULL DEFAULT 0, emi_minor BIGINT NOT NULL DEFAULT 0,
  due_day INTEGER NOT NULL DEFAULT 0, pattern TEXT NOT NULL DEFAULT '', as_of TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0)'''
# Payments you record yourself on the Plan page: an EMI the SMS didn't show, or an extra (pre)payment.
PAYMENTS_SCHEMA = '''CREATE TABLE IF NOT EXISTS loan_payments (id {id} PRIMARY KEY, holding_id BIGINT NOT NULL, paid_on TEXT NOT NULL,
  amount_minor BIGINT NOT NULL, note TEXT NOT NULL DEFAULT '')'''
# The monthly check-in: what you planned (an extra payment, a spending limit) and whether you did it.
ACTIONS_SCHEMA = '''CREATE TABLE IF NOT EXISTS plan_actions (month TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  target_minor BIGINT NOT NULL DEFAULT 0, actual_minor BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (month, kind, ref))'''
PLAN_KINDS = {'balances', 'emi', 'extra', 'limit', 'savings', 'alloc'}
# Your answers to the Plan tab's setup: the salary, how you split it, and the debt option you chose.
SETTINGS_SCHEMA = 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
SETTING_KEYS = {'salary', 'allocations', 'debt_choice'}
# What you owed and had saved, once a month (INR, the latest look at the Debt tab that month), for the graphs.
SNAPSHOTS_SCHEMA = 'CREATE TABLE IF NOT EXISTS snapshots (month TEXT PRIMARY KEY, debt_minor BIGINT NOT NULL, savings_minor BIGINT NOT NULL)'
PLAN_STATUS = {'planned', 'done', 'skipped'}
PLAN_MONTHS = 600  # 50 years: a loan whose EMI doesn't cover its interest never ends
# SMS of transactions you deleted, so the phone sending them again (or an import) doesn't bring them back.
DELETED_SCHEMA = 'CREATE TABLE IF NOT EXISTS deleted_sms (body TEXT PRIMARY KEY)'
# Your bank accounts, cards, wallets (STC Pay, PhonePe…), buy-now-pay-later (Tamara, Tabby) and loan accounts, named when
# you import a statement. digits: the account's or card's last 4, so its SMS ('A/c XX1234') show under the same name.
ACCOUNTS_SCHEMA = "CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, kind TEXT NOT NULL, currency TEXT NOT NULL, digits TEXT NOT NULL DEFAULT '')"
ACCOUNT_KINDS = {'bank', 'card', 'wallet', 'bnpl', 'loan'}
# Transfers you linked by hand on the Money trail: the debit in one of your accounts and the credit it became.
LINKS_SCHEMA = 'CREATE TABLE IF NOT EXISTS txn_links (debit_id BIGINT PRIMARY KEY, credit_id BIGINT NOT NULL UNIQUE)'
# One row per imported statement file; its transactions carry statement_id, so the import can be undone.
STATEMENTS_SCHEMA = '''CREATE TABLE IF NOT EXISTS statements (id {id} PRIMARY KEY, account TEXT NOT NULL, file_name TEXT NOT NULL,
  imported_at TEXT NOT NULL, first_day TEXT, last_day TEXT, read_rows INTEGER NOT NULL, new_rows INTEGER NOT NULL,
  sms_rows INTEGER NOT NULL, checked INTEGER NOT NULL)'''
# A receipt per SMS the phone sends (time, sender, what happened; never the text), so you can check delivery.
DELIVERIES_SCHEMA = 'CREATE TABLE IF NOT EXISTS phone_deliveries (id {id} PRIMARY KEY, at TEXT NOT NULL, sender TEXT NOT NULL, outcome TEXT NOT NULL)'
DELIVERY_DAYS = 7
# The text of SMS that were skipped as 'not a transaction', kept as long as their receipt, so you can save one
# as a transaction from Settings. Codes and passwords are never kept.
SKIPPED_SCHEMA = 'CREATE TABLE IF NOT EXISTS skipped_sms (delivery_id BIGINT PRIMARY KEY, body TEXT NOT NULL, received_at TEXT NOT NULL)'
SECRET = re.compile(r'\b(?:otp|one[- ]time|verification|passcode|password|pin)\b|رمز|كلمة المرور', re.I)
IGNORED = 'Ignored'  # a category like any other, except it never counts toward totals
OWN_TRANSFER = 'Own transfer'  # money moved between your own accounts: not spending, not income
NOT_COUNTED = {IGNORED, OWN_TRANSFER}
# Advert senders: Saudi rules put "AD" on promotional sender names ("Mobily-AD"); Indian promotional ones end in "-P".
AD_SENDER = re.compile(r'(?:^ad[-_ ]|[-_ ]ad$|[-_ ]adv$|-p$)', re.I)
# A refund from a merchant with no category is money back on spending, not income: it waits for a category.
REFUND = re.compile(r'\b(?:refund(?:ed)?|reversal|reversed|reverse|cashback)\b|استرداد|مسترد', re.I)
# Words that mark a bank-to-bank transfer (English and Arabic), used to pair the two sides of an own transfer.
TRANSFER = re.compile(r'\b(?:transfer(?:red)?|trf|xfer|neft|imps|rtgs|upi|iban|sarie)\b|حوالة|تحويل', re.I)
# shortcut: pairs only same-currency, same-amount SMS within an hour; a slower or cross-currency transfer
# needs the "Own transfer" option once (with "apply to all", that also covers the future ones).
PAIR_WINDOW_SECONDS = 60 * 60


def direct(url):
    """Neon's direct address instead of its connection pooler ('ep-x-pooler.…' → 'ep-x.…'). pg8000 sends a query in two
    steps, and a pooler in transaction mode can hand the second step to another server ('unnamed prepared statement
    does not exist'). Neon on Vercel also sets DATABASE_URL_UNPOOLED, which is preferred when present."""
    u = urlparse(url)
    if u.hostname and '-pooler.' in u.hostname:
        return url.replace(u.hostname, u.hostname.replace('-pooler.', '.'), 1)
    return url


class DB:
    """Postgres when DATABASE_URL is set (Neon on Vercel), else a local SQLite file. Both take :name parameters."""
    _schema_ready = set()
    # Open Postgres connections kept between requests: a new TLS + login handshake costs several round trips,
    # and Vercel reuses warm instances. A pool (not one shared connection) because requests can run concurrently.
    _idle = {}
    POOL_SIZE = 3

    def __init__(self, url=None):
        url = direct(url if url is not None else os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get('DATABASE_URL', ''))
        self.url, self.reused = url, False
        if url.startswith(('postgres://', 'postgresql://')):
            try:
                self.conn, self.reused = DB._idle.setdefault(url, []).pop(), True
            except IndexError:
                self.conn = self._connect(url)
            self.pg, schema = True, SCHEMA.format(id='BIGSERIAL')
        else:
            url = url or os.environ.get('EXPENSE_DB', str(HERE / 'expense.db'))
            self.conn = sqlite3.connect(url, isolation_level=None)
            self.conn.row_factory = sqlite3.Row
            self.pg, schema = False, SCHEMA.format(id='INTEGER')
        if url not in DB._schema_ready:  # once per process, not per request
            self.run(schema)
            for extra in [FAILURES_SCHEMA, *LEARNED_SCHEMAS, DELIVERIES_SCHEMA, SKIPPED_SCHEMA, FRIENDS_SCHEMA, DELETED_SCHEMA, HOLDINGS_SCHEMA, PAYMENTS_SCHEMA, ACTIONS_SCHEMA, SETTINGS_SCHEMA, SNAPSHOTS_SCHEMA, ACCOUNTS_SCHEMA, STATEMENTS_SCHEMA, LINKS_SCHEMA]:
                self.run(extra.format(id='BIGSERIAL' if self.pg else 'INTEGER'))
            self.migrate()
            DB._schema_ready.add(url)  # before the re-read: if that fails, requests must still work and not retry it each time
            try:
                self.reread_amounts()
            except Exception as e:  # a clean-up; never worth failing a request over
                print(f'reread_amounts failed: {type(e).__name__}: {e}', file=sys.stderr)

    def migrate(self):
        """Columns added after a table first existed. holdings.auto: the EMI is taken automatically each month
        (loans made before it existed are, as Indian EMIs usually are; cards aren't)."""
        cols = ({r['column_name'] for r in self.run("SELECT column_name FROM information_schema.columns WHERE table_name = 'holdings'")}
                if self.pg else {r['name'] for r in self.run('PRAGMA table_info(holdings)')})
        if 'auto' not in cols:
            self.run('ALTER TABLE holdings ADD COLUMN auto INTEGER NOT NULL DEFAULT 0')
            self.run("UPDATE holdings SET auto = 1 WHERE kind = 'loan'")
        # transactions.statement_id: the statement a row came from (none for SMS)
        cols = ({r['column_name'] for r in self.run("SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions'")}
                if self.pg else {r['name'] for r in self.run('PRAGMA table_info(transactions)')})
        if 'statement_id' not in cols:
            self.run('ALTER TABLE transactions ADD COLUMN statement_id BIGINT')

    @staticmethod
    def _connect(url):
        import pg8000.native
        u = urlparse(url)
        tls = parse_qs(u.query).get('sslmode', ['require'])[0] != 'disable'
        return pg8000.native.Connection(
            unquote(u.username or ''), host=u.hostname, port=u.port or 5432, database=u.path.lstrip('/'),
            password=unquote(u.password or ''), ssl_context=ssl.create_default_context() if tls else None)

    def reread_amounts(self):
        """Once per server start: read amount, currency and direction again from every stored SMS and fix the ones
        the current parser reads differently, so a parser fix also corrects messages stored before it
        (e.g. a date on the line after 'Balance: … SAR' once read as the amount). Adverts stored before adverts
        were recognized are marked Ignored, unless you set their category yourself. Batched, a few hundred rows per
        statement: one round trip per row could outlast the request on a slow link."""
        has_category = {r['txn_id'] for r in self.run('SELECT txn_id FROM txn_categories')}
        adverts, fixes = [], []
        for r in self.run('SELECT id, sender, body, amount_minor, currency, direction FROM transactions WHERE statement_id IS NULL'):
            if AD_SENDER.search(r['sender'].strip()) or AD.search(r['body']):
                if r['id'] not in has_category:
                    adverts.append(r['id'])
                continue
            again = parse(r['body'])
            if again and (again['amount_minor'], again['currency'], again['direction']) != (r['amount_minor'], r['currency'], r['direction']):
                fixes.append((r['id'], again['amount_minor'], again['currency'], again['direction']))
        for i in range(0, len(adverts), 300):
            chunk = adverts[i:i + 300]
            self.run('INSERT INTO txn_categories (txn_id, category) VALUES ' + ', '.join(f'(:id{n}, :c)' for n in range(len(chunk)))
                     + ' ON CONFLICT (txn_id) DO NOTHING', c=IGNORED, **{f'id{n}': v for n, v in enumerate(chunk)})
        for i in range(0, len(fixes), 300):  # only after a parser fix, and only the rows it changed
            chunk = fixes[i:i + 300]
            # VALUES columns are column1..column4 in both Postgres and SQLite; casts give Postgres the types.
            self.run('UPDATE transactions SET amount_minor = v.column2, currency = v.column3, direction = v.column4 FROM (VALUES '
                     + ', '.join(f'(CAST(:i{n} AS BIGINT), CAST(:a{n} AS BIGINT), :c{n}, :d{n})' for n in range(len(chunk)))
                     + ') AS v WHERE transactions.id = v.column1',
                     **{k: v for n, f in enumerate(chunk) for k, v in ((f'i{n}', f[0]), (f'a{n}', f[1]), (f'c{n}', f[2]), (f'd{n}', f[3]))})

    def run(self, sql, **params):
        if self.pg:
            from pg8000.exceptions import DatabaseError, InterfaceError
            try:
                rows = self.conn.run(sql, **params) or []
            except (InterfaceError, OSError, DatabaseError) as e:
                # 26000 'unnamed prepared statement does not exist': a connection pooler sent the two halves of the
                # query to different servers. Reconnect and run it again, like a stale connection.
                pooled = isinstance(e, DatabaseError) and isinstance(e.args[0], dict) and e.args[0].get('C') == '26000'
                if isinstance(e, DatabaseError) and not pooled or not (self.reused or pooled):
                    raise
                # A kept connection went stale (Neon drops them when it sleeps): reconnect once and retry.
                # Every statement here is safe to repeat (inserts are ON CONFLICT DO NOTHING / upserts).
                self.conn, self.reused = self._connect(self.url), False
                rows = self.conn.run(sql, **params) or []
            names = [c['name'] for c in self.conn.columns or []]
            return [dict(zip(names, r)) for r in rows]
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def close(self):
        idle = DB._idle.get(self.url)
        if self.pg and len(idle) < DB.POOL_SIZE:
            idle.append(self.conn)
        else:
            self.conn.close()


def store_many(db, messages):
    """Parse (sender, body, received_at) messages and insert the new transactions in one statement
    (one round trip, so a big import stays fast). Returns the stored transactions."""
    rows = {}
    deleted = {r['body'] for r in db.run('SELECT body FROM deleted_sms')} if messages else set()
    for sender, body, received_at in messages:
        if body in deleted:
            continue
        txn = None if AD_SENDER.search(sender.strip()) else parse(body)
        if txn:
            rows.setdefault(body, {**txn, 'sender': sender, 'body': body, 'received_at': received_at})
    if not rows:
        return []
    columns = ('received_at', 'sender', 'body', 'amount_minor', 'currency', 'direction', 'merchant')
    values = ', '.join('(' + ', '.join(f':{c}{i}' for c in columns) + ')' for i in range(len(rows)))
    params = {f'{c}{i}': row[c] for i, row in enumerate(rows.values()) for c in columns}
    inserted = {r['body'] for r in db.run(
        f'INSERT INTO transactions ({", ".join(columns)}) VALUES {values} ON CONFLICT (body) DO NOTHING RETURNING body', **params)}
    return [{k: row[k] for k in ('amount_minor', 'currency', 'direction', 'merchant', 'received_at')}
            for row in rows.values() if row['body'] in inserted]


def record_delivery(db, sender, outcome, skipped=None):
    """skipped: (body, received_at) of an SMS that wasn't read as a transaction, kept so you can save it yourself."""
    now = datetime.now(timezone.utc)
    receipt = db.run('INSERT INTO phone_deliveries (at, sender, outcome) VALUES (:at, :s, :o) RETURNING id',
                     at=now.isoformat(timespec='seconds'), s=sender[:40], o=outcome)[0]['id']
    if skipped and not SECRET.search(skipped[0]):
        db.run('INSERT INTO skipped_sms (delivery_id, body, received_at) VALUES (:id, :b, :r)', id=receipt, b=skipped[0], r=skipped[1])
    # Keep a week, and at most the newest 100, so a stream of refused requests can't fill the table.
    db.run('DELETE FROM phone_deliveries WHERE at < :old OR id <= (SELECT id FROM phone_deliveries ORDER BY id DESC LIMIT 1 OFFSET 100)',
           old=(now - timedelta(days=DELIVERY_DAYS)).isoformat(timespec='seconds'))
    db.run('DELETE FROM skipped_sms WHERE delivery_id NOT IN (SELECT id FROM phone_deliveries)')


def save_skipped(db, receipt_id, amount_minor, direction, currency):
    """Store a skipped SMS as a transaction with the amount and direction you gave; its receipt then says so."""
    found = db.run('SELECT s.body, s.received_at, d.sender FROM skipped_sms s JOIN phone_deliveries d ON d.id = s.delivery_id '
                   'WHERE s.delivery_id = :id', id=receipt_id)
    if not found:
        raise KeyError('no such message')
    sms = found[0]
    db.run('INSERT INTO transactions (received_at, sender, body, amount_minor, currency, direction, merchant) '
           'VALUES (:r, :s, :b, :a, :c, :d, :m) ON CONFLICT (body) DO NOTHING',
           r=sms['received_at'], s=sms['sender'], b=sms['body'], a=amount_minor, c=currency, d=direction, m=merchant_of(sms['body']))
    db.run('INSERT INTO txn_categories (txn_id, category) SELECT id, :c FROM transactions WHERE body = :b ON CONFLICT (txn_id) DO NOTHING',
           c='Uncategorized', b=sms['body'])  # you chose to keep it: the start-up advert sweep must leave it alone
    db.run("UPDATE phone_deliveries SET outcome = 'saved by you' WHERE id = :id", id=receipt_id)
    db.run('DELETE FROM skipped_sms WHERE delivery_id = :id', id=receipt_id)


def store_sms(db, sender, body, received_at):
    """Parse and insert one SMS. Returns the stored transaction, or None if it was skipped or a duplicate."""
    stored = store_many(db, [(sender, body, received_at)])
    return stored[0] if stored else None


def transactions(db, month=None, currency=None):
    # Categories are computed on read, so a correction or a rules.json edit re-categorizes history too.
    # Order: your correction for this transaction > your rule for its merchant > rules.json keywords.
    rules = compile_rules(json.loads(RULES.read_text(encoding='utf-8')))
    saved = {r['merchant']: r['category'] for r in db.run('SELECT merchant, category FROM merchant_categories')}
    by_wording = {k: c for k, c in saved.items() if k.startswith(WORDING)}
    for_merchant = rule_finder({k: c for k, c in saved.items() if not k.startswith(WORDING)})
    overrides = {r['txn_id']: r['category'] for r in db.run('SELECT txn_id, category FROM txn_categories')}
    friends = {r['txn_id']: r for r in db.run('SELECT txn_id, friend, theirs_minor, settled FROM txn_friends')}
    # id breaks ties: rows with the same timestamp must come back in the same order every time,
    # or the dashboard sees "changed" data on each load and redraws under your finger.
    rows = db.run('SELECT * FROM transactions ORDER BY received_at DESC, id DESC')
    own = own_transfers(rows, overrides)
    named = {a['digits']: a['name'] for a in db.run("SELECT name, digits FROM accounts WHERE digits != ''")}
    mine = lambda d: next((n for k, n in named.items() if d and k.endswith(d)), None)  # '234' shown, '1234' given
    acct = {r['id']: r['sender'] if r['statement_id'] else mine(account_of(r['body']).partition('•')[2]) or account_label(r['sender'], r['body'])
            for r in rows}
    # One bank shows '•234' in one SMS and '•1234' in the next: the same account, under its longer ending.
    ends = defaultdict(set)
    for a in set(acct.values()):
        head, dot, d = a.rpartition('•')
        if dot:
            ends[head].add(d)
    longer = lambda a: next(iter([f'{a.rpartition("•")[0]}•{x}' for x in ends[a.rpartition('•')[0]]
                                  if len(x) > len(a.rpartition('•')[2]) and x.endswith(a.rpartition('•')[2])][:1]), a)
    acct = {k: longer(v) if '•' in v else v for k, v in acct.items()}
    linked = links(rows, acct, overrides, [(r['debit_id'], r['credit_id']) for r in db.run('SELECT * FROM txn_links')])
    own |= set(linked)
    result = []
    for r in rows:
        if (month and not r['received_at'].startswith(month)) or (currency and r['currency'] != currency):
            continue
        merchant = r['merchant'] if r['statement_id'] else merchant_of(r['body'])
        f = friends.get(r['id'])
        # A credit from a friend is all theirs (a repayment); a debit is theirs up to its amount.
        theirs = 0 if not f else r['amount_minor'] if r['direction'] == 'credit' else min(f['theirs_minor'], r['amount_minor'])
        result.append({
            'id': r['id'], 'received_at': r['received_at'], 'sender': r['sender'], 'body': r['body'],
            'amount': r['amount_minor'] / 100, 'currency': r['currency'], 'direction': r['direction'],
            'merchant': merchant,
            'account': acct[r['id']], 'statement': bool(r['statement_id']), 'linked': linked.get(r['id']), 'fixed': r['id'] in overrides,
            'friend': f['friend'] if f else '', 'theirs': theirs / 100, 'settled': bool(f and f['settled']),
            'category': overrides.get(r['id']) or (OWN_TRANSFER if r['id'] in own else None)
                        or (merchant and for_merchant(merchant))
                        or (not merchant and by_wording.get(wording(r['body'])))
                        or categorize(merchant, r['body'], rules, 'Income' if r['direction'] == 'credit' and not REFUND.search(r['body']) else 'Uncategorized'),
        })
    return result


def account_label(sender, body):
    """'AlRajhiBank · Card •1234': which bank and card/account a transaction used. Indian sender IDs carry an
    operator prefix/suffix ('VM-HDFCBK', 'JD-HDFCBK-S') that changes per SMS, so it's dropped."""
    bank = re.sub(r'^[A-Za-z]{2}-|-[A-Za-z]$', '', sender.strip())
    return ' · '.join(part for part in (bank, account_of(body)) if part) or 'Unknown account'


def rule_finder(rules):
    """Look up your rule for a merchant: its exact name, else the longest saved name found inside it, so a rule
    for 'JARIR MEDICAL CO' beats one for 'JARIR' whatever order they were saved in. Memoized per merchant."""
    found = {}

    def find(merchant):
        m = merchant.strip().lower()
        if m not in found:
            inside = [k for k in rules if re.search(r'\b' + re.escape(k) + r'\b', m)]
            found[m] = rules.get(m) or (rules[max(inside, key=len)] if inside else None)
        return found[m]
    return find


def own_transfers(rows, overrides):
    """Ids of transfers between your own accounts: a transfer out and a transfer in of the same amount and
    currency within PAIR_WINDOW_SECONDS (each account's bank sends its own SMS). A transaction you
    categorized yourself is never paired, so correcting one side breaks a wrong pair."""
    credits = defaultdict(list)  # (currency, amount) -> [(time, id)], so each debit only looks at equal amounts
    for r in rows:
        if r['direction'] == 'credit' and r['id'] not in overrides and TRANSFER.search(r['body']):
            credits[r['currency'], r['amount_minor']].append((datetime.fromisoformat(r['received_at']), r['id']))
    paired = set()
    for r in rows:
        if r['direction'] != 'debit' or r['id'] in overrides or not TRANSFER.search(r['body']):
            continue
        sent_at = datetime.fromisoformat(r['received_at'])
        gaps = [(abs((got_at - sent_at).total_seconds()), cid) for got_at, cid in credits[r['currency'], r['amount_minor']]
                if cid not in paired]
        gap, cid = min(gaps, default=(None, None))
        if cid is not None and gap <= PAIR_WINDOW_SECONDS:
            paired |= {r['id'], cid}
    return paired


# Words that make a debit and a credit in two of your accounts days apart (or in two currencies) one movement of money:
# transfers, remittances home, wallet top-ups, card bills and loan repayments.
# Generic words only (no bank or app names), so it works the same whatever banks you use.
LINK_WORDS = re.compile(r'\b(?:remit\w*|inward|outward|international|swift|foreign|nre|nro|'
                        r'top ?-?up|card ?payment|cc ?payment|payment (?:received|thank)|'
                        r'repayment|emi|loan|by transfer|to transfer)\b|حوالة|تحويل|سداد', re.I)
# Credit/debit amount ratio for money changing currency on the way (₹ per SAR, ₹ per $, $ per SAR), with room for fees and
# the rates of the last few years.
# 'A/c XX1234 debited by Rs 15,000; ANIL K credited. RRN …': money sent to another account (a person's, or yours).
# A purchase or a card spend pays a shop: it never moves money to one of your accounts.
PURCHASE = re.compile(r'\b(?:purchase|pos|spent|shopping)\b|شراء', re.I)
P2P = re.compile(r'\bdebited\b[^\n]*\bcredited\b|\brrn\b', re.I)
FX_RATIO = {('SAR', 'INR'): (20.0, 27.0), ('USD', 'INR'): (78.0, 100.0), ('SAR', 'USD'): (0.255, 0.27)}
LINK_DAYS = 4


def transfer_like(r):
    return bool(LINK_WORDS.search(r['body']) or TRANSFER.search(r['body']) or P2P.search(r['body']))


def link_by_hand(db, debit_id, credit_id):
    """You say this debit became that credit (or, credit_id None, that it isn't linked by hand any more). Your own
    category on either is dropped, so both count as an own transfer."""
    db.run('DELETE FROM txn_links WHERE debit_id = :d OR credit_id = :d', d=debit_id)
    if credit_id is None:
        return
    rows = {r['id']: r for r in db.run('SELECT id, direction FROM transactions WHERE id IN (:d, :c)', d=debit_id, c=credit_id)}
    if rows.get(debit_id, {}).get('direction') != 'debit' or rows.get(credit_id, {}).get('direction') != 'credit':
        raise KeyError('pick money going out, and money coming in')
    db.run('DELETE FROM txn_links WHERE debit_id = :c OR credit_id = :c', c=credit_id)
    db.run('INSERT INTO txn_links (debit_id, credit_id) VALUES (:d, :c)', d=debit_id, c=credit_id)
    db.run('DELETE FROM txn_categories WHERE txn_id IN (:d, :c)', d=debit_id, c=credit_id)


def links(rows, acct, overrides, manual=()):
    """{debit id: credit id, credit id: debit id} for money that left one of your accounts and arrived in another:
    the same amount (or the same at an exchange rate) within LINK_DAYS, with transfer words on either side.
    Two SMS in the same currency must be an hour apart at most (as in own_transfers), so a UPI payment and an
    unrelated refund of the same amount days later don't pair. Nearest in time first; each row pairs once."""
    day = {r['id']: date.fromisoformat(r['received_at'][:10]) for r in rows}
    credits = defaultdict(list)  # currency -> [(day, id)] sorted
    for r in rows:
        if r['direction'] == 'credit' and r['id'] not in overrides:
            credits[r['currency']].append((day[r['id']], r['id']))
    for v in credits.values():
        v.sort()
    by_id = {r['id']: r for r in rows}
    paired = {}
    for d, c in manual:  # yours first
        if d in by_id and c in by_id:
            paired[d], paired[c] = c, d
    words = transfer_like
    for d in sorted((r for r in rows if r['direction'] == 'debit' and r['id'] not in overrides and r['id'] not in paired and not PURCHASE.search(r['body'])),
                    key=lambda r: r['received_at']):
        best = None
        for cur, lo_hi in [(d['currency'], None)] + [(c2, rng) for (c1, c2), rng in FX_RATIO.items() if c1 == d['currency']]:
            lst = credits.get(cur, [])
            for k in range(bisect_left(lst, (day[d['id']], -1)), len(lst)):
                when, cid = lst[k]
                gap = (when - day[d['id']]).days
                if gap > LINK_DAYS:
                    break
                c = by_id[cid]
                if cid in paired or acct[cid] == acct[d['id']]:
                    continue
                if lo_hi is None:
                    if c['amount_minor'] != d['amount_minor'] or not (d['statement_id'] or c['statement_id']) and abs(
                            (datetime.fromisoformat(c['received_at']) - datetime.fromisoformat(d['received_at'])).total_seconds()) > PAIR_WINDOW_SECONDS:
                        continue
                elif not lo_hi[0] <= c['amount_minor'] / d['amount_minor'] <= lo_hi[1]:
                    continue
                sms = not (d['statement_id'] or c['statement_id'])
                if lo_hi is None and sms and not (words(d) and words(c)):
                    continue  # two SMS: both must say transfer, as own_transfers asks
                if lo_hi and not (words(d) and (words(c) or c['statement_id'] or account_of(c['body']))):
                    continue  # changing currency: a transfer out, arriving in a named account (not an advert's 'credited to you')
                if lo_hi is None and not sms and not (words(d) or words(c)):
                    continue
                if best is None or gap < best[0]:
                    best = (gap, cid)
                break  # the nearest in this currency
        if best:
            paired[d['id']], paired[best[1]] = best[1], d['id']
    return paired


def import_statement(db, account, kind, currency, digits, file_name, data, password=None):
    """Store a statement's transactions under `account`. A row that an SMS already stored shows (same amount, way and
    currency within 2 days, and the same last 4 digits when both have them) is skipped: the SMS stays. Importing the
    same file again adds nothing. Returns the statement's summary."""
    got = read_statement(data, password)
    rows = got['rows']
    if not rows:
        raise StatementError('no transactions were found in this file')
    first, last = span(rows)
    db.run('INSERT INTO accounts (name, kind, currency, digits) VALUES (:n, :k, :c, :d) '
           'ON CONFLICT (name) DO UPDATE SET kind = :k, currency = :c, digits = :d', n=account, k=kind, c=currency, d=digits)
    sms = [r for r in db.run('SELECT id, received_at, body, amount_minor, direction FROM transactions '
                             'WHERE statement_id IS NULL AND currency = :c AND received_at >= :a AND received_at < :b',
                             c=currency, a=(date.fromisoformat(first) - timedelta(days=3)).isoformat(),
                             b=(date.fromisoformat(last) + timedelta(days=4)).isoformat())]
    used, fresh, seen = set(), [], defaultdict(int)
    for r in rows:
        twin = next((m for m in sms if m['id'] not in used and m['amount_minor'] == r['amount_minor'] and m['direction'] == r['direction']
                     and abs((date.fromisoformat(m['received_at'][:10]) - date.fromisoformat(r['day'])).days) <= 2
                     and not (digits and account_of(m['body'])[-4:].isdigit() and account_of(m['body'])[-4:] != digits)), None)
        if twin:
            used.add(twin['id'])
            continue
        amount = f"{currency} {r['amount_minor'] / 100:,.2f}"
        body = (f"{r['desc'] or 'No description'} · {'Paid' if r['direction'] == 'debit' else 'Received'} {amount} · {account}, {r['day']}"
                + (f" · balance {r['balance_minor'] / 100:,.2f}" if r['balance_minor'] is not None else ''))
        seen[body] += 1
        if seen[body] > 1:
            body += f' · #{seen[body]}'  # two identical rows in one file are two transactions
        fresh.append({'received_at': f"{r['day']}T12:00:00{'+05:30' if currency == 'INR' else '+03:00'}", 'sender': account,
                      'body': body, 'amount_minor': r['amount_minor'], 'currency': currency, 'direction': r['direction'],
                      'merchant': ' '.join(r['desc'].split())[:80]})
    deleted = {r['body'] for r in db.run('SELECT body FROM deleted_sms')} if fresh else set()
    fresh = [f for f in fresh if f['body'] not in deleted]
    sid = db.run('INSERT INTO statements (account, file_name, imported_at, first_day, last_day, read_rows, new_rows, sms_rows, checked) '
                 'VALUES (:a, :f, :t, :x, :y, :n, 0, :s, :k) RETURNING id', a=account, f=file_name[:120],
                 t=datetime.now(timezone.utc).isoformat(timespec='seconds'), x=first, y=last, n=len(rows), s=len(used), k=got['checked'])[0]['id']
    new = 0
    columns = ('received_at', 'sender', 'body', 'amount_minor', 'currency', 'direction', 'merchant')
    for i in range(0, len(fresh), 300):
        chunk = fresh[i:i + 300]
        values = ', '.join('(' + ', '.join(f':{c}{n}' for c in columns) + f', :sid)' for n in range(len(chunk)))
        new += len(db.run(f'INSERT INTO transactions ({", ".join(columns)}, statement_id) VALUES {values} ON CONFLICT (body) DO NOTHING RETURNING id',
                          sid=sid, **{f'{c}{n}': row[c] for n, row in enumerate(chunk) for c in columns}))
    db.run('UPDATE statements SET new_rows = :n WHERE id = :id', n=new, id=sid)
    return {'id': sid, 'account': account, 'kind': got['kind'], 'first_day': first, 'last_day': last, 'read': len(rows),
            'new': new, 'from_sms': len(used), 'already': len(fresh) - new, 'checked': got['checked'], 'currency_in_file': got['currency']}


def statements(db):
    return {'accounts': db.run('SELECT * FROM accounts ORDER BY name'),
            'statements': db.run('SELECT * FROM statements ORDER BY imported_at DESC, id DESC')}


def delete_statement(db, sid):
    """Undo an import: its transactions go (and can be imported again), the account stays."""
    if not db.run('SELECT id FROM statements WHERE id = :id', id=sid):
        raise KeyError('no such statement')
    for table, key in (('txn_categories', 'txn_id'), ('txn_friends', 'txn_id')):
        db.run(f'DELETE FROM {table} WHERE {key} IN (SELECT id FROM transactions WHERE statement_id = :id)', id=sid)
    db.run('DELETE FROM transactions WHERE statement_id = :id', id=sid)
    db.run('DELETE FROM statements WHERE id = :id', id=sid)


WALLETS = re.compile(r'stc ?pay|urpay|barq|wallet', re.I)  # PhonePe/GPay are UPI: the money moves in a bank account
BNPL = re.compile(r'tamara|tabby|postpay|spotii|simpl|lazypay', re.I)
FOLLOW_DAYS = 10


def trail(db, first=None, last=None):
    """Where money went between your accounts: each account's in and out, the flows between accounts (and on to
    loans), and journeys: a transfer, then the next transfer or loan payment out of the account it reached
    (likely the same money: within FOLLOW_DAYS and no more than what arrived), and so on."""
    every = transactions(db)
    by_id = {t['id']: t for t in every}
    kinds = {a['name']: a['kind'] for a in db.run('SELECT name, kind FROM accounts')}
    loans = [h for h in db.run('SELECT id, name, kind, currency, pattern, emi_minor FROM holdings') if h['kind'] in DEBTS]
    def why_loan(t):
        """(loan name, why) for a payment to one of your loans: its account digits in the SMS, or exactly its EMI. Not
        once you've given the transaction a category of your own (other than Rent & EMI): that's your correction."""
        if t['direction'] != 'debit' or t['fixed'] and t['category'] != 'Rent & EMI':
            return None
        for h in loans:
            if h['currency'] == t['currency'] and h['pattern'].strip() and h['pattern'].strip().lower() in t['body'].lower():
                return h['name'], f"the message mentions {h['pattern'].strip()}, the loan's account digits"
            if h['currency'] == t['currency'] and h['emi_minor'] and round(t['amount'] * 100) == h['emi_minor']:
                return h['name'], "exactly the loan's EMI"
        return None
    loan_of = lambda t: (why_loan(t) or (None,))[0]
    inside = lambda t: (not first or t['received_at'][:10] >= first) and (not last or t['received_at'][:10] <= last)
    kind_of = lambda name: kinds.get(name) or ('wallet' if WALLETS.search(name) else 'bnpl' if BNPL.search(name)
                                               else 'card' if 'Card' in name else 'bank')
    accounts = {}
    for t in every:
        if not inside(t) or t['category'] == IGNORED:
            continue
        a = accounts.setdefault(t['account'], {'name': t['account'], 'kind': kind_of(t['account']), 'in': defaultdict(float),
                                               'out': defaultdict(float), 'count': 0, 'last': ''})
        a['in' if t['direction'] == 'credit' else 'out'][t['currency']] += t['amount']
        a['count'] += 1
        a['last'] = max(a['last'], t['received_at'][:10])
    flows = {}

    proof = lambda t: {k: t[k] for k in ('id', 'account', 'amount', 'currency', 'direction', 'body', 'category')} | {'day': t['received_at'][:10]}

    def flow(src, dst, kind, sent, got, why):
        f = flows.setdefault((src, dst), {'from': src, 'to': dst, 'kind': kind, 'count': 0, 'sent': defaultdict(float), 'got': defaultdict(float), 'last': '', 'proof': []})
        f['count'] += 1
        f['proof'].append({'why': why, 'items': [proof(sent)] + ([proof(got)] if got is not sent else [])})
        f['sent'][sent['currency']] += sent['amount']
        f['got'][got['currency']] += got['amount']
        f['last'] = max(f['last'], sent['received_at'][:10])
    for t in every:
        if t['direction'] == 'debit' and inside(t):
            if t['linked'] in by_id:
                c = by_id[t['linked']]
                gap = (date.fromisoformat(c['received_at'][:10]) - date.fromisoformat(t['received_at'][:10])).days
                when = 'the same day' if not gap else f'{gap} day{"s" * (gap > 1)} later'
                flow(t['account'], c['account'], 'transfer', t, c,
                     f"arrived {when}" + (f" at {c['amount'] / t['amount']:.2f} {c['currency']} per {t['currency']}" if c['currency'] != t['currency'] else ', same amount'))
            elif found := why_loan(t):
                flow(t['account'], found[0], 'loan', t, t, found[1])
    # Journeys: after money arrives in an account, the next transfer/loan payment out of it.
    out_of = defaultdict(list)
    for t in sorted(every, key=lambda t: t['received_at']):
        if t['direction'] == 'debit' and (t['category'] not in NOT_COUNTED or t['linked'] in by_id):
            out_of[t['account']].append(t)
    # A credit's money goes on in every transfer/loan payment out of that account in the next FOLLOW_DAYS, as long as
    # together they're no more than what arrived: one big transfer home, split out to each loan's account.
    nxt, used = defaultdict(list), set()
    for c in sorted((t for t in every if t['direction'] == 'credit' and t['linked'] in by_id), key=lambda t: t['received_at']):
        day, room = date.fromisoformat(c['received_at'][:10]), 1.02 * c['amount']
        for d in out_of[c['account']]:
            gap = (date.fromisoformat(d['received_at'][:10]) - day).days
            if gap < 0 or d['id'] in used or d['currency'] != c['currency']:
                continue
            if gap > FOLLOW_DAYS:
                break
            if d['amount'] <= room and (d['amount'] >= 0.05 * c['amount'] or d['linked'] in by_id or loan_of(d)):  # not each coffee
                nxt[c['id']].append(d)
                used.add(d['id'])
                room -= d['amount']
    hop = lambda t, way, likely: {'id': t['id'], 'account': t['account'], 'kind': kind_of(t['account']), 'day': t['received_at'][:10], 'way': way,
                                  'amount': t['amount'], 'currency': t['currency'], 'desc': t['merchant'] or wording(t['body'])[len(WORDING):][:60],
                                  'likely': likely, 'then': []}

    def follow(t, likely, depth=0):
        """A journey as a tree: sent → arrived → (each onward transfer, or the loan it paid)."""
        node = hop(t, 'sent', likely)
        if t['linked'] in by_id and depth < 6:
            c = by_id[t['linked']]
            node['then'] = [{**hop(c, 'arrived', False), 'then': [follow(d, True, depth + 1) for d in nxt[c['id']]]}]
        elif name := loan_of(t):
            node['then'] = [{**hop(t, 'loan', False), 'account': name, 'kind': 'loan', 'desc': ''}]
        elif likely:  # money that left your accounts: to a person or a shop
            node['way'] = 'paid'
        return node
    flat = lambda n: [n] + [m for k in n['then'] for m in flat(k)]
    journeys = [follow(d, False) for d in sorted((t for t in every if t['direction'] == 'debit' and t['id'] not in used and t['linked'] in by_id),
                                                 key=lambda t: t['received_at'])]
    journeys = [j for j in journeys if any(inside(by_id[n['id']]) for n in flat(j))]
    plain = lambda d: {k: round(v, 2) for k, v in d.items()}
    return {'accounts': sorted(({**a, 'in': plain(a['in']), 'out': plain(a['out'])} for a in accounts.values()), key=lambda a: -a['count']),
            'flows': sorted(({**f, 'sent': plain(f['sent']), 'got': plain(f['got']), 'proof': f['proof'][::-1][:20]} for f in flows.values()),
                            key=lambda f: (-f['count'], f['from'])),
            'journeys': journeys[::-1][:60], 'unmatched': unmatched(every, inside)}


def unmatched(every, inside):
    """Transfers in the period with no other side found, newest first, each with the likeliest other sides (opposite
    way, another account, within a week; same amount or an exchange rate first) for you to link by hand."""
    def fits(a, b):
        if a['currency'] == b['currency']:
            return abs(a['amount'] - b['amount']) <= 0.02 * max(a['amount'], b['amount'])
        d, c = (a, b) if a['direction'] == 'debit' else (b, a)
        rng = FX_RATIO.get((d['currency'], c['currency']))
        return bool(rng) and rng[0] <= c['amount'] / d['amount'] <= rng[1]
    open_ = [t for t in every if not t['linked'] and t['category'] != IGNORED and transfer_like(t) and not PURCHASE.search(t['body'])]
    out = []
    for t in sorted((t for t in open_ if inside(t)), key=lambda t: t['received_at'], reverse=True)[:40]:
        day = date.fromisoformat(t['received_at'][:10])
        near = [o for o in every if o['direction'] != t['direction'] and o['account'] != t['account'] and not o['linked']
                and abs((date.fromisoformat(o['received_at'][:10]) - day).days) <= 7 and o['category'] != IGNORED]
        near.sort(key=lambda o: (not fits(t, o), abs((date.fromisoformat(o['received_at'][:10]) - day).days)))
        pick = lambda o: {k: o[k] for k in ('id', 'account', 'amount', 'currency', 'direction', 'merchant')} | {'day': o['received_at'][:10], 'fits': fits(t, o)}
        out.append({**pick(t), 'body': t['body'], 'candidates': [pick(o) for o in near[:6]]})
    return out


WORDING = 'sms:'  # merchant_categories keys starting with this are message wordings, not merchant names


def wording(body):
    """A message's wording without its numbers (amounts, dates, references, card digits), so
    'Salary credited SAR 9,000 on 01/10' and 'Salary credited SAR 9,500 on 01/11' count as similar."""
    return WORDING + ' '.join(re.sub(r'[\d٠-٩][\d٠-٩,.:/*-]*', '#', body.lower()).split())


def set_category(db, txn_id, category, whole_merchant):
    """Save a correction. With whole_merchant, every past and future transaction from that merchant follows it;
    for a message with no merchant, every message with the same wording does."""
    found = db.run('SELECT body FROM transactions WHERE id = :id', id=txn_id)
    if not found:
        raise KeyError('no such transaction')
    merchant = merchant_of(found[0]['body']).strip().lower() or wording(found[0]['body'])
    if category != OWN_TRANSFER:
        db.run('DELETE FROM txn_links WHERE debit_id = :id OR credit_id = :id', id=txn_id)
    if whole_merchant:
        db.run('INSERT INTO merchant_categories (merchant, category) VALUES (:m, :c) '
               'ON CONFLICT (merchant) DO UPDATE SET category = excluded.category', m=merchant, c=category)
        db.run('DELETE FROM txn_categories WHERE txn_id = :id', id=txn_id)  # so this one follows the merchant rule too
    else:
        db.run('INSERT INTO txn_categories (txn_id, category) VALUES (:id, :c) '
               'ON CONFLICT (txn_id) DO UPDATE SET category = excluded.category', id=txn_id, c=category)


def set_friend(db, txn_id, friend, theirs_minor):
    """Tag a transaction with a friend and their share of it (for a credit: they paid you back). No name removes the tag.
    A name typed again in other capitals is the same friend."""
    found = db.run('SELECT amount_minor, direction FROM transactions WHERE id = :id', id=txn_id)
    if not found:
        raise KeyError('no such transaction')
    if not friend:
        db.run('DELETE FROM txn_friends WHERE txn_id = :id', id=txn_id)
        return
    known = {r['friend'].lower(): r['friend'] for r in db.run('SELECT DISTINCT friend FROM txn_friends')}
    friend = known.get(friend.lower(), friend)
    amount, credit = found[0]['amount_minor'], found[0]['direction'] == 'credit'
    if not credit and not 0 < theirs_minor <= amount:
        raise ValueError('their share must be more than 0 and at most the amount')
    db.run('INSERT INTO txn_friends (txn_id, friend, theirs_minor, settled) VALUES (:id, :f, :t, 0) '
           'ON CONFLICT (txn_id) DO UPDATE SET friend = excluded.friend, theirs_minor = excluded.theirs_minor, settled = 0',
           id=txn_id, f=friend, t=amount if credit else theirs_minor)


def delete_transaction(db, txn_id):
    """Remove a transaction for good: its SMS is remembered so it isn't stored again when the phone resends it."""
    found = db.run('SELECT body FROM transactions WHERE id = :id', id=txn_id)
    if not found:
        raise KeyError('no such transaction')
    db.run('INSERT INTO deleted_sms (body) VALUES (:b) ON CONFLICT (body) DO NOTHING', b=found[0]['body'])
    for table, key in (('txn_categories', 'txn_id'), ('txn_friends', 'txn_id'), ('transactions', 'id')):
        db.run(f'DELETE FROM {table} WHERE {key} = :id', id=txn_id)


def settle_friend(db, friend, currency):
    """Square up with a friend in one currency: everything so far stops counting toward what they owe."""
    db.run('UPDATE txn_friends SET settled = 1 WHERE friend = :f AND txn_id IN (SELECT id FROM transactions WHERE currency = :c)',
           f=friend, c=currency)


def plan(loans, extra, strategy=None):
    """Pay the loans off month by month: interest is added (yearly rate / 12), then each loan's EMI is paid.
    With a strategy, the extra per month and the EMIs of loans already paid off go to one loan at a time:
    'avalanche' = highest rate first (least interest), 'snowball' = smallest balance first (fastest wins).
    Without one ('as is'), each loan just pays its own EMI. Returns months to debt-free (None if never),
    total interest, the month each loan is paid off, and `curve`: what's still owed in total at the end of each
    month (whole units, the first 30 years) for the graphs. Amounts in minor units."""
    bal = {l['id']: l['balance_now'] for l in loans if l['balance_now'] > 0}
    rate = {l['id']: l['rate_bp'] / 120000 for l in loans}
    emi = {l['id']: l['emi_minor'] for l in loans}
    budget, done, interest, month, curve = sum(emi[i] for i in bal) + extra, {}, 0, 0, []
    while bal and month < PLAN_MONTHS:
        month += 1
        for i in bal:
            charge = round(bal[i] * rate[i])
            interest += charge
            bal[i] += charge
        left = budget
        for i in bal:  # every loan gets its EMI first
            paid = min(emi[i], bal[i])
            bal[i] -= paid
            left -= paid
        if strategy:
            key = (lambda i: (-rate[i], bal[i])) if strategy == 'avalanche' else (lambda i: (bal[i], -rate[i]))
            for i in sorted(bal, key=key):
                paid = min(max(left, 0), bal[i])
                bal[i] -= paid
                left -= paid
        for i in [i for i in bal if bal[i] <= 0]:
            done[i] = month
            del bal[i]
        if month <= 360:
            curve.append(round(sum(bal.values()) / 100))
    return {'months': None if bal else month, 'interest': interest, 'payoff': done, 'curve': curve}


DEBTS = ('loan', 'card')


def auto_emis(h, taken, today):
    """The EMIs an auto-debited debt has paid since its balance was entered: one on each due day up to today,
    except in months where an SMS or a payment you recorded already shows it (`taken`: those months)."""
    out, month = [], h['as_of'][:7]
    while month <= today[:7]:
        y, m = map(int, month.split('-'))
        day = f'{month}-{min(h["due_day"], [31, 29 if y % 4 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]):02d}'
        if h['as_of'] < day <= today and month not in taken:
            out.append({'date': day, 'amount': h['emi_minor'] / 100, 'source': 'auto'})
        month = f'{y + m // 12:04d}-{m % 12 + 1:02d}'
    return out


def money(db, currency='INR', extra=0, every=None, rate=None, today=None, options=()):
    """Loans and credit cards (with today's balance after the SMS since it was entered) and savings, plus payoff
    plans for all of them in `currency` (the others converted at `rate`, INR per SAR): as they are, and with
    `extra` a month by each strategy. A card's balance goes up with each purchase SMS and down with each payment."""
    every = transactions(db) if every is None else every
    items, recorded = [], defaultdict(list)
    for r in db.run('SELECT * FROM loan_payments ORDER BY paid_on, id'):
        recorded[r['holding_id']].append(r)
    for h in db.run('SELECT * FROM holdings ORDER BY kind, id'):
        h = dict(h)
        h['balance_now'], h['payments'] = h['balance_minor'], []
        h['charges'] = []
        if h['kind'] in DEBTS:
            key, card = h['pattern'].strip().lower(), h['kind'] == 'card'
            seen = [t for t in every if key and t['currency'] == h['currency'] and t['received_at'][:10] > h['as_of']
                    and t['category'] not in NOT_COUNTED and key in t['body'].lower()]
            # A loan's matching SMS are EMIs going out. A card's are purchases (debits) and payments in (credits).
            sms = [{'id': t['id'], 'date': t['received_at'][:10], 'amount': t['amount'], 'source': 'sms'} for t in seen
                   if t['direction'] == ('credit' if card else 'debit')]
            if card:
                h['charges'] = [{'id': t['id'], 'date': t['received_at'][:10], 'amount': t['amount']} for t in seen if t['direction'] == 'debit']
                h['balance_now'] += round(sum(c['amount'] for c in h['charges']) * 100)
            sms_months = {p['date'][:7] for p in sms}
            mine = [{'pid': r['id'], 'date': r['paid_on'], 'amount': r['amount_minor'] / 100, 'source': r['note'] or 'manual'}
                    for r in recorded[h['id']] if r['paid_on'] >= h['as_of']  # recorded on the day you typed the balance: after it
                    and not (r['note'] == 'EMI' and r['paid_on'][:7] in sms_months)]  # the SMS turned up after all: count it once
            if h['auto'] and h['due_day'] and h['emi_minor']:
                today = today or datetime.now(ZoneInfo(os.environ.get('EXPENSE_TZ') or 'Asia/Riyadh')).date().isoformat()
                mine += auto_emis(h, sms_months | {p['date'][:7] for p in mine if p['source'] == 'EMI'}, today)
            interest_month = None
            for p in sorted(sms + mine, key=lambda p: p['date']):
                # One month's interest per month with a payment (yearly rate / 12). Not on a card: its interest
                # shows up when you type the statement balance in the check-in.
                if not card and p['date'][:7] != interest_month:
                    interest_month = p['date'][:7]
                    h['balance_now'] += round(h['balance_now'] * h['rate_bp'] / 120000)
                h['balance_now'] = max(0, h['balance_now'] - round(p['amount'] * 100))
                h['payments'].append(p)
        items.append(h)
    other = [h for h in items if h['kind'] in DEBTS and h['currency'] != currency]
    if other and not rate:
        rate = (inr_per_sar() or {}).get('rate') or 24.9
    factor = lambda h: 1 if h['currency'] == currency else rate if currency == 'INR' else 1 / rate
    loans = [{**h, 'balance_now': round(h['balance_now'] * factor(h)), 'emi_minor': round(h['emi_minor'] * factor(h))}
             for h in items if h['kind'] in DEBTS]
    as_is = plan(loans, 0)
    # What prepaying 1 lakh (or 1,000 SAR) on each loan today would save, for the suggestions.
    lump, prepay = 1_00000_00 if currency == 'INR' else 1000_00, {}
    for h in loans:
        if h['balance_now'] > 0:
            after = plan([{**l, 'balance_now': max(0, l['balance_now'] - lump)} if l is h else l for l in loans], 0)  # in `currency`
            prepay[h['id']] = {'interest': as_is['interest'] - after['interest'],
                               'months': (as_is['payoff'].get(h['id']) or PLAN_MONTHS) - (after['payoff'].get(h['id']) or PLAN_MONTHS)}
    # Ways to close the debt faster: each extra a month, by both strategies (for the Plan tab to choose from).
    choices = [{'extra': e / 100, 'avalanche': plan(loans, e, 'avalanche'), 'snowball': plan(loans, e, 'snowball')} for e in options]
    return {'holdings': items, 'currency': currency, 'rate': rate, 'extra': extra / 100, 'lump': lump / 100, 'prepay': prepay, 'options': choices,
            'plans': {'as_is': as_is, 'avalanche': plan(loans, extra, 'avalanche'), 'snowball': plan(loans, extra, 'snowball')}}


# Open exchange-rate services, no key needed. SAR is pegged at 3.75 to the dollar, so the dollar rate works too.
# Each gives (₹ per SAR, ₹ per USD).
RATE_SOURCES = [('open.er-api.com', 'https://open.er-api.com/v6/latest/SAR', lambda d: (d['rates']['INR'], d['rates']['INR'] / d['rates']['USD'])),
                ('frankfurter.dev', 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR', lambda d: (d['rates']['INR'] / 3.75, d['rates']['INR']))]
RATE_TTL = 6 * 3600
# Gold, US dollars per troy ounce (no key needed). 31.1035 g to the ounce.
GOLD_SOURCE = ('gold-api.com', 'https://api.gold-api.com/price/XAU', lambda d: d['price'])
GRAMS_PER_OUNCE = 31.1035
KARATS = {24, 22, 21, 18, 14}
_rate = {}


def inr_per_sar(now=None):
    """Today's ₹ per SAR (rate) and ₹ per USD (usd) from the first service that answers, kept for 6 hours.
    None if none answers."""
    now = now or time.time()
    if _rate.get('value') and now - _rate['at'] < RATE_TTL:
        return _rate['value']
    if now - _rate.get('failed_at', 0) < 600:  # every service just failed: don't make each request wait 10 s again
        return None
    for name, url, pick in RATE_SOURCES:
        try:
            with urlopen(url, timeout=5) as r:
                sar, usd = (round(float(v), 4) for v in pick(json.load(r)))
            if 10 < sar < 100 and 30 < usd < 300:  # a wildly wrong number is worse than none
                _rate.update(at=now, value={'rate': sar, 'usd': usd, 'source': name, 'at': datetime.now(timezone.utc).isoformat(timespec='minutes')})
                try:  # gold is extra: the rates stand without it
                    with urlopen(GOLD_SOURCE[1], timeout=5) as g:
                        oz = float(GOLD_SOURCE[2](json.load(g)))
                    if 500 < oz < 20000:
                        _rate['value'].update(gold_usd_oz=round(oz, 2), gold_source=GOLD_SOURCE[0])
                except (OSError, ValueError, KeyError, TypeError):
                    pass
                return _rate['value']
        except (OSError, ValueError, KeyError, TypeError):
            continue
    _rate['failed_at'] = now
    return None


# Credit-card due reminders: '…VISA Card is due on 25/11/2026 for SAR 8,622.00 total amount due SAR 13,845.84'.
_AMT = r'(SAR|SR|INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)'
CARD_TOTAL = re.compile(r'(?:total\s+(?:amount\s+)?due|total\s+outstanding|outstanding\s+balance|statement\s+balance)\s*(?:is|of|:)?\s*' + _AMT, re.I)
CARD_DUE = re.compile(r'(?:\bdue\b[^\n]*?\bfor\s*|minimum\s+(?:amount\s+)?(?:due|payment)\s*(?:is|of|:)?\s*)' + _AMT, re.I)
CARD_DUE_DAY = re.compile(r'\bdue\s+(?:on|by|date)?\s*:?\s*(\d{1,2})[/.-]\d{1,2}[/.-]\d{2,4}', re.I)
CARD_DIGITS = re.compile(r'(?:card|ending|\*)\D{0,12}?(\d{4})\b', re.I)
CARD_BRAND = re.compile(r'\b(visa|master\s?card|mada|amex|american\s+express)\b', re.I)


# Pay-later (Tamara, Tabby): 'Split in 6 payment confirmation: Store: Petromin Nissan Order: 6,991.92 SAR'.
PAY_LATER = re.compile(r'\b(?:split|pay)\s+in\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:interest-free\s+)?(?:payments|instal+ments)\b', re.I)
PAY_LATER_TOTAL = re.compile(r'(?:order|total|amount|purchase)[^\n\d]{0,12}?(?:' + _AMT + r'|([\d,]+(?:\.\d+)?)\s*(SAR|SR|ريال))', re.I)
PAY_LATER_STORE = re.compile(r'(?:store|merchant)\s*:\s*([^\n]{2,40})', re.I)


def pay_later(db, body, received_at):
    """A pay-later confirmation goes on the Debt tab as a 0% plan: the first part is paid at checkout, the rest one a
    month on the purchase day (taken automatically, like an EMI). Not stored as spending: the card charges that pay
    each part already are. Returns the plan's name, or None."""
    parts, total, store = PAY_LATER.search(body), PAY_LATER_TOTAL.search(body), PAY_LATER_STORE.search(body)
    n = parts and int(parts.group(1) or parts.group(2))
    if not (total and n and 2 <= n <= 24):
        return None
    cur, amount = (total.group(1), total.group(2)) if total.group(1) else (total.group(4), total.group(3))
    owed = round(float(amount.replace(',', '')) * 100)
    part, when = round(owed / n), received_at[:10]
    name = f"Pay later · {' '.join(store.group(1).split()) if store else 'purchase'}"
    if not any(h['name'] == name and h['as_of'] == when for h in db.run("SELECT name, as_of FROM holdings WHERE kind = 'loan'")):  # phone resends
        save_holding(db, {'id': None, 'kind': 'loan', 'auto': 1, 'name': name[:60], 'currency': 'INR' if cur.upper().startswith(('INR', 'RS', '₹')) else 'SAR',
                          'balance_minor': owed - part, 'rate_bp': 0, 'emi_minor': part, 'due_day': min(28, int(when[8:])), 'pattern': '', 'as_of': when})
    return name


def card_statement(db, body, received_at):
    """A card's due reminder puts the card on the Debt page, or updates what's owed, the payment due and the due
    day from it (a reminder older than the card's last update is ignored). Returns the card's name, or None."""
    total = CARD_TOTAL.search(body) if re.search(r'\bcard\b', body, re.I) else None
    if not total:
        return pay_later(db, body, received_at)
    minor = lambda m: round(float(m.group(2).replace(',', '')) * 100)
    currency = 'INR' if total.group(1).upper().startswith(('INR', 'RS', '₹')) else 'SAR'
    due, day, digits, brand = CARD_DUE.search(body), CARD_DUE_DAY.search(body), CARD_DIGITS.search(body), CARD_BRAND.search(body)
    digits = digits and digits.group(1)
    name = f"{brand.group(1).title() if brand else 'Credit'} card" + (f' ••{digits}' if digits else '')
    when = received_at[:10]
    cards = [c for c in db.run("SELECT * FROM holdings WHERE kind = 'card'") if c['currency'] == currency]
    card = (next((c for c in cards if digits and c['pattern'] == digits), None) or next((c for c in cards if c['name'] == name), None)
            or (cards[0] if len(cards) == 1 and not digits else None))  # one card in that currency: the reminder is about it
    owed, pay = minor(total), minor(due) if due else minor(total)
    if card:
        if when >= card['as_of']:
            db.run('UPDATE holdings SET balance_minor = :b, emi_minor = :e, due_day = :d, as_of = :a WHERE id = :id',
                   b=owed, e=pay, d=int(day.group(1)) if day else card['due_day'], a=when, id=card['id'])
        return card['name']
    save_holding(db, {'id': None, 'kind': 'card', 'auto': 0, 'name': name, 'currency': currency, 'balance_minor': owed, 'rate_bp': 0,
                      'emi_minor': pay, 'due_day': int(day.group(1)) if day else 0, 'pattern': digits or '', 'as_of': when})
    return name


def snapshot(db, m, month=None):
    """Keep this month's totals (INR) for the history graphs; later looks in the same month replace it."""
    usd = m.get('usd') or (m['rate'] or 24.9) * 3.75
    def inr(h, v):
        if h['currency'] == 'GOLD':  # v = grams × 100; value = grams × purity × ₹ a gram of 24K
            return round(v * h['rate_bp'] / 2400 * (m.get('gold_inr_g') or 0))
        return v if h['currency'] == 'INR' else round(v * usd) if h['currency'] == 'USD' else round(v * (m['rate'] or 24.9))
    debt = sum(inr(h, h['balance_now']) for h in m['holdings'] if h['kind'] in DEBTS)
    saved = sum(inr(h, h['balance_now']) for h in m['holdings'] if h['kind'] == 'saving')
    month = month or datetime.now(ZoneInfo(os.environ.get('EXPENSE_TZ') or 'Asia/Riyadh')).strftime('%Y-%m')
    db.run('INSERT INTO snapshots (month, debt_minor, savings_minor) VALUES (:m, :d, :s) '
           'ON CONFLICT (month) DO UPDATE SET debt_minor = excluded.debt_minor, savings_minor = excluded.savings_minor', m=month, d=debt, s=saved)


def record_payment(db, holding_id, paid_on, amount_minor, note):
    if not db.run("SELECT id FROM holdings WHERE id = :id AND kind IN ('loan', 'card')", id=holding_id):
        raise KeyError('no such loan')
    db.run('INSERT INTO loan_payments (holding_id, paid_on, amount_minor, note) VALUES (:h, :d, :a, :n)',
           h=holding_id, d=paid_on, a=amount_minor, n=note)


def plan_month(db, month):
    """This month's check-in actions and last month's, for the review."""
    y, m = map(int, month.split('-'))
    previous = f'{y - (m == 1):04d}-{(m - 2) % 12 + 1:02d}'
    rows = lambda mo: db.run('SELECT * FROM plan_actions WHERE month = :m ORDER BY at', m=mo)
    return {'month': month, 'actions': rows(month), 'previous_month': previous, 'previous': rows(previous)}


def save_action(db, a):
    db.run('INSERT INTO plan_actions (month, kind, ref, target_minor, actual_minor, status, at) '
           'VALUES (:month, :kind, :ref, :target_minor, :actual_minor, :status, :at) '
           'ON CONFLICT (month, kind, ref) DO UPDATE SET target_minor = excluded.target_minor, '
           'actual_minor = excluded.actual_minor, status = excluded.status, at = excluded.at', **a)


def save_holding(db, h):
    if h.get('id'):
        if not db.run('SELECT id FROM holdings WHERE id = :id', id=h['id']):
            raise KeyError('no such loan or saving')
        db.run('UPDATE holdings SET kind = :kind, name = :name, currency = :currency, balance_minor = :balance_minor, rate_bp = :rate_bp, '
               'emi_minor = :emi_minor, due_day = :due_day, pattern = :pattern, as_of = :as_of, auto = :auto WHERE id = :id', **h)
    else:
        db.run('INSERT INTO holdings (kind, name, currency, balance_minor, rate_bp, emi_minor, due_day, pattern, as_of, auto) '
               'VALUES (:kind, :name, :currency, :balance_minor, :rate_bp, :emi_minor, :due_day, :pattern, :as_of, :auto)',
               **{k: v for k, v in h.items() if k != 'id'})


def mine(t):
    """Your part of a transaction in minor units: the amount less a friend's share."""
    return round((t['amount'] - t['theirs']) * 100)


# Neon (AWS) region -> the Vercel region in the same city, where the server should run.
VERCEL_REGION_FOR = {'us-east-1': 'iad1', 'us-east-2': 'cle1', 'us-west-2': 'pdx1', 'eu-central-1': 'fra1',
                     'eu-west-2': 'lhr1', 'ap-southeast-1': 'sin1', 'ap-southeast-2': 'syd1', 'sa-east-1': 'gru1'}


def health(db, database_ms):
    """Where the server and the database run, and how long a database round trip took. No secrets."""
    host = urlparse(db.url).hostname or '' if db.pg else ''
    db_region = next((part for part in host.split('.') if part in VERCEL_REGION_FOR), 'local' if not db.pg else 'unknown')
    server_region = os.environ.get('VERCEL_REGION', 'local')
    best = VERCEL_REGION_FOR.get(db_region)
    return {
        'version': VERSION, 'server_region': server_region, 'database_region': db_region, 'database_ms': database_ms,
        'reused_connection': db.reused,
        'advice': f'Run the server in {best} (vercel.json "regions") to sit next to the database.'
                  if best and best != server_region else 'Server and database are in the same place.',
    }


SEARCH_LIMIT = 200


def search(db, q, currency=None):
    """Transactions from every month whose SMS, merchant, category or card contain all the words in q
    (case-insensitive, Arabic or Western digits), newest first."""
    words = q.lower().translate(ARABIC_DIGITS).split()
    if not words:
        return {'results': [], 'count': 0, 'spent': 0}
    hits = [t for t in transactions(db, currency=currency)
            if all(w in ' '.join((t['body'], t['merchant'], t['category'], t['account'])).lower().translate(ARABIC_DIGITS)
                   for w in words)]
    spent = sum(mine(t) for t in hits if t['direction'] == 'debit' and t['category'] not in NOT_COUNTED) / 100
    return {'results': hits[:SEARCH_LIMIT], 'count': len(hits), 'spent': round(spent, 2)}


def summary(db, month=None, currency=None, every=None):
    every = transactions(db) if every is None else every
    currencies = sorted({t['currency'] for t in every})
    # INR and SAR are never added together; SAR is the main account, so it is shown first.
    currency = currency or ('SAR' if 'SAR' in currencies or not every else every[0]['currency'])
    rows = [t for t in every if t['currency'] == currency]

    months = defaultdict(lambda: {'spent': 0, 'received': 0})
    for t in rows:
        totals = months[t['received_at'][:7]]  # the month is listed even if everything in it is ignored
        if t['category'] not in NOT_COUNTED:
            totals['spent' if t['direction'] == 'debit' else 'received'] += mine(t)
    month = month or max(months, default=datetime.now(timezone.utc).strftime('%Y-%m'))

    by_category, by_merchant, by_account = defaultdict(int), defaultdict(int), defaultdict(int)
    for t in rows:
        if t['received_at'].startswith(month) and t['direction'] == 'debit' and t['category'] not in NOT_COUNTED:
            minor = mine(t)
            if not minor:  # bought entirely for a friend
                continue
            by_category[t['category']] += minor
            by_merchant[t['merchant'] or '(unknown)'] += minor
            by_account[t['account']] += minor

    major = lambda d: {k: v / 100 for k, v in sorted(d.items(), key=lambda kv: -kv[1])}
    return {
        'currency': currency,
        'currencies': currencies,
        'month': month,
        'months': [{'month': m, 'spent': v['spent'] / 100, 'received': v['received'] / 100} for m, v in sorted(months.items())],
        'by_category': major(by_category),
        'top_merchants': dict(list(major(by_merchant).items())[:10]),
        'by_account': major(by_account),
        # Choices for the category editor: the built-in ones plus any you invented.
        'categories': sorted({*json.loads(RULES.read_text(encoding='utf-8')), 'Income', *(t['category'] for t in every)} - {'Uncategorized', *NOT_COUNTED}),
        # The month's transactions too (ignored ones included, so they can be un-ignored), in one request.
        'transactions': [t for t in rows if t['received_at'].startswith(month)],
        # Every month's uncategorized ones, newest first, for the "Needs a category" list.
        'to_review': [t for t in rows if t['category'] == 'Uncategorized'],
        'version': VERSION,
        'deliveries': db.run('SELECT d.id, d.at, d.sender, d.outcome, s.body FROM phone_deliveries d '
                             'LEFT JOIN skipped_sms s ON s.delivery_id = d.id ORDER BY d.id DESC LIMIT 20'),
    }


def refreshed(db, query, every=None):
    """The updated dashboard after a change, plus every transaction in its currency, so the page
    recomputes all its analytics from one reply."""
    every = transactions(db) if every is None else every
    result = summary(db, query.get('month'), query.get('currency'), every)
    return {'summary': result, 'all': [t for t in every if t['currency'] == result['currency']]}


def _token():
    token = os.environ.get('EXPENSE_TOKEN', '').strip()  # a space pasted into Vercel's value box shouldn't lock you out
    return token if len(token) >= MIN_PASSWORD else None


def _sign(expires):
    return hmac.new(_token().encode(), f'session:{expires}'.encode(), hashlib.sha256).hexdigest()


def new_session():
    """Cookie value '<expiry>.<signature>': stateless, so it works across Vercel instances; changing EXPENSE_TOKEN logs everyone out."""
    expires = int(time.time()) + SESSION_DAYS * 86400
    return f'{expires}.{_sign(expires)}'


def client_ip(environ):
    # Vercel overwrites X-Forwarded-For with the real client address, so it can't be spoofed there.
    return (environ.get('HTTP_X_FORWARDED_FOR') or environ.get('REMOTE_ADDR') or '?').split(',')[0].strip()


def check_password(environ, given):
    """'ok', 'wrong' or 'locked'. A short password is guessable, so every wrong guess is recorded per IP
    (in the database, because Vercel instances share no memory) and MAX_FAILURES of them lock that IP out."""
    db = DB()
    try:
        ip, now = client_ip(environ), int(time.time())
        recent = db.run('SELECT COUNT(*) AS n FROM login_failures WHERE ip = :ip AND at > :since',
                        ip=ip, since=now - LOCKOUT_SECONDS)[0]['n']
        if recent >= MAX_FAILURES:
            return 'locked'
        if hmac.compare_digest(given.strip().encode(), _token().encode()):  # strip: phone keyboards add trailing spaces
            return 'ok'
        db.run('DELETE FROM login_failures WHERE at <= :since', since=now - LOCKOUT_SECONDS)
        db.run('INSERT INTO login_failures (ip, at) VALUES (:ip, :at)', ip=ip, at=now)
        return 'wrong'
    finally:
        db.close()


def bearer_ok(environ):
    """The phone authenticates with 'Authorization: Bearer <EXPENSE_TOKEN>'; guesses here count toward the lockout too."""
    header = environ.get('HTTP_AUTHORIZATION', '')
    return bool(_token()) and header.startswith('Bearer ') and check_password(environ, header[7:]) == 'ok'


def session_ok(environ):
    """The browser authenticates with the cookie set by the login page."""
    cookie = SimpleCookie(environ.get('HTTP_COOKIE', '')).get('session')
    expires, _, sig = (cookie.value if cookie else '').partition('.')
    return bool(_token()) and expires.isdigit() and int(expires) > time.time() and hmac.compare_digest(sig, _sign(expires))


def read_form(environ):
    length = int(environ.get('CONTENT_LENGTH') or 0)
    if not 0 < length <= MAX_BODY:
        return {}
    return {k: v[0] for k, v in parse_qs(environ['wsgi.input'].read(length).decode(errors='replace')).items()}


def read_sms(environ):
    """Validate the phone's POST. Accepts JSON or form fields: sender, body, received_at (optional ISO 8601 or epoch ms)."""
    length = int(environ.get('CONTENT_LENGTH') or 0)
    if not 0 < length <= MAX_BODY:
        raise ValueError('body size')
    raw = environ['wsgi.input'].read(length)
    if environ.get('CONTENT_TYPE', '').startswith('application/x-www-form-urlencoded'):
        msg = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
    else:
        msg = json.loads(raw)
    return clean_message(msg)


def clean_message(msg):
    """(sender, body, received_at) from one message dict; raises ValueError/KeyError/TypeError when it's malformed."""
    sender, body = str(msg['sender']).strip(), str(msg['body']).strip()
    if len(sender) > 40 or '\n' in sender or sender == body:  # an iPhone Shortcut sending the message as its sender
        sender = 'iPhone'
    received_at = str(msg.get('received_at') or '').strip()
    if received_at.isdigit():  # epoch milliseconds from the phone; shown in EXPENSE_TZ so months split at local midnight
        when = datetime.fromtimestamp(int(received_at) / 1000, ZoneInfo(os.environ.get('EXPENSE_TZ') or 'Asia/Riyadh'))
        received_at = when.isoformat(timespec='seconds')
    received_at = received_at or datetime.now(timezone.utc).isoformat(timespec='seconds')
    datetime.fromisoformat(received_at)  # reject junk dates; they would break month grouping
    return sender, body, received_at


def read_json(environ, limit):
    """JSON request body from the dashboard. JSON only, so a cross-site form can't submit it with the browser's cookie."""
    length = int(environ.get('CONTENT_LENGTH') or 0)
    if not 0 < length <= limit or not environ.get('CONTENT_TYPE', '').startswith('application/json'):
        raise ValueError(f'expected a JSON body up to {limit} bytes')
    return json.loads(environ['wsgi.input'].read(length))


def read_category(environ):
    """{"id": 12, "category": "Food", "whole_merchant": true} from the category editor."""
    msg = read_json(environ, MAX_BODY)
    category = ' '.join(str(msg['category']).split())
    if not 0 < len(category) <= MAX_CATEGORY or category == 'Uncategorized':
        raise ValueError(f'category must be 1-{MAX_CATEGORY} characters')
    return int(msg['id']), category, bool(msg.get('whole_merchant', True))


def read_friend(environ):
    """{"id": 12, "friend": "Ali", "theirs": "50.00"} from a transaction; an empty friend removes the tag."""
    msg = read_json(environ, MAX_BODY)
    friend = ' '.join(str(msg.get('friend') or '').split())
    if len(friend) > MAX_FRIEND:
        raise ValueError(f'a name is at most {MAX_FRIEND} characters')
    theirs = int(Decimal(str(msg.get('theirs') or 0).replace(',', '').strip()) * 100)
    return int(msg['id']), friend, theirs


def read_payment(environ):
    """{"holding_id": 3, "amount": "57500", "paid_on": "2026-12-05", "note": "EMI" | "Extra"}"""
    msg = read_json(environ, MAX_BODY)
    amount = int(Decimal(str(msg['amount']).replace(',', '').strip()) * 100)
    paid_on = str(msg['paid_on'])
    datetime.strptime(paid_on, '%Y-%m-%d')
    note = str(msg.get('note') or '')
    if not 0 < amount < 10 ** 13 or note not in ('EMI', 'Extra', ''):
        raise ValueError('amount must be more than 0; note EMI or Extra')
    return int(msg['holding_id']), paid_on, amount, note


def read_action(environ):
    """{"month": "2026-12", "kind": "extra", "ref": "3", "target": "20000", "actual": "0", "status": "planned"}"""
    msg = read_json(environ, MAX_BODY)
    minor = lambda v: int(Decimal(str(v or 0).replace(',', '').strip()) * 100)
    a = {'month': str(msg['month']), 'kind': msg['kind'], 'ref': str(msg.get('ref') or '')[:60], 'target_minor': minor(msg.get('target')),
         'actual_minor': minor(msg.get('actual')), 'status': msg['status'], 'at': datetime.now(timezone.utc).isoformat(timespec='seconds')}
    datetime.strptime(a['month'], '%Y-%m')
    if a['kind'] not in PLAN_KINDS or a['status'] not in PLAN_STATUS or not 0 <= a['target_minor'] < 10 ** 13 or not 0 <= a['actual_minor'] < 10 ** 13:
        raise ValueError('unknown step or status, or a bad amount')
    return a


def read_holding(environ):
    """A loan or saving from the Money page: {kind, name, currency, balance, rate, emi, due_day, match, as_of, id?}."""
    msg = read_json(environ, MAX_BODY)
    minor = lambda v: int(Decimal(str(v or 0).replace(',', '').strip()) * 100)
    h = {'id': int(msg['id']) if msg.get('id') else None, 'kind': msg['kind'], 'name': ' '.join(str(msg['name']).split()),
         'currency': msg['currency'], 'balance_minor': minor(msg.get('balance')), 'rate_bp': minor(msg.get('rate')),
         'emi_minor': minor(msg.get('emi')), 'due_day': int(msg.get('due_day') or 0), 'pattern': ' '.join(str(msg.get('match') or '').split()),
         'as_of': str(msg.get('as_of') or datetime.now(timezone.utc).date().isoformat()),
         'auto': 1 if msg.get('auto') in (True, 1, '1', 'on', 'true') else 0}
    datetime.strptime(h['as_of'], '%Y-%m-%d')
    if h['currency'] in ('USD', 'GOLD') and h['kind'] != 'saving':
        raise ValueError('USD and gold are for savings and investments')
    # Gold is kept in grams (balance) and karats (in the rate column, which savings don't otherwise use).
    if h['currency'] == 'GOLD' and h['rate_bp'] // 100 not in KARATS:
        raise ValueError(f'purity must be one of {sorted(KARATS)} karat')
    if (h['kind'] not in ('loan', 'card', 'saving') or h['currency'] not in ('SAR', 'INR', 'USD', 'GOLD') or not 0 < len(h['name']) <= 40
            or not 0 <= h['balance_minor'] < 10 ** 13 or not 0 <= h['rate_bp'] <= 6000 or not 0 <= h['emi_minor'] < 10 ** 11
            or not 0 <= h['due_day'] <= 31 or len(h['pattern']) > 40):
        raise ValueError('check the name (1-40 letters), amounts, rate (0-60 %) and due day (1-31)')
    return h


def read_import(environ):
    """A batch from the import page: JSON {"messages": [{sender, body, received_at}, ...]}."""
    messages = read_json(environ, MAX_IMPORT_BODY)['messages']
    if not isinstance(messages, list) or len(messages) > MAX_IMPORT_BATCH:
        raise ValueError(f'messages must be a list of at most {MAX_IMPORT_BATCH}')
    return [clean_message(m) for m in messages]


def app(environ, start_response):
    """Any unexpected error becomes a 500 that says what went wrong (type and message, no stack or data), so the
    page's error bar can show it; the full trace still goes to the server log."""
    try:
        return _app(environ, start_response)
    except Exception as e:
        import traceback
        traceback.print_exc()
        body = json.dumps({'error': f'{type(e).__name__}: {str(e)[:200]}'}).encode()
        start_response('500 Internal Server Error', [('Content-Type', 'application/json'), ('Content-Length', str(len(body))),
                                                    ('Cache-Control', 'no-store')])
        return [body]


def _app(environ, start_response):
    def respond(status, payload, content_type='application/json', headers=()):
        data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        start_response(status, [('Content-Type', content_type), ('Content-Length', str(len(data))),
                                ('Cache-Control', 'no-store'), *headers])
        return [data]

    def redirect(location, cookie=None):
        headers = [('Location', location)]
        if cookie is not None:
            max_age = SESSION_DAYS * 86400 if cookie else 0
            headers.append(('Set-Cookie', f'session={cookie}; Max-Age={max_age}; Path=/; HttpOnly; Secure; SameSite=Lax'))
        return respond('303 See Other', b'', 'text/plain', headers)

    method, path = environ['REQUEST_METHOD'], environ.get('PATH_INFO') or '/'
    query = {k: v[0] for k, v in parse_qs(environ.get('QUERY_STRING', '')).items()}

    if method == 'GET' and path in PUBLIC:
        return respond('200 OK', (HERE / path.lstrip('/')).read_bytes(), PUBLIC[path])
    if path == '/login':
        if method == 'POST':
            if not _token():  # says only that setup is incomplete, nothing about the password itself
                return redirect('/login?error=setup')
            result = check_password(environ, read_form(environ).get('password', ''))
            if result == 'ok':
                return redirect('/', new_session())
            return redirect('/login?error=locked' if result == 'locked' else '/login?error=1')
        return respond('200 OK', (HERE / 'login.html').read_bytes(), 'text/html; charset=utf-8')
    if (method, path) == ('POST', '/logout'):
        return redirect('/login', '')

    if (method, path) == ('POST', '/sms'):
        if not bearer_ok(environ):  # phone only: the cookie isn't accepted here, so no cross-site form can add SMS
            refused = DB()
            try:
                record_delivery(refused, '?', 'refused: wrong password in the phone app')
            finally:
                refused.close()
            return respond('401 Unauthorized', {'error': 'unauthorized'})
        try:
            sms = read_sms(environ)
        except (ValueError, KeyError, TypeError) as e:
            refused = DB()
            try:
                record_delivery(refused, '?', 'refused: the phone app sent an unreadable message')
            finally:
                refused.close()
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif not (session_ok(environ) or bearer_ok(environ)):
        return redirect('/login') if method == 'GET' and path in PAGES else respond('401 Unauthorized', {'error': 'unauthorized'})
    elif method == 'GET' and path in PAGES:
        return respond('200 OK', (HERE / PAGES[path]).read_bytes(), 'text/html; charset=utf-8')
    elif (method, path) == ('POST', '/api/import'):
        try:
            batch = read_import(environ)
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/deliveries/save'):
        try:
            keep = read_json(environ, MAX_BODY)
            amount_minor = int(Decimal(str(keep['amount']).replace(',', '').strip()) * 100)
            if not 0 < amount_minor < 10 ** 11 or keep['direction'] not in ('debit', 'credit') or keep['currency'] not in ('SAR', 'INR'):
                raise ValueError('amount, direction (debit/credit) and currency (SAR/INR) are required')
            keep = (int(keep['id']), amount_minor, keep['direction'], keep['currency'])
        except (ValueError, KeyError, TypeError, ArithmeticError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/category'):
        try:
            correction = read_category(environ)
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/friend'):
        try:
            tag = read_friend(environ)
        except (ValueError, KeyError, TypeError, ArithmeticError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/delete'):
        try:
            doomed = int(read_json(environ, MAX_BODY)['id'])
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/money'):
        try:
            holding = read_holding(environ)
        except (ValueError, KeyError, TypeError, ArithmeticError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/money/pay'):
        try:
            payment = read_payment(environ)
        except (ValueError, KeyError, TypeError, ArithmeticError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/money/pay/delete'):
        try:
            unpaid = int(read_json(environ, MAX_BODY)['id'])
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/settings'):
        try:
            setting = read_json(environ, MAX_BODY)
            if setting['key'] not in SETTING_KEYS:
                raise ValueError(f'key must be one of {sorted(SETTING_KEYS)}')
            setting = (setting['key'], json.dumps(setting['value']))
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/plan'):
        try:
            action = read_action(environ)
        except (ValueError, KeyError, TypeError, ArithmeticError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/money/delete'):
        try:
            gone = int(read_json(environ, MAX_BODY)['id'])
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/statement'):
        try:
            upload = read_json(environ, MAX_STATEMENT_BODY)
            name, kind, cur = ' '.join(str(upload['account']).split())[:60], upload['kind'], upload['currency']
            digits = re.sub(r'\D', '', str(upload.get('digits') or ''))[-4:]
            if not name or kind not in ACCOUNT_KINDS or cur not in ('SAR', 'INR', 'USD'):
                raise ValueError(f'account name, kind ({sorted(ACCOUNT_KINDS)}) and currency (SAR/INR/USD) are required')
            upload = (name, kind, cur, digits, str(upload.get('file_name') or 'statement')[:120],
                      base64.b64decode(upload['data'], validate=True), str(upload.get('password') or '') or None)
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/link'):
        try:
            pair = read_json(environ, MAX_BODY)
            pair = (int(pair['debit']), None if pair.get('credit') is None else int(pair['credit']))
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/statement/delete'):
        try:
            undone = int(read_json(environ, MAX_BODY)['id'])
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) == ('POST', '/api/friend/settle'):
        try:
            square = str(read_json(environ, MAX_BODY)['friend'])
        except (ValueError, KeyError, TypeError) as e:
            return respond('400 Bad Request', {'error': f'bad request: {e}'})
    elif (method, path) not in {('GET', '/api/summary'), ('GET', '/api/transactions'), ('GET', '/api/health'), ('GET', '/api/search'), ('GET', '/api/latest'), ('GET', '/api/money'), ('GET', '/api/rate'), ('GET', '/api/plan'), ('GET', '/api/settings'), ('GET', '/api/statements'), ('GET', '/api/trail')}:
        return respond('404 Not Found', {'error': 'not found'})

    started = time.perf_counter()
    db = DB()
    try:
        if path == '/api/health':
            db.run('SELECT 1')
            return respond('200 OK', health(db, round((time.perf_counter() - started) * 1000)))
        if path == '/api/deliveries/save':
            try:
                save_skipped(db, *keep)
            except KeyError:
                return respond('404 Not Found', {'error': 'that message is no longer kept'})
            return respond('200 OK', {'saved': True})
        if path == '/api/category':
            try:
                set_category(db, *correction)
            except KeyError:
                return respond('404 Not Found', {'error': 'no such transaction'})
            # What it now shows as (so the page can say if another rule still wins), plus the updated
            # dashboard, so saving is one request and one pass over the data instead of three.
            every = transactions(db)
            now = next(t['category'] for t in every if t['id'] == correction[0])
            return respond('200 OK', {'saved': True, 'category': now, **refreshed(db, query, every)})
        if path == '/api/friend':
            try:
                set_friend(db, *tag)
            except KeyError:
                return respond('404 Not Found', {'error': 'no such transaction'})
            except ValueError as e:
                return respond('400 Bad Request', {'error': f'bad request: {e}'})
            return respond('200 OK', {'saved': True, **refreshed(db, query)})
        if path == '/api/delete':
            try:
                delete_transaction(db, doomed)
            except KeyError:
                return respond('404 Not Found', {'error': 'no such transaction'})
            return respond('200 OK', {'deleted': True, **refreshed(db, query)})
        if path == '/api/rate':
            rate = inr_per_sar()
            return respond('200 OK' if rate else '503 Service Unavailable', rate or {'error': 'no exchange-rate service answered'})
        if path == '/api/settings':
            if method == 'POST':
                db.run('INSERT INTO settings (key, value) VALUES (:k, :v) ON CONFLICT (key) DO UPDATE SET value = excluded.value', k=setting[0], v=setting[1])
            return respond('200 OK', {r['key']: json.loads(r['value']) for r in db.run('SELECT key, value FROM settings')})
        if path == '/api/plan':
            if method == 'POST':
                save_action(db, action)
            month = action['month'] if method == 'POST' else query.get('month') or datetime.now(timezone.utc).strftime('%Y-%m')
            try:
                return respond('200 OK', plan_month(db, month))
            except ValueError:
                return respond('400 Bad Request', {'error': 'month must look like 2026-12'})
        if path.startswith('/api/money'):
            if path == '/api/money/pay':
                try:
                    record_payment(db, *payment)
                except KeyError:
                    return respond('404 Not Found', {'error': 'no such loan'})
            elif path == '/api/money/pay/delete':
                db.run('DELETE FROM loan_payments WHERE id = :id', id=unpaid)
            elif path == '/api/money' and method == 'POST':
                try:
                    save_holding(db, holding)
                except KeyError:
                    return respond('404 Not Found', {'error': 'no such loan or saving'})
            elif path == '/api/money/delete':
                db.run('DELETE FROM holdings WHERE id = :id', id=gone)
                db.run('DELETE FROM loan_payments WHERE holding_id = :id', id=gone)
            try:
                extra = int(Decimal(query.get('extra') or 0) * 100)
            except ArithmeticError:
                extra = 0
            try:
                rate = float(query.get('rate') or 0)
            except ValueError:
                rate = 0
            try:
                options = [max(0, min(int(Decimal(x) * 100), 10 ** 11)) for x in (query.get('options') or '').split(',') if x.strip()][:6]
            except ArithmeticError:
                options = []
            result = money(db, query.get('currency') or 'INR', max(0, min(extra, 10 ** 11)), rate=rate if 10 < rate < 100 else None, options=options)
            try:
                usd = float(query.get('usd') or 0)
            except ValueError:
                usd = 0
            result['usd'] = usd if 30 < usd < 300 else None  # for savings held in dollars
            try:
                gold = float(query.get('gold') or 0)  # ₹ a gram of 24K gold, from the page
            except ValueError:
                gold = 0
            result['gold_inr_g'] = gold if 1000 < gold < 100000 else None
            priced = result['gold_inr_g'] or not any(h['currency'] == 'GOLD' for h in result['holdings'])  # else gold would count as 0
            if priced and (result['currency'] == 'INR' and result['rate'] or not any(h['currency'] == 'SAR' for h in result['holdings'])):
                snapshot(db, result)
            result['history'] = db.run('SELECT * FROM snapshots ORDER BY month')
            return respond('200 OK', result)
        if path == '/api/statement':
            try:
                return respond('200 OK', import_statement(db, *upload))
            except StatementError as e:
                return respond('422 Unprocessable Entity', {'error': str(e)})
            except Exception as e:  # a file the readers choke on: say so instead of a bare 500
                print(f'statement import failed: {type(e).__name__}: {e}', file=sys.stderr)
                return respond('422 Unprocessable Entity', {'error': f'could not read this file ({type(e).__name__}). Try the Excel or CSV download instead.'})
        if path == '/api/link':
            try:
                link_by_hand(db, *pair)
            except KeyError as e:
                return respond('400 Bad Request', {'error': str(e.args[0])})
            return respond('200 OK', {'saved': True})
        if path == '/api/statement/delete':
            try:
                delete_statement(db, undone)
            except KeyError:
                return respond('404 Not Found', {'error': 'no such statement'})
            return respond('200 OK', statements(db))
        if path == '/api/statements':
            return respond('200 OK', statements(db))
        if path == '/api/trail':
            return respond('200 OK', trail(db, query.get('from'), query.get('to')))
        if path == '/api/friend/settle':
            settle_friend(db, square, query.get('currency') or 'SAR')
            return respond('200 OK', {'saved': True, **refreshed(db, query)})
        if path == '/api/import':
            stored = store_many(db, batch)
            for _, body, received_at in sorted(batch, key=lambda m: m[2]):  # oldest first, so the newest reminder wins
                card_statement(db, body, received_at)
            if environ.get('HTTP_AUTHORIZATION', '').startswith('Bearer '):  # the Expense Sync phone app (the import page uses the login cookie)
                record_delivery(db, 'Phone sync', f'{len(stored)} new of {len(batch)} checked')
            return respond('200 OK', {'received': len(batch), 'stored': len(stored)})
        if method == 'POST':
            stored = store_sms(db, *sms)
            advert = bool(AD_SENDER.search(sms[0].strip()))
            skipped = not stored and not advert and not parse(sms[1])
            card = skipped and card_statement(db, sms[1], sms[2])
            record_delivery(db, sms[0], 'advert, not counted' if advert else f'card due: {card} updated on the Debt tab' if card else 'not a transaction' if skipped
                            else 'saved' if stored else 'already had it', (sms[1], sms[2]) if skipped and not card else None)
            return respond('201 Created' if stored else '200 OK', {'stored': bool(stored), 'transaction': stored})
        if path == '/api/summary':
            return respond('200 OK', summary(db, query.get('month'), query.get('currency')))
        if path == '/api/latest':  # a tiny "anything new?" check the open app polls; one cheap query
            return respond('200 OK', db.run('SELECT COUNT(*) AS count, MAX(id) AS last_id FROM transactions')[0])
        if path == '/api/search':
            return respond('200 OK', search(db, query.get('q', ''), query.get('currency')))
        return respond('200 OK', transactions(db, query.get('month'), query.get('currency')))
    finally:
        db.close()


if __name__ == '__main__':
    from wsgiref.simple_server import make_server
    if not _token():
        raise SystemExit(f'Set EXPENSE_TOKEN to a password of at least {MIN_PASSWORD} characters.')
    host, port = os.environ.get('HOST', '127.0.0.1'), int(os.environ.get('PORT', '8000'))
    print(f'Listening on http://{host}:{port}')
    make_server(host, port, app).serve_forever()
