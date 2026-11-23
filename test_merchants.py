"""Merchant data (data/merchants.json) and fee detection: real-looking SMS land in the right category with no input."""
import json
import time
import unittest
from pathlib import Path

from parse import BRANDS, brand_category, categorize, compile_rules, merchant_of

HERE = Path(__file__).parent
RULES = compile_rules(json.loads((HERE / 'rules.json').read_text(encoding='utf-8')))

CASES = [
    # India: UPI handles, card descriptors, aggregators
    ('Rs.349.00 debited from A/c XX1234 on 02-Nov-26 to VPA zomato-order@ptybl (UPI Ref 6312345). -Axis', 'Food'),
    ('Sent Rs.120.00 From HDFC Bank A/C *1234 To BLINKIT On 03/11/26 Ref 63123', 'Groceries'),
    ('Rs 2,150.00 spent on your SBI Credit Card ending 4321 at BIGBASKET on 04/11/26.', 'Groceries'),
    ('INR 649.00 spent on ICICI Bank Card XX9012 on 05-Nov-26 at SPOTIFY INDIA. Avl Limit: INR 1,10,000.00', 'Subscriptions'),
    ('INR 1,950.00 spent on HDFC Bank Card x1111 at ANTHROPIC on 2026-11-05', 'Subscriptions'),
    ('USD 20.00 spent on ICICI Bank Card XX9012 on 06-Nov-26 at OPENAI *CHATGPT SUBSCR.', 'Subscriptions'),
    ('Rs 239.00 debited from A/c XX5678 to VPA jiorecharge@ybl (UPI Ref 6281234).', 'Bills & Utilities'),
    ('Rs.1,234.00 paid to BESCOM via Bharat BillPay from A/c XX12 on 07-11-26', 'Bills & Utilities'),
    ('Rs 999 debited from A/c XX12 towards AIRTEL PAYMENTS on 07-11-26', 'Bills & Utilities'),
    ('Rs.4,500.00 spent on Kotak Card x2222 at INDIGO on 08-11-26', 'Travel'),
    ('Rs.1,850.00 spent on Axis Card XX33 at MAKEMYTRIP INDIA PVT on 08-11-26', 'Travel'),
    ('Rs.2,000.00 spent at INDIAN OIL CORP FUEL STN on HDFC card x44 on 09-11-26', 'Transport'),
    ('Rs.150.00 paid to RAPIDO via UPI on 09-11-26', 'Transport'),
    ('Rs.450.00 debited to VPA irctc@sbi on 09-11-26', 'Transport'),
    ('Rs.589.00 spent on SBI Card at APOLLO PHARMACY on 10-11-26', 'Health'),
    ('Rs.320.00 paid to VPA bookmyshow@icici on 10-11-26', 'Entertainment'),
    ('Rs.5,000.00 debited from A/c XX12 to ZERODHA BROKING on 10-11-26', 'Investments'),
    ('Rs.12,000.00 debited from A/c XX12 to LIC OF INDIA on 10-11-26', 'Insurance'),
    ('Rs.1,299.00 spent on HDFC Card at MYNTRA DESIGNS on 11-11-26', 'Shopping'),
    ('Rs.899.00 spent on HDFC Card at RAZORPAY*SWIGGY on 11-11-26', 'Food'),
    ('Rs.499.00 spent on HDFC Card at PAYU*NYKAA on 11-11-26', 'Shopping'),
    ('Rs.1,500.00 paid to PASSPORT SEVA via UPI on 12-11-26', 'Government & fees'),
    ('Rs.600.00 spent on Axis Card at URBAN COMPANY on 12-11-26', 'Personal care'),
    ('Rs.3,000.00 spent on ICICI Card at UNACADEMY on 12-11-26', 'Education'),
    # India: fees and interest (no merchant at all)
    ('Finance charges of Rs 1,245.60 levied on your HDFC Bank Credit Card XX1234 for the billing period.', 'Fees & interest'),
    ('Late payment fee of Rs 750 + GST debited to your SBI Card ending 4321.', 'Fees & interest'),
    ('Annual fee of Rs.499 + GST charged on your ICICI Bank Credit Card XX9012.', 'Fees & interest'),
    ('Rs 17.70 debited from A/c XX1234 towards SMS charges for the quarter.', 'Fees & interest'),
    ('Forex markup of Rs 85.20 charged on your Axis Bank Card XX33 for txn at AMAZON WEB SERVICES', 'Fees & interest'),
    ('IGST of Rs 224.13 debited to your Credit Card XX1234', 'Fees & interest'),
    # Saudi: English descriptors
    ('PoS Purchase\nAmount: SAR 38.00\nCard: *1234\nAt: JAHEZ\nDate: 2026-11-01', 'Food'),
    ('Online Purchase\nBy: mada *5678\nAmount: 54.00 SAR\nAt: KEETA\nOn: 01/11/26', 'Food'),
    ('PoS Purchase\nAmount: SAR 120.00\nAt: STARBUCKS OLAYA 1123\nDate: 2026-11-02', 'Food'),
    ('PoS Purchase\nAmount: SAR 95.00\nAt: AL DREES PETROLEUM 223\nDate: 2026-11-02', 'Transport'),
    ('Online Purchase\nAmount: SAR 23.00\nAt: CAREEM\nOn: 03/11/26', 'Transport'),
    ('Online Purchase\nAmount: SAR 450.00\nAt: FLYNAS\nOn: 03/11/26', 'Travel'),
    ('Online Purchase\nAmount: SAR 230.00\nAt: STC\nOn: 04/11/26', 'Bills & Utilities'),
    ('Online Purchase\nAmount: SAR 310.00\nAt: SAUDI ELECTRICITY CO\nOn: 04/11/26', 'Bills & Utilities'),
    ('Online Purchase\nAmount: SAR 29.99\nAt: SHAHID\nOn: 05/11/26', 'Subscriptions'),
    ('Online Purchase\nAmount: SAR 11.99\nAt: APPLE.COM/BILL\nOn: 05/11/26', 'Subscriptions'),
    ('PoS Purchase\nAmount: SAR 64.50\nAt: NAHDI MEDICAL CO\nOn: 05/11/26', 'Health'),
    ('PoS Purchase\nAmount: SAR 210.00\nAt: OTHAIM MARKETS\nOn: 06/11/26', 'Groceries'),
    ('PoS Purchase\nAmount: SAR 89.00\nAt: WEBOOK\nOn: 06/11/26', 'Entertainment'),
    ('Online Purchase\nAmount: SAR 650.00\nAt: ABSHER\nOn: 07/11/26', 'Government & fees'),
    ('PoS Purchase\nAmount: SAR 199.00\nAt: CENTREPOINT RIYADH\nOn: 07/11/26', 'Shopping'),
    ('PoS Purchase\nAmount: SAR 75.00\nAt: KUDU 0045\nOn: 07/11/26', 'Food'),
    # Saudi: Arabic
    ('شراء عبر نقاط البيع\nمبلغ: ٤٥ ريال\nلدى: هرفي\nفي: 2026-11-08', 'Food'),
    ('شراء عبر الإنترنت\nمبلغ: ٢٣٠ ريال\nلدى: موبايلي\nفي: 2026-11-08', 'Bills & Utilities'),
    ('شراء عبر نقاط البيع\nمبلغ: ١٢٠ ريال\nلدى: صيدلية النهدي\nفي: 2026-11-08', 'Health'),
    ('شراء عبر الإنترنت\nمبلغ: ٥٠ ريال\nلدى: منصة إحسان\nفي: 2026-11-09', 'Charity'),
    ('خصم رسوم سنوية لبطاقة الائتمان\nمبلغ: ٢٨٧٫٥٠ ريال', 'Fees & interest'),
    ('Card annual fee\nAmount: SAR 287.50\nCard: *1234 Credit Card', 'Fees & interest'),
]


