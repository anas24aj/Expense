"""Shared costs as balances, a loan in someone else's name, card-lent ranges kept as rules, a rented home as a place,
settle-ups by day, and pots vs splits. Same harness as test_v3_plan (SQLite; Postgres with V3_TEST_DATABASE_URL)."""
import engine
from api import classify
from api.db import Scoped, now
from tests.test_v3_plan import M, PlanTest


class FeatureGapsTest(PlanTest):
    def person(self, cid):
        return next(p for p in self.ok('GET', '/people')['items'] if p['id'] == cid)

    def classify(self, ids=None):
        classify.reclassify(Scoped(self.db, self.hid), ids)

    def borrow(self, minor, merchant, who, day=None):
        """A cost someone paid for you: recorded as purpose borrow with them."""
        t = self.txn(minor, 'debit', merchant, day)
        self.ok('PATCH', f'/transactions/{t}', {'purpose': 'borrow', 'person': {'kind': 'contact', 'id': who}})
        return t

    def owed_to_you(self):
        return self.ok('GET', '/insights/month', query='month=' + self.today[:7])['owed_to_you']['people']['minor']

    def test_shared_costs_become_balances(self):
        car = self.ok('POST', '/assets', {'kind': 'vehicle', 'name': 'Patrol', 'currency': 'SAR', 'cost_minor': 80000_00})['id']
        self.ok('PUT', f'/assets/{car}/sharers', {'items': [{'contact_id': self.ali, 'cost_type': '*', 'share_pct': 50}]})
        fuel = self.txn(200_00, 'debit', 'Aldrees')
        self.ok('POST', f'/assets/{car}/costs', {'txn_id': fuel, 'cost_type': 'fuel'})
        self.assertEqual(self.person(self.ali)['owes_you'], [M(100_00)])  # half the fuel I paid
        service = self.borrow(300_00, 'Toyota service', self.ali)  # Ali paid the service for me
        self.ok('POST', f'/assets/{car}/costs', {'txn_id': service, 'cost_type': 'service'})
        p = self.person(self.ali)
        self.assertEqual((p['owes_you'], p['you_owe']), ([], [M(50_00)]))  # 100 he owes me, 150 (my half) I owe him
        a = self.ok('GET', f'/assets/{car}')
        self.assertEqual(a['sharer_totals'][0]['net_owes_you'], M(-50_00))
        self.assertEqual({c['txn_id']: c['paid_by'] for c in a['costs']}, {fuel: None, service: 'Ali'})
        self.assertEqual(a['cost_by_month'], [{'month': self.today[:7], 'total': M(500_00), 'mine': M(250_00)}])
        # a cost that is also split: the split says what he owes, the sharer % is not added on top
        tyres = self.txn(400_00, 'debit', 'Tyres')
        self.ok('POST', f'/assets/{car}/costs', {'txn_id': tyres, 'cost_type': 'repairs'})
        self.ok('POST', f'/transactions/{tyres}/split', {'shares': [{'contact_id': self.ali, 'share_minor': 100_00}]})
        self.assertEqual(self.person(self.ali)['owes_you'], [M(50_00)])  # -50 + 100 split

        # a subscription shared with Omar: each payment adds his share until he pays it
        nf = self.txn(60_00, 'debit', 'NETFLIX.COM')
        c = self.ok('POST', '/commitments', {'name': 'Netflix', 'kind': 'subscription', 'amount_minor': 60_00, 'currency': 'SAR',
                                             'cycle_months': 1, 'next_due': self.today, 'match_pattern': 'netflix',
                                             'shares': [{'contact_id': self.omar, 'share_minor': 20_00}]})
        self.assertEqual(self.ok('GET', f'/transactions/{nf}')['commitment_id'], c['id'])
        self.assertEqual(self.person(self.omar)['owes_you'], [M(20_00)])
        self.assertEqual(self.owed_to_you(), 70_00)  # Home agrees with People: Ali 50 + Omar 20
        self.ok('POST', f'/commitments/{c["id"]}/paid', {'payer': {'kind': 'contact', 'id': self.omar}})
        self.assertEqual(self.person(self.omar)['owes_you'], [])
        # settle with Ali: everything up to now is cleared
        self.ok('POST', '/settle', {'person': {'kind': 'contact', 'id': self.ali}, 'currency': 'SAR'})
        self.assertEqual((self.person(self.ali)['owes_you'], self.person(self.ali)['you_owe']), ([], []))

    def test_settle_up_goes_by_the_day(self):
        old = engine.add_months(self.today, -3)
        lent = self.txn(500_00, 'debit', 'Transfer to Ali', old)
        self.ok('PATCH', f'/transactions/{lent}', {'purpose': 'lend', 'person': {'kind': 'contact', 'id': self.ali}})
        self.assertEqual(self.owed_to_you(), 500_00)
        self.ok('POST', '/settle', {'person': {'kind': 'contact', 'id': self.ali}, 'currency': 'SAR'})
        self.assertEqual(self.owed_to_you(), 0)
        # an older loan imported after the settle-up (a statement) is settled too; a new one counts
        late = self.txn(300_00, 'debit', 'Transfer to Ali', engine.add_months(self.today, -2))
        self.ok('PATCH', f'/transactions/{late}', {'purpose': 'lend', 'person': {'kind': 'contact', 'id': self.ali}})
        self.assertEqual(self.person(self.ali)['owes_you'], [])
        new = self.txn(40_00, 'debit', 'Transfer to Ali')
        self.db.run("UPDATE transactions SET created_at = '2999-01-01T00:00:00+00:00' WHERE id = :t", t=new)  # recorded after the settle-up
        self.ok('PATCH', f'/transactions/{new}', {'purpose': 'lend', 'person': {'kind': 'contact', 'id': self.ali}})
        self.assertEqual((self.person(self.ali)['owes_you'], self.owed_to_you()), ([M(40_00)], 40_00))

    def test_pot_and_split_never_both(self):
        f = self.ok('POST', '/funds', {'name': 'House groceries', 'currency': 'SAR', 'rent': {
            'tenant': {'name': 'Afaq'}, 'amount_minor': 1000_00, 'from': self.today, 'shares': [{'contact_id': self.ali, 'share_pct': 50}]}})
        in_pot = self.txn(300_00, 'debit', 'Panda')
        self.ok('PATCH', f'/transactions/{in_pot}', {'fund_id': f['id']})
        code, out = self.call('POST', f'/api/transactions/{in_pot}/split', {'shares': [{'contact_id': self.ali, 'share_minor': 150_00}]})
        self.assertEqual(code, 400)
        self.assertIn('rent pot', out['error'])
        split = self.txn(200_00, 'debit', 'Lulu')
        self.ok('POST', f'/transactions/{split}/split', {'shares': [{'contact_id': self.ali, 'share_minor': 100_00}]})
        code, out = self.call('PATCH', f'/api/transactions/{split}', {'fund_id': f['id']})
        self.assertEqual(code, 400)
        self.assertIn('split', out['error'])

    def test_card_lent_for_a_range_is_a_rule(self):
        inside, fee = self.txn(5000, 'debit', 'Hotel', '2026-04-25'), self.txn(2500, 'debit', 'ANNUAL FEE CHARGES', '2026-04-26')
        self.classify()
        self.assertEqual(self.ok('GET', f'/transactions/{fee}')['purpose'], 'fee')
        out = self.ok('POST', f'/accounts/{self.bank}/used-by', {'person': {'kind': 'contact', 'id': self.ali}, 'from': '2026-04-20', 'to': '2026-05-21'})
        self.assertEqual((out['tagged'], out['rule']['person']['name']), (1, 'Ali'))
        later = self.txn(1200, 'debit', 'Jarir', '2026-05-02')  # imported after the range was saved
        self.classify([later])
        self.assertEqual({k: self.ok('GET', f'/transactions/{t}')['purpose'] for k, t in (('in', inside), ('fee', fee), ('later', later))},
                         {'in': 'lend', 'fee': 'fee', 'later': 'lend'})
        self.assertEqual(self.person(self.ali)['owes_you'], [M(6200)])
        rules = self.ok('GET', f'/accounts/{self.bank}/used-by')['items']
        self.assertEqual([(r['from'], r['to'], r['purpose']) for r in rules], [('2026-04-20', '2026-05-21', 'lend')])
        self.assertEqual(self.ok('DELETE', f'/accounts/{self.bank}/used-by/{rules[0]["id"]}')['untagged'], 1)
        self.assertEqual(self.person(self.ali)['owes_you'], [])
        self.assertEqual(self.ok('GET', f'/transactions/{inside}')['purpose'], 'spend')

    def test_loan_in_someone_elses_name(self):
        harish = self.ins('contacts', name='Harish', created_at=now())['id']
        loan = self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Harish personal loan (car)', 'currency': 'SAR', 'principal_minor': 60000_00,
                                                'rate_bp': 0, 'emi_minor': 5400_00, 'as_of': engine.add_months(self.today, -1),
                                                'holder_contact_id': harish, 'my_share_pct': 50})
        self.assertEqual((loan['emi'], loan['outstanding'], loan['my_share_pct']), (M(2700_00), M(30000_00), 50))
        sh = loan['shared']
        self.assertEqual((sh['holder']['name'], sh['loan_emi'], sh['loan_principal'], sh['sent_this_month']), ('Harish', M(5400_00), M(60000_00), False))
        self.txn(150_00, 'debit', 'Transfer to HARISH')  # money for something else: not the EMI
        sent = self.txn(2700_00, 'debit', 'Transfer to HARISH KUMAR')
        got = self.ok('GET', f'/liabilities/{loan["id"]}')
        self.assertEqual(([p['txn_id'] for p in got['payments']], got['outstanding'], got['shared']['sent_this_month']), ([sent], M(27300_00), True))
        self.assertRegex(got['payoff_month'], r'^\d{4}-\d\d$')
        self.assertEqual(self.ok('GET', '/liabilities')['emi_total'], M(2700_00))
        self.assertEqual(self.call('PATCH', f'/api/liabilities/{loan["id"]}', {'my_share_pct': 0})[0], 400)

    def test_rented_home(self):
        sa = self.ins('accounts', kind='bank', name='SAB', currency='SAR', country='SA', created_at=now())['id']
        home = self.ok('POST', '/assets', {'kind': 'home', 'name': 'Riyadh flat', 'currency': 'SAR'})
        self.assertEqual((home['verdict'], home['auto_tag']['categories']['Groceries']), (None, 'groceries'))
        hid = home['id']
        f = self.ok('POST', '/funds', {'name': 'House groceries', 'currency': 'SAR', 'rent': {
            'tenant': {'name': 'Afaq'}, 'amount_minor': 1000_00, 'from': self.today, 'shares': [{'contact_id': self.ali, 'share_pct': 50}]}})
        self.ok('PATCH', f'/assets/{hid}', {'details': {'fund_id': f['id']}})
        self.ok('PUT', f'/assets/{hid}/sharers', {'items': [{'contact_id': self.ali, 'cost_type': '*', 'share_pct': 50}]})
        mk = lambda minor, merchant, cat, cur='SAR', acct=sa: self.ins('transactions', account_id=acct, member_id=self.member['id'], occurred_at=self.today + 'T09:00:00Z',
                                                                         day=self.today, amount_minor=minor, currency=cur, direction='debit', merchant=merchant,
                                                                         merchant_raw=merchant, category=cat, source='sms', dedupe_key=merchant, created_at=now())['id']
        power = mk(400_00, 'SEC electricity', 'Bills & Utilities')
        mk(900_00, 'Lulu Kochi', 'Groceries', 'INR')  # India: not this home's
        mk(80_00, 'Cafe', 'Food')
        pot_buy = mk(300_00, 'Panda', 'Groceries')
        self.ok('PATCH', f'/transactions/{pot_buy}', {'fund_id': f['id']})
        rent = self.ok('POST', '/commitments', {'name': 'Flat rent', 'kind': 'rent', 'amount_minor': 30000_00, 'currency': 'SAR', 'cycle_months': 6,
                                                'next_due': engine.add_months(self.today, 4), 'asset_id': hid})
        a = self.ok('GET', f'/assets/{hid}')
        self.assertEqual(sorted((c['merchant'], c['cost_type'], c['auto'], c['from_pot']) for c in a['costs']),
                         [('Panda', 'groceries', False, True), ('SEC electricity', 'utilities', True, False)])
        self.assertEqual(([r['id'] for r in a['rent']], a['pot']['fund_id'], a['pot']['pending_months']), ([rent['id']], f['id'], [self.today[:7]]))
        self.assertEqual(a['sharer_totals'][0]['net_owes_you'], M(200_00))  # half the power bill; the pot splits the groceries itself
        self.assertEqual(self.person(self.ali)['owes_you'], [M(350_00)])  # 200 of the power bill + half of what the pot overspent, once each
        # the rule is explicit and editable: drop utilities and the bill is no longer the home's
        self.ok('PATCH', f'/assets/{hid}', {'details': {'auto_tag': {'currency': 'SAR', 'country': 'SA', 'categories': {'Groceries': 'groceries'}}}})
        self.assertNotIn(power, [c['txn_id'] for c in self.ok('GET', f'/assets/{hid}')['costs']])
        self.assertEqual(self.call('PATCH', f'/api/assets/{hid}', {'details': {'auto_tag': {'categories': 'all'}}})[0], 400)
        self.assertEqual(self.call('PATCH', f'/api/assets/{hid}', {'details': {'photo': 'https://x.test/a.jpg'}})[0], 400)
        self.ok('PATCH', f'/assets/{hid}', {'details': {'photo': 'data:image/jpeg;base64,/9j/AAAA'}})

    def test_transaction_account_and_trip(self):
        other = self.ins('accounts', kind='credit_card', name='SNB card', currency='SAR', created_at=now())['id']
        t = self.txn(100_00, 'debit', 'Hotel')
        self.assertEqual(self.ok('PATCH', f'/transactions/{t}', {'account_id': other})['account_id'], other)
        self.assertEqual(self.call('PATCH', f'/api/transactions/{t}', {'account_id': 'nope'})[0], 404)
        self.assertIsNone(self.ok('PATCH', f'/transactions/{t}', {'account_id': None})['account_id'])
        trip = self.ok('POST', '/trips', {'name': 'Jeddah', 'country': 'SA', 'start_on': self.today, 'end_on': self.today, 'kind': 'business'})
        self.assertEqual(self.ok('GET', f'/transactions/{t}')['trips'], [{'id': trip['id'], 'name': 'Jeddah', 'status': 'unreviewed'}])
        self.ok('POST', f'/trips/{trip["id"]}/tag', {'txn_ids': [t], 'status': 'excluded'})
        self.assertEqual(self.ok('GET', f'/transactions/{t}')['trips'], [])
