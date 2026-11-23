# API v3 contract (household-first)

Base: `/api`. JSON in and out. Auth: `session` HttpOnly cookie (web), `Authorization: Bearer <device key>` (phones, only
`/api/ingest/sms`), MCP at `/mcp/<personal key>` or `/mcp` with Bearer. The current household is the `hh` cookie (set by
`POST /api/households/switch`), defaulting to the user's first household.

Conventions
- **Money**: responses use `{"minor": 12345, "currency": "SAR"}` (shown as `Money`). Requests send `amount_minor` (int) + `currency`.
- Ids are 32-char hex strings. Days `YYYY-MM-DD`, months `YYYY-MM`, times ISO-8601 UTC.
- Errors: `{"error": "human sentence"}` with 400/401/403/404/409/413/422/429. 500 never leaks internals.
- Lists return `{"items": [...]}` plus extra summary fields where noted. Deletes return `{"id": ..., "deleted": true}`.
- Every write returns the saved object in the same shape as its GET.

## Auth & account (`api/auth.py`)
| Method | Path | Body → Response |
|---|---|---|
| POST | /auth/signup | `{email, password, name}` → `{user, household}`; creates user + household "<name>'s family" + owner member; signs in. 409 if email taken. Accepts `invite` token to join an existing household instead. |
| POST | /auth/login | `{login (email or username), password}` → `{user}`; 401 wrong, 429 locked (10 fails/15 min/IP) |
| POST | /auth/logout | → `{ok}` |
| GET | /auth/me | → `{user: {id,email,username,name}, household: {id,name,base_currency,home_currency,timezone}, member: {id,display_name,role,relation}, households: [{id,name,role}]}` (401 if signed out) |
| POST | /auth/password | `{current, new}` → `{ok}` (other sessions end) |
| POST | /auth/forgot | `{email}` → `{ok}` always; emails a link if RESEND_API_KEY+MAIL_FROM, else owner sees it in household admin |
| POST | /auth/reset | `{token, password}` → `{user}` signed in; token single-use, 30 min |
| PATCH | /auth/me | `{name?, username?}` → user |

## Household & people (`api/households.py`)
| GET | /households/current | → `{household, members: [Member], contacts: [Contact], invites: [Invite]}` |
| PATCH | /households/current | `{name?, base_currency?, home_currency?, timezone?}` (admin) |
| POST | /households | `{name}` → household (user becomes owner) |
| POST | /households/switch | `{household_id}` → me |
| POST | /members | `{display_name, relation, role?, email?}` (admin) → Member; with email also creates an invite |
| PATCH/DELETE | /members/{id} | (admin) |
| POST | /invites/{id}/resend, DELETE /invites/{id} | (admin) → Invite with `link` |
| GET | /invites/{token}/preview | public → `{household_name, invited_by, email}` |
| POST | /contacts, PATCH/DELETE /contacts/{id} | `{name, email?, phone?}` → Contact (`on_app`: bool) |
| GET | /people | → `{items: [{kind: member|contact, id, name, relation, role, on_app, owes_you: [Money], you_owe: [Money], support_month: Money|null, support_plan: Money|null}]}` |
| GET | /devices | → `{items: [{id, name, platform, member_id, created_at, last_seen}]}` |
| POST | /devices | `{name, platform: iphone|android|other}` → `{device, key, sms_url, setup: "<json string {url,key}>", shortcut_url}` (key shown once) |
| DELETE | /devices/{id} | revoke |
| GET | /mcp-key | → `{url}` personal MCP connector link (POST rotates) |

Member: `{id, display_name, relation, role, user_id|null, email|null}`. Contact: `{id, name, email, phone, on_app}`.

## Ledger (`api/ledger.py`)
| GET | /accounts | → `{items: [Account]}` Account: `{id, kind, institution, name, currency, country, last4, owner_member_id, visibility, balance: Money|null, balance_at, credit_limit: Money|null, used_pct|null, due_day, statement_day, rate_bp, archived}` |
| POST/PATCH/DELETE | /accounts, /accounts/{id} | create/update/archive |
| GET | /transactions | query `month, account_id, category, purpose, member_id, q, review=1, limit, before` → `{items: [Txn], next_before}` |
| GET | /transactions/{id} | → Txn + `{raw: sender/body|null, links: [...], splits: [...], claim|null}` |
| POST | /transactions | manual `{account_id?, day, amount_minor, currency, direction, merchant, category?, purpose?, note?}` |
| PATCH | /transactions/{id} | `{category?, purpose?, person: {kind, id}?, note?, apply_to_merchant?: bool}` → Txn (writes merchant_rules when apply_to_merchant) |
| POST | /transactions/{id}/split | `{shares: [{member_id|contact_id, share_minor}]}` → Txn |
| POST | /transactions/{id}/link | `{to_txn_id, kind: transfer|refund|repayment}` / DELETE /transactions/{id}/link/{link_id} |
| DELETE | /transactions/{id} | soft delete |
| GET | /review | → `{items: [Txn + suggestions: [{purpose, category, person, label}]], count}` low-confidence first |
| GET | /categories | → `{items: [{id, name, parent, kind, icon}]}` |
| POST | /settle | `{person: {kind,id}, currency, txn_id?}` mark balances with a person settled |

