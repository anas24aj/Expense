"""v3 core: auth, households, ledger, ingestion. SQLite temp file by default; set TEST_DATABASE_URL (or DATABASE_URL) to a
Postgres url to run the same tests there, e.g.
  TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/core_test?sslmode=disable' python3 -m unittest discover -s tests -q
Postgres tables are dropped and recreated per test class."""
import base64
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
PG = os.environ.get('TEST_DATABASE_URL') or (os.environ.get('DATABASE_URL') if os.environ.get('DATABASE_URL', '').startswith('postgres') else '')
TMP = tempfile.mkdtemp()
os.environ['DATABASE_URL'] = PG
os.environ.pop('DATABASE_URL_UNPOOLED', None)
for k in ('RESEND_API_KEY', 'MAIL_FROM', 'EXPENSE_TOKEN'):
    os.environ.pop(k, None)

import api.db as dbmod  # noqa: E402
from api import auth  # noqa: E402
from api.app import app  # noqa: E402


def fresh_db(name):
    """A clean database for one test class."""
    dbmod._ready.clear()
    auth._secret.clear()
    if PG:
        db = dbmod.DB()
        db.run('DROP SCHEMA public CASCADE')
        db.run('CREATE SCHEMA public')
        db.run(f'DROP SCHEMA IF EXISTS {dbmod.SCHEMA} CASCADE')
        db.conn.close()
        dbmod._idle.clear()
        dbmod._ready.clear()
    else:
        os.environ['EXPENSE_DB_V3'] = os.path.join(TMP, name + '.db')


class Client:
    def __init__(self, ip='10.0.0.1'):
        self.cookies, self.ip = {}, ip

    def call(self, method, path, body=None, bearer=None):
        path, _, qs = path.partition('?')
        raw = json.dumps(body).encode() if body is not None else b''
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': qs, 'wsgi.input': io.BytesIO(raw), 'CONTENT_LENGTH': str(len(raw)),
               'REMOTE_ADDR': self.ip, 'HTTP_HOST': 'test.local', 'HTTP_COOKIE': '; '.join(f'{k}={v}' for k, v in self.cookies.items())}
        if bearer:
            env['HTTP_AUTHORIZATION'] = 'Bearer ' + bearer
        got = {}

        def start(status, headers):
            got['status'] = int(status.split()[0])
            got['headers'] = headers
        data = b''.join(app(env, start))
        for k, v in got['headers']:
            if k == 'Set-Cookie':
                name, _, rest = v.partition('=')
                value = rest.split(';')[0]
                if 'Max-Age=0' in v:
                    self.cookies.pop(name, None)
                else:
                    self.cookies[name] = value
        return got['status'], json.loads(data)

    def ok(self, method, path, body=None, status=(200, 201), **kw):
        code, out = self.call(method, path, body, **kw)
        assert code in status, (method, path, code, out)
        return out


def signup(email, name='Anas', password='correct horse', **extra):
    c = Client()
    c.ok('POST', '/api/auth/signup', {'email': email, 'password': password, 'name': name, **extra})
    return c


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fresh_db(cls.__name__)


