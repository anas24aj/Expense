-- Trips and imported claim lines. Portable between Postgres and SQLite.
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  start_on TEXT NOT NULL, end_on TEXT NOT NULL, currency TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);

ALTER TABLE claims ADD COLUMN trip_id TEXT NOT NULL DEFAULT '';

-- One row per item of a company claim (a receipt). Amounts in minor units; qar/sar are the claimed amounts, 0 when absent.
CREATE TABLE IF NOT EXISTS claim_lines (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, claim_id TEXT NOT NULL, day TEXT NOT NULL, vendor TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '', receipt_minor BIGINT NOT NULL DEFAULT 0, receipt_currency TEXT NOT NULL DEFAULT 'QAR',
  qar_minor BIGINT NOT NULL DEFAULT 0, sar_minor BIGINT NOT NULL DEFAULT 0, bill_ref TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS claim_lines_claim ON claim_lines (household_id, claim_id);

-- The owner's verdict on a trip expense nobody claimed: personal | missed_claim.
CREATE TABLE IF NOT EXISTS trip_tags (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, trip_id TEXT NOT NULL, txn_id TEXT NOT NULL, status TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS trip_tags_txn ON trip_tags (trip_id, txn_id);
