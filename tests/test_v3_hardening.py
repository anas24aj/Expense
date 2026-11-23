"""Hardening before the bulk load: re-import after delete, viewer role, /api/shared links, unsupported currencies,
foreign-currency SMS, atomic migrations, the errors table and targeted reclassify. Runs on SQLite or TEST_DATABASE_URL."""
import base64
import json
import tempfile
import unittest
from pathlib import Path

from test_v3_core import Base, Client, signup  # noqa: F401  (also sets DATABASE_URL for the run)

import api.db as dbmod  # noqa: E402
from api import app as router  # noqa: E402
from api.db import DB, Scoped, now  # noqa: E402


def household(c):
    return Scoped(DB(), c.ok('GET', '/api/auth/me')['household']['id'])


class HardeningTest(Base):
    def test_reimport_after_deleting_statement(self):
        c = signup('re@x.com')
        acc = c.ok('POST', '/api/accounts', {'kind': 'bank', 'name': 'SNB', 'currency': 'SAR'})
        csv = b'Date,Description,Debit,Credit,Balance\n01/10/2026,POS PANDA X,12.00,,100.00\n02/10/2026,POS PANDA Y,13.00,,87.00\n'
        body = {'account_id': acc['id'], 'file_name': 'r.csv', 'data_base64': base64.b64encode(csv).decode()}
        first = c.ok('POST', '/api/ingest/statement', body)
        self.assertEqual(first['new'], 2)
        c.ok('DELETE', f"/api/ingest/statements/{first['statement']['id']}")
        again = c.ok('POST', '/api/ingest/statement', body)
        self.assertEqual((again['new'], again['duplicates']), (2, 0))
        one = c.ok('GET', f"/api/transactions?account_id={acc['id']}")['items'][0]
        c.ok('DELETE', f"/api/transactions/{one['id']}")  # one deleted row comes back too
        self.assertEqual(c.ok('POST', '/api/ingest/statement', body)['new'], 1)

    def test_viewer_cannot_write_through_api_or_mcp(self):
        owner = signup('vo@x.com')
        m = owner.ok('POST', '/api/members', {'display_name': 'Afaq', 'email': 'viewer@x.com', 'role': 'viewer'})
        v = signup('viewer@x.com', name='Afaq', invite=m['invite']['link'].split('t=')[1])
        self.assertEqual(v.ok('GET', '/api/auth/me')['member']['role'], 'viewer')
        self.assertEqual(v.ok('GET', '/api/transactions')['items'], [])
        add = {'day': '2026-11-02', 'amount_minor': 500, 'currency': 'SAR', 'merchant': 'X'}
        self.assertEqual(v.call('POST', '/api/transactions', add)[0], 403)
        self.assertEqual(v.call('POST', '/api/devices', {'name': 'p', 'platform': 'android'})[0], 403)
        key = v.ok('GET', '/api/mcp-key')['url'].split('/mcp/')[1]
        rpc = lambda name, args: Client().call('POST', f'/mcp/{key}', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}})
        self.assertTrue(rpc('add_transaction', add)[1]['result']['isError'])
        self.assertFalse(rpc('list_transactions', {})[1]['result']['isError'])
        owner.ok('POST', '/api/transactions', add)  # owners still write

    def test_shared_needs_the_contact_invite_link(self):
        owner = signup('so@x.com')
        harish = owner.ok('POST', '/api/contacts', {'name': 'Harish', 'email': 'harish2@x.com'})
        t = owner.ok('POST', '/api/transactions', {'day': '2026-11-02', 'amount_minor': 4000, 'currency': 'SAR', 'direction': 'debit', 'merchant': 'Rent'})
        owner.ok('POST', f"/api/transactions/{t['id']}/split", {'shares': [{'contact_id': harish['id'], 'share_minor': 2000}]})
        squatter = signup('harish2@x.com', name='Not Harish')  # same email, no link: sees nothing
        self.assertEqual(squatter.ok('GET', '/api/shared')['items'], [])
        token = owner.ok('POST', f"/api/contacts/{harish['id']}/invite")['link'].split('invite=')[1]
        self.assertEqual(squatter.call('POST', '/api/auth/login', {'login': 'harish2@x.com', 'password': 'correct horse', 'invite': token[:-2] + 'xx'})[0], 404)
        h = signup('harish@elsewhere.com', name='Harish', invite=token)
        got = h.ok('GET', '/api/shared')['items']
        self.assertEqual((len(got), got[0]['you_owe']), (1, [{'minor': 2000, 'currency': 'SAR'}]))
        self.assertEqual(h.ok('GET', '/api/auth/me')['member']['role'], 'owner')  # their own household, not a member here
        squatter.ok('POST', '/api/auth/login', {'login': 'harish2@x.com', 'password': 'correct horse', 'invite': token})
        self.assertEqual(squatter.ok('GET', '/api/shared')['items'], [])  # the first account to accept keeps it

    def test_unsupported_currency(self):
        c = signup('eur@x.com')
        self.assertEqual(c.call('POST', '/api/transactions', {'day': '2026-11-02', 'amount_minor': 5000, 'currency': 'EUR', 'merchant': 'Paris'})[0], 400)
        c.ok('POST', '/api/transactions', {'day': '2026-11-02', 'amount_minor': 5000, 'currency': 'SAR', 'merchant': 'Panda'})
        hh = household(c)
        hh.insert('transactions', occurred_at='2026-11-02T10:00:00+00:00', day='2026-11-02', amount_minor=5000, currency='EUR', direction='debit',
                  merchant='Paris cafe', merchant_raw='Paris cafe', source='manual', dedupe_key='eur.1', created_at=now())  # one that got in earlier
        self.assertEqual(c.call('GET', '/api/insights/home')[0], 200)
        self.assertEqual(c.call('GET', '/api/insights/month?month=2026-11')[0], 200)
        self.assertIn('Paris cafe', [t['merchant'] for t in c.ok('GET', '/api/transactions')['items']])

    def test_foreign_currency_sms_on_a_sar_card(self):
        c = signup('fx@x.com')
        card = c.ok('POST', '/api/accounts', {'kind': 'credit_card', 'name': 'SAB card', 'currency': 'SAR', 'last4': '4444', 'institution': 'SAB',
                                              'opening_balance_minor': 0, 'opening_as_of': '2026-11-01'})
        key = c.ok('POST', '/api/devices', {'name': 'p', 'platform': 'android'})['key']
        sms = lambda body, at: Client().call('POST', '/api/ingest/sms', {'sender': 'SAB', 'body': body, 'received_at': at}, bearer=key)[1]
        t = sms('USD 10.00 spent on your credit card XX4444 at AMAZON.COM (SAR 37.60)', '2026-11-05T10:00:00+03:00')['transaction']
        self.assertEqual((t['account_id'], t['amount']), (card['id'], {'minor': 3760, 'currency': 'SAR'}))
        csv = b'Date,Description,Debit,Credit,Balance\n05/11/2026,AMAZON.COM,37.60,,\n'
        out = c.ok('POST', '/api/ingest/statement', {'account_id': card['id'], 'file_name': 's.csv', 'data_base64': base64.b64encode(csv).decode()})
        self.assertEqual((out['new'], out['duplicates']), (0, 1))  # the SMS is the statement row: counted once
        u = sms('USD 20.00 spent on your credit card XX4444 at STEAM', '2026-11-06T10:00:00+03:00')['transaction']
        self.assertEqual(u['amount'], {'minor': 2000, 'currency': 'USD'})
        self.assertIn(u['id'], [i['id'] for i in c.ok('GET', '/api/review')['items']])  # a probable duplicate: in Review
        bal = next(a for a in c.ok('GET', '/api/accounts')['items'] if a['id'] == card['id'])['balance']
        self.assertEqual(bal, {'minor': -3760, 'currency': 'SAR'})  # the USD row is not added to a SAR balance

    def test_commitment_reclassifies_only_its_matches(self):
        c = signup('rc@x.com')
        add = lambda m: c.ok('POST', '/api/transactions', {'day': '2026-11-02', 'amount_minor': 20000, 'currency': 'SAR', 'merchant': m})['id']
        stc, mob = add('STC BILL'), add('MOBILY')
        com = c.ok('POST', '/api/commitments', {'name': 'Phone', 'kind': 'bill', 'amount_minor': 20000, 'currency': 'SAR', 'cycle_months': 1,
                                                 'next_due': '2026-12-02', 'match_pattern': 'stc'})
        cid = lambda t: c.ok('GET', f'/api/transactions/{t}')['commitment_id']
        self.assertEqual((cid(stc), cid(mob)), (com['id'], None))
        c.ok('PATCH', f"/api/commitments/{com['id']}", {'match_pattern': 'mobily'})
        self.assertEqual((cid(stc), cid(mob)), (None, com['id']))

    def test_errors_are_kept_for_the_admin(self):
        if not any(rx.pattern == '^/api/test-boom$' for _, rx, _, _ in router._routes):
            router.route('GET', '/api/test-boom')(lambda req: 1 / 0)
        owner = signup('err@x.com')
        self.assertEqual(owner.call('GET', '/api/test-boom')[0], 500)
        items = owner.ok('GET', '/api/admin/errors')['items']
        self.assertEqual((items[0]['route'], items[0]['kind']), ('GET /api/test-boom', 'ZeroDivisionError'))
        self.assertLessEqual(len(items[0]['trace']), 4096)
        self.assertEqual(signup('other@x.com').ok('GET', '/api/admin/errors')['items'], [])  # another household's errors stay theirs
        m = owner.ok('POST', '/api/members', {'display_name': 'M', 'email': 'mem@x.com', 'role': 'member'})
        self.assertEqual(signup('mem@x.com', invite=m['invite']['link'].split('t=')[1]).call('GET', '/api/admin/errors')[0], 403)

    def test_a_failing_migration_leaves_nothing_behind(self):
        db0 = DB()  # migrated
        url = db0.url
        db0.close()
        saved, tmp = dbmod.MIGRATIONS, Path(tempfile.mkdtemp())
        (tmp / '999_bad.sql').write_text('CREATE TABLE mig_probe (a INTEGER);\nCREATE TABLE mig_probe (a INTEGER);')
        dbmod.MIGRATIONS = tmp
        dbmod._ready.discard(url)
        try:
            with self.assertRaises(Exception):
                DB()
        finally:
            dbmod.MIGRATIONS = saved
            dbmod._idle.clear()
        db = DB()
        dbmod._ready.add(db.url)
        self.assertIsNone(db.one("SELECT name FROM schema_migrations WHERE name = '999_bad.sql'"))
        probe = "SELECT to_regclass('mig_probe') IS NOT NULL AS ok" if db.pg else "SELECT COUNT(*) AS ok FROM sqlite_master WHERE name = 'mig_probe'"
        self.assertFalse(db.one(probe)['ok'])


if __name__ == '__main__':
    unittest.main()
