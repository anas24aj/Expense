# Decisions (ADRs)

## ADR-001 Evolve the existing stack, don't rewrite (2026-11-23)
The SMS parser, statement reader and transfer matcher hold weeks of real-world edge cases with 113 tests. A rewrite in
a new stack would re-learn them. Keep Python WSGI + Neon + no-build PWA; add the domain model in new modules; move
business math server-side. Revisit only if the single-process WSGI hits Vercel limits.

## ADR-002 Purpose on every movement
Spending is a sum over purposes, not over debits. Fixes double-counting of card payments and remittances for good.

## ADR-003 New concepts in new tables, additive migrations
`people, commitments, funds, assets, asset_costs, claims, devices…` are new tables; old tables stay readable until the
new screens replace them. No destructive migration without a backup export first.

## ADR-004 Parallel build by file ownership
Work is split into streams that own separate files (see roadmap.md) and meet at the API contract in `api.md`.

## ADR-005 iPhone ingestion via a shared Shortcut + device key
Apple doesn't let apps read SMS. A shared iCloud Shortcut is one tap to install; it reads its device key from the
clipboard (copied by *Add iPhone* in the app) so no typing. Creating the Messages automation is 3 taps the app walks
through; Apple doesn't allow installing automations by link.

## ADR-006 App stores
PWA for both platforms now. Android: the existing SMS app (sideload / Play internal testing later as a TWA + SMS
permission declaration). iOS App Store adds nothing over PWA + Shortcut since SMS can't be read.

## ADR-007 Merchant data from open brand data
Use OpenStreetMap's name-suggestion-index (BSD-3) for India and Saudi brands plus curated keywords; no third-party
transaction categorization API (privacy, cost).
