-- A fund fed by rent from a tenant (a contact) and shared with co-owners: a pot. Credits and spends tagged to it
-- (txn_meta.fund_id) fill and draw it down; rent credits whose text has match_pattern are tagged by the classifier.
ALTER TABLE funds ADD COLUMN tenant_contact_id TEXT;
ALTER TABLE funds ADD COLUMN rent_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE funds ADD COLUMN rent_from TEXT NOT NULL DEFAULT '';
ALTER TABLE funds ADD COLUMN match_pattern TEXT NOT NULL DEFAULT '';
-- Co-owners other than the household: share_pct of the pot is theirs (the household's part is the rest).
CREATE TABLE IF NOT EXISTS fund_shares (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL, fund_id TEXT NOT NULL, member_id TEXT, contact_id TEXT, share_pct INTEGER NOT NULL);
-- A month of rent the tenant was let off.
CREATE TABLE IF NOT EXISTS fund_waivers (
  household_id TEXT NOT NULL, fund_id TEXT NOT NULL, month TEXT NOT NULL, PRIMARY KEY (household_id, fund_id, month));
