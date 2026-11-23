-- A credit card's last statement as the bank states it: the total due, the minimum due and the date it is due by.
-- NULL = not known yet (the planner then uses the full amount owed).
ALTER TABLE accounts ADD COLUMN statement_due_minor BIGINT;
ALTER TABLE accounts ADD COLUMN min_due_minor BIGINT;
ALTER TABLE accounts ADD COLUMN statement_due_on TEXT;
