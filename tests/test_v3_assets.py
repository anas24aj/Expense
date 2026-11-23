"""Asset pages: own money vs loan, interest, market value, depreciation, sold / written off, and the "good buy" verdict.
Runs on the same harness as test_v3_plan (SQLite by default; Postgres with V3_TEST_DATABASE_URL)."""
import unittest

import engine
from tests.test_v3_plan import M, PlanTest

INR = lambda minor: M(minor, 'INR')


class EngineAssetTest(unittest.TestCase):
    def test_verdict_with_interest_against_fd(self):
        # 40L own in 2023, 40L tranche in 2024, 4L interest since; worth 1.1 Cr in Nov 2026
        flows = [('2023-11-23', 40_00_000_00), ('2024-11-23', 40_00_000_00), ('2025-11-23', 4_00_000_00)]
        v = engine.asset_verdict('property', flows, 1_10_00_000_00, '2026-11-23', 700, 'INR')
        self.assertEqual((v['cost'], v['gain']), (84_00_000_00, 26_00_000_00))
        fd = 40_00_000_00 * (1.07 ** (1096 / 365.25) - 1) + 40_00_000_00 * (1.07 ** (730 / 365.25) - 1) + 4_00_000_00 * (1.07 ** (365 / 365.25) - 1)
        self.assertEqual(v['fd_gain'], round(fd))
        self.assertEqual(v['tone'], 'good')
        self.assertGreater(v['annual_pct'], 7)  # beat the FD, so it earned more than 7% a year
        # the same numbers while still being built: provisional, said so in words
        p = engine.asset_verdict('property', flows, 1_10_00_000_00, '2026-11-23', 700, 'INR', provisional=True)
        self.assertTrue(p['provisional'] and p['text'].startswith('Provisional'))
        self.assertIn('7% a year', ' '.join(p['assumptions']))
        # worth only what it cost: behind the FD
        self.assertEqual(engine.asset_verdict('property', flows, 84_00_000_00, '2026-11-23', 700, 'INR')['tone'], 'warn')
        self.assertEqual(engine.asset_verdict('property', flows, 80_00_000_00, '2026-11-23', 700, 'INR')['tone'], 'bad')

    def test_xirr_and_depreciation(self):
        self.assertAlmostEqual(engine.xirr([('2024-01-01', -100_00), ('2026-01-01', 121_00)]), 0.1, places=3)
        self.assertIsNone(engine.xirr([('2024-01-01', -100_00)]))
        self.assertEqual(engine.depreciated(100_000_00, '2024-11-23', '2026-11-23', 15), round(100_000_00 * 0.85 ** (730 / 365.25)))
        self.assertEqual(engine.depreciated(100_000_00, '2026-11-23', '2026-11-23'), 100_000_00)


