"""MCP server for v3: JSON-RPC 2.0 over POST at /mcp/<personal key> or /mcp with `Authorization: Bearer <key>`.
Each tool calls the same route handler the web app uses (so numbers never differ), as the key's user and household."""
import io
import json
import sys
import traceback
from urllib.parse import unquote, urlencode

from api import app as router
from api.app import ApiError, Request
from api.db import DB, Scoped

VERSIONS = ('2025-06-18', '2025-03-26', '2024-11-05')
MAX_BODY = 256 * 1024
_S = lambda props, req=(): {'type': 'object', 'properties': props, 'required': list(req), 'additionalProperties': False}
_STR, _INT = {'type': 'string'}, {'type': 'integer'}
PURPOSES = ['spend', 'fee', 'transfer', 'income', 'support', 'lend', 'repaid', 'borrow', 'repay', 'loan_payment', 'claim',
            'reimbursement', 'asset', 'saving', 'refund', 'ignore']

# name: (description, input schema, method, path, read-only). Arguments become the query (GET) or the body.
TOOLS = {
    'get_home': ('This month at a glance: income, spent, committed, free money, next dues, 6-month look-ahead, alerts. Amounts in the household base currency.',
                 _S({}), 'GET', '/api/insights/home', True),
    'get_month': ('One month: income, spending by category and purpose, commitments due and paid, fund set-asides, free money, what is owed both ways, interest.',
                  _S({'month': {'type': 'string', 'description': 'YYYY-MM, default this month'}}), 'GET', '/api/insights/month', True),
    'get_lookahead': ('The next months: expected salary, commitments, fund set-asides, everyday spending, free money and warnings; debt-free month; interest per month.',
                      _S({'months': {'type': 'integer', 'minimum': 1, 'maximum': 36}}), 'GET', '/api/insights/lookahead', True),
    'what_if': ('What happens if I spend this now: paid in cash, on a card, or as an EMI over some months. Delay to debt-free, extra interest, a verdict.',
                _S({'amount_minor': _INT, 'currency': _STR, 'pay': {'type': 'string', 'enum': ['cash', 'card', 'emi']}, 'months': _INT, 'rate_bp': _INT},
                   ['amount_minor']), 'GET', '/api/insights/whatif', True),
    'list_transactions': ('Transactions, newest first, filtered by month (YYYY-MM), account, category, purpose or member.',
                          _S({'month': _STR, 'account_id': _STR, 'category': _STR, 'purpose': _STR, 'member_id': _STR, 'limit': _INT, 'before': _STR}),
                          'GET', '/api/transactions', True),
    'search_transactions': ('Transactions whose merchant, note or text contain the words in q.', _S({'q': _STR, 'limit': _INT}, ['q']),
                            'GET', '/api/transactions', True),
    'get_people': ('Family members and contacts: who owes whom, monthly family support against plan.', _S({}), 'GET', '/api/people', True),
    'get_commitments': ('Rent, bills, subscriptions, EMIs, insurance, school fees and support: amount, cycle, next due, paid/due/overdue, sharers and whether they paid.',
                        _S({}), 'GET', '/api/commitments', True),
    'get_liabilities': ('Loans, cards, pay-later and money borrowed: outstanding, EMI, rate, interest this month, payoff month, paid %.',
                        _S({}), 'GET', '/api/liabilities', True),
    'get_claims': ('Company reimbursement claims: items, expected, received, status, age, and the total pending.', _S({}), 'GET', '/api/claims', True),
    'get_assets': ('Property, vehicles and investments: cost, paid, financed, still to pay, next milestone, monthly running cost and my share.',
                   _S({}), 'GET', '/api/assets', True),
    'get_advice': ('Rules-based steps for this month’s free money: emergency fund, costly debt first, funds, cheap debt vs an NRE FD, investing. Not financial advice.',
                   _S({}), 'GET', '/api/insights/advice', True),
    'add_transaction': ('Record a transaction by hand. Only when the user asks.',
                        _S({'day': _STR, 'amount_minor': _INT, 'currency': _STR, 'direction': {'type': 'string', 'enum': ['debit', 'credit']},
                            'merchant': _STR, 'account_id': _STR, 'category': _STR, 'purpose': {'type': 'string', 'enum': PURPOSES}, 'note': _STR},
                           ['day', 'amount_minor', 'currency', 'direction', 'merchant']), 'POST', '/api/transactions', False),
    'set_purpose': ('Say what a transaction was for, optionally for every transaction from that merchant. Only when the user asks.',
                    _S({'txn_id': _STR, 'purpose': {'type': 'string', 'enum': PURPOSES}, 'category': _STR, 'apply_to_merchant': {'type': 'boolean'}},
                       ['txn_id', 'purpose']), 'PATCH', '/api/transactions/{txn_id}', False),
}


