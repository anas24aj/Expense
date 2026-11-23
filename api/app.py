"""WSGI entry for v3: JSON API under /api, MCP at /mcp, and the built React app (web/dist) for everything else.

Modules register routes with @route. Handler: fn(req) -> body | (status, body). Raise ApiError for 4xx.
Auth levels: 'public' | 'user' (signed in) | 'member' (signed in + current household) | 'admin' (household owner/admin)
| 'device' (phone: Authorization: Bearer <device key>)."""
import importlib
import json
import mimetypes
import re
import sys
import traceback
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs

from api.db import DB, Scoped

DIST = Path(__file__).parent.parent / 'web' / 'dist'
MAX_BODY = 6 * 1024 * 1024  # statements arrive base64; Vercel caps requests at 4.5 MB anyway
MODULES = ['api.auth', 'api.households', 'api.ledger', 'api.ingest', 'api.plan', 'api.insights', 'api.flows', 'api.salary', 'api.logo']
_routes = []
_loaded = []


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


def route(method, pattern, auth='member'):
    rx = re.compile('^' + re.sub(r'\{(\w+)\}', r'(?P<\1>[^/]+)', pattern) + '$')

    def add(fn):
        _routes.append((method, rx, auth, fn))
        return fn
    return add


class Request:
    def __init__(self, environ, db):
        self.environ, self.db = environ, db
        self.method = environ['REQUEST_METHOD']
        self.path = environ.get('PATH_INFO') or '/'
        self.query = {k: v[0] for k, v in parse_qs(environ.get('QUERY_STRING', '')).items()}
        self.cookies = {k: m.value for k, m in SimpleCookie(environ.get('HTTP_COOKIE', '')).items()}
        self.params = {}
        self.headers_out = []  # extra response headers (Set-Cookie…)
        self.user = self.member = self.device = None
        self.hh = None  # Scoped for the current household
        self._json = None

    @property
    def json(self):
        if self._json is None:
            try:
                length = int(self.environ.get('CONTENT_LENGTH') or 0)
            except ValueError:
                length = 0
            if length > MAX_BODY:
                raise ApiError(413, 'request too large')
            raw = self.environ['wsgi.input'].read(length) if length else b''
            try:
                self._json = json.loads(raw or b'{}')
            except ValueError:
                raise ApiError(400, 'body must be JSON')
            if not isinstance(self._json, dict):
                raise ApiError(400, 'body must be a JSON object')
        return self._json

    def header(self, name):
        return self.environ.get('HTTP_' + name.upper().replace('-', '_'), '')

    def set_cookie(self, name, value, max_age):
        self.headers_out.append(('Set-Cookie', f'{name}={value}; Max-Age={max_age}; Path=/; HttpOnly; Secure; SameSite=Lax'))


def _load():
    if not _loaded:
        for m in MODULES:
            try:
                importlib.import_module(m)
            except ModuleNotFoundError as e:
                if e.name != m:  # a module that exists but fails to import is a real bug
                    raise
        _loaded.append(True)


def _authorize(req, level):
    from api import auth  # owned by api/auth.py: current_user, current_household, device_from_bearer
    if level == 'public':
        return
    if level == 'device':
        req.device = auth.device_from_bearer(req)
        if not req.device:
            raise ApiError(401, 'unknown or revoked device key')
        req.hh = Scoped(req.db, req.device['household_id'])
        return
    req.user = auth.current_user(req)
    if not req.user:
        raise ApiError(401, 'sign in first')
    if level == 'user':
        return
    hid, req.member = auth.current_household(req, req.user)
    if not hid:
        raise ApiError(409, 'no household yet')
    req.hh = Scoped(req.db, hid)
    if level == 'admin' and req.member['role'] not in ('owner', 'admin'):
        raise ApiError(403, 'only the household owner or an admin can do this')


def _static(path):
    f = (DIST / path.lstrip('/')).resolve()
    if DIST.exists() and f.is_file() and DIST.resolve() in f.parents:
        return f
    return DIST / 'index.html' if not path.startswith(('/api/', '/mcp')) else None


def app(environ, start_response):
    def send(status, body, ctype='application/json', headers=()):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
        start_response(f'{status} {_REASON.get(status, "OK")}', [('Content-Type', ctype), ('Content-Length', str(len(data))),
                                                                ('X-Content-Type-Options', 'nosniff'), *headers])
        return [data]

    method, path = environ['REQUEST_METHOD'], environ.get('PATH_INFO') or '/'
    if path == '/mcp' or path.startswith('/mcp/'):
        _load()
        from api import mcp
        return mcp.app(environ, start_response)
    if not path.startswith('/api/'):
        f = _static(path)
        if not f or not f.exists():
            return send(404, {'error': 'not found (is web/dist built?)'})
        ctype = mimetypes.guess_type(str(f))[0] or 'application/octet-stream'
        cache = 'public, max-age=31536000, immutable' if '/assets/' in path else 'no-cache'
        return send(200, f.read_bytes(), ctype, [('Cache-Control', cache)])

    _load()
    db = DB()
    try:
        req = Request(environ, db)
        allowed = False
        for m, rx, level, fn in sorted(_routes, key=lambda r: r[1].groups):  # literal paths win over /{id}
            hit = rx.match(path)
            if not hit:
                continue
            allowed = True
            if m != method:
                continue
            req.params = hit.groupdict()
            try:
                _authorize(req, level)
                out = fn(req)
                status, body, *ctype = out if isinstance(out, tuple) else (200, out)  # (status, bytes, content type) for files
                return send(status, body, *ctype, headers=req.headers_out)
            except ApiError as e:
                return send(e.status, {'error': e.message}, headers=req.headers_out)
        return send(405 if allowed else 404, {'error': 'method not allowed' if allowed else 'not found'})
    except Exception as e:  # never leak internals to the client; log them for Vercel
        traceback.print_exc(file=sys.stderr)
        return send(500, {'error': 'something went wrong on our side', 'kind': type(e).__name__})
    finally:
        db.close()


_REASON = {200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
           404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity',
           429: 'Too Many Requests', 500: 'Internal Server Error'}