class AssetPageTest(PlanTest):
    def test_property_own_loan_interest_and_market_value(self):
        today = self.today
        loan = self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Canara home loan', 'lender': 'Canara Bank', 'currency': 'INR',
                                                'principal_minor': 60_00_000_00, 'rate_bp': 850, 'emi_minor': 52_000_00, 'due_day': 5,
                                                'emi_from': engine.add_months(today, 12), 'as_of': engine.add_months(today, -25)})
        canara = self.ins('accounts', kind='bank', name='Canara savings', currency='INR', created_at='2024-01-01T00:00:00Z')['id']
        flat = self.ok('POST', '/assets', {'kind': 'property', 'name': 'Shriram flat', 'currency': 'INR', 'cost_minor': 80_00_000_00,
                                           'liability_id': loan['id'], 'details': {'builder': 'Shriram Properties', 'bought_on': engine.add_months(today, -24)}})
        fid = flat['id']
        booking = self.ins('transactions', account_id=canara, member_id=self.member['id'], occurred_at='x', day=engine.add_months(today, -24),
                           amount_minor=10_00_000_00, currency='INR', direction='debit', merchant='SHRIRAM PROPERTIES', merchant_raw='', source='pdf',
                           dedupe_key='b1', created_at='x')['id']
        self.ok('POST', f'/assets/{fid}/milestones', {'name': 'Booking', 'due_on': engine.add_months(today, -24), 'amount_minor': 10_00_000_00})
        stones = self.ok('GET', f'/assets/{fid}')['milestones']
        self.ok('PATCH', f'/assets/{fid}/milestones/{stones[0]["id"]}', {'paid_txn_id': booking})
        self.ok('POST', f'/assets/{fid}/milestones', {'name': 'Agreement', 'due_on': engine.add_months(today, -23), 'amount_minor': 6_00_000_00,
                                                      'paid_on': engine.add_months(today, -23)})  # paid in cash
        self.ok('POST', f'/assets/{fid}/milestones', {'name': 'Slab 1', 'due_on': engine.add_months(today, -12), 'amount_minor': 30_00_000_00,
                                                      'disbursed_on': engine.add_months(today, -12)})
        self.ok('POST', f'/assets/{fid}/milestones', {'name': 'Handover', 'due_on': engine.add_months(today, 12), 'amount_minor': 34_00_000_00})
        pre = self.txn(21_250_00, 'debit', 'CANARA PRE EMI', engine.add_months(today, -1), 'INR')
        self.ok('PATCH', f'/transactions/{pre}', {'liability_id': loan['id']})
        flat = self.ok('PATCH', f'/assets/{fid}', {'details': {'area_sqft': 1250, 'market_value': {'minor': 95_00_000_00, 'as_of': today,
                                                                                                    'source': '7,600 a sq ft, local listings'}}})
        f = flat['funding']
        self.assertEqual((f['own'], f['loan'], f['interest']), (INR(16_00_000_00), INR(30_00_000_00), INR(21_250_00)))
        self.assertEqual(f['cost_to_date'], INR(46_21_250_00))
        self.assertEqual({s['name']: s['amount'] for s in f['own_sources']},
                         {'Canara savings': INR(10_00_000_00), 'Cash or not linked to a payment': INR(6_00_000_00)})
        self.assertEqual(flat['details']['builder'], 'Shriram Properties')  # the PATCH merged into the details
        self.assertEqual((flat['value'], flat['valuation']['basis']), (INR(95_00_000_00), 'market'))
        v = flat['verdict']
        self.assertTrue(flat['under_construction'] and v['provisional'])
        self.assertEqual(v['gain'], INR(95_00_000_00 - 46_21_250_00))
        self.assertIn('under construction', v['text'])
        # bad input at the boundary
        for bad in ({'photo_url': 'javascript:alert(1)'}, {'market_value': {'minor': -1, 'as_of': today}}, {'disposal': {'status': 'lost', 'on': today, 'proceeds_minor': 1}}):
            self.assertEqual(self.call('PATCH', f'/api/assets/{fid}', {'details': bad})[0], 400)
        # the FD yardstick is a setting
        self.ok('PUT', '/settings', {'fd_rates_bp': {'INR': 900, 'SAR': 500}})
        self.assertEqual(self.ok('GET', f'/assets/{fid}')['verdict']['fd_rate_bp'], 900)

    def test_car_bought_with_loan_then_written_off(self):
        today = self.today
        bought = engine.add_months(today, -18)
        loan = self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Personal loan', 'lender': 'Al Rajhi', 'currency': 'SAR',
                                                'principal_minor': 150_000_00, 'rate_bp': 600, 'emi_minor': 4_000_00, 'due_day': 1,
                                                'start_on': bought, 'as_of': bought})
        car = self.ok('POST', '/assets', {'kind': 'vehicle', 'name': 'Fortuner', 'currency': 'SAR', 'cost_minor': 140_000_00, 'liability_id': loan['id'],
                                          'details': {'bought_on': bought, 'paid_cash_minor': 0}})
        cid = car['id']
        emi = self.txn(4_000_00, 'debit', 'ALRAJHI LOAN', engine.add_months(today, -1))
        self.ok('PATCH', f'/transactions/{emi}', {'liability_id': loan['id']})
        fuel = self.txn(300_00, 'debit', 'ALDREES')
        self.ok('POST', f'/assets/{cid}/costs', {'txn_id': fuel, 'cost_type': 'fuel'})
        car = self.ok('GET', f'/assets/{cid}')
        interest = car['funding']['interest']['minor']
        self.assertGreater(interest, 0)
        self.assertEqual(car['funding']['loan'], M(140_000_00))  # the loan paid for the car, capped at its price
        self.assertEqual(car['valuation']['basis'], 'depreciation')
        self.assertEqual(car['value'], M(engine.depreciated(140_000_00, bought, today, 15)))
        car = self.ok('PATCH', f'/assets/{cid}', {'details': {'depreciation_pct': 20}})
        self.assertEqual(car['value'], M(engine.depreciated(140_000_00, bought, today, 20)))
        # an accident: the insurer pays 80,000 and the car is written off
        car = self.ok('PATCH', f'/assets/{cid}', {'details': {'disposal': {'status': 'written_off', 'on': today, 'proceeds_minor': 80_000_00,
                                                                            'note': 'Insurance payout after accident'}}})
        self.assertEqual((car['status'], car['value'], car['valuation']['basis']), ('written_off', M(80_000_00), 'written_off'))
        v = car['verdict']
        self.assertEqual(v['cost'], M(140_000_00 + interest))
        self.assertEqual(v['gain'], M(80_000_00 - 140_000_00 - interest))
        self.assertEqual(v['net_cost'], M(140_000_00 + interest + 300_00 - 80_000_00))  # with the fuel, less the payout
        self.assertTrue(v['text'].startswith('Written off') and not v['provisional'])
        self.assertIn(cid, [a['id'] for a in self.ok('GET', '/assets')['items']])  # still listed, marked written off
        car = self.ok('PATCH', f'/assets/{cid}', {'details': {'disposal': None}})  # undo
        self.assertEqual(car['status'], 'owned')


def load_tests(loader, tests, pattern):  # only this module's tests, not the PlanTest ones it inherits
    return unittest.TestSuite([loader.loadTestsFromTestCase(EngineAssetTest),
                               unittest.TestSuite(map(AssetPageTest, sorted(n for n in vars(AssetPageTest) if n.startswith('test_'))))])
