"""Sign-up, forgot / reset password, and per-phone device keys."""
import io
import json
import os
import tempfile
import unittest
from urllib.parse import parse_qs, urlencode, urlparse

import server

TOKEN = 'test-token-1234567890'


class AuthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ.update(EXPENSE_TOKEN=TOKEN, EXPENSE_DB=os.path.join(self.tmp.name, 'app.db'), DATABASE_URL='', ADMIN_PASSWORD='admin-pass-123')
        for k in ('SIGNUP', 'RESEND_API_KEY', 'MAIL_FROM'):
            os.environ.pop(k, None)

    def tearDown(self):
        os.environ.pop('ADMIN_PASSWORD', None)
        self.tmp.cleanup()

    def call(self, method, path, body=b'', auth='', cookie='', content_type='application/json', query='', ip='198.51.100.7'):
        result = {}
        environ = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query, 'HTTP_AUTHORIZATION': auth, 'HTTP_HOST': 'expense.test',
                   'HTTP_COOKIE': cookie, 'REMOTE_ADDR': ip, 'CONTENT_TYPE': content_type, 'CONTENT_LENGTH': str(len(body)), 'wsgi.input': io.BytesIO(body)}
        out = b''.join(server.app(environ, lambda status, headers: result.update(status=int(status[:3]), headers=dict(headers))))
        self.headers = result['headers']
        return result['status'], out

    def form(self, path, ip='198.51.100.7', **fields):
        self.call('POST', path, urlencode(fields).encode(), content_type='application/x-www-form-urlencoded', ip=ip)
        return self.headers.get('Location'), self.headers.get('Set-Cookie', '').split(';')[0]

    def sms(self, key, body):
        return self.call('POST', '/sms', json.dumps({'sender': 'Bank', 'body': body, 'received_at': '2026-11-01T10:00:00+03:00'}).encode(), auth=f'Bearer {key}')[0]

    def signup(self, email='new@example.com', password='new-pass-123'):
        return self.form('/signup', email=email, password=password)

    def test_signup_makes_an_account_with_its_own_data(self):
        self.assertEqual(self.call('GET', '/signup')[0], 200)
        location, cookie = self.signup('New@Example.com ')
        self.assertEqual(location, '/setup')
        me = json.loads(self.call('GET', '/api/me', cookie=cookie)[1])
        self.assertEqual((me['email'], me['owner']), ('new@example.com', False))
        self.assertEqual(self.signup()[0], '/signup?error=taken')
        self.assertEqual(self.signup('x@example.com', 'short')[0], '/signup?error=short')
        self.assertEqual(self.signup('not-an-email')[0], '/signup?error=email')
        self.assertEqual(self.form('/login', email='new@example.com', password='new-pass-123')[0], '/')
        self.assertEqual(self.call('GET', '/setup', cookie=cookie)[0], 200)
        self.assertEqual(self.call('GET', '/setup')[0], 303)  # signed out: to the sign-in page

    def test_closed_signup(self):
        os.environ['SIGNUP'] = 'closed'
        self.assertEqual((self.call('GET', '/signup')[0], self.headers['Location']), (303, '/login?error=closed'))
        self.assertEqual(self.signup(), ('/login?error=closed', ''))
        self.assertEqual(self.form('/login', email='new@example.com', password='new-pass-123')[0], '/login?error=1')

    def test_signup_and_forgot_are_rate_limited(self):
        for _ in range(server.MAX_FAILURES):
            self.assertEqual(self.form('/forgot', email='nobody@example.com')[0], '/forgot?sent=1')
        self.assertEqual(self.signup()[0], '/signup?error=locked')
        self.assertEqual(self.form('/signup', ip='203.0.113.9', email='a@example.com', password='new-pass-123')[0], '/setup')  # other networks still can

    def reset_links(self):
        self.call('POST', '/admin/login', b'password=admin-pass-123', content_type='application/x-www-form-urlencoded')
        admin = self.headers['Set-Cookie'].split(';')[0]
        return json.loads(self.call('GET', '/api/admin/resets', cookie=admin)[1])['resets']

    def test_forgot_and_reset_password(self):
        _, old_session = self.signup()
        # The same answer whether or not the email has an account.
        self.assertEqual(self.form('/forgot', email='nobody@example.com')[0], '/forgot?sent=1')
        self.assertEqual(self.form('/forgot', email='NEW@example.com')[0], '/forgot?sent=1')
        links = self.reset_links()
        self.assertEqual([r['email'] for r in links], ['new@example.com'])
        token = parse_qs(urlparse(links[0]['link']).query)['t'][0]
        self.assertTrue(links[0]['link'].startswith('https://expense.test/reset?t='))
        # Only the token's hash is stored.
        pub = server.DB()
        try:
            stored = pub.run('SELECT * FROM password_resets')[0]
        finally:
            pub.close()
        self.assertNotIn(token, json.dumps(dict(stored)))

        self.assertEqual(self.call('GET', '/reset', query=f't={token}')[0], 200)
        self.assertEqual(self.form('/reset', t=token, password='short')[0], f'/reset?t={token}&error=short')
        location, cookie = self.form('/reset', t=token, password='brand-new-pass')
        self.assertEqual(location, '/')
        self.assertEqual(self.call('GET', '/api/me', cookie=cookie)[0], 200)
        self.assertEqual(self.call('GET', '/api/me', cookie=old_session)[0], 401)  # other sessions end
        self.assertEqual(self.form('/reset', t=token, password='another-pass-1')[0], '/reset?error=expired')  # single use
        self.assertEqual(self.form('/login', email='new@example.com', password='brand-new-pass')[0], '/')
        self.assertEqual(self.reset_links(), [])

        # An expired link doesn't work.
        self.form('/forgot', email='new@example.com')
        token = parse_qs(urlparse(self.reset_links()[0]['link']).query)['t'][0]
        pub = server.DB()
        try:
            pub.run('UPDATE password_resets SET expires = 1')
        finally:
            pub.close()
        self.assertEqual(self.form('/reset', t=token, password='late-pass-123')[0], '/reset?error=expired')
        self.assertEqual(self.form('/reset', t='made-up', password='late-pass-123')[0], '/reset?error=expired')

    def test_device_keys(self):
        _, cookie = self.signup()
        sync_key = json.loads(self.call('GET', '/api/me', cookie=cookie)[1])['sync_key']
        add = lambda **d: self.call('POST', '/api/devices', json.dumps(d).encode(), cookie=cookie)
        self.assertEqual(add(name='My iPhone', platform='nokia')[0], 400)
        self.assertEqual(self.call('POST', '/api/devices', b'{"name":"x","platform":"iphone"}', auth=f'Bearer {sync_key}')[0], 401)  # a phone can't make keys
        status, out = add(name='My iPhone', platform='iphone')
        made = json.loads(out)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(made['setup']), {'url': 'https://expense.test/sms', 'key': made['key']})
        key, device = made['key'], made['devices'][0]
        self.assertEqual((device['name'], device['last_seen']), ('My iPhone', ''))

        self.assertEqual(self.sms(key, 'SAR 12.00 paid to CAFE ONE'), 201)
        listed = json.loads(self.call('GET', '/api/devices', cookie=cookie)[1])
        self.assertNotEqual(listed['devices'][0]['last_seen'], '')
        self.assertNotIn('key', listed['devices'][0])
        self.assertEqual(json.loads(self.call('GET', '/api/latest', cookie=cookie)[1])['count'], 1)  # landed in this person's data

        # Revoked: refused. The older sync key and the site password still work.
        _, other = self.signup('other@example.com')
        self.assertEqual(self.call('POST', '/api/devices/revoke', json.dumps({'id': device['id']}).encode(), cookie=other)[0], 404)  # not theirs
        self.assertEqual(self.call('POST', '/api/devices/revoke', json.dumps({'id': device['id']}).encode(), cookie=cookie)[0], 200)
        self.assertEqual(self.sms(key, 'SAR 13.00 paid to CAFE TWO'), 401)
        self.assertEqual(self.sms(sync_key, 'SAR 14.00 paid to CAFE THREE'), 201)
        self.assertEqual(self.sms(TOKEN, 'SAR 15.00 paid to OWNER SHOP'), 201)
        self.assertEqual(json.loads(self.call('GET', '/api/latest', cookie=cookie)[1])['count'], 2)

    def test_service_worker_is_public(self):
        status, out = self.call('GET', '/sw.js')
        self.assertEqual((status, self.headers['Content-Type']), (200, 'text/javascript'))
        self.assertIn(b'expense-data', out)
        manifest = json.loads(self.call('GET', '/manifest.webmanifest')[1])
        self.assertEqual(manifest['display'], 'standalone')
        self.assertIn('maskable', {i['purpose'] for i in manifest['icons']})


if __name__ == '__main__':
    unittest.main()
