"""GET /api/logo/{domain}: a brand's favicon, fetched by the server so the browser never tells a third party which banks
and shops the family uses. Only the brands the app knows (web/src/ui/Icon.tsx DOMAINS) are served; cached per process."""
from urllib.request import Request, urlopen

from api.app import ApiError, route

# keep in step with DOMAINS in web/src/ui/Icon.tsx (tests/test_v3_logo.py checks)
DOMAINS = frozenset('''
netflix.com youtube.com play.google.com google.com apple.com spotify.com amazon.com shahid.mbc.net hotstar.com anghami.com
openai.com anthropic.com microsoft.com stcbank.com.sa stc.com.sa mobily.com.sa sa.zain.com ooredoo.qa jio.com airtel.in
careem.com uber.com jahez.net hungerstation.com talabat.com snoonu.com noon.com zomato.com swiggy.com starbucks.com
mcdonalds.com kfc.com carrefourksa.com luluhypermarket.com panda.com.sa danube.sa tamimimarkets.com ikea.com mi.com
jarir.com tamara.co tabby.ai saudia.com flynas.com airindiaexpress.com qatarairways.com phonepe.com paytm.com
alrajhibank.com.sa urpay.com.sa sab.com hdfcbank.com canarabank.com federalbank.co.in sbicard.com sbi.co.in axisbank.com
tiqmo.com getonecard.app nissan-global.com shriramproperties.com
'''.split())
MAX_BYTES = 256 * 1024
_cache = {}  # domain -> (bytes, content type), or None when the fetch failed (the app then shows the monogram)


def _fetch(domain):
    req = Request(f'https://www.google.com/s2/favicons?domain={domain}&sz=128', headers={'User-Agent': 'ledger-logo/1'})
    try:
        with urlopen(req, timeout=4) as r:
            ctype = r.headers.get('Content-Type', '').split(';')[0].strip()
            data = r.read(MAX_BYTES + 1)
    except Exception:  # network trouble is never the caller's error: no logo, monogram instead
        return None
    if r.status != 200 or not ctype.startswith('image/') or not data or len(data) > MAX_BYTES:
        return None
    return data, ctype


@route('GET', '/api/logo/{domain}', auth='public')
def logo(req):
    domain = req.params['domain'].lower()
    if domain not in DOMAINS:
        raise ApiError(404, 'unknown brand')
    if domain not in _cache:
        _cache[domain] = _fetch(domain)
    hit = _cache[domain]
    if not hit:
        raise ApiError(404, 'no logo')
    req.headers_out.append(('Cache-Control', 'public, max-age=2592000, immutable'))
    return 200, hit[0], hit[1]
