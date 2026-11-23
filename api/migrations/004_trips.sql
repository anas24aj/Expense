-- Trips: a date window and a place; the transactions in it belong to the trip (computed), trip_txns holds explicit tags.
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, name TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  start_on TEXT NOT NULL, end_on TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'business',  -- business|personal
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trip_txns (
  trip_id TEXT NOT NULL, household_id TEXT NOT NULL, txn_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unreviewed',  -- personal|missed|claimed|unreviewed
  set_by TEXT NOT NULL DEFAULT 'user', PRIMARY KEY (trip_id, txn_id));
