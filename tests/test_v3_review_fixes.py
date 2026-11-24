"""The live-data review of 24 Nov 2026 (docs: reviews/app-review-2026-11-24.md): one "short by", one interest figure,
who pays a card, overdue items, "no rush" for people you owe, cash against the next 30 days, card instalments, labels
and the card extras (migration 012). Same harness as test_v3_plan (SQLite; Postgres with V3_TEST_DATABASE_URL)."""
import engine
import domain
from api import classify, ledger
from api.db import Scoped, now
from tests import test_v3_overview, test_v3_plan

M = test_v3_overview.M


class ReviewFixesTest(test_v3_plan.PlanTest):
    acct, on = test_v3_overview.OverviewTest.acct, test_v3_overview.OverviewTest.on  # helpers only: its tests run in their own module

    def setUp(self):
        super().setUp()
        self.last = engine.add_months(self.today[:7], -1)
        self.db.run("UPDATE accounts SET country = 'SA', last_balance_minor = 3000_00, last_balance_at = :t WHERE id = :a", t=now(), a=self.bank)

    def test_one_short_by(self):
        """Home's Expected card, Home's alert, the look-ahead and Plan show one gap: income minus the dues counted this
        month. A card counts its statement by its due date; the rest of its balance is revolving debt, not counted."""
        self.ok('PUT', '/settings', {'salary_minor': 10000_00, 'salary_currency': 'SAR'})
        self.ok('POST', '/commitments', {'name': 'Rent', 'kind': 'rent', 'amount_minor': 6000_00, 'currency': 'SAR', 'cycle_months': 1,
                                         'next_due': self.today, 'country': 'SA'})
        self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Car loan', 'currency': 'SAR', 'principal_minor': 50000_00,
                                         'rate_bp': 500, 'emi_minor': 3000_00, 'due_day': 28, 'as_of': self.today})
        card = self.acct('credit_card', 'SNB', 'SAR', 'SA', -9000_00)
        self.ok('PATCH', f'/accounts/{card}', {'statement_due_minor': 2500_00, 'statement_due_on': self.today})
        borrow = self.txn(700_00, 'debit', 'Groceries Ali paid')
        self.ok('PATCH', f'/transactions/{borrow}', {'purpose': 'borrow', 'person': {'kind': 'contact', 'id': self.ali}})
        this = self.ok('GET', '/insights/plan')['months'][0]
        lines = {x['kind']: x for x in this['lines']}
        self.assertEqual((lines['card']['amount'], lines['card']['counted']), (M(2500_00), True))
        self.assertEqual((lines['revolving']['amount'], lines['revolving']['counted']), (M(6500_00), False))
        self.assertIn('interest', lines['revolving']['note'])
        self.assertFalse(lines['person']['counted'])  # no due date: no rush
        self.assertIn('No rush', lines['person']['note'])
        self.assertEqual(this['short'], M(1500_00))  # 10,000 − (6,000 + 3,000 + 2,500)
        self.assertEqual(this['revolving'], M(6500_00))
        la = self.ok('GET', '/insights/lookahead', query='months=2')['months'][0]
        self.assertEqual(la['short'], this['short'])
        self.assertIn('Short by SAR 1,500', ' '.join(la['warnings']))
        h = self.ok('GET', '/insights/home')
        self.assertEqual(h['lookahead']['months'][0]['short'], this['short'])
        self.assertTrue(any('Short by SAR 1,500' in a['text'] for a in h['alerts']))
        # the person page's toggle counts what you owe them this month
        self.ok('PUT', f'/people/contact/{self.ali}/dues', {'count_in_dues': True})
        self.assertTrue(self.ok('GET', f'/people/contact/{self.ali}')['person']['count_in_dues'])
        this = self.ok('GET', '/insights/plan')['months'][0]
        self.assertEqual(this['short'], M(2200_00))
        self.ok('PUT', f'/people/contact/{self.ali}/dues', {'count_in_dues': False})
        self.assertEqual(self.ok('GET', '/insights/plan')['months'][0]['short'], M(1500_00))
        self.assertEqual(self.call('PUT', f'/api/people/contact/{self.ali}/dues', {'count_in_dues': 'yes'})[0], 400)
        self.assertEqual(self.call('PUT', '/api/people/contact/nobody/dues', {'count_in_dues': True})[0], 404)

    def test_one_interest_figure(self):
        """A card's interest is what it really charged (3-month average), its rate inferred from that; Home's debt card
        (payoff), Month, the card page, the look-ahead and the debt plan agree. No data: the assumed rate, labelled."""
        card = self.acct('credit_card', 'SNB', 'SAR', 'SA', -12000_00)
        for k, fee in ((1, 300_00), (2, 200_00), (3, 100_00)):
            day = engine.add_months(self.today[:7], -k) + '-10'
            self.on(card, fee, 'debit', 'FINANCE CHARGE', day, purpose='fee')
            self.on(card, 1000_00, 'debit', 'Shop', day)
        quiet = self.acct('credit_card', 'Quiet card', 'INR', 'IN', -5000_00)
        p = self.ok('GET', '/insights/payoff')
        debts = {d['id']: d for d in p['debts']}
        self.assertEqual((debts[card]['rate_bp'], debts[card]['rate_assumed']), (2000, False))  # 200 × 12 ÷ 12,000 = 20%
        self.assertEqual((debts[quiet]['rate_bp'], debts[quiet]['rate_assumed']), (3600, True))
        quiet_interest = round(5000_00 * 3600 / 120000 / 25)
        self.assertEqual(p['interest_now']['cards'], M(200_00 + quiet_interest))
        self.assertTrue(any('Quiet card' in n and 'assumed' in n for n in p['assumptions']))
        month = self.ok('GET', '/insights/month', query='month=' + self.today[:7])
        self.assertEqual(month['interest_month'], p['interest_now']['total'])
        self.assertEqual(self.ok('GET', '/insights/lookahead', query='months=1')['interest_per_month'], p['interest_now']['total'])
        c = self.ok('GET', f'/insights/card/{card}')
        self.assertEqual((c['interest_month'], c['rate_bp'], c['rate_assumed'], c['interest_source']), (M(200_00), 2000, False, 'charges'))
        self.assertEqual(c['months'][-2]['interest'], M(300_00))
        # a rate the card states wins for the plan; the interest a month stays what was charged
        self.ok('PATCH', f'/accounts/{card}', {'rate_bp': 3000})
        self.assertEqual(self.ok('GET', f'/insights/card/{card}')['rate_bp'], 3000)
        self.assertEqual(self.ok('GET', f'/insights/card/{card}')['interest_month'], M(200_00))
        # a loan: its schedule
        loan = self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Car loan', 'currency': 'SAR', 'principal_minor': 120000_00,
                                                'rate_bp': 600, 'emi_minor': 3000_00})
        self.assertEqual(loan['interest_month'], M(600_00))
        self.assertEqual(self.ok('GET', '/insights/payoff')['interest_now']['loans'], M(600_00))

    def test_card_paid_from_the_account_that_last_paid_it(self):
        axis = self.acct('bank', 'Axis Bank', 'INR', 'IN', 2000_00, last4='8138')
        self.acct('bank', 'HDFC Bank', 'INR', 'IN', 900000_00, last4='8236')  # the biggest: the old default
        card = self.acct('credit_card', 'SBI Card', 'INR', 'IN', -40000_00, last4='8412')
        for k, src in ((2, self.acct('bank', 'Old bank', 'INR', 'IN', 0)), (1, axis)):
            day = engine.add_months(self.today, -k)
            pay, got = self.on(src, 5000_00, 'debit', 'Card payment', day, 'INR'), self.on(card, 5000_00, 'credit', 'Payment received', day, 'INR')
            self.ins('txn_links', kind='transfer', from_txn=pay, to_txn=got, set_by='rule', created_at=now())
        line = next(x for x in self.ok('GET', '/insights/plan')['months'][0]['lines'] if x['kind'] == 'card')
        self.assertEqual((line['account_id'], line['account_name'], line['name']), (axis, 'Axis Bank ··8138', 'SBI Card ··8412'))
        self.assertEqual(self.ok('GET', f'/insights/card/{card}')['payer'], {'id': axis, 'name': 'Axis Bank ··8138'})

    def test_overdue_instalment_and_recurring_payment(self):
        if self.today[8:] < '03':
            self.skipTest('needs a tracking start after the 1st and before today')
        since = self.today[:8] + '02'  # tracked from after this month's due date: the missed-EMI check skips it, the planner does not
        harish = self.ins('contacts', name='Harish', created_at=now())['id']
        self.ok('POST', '/liabilities', {'kind': 'loan', 'name': 'Shared loan', 'currency': 'SAR', 'principal_minor': 50000_00, 'rate_bp': 0,
                                         'emi_minor': 2000_00, 'due_day': 1, 'as_of': since, 'holder_contact_id': harish, 'my_share_pct': 50})
        self.ok('POST', '/commitments', {'name': 'Internet', 'kind': 'bill', 'amount_minor': 300_00, 'currency': 'SAR', 'cycle_months': 1,
                                         'next_due': self.today[:8] + '01', 'country': 'SA'})
        lines = {x['name']: x for x in self.ok('GET', '/insights/plan')['months'][0]['lines']}
        self.assertTrue(lines['Shared loan']['overdue'] and lines['Internet']['overdue'])
        self.assertEqual(lines['Shared loan']['amount'], M(1000_00))  # your half
        alerts = [a['text'] for a in self.ok('GET', '/insights/home')['alerts'] if a.get('overdue')]
        self.assertTrue(any(t.startswith('Shared loan is overdue') for t in alerts), alerts)
        self.assertTrue(any(t.startswith('Internet is overdue') for t in alerts), alerts)
        paid = self.txn(1000_00, 'debit', 'To Harish')
        self.ok('PATCH', f'/transactions/{paid}', {'liability_id': next(l['id'] for l in self.ok('GET', '/liabilities')['items'])})
        lines = {x['name']: x for x in self.ok('GET', '/insights/plan')['months'][0]['lines']}
        self.assertFalse(lines['Shared loan']['overdue'])

    def test_cash_against_the_next_30_days(self):
        self.acct('bank', 'Axis Bank', 'INR', 'IN', 10000_00)
        due = engine.add_months(self.today, 1) if self.today[8:] > '27' else self.today[:8] + '28'
        self.ok('POST', '/commitments', {'name': 'Umma', 'kind': 'support', 'amount_minor': 60000_00, 'currency': 'INR', 'cycle_months': 1,
                                         'next_due': min(due, engine.add_months(self.today, 1)), 'country': 'IN'})
        top = [a for a in self.ok('GET', '/insights/home')['alerts'] if a.get('top')]
        self.assertEqual(len(top), 1)
        self.assertEqual(top[0]['country'], 'IN')
        self.assertIn('Due in 30 days INR 60,000, in accounts INR 10,000, move SAR 2,000', top[0]['text'])  # ₹50,000 at 25

    def test_card_instalments(self):
        card = self.acct('credit_card', 'SBI Card', 'INR', 'IN', -1000_00)
        emi = self.on(card, 4166_00, 'debit', 'SBI CARD PAY IN EMIS 3/12', currency='INR')
        interest = self.on(card, 410_00, 'debit', 'INTEREST ON EMI 3/12', currency='INR')
        classify.reclassify(Scoped(self.db, self.hid), [emi, interest])
        e, i = self.ok('GET', f'/transactions/{emi}'), self.ok('GET', f'/transactions/{interest}')
        self.assertEqual((e['category'], e['purpose'], e['instalment']), ('Card instalments', 'spend', {'n': 3, 'of': 12, 'left': 9}))
        self.assertEqual((i['category'], i['purpose']), ('Card instalments', 'fee'))  # the interest part is still a loss
        loss = self.ok('GET', '/insights/month', query='month=' + self.today[:7])['loss']['by_category']
        self.assertEqual([x['category'] for x in loss], ['Card instalment interest'])
        self.assertEqual(domain.instalment('Instalment 02 of 06'), {'n': 2, 'of': 6, 'left': 4})
        self.assertIsNone(domain.instalment('Amazon order 2/3'))

    def test_labels_without_doubled_words(self):
        self.assertEqual(ledger.label('SBI Card', 'SBI Card', '8412'), 'SBI Card ··8412')
        self.assertEqual(ledger.label('Federal Bank', 'Federal OneCard', '8235'), 'Federal OneCard ··8235')
        self.assertEqual(ledger.label('RiyadBank', 'Main', '7777'), 'RiyadBank ··7777')
        self.assertEqual(ledger.label('HDFC', 'HDFC', None), 'HDFC')
        self.assertEqual(ledger.label(None, 'Cash', None), 'Cash')
        self.acct('credit_card', 'Federal Bank', 'INR', 'IN', -100_00, last4='8235')
        self.db.run("UPDATE accounts SET name = 'Federal OneCard' WHERE institution = 'Federal Bank'")
        self.assertIn('Federal OneCard ··8235', {d['name'] for d in self.ok('GET', '/insights/payoff')['debts']})

    def test_card_extras(self):
        card = self.acct('credit_card', 'SNB', 'SAR', 'SA', -100_00)
        c = self.ok('GET', f'/insights/card/{card}')
        self.assertEqual([c[k] for k in ('rewards', 'annual_fee', 'forex_markup_bp', 'interest_free_days')], [None] * 4)
        self.ok('PATCH', f'/accounts/{card}', {'rewards': '1% cashback', 'annual_fee_minor': 250_00, 'forex_markup_bp': 275, 'interest_free_days': 50})
        c = self.ok('GET', f'/insights/card/{card}')
        self.assertEqual([c[k] for k in ('rewards', 'annual_fee', 'forex_markup_bp', 'interest_free_days')], ['1% cashback', M(250_00), 275, 50])
        self.ok('PATCH', f'/accounts/{card}', {'annual_fee_minor': None})
        self.assertIsNone(self.ok('GET', f'/insights/card/{card}')['annual_fee'])
        self.assertEqual(self.call('PATCH', f'/api/accounts/{card}', {'interest_free_days': 500})[0], 400)

    def test_networth_history(self):
        self.on(self.bank, 1000_00, 'credit', 'Salary', self.today)
        n = self.ok('GET', '/insights/networth')
        h = n['history']
        self.assertEqual(len(h), 6)
        self.assertEqual(h[-1]['net'], n['net'])
        self.assertEqual(h[-2]['net'], M(n['net']['minor'] - 1000_00))  # before this month's credit


for _name in [k for k in vars(test_v3_plan.PlanTest) if k.startswith('test_')]:  # the harness only: PlanTest's own tests run in their module
    setattr(ReviewFixesTest, _name, None)
