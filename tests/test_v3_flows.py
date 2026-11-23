"""Money flow between accounts and per-account coverage."""
import unittest

from api import db as dbmod
from tests.test_v3_core import Base, signup


class FlowsTest(Base):
    def test_flows_and_coverage(self):
        c = signup('flow@x.com')
        hid = c.ok('GET', '/api/auth/me')['household']['id']
        bank = c.ok('POST', '/api/accounts', {'kind': 'bank', 'name': 'Al Rajhi', 'currency': 'SAR'})['id']
        card = c.ok('POST', '/api/accounts', {'kind': 'credit_card', 'name': 'Card', 'currency': 'SAR'})['id']
        # salary in, groceries out, a card payment from the bank (a transfer), and nothing in the bank for two months
        sal = c.ok('POST', '/api/transactions', {'account_id': bank, 'day': '2026-08-01', 'amount_minor': 2000000, 'currency': 'SAR', 'direction': 'credit', 'merchant': 'Salary', 'purpose': 'income'})
        c.ok('POST', '/api/transactions', {'account_id': card, 'day': '2026-11-03', 'amount_minor': 30000, 'currency': 'SAR', 'direction': 'debit', 'merchant': 'Panda', 'category': 'Groceries', 'purpose': 'spend'})
        out = c.ok('POST', '/api/transactions', {'account_id': bank, 'day': '2026-11-05', 'amount_minor': 30000, 'currency': 'SAR', 'direction': 'debit', 'merchant': 'Card payment', 'purpose': 'transfer'})
        inn = c.ok('POST', '/api/transactions', {'account_id': card, 'day': '2026-11-05', 'amount_minor': 30000, 'currency': 'SAR', 'direction': 'credit', 'merchant': 'Payment received', 'purpose': 'transfer'})
        c.ok('POST', f"/api/transactions/{out['id']}/link", {'to_txn_id': inn['id'], 'kind': 'transfer'})
        f = c.ok('GET', '/api/insights/flows?from=2026-08-01&to=2026-11-30')
        pairs = {(l['source'], l['target']): l['amount']['minor'] for l in f['links']}
        self.assertEqual(pairs[('in:income', 'acc:' + bank)], 2000000)
        self.assertEqual(pairs[('acc:' + bank, 'acc:' + card)], 30000)  # drawn once, bank → card
        self.assertEqual(pairs[('acc:' + card, 'cat:Groceries')], 30000)
        self.assertNotIn(('in:transfer', 'acc:' + card), pairs)
        cov = {a['name']: a for a in c.ok('GET', '/api/accounts/coverage')['items']}
        self.assertEqual(cov['Al Rajhi']['first_month'], '2026-08')
        self.assertIn('2026-09', cov['Al Rajhi']['missing_months'])
        self.assertEqual(cov['Al Rajhi']['status'], 'gaps')
        self.assertEqual(c.call('GET', '/api/insights/flows?from=2026-12-01&to=2026-01-01')[0], 400)
        self.assertTrue(sal)


if __name__ == '__main__':
    unittest.main()
