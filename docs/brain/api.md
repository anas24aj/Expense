# API v2 contract

All under `/api/v2/`, JSON, same auth as `/api/*` (session cookie or `Authorization: Bearer`). Money is
`{"minor": 12345, "currency": "SAR"}` in responses; requests may send `"amount": "123.45"` + `"currency"`.
Dates `YYYY-MM-DD`, months `YYYY-MM`. Errors: `400 {"error": "..."}`. Every POST returns the saved object.
Implemented in `domain.py` (routes) and `engine.py` (math). Both the UI and MCP use only these numbers.

## People
- `GET /people` → `[{id, name, relation: family|friend|colleague|other, email, on_app, owes_you: [money], you_owe: [money], support_plan: money|null, support_this_month: money}]`
- `POST /people` `{id?, name, relation, email?, support_amount?, support_currency?}`; `POST /people/delete` `{id}`

## Commitments (bills, rent, subscriptions, EMIs, support, milestones)
- `GET /commitments` → `[{id, name, kind: rent|bill|subscription|emi|insurance|school|support|milestone|other, amount: money, cycle_months (0 = one-off), next_due, country, match, sharers: [{person_id, share_minor, paid_this_cycle}], status_this_cycle: paid|due|overdue|upcoming, last_paid_txn}]`
- `POST /commitments` `{id?, name, kind, amount, currency, cycle_months, next_due, country?, match?, sharers?: [{person_id, share}]}`; `POST /commitments/delete` `{id}`
- `GET /commitments/detect` → suggested commitments from recurring transactions (not saved) `[{name, kind, amount, cycle_months, next_due, match, evidence_txn_ids}]`

## Funds (sinking funds)
- `GET /funds` → `[{id, name, target: money, due, saved: money, monthly: money, commitment_id|null, on_track}]` (commitments with cycle > 1 appear automatically)
- `POST /funds` `{id?, name, target, currency, due, saved?}`; `POST /funds/contribute` `{id, amount}`; `POST /funds/delete` `{id}`

## Assets
- `GET /assets` → `[{id, kind: property|vehicle|investment, name, currency, value: money, cost: money, paid_cash: money, financed: money, remaining: money, next_milestone: {name, due, amount}|null, monthly_cost: money, your_monthly_cost: money, costs_by_type: {fuel: money, ...}, sharers: [{person_id, cost_type, share_pct}]}]`
- `POST /assets` `{id?, kind, name, currency, cost?, value?, paid_cash?, loan_liability?, milestones?: [{name, due, amount}], match?, sharers?}`; `POST /assets/delete` `{id}`
- `POST /assets/cost` `{asset_id, txn_id, cost_type}` tags a transaction as a running cost (fuel, service, insurance, registration, parking, other)

## Claims (company reimbursements)
- `GET /claims` → `[{id, name, status: draft|submitted|paid|partly, items: [{txn_id, amount: money, merchant, day}], expected: money, received: money, age_days}]`, plus `pending_total` per currency
- `POST /claims` `{id?, name, status?, txn_ids}`; `POST /claims/paid` `{id, txn_id}` (the reimbursement credit); `POST /claims/delete` `{id}`

## Purpose of a transaction
- `POST /purpose` `{txn_id, purpose: spend|fee|transfer|income|support|lend|repaid|borrow|repay|loan_payment|claim|reimbursement|asset|saving, person_id?, all_from_merchant?}`
- Every transaction from `/api/transactions` and `/api/v2/review` carries `purpose` and `confidence` (0–1).
- `GET /review` → transactions with low confidence or uncategorized, newest first, with `suggestions: [{purpose, category, person_id}]`

## Engine
- `GET /month?month=YYYY-MM&currency=SAR` → `{income, spent, committed_due, committed_paid, set_aside, free, by_purpose: {...}, owed_by_you: {loans, cards, bnpl, people, total}, owed_to_you: {people, claims, total}, interest_this_month, rate: {"SAR_INR": x, at}}`
- `GET /lookahead?months=12&currency=SAR` → `{months: [{month, income, commitments, funds, everyday, free, warnings: [str]}], debt_free: {month|null, months}, interest_per_month}`
- `GET /whatif?amount=5000&currency=SAR&pay=cash|card` → `{debt_free_before, debt_free_after, delay_months, extra_interest, month_free_after, verdict: ok|tight|no, why}`
- `GET /advice?currency=SAR` → `{emergency_fund: {months_covered, target}, steps: [{title, why, amount}]}` (rules-based, plain words)
- `GET /settings` / `POST /settings` `{salary, salary_currency, salary_day, home_currency, emergency_months}`
