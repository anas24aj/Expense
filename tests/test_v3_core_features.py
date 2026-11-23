"""The expense-manager core (api/insights.py): the monthly overview (spending by category, what is not spending, losses
apart, last month and the trend), the cards-first payoff ("how many months to recover"), card balances from the card
account, and card due alerts. Same harness as test_v3_plan (SQLite; Postgres with V3_TEST_DATABASE_URL)."""
import unittest

import engine
from api.db import now
from tests import test_v3_plan

M = test_v3_plan.M


class PayoffMathTest(unittest.TestCase):
    def test_cards_first_then_loans_keep_their_emis(self):
        debts = [{'id': 'card', 'kind': 'card', 'balance': 10000_00, 'rate_bp': 3600, 'emi': 0},
                 {'id': 'loan', 'kind': 'loan', 'balance': 20000_00, 'rate_bp': 1200, 'emi': 2000_00}]
        p = engine.payoff(debts, 3000_00)
        # month 1: card 10,000 + 3% = 10,300, less 3,000 → 7,300; then 7,519 → 4,519; 4,654.57 → 1,654.57; 1,704.21 → cleared in month 4
        self.assertEqual(p['cards_months'], 4)
        self.assertEqual(p['cleared']['card'], 4)
        self.assertEqual(p['timeline'][0]['cards'], 7300_00)
        self.assertEqual(p['timeline'][0]['interest'], 300_00 + 200_00)
        # the loan never got more than its EMI while the card ran: 20,000 → 20,200 − 2,000 = 18,200 after month 1
        self.assertEqual(p['timeline'][0]['loans'], 18200_00)
        self.assertIsNotNone(p['debt_months'])
        self.assertLess(engine.payoff(debts, 3000_00, prepay_loans=True)['debt_months'], p['debt_months'])

    def test_no_surplus_never_clears_the_card(self):
        p = engine.payoff([{'id': 'c', 'kind': 'card', 'balance': 1000_00, 'rate_bp': 3600, 'emi': 0}], 0, cap=24)
        self.assertIsNone(p['cards_months'])
        self.assertIsNone(p['debt_months'])

    def test_spending_now_delays(self):
        debts = [{'id': 'c', 'kind': 'card', 'balance': 6000_00, 'rate_bp': 3600, 'emi': 0}]
        before, after = engine.payoff(debts, 2000_00), engine.payoff(debts, 2000_00, spend_now=4000_00)
        self.assertEqual(before['cards_months'], 4)
        self.assertGreater(after['cards_months'], before['cards_months'])
        self.assertGreater(after['interest'], before['interest'])

    def test_minimum_due_costs_more(self):
        card = [{'id': 'c', 'kind': 'card', 'balance': 6000_00, 'rate_bp': 3600, 'emi': 0}]
        self.assertGreater(engine.min_due_interest(card), engine.payoff(card, 2000_00)['card_interest'])
        self.assertEqual(engine.min_due_interest([{**card[0], 'kind': 'loan'}]), 0)


