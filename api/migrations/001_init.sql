-- Schema v3: household-first. Portable between Postgres (Neon) and SQLite (tests/local).
-- Ids: TEXT uuid4 hex made in Python. Times: TEXT ISO-8601 UTC. Days: TEXT YYYY-MM-DD. Money: BIGINT minor units + currency.
-- Booleans: INTEGER 0/1. Every domain row carries household_id; api/db.py scopes every query by it.

CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, username TEXT UNIQUE, name TEXT NOT NULL DEFAULT '',
  pw_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_currency TEXT NOT NULL DEFAULT 'SAR', home_currency TEXT NOT NULL DEFAULT 'INR',
  timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh', created_at TEXT NOT NULL);

-- A person in the household. user_id NULL: a family member without a login (e.g. mother).
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, user_id TEXT, display_name TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'self',  -- self|spouse|parent|child|sibling|other
  role TEXT NOT NULL DEFAULT 'member',    -- owner|admin|member|viewer
  created_at TEXT NOT NULL, removed_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS members_user ON members (household_id, user_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, member_id TEXT,
  token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, household_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL,
  platform TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen TEXT NOT NULL DEFAULT '', revoked_at TEXT);

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT);

CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at INTEGER NOT NULL);

-- Contacts: friends/colleagues outside the household (can be linked to another app user).
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  linked_user_id TEXT, created_at TEXT NOT NULL, removed_at TEXT);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, owner_member_id TEXT,
  kind TEXT NOT NULL,  -- bank|wallet|credit_card|debit_card|bnpl|loan|cash|investment
  institution TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, currency TEXT NOT NULL, country TEXT NOT NULL DEFAULT '',
  last4 TEXT NOT NULL DEFAULT '', parent_account_id TEXT,  -- a debit card's bank account
  credit_limit_minor BIGINT NOT NULL DEFAULT 0, statement_day INTEGER NOT NULL DEFAULT 0, due_day INTEGER NOT NULL DEFAULT 0,
  rate_bp INTEGER NOT NULL DEFAULT 0, opening_balance_minor BIGINT NOT NULL DEFAULT 0, opening_as_of TEXT NOT NULL DEFAULT '',
  last_balance_minor BIGINT, last_balance_at TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'household',  -- household|private (private: only owner_member sees it)
  created_at TEXT NOT NULL, archived_at TEXT);

