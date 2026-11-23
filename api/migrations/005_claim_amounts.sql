-- A claim can cover part of a transaction (the company pays SAR 380 of a SAR 412 bill). NULL = the whole transaction.
ALTER TABLE claim_items ADD COLUMN claimed_minor BIGINT;
ALTER TABLE claim_items ADD COLUMN claimed_currency TEXT;
