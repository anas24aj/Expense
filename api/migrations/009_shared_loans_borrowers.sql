-- A loan held in someone else's name that you share (a roommate's personal loan paying for a shared car): holder is the
-- contact whose name it is in; my_share_pct of its principal, balance and EMI is yours (100 = all yours, the usual case).
ALTER TABLE liabilities ADD COLUMN holder_contact_id TEXT;
ALTER TABLE liabilities ADD COLUMN my_share_pct INTEGER NOT NULL DEFAULT 100;
-- "Someone else used this card" kept as a rule: plain spending on the account between from_day and to_day is theirs
-- (purpose lend for a friend, support for family). Fees, interest and card charges stay yours.
CREATE TABLE IF NOT EXISTS account_borrowers (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, account_id TEXT NOT NULL, member_id TEXT, contact_id TEXT,
  from_day TEXT NOT NULL, to_day TEXT NOT NULL, purpose TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS account_borrowers_acct ON account_borrowers (household_id, account_id);