def call_route(db, who, method, path, args):
    """Run an API route in-process as this user: GET args become the query, others the JSON body."""
    router._load()
    path = path.format(**{k: v for k, v in args.items() if isinstance(v, str)})
    args = {k: v for k, v in args.items() if f'{{{k}}}' not in path}
    body = json.dumps(args).encode() if method != 'GET' else b''
    environ = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': urlencode(args) if method == 'GET' else '',
               'CONTENT_LENGTH': str(len(body)), 'wsgi.input': io.BytesIO(body)}
    for m, rx, level, fn in router._routes:
        hit = rx.match(path)
        if hit and m == method:
            if level == 'admin' and who['member']['role'] not in ('owner', 'admin'):
                raise ApiError(403, 'only the household owner or an admin can do this')
            if method != 'GET' and who['member']['role'] == 'viewer':
                raise ApiError(403, 'viewers can look but not change anything')
            req = Request(environ, db)
            req.params, req.user, req.member, req.hh = hit.groupdict(), who['user'], who['member'], Scoped(db, who['household_id'])
            out = fn(req)
            return out[1] if isinstance(out, tuple) else out
    raise ApiError(404, f'{path} is not available on this server yet')


def reply(db, who, msg):
    """One JSON-RPC message in, its response out (None for a notification)."""
    if not isinstance(msg, dict) or msg.get('jsonrpc') != '2.0' or 'method' not in msg:
        return {'jsonrpc': '2.0', 'id': msg.get('id') if isinstance(msg, dict) else None, 'error': {'code': -32600, 'message': 'invalid request'}}
    if 'id' not in msg:
        return None  # notifications/initialized and the like
    ok = lambda result: {'jsonrpc': '2.0', 'id': msg['id'], 'result': result}
    method, params = msg['method'], msg.get('params') or {}
    if method == 'initialize':
        asked = params.get('protocolVersion')
        return ok({'protocolVersion': asked if asked in VERSIONS else VERSIONS[0], 'capabilities': {'tools': {'listChanged': False}},
                   'serverInfo': {'name': 'expense', 'title': 'Family money', 'version': '3'},
                   'instructions': 'A family’s money across Saudi Arabia (SAR) and India (INR): spending, commitments, debts, claims, assets and a '
                                   'look-ahead. Money is {minor, currency}: divide minor by 100. Use add_transaction and set_purpose only when the user asks.'})
    if method == 'ping':
        return ok({})
    if method == 'tools/list':
        return ok({'tools': [{'name': n, 'description': d, 'inputSchema': schema, 'annotations': {'readOnlyHint': ro, 'destructiveHint': False}}
                             for n, (d, schema, _, _, ro) in TOOLS.items()]})
    if method == 'tools/call':
        tool = TOOLS.get(params.get('name'))
        args = params.get('arguments') or {}
        if not tool or not isinstance(args, dict):
            return {'jsonrpc': '2.0', 'id': msg['id'], 'error': {'code': -32602, 'message': f"unknown tool: {params.get('name')}"}}
        try:
            data = call_route(db, who, tool[2], tool[3], args)
            return ok({'content': [{'type': 'text', 'text': json.dumps(data, ensure_ascii=False, default=str)}], 'structuredContent': data, 'isError': False})
        except ApiError as e:
            return ok({'content': [{'type': 'text', 'text': f'Could not do that: {e.message}'}], 'isError': True})
    return {'jsonrpc': '2.0', 'id': msg['id'], 'error': {'code': -32601, 'message': f'unknown method: {method}'}}


def app(environ, start_response):
    def send(status, body):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
        start_response(status, [('Content-Type', 'application/json'), ('Content-Length', str(len(data))), ('Cache-Control', 'no-store')])
        return [data]

    if environ['REQUEST_METHOD'] != 'POST':  # no server-to-client stream: every answer comes back in the POST
        return send('405 Method Not Allowed', {'error': 'POST JSON-RPC messages here'})
    path, header = environ.get('PATH_INFO') or '', environ.get('HTTP_AUTHORIZATION', '')
    key = unquote(path[len('/mcp/'):]) if path.startswith('/mcp/') else header[7:] if header.startswith('Bearer ') else ''
    db, who = DB(), None
    try:
        from api import auth
        who = auth.mcp_user(key, db) if key else None  # {user, household_id, member}
        if not who:
            return send('401 Unauthorized', {'error': 'use your connector link from Settings (it has your key in it)'})
        try:
            length = int(environ.get('CONTENT_LENGTH') or 0)
            if not 0 < length <= MAX_BODY:
                raise ValueError
            incoming = json.loads(environ['wsgi.input'].read(length))
        except ValueError:
            return send('400 Bad Request', {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'parse error'}})
        replies = [r for r in (reply(db, who, m) for m in (incoming if isinstance(incoming, list) else [incoming])) if r is not None]
        if not replies:
            return send('202 Accepted', b'')
        return send('200 OK', replies if isinstance(incoming, list) else replies[0])
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        router.log_error(db, 'POST /mcp', e, Scoped(db, who['household_id']) if who else None)
        return send('500 Internal Server Error', {'error': 'something went wrong on our side', 'kind': type(e).__name__})
    finally:
        db.close()
