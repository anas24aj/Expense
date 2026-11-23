"""Input checks for the trust boundary (request bodies and queries) and response shapes shared by the core modules."""
import re
from datetime import date, datetime, timezone

import engine
from api.app import ApiError

CURRENCY = re.compile(r'[A-Z]{3}\Z')
ID = re.compile(r'[0-9a-f]{32}\Z')


def text(v, field, n=60, required=True):
    if v is None or v == '':
        if required:
            raise ApiError(400, f'{field} is required')
        return ''
    if not isinstance(v, str):
        raise ApiError(400, f'{field} must be text')
    v = ' '.join(v.split())
    if required and not v:
        raise ApiError(400, f'{field} is required')
    if len(v) > n:
        raise ApiError(400, f'{field} is too long (at most {n} characters)')
    return v


def choice(v, allowed, field, default=None):
    if v is None and default is not None:
        return default
    if v not in allowed:
        raise ApiError(400, f'{field} must be one of: {", ".join(sorted(allowed))}')
    return v


def currency(v, field='currency'):
    v = v.upper() if isinstance(v, str) else v
    if not isinstance(v, str) or not CURRENCY.match(v):
        raise ApiError(400, f'{field} must be a 3-letter currency code')
    if v not in engine.SUPPORTED:  # totals could not convert it
        raise ApiError(400, f"{field} must be one of: {', '.join(sorted(engine.SUPPORTED))}")
    return v


def minor(v, field, positive=False):
    if isinstance(v, bool) or not isinstance(v, int):
        raise ApiError(400, f'{field} must be a whole number of minor units')
    if abs(v) > 10 ** 15 or (positive and v <= 0):
        raise ApiError(400, f'{field} must be ' + ('more than 0' if positive else 'in range'))
    return v


def integer(v, field, lo, hi):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ApiError(400, f'{field} must be a whole number from {lo} to {hi}')
    return v


def day(v, field='day', required=True):
    if not v and not required:
        return ''
    try:
        if isinstance(v, str) and len(v) == 10:
            return date.fromisoformat(v).isoformat()
    except ValueError:
        pass
    raise ApiError(400, f'{field} must be a date YYYY-MM-DD')


def month(v):
    if not isinstance(v, str) or not re.match(r'\d{4}-(0[1-9]|1[0-2])\Z', v):
        raise ApiError(400, 'month must be YYYY-MM')
    return v


def when(v, field='received_at'):
    """An ISO-8601 time as an aware UTC datetime (no zone given: UTC)."""
    try:
        t = datetime.fromisoformat(v.replace('Z', '+00:00'))
    except (AttributeError, ValueError):
        raise ApiError(400, f'{field} must be an ISO-8601 time')
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def ident(v, field):
    if not isinstance(v, str) or not ID.match(v):
        raise ApiError(404, f'{field} not found')
    return v


def money(m, cur):
    return None if m is None else {'minor': int(m), 'currency': cur}


def inlist(prefix, values):
    """('(:p0, :p1)', {'p0': .., 'p1': ..}) for an IN clause that works on SQLite and Postgres alike."""
    params = {f'{prefix}{i}': v for i, v in enumerate(values)}
    return '(' + (', '.join(':' + k for k in params) or 'NULL') + ')', params
