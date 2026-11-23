"""Construction loans (tranches, pre-EMI), missed EMIs, bounce charges, salary history and shared vehicle costs.
Runs on the same harness as test_v3_plan (SQLite by default; Postgres with V3_TEST_DATABASE_URL)."""
import unittest

import engine
from api import classify
from api.db import Scoped
from tests.test_v3_plan import M, PlanTest

INR = lambda minor: M(minor, 'INR')
# The owner's home loan: 6 tranches disbursed so far, 44,83,514.60 in all
TRANCHES = [699_000_00, 1_045_000_00, 650_000_00, 812_514_60, 700_000_00, 577_000_00]


class EngineLoanTest(unittest.TestCase):
    def test_owner_construction_loan(self):
        self.assertEqual(sum(TRANCHES), 44_83_514_60)
        days = [f'2025-{m:02d}-10' for m in (3, 5, 7, 9, 11)] + ['2026-02-10']
        bal, split = engine.loan_walk(0, 845, [{'id': 'p1', 'day': '2026-03-05', 'amount': 31_571_42}], list(zip(days, TRANCHES)))
        self.assertEqual((bal, split['p1']), (44_83_514_60, 31_571_42))  # a pre-EMI payment is all interest: nothing repaid
        c = engine.construction(69_50_000_00, list(zip(days, TRANCHES)), bal, 845, 54_556_00, '2027-07-05', '2026-11-23')
        self.assertEqual((c['disbursed'], c['undisbursed'], c['pre_emi'], c['phase'], c['monthly']),
                         (44_83_514_60, 24_66_485_40, 31_571_42, 'pre_emi', 31_571_42))
        self.assertEqual(engine.construction(69_50_000_00, [], 0, 845, 54_556_00, '2027-07-05', '2027-07-05')['phase'], 'emi')
        loan = {'emi_minor': 54_556_00, 'pre_emi_minor': 31_571_42, 'emi_from': '2027-07-05'}
        self.assertEqual((engine.emi_in(loan, '2027-06'), engine.emi_in(loan, '2027-07')), (31_571_42, 54_556_00))
        self.assertAlmostEqual(engine.emi(69_50_000_00, 845, 360) / 100, 53193.41, places=1)
        # once EMIs start, a payment above the interest repays principal
        bal, split = engine.loan_walk(100_000_00, 1200, [{'id': 'e', 'day': '2026-01-05', 'amount': 5_000_00}])
        self.assertEqual((bal, split['e']), (96_000_00, 1_000_00))

    def test_missed_months(self):
        self.assertEqual(engine.missed_months(5, ['2026-10-04'], '2026-08-15', '2026-11-23'), ['2026-09', '2026-11'])
        self.assertEqual(engine.missed_months(25, [], '2026-08-15', '2026-11-23'), ['2026-09', '2026-10'])  # Nov 25 not due yet
        self.assertEqual(engine.missed_months(0, [], '2026-10-31', '2026-11-23'), [])  # month end: not yet

    def test_salary_in(self):
        hist = [{'member_id': 'a', 'from_month': '2025-01', 'amount_minor': 30_000_00, 'currency': 'SAR', 'kind': 'base'},
                {'member_id': 'a', 'from_month': '2026-12', 'amount_minor': 35_500_00, 'currency': 'SAR', 'kind': 'base'},
                {'member_id': 'a', 'from_month': '2026-11', 'amount_minor': 11_000_00, 'currency': 'SAR', 'kind': 'arrears'},
                {'member_id': 'b', 'from_month': '2026-01', 'amount_minor': 25_000_00, 'currency': 'INR', 'kind': 'base'}]
        s = {'salary_history': hist, 'salary': 1}
        self.assertEqual(engine.salary_in(s, '2026-11', 'SAR', 25.0), (31_000_00, 11_000_00))
        self.assertEqual(engine.salary_in(s, '2026-12', 'SAR', 25.0), (36_500_00, 0))
        self.assertEqual(engine.salary_in(s, '2024-12', 'SAR', 25.0), (None, 0))
        self.assertEqual(engine.expected_income(s, [], '2026-11', 'SAR', 25.0), 42_000_00)
        self.assertEqual(engine.expected_income({'salary': 20000}, [], '2026-11', 'SAR', 25.0), 20_000_00)  # the old setting


