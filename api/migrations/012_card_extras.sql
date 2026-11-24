-- What a credit card costs and gives, as the bank states it. NULL = not known yet (the card page says "unknown").
ALTER TABLE accounts ADD COLUMN rewards TEXT;
ALTER TABLE accounts ADD COLUMN annual_fee_minor BIGINT;
ALTER TABLE accounts ADD COLUMN forex_markup_bp INTEGER;
ALTER TABLE accounts ADD COLUMN interest_free_days INTEGER;