class AuthTest(Base):
    def test_signup_login_logout_me(self):
        c = signup('a@x.com')
        me = c.ok('GET', '/api/auth/me')
        self.assertEqual(me['user']['email'], 'a@x.com')
        self.assertEqual(me['household']['name'], "Anas's family")
        self.assertEqual(me['member']['role'], 'owner')
        self.assertEqual(Client().call('POST', '/api/auth/signup', {'email': 'A@x.com', 'password': 'whatever1', 'name': 'B'})[0], 409)
        c.ok('POST', '/api/auth/logout')
        self.assertEqual(c.call('GET', '/api/auth/me')[0], 401)
        c.ok('PATCH', '/api/auth/me', None, status=(401,))
        d = Client()
        self.assertEqual(d.call('POST', '/api/auth/login', {'login': 'a@x.com', 'password': 'nope nope'})[0], 401)
        d.ok('POST', '/api/auth/login', {'login': 'a@x.com', 'password': 'correct horse'})
        d.ok('PATCH', '/api/auth/me', {'username': 'anas'})
        e = Client()
        e.ok('POST', '/api/auth/login', {'login': 'anas', 'password': 'correct horse'})
        self.assertEqual(e.ok('GET', '/api/auth/me')['user']['username'], 'anas')

    def test_lockout(self):
        signup('lock@x.com')
        c = Client(ip='10.9.9.9')
        for _ in range(10):
            self.assertEqual(c.call('POST', '/api/auth/login', {'login': 'lock@x.com', 'password': 'wrong pass'})[0], 401)
        self.assertEqual(c.call('POST', '/api/auth/login', {'login': 'lock@x.com', 'password': 'correct horse'})[0], 429)
        Client(ip='10.9.9.8').ok('POST', '/api/auth/login', {'login': 'lock@x.com', 'password': 'correct horse'})

    def test_password_change_ends_other_sessions(self):
        a = signup('pw@x.com')
        b = Client()
        b.ok('POST', '/api/auth/login', {'login': 'pw@x.com', 'password': 'correct horse'})
        self.assertEqual(a.call('POST', '/api/auth/password', {'current': 'bad', 'new': 'new password 1'})[0], 403)
        a.ok('POST', '/api/auth/password', {'current': 'correct horse', 'new': 'new password 1'})
        a.ok('GET', '/api/auth/me')
        self.assertEqual(b.call('GET', '/api/auth/me')[0], 401)

    def test_forgot_and_reset(self):
        owner = signup('reset@x.com')
        self.assertEqual(Client().ok('POST', '/api/auth/forgot', {'email': 'nobody@x.com'}), {'ok': True})
        Client().ok('POST', '/api/auth/forgot', {'email': 'reset@x.com'})
        resets = owner.ok('GET', '/api/households/current')['resets']  # no mail configured: the owner sees the link
        token = resets[0]['link'].split('t=')[1]
        c = Client()
        self.assertEqual(c.call('POST', '/api/auth/reset', {'token': 'x' * 40, 'password': 'brand new pw'})[0], 400)
        c.ok('POST', '/api/auth/reset', {'token': token, 'password': 'brand new pw'})
        c.ok('GET', '/api/auth/me')
        self.assertEqual(owner.call('GET', '/api/auth/me')[0], 401)  # the old session ended with the old password
        self.assertEqual(Client().call('POST', '/api/auth/reset', {'token': token, 'password': 'again again'})[0], 400)  # single use
        Client().ok('POST', '/api/auth/login', {'login': 'reset@x.com', 'password': 'brand new pw'})

    def test_mcp_key(self):
        c = signup('mcp@x.com')
        url = c.ok('GET', '/api/mcp-key')['url']
        self.assertEqual(c.ok('GET', '/api/mcp-key')['url'], url)
        key = url.rsplit('/', 1)[1]
        who = auth.mcp_user(key)
        self.assertEqual(who['user']['email'], 'mcp@x.com')
        c.ok('POST', '/api/mcp-key')
        self.assertIsNone(auth.mcp_user(key))


class V2CarryOverTest(Base):
    def test_old_account_signs_in_once_and_moves_over(self):
        from server import hash_password
        db = dbmod.DB()
        db.run("CREATE TABLE app_users (id TEXT, email TEXT, pw_hash TEXT, space TEXT, sync_key TEXT, created_at TEXT, last_seen TEXT)")
        db.run("INSERT INTO app_users (id, email, pw_hash) VALUES ('1', 'old@x.com', :h)", h=hash_password('old password'))
        self.assertEqual(Client().call('POST', '/api/auth/login', {'login': 'old@x.com', 'password': 'wrong one'})[0], 401)
        c = Client()
        c.ok('POST', '/api/auth/login', {'login': 'old@x.com', 'password': 'old password'})
        self.assertEqual(c.ok('GET', '/api/auth/me')['member']['role'], 'owner')
        Client().ok('POST', '/api/auth/login', {'login': 'old@x.com', 'password': 'old password'})  # second time: plain v3 login
        self.assertEqual(db.one("SELECT COUNT(*) AS n FROM users WHERE email = 'old@x.com'")['n'], 1)


