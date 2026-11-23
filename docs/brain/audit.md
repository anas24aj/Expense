# Audit of the existing code (2026-11-23, upstream commit f9e1db0)

**Verdict: the core is good and tested; the shape is the problem.** The app is not a pile of dead code: 104 commits in
five weeks built a working SMS tracker with careful parsing, money-trail matching, statements import, debts, splits,
multi-user and MCP. 113 tests pass (30 skipped need Postgres). What hurts is that each idea was bolted on where it fit:
one 2,634-line `server.py`, one 2,900-line `dashboard.html` with ~30 pages, and domain concepts squeezed into tables
built for something else (loans, savings and cards all live in `holdings`). That is why it doesn't *feel* like one
finance solution.

## What exists and works (keep)

| Area | Where | Notes |
|---|---|---|
| SMS parsing (SAR/INR/USD, English + Arabic, OTP/ad filtering) | `parse.py`, `SAMPLES` in `test_expense.py` | The most valuable code. Re-reads stored SMS when the parser improves. Keep as is. |
| Categories from keywords + learned per merchant/txn | `rules.json`, `merchant_categories`, `txn_categories` | Rules are evaluated at read time, so editing rules re-categorizes history. Dataset is small (~20 categories of keywords). |
| Statement import: PDF, xlsx, xls, CSV, HTML-xls, password-protected PDF | `statement.py`, `import_statement()` | Already done — the "last phase" mostly needs the owner's files and per-bank fixes, not new code. |
| Own-account transfer matching ("money trail") incl. SAR→INR remittance and onward splits | `own_transfers`, `links`, `trail`, `txn_links` | Implements wishlist #1. Fragile heuristics but tested. |
| Accounts: bank, card, debit, wallet, BNPL, loan; balances from SMS | `accounts`, `balances`, `account_months` | |
| Loans/savings/cards with EMI, payoff plan (avalanche/snowball), extra payment what-if, "Can I buy it?" | `holdings`, `plan()`, `money()` | Covers much of #2 and #7. |
| Friends splits, settle-up; splits with people on the app (both sides) | `txn_friends`, `shared_splits`, `peer_links`, `contacts` | #3 and #11, partially. |
| Recurring detection and 30-day forecast | `dashboard.html` (`forecast`, `recurringPage`) | Client-side only; not visible to MCP. |
| Multi-user: Postgres schema per person, PBKDF2 passwords, sessions, lockout, admin page | `app_users`, `sign_in`, `admin.html` | Sign-up is admin-only; no forgot-password. |
| MCP server (JSON-RPC over HTTP) with per-user link | `_mcp`, `mcp_*` | 9 tools. |
| Android SMS forwarder app | `android/`, CI in `.github/workflows/android.yml` | |
| iPhone: Shortcuts automation, steps typed by hand from Settings; paste/import page | `dashboard.html` ~L2416, `import.html` | Not one-tap. |
| PWA manifest and icons | `manifest.webmanifest` | No service worker / offline. |

## Half-done or awkward

- **Domain overloading:** `holdings` mixes loans, savings, gold, USD stocks and credit cards; `settings` holds salary as JSON.
  No first-class *person*, *commitment*, *fund*, *asset*, *claim*.
- **Business logic in the browser:** forecast, recurring detection, many totals are computed in `dashboard.html`, so MCP
  and other clients can't see them and they're untested.
- **~30 pages behind 5 tabs** (overview, spending, debt, plan, activity) plus hidden routes (trail, liabilities, buy,
  balances, health, forecast, income, trends…). Hard to discover; the owner reports it doesn't feel like one product.
- **Dedupe by SMS body text** (`UNIQUE(body)`): two genuinely identical SMS count once; no device id.
- **One sync key per person**, so several phones can't be told apart.
- **Exchange rate** is one live INR/SAR lookup; no history, no USD/AED.

## Dead or nearly dead

- `lineChart` in `dashboard.html` is never called.
- `EXPENSE_TOKEN` "site password" path and the `public` data space are legacy from single-user days; kept only for old phones.
- Vercel-specific workarounds (4.5 MB body limit, pooler retry) are live, not dead, while Vercel stays the host.

Nothing large is dead; the clean-up is restructuring, not deleting.

## Gaps against the wishlist

| # | Gap |
|---|---|
| 1 | Fees/interest not a distinct category; wallet top-ups only matched by heuristic. |
| 3 | No *person* entity: family support has no plan vs actual. |
| 4, 5 | Bills and rent only as detected recurring; no cycle (6-monthly rent), no split share. |
| 6 | No property/asset with construction milestones. |
| 8 | Subscriptions detected but not shareable; no "did they pay". |
| 9 | No reimbursement claims. |
| 10 | No sinking funds for planned big expenses. |
| 12 | No vehicles. |
| 13 | Allocation exists on Plan; no reasoning about where to keep money (NRE/NRO/FD vs debt). |
| 14 | Forecast is 30 days of spending only; no 12-month look-ahead of income vs commitments. |
| 15 | Merchant dataset is small; no MCC-style taxonomy. |
| Auth | No self sign-up, no forgot password, no per-device keys. |
| iPhone | No one-tap Shortcut. |
