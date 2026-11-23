-- A small profile photo (data:image/... URL, about 96px) for family and friends.
ALTER TABLE members ADD COLUMN photo TEXT;
ALTER TABLE contacts ADD COLUMN photo TEXT;
