# Domain model

The rules here decide every number the app shows. When code and this file disagree, fix one of them in the same commit.

## Core idea: every movement has one purpose

Money is recorded once, as a **movement** on an **account**. What it *means* is its **purpose**. Totals are sums of
purposes, so "spending" can never double-count a card payment or a transfer home.

| Purpose | Example | Counts as your spending? |
|---|---|---|
| `spend` | Groceries, fuel, Netflix | Yes (your share, see splits) |
| `fee` | Card interest, late fee, bank charge, FX markup | Yes, category *Fees & interest* |
| `transfer` | Bank → credit card payment, SAR → INR remittance, wallet top-up | No. Both legs linked. |
| `income` | Salary, interest earned, refund* | No (it's income) |
| `support` | Monthly to parents, extra for a family need | Yes, category *Family*, tracked against plan |
| `lend` / `repaid` | Money given to a friend / them paying it back | No. Changes what they owe you. |
| `borrow` / `repay` | Money from a friend / paying them back | No. Changes what you owe. |
| `loan_payment` | EMI | Principal: no (reduces debt). Interest: yes (`fee`). |
| `claim` | Work trip hotel on your card | No. Money expected from the company until reimbursed. |
| `reimbursement` | The company paying the claim | No. Closes claims. |
| `asset` | Flat instalment, car down-payment | No. Raises the asset's paid-to-date. |
| `saving` | FD, SIP, stocks, gold | No. Raises savings. |

*A refund is negative spending in the original category.

Purpose is inferred (see Classification) and can be changed with one tap; a change on a merchant can be applied to all
its movements.

## Entities

- **Account** — where money sits or is owed: `bank`, `wallet` (STC Pay, PhonePe, Paytm), `credit_card`, `debit_card`
  (belongs to a bank account), `bnpl` (Tabby, Tamara), `loan`, `cash`. Has country, currency, last-4 digits, owner.
- **Movement** — amount (minor units), currency, direction, date, account, merchant, category, purpose, source
  (`sms` | `statement` | `shortcut` | `manual` | `peer`), device, original text. Immutable facts; meaning lives in links.
- **Link** — pairs two movements: the two legs of a transfer, a claim and its reimbursement, a loan and its repayment.
- **Person** — family, friend or colleague. Optional email; if they use the app, splits show on both sides.
- **Split** — a movement × person × their share. Your spending is the amount minus others' shares.
- **Liability** — something you owe: loan (principal, rate, EMI, tenure), credit card (statement balance, due date,
  rate), BNPL plan, or a person. Outstanding is computed from its opening balance and linked movements.
- **Commitment** — a promise of future money with a cycle: EMI, rent, utility bill, subscription, insurance, school
  fee, family support, construction milestone. Fields: amount (fixed or estimated), cycle in months (1, 3, 6, 12) or
  one-off date, next due, country/currency, matching rule (merchant/text) so payments tick it off, optional sharers.
- **Fund** — money set aside for a known future cost (next rent in 6 months, flight home, school fees). Target, due
  date, monthly set-aside = (target − saved) / months left. A commitment with a cycle > 1 month gets a fund automatically.
- **Asset** — property (cost, financed, paid in cash, remaining milestones), vehicle (purchase, loan, running costs
  with optional sharing per cost type), investment (FD, NRE/NRO, stocks, gold, PF) with value and rate.
- **Claim** — one or more `claim` movements, expected amount, submitted date, status (draft, submitted, paid, partly).
- **Rate** — daily FX rate per currency pair, so past months convert with that month's rate.

## Derived numbers

- **This month:** income − spending − commitments still due − fund set-asides = **free money**.
- **Owed by you:** loans + cards + BNPL + people. **Owed to you:** people + claims.
- **Interest burn:** Σ outstanding × monthly rate, per liability, per month.
- **Debt-free date:** month-by-month simulation of every liability with its EMI plus the chosen extra payment
  (avalanche by default: highest rate first).
- **What if I spend X now:** rerun the simulation with X taken from free money (or put on a card); show the delay to
  debt-free and the extra interest.
- **12-month look-ahead:** for each month: expected income, commitments due, fund set-asides, everyday spending
  (trailing average by category), → free money; flags months that go negative.
- Amounts in different currencies are never summed without converting at a stated rate; the home view shows both.

## Classification (no questions)

1. Parse the SMS / statement row (amount, currency, direction, account, merchant).
2. **Transfer?** Match against an opposite movement on another own account within a window (amount equal, or equal after
   FX within tolerance). Wallet top-ups and card payments by keyword. Linked → `transfer`.
3. **Commitment?** Matches a commitment's rule → its purpose (EMI → `loan_payment`, rent → `spend`/Rent, support →
   `support`), and ticks the commitment off.
4. **Learned?** The owner's past correction for this merchant wins.
5. **Merchant dataset** → category (see architecture: merchant data).
6. Otherwise `spend` / *Uncategorized* and into the Review inbox. Never a blocking question.