CREATE TABLE IF NOT EXISTS raw_messages (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, device_id TEXT, member_id TEXT, sender TEXT NOT NULL, body TEXT NOT NULL,
  received_at TEXT NOT NULL, hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS raw_messages_hash ON raw_messages (household_id, hash);

CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, account_id TEXT NOT NULL, file_name TEXT NOT NULL,
  period_from TEXT NOT NULL DEFAULT '', period_to TEXT NOT NULL DEFAULT '', rows INTEGER NOT NULL DEFAULT 0, imported_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, household_id TEXT,  -- NULL: global seed
  parent_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'spend', icon TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, account_id TEXT, member_id TEXT,
  occurred_at TEXT NOT NULL, day TEXT NOT NULL, amount_minor BIGINT NOT NULL, currency TEXT NOT NULL,
  direction TEXT NOT NULL,  -- debit|credit
  merchant_raw TEXT NOT NULL DEFAULT '', merchant TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,  -- sms|statement|manual|peer
  raw_message_id TEXT, statement_id TEXT, dedupe_key TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_dedupe ON transactions (household_id, dedupe_key);
CREATE INDEX IF NOT EXISTS transactions_day ON transactions (household_id, day);

-- Meaning of a transaction (see docs/brain/domain-model.md). One row per transaction once classified.
CREATE TABLE IF NOT EXISTS txn_meta (
  txn_id TEXT PRIMARY KEY, household_id TEXT NOT NULL,
  purpose TEXT NOT NULL,  -- spend|fee|transfer|income|support|lend|repaid|borrow|repay|loan_payment|claim|reimbursement|asset|saving|refund|ignore
  confidence REAL NOT NULL DEFAULT 0, set_by TEXT NOT NULL DEFAULT 'rule',  -- rule|user
  person_member_id TEXT, person_contact_id TEXT, liability_id TEXT, asset_id TEXT, commitment_id TEXT, claim_id TEXT, fund_id TEXT,
  updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS txn_links (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, kind TEXT NOT NULL,  -- transfer|claim|repayment|refund
  from_txn TEXT NOT NULL, to_txn TEXT NOT NULL, fx_rate REAL, set_by TEXT NOT NULL DEFAULT 'rule', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS txn_links_pair ON txn_links (household_id, from_txn, to_txn);

CREATE TABLE IF NOT EXISTS splits (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, txn_id TEXT NOT NULL, member_id TEXT, contact_id TEXT,
  share_minor BIGINT NOT NULL, settled_at TEXT, settled_txn_id TEXT);

CREATE TABLE IF NOT EXISTS merchant_rules (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, pattern TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '',
  person_member_id TEXT, person_contact_id TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_rules_pattern ON merchant_rules (household_id, pattern);

CREATE TABLE IF NOT EXISTS fx_rates (day TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL, rate REAL NOT NULL, PRIMARY KEY (day, base, quote));

CREATE TABLE IF NOT EXISTS liabilities (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, account_id TEXT, member_id TEXT, contact_id TEXT,
  kind TEXT NOT NULL,  -- loan|credit_card|bnpl|person|other
  name TEXT NOT NULL, lender TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL,
  principal_minor BIGINT NOT NULL DEFAULT 0, opening_balance_minor BIGINT NOT NULL DEFAULT 0, as_of TEXT NOT NULL,
  rate_bp INTEGER NOT NULL DEFAULT 0, emi_minor BIGINT NOT NULL DEFAULT 0, due_day INTEGER NOT NULL DEFAULT 0,
  start_on TEXT NOT NULL DEFAULT '', end_on TEXT NOT NULL DEFAULT '', match_pattern TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, closed_at TEXT);

-- Anything recurring or scheduled: rent, bills, subscriptions, EMI, insurance, school, family support, milestones.
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL,  -- rent|bill|subscription|emi|insurance|school|support|milestone|other
  amount_minor BIGINT NOT NULL, currency TEXT NOT NULL, cycle_months INTEGER NOT NULL DEFAULT 1,  -- 0 = one-off
  next_due TEXT NOT NULL, end_on TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', match_pattern TEXT NOT NULL DEFAULT '',
  account_id TEXT, liability_id TEXT, asset_id TEXT, for_member_id TEXT, paid_by_member_id TEXT,
  created_at TEXT NOT NULL, ended_at TEXT);

CREATE TABLE IF NOT EXISTS commitment_shares (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, commitment_id TEXT NOT NULL, member_id TEXT, contact_id TEXT, share_minor BIGINT NOT NULL);

CREATE TABLE IF NOT EXISTS commitment_payments (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, commitment_id TEXT NOT NULL, cycle_due TEXT NOT NULL,
  txn_id TEXT, payer_member_id TEXT, payer_contact_id TEXT, amount_minor BIGINT NOT NULL, paid_on TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS funds (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, target_minor BIGINT NOT NULL, currency TEXT NOT NULL,
  due_on TEXT NOT NULL, commitment_id TEXT, created_at TEXT NOT NULL, closed_at TEXT);

CREATE TABLE IF NOT EXISTS fund_moves (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, fund_id TEXT NOT NULL, on_day TEXT NOT NULL, amount_minor BIGINT NOT NULL, txn_id TEXT);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, kind TEXT NOT NULL,  -- property|vehicle|investment|gold|other
  name TEXT NOT NULL, currency TEXT NOT NULL, cost_minor BIGINT NOT NULL DEFAULT 0, value_minor BIGINT NOT NULL DEFAULT 0,
  value_as_of TEXT NOT NULL DEFAULT '', liability_id TEXT, match_pattern TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, sold_at TEXT);

CREATE TABLE IF NOT EXISTS asset_milestones (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, asset_id TEXT NOT NULL, name TEXT NOT NULL, due_on TEXT NOT NULL,
  amount_minor BIGINT NOT NULL, paid_txn_id TEXT, paid_on TEXT);

-- A running cost of an asset (fuel, service…), optionally shared: share_pct of it is someone else's.
CREATE TABLE IF NOT EXISTS asset_costs (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, asset_id TEXT NOT NULL, txn_id TEXT NOT NULL, cost_type TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_sharers (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, asset_id TEXT NOT NULL, cost_type TEXT NOT NULL,  -- '*' = all costs
  member_id TEXT, contact_id TEXT, share_pct INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, member_id TEXT, name TEXT NOT NULL, payer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',  -- draft|submitted|paid|partly|rejected
  submitted_on TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claim_items (claim_id TEXT NOT NULL, household_id TEXT NOT NULL, txn_id TEXT NOT NULL, PRIMARY KEY (claim_id, txn_id));

CREATE TABLE IF NOT EXISTS settings (household_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (household_id, key));

-- Money between two households on the app (a friend's split, a family member in another household).
CREATE TABLE IF NOT EXISTS shared_entries (
  id TEXT PRIMARY KEY, from_household_id TEXT NOT NULL, to_household_id TEXT NOT NULL, from_txn_id TEXT, to_txn_id TEXT,
  amount_minor BIGINT NOT NULL, currency TEXT NOT NULL, what TEXT NOT NULL, day TEXT NOT NULL, settled_at TEXT, created_at TEXT NOT NULL);
