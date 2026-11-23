# Architecture

## Shape

```
 Android app ──┐                                     ┌── PWA (phone, desktop) ── user
 iPhone Shortcut ┼─ POST /sms (device key) ─┐        │
 Statement upload ┘                         ▼        │
                                    ┌───────────────────────┐
                                    │  Python WSGI app       │  Vercel (serverless)
                                    │  ingest → classify →   │
                                    │  ledger → engine → API │──── /mcp ── Claude / ChatGPT / agents
                                    └──────────┬────────────┘
                                               ▼
                                     Neon Postgres (schema per person)
```

## Stack (see decisions ADR-001)

- **Backend:** Python 3.12, plain WSGI, standard library + `pg8000`, `openpyxl`, `xlrd`, `pypdf`. Same code locally on
  SQLite. Hosted on Vercel Hobby; database Neon Free.
- **Frontend:** no-build PWA: HTML + ES modules + one CSS file with design tokens; a service worker for install and
  offline shell. One module per screen.
- **Tests:** `unittest`; parsing samples, classification, engine (look-ahead, debt-free, what-if) and API.

## Code layout (target)

```
app/
  db.py            connection, schema, migrations
  auth.py          users, sessions, password reset, device keys
  ingest/          sms.py (was parse.py), statement.py, dedupe.py
  classify.py      purpose + category inference (transfer matching, commitments, learned, merchant data)
  ledger.py        movements, links, splits, claims, accounts, balances
  engine.py        month view, look-ahead, debt-free simulation, what-if, advice
  api.py           HTTP routes (JSON)
  mcp.py           MCP tools over the same engine
data/
  merchants.json   merchant → category (India + Saudi), built from rules.json + open brand data
  categories.json  the category tree
web/               the PWA
server.py          WSGI entry (Vercel looks here)
```

Business numbers are computed **only** in `engine.py`, so the UI, the API and MCP always agree.

## Data

- One Postgres schema per person (existing). Shared rows between people (splits, peer links) in `public`.
- New tables are additive (`people`, `commitments`, `funds`, `assets`, `asset_costs`, `claims`, `claim_items`,
  `splits`, `rates`, `devices`, `password_resets`); `holdings` rows migrate into `liabilities`/`assets` by a one-time,
  idempotent migration that leaves the old table in place until verified.
- Movements keep the original SMS/row text so the parser can be improved and re-run.
- Dedupe: (device, message id) when the phone sends one; else (account, amount, time ±2 min, text hash); statement rows
  dedupe against SMS by (account, date, amount).

## Ingestion

- **Android:** existing app, posts each new SMS with its device key.
- **iPhone:** a shared Shortcut ("Send to Expense") installed from an iCloud link; it reads the device key from the
  clipboard on first run (the app's *Add iPhone* button copies it) and stores it. A Messages automation runs it for
  messages containing an amount. See ADR-005.
- **Statements:** upload PDF/Excel/CSV per account (existing `statement.py`).
- **Several phones:** each phone is a *device* with its own key, name and last-seen; revoke one without touching others.

## Auth

- Email + password (PBKDF2), self sign-up (SIGNUP=closed for invite-only), sessions per device. No secrets to configure: signing key generated and kept in `app_secrets`; first account = owner = admin (ADR-008).
- Forgot password: emailed one-time link (30 min, only an HMAC-derived hash stored) via Resend (`RESEND_API_KEY`, `MAIL_FROM`); until then the admin
  page issues reset links.
- MCP: per-person secret URL (works as a Claude custom connector) or bearer header.

## Merchant data (wishlist #15)

`data/merchants.json` = curated rules.json keywords + brand names from the open *name-suggestion-index* (OpenStreetMap
brands, BSD-3) filtered to India and Saudi Arabia, mapped to our categories, + common SMS descriptors (UPI handles,
POS names). Learned corrections per person sit on top. No transaction data ever leaves the app.