class MerchantDataTest(unittest.TestCase):
    def test_real_sms_find_their_category(self):
        for sms, category in CASES:
            with self.subTest(sms=sms):
                self.assertEqual(categorize(merchant_of(sms), sms, RULES), category)

    def test_brand_lookup(self):
        self.assertGreater(len(BRANDS), 2000)
        self.assertEqual(brand_category('POS PANDA RETAIL CO'), 'Groceries')
        self.assertEqual(brand_category('Hunger Station'), 'Food')         # spaced and unspaced forms both match
        self.assertEqual(brand_category('netflix.upi@hdfcbank'), 'Subscriptions')
        self.assertEqual(brand_category('PAYTM-ZOMATO'), 'Food')            # gateway prefix dropped
        self.assertEqual(brand_category('SONY LIV'), 'Subscriptions')       # the longest brand wins over 'Sony'
        self.assertIsNone(brand_category('ANIL KUMAR'))
        self.assertIsNone(brand_category('ZYXW TRADING EST'))

    def test_fees_word_alone_is_not_a_fee(self):
        sms = 'Auto debit of SAR 20.00 from A/c XX1234 via Mobile Banking. Fees SAR 0.00. Capital Holdings Co'
        self.assertEqual(categorize(merchant_of(sms), sms, RULES), 'Uncategorized')

    def test_every_category_is_known(self):
        tree = json.loads((HERE / 'data' / 'categories.json').read_text(encoding='utf-8'))
        rules = json.loads((HERE / 'rules.json').read_text(encoding='utf-8'))
        self.assertLessEqual(set(BRANDS.values()) | set(rules), set(tree))

    def test_fast(self):
        merchants = [merchant_of(sms) for sms, _ in CASES] + ['SOME LOCAL SHOP 12', 'ANIL K']
        start = time.perf_counter()
        for i in range(10_000):
            categorize(merchants[i % len(merchants)], CASES[i % len(CASES)][0], RULES)
        self.assertLess(time.perf_counter() - start, 1.0)


if __name__ == '__main__':
    unittest.main()
