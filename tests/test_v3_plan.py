"""v3 plan, insights and MCP, through the real WSGI app and a signed-up user. SQLite temp file by default; Postgres when
V3_TEST_DATABASE_URL or DATABASE_URL is a postgres URL (tables are emptied before each test):
  DATABASE_URL='postgresql://postgres@127.0.0.1:5433/plan_test?sslmode=disable' python3 -m unittest tests.test_v3_plan"""
import io
import json
import os
import re
import tempfile
import unittest
from unittest import mock

import engine
from api import app as router, auth
from api.db import DB, MIGRATIONS, new_id, now
from api.insights import today_in

PG = os.environ.get('V3_TEST_DATABASE_URL') or (os.environ.get('DATABASE_URL', '') if os.environ.get('DATABASE_URL', '').startswith('postgres') else '')
TABLES = sorted({t for f in MIGRATIONS.glob('*.sql') for t in re.findall(r'CREATE TABLE IF NOT EXISTS (\w+)', f.read_text())})
M = lambda minor, cur='SAR': {'minor': minor, 'currency': cur}


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {'DATABASE_URL': PG, 'DATABASE_URL_UNPOOLED': '', 'EXPENSE_DB_V3': os.path.join(self.tmp.name, 'v3.db')})
        self.env.start()
        for k in ('RESEND_API_KEY', 'MAIL_FROM'):
            os.environ.pop(k, None)
        self.db = DB()
        for t in TABLES:
            self.db.run(f'DELETE FROM {t}')
        auth._secret.clear()
        self.cookies, self.today = {}, today_in('Asia/Riyadh')
        self.ok('POST', '/auth/signup', {'email': 'anas@example.com', 'password': 'correct horse', 'name': 'Anas'})
        me = self.ok('GET', '/auth/me')
        self.hid, self.member = me['household']['id'], me['member']
        self.ali, self.omar = (self.ins('contacts', name=n, created_at=now())['id'] for n in ('Ali', 'Omar'))
        self.bank = self.ins('accounts', kind='bank', name='Al Rajhi', currency='SAR', created_at=now())['id']
        self.db.run("INSERT INTO fx_rates (day, base, quote, rate) VALUES (:d, 'SAR', 'INR', 25.0)", d=self.today)

    def tearDown(self):
        self.db.close()
        self.env.stop()
        self.tmp.cleanup()

    def ins(self, table, **cols):
        cols.setdefault('id', new_id())
        cols['household_id'] = self.hid
        self.db.run(f'INSERT INTO {table} ({", ".join(cols)}) VALUES ({", ".join(":" + k for k in cols)})', **cols)
        return cols

    def txn(self, minor, direction, merchant, day=None, currency='SAR'):
        day = day or self.today
        return self.ins('transactions', account_id=self.bank, member_id=self.member['id'], occurred_at=day + 'T10:00:00Z', day=day, amount_minor=minor,
                        currency=currency, direction=direction, merchant=merchant, merchant_raw=merchant, source='sms', dedupe_key=new_id(),
                        created_at=now())['id']

    def call(self, method, path, body=None, query=''):
        data = json.dumps(body).encode() if body is not None else b''
        environ = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query, 'CONTENT_LENGTH': str(len(data)), 'wsgi.input': io.BytesIO(data),
                   'REMOTE_ADDR': '10.0.0.9', 'HTTP_HOST': 'test.local', 'HTTP_COOKIE': '; '.join(f'{k}={v}' for k, v in self.cookies.items())}
        got = {}

        def start(status, headers):
            got['status'] = int(status[:3])
            for k, v in headers:
                if k == 'Set-Cookie':
                    name, _, rest = v.partition('=')
                    self.cookies[name] = rest.split(';')[0]
        out = b''.join(router.app(environ, start))
        return got['status'], json.loads(out) if out else None

    def ok(self, method, path, body=None, query='', status=(200, 201)):
        code, out = self.call(method, '/api' + path, body, query)
        self.assertIn(code, status, out)
        return out

    def spent(self):
        return self.ok('GET', '/insights/month', query='month=' + self.today[:7])['spent']['minor']

    def test_month_spent_split_by_currency(self):
        self.txn(120_00, 'debit', 'Panda')
        self.txn(2400_00, 'debit', 'KSEB', currency='INR')
        m = self.ok('GET', '/insights/month', query='month=' + self.today[:7])
        self.assertEqual(m['spent_by_currency'], [M(2400_00, 'INR'), M(120_00)])  # each as spent, never converted

    def test_card_used_by_someone_else_for_a_period(self):
        inside, outside = self.txn(5000, 'debit', 'Hotel', '2026-04-25'), self.txn(700, 'debit', 'Cafe', '2026-06-01')
        refund = self.txn(300, 'credit', 'Hotel refund', '2026-04-26')
        out = self.ok('POST', f'/accounts/{self.bank}/used-by', {'person': {'kind': 'contact', 'id': self.ali}, 'from': '2026-04-20', 'to': '2026-05-21'})
        self.assertEqual(out['tagged'], 1)
        meta = lambda t: self.db.one('SELECT purpose, person_contact_id FROM txn_meta WHERE txn_id = :t', t=t) or {}
        self.assertEqual((meta(inside)['purpose'], meta(inside)['person_contact_id']), ('lend', self.ali))
        self.assertNotEqual(meta(outside).get('person_contact_id'), self.ali)
        self.assertNotEqual(meta(refund).get('person_contact_id'), self.ali)
        self.assertEqual(self.call('POST', f'/api/accounts/{self.bank}/used-by', {'person': {'kind': 'contact', 'id': self.ali}, 'from': '2026-05-21', 'to': '2026-04-20'})[0], 400)

    # ---- liabilities ----

    def test_loan_outstanding_interest_split_and_payoff(self):
        loan = self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Home loan', 'currency': 'SAR', 'principal_minor': 120000_00,
                                                'opening_balance_minor': 100000_00, 'as_of': engine.add_months(self.today, -2),
                                                'rate_bp': 1200, 'emi_minor': 5000_00, 'match_pattern': 'home loan'})
        self.assertEqual(loan['outstanding'], M(100000_00))
        self.txn(5000_00, 'debit', 'HOME LOAN EMI', engine.add_months(self.today, -1))
        self.txn(5000_00, 'debit', 'HOME LOAN EMI', self.today)
        got = self.ok('GET', f'/liabilities/{loan["id"]}')
        # 1% a month: 1000.00 interest then 4000.00 principal; then 960.00 interest and 4040.00 principal
        self.assertEqual([p['interest']['minor'] for p in got['payments']], [1000_00, 960_00])
        self.assertEqual(got['outstanding'], M(91960_00))
        self.assertEqual(got['interest_month'], M(919_60))
        self.assertEqual(got['paid_pct'], 23)
        self.assertRegex(got['payoff_month'], r'^\d{4}-\d\d$')
        m = self.ok('GET', '/insights/month', query='month=' + self.today[:7])
        self.assertEqual(m['by_purpose']['fee'], M(960_00))  # the interest part is a cost; the principal is not spending
        self.assertEqual(m['spent'], M(960_00))
        lst = self.ok('GET', '/liabilities')
        self.assertEqual((lst['emi_total'], lst['outstanding_total']), (M(5000_00), M(91960_00)))

    # ---- commitments, funds ----
        catch_up = self.txn(5000_00, 'debit', 'AXIS ACH RETURN', self.today)  # a bounced EMI paid another way
        self.assertEqual(self.ok('PATCH', f'/transactions/{catch_up}', {'liability_id': loan['id']})['liability_id'], loan['id'])
        self.assertEqual(len(self.ok('GET', f'/liabilities/{loan["id"]}')['payments']), 3)
        self.assertEqual(self.call('PATCH', f'/api/transactions/{catch_up}', {'liability_id': new_id()}, '')[0], 400)
        self.assertIsNone(self.ok('PATCH', f'/transactions/{catch_up}', {'liability_id': None, 'purpose': 'spend'})['liability_id'])  # unlink
        self.assertEqual(len(self.ok('GET', f'/liabilities/{loan["id"]}')['payments']), 2)

    def test_six_monthly_rent_gets_a_fund(self):
        c = self.ok('POST', '/commitments', {'name': 'Flat rent', 'kind': 'rent', 'amount_minor': 30000_00, 'currency': 'SAR', 'cycle_months': 6,
                                             'next_due': engine.add_months(self.today, 4)})
        self.assertIsNotNone(c['fund_id'])
        f = self.ok('GET', f'/funds/{c["fund_id"]}')
        self.assertEqual((f['target'], f['monthly'], f['saved'], f['commitment_id']), (M(30000_00), M(6000_00), M(0), c['id']))
        f = self.ok('POST', f'/funds/{f["id"]}/move', {'amount_minor': 6000_00})
        self.assertEqual((f['saved'], f['on_track']), (M(6000_00), True))
        self.assertEqual(self.ok('GET', '/commitments')['items'][0]['status'], 'upcoming')
        self.ok('PATCH', f'/commitments/{c["id"]}', {'cycle_months': 1})  # monthly now: no fund
        self.assertEqual(self.ok('GET', '/funds')['items'], [])

    def test_subscription_shared_with_two_contacts(self):
        c = self.ok('POST', '/commitments', {'name': 'Netflix', 'kind': 'subscription', 'amount_minor': 60_00, 'currency': 'SAR', 'cycle_months': 1,
                                             'next_due': self.today, 'match_pattern': 'netflix',
                                             'shares': [{'contact_id': self.ali, 'share_minor': 20_00}, {'contact_id': self.omar, 'share_minor': 20_00}]})
        self.assertEqual(c['status'], 'due')
        self.txn(60_00, 'debit', 'NETFLIX.COM')
        c = self.ok('POST', f'/commitments/{c["id"]}/paid', {'payer': {'kind': 'contact', 'id': self.ali}})
        self.assertEqual((c['status'], c['next_due']), ('paid', engine.add_months(self.today, 1)))
        self.assertEqual({s['name']: s['paid_this_cycle'] for s in c['shares']}, {'Ali': True, 'Omar': False})
        self.assertEqual(c['my_share'], M(20_00))
        self.assertEqual(self.spent(), 20_00)  # only my share is my spending
        self.assertEqual(self.ok('GET', '/commitments')['monthly_total'], M(20_00))
        code, _ = self.call('POST', f'/api/commitments/{c["id"]}/paid', {'payer': {'kind': 'contact', 'id': new_id()}})
        self.assertEqual(code, 400)

    def test_mark_paid_without_transaction_and_detect(self):
        c = self.ok('POST', '/commitments', {'name': 'Electricity', 'kind': 'bill', 'amount_minor': 300_00, 'currency': 'SAR', 'next_due': self.today})
        c = self.ok('POST', f'/commitments/{c["id"]}/paid', {})
        self.assertEqual((c['status'], c['last_paid']['day']), ('paid', self.today))
        self.assertEqual(self.spent(), 0)  # a mark is not a transaction
        for k in (1, 7):
            self.txn(30000_00, 'debit', 'Landlord Rent', engine.add_months(self.today, -k))
        found = self.ok('GET', '/commitments/detect')['items']
        self.assertEqual([(d['name'], d['cycle_months'], d['kind']) for d in found], [('Landlord Rent', 6, 'rent')])
        self.assertEqual(len(found[0]['evidence_txn_ids']), 2)

    # ---- assets ----

    def test_property_paid_financed_milestones(self):
        loan = self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Flat loan', 'currency': 'SAR', 'principal_minor': 300000_00, 'emi_minor': 3000_00})
        a = self.ok('POST', '/assets', {'kind': 'property', 'name': 'Flat in Kochi', 'currency': 'SAR', 'cost_minor': 500000_00, 'liability_id': loan['id'],
                                        'details': {'paid_cash_minor': 100000_00}})
        self.ok('POST', f'/assets/{a["id"]}/milestones', {'name': 'Slab', 'due_on': engine.add_months(self.today, -1), 'amount_minor': 50000_00,
                                                           'paid_on': engine.add_months(self.today, -1)})
        a = self.ok('POST', f'/assets/{a["id"]}/milestones', {'name': 'Handover', 'due_on': engine.add_months(self.today, 6), 'amount_minor': 50000_00})
        self.assertEqual((a['paid'], a['financed'], a['remaining']), (M(150000_00), M(300000_00), M(50000_00)))
        self.assertEqual(a['next_milestone']['name'], 'Handover')
        self.assertEqual(a['monthly_cost'], M(3000_00))

    def test_vehicle_fuel_shared_half(self):
        a = self.ok('POST', '/assets', {'kind': 'vehicle', 'name': 'Camry', 'currency': 'SAR', 'cost_minor': 90000_00})
        for k in (1, 2, 3):
            t = self.txn(300_00, 'debit', 'ALDREES FUEL', engine.add_months(self.today, -k))
            self.ok('POST', f'/assets/{a["id"]}/costs', {'txn_id': t, 'cost_type': 'fuel'})
        a = self.ok('PUT', f'/assets/{a["id"]}/sharers', {'items': [{'cost_type': 'fuel', 'contact_id': self.ali, 'share_pct': 50}]})
        self.assertEqual((a['costs_by_type'], a['monthly_cost'], a['my_monthly_cost']), ({'fuel': M(300_00)}, M(300_00), M(150_00)))
        self.assertEqual(a['sharers'][0]['name'], 'Ali')
        last = self.ok('GET', '/insights/month', query='month=' + engine.add_months(self.today, -1)[:7])
        self.assertEqual(last['spent'], M(150_00))

    # ---- claims ----

    def test_claim_lifecycle_and_not_spending(self):
        hotel = self.txn(500_00, 'debit', 'HILTON JEDDAH')
        c = self.ok('POST', '/claims', {'name': 'Jeddah trip', 'payer': 'Employer', 'txn_ids': [hotel]})
        self.assertEqual((c['status'], c['expected'], c['received'], c['items'][0]['id']), ('submitted', M(500_00), M(0), hotel))
        self.assertEqual(self.spent(), 0)
        self.assertEqual(self.ok('GET', '/claims')['pending'], [M(500_00)])
        self.assertEqual(self.ok('GET', '/insights/month', query='month=' + self.today[:7])['owed_to_you']['claims'], M(500_00))
        pay = self.txn(500_00, 'credit', 'EMPLOYER REIMB')
        self.assertEqual(self.ok('GET', f'/claims/{c["id"]}')['suggestion']['txn_id'], pay)
        c = self.ok('POST', f'/claims/{c["id"]}/paid', {})
        self.assertEqual((c['status'], c['received'], c['reimbursement_txn_ids']), ('paid', M(500_00), [pay]))
        self.assertEqual(self.ok('GET', '/claims')['pending'], [])
        self.assertEqual(self.ok('GET', '/insights/month', query='month=' + self.today[:7])['income'], M(0))  # a reimbursement isn't income
        self.ok('DELETE', f'/claims/{c["id"]}')
        self.assertEqual(self.spent(), 500_00)

    # ---- insights ----

    def test_lookahead_twelve_months_with_negative_warning(self):
        s = self.ok('PUT', '/settings', {'salary_minor': 10000_00, 'salary_currency': 'SAR', 'salary_day': 27})
        self.assertEqual(s['salary'], M(10000_00))
        self.ok('POST', '/commitments', {'name': 'School fees', 'kind': 'school', 'amount_minor': 30000_00, 'currency': 'SAR', 'cycle_months': 0,
                                         'next_due': engine.add_months(self.today, 2)})
        la = self.ok('GET', '/insights/lookahead', query='months=12')
        self.assertEqual(len(la['months']), 12)
        self.assertEqual(la['months'][0]['income'], M(10000_00))
        self.assertTrue(any(w.startswith('Short') for w in la['months'][2]['warnings']))
        self.assertEqual(la['months'][1]['warnings'], [])
        self.assertEqual(self.call('GET', '/api/insights/lookahead', query='months=99')[0], 400)

    def test_debt_free_and_whatif_delay(self):
        self.ok('PUT', '/settings', {'salary_minor': 3000_00, 'extra_to_debt_minor': 0})
        self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Car', 'currency': 'SAR', 'opening_balance_minor': 12000_00, 'emi_minor': 1000_00})
        la = self.ok('GET', '/insights/lookahead')
        self.assertEqual(la['debt_free'], {'month': engine.add_months(self.today[:7], 12), 'months': 12})
        self.ok('POST', '/liabilities', {'kind': 'credit_card', 'name': 'Visa', 'currency': 'SAR', 'opening_balance_minor': 10000_00, 'rate_bp': 2400,
                                         'emi_minor': 1000_00})
        w = self.ok('GET', '/insights/whatif', query='amount_minor=500000&currency=SAR&pay=cash')
        self.assertGreater(w['delay_months'], 0)
        self.assertGreater(w['extra_interest']['minor'], 0)
        self.assertIn(w['verdict'], ('tight', 'no'))
        e = self.ok('GET', '/insights/whatif', query='amount_minor=600000&pay=emi&months=6')
        self.assertEqual(set(e), {'verdict', 'why', 'month_free_after', 'debt_free_before', 'debt_free_after', 'delay_months', 'extra_interest',
                                  'free_per_month', 'recover_months'})
        self.assertEqual(self.call('GET', '/api/insights/whatif', query='amount_minor=100&pay=gold')[0], 400)

    def test_advice(self):
        self.ok('PUT', '/settings', {'salary_minor': 15000_00})
        self.ok('POST', '/liabilities', {'kind': 'credit_card', 'name': 'Visa', 'currency': 'SAR', 'opening_balance_minor': 8000_00, 'rate_bp': 3600})
        a = self.ok('GET', '/insights/advice')
        self.assertIn('months_covered', a['emergency'])
        self.assertTrue(any(s['title'] == 'Pay extra on Visa' for s in a['steps']))
        self.assertIn('not financial advice', a['note'])
        self.assertTrue(any('NRE' in s['why'] for s in a['steps']))

    def test_home_shape(self):
        self.ok('POST', '/commitments', {'name': 'STC', 'kind': 'bill', 'amount_minor': 200_00, 'currency': 'SAR', 'next_due': engine.add_months(self.today, -1)[:8] + '01'})
        self.txn(100_00, 'debit', 'PANDA')
        h = self.ok('GET', '/insights/home')
        self.assertEqual(set(h), {'month', 'next_dues', 'lookahead', 'review_count', 'alerts'})
        self.assertEqual(len(h['lookahead']['months']), 6)
        self.assertEqual(h['review_count'], 1)  # PANDA has no meaning yet
        self.assertEqual(h['next_dues'][0]['status'], 'overdue')
        self.assertTrue(any('overdue' in a['text'] for a in h['alerts']))
        m = h['month']
        for k in ('income', 'spent', 'committed_due', 'committed_paid', 'set_aside', 'free', 'by_category', 'by_purpose', 'owed_by_you', 'owed_to_you',
                  'interest_month', 'fx'):
            self.assertIn(k, m)
        self.assertEqual(m['fx'], {'SAR_INR': 25.0, 'at': self.today})
        self.assertEqual(m['by_category'], [{'category': 'Uncategorized', 'amount': M(100_00), 'last': M(0)}])

    def test_validation_and_scoping(self):
        self.assertEqual(self.call('POST', '/api/commitments', {'name': 'x'})[0], 400)
        self.assertEqual(self.call('POST', '/api/commitments', {'name': 'x', 'kind': 'bill', 'amount_minor': 1, 'currency': 'SAR', 'next_due': self.today,
                                                               'account_id': new_id()})[0], 400)
        self.assertEqual(self.call('GET', f'/api/liabilities/{new_id()}')[0], 404)
        other = new_id()  # a liability in another household is invisible
        self.db.run("INSERT INTO liabilities (id, household_id, kind, name, currency, as_of, created_at) VALUES (:i, :h, 'loan', 'x', 'SAR', :d, :t)",
                    i=other, h=new_id(), d=self.today, t=now())
        self.assertEqual(self.call('PATCH', f'/api/liabilities/{other}', {'name': 'y'})[0], 404)

    # ---- trips ----

    def trip_setup(self):
        m = engine.add_months(self.today, -1)[:8]
        trip = self.ok('POST', '/trips', {'name': 'Kochi visit', 'city': 'Kochi', 'country': 'India', 'start_on': m + '05', 'end_on': m + '08', 'kind': 'business'})
        ids = {'hotel': self.txn(5000_00, 'debit', 'TAJ HOTEL', m + '05', 'INR'), 'taxi': self.txn(1000_00, 'debit', 'UBER', m + '06', 'INR'),
               'gift': self.txn(500_00, 'debit', 'LULU MALL', m + '07', 'INR'), 'coffee': self.txn(20_00, 'debit', 'STARBUCKS', m + '06'),
               'later': self.txn(300_00, 'debit', 'AMAZON', m + '20', 'INR')}
        return self.ok('GET', f'/trips/{trip["id"]}'), ids, m[:7]

    def test_trip_abroad_counts_base_currency_bookings(self):
        m = engine.add_months(self.today, -2)[:8]
        trip = self.ok('POST', '/trips', {'name': 'Doha', 'city': 'Doha', 'country': 'Qatar', 'start_on': m + '10', 'end_on': m + '12', 'kind': 'business'})
        self.txn(400_00, 'debit', 'QATAR AIRWAYS', m + '10')  # billed in SAR
        self.txn(100_00, 'debit', 'KARAK', m + '11', 'QAR')
        self.txn(900_00, 'debit', 'AMAZON IN', m + '11', 'INR')  # family at home: not the trip
        self.assertEqual(self.ok('GET', f'/trips/{trip["id"]}')['count'], 2)

    def test_trip_window_tags_claim_and_spending(self):
        trip, ids, month = self.trip_setup()
        self.assertEqual((trip['currency'], trip['count'], trip['totals']['total']), ('INR', 3, M(6500_00, 'INR')))
        self.assertEqual(trip['totals_base']['total'], M(260_00))
        t = self.ok('POST', f'/trips/{trip["id"]}/tag', {'txn_ids': [ids['gift']], 'status': 'personal'})
        t = self.ok('POST', f'/trips/{trip["id"]}/tag', {'txn_ids': [ids['taxi']], 'status': 'missed'})
        self.assertEqual({k: t['totals'][k]['minor'] for k in ('unreviewed', 'personal', 'missed', 'claimed')},
                         {'unreviewed': 5000_00, 'personal': 500_00, 'missed': 1000_00, 'claimed': 0})
        self.assertEqual({e['id']: e['trip_status'] for e in t['expenses']}[ids['taxi']], 'missed')
        spent = lambda: self.ok('GET', '/insights/month', query='month=' + month)['spent']['minor']
        self.assertEqual(spent(), 252_00)  # hotel 200 + gift 20 + coffee 20 + later 12; the missed taxi is money expected
        c = self.ok('POST', f'/trips/{trip["id"]}/claim', {'name': 'Kochi claim'})
        self.assertEqual((c['expected'], len(c['items'])), (M(6000_00, 'INR'), 2))
        t = self.ok('GET', f'/trips/{trip["id"]}')
        self.assertEqual((t['claim_ids'], t['totals']['claimed'], len(t['claims'])), ([c['id']], M(6000_00, 'INR'), 1))
        self.assertEqual(spent(), 52_00)
        self.assertEqual(self.call('POST', f'/api/trips/{trip["id"]}/claim', {})[0], 400)  # nothing left
        self.assertEqual(self.call('POST', f'/api/trips/{trip["id"]}/tag', {'txn_ids': [ids['gift']], 'status': 'lost'})[0], 400)
        self.assertEqual(self.call('POST', '/api/trips', {'name': 'x', 'start_on': '2026-02-02', 'end_on': '2026-02-01'})[0], 400)
        self.ok('DELETE', f'/trips/{trip["id"]}')
        self.assertEqual(self.ok('GET', '/trips')['items'], [])

    def test_claim_import_from_excel(self):
        import base64
        from datetime import date
        from openpyxl import Workbook
        trip, ids, month = self.trip_setup()
        wb = Workbook()
        ws = wb.active
        ws.append(['Expense claim form - Employee 123'])
        ws.append(['Date', 'Expense Description', 'Currency', 'Amount', 'Claimed Amount'])
        ws.append([date.fromisoformat(month + '-05'), 'Hotel 1 night', 'INR', 5000.00, 5000])
        ws.append([f'08/{month[5:]}/{month[:4]}', 'Taxi', 'INR', 1005.00, 1005])  # 2 days off, 0.5% off: still the Uber ride
        ws.append([date.fromisoformat(month + '-06'), 'Client dinner', 'INR', 777.00, 777])
        ws.append([None, 'Total', None, 6782.00, 6782])
        buf = io.BytesIO()
        wb.save(buf)
        out = self.ok('POST', '/claims/import', {'file_name': 'kochi-claim.xlsx', 'data_base64': base64.b64encode(buf.getvalue()).decode(),
                                                 'trip_id': trip['id']})
        self.assertEqual({m['description']: m['txn_id'] for m in out['matched']}, {'Hotel 1 night': ids['hotel'], 'Taxi': ids['taxi']})
        self.assertEqual([(u['description'], u['amount']) for u in out['unmatched']], [('Client dinner', M(777_00, 'INR'))])
        self.assertEqual((out['claim']['name'], out['claim']['expected']), ('Kochi visit', M(6000_00, 'INR')))
        bad = self.call('POST', '/api/claims/import', {'file_name': 'x.xlsx', 'data_base64': base64.b64encode(b'not excel').decode()})
        self.assertEqual(bad[0], 422)

    def test_partial_claim_burden_and_trip_breakdown(self):
        import base64
        from openpyxl import Workbook
        trip, ids, month = self.trip_setup()
        self.ok('POST', f'/trips/{trip["id"]}/tag', {'txn_ids': [ids['gift']], 'status': 'personal'})
        wb = Workbook()
        wb.active.append(['Date', 'Description', 'Currency', 'Amount', 'Claimed'])
        wb.active.append([month + '-05', 'Hotel', 'INR', 5000, 4600])  # the company pays part of the hotel
        wb.active.append([month + '-06', 'Taxi', 'INR', 1000, 1005])  # claimed more than the bill: capped at the bill
        buf = io.BytesIO()
        wb.save(buf)
        out = self.ok('POST', '/claims/import', {'file_name': 'c.xlsx', 'data_base64': base64.b64encode(buf.getvalue()).decode(), 'trip_id': trip['id']})
        self.assertEqual(out['claim']['expected'], M(5600_00, 'INR'))
        t = self.ok('GET', f'/trips/{trip["id"]}')
        by = {e['id']: e for e in t['expenses']}
        self.assertEqual([e['day'] for e in t['expenses']], sorted(e['day'] for e in t['expenses']))
        self.assertEqual((by[ids['hotel']]['trip_status'], by[ids['hotel']]['claimed'], by[ids['hotel']]['burden']),
                         ('claimed', M(4600_00, 'INR'), M(400_00, 'INR')))
        self.assertEqual((by[ids['taxi']]['claimed'], by[ids['taxi']]['burden']), (M(1000_00, 'INR'), M(0, 'INR')))
        self.assertEqual((by[ids['gift']]['claimed_trip'], by[ids['gift']]['burden_trip']), (M(0, 'INR'), M(500_00, 'INR')))
        self.assertEqual({k: t['totals'][k]['minor'] for k in ('spent', 'claimed', 'burden', 'personal', 'missed', 'unreviewed')},
                         {'spent': 6500_00, 'claimed': 5600_00, 'burden': 900_00, 'personal': 500_00, 'missed': 0, 'unreviewed': 0})
        self.assertEqual(t['totals_base']['burden'], M(36_00))
        self.assertEqual([(d['day'][-2:], d['spent']['minor'], d['claimed']['minor'], d['burden']['minor']) for d in t['by_day']],
                         [('05', 5000_00, 4600_00, 400_00), ('06', 1000_00, 1000_00, 0), ('07', 500_00, 0, 500_00)])
        self.assertEqual([sum(c[k]['minor'] for c in t['by_category']) for k in ('spent', 'claimed', 'burden')], [6500_00, 5600_00, 900_00])
        self.assertEqual(t['by_category'], sorted(t['by_category'], key=lambda c: -c['spent']['minor']))  # biggest first
        listed = self.ok('GET', '/trips')['items'][0]
        self.assertEqual((listed['totals']['burden'], 'expenses' in listed), (M(900_00, 'INR'), False))
        # spending counts only your part: hotel 400 INR (16) + gift 20 + coffee 20 + later 12
        self.assertEqual(self.ok('GET', '/insights/month', query='month=' + month)['spent']['minor'], 68_00)
        c = self.ok('POST', '/claims', {'name': 'Manual', 'txn_ids': [ids['later']]})  # by hand: the whole amount
        self.assertEqual(c['expected'], M(300_00, 'INR'))

    def test_claim_layouts_with_currency_in_cells(self):
        from api.plan import _claim_rows
        summary = [['Summary'], ['Date', 'Total', 'Claimed']]  # a header with nothing under it: not the claim
        cards = [['MON 02 MAR 2026 — two bills'], [], ['✔ Compliant — dinner'], [None, 'Vendor', 'Some Cafe'],
                 [None, 'Receipt total', 'QAR 50.00'], [None, 'Claimed', 'QAR 40.00  =  SAR 41.20'],
                 [None, '03 Mar 2026 (booked 1 Mar) — flight'], [None, 'What / amount', 'Flight home'], [None, 'Claimed', 'SAR 900.00']]
        rows = _claim_rows([summary, cards])
        self.assertEqual([(r['day'], r['description'], r['amount_minor'], r['claimed_minor'], r['currency']) for r in rows],
                         [('2026-03-02', 'Some Cafe', 5000, 4000, 'QAR'), ('2026-03-03', 'Flight home', 90000, 90000, 'SAR')])
        pack = [['Date', 'Vendor / item', 'What / amount', 'Claimed'], ['9 Aug 2026', 'Airline', 'Return ticket, 2 bags', 'SAR 1765.80']]
        food = [['Day', 'Vendor', 'Receipt total (QAR)', 'Claimed (QAR)'], ['Sun 09 Aug 2026', 'Grocer', 31.5, 31.5]]
        self.assertEqual([(r['amount_minor'], r['currency']) for r in _claim_rows([pack, food])], [(176580, 'SAR'), (3150, None)])

    # ---- MCP ----

    def mcp(self, msg, key=None):
        key = key or self.ok('GET', '/mcp-key')['url'].rsplit('/mcp/', 1)[1]
        return self.call('POST', '/mcp/' + key, msg)

    def test_mcp(self):
        code, init = self.mcp({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}})
        self.assertEqual((code, init['result']['protocolVersion']), (200, '2025-06-18'))
        self.assertIn('tools', init['result']['capabilities'])
        self.assertEqual(init['result']['serverInfo']['name'], 'expense')
        tools = {t['name']: t for t in self.mcp({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})[1]['result']['tools']}
        self.assertEqual(set(tools), {'get_home', 'get_month', 'get_lookahead', 'what_if', 'list_transactions', 'search_transactions', 'get_people',
                                      'get_commitments', 'get_liabilities', 'get_claims', 'get_assets', 'get_advice', 'add_transaction', 'set_purpose'})
        self.assertTrue(all(t['inputSchema']['type'] == 'object' for t in tools.values()))
        self.assertFalse(tools['add_transaction']['annotations']['readOnlyHint'])
        self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Car', 'currency': 'SAR', 'opening_balance_minor': 12000_00, 'emi_minor': 1000_00})
        out = self.mcp({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'get_liabilities', 'arguments': {}}})[1]['result']
        self.assertEqual(out['content'][0]['type'], 'text')
        self.assertEqual(json.loads(out['content'][0]['text'])['items'][0]['name'], 'Car')
        out = self.mcp({'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'get_lookahead', 'arguments': {'months': 3}}})[1]['result']
        self.assertEqual(len(out['structuredContent']['months']), 3)
        bad = self.mcp({'jsonrpc': '2.0', 'id': 5, 'method': 'tools/call', 'params': {'name': 'what_if', 'arguments': {'amount_minor': 0}}})[1]['result']
        self.assertTrue(bad['isError'])
        self.assertEqual(self.mcp({'jsonrpc': '2.0', 'method': 'notifications/initialized'})[0], 202)
        self.assertEqual(self.mcp({'jsonrpc': '2.0', 'id': 6, 'method': 'ping'})[1]['result'], {})
        self.assertEqual(self.mcp({'jsonrpc': '2.0', 'id': 7, 'method': 'tools/list'}, key='wrong')[0], 401)
        tool = lambda name, args: self.mcp({'jsonrpc': '2.0', 'id': 8, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}})[1]['result']
        added = tool('add_transaction', {'day': self.today, 'amount_minor': 45_00, 'currency': 'SAR', 'direction': 'debit', 'merchant': 'Kudu'})
        self.assertFalse(added['isError'], added)
        tid = added['structuredContent']['id']
        self.assertEqual(tool('set_purpose', {'txn_id': tid, 'purpose': 'lend'})['structuredContent']['purpose'], 'lend')
        found = tool('search_transactions', {'q': 'kudu'})['structuredContent']['items']
        self.assertEqual([t['id'] for t in found], [tid])


if __name__ == '__main__':
    unittest.main()
