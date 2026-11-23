"""GET /api/logo/{domain}: allowlisted brands only, fetched server-side (urlopen mocked: no network)."""
import io
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from tests.test_v3_core import fresh_db  # noqa: E402  (sets up a temp database before api imports)
from api.app import app  # noqa: E402
from api import app as appmod, logo  # noqa: E402


def get(path):
    got = {}
    body = b''.join(app({'REQUEST_METHOD': 'GET', 'PATH_INFO': path, 'QUERY_STRING': '', 'wsgi.input': io.BytesIO(b''), 'CONTENT_LENGTH': '0',
                         'REMOTE_ADDR': '10.0.0.1', 'HTTP_HOST': 'test.local'}, lambda s, h: got.update(status=int(s.split()[0]), headers=dict(h))))
    return got['status'], got['headers'], body


class FakeResp(io.BytesIO):
    status = 200
    headers = {'Content-Type': 'image/png'}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class LogoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fresh_db(cls.__name__)
        appmod._load()

    def setUp(self):
        logo._cache.clear()

    def test_unknown_domain_is_404_without_fetching(self):
        with mock.patch.object(logo, 'urlopen') as u:
            for d in ('evil.example', 'netflix.com.evil.example', '..', 'localhost'):
                self.assertEqual(get(f'/api/logo/{d}')[0], 404, d)
            u.assert_not_called()

    def test_known_domain_is_fetched_once_and_cached(self):
        with mock.patch.object(logo, 'urlopen', return_value=FakeResp(b'\x89PNG...')) as u:
            status, headers, body = get('/api/logo/alrajhibank.com.sa')
            self.assertEqual((status, headers['Content-Type'], body), (200, 'image/png', b'\x89PNG...'))
            self.assertEqual(headers['Cache-Control'], 'public, max-age=2592000, immutable')
            get('/api/logo/alrajhibank.com.sa')
            self.assertEqual(u.call_count, 1)
            self.assertEqual(u.call_args.kwargs['timeout'], 4)

    def test_fetch_failure_is_404(self):
        with mock.patch.object(logo, 'urlopen', side_effect=OSError('offline')):
            self.assertEqual(get('/api/logo/hdfcbank.com')[0], 404)

    def test_allowlist_matches_the_app(self):
        src = (ROOT / 'web/src/ui/Icon.tsx').read_text()
        block = src[src.index('const DOMAINS'):src.index('export function logoOf')]
        self.assertEqual(set(re.findall(r"'([a-z0-9.-]+)'\]", block)), set(logo.DOMAINS))


if __name__ == '__main__':
    unittest.main()
