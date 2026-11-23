"""A shared rent pot: a tenant's rent fills a fund shared with a co-owner and groceries draw it down; an overspend is
owed by the co-owner and shows once in their person balance. Same harness as tests/test_v3_plan.py."""
import unittest

import engine
from tests import test_v3_plan as base

M = base.M


class PotMath(unittest.TestCase):
    def test_surplus_carries_and_a_shortfall_is_split(self):
        lines = [('2026-01-03', 1000_00), ('2026-01-20', -600_00),  # 400 left
                 ('2026-02-10', -900_00),                            # no rent: 500 paid from pocket, pot back to 0
                 ('2026-03-01', 1000_00), ('2026-03-09', -201_00)]
        p = engine.pot(lines, {'harish': 50}, ['2026-01', '2026-02', '2026-03'])
        self.assertEqual((p['in'], p['out'], p['balance'], p['short']), (2000_00, 1701_00, 799_00, 500_00))
        self.assertEqual(p['owed'], {'harish': 250_00})
        self.assertEqual(p['parts']['harish'] + p['my_part'], p['balance'])  # rounding never loses a halala
        self.assertEqual(p['missing'], ['2026-02'])

    def test_rent_later_in_the_month_still_pays_that_months_groceries(self):
        p = engine.pot([('2026-01-02', -700_00), ('2026-01-28', 1000_00)], {'h': 50})
        self.assertEqual((p['short'], p['balance'], p['owed']), (0, 300_00, {'h': 0}))


