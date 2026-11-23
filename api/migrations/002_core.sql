-- Personal MCP connector keys: one per user and household; only the sha256 of the key is kept.
CREATE TABLE IF NOT EXISTS mcp_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, household_id TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_used TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS transactions_account ON transactions (household_id, account_id, day);
CREATE INDEX IF NOT EXISTS raw_messages_created ON raw_messages (household_id, created_at);
