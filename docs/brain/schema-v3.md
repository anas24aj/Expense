# Schema v3: household-first (draft, 2026-11-23)

Replaces schema-per-person (`u_N` Postgres schemas) with one schema where every row belongs to a **household**.
Driven by the owner's feedback: the app is for him *and his family*; people must share accounts, bills and plans.

## Principles
- One Postgres schema. Every domain row has `household_id`; every query is scoped by it (enforced in one data-access
  layer, plus Postgres row-level security as a backstop).
- Money is `amount_minor BIGINT` + `currency CHAR(3)`. Never floats. FX conversions use `fx_rates` for that day.
- Facts are immutable (`transactions`, `raw_messages`); meaning lives in editable tables (`txn_purposes`, splits, links).
- Soft delete (`deleted_at`) for anything a user can remove; hard delete only via "delete my data".
- UUID primary keys (safe to share across households and devices).

## Identity and sharing
```
users(id, email UNIQUE, username UNIQUE, pw_hash, created_at, last_seen)
households(id, name, base_currency, home_currency, created_at)          -- "Anas family"
members(household_id, user_id NULL, display_name, relation, role, ...)  -- role: owner|admin|member|viewer
                                                                           user_id NULL = a family member without login (mother)
invites(id, household_id, email, role, token_hash, expires_at)
devices(id, user_id, household_id, name, platform, key_hash, last_seen, revoked_at)
password_resets(id, user_id, token_hash, expires_at, used_at)
app_secrets(name, value)
```
A user can belong to several households (own + parents'). Each account/commitment has `visibility`
(`household` | `private`) so a member can keep personal cards private.

## Money places
```
accounts(id, household_id, owner_member_id, kind, institution, name, currency, country, last4,
         credit_limit_minor, statement_day, due_day, rate_bp, visibility, archived_at)
  kind: bank|wallet|credit_card|debit_card|bnpl|loan|cash|investment
```

## Ingestion
```
raw_messages(id, household_id, device_id, sender, body, received_at, hash UNIQUE(household_id, hash), parsed_ok)
statements(id, household_id, account_id, file_name, period_from, period_to, imported_at)
transactions(id, household_id, account_id, occurred_at, amount_minor, currency, direction,
             merchant_raw, merchant_id NULL, category_id NULL, source sms|statement|manual|peer,
             raw_message_id NULL, statement_id NULL, created_by_member_id, dedupe_key UNIQUE(household_id, dedupe_key))
txn_purposes(txn_id PK, purpose, person_member_id NULL, confidence, set_by user|rule|model)
txn_links(id, kind transfer|claim|repayment|refund, from_txn, to_txn, fx_rate NULL)
splits(txn_id, member_id NULL, contact_id NULL, share_minor, settled_at)
```

## Reference data
```
categories(id, parent_id, name, kind spend|income|excluded)                 -- global seed + household custom
merchants(id, name, category_id, country, aliases[])                         -- global seed (NSI + curated)
merchant_rules(household_id, pattern, category_id, purpose)                  -- learned corrections
fx_rates(day, base, quote, rate)
```

## Obligations and plans
```
liabilities(id, household_id, account_id NULL, counterparty, kind loan|card|bnpl|person,
            principal_minor, rate_bp, emi_minor, start_on, end_on, opening_balance_minor, as_of)
commitments(id, household_id, name, kind, amount_minor, currency, cycle_months, next_due, country,
            match_pattern, account_id NULL, liability_id NULL, asset_id NULL)
commitment_shares(commitment_id, member_id|contact_id, share_minor)
commitment_payments(commitment_id, cycle_start, txn_id NULL, paid_by_member_id, amount_minor)
funds(id, household_id, name, target_minor, currency, due_on, commitment_id NULL)
fund_moves(fund_id, on_day, amount_minor, txn_id NULL)
assets(id, household_id, kind property|vehicle|investment, name, currency, cost_minor, value_minor, value_as_of)
asset_milestones(asset_id, name, due_on, amount_minor, paid_txn_id NULL)
asset_costs(asset_id, txn_id, cost_type, shared_with_member_id|contact_id, share_pct)
claims(id, household_id, member_id, name, status, submitted_on, expected_minor)
claim_items(claim_id, txn_id)
contacts(id, household_id, name, phone, email, linked_user_id NULL)          -- friends outside the household
settings(household_id, key, value)
trips(id, household_id, name, city, country, start_on, end_on, kind business|personal)   -- 004_trips.sql
trip_txns(trip_id, txn_id, status personal|missed|claimed|unreviewed, set_by)
```

## Why this fixes the complaints
- Family: members + roles + visibility; parents without logins are members too.
- Splits between households (friends on the app) are links between two households' transactions, not shared copies.
- One schema: no per-user DDL at request time (the cause of the first-load crash).
