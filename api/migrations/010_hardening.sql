-- Reclassify looks up a transaction's meaning and its transfer links per row: index both sides.
-- (transactions (household_id, day) already exists as transactions_day in 001.)
CREATE INDEX IF NOT EXISTS txn_meta_hh ON txn_meta (household_id, txn_id, set_by);
CREATE INDEX IF NOT EXISTS txn_links_to ON txn_links (household_id, to_txn);
-- A deleted row frees its dedupe key, so importing the same statement again brings the rows back.
UPDATE transactions SET dedupe_key = dedupe_key || '.del.' || id WHERE deleted_at IS NOT NULL AND dedupe_key NOT LIKE '%.del.%';
-- Unhandled exceptions, for the household admin (no request bodies, no secrets).
CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY, household_id TEXT, at TEXT NOT NULL, route TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, trace TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS errors_hh ON errors (household_id, at);
