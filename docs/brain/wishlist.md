# Wishlist (the spec)

Source: the owner's message of 2026-11-23, told as a story. Each need is restated as a requirement with a check that
proves it is done. Status is kept current in [roadmap.md](roadmap.md).

**Persona.** Home country India (INR), lives and earns in Saudi Arabia (SAR). One salary in SAR. Several bank accounts,
wallets and credit cards in both countries. Dislikes manual entry and being asked questions.

| # | Need | Requirement | Done when |
|---|---|---|---|
| 1 | Spend through banks, wallets, cards | Every account (bank, wallet, credit/debit card, BNPL) is an account. A move between two of *your* accounts is a **transfer**, never spending. Card interest, late fees and bank charges **are** spending (category *Fees & interest*). | Paying the credit card from the bank, or topping up STC Pay, adds 0 to spending; a card's interest line shows as spending. |
| 2 | Loans and EMIs | Loans with principal, rate, EMI, start/end. Monthly burden = sum of EMIs; total owed = sum of outstanding. EMI SMS reduce the balance automatically. | Debt screen shows monthly EMI burden, total outstanding by lender, and payoff date per loan. |
| 3 | Family and friends | People are first-class. Recurring support (e.g. monthly to parents) and one-off extra; money lent, money spent *for* someone and their repayment. | "Family" shows monthly support vs plan; "Friends" shows who owes whom; a repayment credit closes what was lent. |
| 4 | Utilities in both countries, sometimes split | Bills are commitments with country, due day, expected amount and optional split with people. | This month's bills list paid/due/overdue; your share only counts as your spending. |
| 5 | Rent | Rent is a commitment with its own cycle (monthly, quarterly, 6-monthly, yearly). | Next rent date and amount shown; a monthly set-aside is suggested. |
| 6 | Property, part loan part cash, maybe unfinished | A property is an asset with cost, paid-so-far (by loan and by cash) and a remaining payment schedule (construction milestones). | Property screen shows paid, financed, still to pay and next milestone. |
| 7 | Look-ahead and debt-free | Month view: salary, spent, committed, free money. Owed to cards/people/loans. Months to debt-free. Interest lost per month. "If I spend X, what happens" (delay to debt-free, extra interest). | Overview answers all of these with no setup beyond salary. |
| 8 | Recurring expenses and subscriptions | Auto-detect subscriptions (Netflix, Prime, Claude…). Mark shared with people; track whether they paid their share this cycle. | Subscriptions list with monthly total, sharers and paid/unpaid badges. |
| 9 | Company reimbursements | Mark a transaction (or several) as a **claim**; it isn't your spending; it's money expected until the reimbursement credit arrives. | Claims screen with pending total, age, and auto-match when the reimbursement lands. |
| 10 | Liabilities and planned big expenses | Liabilities with closed vs pending. Planned future expenses (rent in 6 months, school fees, flights home) get **sinking funds**: target, date, monthly set-aside. | Plan shows each fund's progress and whether this month's set-aside was made. |
| 11 | Share with people on the app | If the other person uses the app, splits and loans appear on both sides and settle once. | Already partly built (shared_splits, peer_links); extend to loans and subscriptions. |
| 12 | Vehicles | A vehicle is an asset with its costs (fuel, service, insurance, registration, loan) and optional sharing of a cost type (e.g. fuel with one person). | Vehicle screen: monthly cost of ownership, your share, cost per month trend. |
| 13 | Where to save and invest | Rules-based guidance: emergency fund months, high-interest debt first, then goals, then investing; INR vs SAR placement (NRE/NRO, FD rates vs loan rates). Not financial advice, explained in plain words. | Plan suggests an allocation of free money each month with reasons. |
| 14 | Expected amount every month | A 12-month look-ahead: income, commitments, funds, free money per month. | Look-ahead chart and table for the next 12 months. |
| 15 | Categorize SMS without manual entry | A merchant dataset (Indian + Saudi merchants, MCC-like categories) plus learned corrections. | ≥90% of SMS land in a category with no input; one tap fixes the rest and teaches the merchant. |

## Also asked for

- **Registration and passwords:** self sign-up, password change, **forgot password** by email link, sessions per device.
- **AI chat:** MCP server so Claude (or another agent) can answer questions on the data. Exists; extend tools to the new model.
- **Install:** PWA install on Android and iPhone; Android SMS app (exists); iPhone via Shortcuts with **one-tap install**.
- **Several phones** per person, each identified, all feeding the same data.
- **History import** (last phase): years of Indian bank, wallet and card PDFs/Excel into the database, de-duplicated against SMS.