Txn: `{id, day, occurred_at, amount: Money, direction, merchant, category, purpose, confidence, account_id, account_name, member_id, note, source, person: {kind,id,name}|null, split_mine: Money|null, claim_id|null, commitment_id|null}`

## Ingestion (`api/ingest.py`)
| POST | /ingest/sms | device auth. `{sender, body, received_at?}` → 201 `{stored: true, transaction: Txn}` / 200 `{stored: false, reason}` |
| POST | /ingest/sms/batch | session auth. `{messages: [{sender, body, received_at}]}` (paste/import) → `{received, stored}` |
| POST | /ingest/statement | `{account_id, file_name, data_base64, password?}` → `{statement, rows, new, duplicates}` (reuses statement.py) |
| GET | /ingest/statements | → `{items: [{id, account_id, file_name, period_from, period_to, rows, imported_at}]}`; DELETE /ingest/statements/{id} |
| GET | /ingest/log | → `{items: [{at, device, sender, outcome}]}` last 50 deliveries (for "is my phone sending?") |

Pipeline per message: parse.py → account match (last4/sender) or auto-create account → dedupe → classify (transfer pairing, liability/commitment/asset match, merchant_rules, merchants dataset, fee words) → txn_meta with confidence.

## Plan (`api/plan.py`)
| GET/POST/PATCH/DELETE | /liabilities[/{id}] | Liability: `{id, kind, name, lender, currency, principal, outstanding: Money, rate_bp, emi: Money, due_day, start_on, end_on, paid_pct, payoff_month, interest_month: Money, account_id, contact_id}` |
| GET/POST/PATCH/DELETE | /commitments[/{id}] | Commitment: `{id, name, kind, amount: Money, cycle_months, next_due, end_on, country, match_pattern, account_id, liability_id, asset_id, for_member_id, shares: [{member_id|contact_id, name, share: Money, paid_this_cycle}], status: paid|due|overdue|upcoming, last_paid: {day, txn_id}|null, fund_id|null}` |
| GET | /commitments/detect | → `{items: [suggested Commitment without id + evidence_txn_ids]}` |
| POST | /commitments/{id}/paid | `{txn_id?, amount_minor?, payer?: {kind,id}}` mark this cycle paid (by me or a sharer) |
| GET/POST/PATCH/DELETE | /funds[/{id}] | Fund: `{id, name, target: Money, due_on, saved: Money, monthly: Money, on_track, commitment_id}`; POST /funds/{id}/move `{amount_minor}` |
| GET/POST/PATCH/DELETE | /assets[/{id}] | Asset: `{id, kind, name, currency, cost, value, paid: Money, financed: Money, remaining: Money, milestones: [...], next_milestone, monthly_cost: Money, my_monthly_cost: Money, costs_by_type: {type: Money}, sharers: [...], liability_id, details}`; POST /assets/{id}/milestones, PATCH/DELETE /assets/{id}/milestones/{mid}; POST /assets/{id}/costs `{txn_id, cost_type}`; PUT /assets/{id}/sharers `{items: [{cost_type, member_id|contact_id, share_pct}]}` |
| GET/POST/PATCH/DELETE | /claims[/{id}] | Claim: `{id, name, payer, status, member_id, items: [Txn], expected: Money, received: Money, age_days, submitted_on}`; list adds `pending: [Money]`; POST /claims/{id}/items `{txn_ids}`; POST /claims/{id}/paid `{txn_id}` |
| GET/PUT | /settings | `{salary: Money|null, salary_day, emergency_months, debt_strategy: avalanche|snowball, extra_to_debt_minor}` |

## Insights (`api/insights.py`, math in engine.py)
| GET | /insights/month?month= | `{month, currency, income, spent, committed_due, committed_paid, set_aside, free, by_category: [{category, amount: Money}], by_purpose, owed_by_you: {loans, cards, bnpl, people, total}, owed_to_you: {people, claims, total}, interest_month, fx: {SAR_INR, at}}` (all Money in base currency) |
| GET | /insights/lookahead?months=12 | `{months: [{month, income, commitments, funds, everyday, free, warnings}], debt_free: {month|null, months|null}, interest_per_month: Money}` |
| GET | /insights/whatif?amount_minor=&currency=&pay=cash|card|emi&months= | `{verdict: ok|tight|no, why, month_free_after, debt_free_before, debt_free_after, delay_months, extra_interest}` |
| GET | /insights/advice | `{emergency: {months_covered, target: Money}, steps: [{title, why, amount: Money|null}]}` |
| GET | /insights/home | one call for the Home screen: `{month (as above), next_dues: [Commitment ×5], lookahead (6 months), review_count, alerts: [{level, text, link}]}` |

## MCP (`api/mcp.py`)
JSON-RPC 2.0 over POST (`initialize`, `tools/list`, `tools/call`, `ping`). Tools read the same functions as the API:
`get_home, get_month, get_lookahead, what_if, list_transactions, search_transactions, get_people, get_commitments, get_liabilities, get_claims, get_assets, get_advice, add_transaction, set_purpose`.