class HouseholdTest(Base):
    def test_isolation(self):
        a, b = signup('ha@x.com'), signup('hb@x.com', name='B')
        acc = a.ok('POST', '/api/accounts', {'kind': 'bank', 'name': 'SNB', 'currency': 'SAR'})
        t = a.ok('POST', '/api/transactions', {'day': '2026-11-01', 'amount_minor': 1000, 'currency': 'SAR', 'merchant': 'Panda', 'account_id': acc['id']})
        self.assertEqual(b.call('GET', f"/api/transactions/{t['id']}")[0], 404)
        self.assertEqual(b.call('PATCH', f"/api/accounts/{acc['id']}", {'name': 'mine'})[0], 404)
        self.assertEqual(b.call('PATCH', f"/api/transactions/{t['id']}", {'category': 'Food'})[0], 404)
        self.assertEqual(b.ok('GET', '/api/transactions')['items'], [])
        self.assertEqual(b.ok('GET', '/api/accounts')['items'], [])
        bh = b.ok('GET', '/api/auth/me')['household']['id']
        self.assertEqual(a.call('POST', '/api/households/switch', {'household_id': bh})[0], 404)

    def test_invite_join_and_private_account(self):
        owner = signup('own@x.com')
        m = owner.ok('POST', '/api/members', {'display_name': 'Sara', 'relation': 'spouse', 'email': 'sara@x.com'})
        token = m['invite']['link'].split('t=')[1]
        prev = Client().ok('GET', f'/api/invites/{token}/preview')
        self.assertEqual(prev['email'], 'sara@x.com')
        sara = signup('sara@x.com', name='Sara', invite=token)
        me = sara.ok('GET', '/api/auth/me')
        self.assertEqual(me['member']['id'], m['id'])
        self.assertEqual(me['household']['id'], owner.ok('GET', '/api/auth/me')['household']['id'])
        self.assertEqual(Client().call('GET', f'/api/invites/{token}/preview')[0], 404)  # used
        self.assertEqual(sara.call('POST', '/api/members', {'display_name': 'X'})[0], 403)  # not an admin
        priv = owner.ok('POST', '/api/accounts', {'kind': 'credit_card', 'name': 'My card', 'currency': 'SAR', 'visibility': 'private'})
        shared = owner.ok('POST', '/api/accounts', {'kind': 'bank', 'name': 'Joint', 'currency': 'SAR'})
        t = owner.ok('POST', '/api/transactions', {'day': '2026-11-02', 'amount_minor': 500, 'currency': 'SAR', 'merchant': 'Gift', 'account_id': priv['id']})
        self.assertEqual([a['id'] for a in sara.ok('GET', '/api/accounts')['items']], [shared['id']])
        self.assertEqual(sara.call('GET', f"/api/transactions/{t['id']}")[0], 404)
        self.assertEqual(sara.ok('GET', '/api/transactions')['items'], [])
        self.assertEqual(len(owner.ok('GET', '/api/transactions')['items']), 1)

    def test_member_without_login_and_people(self):
        c = signup('fam@x.com')
        mum = c.ok('POST', '/api/members', {'display_name': 'Mum', 'relation': 'parent'})
        self.assertIsNone(mum['user_id'])
        friend = c.ok('POST', '/api/contacts', {'name': 'Ravi', 'email': 'fam@x.com'})
        self.assertTrue(friend['on_app'])
        t = c.ok('POST', '/api/transactions', {'day': '2026-11-03', 'amount_minor': 30000, 'currency': 'SAR', 'merchant': 'Dinner'})
        c.ok('POST', f"/api/transactions/{t['id']}/split", {'shares': [{'contact_id': friend['id'], 'share_minor': 10000}]})
        lend = c.ok('POST', '/api/transactions', {'day': '2026-11-04', 'amount_minor': 5000, 'currency': 'SAR', 'merchant': 'Cash to Ravi', 'purpose': 'lend'})
        c.ok('PATCH', f"/api/transactions/{lend['id']}", {'person': {'kind': 'contact', 'id': friend['id']}})
        people = {p['name']: p for p in c.ok('GET', '/api/people')['items']}
        self.assertEqual(people['Ravi']['owes_you'], [{'minor': 15000, 'currency': 'SAR'}])
        self.assertEqual(people['Mum']['on_app'], False)
        out = c.ok('POST', '/api/settle', {'person': {'kind': 'contact', 'id': friend['id']}, 'currency': 'SAR'})
        self.assertEqual(out['person']['owes_you'], [])
        dev = c.ok('POST', '/api/devices', {'name': 'iPhone', 'platform': 'iphone'})
        self.assertEqual(json.loads(dev['setup'])['key'], dev['key'])
        self.assertEqual(len(c.ok('GET', '/api/devices')['items']), 1)
        c.ok('DELETE', f"/api/devices/{dev['device']['id']}")
        self.assertEqual(Client().call('POST', '/api/ingest/sms', {'sender': 'X', 'body': 'y'}, bearer=dev['key'])[0], 401)


