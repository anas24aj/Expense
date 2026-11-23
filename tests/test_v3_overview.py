"""The redesign's reads (api/overview.py): net worth by country and fees as losses, the month planner, money movement,
one person's ledger, the review queue by merchant, account owners, and trips leaving out home bills and showing fees.
Same harness as test_v3_plan (SQLite; Postgres with V3_TEST_DATABASE_URL)."""
import engine
from api.db import now
from tests import test_v3_plan

M = test_v3_plan.M


class OverviewTest(test_v3_plan.PlanTest):  # imported as a module so the harness's own tests are not collected here again
    def acct(self, kind, name, currency, country, balance=None, **cols):
        return self.ins('accounts', kind=kind, name=name, institution=name, currency=currency, country=country, last_balance_minor=balance,
                        last_balance_at=now() if balance is not None else None, owner_member_id=self.member['id'], created_at=now(), **cols)['id']

    def on(self, account, minor, direction, merchant, day=None, currency='SAR', purpose=None, person=None):
        t = self.txn(minor, direction, merchant, day, currency)
        self.db.run('UPDATE transactions SET account_id = :a WHERE id = :t', a=account, t=t)
        if purpose:
            self.ok('PATCH', f'/transactions/{t}', {'purpose': purpose, **({'person': person} if person else {})})
        return t

    def test_networth_by_country_and_losses(self):
        self.db.run('UPDATE accounts SET last_balance_minor = 10000_00, country = :c WHERE id = :a', c='SA', a=self.bank)
        self.acct('credit_card', 'SAB card', 'SAR', 'SA', -2000_00)
        self.acct('bank', 'HDFC', 'INR', 'IN', 50000_00)
        self.acct('credit_card', 'HDFC card', 'INR', 'IN', -25000_00)
        self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Home loan', 'currency': 'INR', 'principal_minor': 1000000_00,
                                         'opening_balance_minor': 500000_00, 'rate_bp': 900, 'emi_minor': 10000_00})
        self.ok('POST', '/assets', {'kind': 'property', 'name': 'Flat', 'currency': 'INR', 'cost_minor': 2500000_00})
        charge = self.txn(84_20, 'debit', 'FINANCE CHARGE')
        self.ok('PATCH', f'/transactions/{charge}', {'purpose': 'fee'})
        n = self.ok('GET', '/insights/networth')
        sa, india = n['countries'][0], n['countries'][1]
        self.assertEqual((sa['code'], sa['cash'], sa['cards'], sa['net']), ('SA', M(10000_00), M(2000_00), M(8000_00)))
        self.assertEqual((india['code'], india['cash'], india['cards'], india['loans']), ('IN', M(50000_00, 'INR'), M(25000_00, 'INR'), M(500000_00, 'INR')))
        flat = india['property']['minor']
        self.assertGreater(flat, 0)
        self.assertEqual(india['net'], M(50000_00 + flat - 525000_00, 'INR'))
        # together in SAR at 25 ₹/SAR
        self.assertEqual(n['liabilities'], M(2000_00 + 525000_00 / 25))
        self.assertEqual(n['net'], M(8000_00 + (50000_00 + flat - 525000_00) / 25))
        self.assertEqual((n['losses']['month'], n['losses']['year']), (M(84_20), M(84_20)))
        self.assertEqual(n['losses']['items'][0]['merchant'], 'FINANCE CHARGE')

    def test_card_account_with_a_liability_is_counted_once(self):
        card = self.acct('credit_card', 'SNB card', 'SAR', 'SA', -3000_00)
        self.ok('POST', '/liabilities', {'kind': 'credit_card', 'name': 'SNB', 'currency': 'SAR', 'principal_minor': 3000_00, 'account_id': card})
        self.assertEqual(self.ok('GET', '/insights/networth')['liabilities'], M(3000_00))

    def test_month_planner(self):
        self.db.run("UPDATE accounts SET last_balance_minor = 5000_00, country = 'SA' WHERE id = :a", a=self.bank)
        inr = self.acct('bank', 'HDFC', 'INR', 'IN', 10000_00)
        self.acct('credit_card', 'SAB card', 'SAR', 'SA', -1500_00, due_day=20)
        self.ok('PUT', '/settings', {'salary_minor': 26000_00, 'salary_currency': 'SAR', 'salary_day': 27})
        nxt = engine.add_months(self.today[:7], 1)
        self.ok('POST', '/commitments', {'name': 'Rent', 'kind': 'rent', 'amount_minor': 4000_00, 'currency': 'SAR', 'cycle_months': 1,
                                         'next_due': nxt + '-01', 'country': 'SA'})
        self.ok('POST', '/commitments', {'name': 'Umma', 'kind': 'support', 'amount_minor': 30000_00, 'currency': 'INR', 'cycle_months': 1,
                                         'next_due': nxt + '-05', 'country': 'IN', 'account_id': inr})
        self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Home loan', 'currency': 'INR', 'principal_minor': 1000000_00,
                                         'rate_bp': 900, 'emi_minor': 20000_00, 'due_day': 10})
        self.borrow = self.txn(300_00, 'debit', 'Groceries Harish paid')
        self.ok('PATCH', f'/transactions/{self.borrow}', {'purpose': 'borrow', 'person': {'kind': 'contact', 'id': self.ali}})
        p = self.ok('GET', '/insights/plan')
        this, second = p['months']
        kinds = {(x['kind'], x['name']): x for x in this['lines']}
        self.assertIn(('emi', 'Home loan'), kinds)
        self.assertEqual(kinds[('card', 'SAB card card')]['amount'], M(1500_00))
        self.assertEqual(kinds[('person', 'Pay back Ali')]['amount'], M(300_00))
        self.assertEqual(kinds[('card', 'SAB card card')]['account_id'], self.bank)  # paid from the main Saudi bank
        # next month: rent, Umma and the EMI; nobody owed; the card bill is a guess from past spending (none here)
        names = {x['name'] for x in second['lines']}
        self.assertTrue({'Rent', 'Umma', 'Home loan'} <= names)
        self.assertNotIn('Pay back Ali', names)
        out = sum(x['base']['minor'] for x in second['lines'] if x['counted'])
        self.assertEqual(second['surplus']['minor'], second['income']['minor'] - out)
        # rupee dues: 30,000 + 20,000 next month; the Indian account (₹10,000) is used up by this month's EMI, so all of it moves
        self.assertEqual(second['india']['due'], M(50000_00, 'INR'))
        self.assertEqual(second['move_to_india']['inr'], M(50000_00, 'INR'))
        self.assertEqual(second['move_to_india']['amount'], M(2000_00))  # 50,000 / 25 = 2,000, in whole hundreds
        self.assertEqual(second['move_to_india']['to'], inr)
        accounts = {x['account_id'] for x in second['pay_from']}
        self.assertIn(inr, accounts)

    def test_movements(self):
        self.db.run("UPDATE accounts SET country = 'SA' WHERE id = :a", a=self.bank)
        inr = self.acct('bank', 'HDFC', 'INR', 'IN', 0)
        card = self.acct('credit_card', 'SAB card', 'SAR', 'SA', 0)
        out = self.on(self.bank, 4000_00, 'debit', 'Remit')
        inn = self.on(inr, 100000_00, 'credit', 'Inward remittance', currency='INR')
        self.ok('POST', f'/transactions/{out}/link', {'to_txn_id': inn, 'kind': 'transfer'})
        pay = self.on(self.bank, 1000_00, 'debit', 'Card payment')
        got = self.on(card, 1000_00, 'credit', 'Payment received')
        self.ok('POST', f'/transactions/{pay}/link', {'to_txn_id': got, 'kind': 'transfer'})
        fam = self.ins('members', display_name='Umma', relation='parent', role='viewer', created_at=now())['id']
        self.on(inr, 25000_00, 'debit', 'To Umma', currency='INR', purpose='support', person={'kind': 'member', 'id': fam})
        self.on(self.bank, 500_00, 'credit', 'From Ali', purpose='repaid', person={'kind': 'contact', 'id': self.ali})
        g = {x['key']: x for x in self.ok('GET', '/insights/movements', query='month=' + self.today[:7])['groups']}
        remit = g['remit']['items'][0]
        self.assertEqual((remit['from']['id'], remit['to']['id'], remit['amount'], remit['received']), (self.bank, inr, M(4000_00), M(100000_00, 'INR')))
        self.assertEqual(g['cards']['items'][0]['to']['id'], card)
        self.assertEqual(g['cards']['total'], M(1000_00))
        self.assertEqual(g['family']['items'][0]['to']['name'], 'Umma')
        self.assertEqual(g['family']['total'], M(1000_00))  # ₹25,000 at 25
        self.assertEqual(g['from_people']['items'][0]['from']['name'], 'Ali')
        self.assertNotIn('own', g)
        self.assertEqual(self.call('GET', '/api/insights/movements', query='month=2026-13')[0], 400)

    def test_person_ledger(self):
        dinner = self.txn(300_00, 'debit', 'Dinner')
        self.ok('POST', f'/transactions/{dinner}/split', {'shares': [{'contact_id': self.ali, 'share_minor': 100_00}, {'contact_id': self.omar, 'share_minor': 100_00}]})
        lent = self.txn(50_00, 'debit', 'To Ali')
        self.ok('PATCH', f'/transactions/{lent}', {'purpose': 'lend', 'person': {'kind': 'contact', 'id': self.ali}})
        back = self.txn(20_00, 'credit', 'From Ali')
        self.ok('PATCH', f'/transactions/{back}', {'purpose': 'repaid', 'person': {'kind': 'contact', 'id': self.ali}})
        p = self.ok('GET', f'/people/contact/{self.ali}')
        self.assertEqual(p['person']['owes_you'], [M(130_00)])
        self.assertEqual([(x['txn']['id'], x['share']) for x in p['shared']], [(dinner, M(100_00))])
        self.assertEqual(len(p['shared'][0]['splits']), 2)
        self.assertEqual(([t['id'] for t in p['sent']], [t['id'] for t in p['received']]), ([lent], [back]))
        self.assertEqual((p['totals']['sent'], p['totals']['received'], p['totals']['their_part']), ([M(50_00)], [M(20_00)], [M(100_00)]))
        # "fully theirs" and "not split" are the split endpoint with the shares the page sends
        self.ok('POST', f'/transactions/{dinner}/split', {'shares': [{'contact_id': self.ali, 'share_minor': 300_00}]})
        self.assertEqual(self.ok('GET', f'/people/contact/{self.ali}')['person']['owes_you'], [M(330_00)])
        self.ok('POST', f'/transactions/{dinner}/split', {'shares': []})
        self.assertEqual(self.ok('GET', f'/people/contact/{self.ali}')['shared'], [])
        self.assertEqual(self.call('GET', '/api/people/contact/nope')[0], 404)
        self.assertEqual(self.call('GET', f'/api/people/robot/{self.ali}')[0], 400)

    def test_review_by_merchant(self):
        ids = [self.txn(10_00 + i, 'debit', 'MYSTERY SHOP 42') for i in range(3)] + [self.txn(5_00, 'debit', 'OTHER PLACE')]
        from api import classify
        from api.db import Scoped
        classify.reclassify(Scoped(self.db, self.hid))
        g = self.ok('GET', '/review/merchants')
        self.assertEqual(g['count'], 4)
        top = g['items'][0]
        self.assertEqual((top['merchant'], top['count'], top['totals']), ('MYSTERY SHOP 42', 3, [M(30_03)]))
        out = self.ok('POST', '/review/merchant', {'merchant': 'MYSTERY SHOP 42', 'category': 'Groceries', 'purpose': 'spend'})
        self.assertEqual((out['updated'], out['left']), (3, 1))
        self.assertEqual(self.ok('GET', f'/transactions/{ids[0]}')['category'], 'Groceries')
        later = self.txn(7_00, 'debit', 'MYSTERY SHOP 42')  # the rule holds for what comes later
        classify.reclassify(Scoped(self.db, self.hid), [later])
        self.assertEqual(self.ok('GET', f'/transactions/{later}')['category'], 'Groceries')
        self.assertEqual(self.call('POST', '/api/review/merchant', {'merchant': 'OTHER PLACE'})[0], 400)

    def test_account_owner(self):
        wife = self.ok('POST', '/members', {'display_name': 'Wife', 'relation': 'spouse'})
        wid = (wife.get('member') or wife)['id']
        a = self.ok('POST', '/accounts', {'kind': 'bank', 'name': 'Her bank', 'currency': 'SAR'})
        self.assertEqual(a['owner_member_id'], self.member['id'])  # the creator by default
        self.assertEqual(self.ok('PATCH', f'/accounts/{a["id"]}', {'owner_member_id': wid})['owner_member_id'], wid)

    def test_trip_leaves_out_home_bills_and_shows_fees(self):
        m = engine.add_months(self.today, -2)[:8]
        trip = self.ok('POST', '/trips', {'name': 'Doha', 'city': 'Doha', 'country': 'Qatar', 'start_on': m + '10', 'end_on': m + '14', 'kind': 'business'})
        hotel = self.txn(1000_00, 'debit', 'HOTEL', m + '10')
        rent = self.txn(4000_00, 'debit', 'RIYADH RENT', m + '11')
        self.db.run("UPDATE transactions SET category = 'Rent' WHERE id = :t", t=rent)
        fee = self.txn(25_00, 'debit', 'INTL TXN FEE + VAT', m + '10')
        self.ok('PATCH', f'/transactions/{fee}', {'purpose': 'fee'})
        tea = self.txn(30_00, 'debit', 'KARAK', m + '12')
        t = self.ok('GET', f'/trips/{trip["id"]}')
        self.assertEqual({e['id'] for e in t['expenses']}, {hotel, fee, tea})
        self.assertEqual(t['totals_base']['fees'], M(25_00))
        t = self.ok('POST', f'/trips/{trip["id"]}/tag', {'txn_ids': [tea], 'status': 'excluded'})  # one tap: not the trip's
        self.assertEqual(t['totals_base']['total'], M(1025_00))
        c = self.ok('POST', f'/trips/{trip["id"]}/claim', {'name': 'Doha', 'txn_ids': [hotel]})
        back = self.txn(1000_00, 'credit', 'COMPANY REIMBURSEMENT')
        self.ok('POST', f'/claims/{c["id"]}/paid', {'txn_id': back})
        t = self.ok('GET', f'/trips/{trip["id"]}')
        self.assertEqual((t['totals_base']['claimed'], t['totals_base']['reimbursed'], t['totals_base']['burden']), (M(1000_00), M(1000_00), M(25_00)))


for _name in [k for k in vars(test_v3_plan.PlanTest) if k.startswith('test_')]:  # the harness only: PlanTest's own tests run in their module
    setattr(OverviewTest, _name, None)
