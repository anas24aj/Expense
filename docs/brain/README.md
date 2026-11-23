# Project brain

The living knowledge base for this app. Read it before changing anything; update it in the same commit when a decision,
the domain model or the plan changes. Code says *how*; the brain says *what* and *why*.

| File | What it holds |
|---|---|
| [wishlist.md](wishlist.md) | The owner's story and 15 needs, restated as requirements with acceptance checks. The spec. |
| [audit.md](audit.md) | What the code already does, what is half-done, what is dead, and the gaps against the wishlist. |
| [domain-model.md](domain-model.md) | The money concepts (account, movement, transfer, obligation, person, asset…) and the rules between them. |
| [architecture.md](architecture.md) | Components, data flow, storage, auth, ingestion (SMS, Shortcut, statements), MCP. |
| [ux.md](ux.md) | Navigation, screens, the "no questions" principle and how each feature surfaces. |
| [decisions.md](decisions.md) | Architecture decision records: what we chose and why. Append, don't rewrite. |
| [roadmap.md](roadmap.md) | Build phases, each with its definition of done. |
| [schema-v3.md](schema-v3.md) | Draft household-first database design (replaces schema per person). |

## The one-paragraph version

A personal finance tracker for someone who lives and earns in one country (Saudi Arabia, SAR) while keeping a financial
life in another (India, INR). Money arrives as bank SMS (Android app, iPhone Shortcut), statements (PDF/Excel/CSV) and
very little manual entry. The app tells **real spending** apart from money moving between your own accounts, tracks what
you **owe** (loans, cards, friends, pay-later) and what you're **owed** (friends, family, company claims), knows your
**commitments** (EMIs, rent every 6 months, subscriptions, family support, an unfinished flat) and answers the forward
questions: *what's left this month, when am I debt-free, can I afford this, what do I set aside for next rent*. It can be
shared with the people you split money with, and asked questions from Claude through MCP.
