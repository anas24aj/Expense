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
| GET | /shared | (any signed-in user) splits other households recorded with you as their contact, matched by your email → `{items: [{household, you_owe: [Money], owed_to_you: [Money], lines: [{day, what, your_share}]}]}` |
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
| PATCH | /transactions/{id} | `{category?, purpose?, person: {kind, id}?, note?, liability_id?: id|null (link to a loan; implies purpose loan_payment), apply_to_merchant?: bool}` → Txn (writes merchant_rules when apply_to_merchant) |
| POST | /transactions/{id}/split | `{shares: [{member_id|contact_id, share_minor}]}` → Txn |
| POST | /transactions/{id}/link | `{to_txn_id, kind: transfer|refund|repayment}` / DELETE /transactions/{id}/link/{link_id} |
| DELETE | /transactions/{id} | soft delete |
| GET | /review | → `{items: [Txn + suggestions: [{purpose, category, person, label}]], count}` low-confidence first |
| GET | /categories | → `{items: [{id, name, parent, kind, icon}]}` |
| POST | /settle | `{person: {kind,id}, currency, txn_id?}` mark balances with a person settled |

Txn: `{id, day, occurred_at, amount: Money, direction, merchant, category, purpose, confidence, account_id, account_name, member_id, note, source, person: {kind,id,name}|null, split_mine: Money|null, claim_id|null, commitment_id|null, liability_id|null}`

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

