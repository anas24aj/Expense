import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # tests live next to app/*.py
from test_expense import StatementReaderTest  # noqa: E402,F401  (re-exported so discover finds it)
import unittest  # noqa: E402

import statement  # noqa: E402
from test_expense import pdf  # noqa: E402

# Synthetic layouts only: made-up names, numbers and amounts.
COMBINED = ['Account Number : 11112222333344441', 'Opening Balance : 10.00',
            ' SUMMARY', '   10.00   0.00   0.00   10.00',
            'Account Number : 55556666777788882',
            '   Txn Date   Narration                 Withdrawals       Deposits      Closing Balance',
            '   02/12/2024  UPI-SHOP ONE                1,500.00           0.00             8,500.00',
            '   04/12/2024  UPI-SELF                        0.00       5,000.00            13,500.00']
EPASS = ['Account Number:999988887777', '          Opening Balance                          2384.14',
         '  27-Aug-2026   LOAN DRAWDOWN FROM          2384.14                                0.00',
         '                CASA. Cheque No.:0',
         '                UPI/CR/1234/A',
         '  29-Aug-2026   PERSON/PAYMENT                                  26000.00      26000.00']
FEDERAL = ['    Date        Particulars               Withdrawals        Deposits      Balance        DR',
           '                Opening Balance                                               0      Cr',
           '28-AUG-2024    IFN/TRANSFER IN                                450198.75     450198.75',
           '28-AUG-2024    MB IMPS/OUT                    200000.00                    250198.75',
           '  02-SEP-2024        MB IMPS/OUT SHIFTED PAGE                        10000.00     240198.75']
CARD = ['   Opening     Payment/     Purchase/   Finance    Total Dues',
        '   Balance     Credits      Debits      Charges',
        '   100.00      100.00       45.00       0.00       45.00',
        '      Date              Transaction Description                      Amount (in Rs.)',
        '   02/01/2025 17:00:10  TELE TRANSFER CREDIT                         100.00 Cr',
        '   05/01/2025           SOME SHOP CITY                                45.00']
SBICARD = ['   Date        Transaction Details                                   Amount ( ` )',
           '   02 Mar 25   SOME SHOP CITY                                        1,000.00 D',
           '               FORGN CURR MARKUP DB (EXCL TAX 4.58)                     30.00 D',
           '               IGST CR @ 18.00%                                          5.40 C',
           '   19 Mar 25   FP EMI 05/18(EXCL TAX 1.00)                             500.00 M']


class NewLayoutsTest(unittest.TestCase):
    def test_combined_statement_tags_each_account(self):
        rows = statement.read_statement(pdf(COMBINED))['rows']
        self.assertEqual([(r['account'], r['amount_minor'], r['direction']) for r in rows], [('8882', 150000, 'debit'), ('8882', 500000, 'credit')])
        self.assertNotIn('account', statement.read_statement(pdf(COMBINED[4:]))['rows'][0])  # one account: no tag

    def test_epass_first_row_from_opening_balance(self):
        rows = statement.read_statement(pdf(EPASS))['rows']
        self.assertEqual([(r['amount_minor'], r['direction']) for r in rows], [(238414, 'debit'), (2600000, 'credit')])

    def test_opening_line_is_not_a_header_and_balance_beats_shifted_columns(self):
        rows = statement.read_statement(pdf(FEDERAL))['rows']
        self.assertEqual([r['direction'] for r in rows], ['credit', 'debit', 'debit'])

    def test_card_amount_column_with_cr_suffix(self):
        rows = statement.read_statement(pdf(CARD))['rows']
        self.assertEqual([(r['amount_minor'], r['direction']) for r in rows], [(10000, 'credit'), (4500, 'debit')])

    def test_sbi_card_markup_lines_and_memo_emi(self):
        rows = statement.read_statement(pdf(SBICARD))['rows']
        self.assertEqual([(r['amount_minor'], r['direction']) for r in rows], [(100000, 'debit'), (3000, 'debit'), (540, 'credit')])