class CoreFeaturesTest(test_v3_plan.PlanTest):
    def acct(self, kind, name, currency, country, balance=None, **cols):
        return self.ins('accounts', kind=kind, name=name, institution=name, currency=currency, country=country, last_balance_minor=balance,
                        last_balance_at=now() if balance is not None else '', owner_member_id=self.member['id'], created_at=now(), **cols)['id']

    def tag(self, minor, merchant, purpose=None, category=None, day=None, direction='debit'):
        t = self.txn(minor, direction, merchant, day)
        self.ok('PATCH', f'/transactions/{t}', {k: v for k, v in (('purpose', purpose), ('category', category)) if v})
        return t

    def test_month_overview_counts_only_spending_and_keeps_losses_apart(self):
        last = engine.add_months(self.today, -1)
        self.tag(300_00, 'Panda', 'spend', 'Groceries')
        self.tag(100_00, 'Panda', 'spend', 'Groceries', day=last)
        self.tag(5000_00, 'To HDFC NRE', 'transfer', 'Transfer')          # between own accounts
        self.tag(2000_00, 'SNB card payment', 'transfer', 'Transfer')     # card bill payment
        self.tag(700_00, 'To Ali', 'lend')                                # lending
        self.tag(84_00, 'FINANCE CHARGE', 'fee', 'Interest & late fees')
        self.tag(12_00, 'FX markup', 'spend', 'FX markup & VAT')          # a loss by its category alone
        self.tag(10000_00, 'Salary', 'income', 'Salary', direction='credit')
        m = self.ok('GET', '/insights/month', query='month=' + self.today[:7])
        self.assertEqual(m['spent'], M(300_00 + 84_00 + 12_00))
        self.assertEqual(m['by_category'], [{'category': 'Groceries', 'amount': M(300_00), 'last': M(100_00)}])
        self.assertEqual(m['loss']['total'], M(96_00))
        self.assertEqual({x['category'] for x in m['loss']['by_category']}, {'Interest & late fees', 'FX markup & VAT'})
        self.assertEqual(m['saved'], M(m['income']['minor'] - 396_00))
        self.assertEqual(m['last_month'], {'month': last[:7], 'income': M(0), 'spent': M(100_00), 'saved': M(-100_00)})
        self.assertEqual(len(m['trend']), 12)
        self.assertEqual((m['trend'][-1]['month'], m['trend'][-1]['spent']), (self.today[:7], M(396_00)))
        self.assertEqual(m['trend'][-2]['spent'], M(100_00))

    def test_card_owed_comes_from_the_card_account(self):
        card = self.acct('credit_card', 'SNB', 'SAR', 'SA', -4000_00)
        # a liability entered with an old balance: the account's stated balance wins
        self.ok('POST', '/liabilities', {'kind': 'credit_card', 'name': 'SNB card', 'currency': 'SAR', 'opening_balance_minor': 0,
                                         'principal_minor': 0, 'account_id': card})
        self.acct('credit_card', 'HDFC', 'INR', 'IN', -25000_00)  # no liability row: still owed
        self.acct('credit_card', 'Riyad', 'SAR', 'SA', None)      # no balance yet: not owed, not zero-owed debt
        n = self.ok('GET', '/insights/networth')
        self.assertEqual(n['liabilities'], M(4000_00 + 1000_00))
        m = self.ok('GET', '/insights/month', query='month=' + self.today[:7])
        self.assertEqual(m['owed_by_you']['cards'], M(5000_00))
        p = self.ok('GET', '/insights/payoff')
        self.assertEqual({d['name']: d['balance'] for d in p['debts']}, {'SNB card': M(4000_00), 'HDFC': M(1000_00)})
        hdfc = next(d for d in p['debts'] if d['name'] == 'HDFC')
        self.assertEqual((hdfc['rate_bp'], hdfc['rate_assumed'], hdfc['local']), (3600, True, M(25000_00, 'INR')))
        self.assertEqual(next(d for d in p['debts'] if d['name'] == 'SNB card')['rate_bp'], 3000)
        self.assertTrue(any('assumed 36%' in a for a in p['assumptions']))
        accounts = {a['name']: a for a in self.ok('GET', '/accounts')['items']}
        self.assertIsNone(accounts['Riyad']['balance'])

    def test_payoff_months_and_what_if(self):
        self.ok('PUT', '/settings', {'salary_minor': 10000_00, 'salary_currency': 'SAR', 'extra_to_debt_minor': 3000_00})
        self.acct('credit_card', 'SNB', 'SAR', 'SA', -10000_00, rate_bp=3600)
        self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Car loan', 'currency': 'SAR', 'principal_minor': 20000_00,
                                         'opening_balance_minor': 20000_00, 'rate_bp': 1200, 'emi_minor': 2000_00})
        p = self.ok('GET', '/insights/payoff')
        self.assertEqual(p['surplus'], M(3000_00))
        self.assertEqual(p['cards']['months'], 4)  # as in PayoffMathTest
        self.assertEqual(p['cards']['month'], engine.add_months(self.today[:7], 4))
        self.assertEqual(p['interest_now'], {'cards': M(300_00), 'loans': M(200_00), 'total': M(500_00)})
        self.assertGreater(p['interest_saved']['minor'], 0)
        self.assertEqual(p['debts'][0]['kind'], 'card')
        self.assertEqual(p['timeline'][p['cards']['months'] - 1]['cleared'], ['SNB'])
        w = self.ok('GET', '/insights/payoff', query='spend_minor=500000')
        self.assertGreater(w['delay']['cards'], 0)
        self.assertGreater(w['delay']['interest']['minor'], 0)
        self.assertLess(self.ok('GET', '/insights/payoff', query='prepay=1')['debt_free']['months'], p['debt_free']['months'])
        self.assertEqual(self.call('GET', '/api/insights/payoff', query='spend_minor=-1')[0], 400)

    def test_next_month_plan_with_salary_history_and_an_old_due_date(self):
        self.ok('POST', '/salary', {'from_month': '2025-01', 'amount_minor': 20000_00, 'currency': 'SAR', 'kind': 'base'})
        old = engine.add_months(self.today, -3)  # entered long ago, never ticked off: it rolls on to the coming months
        self.ok('POST', '/commitments', {'name': 'Rent', 'kind': 'rent', 'amount_minor': 3000_00, 'currency': 'SAR', 'cycle_months': 1, 'next_due': old})
        this, nxt = self.ok('GET', '/insights/plan')['months']
        self.assertEqual(nxt['month'], engine.add_months(self.today[:7], 1))
        self.assertEqual(nxt['income'], M(20000_00))
        self.assertIn('Rent', [x['name'] for x in nxt['lines']])
        self.assertEqual(nxt['surplus'], M(20000_00 - sum(x['base']['minor'] for x in nxt['lines'] if x['counted'])))
        self.assertEqual(this['income'], M(20000_00))

    def test_card_page(self):
        card = self.acct('credit_card', 'SNB', 'SAR', 'SA', -1200_00, credit_limit_minor=10000_00, statement_day=1, due_day=20)
        for minor, d, merchant, purpose, cat in ((400_00, 'debit', 'Panda', 'spend', 'Groceries'), (50_00, 'debit', 'FINANCE CHARGE', 'fee', None),
                                                 (300_00, 'credit', 'Payment received', 'transfer', None)):
            t = self.txn(minor, d, merchant)
            self.db.run('UPDATE transactions SET account_id = :a WHERE id = :t', a=card, t=t)
            self.ok('PATCH', f'/transactions/{t}', {k: v for k, v in (('purpose', purpose), ('category', cat)) if v})
        c = self.ok('GET', f'/insights/card/{card}')
        self.assertEqual((c['owed'], c['used_pct'], c['rate_bp'], c['rate_assumed']), (M(1200_00), 12, 3000, True))
        self.assertEqual(len(c['months']), 6)
        self.assertEqual((c['months'][-1]['spent'], c['months'][-1]['lost'], c['months'][-1]['paid']), (M(400_00), M(50_00), M(300_00)))
        self.assertEqual(c['interest_month'], M(30_00))
        self.assertIsNotNone(c['statement'])
        bare = self.acct('credit_card', 'Riyad', 'SAR', 'SA', None)
        b = self.ok('GET', f'/insights/card/{bare}')
        self.assertEqual((b['owed'], b['statement'], b['next_due'], b['limit']), (None, None, None, None))
        self.assertEqual(self.call('GET', f'/api/insights/card/{self.bank}')[0], 404)

    def test_card_due_alert(self):
        due = int(self.today[8:10])
        if due > 28:
            self.skipTest('due days are capped at 28')
        self.acct('credit_card', 'SNB', 'SAR', 'SA', -1500_00, due_day=due)
        self.acct('credit_card', 'Paid off', 'SAR', 'SA', 0, due_day=due)
        alerts = [a for a in self.ok('GET', '/insights/home')['alerts'] if a.get('account_id')]
        self.assertEqual(len(alerts), 1)
        self.assertIn('SAR 1,500 due today', alerts[0]['text'])
