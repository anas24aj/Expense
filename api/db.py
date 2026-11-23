"""Database access for schema v3. Postgres when DATABASE_URL is set (Neon), else SQLite (tests, local).
One schema for everyone; every domain query is scoped by household_id (see Scoped)."""
import os
import re
import sqlite3
import ssl
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

MIGRATIONS = Path(__file__).parent / 'migrations'
_ready = set()   # database urls migrated in this process
_idle = {}       # url -> pooled pg connections
POOL = 3


def new_id():
    return uuid.uuid4().hex


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _url():
    url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get('DATABASE_URL', '')
    return url.replace('-pooler.', '.', 1)  # pooled Neon hosts break pg8000's prepared statements


SCHEMA = 'v3'


class DB:
    def __init__(self, url=None):
        self.url = _url() if url is None else url
        self.pg = self.url.startswith(('postgres://', 'postgresql://'))
        if self.pg:
            try:
                self.conn, self.reused = _idle.setdefault(self.url, []).pop(), True
            except IndexError:
                self.conn, self.reused = self._connect(), False
        else:
            path = self.url or os.environ.get('EXPENSE_DB_V3', str(Path(__file__).parent.parent / 'expense3.db'))
            self.conn = sqlite3.connect(path, isolation_level=None)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute('PRAGMA foreign_keys = OFF')
            self.url = path
        if self.url not in _ready:
            self.migrate()
            _ready.add(self.url)

    def _connect(self):
        import pg8000.native
        u = urlparse(self.url)
        tls = parse_qs(u.query).get('sslmode', ['require'])[0] != 'disable'
        conn = pg8000.native.Connection(unquote(u.username or ''), host=u.hostname, port=u.port or 5432, database=u.path.lstrip('/'),
                                        password=unquote(u.password or ''), ssl_context=ssl.create_default_context() if tls else None)
        # v3 lives in its own schema: the old app's tables (transactions, accounts, ...) sit in public with the same names.
        # public stays on the path only so old accounts (app_users) can move over on first sign-in.
        try:
            conn.run(f'CREATE SCHEMA IF NOT EXISTS {SCHEMA}')
        except Exception:  # two cold starts racing: the other one created it
            pass
        conn.run(f'SET search_path TO {SCHEMA}, public')
        return conn

    def run(self, sql, **params):
        """Run one statement with :name params; returns a list of dicts."""
        if self.pg:
            from pg8000.exceptions import InterfaceError
            try:
                rows = self.conn.run(sql, **params) or []
            except (InterfaceError, OSError):
                if not self.reused:
                    raise
                self.conn, self.reused = self._connect(), False  # a kept connection went stale (Neon sleeps): once more
                rows = self.conn.run(sql, **params) or []
            names = [c['name'] for c in self.conn.columns or []]
            return [dict(zip(names, r)) for r in rows]
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def one(self, sql, **params):
        rows = self.run(sql, **params)
        return rows[0] if rows else None

    @contextmanager
    def tx(self):
        """A transaction: all or nothing."""
        self.run('BEGIN')
        try:
            yield self
        except BaseException:
            self.run('ROLLBACK')
            raise
        self.run('COMMIT')

    @contextmanager
    def lock(self, name):
        """Serialize work across requests (Postgres advisory lock; SQLite is single-writer already)."""
        if not self.pg:
            yield
            return
        self.run('SELECT pg_advisory_lock(hashtext(:n))', n=name)
        try:
            yield
        finally:
            self.run('SELECT pg_advisory_unlock(hashtext(:n))', n=name)

    def migrate(self):
        with self.lock('migrations'):
            self.run('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
            done = {r['name'] for r in self.run('SELECT name FROM schema_migrations')}
            for f in sorted(MIGRATIONS.glob('*.sql')):
                if f.name in done:
                    continue
                for stmt in [s.strip() for s in re.sub(r'--[^\n]*', '', f.read_text()).split(';') if s.strip()]:
                    self.run(stmt)
                self.run('INSERT INTO schema_migrations (name, applied_at) VALUES (:n, :t)', n=f.name, t=now())

    def close(self):
        if self.pg and len(_idle.setdefault(self.url, [])) < POOL:
            _idle[self.url].append(self.conn)
        else:
            self.conn.close()


class Scoped:
    """The only way request code touches household data: every helper adds household_id itself."""

    def __init__(self, db, household_id):
        self.db, self.hid = db, household_id

    def run(self, sql, **params):
        assert ':hid' in sql, 'household-scoped SQL must filter on :hid'
        return self.db.run(sql, hid=self.hid, **params)

    def one(self, sql, **params):
        rows = self.run(sql, **params)
        return rows[0] if rows else None

    def insert(self, table, **cols):
        cols.setdefault('id', new_id())
        cols['household_id'] = self.hid
        names = list(cols)
        self.db.run(f'INSERT INTO {table} ({", ".join(names)}) VALUES ({", ".join(":" + n for n in names)})', **cols)
        return cols

    def update(self, table, id, **cols):
        if not cols:
            return
        sets = ', '.join(f'{k} = :{k}' for k in cols)
        self.db.run(f'UPDATE {table} SET {sets} WHERE id = :_id AND household_id = :_hid', _id=id, _hid=self.hid, **cols)

    def get(self, table, id):
        return self.db.one(f'SELECT * FROM {table} WHERE id = :id AND household_id = :hid', id=id, hid=self.hid)
