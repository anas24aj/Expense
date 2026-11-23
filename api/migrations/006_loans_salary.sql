-- Construction loans: a milestone paid by the bank is a tranche of a liability (disbursed_on); the loan owes what was
-- disbursed and charges pre-EMI interest on it until full EMIs start (liabilities.emi_from).
ALTER TABLE asset_milestones ADD COLUMN liability_id TEXT;
ALTER TABLE asset_milestones ADD COLUMN disbursed_on TEXT;
ALTER TABLE liabilities ADD COLUMN emi_from TEXT NOT NULL DEFAULT '';
-- Salary over time: base pay from a month on (latest wins), arrears and bonuses paid once in from_month.
CREATE TABLE IF NOT EXISTS salary_history (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, member_id TEXT, from_month TEXT NOT NULL, amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'base',  -- base|arrears|bonus
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS salary_history_hh ON salary_history (household_id, from_month);