BANK = 'SNB'
SMS_PURCHASE = 'Purchase\nAmount: SAR 45.00\nCard: mada *1234\nAt: STARBUCKS OLAYA\nBalance: SAR 5,000.00'
SMS_CARD_PAY = 'SAR 1,000.00 debited from A/c XX5678 for credit card payment. Avl bal SAR 9,000.00'
SMS_CARD_GOT = 'Payment received SAR 1,000.00 for credit card XX9876. Thank you'
SMS_INTEREST = 'INR 450.00 debited from HDFC Bank Credit Card XX4321 towards finance charges'
SMS_UNKNOWN = 'Rs 250.00 spent on HDFC Bank Card XX4321 at ZORBLAX TRADERS on 2026-11-20'


class IngestTest(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.c = signup('sms@x.com')
        cls.key = cls.c.ok('POST', '/api/devices', {'name': 'Pixel', 'platform': 'android'})['key']

    def sms(self, body, sender=BANK, at='2026-11-20T10:00:00+03:00'):
        return Client().call('POST', '/api/ingest/sms', {'sender': sender, 'body': body, 'received_at': at}, bearer=self.key)

    def test_sms_makes_transaction_and_account_and_dedupes(self):
        code, out = self.sms(SMS_PURCHASE, sender='AlRajhiBank')
        self.assertEqual(code, 201, out)
        t = out['transaction']
        self.assertEqual(t['amount'], {'minor': 4500, 'currency': 'SAR'})
        self.assertEqual(t['category'], 'Food')
        self.assertEqual(t['purpose'], 'spend')
        acc = next(a for a in self.c.ok('GET', '/api/accounts')['items'] if a['id'] == t['account_id'])
        self.assertEqual((acc['last4'], acc['institution'], acc['kind']), ('1234', 'AlRajhiBank', 'debit_card'))
        self.assertEqual(acc['balance'], {'minor': 500000, 'currency': 'SAR'})
        self.assertEqual(self.sms(SMS_PURCHASE, sender='AlRajhiBank'), (200, {'stored': False, 'reason': 'duplicate'}))
        self.assertEqual(self.sms('Your OTP is 123456 for SAR 10.00 purchase')[1]['stored'], False)
        log = self.c.ok('GET', '/api/ingest/log')['items']
        self.assertIn('Pixel', [l['device'] for l in log])
        self.assertIn('skipped: security code', [l['outcome'] for l in log])
        detail = self.c.ok('GET', f"/api/transactions/{t['id']}")
        self.assertIn('STARBUCKS', detail['raw']['body'])

    def test_card_payment_is_transfer_and_interest_is_fee(self):
        _, a = self.sms(SMS_CARD_PAY, at='2026-11-21T09:00:00+03:00')
        _, b = self.sms(SMS_CARD_GOT, at='2026-11-21T09:05:00+03:00')
        self.assertEqual(a['transaction']['purpose'], 'transfer')
        self.assertEqual(b['transaction']['purpose'], 'transfer')
        d = self.c.ok('GET', f"/api/transactions/{a['transaction']['id']}")
        self.assertEqual(d['links'][0]['other_txn_id'], b['transaction']['id'])
        _, f = self.sms(SMS_INTEREST, sender='VM-HDFCBK')
        self.assertEqual((f['transaction']['purpose'], f['transaction']['category']), ('fee', 'Fees & interest'))

    def test_review_patch_apply_to_merchant(self):
        _, out = self.sms(SMS_UNKNOWN, sender='VM-HDFCBK', at='2026-11-20T12:00:00+05:30')
        t = out['transaction']
        self.assertLess(t['confidence'], 0.7)
        review = self.c.ok('GET', '/api/review')
        self.assertIn(t['id'], [i['id'] for i in review['items']])
        self.assertTrue(review['items'][0]['suggestions'])
        _, out2 = self.sms(SMS_UNKNOWN.replace('250.00', '99.00'), sender='VM-HDFCBK', at='2026-11-22T12:00:00+05:30')
        self.c.ok('PATCH', f"/api/transactions/{t['id']}", {'category': 'Shopping', 'apply_to_merchant': True})
        again = self.c.ok('GET', f"/api/transactions/{out2['transaction']['id']}")
        self.assertEqual(again['category'], 'Shopping')
        self.assertNotIn(t['id'], [i['id'] for i in self.c.ok('GET', '/api/review')['items']])
        _, out3 = self.sms(SMS_UNKNOWN.replace('250.00', '12.00'), sender='VM-HDFCBK', at='2026-11-23T12:00:00+05:30')
        self.assertEqual(out3['transaction']['category'], 'Shopping')  # learned for the future too

    def test_statement_import_dedupes_against_sms(self):
        acc = self.c.ok('POST', '/api/accounts', {'kind': 'bank', 'name': 'Riyad', 'currency': 'SAR', 'last4': '7777', 'institution': 'RiyadBank'})
        _, s = self.sms('SAR 120.00 debited from A/c XX7777 at JARIR BOOKSTORE', sender='RiyadBank', at='2026-11-05T10:00:00+03:00')
        self.assertEqual(s['transaction']['account_id'], acc['id'])
        csv = ('Date,Description,Debit,Credit,Balance\n05/11/2026,POS JARIR BOOKSTORE,120.00,,880.00\n'
               '06/11/2026,SALARY NOVEMBER,,5000.00,5880.00\n07/11/2026,PANDA RETAIL,80.00,,5800.00\n')
        body = {'account_id': acc['id'], 'file_name': 'nov.csv', 'data_base64': base64.b64encode(csv.encode()).decode()}
        out = self.c.ok('POST', '/api/ingest/statement', body)
        self.assertEqual((out['rows'], out['new'], out['duplicates']), (3, 2, 1))
        again = self.c.ok('POST', '/api/ingest/statement', body)
        self.assertEqual((again['new'], again['duplicates']), (0, 3))
        items = self.c.ok('GET', f"/api/transactions?account_id={acc['id']}")['items']
        self.assertEqual(sorted(i['amount']['minor'] for i in items), [8000, 12000, 500000])
        self.assertEqual(next(i for i in items if i['amount']['minor'] == 500000)['purpose'], 'income')
        sts = self.c.ok('GET', '/api/ingest/statements')['items']
        self.c.ok('DELETE', f"/api/ingest/statements/{sts[0]['id']}")
        self.assertEqual(len(self.c.ok('GET', f"/api/transactions?account_id={acc['id']}")['items']), 1)

    def test_batch_and_bad_input(self):
        out = self.c.ok('POST', '/api/ingest/sms/batch', {'messages': [{'sender': 'STCPay', 'body': 'Purchase SAR 15.00 at KUDU', 'received_at': '2026-11-10T10:00:00Z'},
                                                                         {'sender': 'X', 'body': 'hello'}]})
        self.assertEqual(out, {'received': 2, 'stored': 1})
        self.assertEqual(self.c.call('POST', '/api/ingest/sms/batch', {'messages': 'nope'})[0], 400)
        self.assertEqual(Client().call('POST', '/api/ingest/sms', {'sender': 'X', 'body': 'y'}, bearer='wrong')[0], 401)


class LedgerTest(Base):
    def test_contact_who_joins_sees_shared_splits(self):
        owner = signup('own@x.com')
        harish = owner.ok('POST', '/api/contacts', {'name': 'Harish', 'email': 'harish@x.com'})
        t = owner.ok('POST', '/api/transactions', {'day': '2026-11-02', 'amount_minor': 4000, 'currency': 'SAR', 'direction': 'debit', 'merchant': 'Rent'})
        owner.ok('POST', f"/api/transactions/{t['id']}/split", {'shares': [{'contact_id': harish['id'], 'share_minor': 2000}]})
        h = signup('harish@x.com', name='Harish')
        got = h.ok('GET', '/api/shared')['items']
        self.assertEqual((len(got), got[0]['you_owe'], got[0]['lines'][0]['your_share']), (1, [{'minor': 2000, 'currency': 'SAR'}], {'minor': 2000, 'currency': 'SAR'}))
        self.assertEqual(owner.ok('GET', '/api/shared')['items'], [])

    def test_manual_split_link_delete_pagination_categories(self):
        c = signup('led@x.com')
        bank = c.ok('POST', '/api/accounts', {'kind': 'bank', 'name': 'SNB', 'currency': 'SAR', 'opening_balance_minor': 10000, 'opening_as_of': '2026-11-01'})
        t = c.ok('POST', '/api/transactions', {'account_id': bank['id'], 'day': '2026-11-02', 'amount_minor': 2500, 'currency': 'SAR',
                                               'direction': 'debit', 'merchant': 'Carrefour', 'note': 'weekly'})
        self.assertEqual((t['category'], t['source'], t['note']), ('Groceries', 'manual', 'weekly'))
        self.assertEqual(c.ok('GET', '/api/accounts')['items'][0]['balance'], {'minor': 7500, 'currency': 'SAR'})
        self.assertEqual(c.call('POST', '/api/transactions', {'day': '2026-13-01', 'amount_minor': 1, 'currency': 'SAR', 'merchant': 'x'})[0], 400)
        self.assertEqual(c.call('POST', '/api/transactions', {'day': '2026-11-01', 'amount_minor': -5, 'currency': 'SAR', 'merchant': 'x'})[0], 400)
        mum = c.ok('POST', '/api/members', {'display_name': 'Mum', 'relation': 'parent'})
        s = c.ok('POST', f"/api/transactions/{t['id']}/split", {'shares': [{'member_id': mum['id'], 'share_minor': 1000}]})
        self.assertEqual(s['split_mine'], {'minor': 1500, 'currency': 'SAR'})
        self.assertEqual(c.call('POST', f"/api/transactions/{t['id']}/split", {'shares': [{'member_id': mum['id'], 'share_minor': 99999}]})[0], 400)
        card = c.ok('POST', '/api/accounts', {'kind': 'credit_card', 'name': 'Visa', 'currency': 'SAR'})
        out = c.ok('POST', '/api/transactions', {'account_id': bank['id'], 'day': '2026-11-03', 'amount_minor': 700, 'currency': 'SAR', 'merchant': 'Xfer'})
        inn = c.ok('POST', '/api/transactions', {'account_id': card['id'], 'day': '2026-11-03', 'amount_minor': 700, 'currency': 'SAR', 'merchant': 'Xfer in',
                                                 'direction': 'credit'})
        c.ok('POST', f"/api/transactions/{out['id']}/link", {'to_txn_id': inn['id'], 'kind': 'transfer'})
        d = c.ok('GET', f"/api/transactions/{out['id']}")
        self.assertEqual((d['purpose'], len(d['links'])), ('transfer', 1))
        c.ok('DELETE', f"/api/transactions/{out['id']}/link/{d['links'][0]['id']}")
        self.assertNotEqual(c.ok('GET', f"/api/transactions/{out['id']}")['purpose'], 'transfer')
        page = c.ok('GET', '/api/transactions?limit=2')
        self.assertEqual(len(page['items']), 2)
        rest = c.ok('GET', f"/api/transactions?limit=2&before={page['next_before']}")
        self.assertEqual(len({i['id'] for i in page['items'] + rest['items']}), 3)
        self.assertEqual(c.ok('GET', '/api/transactions?q=carre')['items'][0]['id'], t['id'])
        self.assertEqual(c.ok('DELETE', f"/api/transactions/{t['id']}"), {'id': t['id'], 'deleted': True})
        self.assertEqual(c.call('GET', f"/api/transactions/{t['id']}")[0], 404)
        cats = {x['name']: x for x in c.ok('GET', '/api/categories')['items']}
        self.assertEqual(cats['Telecom & Internet']['parent'], 'Bills & Utilities')
        self.assertEqual(cats['Salary']['kind'], 'income')


if __name__ == '__main__':
    unittest.main()