## Trips (added 2026-11-23, owner request; `api/plan.py`, migration 004_trips.sql)
A trip is a date window and a place. Every transaction in the window (and, when known, in that place/currency) belongs
to it automatically. A trip's expenses are each `claimed` (in a claim), `personal` (not claimable), `missed` (should
have been claimed) or `unreviewed`. A business trip with a claim shows what isn't claimed yet so nothing is lost.
| GET | /trips | `{items: [Trip]}` Trip: `{id, name, city, country, start_on, end_on, kind: business|personal, claim_ids: [], totals: {total, spent, claimed, burden, personal, missed, unreviewed} (Money in trip currency + base), count, by_category: [{category, spent, claimed, burden}], by_day: [{day, spent, claimed, burden}]}` |
| POST/PATCH/DELETE | /trips[/{id}] | `{name, city, country, start_on, end_on, kind}` |
| GET | /trips/{id} | Trip + `expenses: [Txn + {trip_status, claimed, burden, claimed_trip, burden_trip}]` (by day, oldest first), `claims: [Claim]` |
| POST | /trips/{id}/tag | `{txn_ids, status: personal|missed|claimed|unreviewed}` |
| POST | /trips/{id}/claim | `{name, txn_ids?}` create a claim from the trip (default: all unreviewed + missed business expenses) |
| POST | /claims/import | `{file_name, data_base64, trip_id?}` the company claim Excel: rows (date, description, amount, currency, claimed amount) → claim + items matched to transactions (amount ± FX tolerance, date ± 3 days); unmatched rows returned as `unmatched` |
Spending reports exclude `claimed` and `missed` trip expenses until reimbursed (they're money expected), include `personal`.
## Implementation notes (core: auth, households, ledger, ingest)
Additions and decisions beyond the tables above; the UI may rely on them.
- **Auth**: `POST /auth/login` also accepts `invite` (an existing user joins that household). Wrong `current` on
  `POST /auth/password` → 403 (not 401, so the UI doesn't think it was signed out). Passwords 8–200 chars.
  Signup with `invite` does not require the invite's email to match.
- **Reset/invite/MCP links** carry `<row id>.<hmac>`; only sha256 is stored. Without RESEND_API_KEY+MAIL_FROM,
  `GET /households/current` adds `resets: [{member_id, name, email, expires_at, link}]` for owners/admins. `invites`
  (with `link`) are listed to owners/admins only (empty list for others).
- **Members**: `POST /members` with `email` returns Member + `invite` (Invite with `link`); `PATCH /members/{id}` with
  `email` invites a login-less member. Owner can't be removed or re-roled; removing a member revokes their phones.
- **Devices**: `POST /devices` → 201. `GET /mcp-key` makes a key on first call; POST rotates (old URL stops working).
- **Accounts**: POST/PATCH fields `kind, name, currency, institution, country, last4, visibility, owner_member_id,
  credit_limit_minor, opening_balance_minor, opening_as_of, due_day, statement_day, rate_bp`; PATCH also `archived`
  (bool). `GET /accounts?archived=1` includes archived. Balance sign: negative = owed (cards). `balance` is the last
  balance an SMS/statement stated, else opening + movements since `opening_as_of`, else null. A card's "Avl limit" SMS
  sets a balance only once `credit_limit_minor` is known.
- **Transactions**: `next_before` is an opaque cursor. Detail `links: [{id, kind, other_txn_id, role: from|to, set_by}]`,
  `splits: [{id, member_id, contact_id, name, share: Money, settled}]`, `claim: {id, name, status}|null`.
  Purposes also include `refund` and `ignore`. Unlinking a transfer re-guesses both sides without pairing and pins it.
- **Review**: items with confidence < 0.7 that the user hasn't set (classify.REVIEW_BELOW), lowest first, 100 max.
- **Settle**: returns `{ok, person: <People item>}`. Splits are marked settled; lend/repaid/borrow/repay movements
  recorded before the settle time stop counting (settings key `settled.<kind>.<id>.<CUR>`).
- **People**: `support_month` = this (UTC) month's `support` debits for that member; `support_plan` from active
  `support` commitments with `for_member_id` (amount / cycle_months). One Money, in the biggest currency.
- **Ingest**: `POST /ingest/statement` → 201. Outcomes in `/ingest/log`: `stored`, `duplicate` (not logged again),
  `already in a statement`, `card statement` (updates/creates the credit_card account's owed balance and due day),
  `pay later plan` (creates a `bnpl` liability), `skipped: security code` (body not kept), `skipped: advert`,
  `not a transaction`. Accounts are auto-created from sender + last 4 (`institution ••1234`).
- **Classification** sets `txn_meta.commitment_id/liability_id/asset_id`; it does not write `commitment_payments`
  (plan.py derives paid status). Schema addition: `migrations/002_core.sql` (`mcp_keys`).
- **For plan/insights/mcp** (Python): `classify.reclassify(hh, txn_ids=None)`, `classify.save_meta(hh, txn_id, meta, set_by)`,
  `ledger.visible_txns(hh, member_id, where='', order=..., limit=None, **params)` + `ledger.txn_views(hh, rows)` → Txn,
  `ledger.get_txn(hh, member_id, id)`, `ledger.account_views(hh, member_id)`, `households.people(hh, db)`,
  `households.balances(hh)`, `households.person_of(req, {kind,id})`, `auth.mcp_user(key, db=None)`, `api/valid.py` checks.

## Implementation notes (plan, insights, MCP)
Additions and decisions beyond the tables above (all additive unless marked). Math stays in `engine.py`; `api/insights.load()`
turns v3 rows into engine shapes once per request.
- **Liability** adds `opening_balance, as_of, member_id, match_pattern, closed, payments: [{txn_id, day, amount, interest, principal}]`.
  Outstanding = opening − principal of payments after `as_of` (payments: `txn_meta.liability_id`, else debit merchant text contains
  `match_pattern`). Each payment pays `outstanding × rate/12` interest first; **that interest counts as spending** (purpose `fee`,
  category *Fees & interest*) in insights. A `credit_card`/`bnpl` with `account_id` follows that account's debits/credits instead.
  List adds `emi_total`, `outstanding_total` (base currency). PATCH `{closed: bool}`; DELETE removes it (and unlinks txn_meta).
  `principal_minor` defaults opening; `opening_balance_minor` defaults principal; `as_of` defaults today.
- **Commitment** adds `my_share` (amount − shares); list adds `monthly_total` (my share / cycle, base). DELETE = soft (`ended_at`).
  Status comes from matched debits (`txn_meta.commitment_id` or `match_pattern`, up to 15 days early) and from
  `POST /paid` marks without a sharer payer (a mark counts for the cycle that was due). `POST /paid` with a `payer` contact
  that isn't a sharer → 400; a member payer who isn't a sharer counts as paying the whole thing. `paid_this_cycle`: a sharer's
  mark since the cycle start, or a credit from that person ≥ 90% of their share. Sharers' shares are excluded from my spending.
- **Fund**: commitment funds (cycle > 1) are created/updated/closed automatically; target = my share, `due_on` follows the
  commitment's next due, `saved` counts only moves in the current cycle. `POST /move` accepts negative amounts, optional
  `txn_id`, `on_day`. List adds `monthly_total`. DELETE = soft (`closed_at`).
- **Asset**: `paid` = `details.paid_cash_minor` (paid before tracking) + debits with `txn_meta.asset_id` or `match_pattern`
  + paid milestones; `financed` = linked liability principal; `remaining` = cost − paid − financed. Milestone:
  `{id, name, due_on, amount, paid, paid_on, paid_txn_id}`; `next_milestone` = first unpaid. Running costs = average of the last
  3 full months of `/costs`-tagged txns; `my_monthly_cost` subtracts sharers' `share_pct` per type (`'*'` = all types) and adds
  the EMI. Sharers' parts of tagged costs are excluded from my spending. Adds `value_as_of, match_pattern`. DELETE = soft (`sold_at`).
- **Claim** adds `suggestion: {txn_id, day, amount}|null` (an unlinked credit for the outstanding amount ±1%, within 90 days of
  the last item) and `reimbursement_txn_ids`. `POST /claims` accepts `txn_ids` (status defaults `submitted` with items, else
  `draft`). `POST /paid` without `txn_id` uses the suggestion, else just marks it paid. Expected = sum of items (no stored
  expected). DELETE removes the claim and re-classifies its items.
- **Settings** PUT accepts `salary_minor` + `salary_currency`, or `salary` as Money|null.
- **Insights**: month adds `other_out` (EMIs, lending, assets, saving). Lookahead adds `extra_to_debt`; `debt_strategy` and
  `extra_to_debt_minor` from settings drive the debt-free simulation (default: average free money, avalanche). Whatif `pay=emi`
  takes `months` (default 12) and `rate_bp` (default 0 = no-cost EMI). Advice adds `note` (guidance, not financial advice);
  emergency cushion = balances of bank/wallet/cash accounts. Home `alerts[].link` are UI paths (`/plan/commitments/{id}`,
  `/plan/claims/{id}`, `/plan/lookahead`). `review_count`: no meaning yet, or rule-set with confidence < 0.6.
- **FX**: one `fx_rates` row per day (SAR→INR) from `server.inr_per_sar()`, else the last stored, else 24.9. `engine.conv`
  only knows SAR/INR/USD: any other currency converts as if INR (a known limit; matters for AED/GBP trips).
- Other members' `private` accounts are left out of every plan/insights number.
- **Trips**: Trip adds `currency` (from `country`: ISO-2 or name, e.g. `IN`/`India`; else base); `totals` are Money in the trip
  currency and `totals_base` the same keys in base currency. The window match is computed (not stored); `trip_txns` holds explicit
  tags (any txn can be tagged in). Being in a claim always wins (`claimed`). `missed` and tagged `claimed` expenses are excluded
  from spending but are not added to `owed_to_you.claims` (only real claims are). `POST /trips/{id}/claim` → 201 Claim; 400 when
  nothing is left. Migration: `004_trips.sql`.
- **Partial claims** (2026-11-23, migration `005_claim_amounts.sql`): `claim_items.claimed_minor` + `claimed_currency` (NULL = the whole
  transaction). The claim import stores each matched row's claimed amount; manual adds keep NULL. The covered part is converted to the
  txn's currency and capped at its amount. Trip `totals.claimed` = what claims cover; `burden` = spent − claimed (personal, missed,
  unreviewed and the unclaimed part of claimed bills); `personal/missed/unreviewed` = those expenses' amounts; `total` = `spent`.
  Per expense `claimed`/`burden` are in the txn's currency, `*_trip` in the trip's. A claim's `expected` sums the covered parts, and
  the uncovered part of a claimed bill counts as spending (`spend`) in insights.
- **Claim import** → `{claim: Claim|null, matched: [{row, day, description, amount, claimed, txn_id}], unmatched: [same without
  txn_id]}`; 201 when a claim was made, else 200; 422 unreadable/no header. Also takes `.xls` and `.csv`. Header row found in the
  first 20 rows by words (date/day, desc/detail/merchant…, curr/ccy, amount/total/cost…, claim/approved/reimburs); the claimed
  column is stored per item (see Partial claims). With `trip_id` only that trip's expenses are candidates; matched txns already in a claim are skipped.
- **MCP** tools call the same route handlers in-process as the key's member (`admin` routes still checked);
  `search_transactions` = `GET /transactions?q=`.