class LoanSalaryTest(PlanTest):
    def property_with_loan(self):
        loan = self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Home loan', 'lender': 'SBI', 'currency': 'INR', 'principal_minor': 69_50_000_00,
                                                'rate_bp': 845, 'emi_minor': 54_556_00, 'due_day': 5, 'emi_from': '2027-07-05',
                                                'as_of': engine.add_months(self.today, -1)})
        flat = self.ok('POST', '/assets', {'kind': 'property', 'name': 'Flat', 'currency': 'INR', 'cost_minor': 90_00_000_00, 'liability_id': loan['id']})
        return loan, flat

    def test_construction_loan_tranches_and_pre_emi(self):
        loan, flat = self.property_with_loan()
        for n, amt in enumerate(TRANCHES):
            day = engine.add_months(self.today, n - 12)
            flat = self.ok('POST', f'/assets/{flat["id"]}/milestones', {'name': f'Slab {n + 1}', 'due_on': day, 'amount_minor': amt, 'disbursed_on': day})
        flat = self.ok('POST', f'/assets/{flat["id"]}/milestones', {'name': 'Possession', 'due_on': engine.add_months(self.today, 8), 'amount_minor': 5_00_000_00})
        self.assertEqual(len([m for m in flat['milestones'] if m['disbursed_on']]), 6)
        self.assertEqual(flat['next_milestone']['name'], 'Possession')  # disbursed tranches count as done
        self.assertEqual(flat['milestones'][0]['liability_id'], loan['id'])  # the asset's loan by default
        got = self.ok('GET', f'/liabilities/{loan["id"]}')
        c = got['construction']
        self.assertEqual(got['outstanding'], INR(44_83_514_60))
        self.assertEqual((c['sanctioned'], c['disbursed'], c['undisbursed'], c['pre_emi']),
                         (INR(69_50_000_00), INR(44_83_514_60), INR(24_66_485_40), INR(31_571_42)))
        self.assertEqual((c['phase'], c['emi_from'], len(c['tranches'])), ('pre_emi', '2027-07-05', 6))
        self.assertEqual(got['interest_month'], INR(31_571_42))
        # a pre-EMI payment: all interest (spending), nothing repaid
        pay = self.txn(31_571_42, 'debit', 'SBI HOME LOAN PRE EMI', self.today, 'INR')
        self.ok('PATCH', f'/transactions/{pay}', {'liability_id': loan['id']})
        got = self.ok('GET', f'/liabilities/{loan["id"]}')
        self.assertEqual((got['outstanding'], got['payments'][0]['interest']), (INR(44_83_514_60), INR(31_571_42)))
        self.assertEqual(self.ok('GET', '/insights/month', query='month=' + self.today[:7])['by_purpose']['fee'], M(round(31_571_42 / 25)))
        # look-ahead: the pre-EMI until July 2027, then the full EMI
        months = {m['month']: m['commitments']['minor'] for m in self.ok('GET', '/insights/lookahead', query='months=12')['months']}
        self.assertEqual(months[self.today[:7]], round(31_571_42 / 25))
        self.assertEqual(months['2027-07'], round(54_556_00 / 25))
        # undo a tranche; a tranche needs a loan
        first = flat['milestones'][0]['id']
        self.ok('PATCH', f'/assets/{flat["id"]}/milestones/{first}', {'disbursed_on': ''})
        self.assertEqual(self.ok('GET', f'/liabilities/{loan["id"]}')['construction']['disbursed'], INR(44_83_514_60 - TRANCHES[0]))
        bare = self.ok('POST', '/assets', {'kind': 'property', 'name': 'Plot', 'currency': 'INR'})
        code, _ = self.call('POST', f'/api/assets/{bare["id"]}/milestones', {'name': 'x', 'due_on': self.today, 'amount_minor': 1, 'disbursed_on': self.today})
        self.assertEqual(code, 400)
        # paying a milestone yourself
        poss = next(m for m in flat['milestones'] if m['name'] == 'Possession')
        flat = self.ok('PATCH', f'/assets/{flat["id"]}/milestones/{poss["id"]}', {'paid_on': self.today})
        self.assertEqual(flat['paid'], INR(5_00_000_00))

    def test_missed_emi_alert(self):
        loan = self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Car loan', 'currency': 'SAR', 'principal_minor': 50_000_00, 'rate_bp': 600,
                                                'emi_minor': 1_500_00, 'due_day': 1, 'as_of': engine.add_months(self.today, -3)[:8] + '15'})
        paid = self.txn(1_500_00, 'debit', 'CAR LOAN', engine.add_months(self.today, -2)[:8] + '01')
        self.ok('PATCH', f'/transactions/{paid}', {'liability_id': loan['id']})
        items = [a for a in self.ok('GET', '/alerts')['items'] if a.get('liability_id') == loan['id']]
        want = [engine.add_months(self.today[:7], -1)] + ([self.today[:7]] if int(self.today[8:]) >= 4 else [])
        self.assertEqual([a['month'] for a in items], want)
        self.assertEqual(items[0]['level'], 'bad')
        self.assertIn('Car loan', self.ok('GET', '/insights/home')['alerts'][-1]['text'])

    def test_bounce_charge_is_a_fee(self):
        self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Home loan', 'currency': 'INR', 'match_pattern': 'home loan', 'emi_minor': 54_556_00})
        hh = Scoped(self.db, self.hid)
        charge = self.txn(590_00, 'debit', 'NACH RTN CHG HOME LOAN', currency='INR')
        emi = self.txn(54_556_00, 'debit', 'HOME LOAN EMI', currency='INR')
        catch_up = self.txn(54_556_00, 'debit', 'ACH RETURN', currency='INR')
        classify.reclassify(hh, [charge, emi, catch_up])
        purpose = lambda t: self.db.one('SELECT purpose FROM txn_meta WHERE txn_id = :t', t=t)['purpose']
        self.assertEqual((purpose(charge), purpose(emi)), ('fee', 'loan_payment'))
        self.assertNotEqual(purpose(catch_up), 'fee')  # a returned EMI without a charge is not a fee
        self.assertEqual(self.ok('GET', f'/transactions/{charge}')['category'], 'Fees & interest')

    def test_salary_history_drives_expected_income(self):
        nxt = engine.add_months(self.today[:7], 1)
        self.ok('PUT', '/settings', {'salary_minor': 20_000_00, 'salary_currency': 'SAR'})
        la = self.ok('GET', '/insights/lookahead', query='months=3')['months']
        self.assertEqual(la[1]['income'], M(20_000_00))  # the old single setting until there is history
        base = self.ok('POST', '/salary', {'from_month': '2025-01', 'amount_minor': 30_000_00, 'currency': 'SAR', 'kind': 'base'})
        self.ok('POST', '/salary', {'from_month': nxt, 'amount_minor': 35_500_00, 'currency': 'SAR', 'note': 'new grade'})
        arr = self.ok('POST', '/salary', {'from_month': self.today[:7], 'amount_minor': 11_000_00, 'currency': 'SAR', 'kind': 'arrears'})
        self.assertEqual((base['member_id'], base['member_name'], arr['kind']), (self.member['id'], 'Anas', 'arrears'))
        got = self.ok('GET', '/salary')
        self.assertEqual([i['from_month'] for i in got['items']], [nxt, self.today[:7], '2025-01'])
        self.assertEqual(got['expected_this_month'], M(41_000_00))
        la = self.ok('GET', '/insights/lookahead', query='months=3')['months']
        self.assertEqual([m['income']['minor'] for m in la], [41_000_00, 35_500_00, 35_500_00])
        self.assertEqual(self.ok('GET', '/insights/month', query='month=' + self.today[:7])['income'], M(41_000_00))
        self.ok('DELETE', f'/salary/{arr["id"]}')
        self.assertEqual(self.ok('GET', '/salary')['expected_this_month'], M(30_000_00))
        for bad in ({'from_month': '2026-13', 'amount_minor': 1, 'currency': 'SAR'}, {'from_month': '2026-01', 'amount_minor': 0, 'currency': 'SAR'},
                    {'from_month': '2026-01', 'amount_minor': 1, 'currency': 'SAR', 'kind': 'tip'},
                    {'from_month': '2026-01', 'amount_minor': 1, 'currency': 'SAR', 'member_id': 'nope'}):
            self.assertEqual(self.call('POST', '/api/salary', bad)[0], 400)
        self.assertEqual(self.call('DELETE', f'/api/salary/{arr["id"]}')[0], 404)

    def test_shared_vehicle_costs(self):
        car = self.ok('POST', '/assets', {'kind': 'vehicle', 'name': 'Camry', 'currency': 'SAR', 'cost_minor': 90_000_00, 'value_minor': 70_000_00,
                                          'value_as_of': self.today})
        fuel = [self.txn(200_00, 'debit', 'ALDREES'), self.txn(100_00, 'debit', 'SASCO')]
        service = self.txn(600_00, 'debit', 'TOYOTA SERVICE')
        for t in fuel:
            self.ok('POST', f'/assets/{car["id"]}/costs', {'txn_id': t, 'cost_type': 'Fuel'})
        self.ok('POST', f'/assets/{car["id"]}/costs', {'txn_id': service, 'cost_type': 'service'})
        car = self.ok('PUT', f'/assets/{car["id"]}/sharers', {'items': [{'cost_type': 'fuel', 'contact_id': self.ali, 'share_pct': 50},
                                                                         {'cost_type': '*', 'contact_id': self.omar, 'share_pct': 25}]})
        self.assertEqual(car['cost_totals'], {'fuel': M(300_00), 'service': M(600_00)})
        self.assertEqual((car['cost_total'], len(car['costs'])), (M(900_00), 3))
        self.assertEqual({s['name']: s['amount'] for s in car['sharer_totals']}, {'Ali': M(150_00), 'Omar': M(225_00)})
        self.assertEqual(car['my_cost_total'], M(525_00))
        self.assertEqual(self.spent(), 525_00)  # sharers' parts are not my spending


def load_tests(loader, tests, pattern):  # only this module's tests, not the PlanTest ones it inherits
    return unittest.TestSuite([loader.loadTestsFromTestCase(EngineLoanTest),
                               unittest.TestSuite(map(LoanSalaryTest, sorted(n for n in vars(LoanSalaryTest) if n.startswith('test_'))))])
