"""Domain model v2 and money engine. Run: python3 -m unittest -v test_domain"""
import io
import json
import os
import tempfile
import time
import unittest

import domain
import engine
import server

TOKEN = 'test-token-1234567890'
M = lambda minor, cur='SAR': {'minor': minor, 'currency': cur}


class EngineTest(unittest.TestCase):
    """Pure functions, no database."""

    def test_add_months(self):
        self.assertEqual(engine.add_months('2026-11-30', 3), '2027-02-28')
        self.assertEqual(engine.add_months('2026-12', 1), '2027-01')
        self.assertEqual(engine.add_months('2027-01-15', -2), '2026-11-15')

    def test_debt_free_simulation(self):
        loan = {'id': 1, 'name': 'Car', 'kind': 'loan', 'balance_now': 12000_00, 'rate_bp': 0, 'emi_minor': 1000_00, 'currency': 'SAR'}
        self.assertEqual(engine.debt_free([loan], 0, '2026-11-23'), {'month': '2027-11', 'months': 12, 'interest': 0})
        self.assertEqual(engine.debt_free([loan], 1000_00, '2026-11-23')['months'], 6)
        card = {'id': 2, 'name': 'Card', 'kind': 'card', 'balance_now': 5000_00, 'rate_bp': 3600, 'emi_minor': 0, 'currency': 'SAR'}
        self.assertIsNone(engine.debt_free([card], 0, '2026-11-23')['month'])  # nothing pays it: never
        self.assertEqual(engine.debt_free([], 0, '2026-11-23'), {'month': '2026-11', 'months': 0, 'interest': 0})
        self.assertAlmostEqual(engine.interest_per_month([card]), 150_00)

    def test_what_if_delay(self):
        loan = {'id': 1, 'name': 'Card', 'kind': 'card', 'balance_now': 10000_00, 'rate_bp': 2400, 'emi_minor': 1000_00, 'currency': 'SAR'}
        w = engine.what_if([loan], 0, 3000_00, 5000_00, 'SAR', 'cash', '2026-11-23')
        self.assertGreater(w['delay_months'], 0)
        self.assertGreater(w['extra_interest']['minor'], 0)
        self.assertEqual(w['month_free_after'], M(-2000_00))
        self.assertIn(w['verdict'], ('tight', 'no'))
        card = engine.what_if([loan], 0, 3000_00, 5000_00, 'SAR', 'card', '2026-11-23')
        self.assertEqual(card['month_free_after'], M(3000_00))
        self.assertGreater(card['delay_months'], 0)
        none = engine.what_if([], 0, 3000_00, 500_00, 'SAR', 'cash', '2026-11-23')
        self.assertEqual((none['delay_months'], none['verdict']), (0, 'ok'))

    def test_detect_commitments(self):
        t = lambda i, day, merchant, minor: {'id': i, 'day': day, 'amount_minor': minor, 'currency': 'SAR', 'direction': 'debit',
                                             'purpose': 'spend', 'merchant': merchant, 'category': 'Uncategorized'}
        txns = [t(1, '2026-08-03', 'NETFLIX', 4500), t(2, '2026-09-03', 'NETFLIX', 4500), t(3, '2026-10-04', 'NETFLIX', 4500),
                t(4, '2026-01-01', 'Landlord Rent', 30000_00), t(5, '2026-07-01', 'Landlord Rent', 30000_00),
                t(6, '2026-10-01', 'PANDA', 120_00), t(7, '2026-10-09', 'PANDA', 410_00)]  # groceries: no steady amount
        found = {c['name']: c for c in engine.detect_commitments(txns, '2026-11-23')}
        self.assertEqual(set(found), {'NETFLIX', 'Landlord Rent'})
        self.assertEqual((found['NETFLIX']['cycle_months'], found['NETFLIX']['next_due'], found['NETFLIX']['kind']), (1, '2026-11-04', 'subscription'))
        self.assertEqual((found['Landlord Rent']['cycle_months'], found['Landlord Rent']['next_due'], found['Landlord Rent']['kind']), (6, '2027-01-01', 'rent'))
        self.assertEqual(engine.detect_commitments(txns, '2026-11-23', known=['netflix'])[0]['name'], 'Landlord Rent')

    def test_fund_projection_rolls_over(self):
        f = {'target_minor': 30000_00, 'saved_minor': 0, 'currency': 'SAR', 'due': '2027-04-01', 'cycle_months': 6}
        p = engine.fund_projection(f, '2026-11', 12)
        self.assertEqual(p[:6], [5000_00] * 6)
        self.assertEqual(p[6:], [5000_00] * 6)  # the next 6-month cycle