class PotApi(unittest.TestCase):
    setUp, tearDown, ins, txn, call, ok = (base.PlanTest.setUp, base.PlanTest.tearDown, base.PlanTest.ins, base.PlanTest.txn,
                                           base.PlanTest.call, base.PlanTest.ok)

    def person(self, pid):
        return next(p for p in self.ok('GET', '/people')['items'] if p['id'] == pid)

    def tag(self, tid, fid):
        return self.ok('PATCH', f'/transactions/{tid}', {'fund_id': fid})

    def test_rent_pot(self):
        m3 = self.today[:7]
        m1, m2 = engine.add_months(m3, -2), engine.add_months(m3, -1)
        harish = self.ins('contacts', name='Harish', email='harish@example.com', created_at=base.now())['id']
        rent_m1 = self.txn(1000_00, 'credit', 'Transfer from AFAQ AHMED', m1 + '-03')
        f = self.ok('POST', '/funds', {'name': 'House groceries', 'currency': 'SAR', 'rent': {
            'tenant': {'name': 'Afaq', 'email': 'afaq@example.com'}, 'amount_minor': 1000_00, 'from': m1 + '-01', 'match_pattern': 'afaq',
            'shares': [{'contact_id': harish, 'share_pct': 50}]}})
        pot, fid = f['pot'], f['id']
        afaq = pot['tenant']['id']
        self.assertEqual(self.ok('GET', f'/transactions/{rent_m1}')['fund_id'], fid)  # past rent is tagged by the rule
        self.tag(self.txn(600_00, 'debit', 'Panda', m1 + '-20'), fid)
        g2 = self.txn(900_00, 'debit', 'Lulu', m2 + '-10')
        self.tag(g2, fid)
        rent_m3 = self.txn(1000_00, 'credit', 'AFAQ AHMED IPS', m3 + '-01')  # arrives after setup: the classifier tags it
        from api import classify
        from api.db import Scoped
        classify.reclassify(Scoped(self.db, self.hid), [rent_m3])

        pot = self.ok('GET', f'/funds/{fid}')['pot']
        self.assertEqual((pot['received'], pot['spent'], pot['balance'], pot['from_pocket']), (M(2000_00), M(1500_00), M(1000_00), M(500_00)))
        self.assertEqual(pot['mine'], {'share_pct': 50, 'part': M(500_00)})
        self.assertEqual((pot['shares'][0]['part'], pot['shares'][0]['owes_you']), (M(500_00), M(250_00)))
        self.assertEqual((pot['pending_months'], pot['rent_due']), ([m2], M(1000_00)))
        self.assertEqual(self.person(afaq)['rent_due'], M(1000_00))

        # the overspend is in Harish's balance once, next to an ordinary split
        other = self.txn(200_00, 'debit', 'Taxi', m3 + '-02')
        self.ok('POST', f'/transactions/{other}/split', {'shares': [{'contact_id': harish, 'share_minor': 100_00}]})
        self.assertEqual(self.person(harish)['owes_you'], [M(350_00)])

        # settling clears both; a later overspend counts only what is new
        self.ok('POST', '/settle', {'person': {'kind': 'contact', 'id': harish}, 'currency': 'SAR'})
        self.assertEqual(self.person(harish)['owes_you'], [])
        self.assertEqual(self.ok('GET', f'/funds/{fid}')['pot']['shares'][0]['owes_you'], M(0))
        self.tag(self.txn(1200_00, 'debit', 'Danube', m3 + '-15'), fid)  # 1000 in the pot: 200 short
        self.assertEqual(self.person(harish)['owes_you'], [M(100_00)])

        # untagging gives it back; then marking the missing month received pays February's groceries
        self.tag(g2, None)
        self.assertEqual(self.ok('GET', f'/transactions/{g2}')['fund_id'], None)
        self.tag(g2, fid)
        pot = self.ok('POST', f'/funds/{fid}/months', {'month': m2, 'status': 'received'})['pot']
        self.assertEqual((pot['pending_months'], pot['rent_due'], pot['from_pocket']), ([], M(0), M(0)))
        # Harish settled 250 for February's overspend, which the rent now covers: the household owes it back to him
        self.assertEqual(self.person(harish)['you_owe'], [M(250_00)])

        # waived instead: no rent, nothing due from Afaq
        pot = self.ok('POST', f'/funds/{fid}/months', {'month': m2, 'status': 'waived'})['pot']
        self.assertEqual((pot['pending_months'], pot['waived_months'], pot['rent_due']), ([], [m2], M(0)))
        self.assertIsNone(self.person(afaq)['rent_due'])
        pot = self.ok('POST', f'/funds/{fid}/months', {'month': m2, 'status': 'due'})['pot']
        self.assertEqual(pot['pending_months'], [m2])

    def test_month_view_counts_only_my_half(self):
        harish = self.ins('contacts', name='Harish', created_at=base.now())['id']
        f = self.ok('POST', '/funds', {'name': 'House groceries', 'currency': 'SAR', 'rent': {
            'tenant': {'name': 'Afaq'}, 'amount_minor': 1000_00, 'from': self.today, 'shares': [{'contact_id': harish, 'share_pct': 50}]}})
        self.tag(self.txn(300_00, 'debit', 'Panda'), f['id'])
        self.assertEqual(self.ok('GET', '/insights/month', query='month=' + self.today[:7])['spent']['minor'], 150_00)

    def test_bad_arrangements(self):
        harish = self.ins('contacts', name='Harish', created_at=base.now())['id']
        body = lambda **r: {'name': 'Pot', 'currency': 'SAR', 'rent': {'tenant': {'name': 'Afaq'}, 'amount_minor': 1000_00, 'from': self.today, **r}}
        for bad in (body(shares=[{'contact_id': harish, 'share_pct': 100}]), body(amount_minor=0), body(**{'from': None}),
                    body(shares=[{'contact_id': harish, 'member_id': self.member['id'], 'share_pct': 50}])):
            self.assertEqual(self.call('POST', '/api/funds', bad)[0], 400, bad)
        f = self.ok('POST', '/funds', body())
        usd = self.txn(10_00, 'debit', 'Amazon', currency='USD')
        self.assertEqual(self.call('PATCH', f'/api/transactions/{usd}', {'fund_id': f['id']})[0], 400)
        self.assertEqual(self.call('POST', f'/api/funds/{f["id"]}/months', {'month': '2026-13', 'status': 'waived'})[0], 400)

    def test_invite_contact(self):
        c = self.ok('POST', '/contacts', {'name': 'Afaq', 'email': 'afaq@example.com'})
        out = self.ok('POST', f'/contacts/{c["id"]}/invite')
        self.assertEqual((out['email'], out['sent']), ('afaq@example.com', False))  # no mail service in tests
        self.assertIn('/signup?invite=contact.', out['link'])


    def test_new_expense_defaults_to_an_account(self):
        card = self.ins('accounts', kind='credit_card', name='SAB card', currency='SAR', created_at=base.now())['id']
        add = lambda **b: self.ok('POST', '/transactions', {'day': self.today, 'amount_minor': 10_00, 'currency': 'SAR', 'merchant': 'Panda', **b})['account_id']
        self.assertEqual(add(), self.bank)                  # nothing used yet: the bank account
        self.assertEqual(add(account_id=card), card)
        self.db.run("UPDATE transactions SET created_at = '9999' WHERE account_id = :c", c=card)  # created_at has whole seconds
        self.assertEqual(add(), card)                       # then the last one used
        self.assertIsNone(add(account_id=None))             # cash stays an explicit choice
        self.assertEqual(add(), card)
        self.assertIsNone(add(currency='INR'))              # no rupee account: nothing to default to
        self.assertEqual(self.ok('GET', '/accounts')['recent_ids'][0], card)


if __name__ == '__main__':
    unittest.main()
