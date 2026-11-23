"""Trips, claim import and reconciliation, on synthetic data in a throwaway SQLite database."""
import os
import tempfile
import unittest
from datetime import datetime
from types import SimpleNamespace

import openpyxl

from api import claims, trips
from api.app import ApiError
from api.db import DB, Scoped


def workbook(path, sheets):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for title, rows in sheets.items():
        ws = wb.create_sheet(title)
        for r in rows:
            ws.append(r)
    wb.save(path)


SIMPLE = [['Destination', 'Doha'], ['Start', 'End'], ['Purpose'], ['Bill Ref', 'Expense type', 'Amount in QR', 'Amount in SAR', 'Date of Expense'],
          ['flight.pdf', 'Flight', '-', 2592.05, datetime(2026, 8, 23)],
          ['car.jpg', 'CarRental', 715, 772.20, datetime(2026, 8, 23)],
          ['food1.jpg', 'Food', 100, 108, datetime(2026, 8, 24)],
          [None, None, 20, 21.6, None],  # continues the row above
          [None, 'Total', 835, 3493.85, None]]
MISC = [['Title'], [None], ['Date', 'Vendor / item', 'What / amount', 'Claimed', 'Policy', 'Remark', 'Files'],
        ['05 Oct 2026 (booked 03 Sep)', 'Qatar Airways', 'Onward flight', 'SAR 589.00', '', '', 'f.pdf'],
        ['05 Oct – 31 Oct 2026 (26 nights)', 'Hotel', '26 nights', 'QAR 8120.00 = SAR 8769.60', '', '', 'h.pdf']]
FOOD = [['Title'], [None], ['Day', 'Time', 'Vendor', 'What', 'Receipt total (QAR)', 'Claimed (QAR)', 'Name', 'Status', 'Files'],
        ['Mon 05 Oct 2026', '18:44', 'Biryani', 'shared dinner', 93, 46.5, '', '', 'b.jpg']]


class ParserTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def read(self, sheets):
        p = os.path.join(self.tmp.name, 'c.xlsx')
        workbook(p, sheets)
        return claims.read_claim(p)

    def test_simple_list(self):
        items = self.read({'Sheet1': SIMPLE})
        self.assertEqual([(i['day'], i['kind'], i['qar_minor'], i['sar_minor'], i['receipt_currency']) for i in items], [
            ('2026-08-23', 'Flight', 0, 259205, 'SAR'), ('2026-08-23', 'CarRental', 71500, 77220, 'QAR'),
            ('2026-08-24', 'Food', 10000, 10800, 'QAR'), ('2026-08-24', 'Food', 2000, 2160, 'QAR')])
        self.assertEqual(items[1]['bill_ref'], 'car.jpg')

    def test_pack_lists(self):
        items = self.read({'Travel_Misc': MISC, 'Food_Daily': FOOD})
        self.assertEqual([(i['day'], i['vendor'], i['qar_minor'], i['sar_minor']) for i in items],
                         [('2026-10-05', 'Qatar Airways', 0, 58900), ('2026-10-05', 'Hotel', 812000, 876960), ('2026-10-05', 'Biryani', 4650, 5022)])
        self.assertEqual(items[2]['receipt_minor'], 9300)  # a shared bill: receipt above the claim

    def test_unknown_layout(self):
        with self.assertRaises(ValueError):
            self.read({'1_Summary': [['nothing here']]})


class TripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = DB(os.path.join(self.tmp.name, 't.db'))
        self.hh = Scoped(self.db, 'h1')
        self.n = 0

    def call(self, fn, body=None, **params):
        return fn(SimpleNamespace(hh=self.hh, json=body or {}, params=params))

    def txn(self, day, minor, cur='QAR', direction='debit', hid='h1'):
        self.n += 1
        self.db.run("INSERT INTO transactions (id, household_id, occurred_at, day, amount_minor, currency, direction, source, dedupe_key, created_at) "
                    "VALUES (:i, :h, :d, :d, :m, :c, :dir, 'manual', :i, :d)", i=f't{self.n}', h=hid, d=day, m=minor, c=cur, dir=direction)
        return f't{self.n}'

    def test_migration_ran_on_both_new_tables(self):
        self.assertEqual(self.db.run('SELECT COUNT(*) AS n FROM trips')[0]['n'] + self.db.run('SELECT COUNT(*) AS n FROM claim_lines')[0]['n'], 0)

    def test_trip_validation_and_crud(self):
        with self.assertRaises(ApiError):
            self.call(trips.create_trip, {'name': 'x', 'start_on': '2026-08-27', 'end_on': '2026-08-23'})
        status, t = self.call(trips.create_trip, {'name': 'Doha', 'city': 'Doha', 'country': 'Qatar', 'start_on': '2026-08-23', 'end_on': '2026-08-27', 'currency': 'qar'})
        self.assertEqual((status, t['currency']), (201, 'QAR'))
        self.assertEqual(self.call(trips.update_trip, {'city': 'Lusail'}, id=t['id'])['city'], 'Lusail')
        self.assertEqual(len(self.call(trips.list_trips)['items']), 1)
        self.hh = Scoped(self.db, 'h2')  # another household sees nothing
        self.assertEqual(self.call(trips.list_trips)['items'], [])
        with self.assertRaises(ApiError):
            self.call(trips.get_trip, id=t['id'])

    def test_reconcile_end_to_end(self):
        _, t = self.call(trips.create_trip, {'name': 'Doha', 'start_on': '2026-08-23', 'end_on': '2026-08-27'})
        car = self.txn('2026-08-24', 71500)                 # claimed car rental, a day off
        self.txn('2026-08-24', 259205, 'SAR')               # the flight, paid in SAR
        coffee = self.txn('2026-08-25', 1800)               # not claimed
        taxi = self.txn('2026-08-26', 4000)                 # not claimed
        self.txn('2026-08-30', 999)                         # outside the trip
        self.txn('2026-08-25', 500, direction='credit')     # not a spend
        self.txn('2026-08-25', 777, hid='h2')               # someone else's
        p = os.path.join(self.tmp.name, 'c.xlsx')
        workbook(p, {'Sheet1': SIMPLE[:6]})
        self.assertEqual(claims.import_claim(self.hh, t['id'], p)['items'], 2)
        claims.import_claim(self.hh, t['id'], p)            # importing again replaces, not duplicates
        d = self.call(trips.get_trip, id=t['id'])
        self.assertEqual(len(d['matched']), 2)
        self.assertIn(car, [m['txn']['id'] for m in d['matched']])
        self.assertEqual(sorted(x['id'] for x in d['unclaimed']), sorted([coffee, taxi]))
        self.assertEqual(d['unmatched_items'], [])
        self.assertEqual(d['totals']['spent'], {'QAR': 71500 + 1800 + 4000, 'SAR': 259205})
        self.assertEqual(d['totals']['claimed'], {'QAR': 71500, 'SAR': 259205 + 77220})

        self.call(trips.tag, {'txn_id': coffee, 'status': 'personal'}, id=t['id'])
        d = self.call(trips.tag, {'txn_id': taxi, 'status': 'missed_claim'}, id=t['id'])
        self.assertEqual((d['totals']['personal'], d['totals']['missed']), ({'QAR': 1800}, {'QAR': 4000}))
        d = self.call(trips.tag, {'txn_id': coffee, 'status': ''}, id=t['id'])  # changeable
        self.assertEqual(d['totals']['personal'], {})
        for bad in ({'txn_id': coffee, 'status': 'nope'}, {'txn_id': 'zzz', 'status': 'personal'}):
            with self.assertRaises(ApiError):
                self.call(trips.tag, bad, id=t['id'])

    def test_matching_rules(self):
        item = {'day': '2026-10-05', 'qar_minor': 4650, 'receipt_minor': 9300, 'receipt_currency': 'QAR', 'sar_minor': 5022}
        t = lambda day, m, cur: {'day': day, 'amount_minor': m, 'currency': cur}
        self.assertTrue(trips.fits(item, t('2026-10-07', 9300, 'QAR')))   # the whole receipt, 2 days later
        self.assertTrue(trips.fits(item, t('2026-10-03', 4650, 'QAR')))
        self.assertTrue(trips.fits(item, t('2026-10-05', 5022, 'SAR')))
        self.assertFalse(trips.fits(item, t('2026-10-08', 4650, 'QAR')))  # 3 days
        self.assertFalse(trips.fits(item, t('2026-10-05', 4650, 'SAR')))  # right number, wrong currency

    def test_delete_trip_removes_its_claims(self):
        _, t = self.call(trips.create_trip, {'name': 'Doha', 'start_on': '2026-08-23', 'end_on': '2026-08-27'})
        p = os.path.join(self.tmp.name, 'c.xlsx')
        workbook(p, {'Sheet1': SIMPLE})
        claims.import_claim(self.hh, t['id'], p)
        self.call(trips.delete_trip, id=t['id'])
        self.assertEqual(self.db.run('SELECT COUNT(*) AS n FROM claim_lines')[0]['n'] + self.db.run('SELECT COUNT(*) AS n FROM claims')[0]['n'], 0)


if __name__ == '__main__':
    unittest.main()