class DomainAPITest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ.update(EXPENSE_TOKEN=TOKEN, EXPENSE_DB=os.path.join(self.tmp.name, 'app.db'), DATABASE_URL='')
        server._rate.update(at=time.time(), value={'rate': 25.0, 'usd': 88.0, 'source': 'test', 'at': '2026-11-23T00:00+00:00'})
        self.db = server.DB()
        self.today = domain.today()
        self.month = self.today[:7]

    def tearDown(self):
        self.db.close()
        server._rate.clear()
        self.tmp.cleanup()

    def call(self, method, path, body=None, query=''):
        data = json.dumps(body).encode() if body is not None else b''
        environ = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query, 'HTTP_AUTHORIZATION': f'Bearer {TOKEN}',
                   'REMOTE_ADDR': '198.51.100.1', 'CONTENT_TYPE': 'application/json', 'CONTENT_LENGTH': str(len(data)), 'wsgi.input': io.BytesIO(data)}
        got = {}
        out = b''.join(server.app(environ, lambda status, headers: got.update(status=int(status[:3]))))
        return got['status'], json.loads(out) if out else None

    def ok(self, method, path, body=None, query=''):
        status, out = self.call(method, '/api/v2' + path, body, query)
        self.assertEqual(status, 200, out)
        return out

    def add(self, amount_minor, direction, body, merchant='', day=None, currency='SAR', account='Bank'):
        """A statement row (merchant and account given, not read from SMS text)."""
        return self.db.run('INSERT INTO transactions (received_at, sender, body, amount_minor, currency, direction, merchant, statement_id) '
                           'VALUES (:r, :s, :b, :a, :c, :d, :m, 1) RETURNING id', r=f'{day or self.today}T10:00:00+03:00', s=account,
                           b=body, a=amount_minor, c=currency, d=direction, m=merchant)[0]['id']

    def purpose(self, txn_id):
        t = next(t for t in server.transactions(self.db) if t['id'] == txn_id)
        return t['purpose'], t['confidence']

    def spent(self):
        return self.ok('GET', '/month', query=f'month={self.month}&currency=SAR')['spent']['minor']

    def test_card_payment_from_bank_is_transfer_not_spending(self):
        self.add(200_00, 'debit', 'POS purchase PANDA', 'PANDA')
        pay = self.add(3000_00, 'debit', 'Payment to your credit card 1234', 'CARD PAYMENT')
        self.assertEqual(self.purpose(pay)[0], 'transfer')
        self.assertEqual(self.spent(), 200_00)
        status, rows = self.call('GET', '/api/transactions')
        self.assertEqual(status, 200)
        self.assertTrue(rows and all('purpose' in t and 0 <= t['confidence'] <= 1 for t in rows))

    def test_card_interest_is_fee_and_counts(self):
        fee = self.add(150_00, 'debit', 'Finance charge on card 1234', 'FINANCE CHARGE', account='Card')
        self.assertEqual(self.purpose(fee), ('fee', 0.9))
        m = self.ok('GET', '/month', query=f'month={self.month}')
        self.assertEqual(m['spent'], M(150_00))
        self.assertEqual(m['by_purpose']['fee'], M(150_00))

    def test_split_share_excluded(self):
        t = self.add(300_00, 'debit', 'POS dinner', 'NANDOS')
        server.set_friend(self.db, t, 'Ali', 100_00)
        self.assertEqual(self.purpose(t)[0], 'spend')
        self.assertEqual(self.spent(), 200_00)
        lent = self.add(50_00, 'debit', 'POS cinema', 'VOX')
        server.set_friend(self.db, lent, 'Ali', 50_00)  # all theirs: money lent
        self.assertEqual(self.purpose(lent)[0], 'lend')
        self.assertEqual(self.spent(), 200_00)
        ali = next(p for p in self.ok('GET', '/people') if p['name'] == 'Ali')
        self.assertEqual(ali['owes_you'], [M(150_00)])

    def test_claim_excluded_and_pending_then_reimbursed(self):
        hotel = self.add(500_00, 'debit', 'POS HILTON', 'HILTON', day=engine.add_months(self.today, -1) if self.today[8:] < '05' else self.today[:8] + '01')
        claim = self.ok('POST', '/claims', {'name': 'Jeddah trip', 'txn_ids': [hotel]})
        self.assertEqual((claim['status'], claim['expected'], claim['received']), ('submitted', M(500_00), M(0)))
        self.assertEqual(self.purpose(hotel), ('claim', 1.0))
        self.assertEqual(self.ok('GET', '/claims')['pending_total'], [M(500_00)])
        self.assertEqual(self.spent(), 0)
        back = self.add(500_00, 'credit', 'Transfer from ACME CO', 'ACME CO', day=self.today)
        self.assertEqual(self.purpose(back)[0], 'reimbursement')
        got = self.ok('GET', '/claims')
        self.assertEqual((got['claims'][0]['status'], got['pending_total']), ('paid', []))
        self.assertEqual(self.ok('GET', '/month', query=f'month={self.month}')['income'], M(0))

    def test_six_monthly_rent_gets_a_fund(self):
        due = engine.add_months(self.today, 5)
        rent = self.ok('POST', '/commitments', {'name': 'Rent', 'kind': 'rent', 'amount': '30000', 'currency': 'SAR', 'cycle_months': 6, 'next_due': due,
                                                'match': 'landlord'})
        self.assertEqual((rent['cycle_months'], rent['status_this_cycle'], rent['amount']), (6, 'upcoming', M(30000_00)))
        fund = next(f for f in self.ok('GET', '/funds') if f['commitment_id'] == rent['id'])
        self.assertEqual((fund['target'], fund['monthly'], fund['due']), (M(30000_00), M(5000_00), due))
        la = self.ok('GET', '/lookahead', query='months=12')
        self.assertEqual([m['funds'] for m in la['months'][:6]], [M(5000_00)] * 6)
        self.assertEqual(la['months'][0]['commitments'], M(0))  # paid from the fund, not counted twice
        # Paid: the commitment rolls 6 months on and the fund starts again.
        self.add(30000_00, 'debit', 'Transfer to landlord', 'LANDLORD', day=due)
        rent = next(c for c in self.ok('GET', '/commitments') if c['id'] == rent['id'])
        self.assertEqual(rent['next_due'], engine.add_months(due, 6))
        self.assertEqual(next(f for f in self.ok('GET', '/funds') if f['id'] == fund['id'])['due'], engine.add_months(due, 6))

    def test_lookahead_12_months_and_debt_free(self):
        self.ok('POST', '/settings', {'salary': '20000', 'salary_currency': 'SAR', 'salary_day': 27})
        self.db.run("INSERT INTO holdings (kind, name, currency, balance_minor, rate_bp, emi_minor, due_day, as_of) "
                    "VALUES ('loan', 'Car loan', 'SAR', 1200000, 0, 100000, 1, :d)", d=self.today)
        self.ok('POST', '/commitments', {'name': 'STC', 'kind': 'bill', 'amount': '300', 'currency': 'SAR', 'cycle_months': 1, 'next_due': self.today})
        la = self.ok('GET', '/lookahead', query='months=12&currency=SAR')
        self.assertEqual(len(la['months']), 12)
        self.assertEqual(la['months'][0]['month'], self.month)
        self.assertEqual(la['months'][11]['month'], engine.add_months(self.month, 11))
        first = la['months'][0]
        self.assertEqual(first['income'], M(20000_00))
        self.assertEqual(first['commitments'], M(1300_00))  # the bill + the loan's EMI
        self.assertEqual(first['free'], M(18700_00))
        self.assertEqual(la['debt_free']['months'], 1)  # all free money goes to the one loan
        self.assertEqual(la['interest_per_month'], M(0))
        inr = self.ok('GET', '/lookahead', query='months=3&currency=INR')
        self.assertEqual(inr['months'][0]['income'], M(500000_00, 'INR'))  # at the stated 25 ₹/SAR
        w = self.ok('GET', '/whatif', query='amount=5000&currency=SAR&pay=card')
        self.assertIn(w['verdict'], ('ok', 'tight', 'no'))
        a = self.ok('GET', '/advice', query='currency=SAR')
        self.assertTrue(a['steps'])
        self.assertIn('target', a['emergency_fund'])

    def test_round_trip_every_route(self):
        p = self.ok('POST', '/people', {'name': 'Amma', 'relation': 'family', 'support_amount': '20000', 'support_currency': 'INR'})
        self.assertEqual((p['relation'], p['support_plan'], p['support_this_month']), ('family', M(20000_00, 'INR'), M(0, 'INR')))
        p = self.ok('POST', '/people', {'id': p['id'], 'name': 'Amma', 'relation': 'family', 'email': 'Amma@Example.com'})
        self.assertEqual(p['email'], 'amma@example.com')
        sent = self.add(20000_00, 'debit', 'IMPS to AMMA', 'AMMA', currency='INR', account='HDFC')
        tagged = self.ok('POST', '/purpose', {'txn_id': sent, 'purpose': 'support', 'person_id': p['id']})
        self.assertEqual((tagged['purpose'], tagged['confidence'], tagged['person_id']), ('support', 1.0, p['id']))
        self.assertEqual(next(x for x in self.ok('GET', '/people') if x['id'] == p['id'])['support_this_month'], M(20000_00, 'INR'))

        c = self.ok('POST', '/commitments', {'name': 'Netflix', 'kind': 'subscription', 'amount': '45', 'currency': 'SAR', 'cycle_months': 1,
                                             'next_due': self.today, 'match': 'netflix', 'sharers': [{'person_id': p['id'], 'share': '15'}]})
        self.assertEqual((c['sharers'][0]['share_minor'], c['sharers'][0]['paid_this_cycle'], c['status_this_cycle']), (15_00, False, 'due'))
        self.assertEqual(self.ok('GET', '/commitments')[0]['id'], c['id'])
        self.assertIsInstance(self.ok('GET', '/commitments/detect'), list)

        f = self.ok('POST', '/funds', {'name': 'Flight home', 'target': '3000', 'currency': 'SAR', 'due': engine.add_months(self.today, 2)})
        self.assertEqual(f['monthly'], M(1000_00))
        f = self.ok('POST', '/funds/contribute', {'id': f['id'], 'amount': '600'})
        self.assertEqual((f['saved'], f['monthly']), (M(600_00), M(800_00)))

        a = self.ok('POST', '/assets', {'kind': 'vehicle', 'name': 'Camry', 'currency': 'SAR', 'cost': '90000', 'paid_cash': '30000',
                                        'milestones': [{'name': 'Final', 'due': engine.add_months(self.today, 1), 'amount': '1000'}],
                                        'sharers': [{'person_id': p['id'], 'cost_type': 'fuel', 'share_pct': 50}]})
        self.assertEqual((a['remaining'], a['next_milestone']['amount']), (M(60000_00), M(1000_00)))
        fuel = self.add(200_00, 'debit', 'POS ALDREES', 'ALDREES', day=engine.add_months(self.today, -1))
        a = self.ok('POST', '/assets/cost', {'asset_id': a['id'], 'txn_id': fuel, 'cost_type': 'fuel'})
        self.assertEqual(a['costs_by_type']['fuel']['minor'], round(200_00 / 3))
        self.assertEqual(a['your_monthly_cost']['minor'], round(100_00 / 3))

        lunch = self.add(80_00, 'debit', 'POS client lunch', 'NOBU')
        cl = self.ok('POST', '/claims', {'name': 'Client', 'txn_ids': [lunch], 'status': 'draft'})
        pay = self.add(50_00, 'credit', 'Payroll adjustment', 'ACME')
        cl = self.ok('POST', '/claims/paid', {'id': cl['id'], 'txn_id': pay})
        self.assertEqual((cl['status'], cl['received']), ('partly', M(50_00)))

        s = self.ok('POST', '/settings', {'salary': '15000', 'salary_currency': 'SAR', 'emergency_months': 3})
        self.assertEqual((s['salary'], s['emergency_months'], s['home_currency']), (15000.0, 3.0, 'INR'))
        self.assertEqual(self.ok('GET', '/settings')['salary'], 15000.0)
        self.assertEqual(json.loads(self.db.run("SELECT value FROM settings WHERE key = 'salary'")[0]['value'])['amount'], 15000.0)

        self.assertIsInstance(self.ok('GET', '/review'), list)
        m = self.ok('GET', '/month', query=f'month={self.month}&currency=SAR')
        for k in ('income', 'spent', 'committed_due', 'committed_paid', 'set_aside', 'free', 'by_purpose', 'owed_by_you', 'owed_to_you', 'interest_this_month', 'rate'):
            self.assertIn(k, m)
        self.assertEqual(m['rate']['SAR_INR'], 25.0)
        self.assertEqual(m['owed_to_you']['claims'], M(30_00))

        for path, ident in (('/claims/delete', cl['id']), ('/assets/delete', a['id']), ('/funds/delete', f['id']),
                            ('/commitments/delete', c['id']), ('/people/delete', p['id'])):
            self.assertEqual(self.ok('POST', path, {'id': ident}), {'id': ident, 'deleted': True})
        self.assertEqual(self.ok('GET', '/claims')['claims'], [])

    def test_bad_input(self):
        for path, body in (('/people', {'name': '', 'relation': 'family'}), ('/people', {'name': 'X', 'relation': 'enemy'}),
                           ('/commitments', {'name': 'R', 'kind': 'rent', 'amount': '-5', 'currency': 'SAR', 'cycle_months': 6, 'next_due': '2026-12-01'}),
                           ('/commitments', {'name': 'R', 'kind': 'rent', 'amount': '5', 'currency': 'EUR', 'cycle_months': 6, 'next_due': '2026-12-01'}),
                           ('/funds', {'name': 'F', 'target': '10', 'currency': 'SAR', 'due': 'soon'}),
                           ('/purpose', {'txn_id': 1, 'purpose': 'gift'}), ('/settings', {'salary_day': 40}), ('/claims', {'name': 'x'})):
            with self.subTest(path=path, body=body):
                self.assertEqual(self.call('POST', '/api/v2' + path, body)[0], 400)
        self.assertEqual(self.call('POST', '/api/v2/purpose', {'txn_id': 999, 'purpose': 'spend'})[0], 404)
        self.assertEqual(self.call('POST', '/api/v2/funds/delete', {'id': 999})[0], 404)
        self.assertEqual(self.call('GET', '/api/v2/month', query='month=Nov')[0], 400)
        self.assertEqual(self.call('GET', '/api/v2/whatif', query='amount=abc')[0], 400)
        self.assertEqual(self.call('GET', '/api/v2/nothing')[0], 404)

    def test_learned_merchant_purpose(self):
        a = self.add(10_00, 'debit', 'POS STC PAY', 'STC PAY')
        b = self.add(20_00, 'debit', 'POS STC PAY top', 'STC PAY', day=engine.add_months(self.today, -1))
        self.ok('POST', '/purpose', {'txn_id': a, 'purpose': 'transfer', 'all_from_merchant': True})
        self.assertEqual(self.purpose(b), ('transfer', 0.9))

    def test_mcp_tools(self):
        rpc = lambda m, p: json.loads(server.app({'REQUEST_METHOD': 'POST', 'PATH_INFO': '/mcp', 'HTTP_AUTHORIZATION': f'Bearer {TOKEN}', 'REMOTE_ADDR': '198.51.100.1',
                                                  'CONTENT_TYPE': 'application/json', 'CONTENT_LENGTH': str(len(b := json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode())),
                                                  'wsgi.input': io.BytesIO(b)}, lambda s, h: None)[0])
        names = {t['name'] for t in rpc('tools/list', {})['result']['tools']}
        self.assertLessEqual({'get_month', 'get_lookahead', 'what_if', 'get_commitments', 'get_people', 'get_claims', 'get_assets', 'get_advice', 'set_purpose'}, names)
        for name, args in (('get_month', {'currency': 'SAR'}), ('get_lookahead', {'months': 3}), ('what_if', {'amount': 100}), ('get_commitments', {}),
                           ('get_people', {}), ('get_claims', {}), ('get_assets', {}), ('get_advice', {})):
            with self.subTest(tool=name):
                self.assertFalse(rpc('tools/call', {'name': name, 'arguments': args})['result']['isError'])
        t = self.add(10_00, 'debit', 'POS X', 'X')
        out = rpc('tools/call', {'name': 'set_purpose', 'arguments': {'txn_id': t, 'purpose': 'claim'}})['result']
        self.assertEqual(out['structuredContent']['purpose'], 'claim')
        self.assertTrue(rpc('tools/call', {'name': 'set_purpose', 'arguments': {'txn_id': 12345, 'purpose': 'claim'}})['result']['isError'])


if __name__ == '__main__':
    unittest.main()
