// Shapes from docs/brain/api-v3.md. Keep in step with the contract; nothing here is invented beyond it.
export type Currency = 'SAR' | 'INR' | (string & {});
export interface Money { minor: number; currency: Currency }
export type Ref = { kind: 'member' | 'contact'; id: string };

export interface User { id: string; email: string; username: string | null; name: string }
export interface Household { id: string; name: string; base_currency: Currency; home_currency: Currency; timezone: string }
export interface Member { id: string; display_name: string; relation: string; role: 'owner' | 'admin' | 'member' | 'viewer'; user_id: string | null; email: string | null }
export interface Contact { id: string; name: string; email: string | null; phone: string | null; on_app: boolean }
export interface Invite { id: string; email: string; role?: string; link?: string; expires_at?: string }
export interface Me { user: User; household: Household; member: Member; households: { id: string; name: string; role: string }[] }
export interface HouseholdFull { household: Household; members: Member[]; contacts: Contact[]; invites: Invite[]; resets?: { member_id: string; name: string; email: string; expires_at: string; link: string }[] }

export interface Person {
  kind: 'member' | 'contact'; id: string; name: string; relation: string | null; role: string | null; on_app: boolean;
  owes_you: Money[]; you_owe: Money[]; support_month: Money | null; support_plan: Money | null;
}
export interface Device { id: string; name: string; platform: 'iphone' | 'android' | 'other'; member_id: string; created_at: string; last_seen: string | null }
export interface DeviceCreated { device: Device; key: string; sms_url: string; setup: string; shortcut_url: string | null }

export type AccountKind = 'bank' | 'wallet' | 'credit_card' | 'debit_card' | 'bnpl' | 'loan' | 'cash' | 'investment';
export interface Account {
  id: string; kind: AccountKind; institution: string; name: string; currency: Currency; country: string; last4: string | null;
  owner_member_id: string | null; visibility: 'household' | 'private'; balance: Money | null; balance_at: string | null;
  credit_limit: Money | null; used_pct: number | null; due_day: number | null; statement_day: number | null; rate_bp: number | null; archived: boolean;
}

export type Purpose = 'spend' | 'fee' | 'transfer' | 'income' | 'support' | 'lend' | 'repaid' | 'borrow' | 'repay'
  | 'loan_payment' | 'claim' | 'reimbursement' | 'asset' | 'saving' | 'refund' | 'ignore';
export interface Txn {
  id: string; day: string; occurred_at: string; amount: Money; direction: 'debit' | 'credit'; merchant: string; category: string | null;
  purpose: Purpose; confidence: number; account_id: string | null; account_name: string | null; member_id: string | null; note: string | null;
  source: 'sms' | 'statement' | 'shortcut' | 'manual' | 'peer'; person: { kind: string; id: string; name: string } | null;
  split_mine: Money | null; claim_id: string | null; commitment_id: string | null; liability_id?: string | null;
}
export interface TxnDetail extends Txn { raw: { sender: string; body: string } | null; links: { id: string; kind: string; other_txn_id: string; role: 'from' | 'to'; set_by: string }[];
  splits: { id: string; member_id: string | null; contact_id: string | null; name: string; share: Money; settled: boolean }[]; claim: { id: string; name: string; status: string } | null }
export interface Suggestion { purpose: Purpose; category: string | null; person: { kind: string; id: string; name: string } | null; label: string }
export interface ReviewTxn extends Txn { suggestions: Suggestion[] }
export interface Category { id: string; name: string; parent: string | null; kind: 'spend' | 'income' | 'excluded'; icon: string | null }

export interface Liability {
  id: string; kind: 'loan' | 'credit_card' | 'bnpl' | 'person' | 'other'; name: string; lender: string; currency: Currency; principal: Money;
  opening_balance?: Money; as_of?: string | null; outstanding: Money; rate_bp: number; emi: Money; due_day: number | null; start_on: string | null; end_on: string | null;
  paid_pct: number; payoff_month: string | null; interest_month: Money; account_id: string | null; contact_id: string | null;
  match_pattern?: string | null; closed?: boolean;
  emi_from?: string | null; construction?: Construction | null;
}
/** A loan paid out in tranches while a property is built: pre-EMI (interest on what is out) until full EMIs start. */
export interface Construction {
  sanctioned: Money; disbursed: Money; undisbursed: Money; pre_emi: Money; monthly: Money; phase: 'pre_emi' | 'emi'; emi_from: string | null;
  tranches: { milestone_id: string; asset_id: string; name: string; day: string; amount: Money; future: boolean }[];
}
export type CommitmentKind = 'rent' | 'bill' | 'subscription' | 'emi' | 'support' | 'insurance' | 'school' | 'milestone' | (string & {});
export interface Share { member_id?: string; contact_id?: string; name: string; share: Money; paid_this_cycle: boolean }
export interface Commitment {
  id: string; name: string; kind: CommitmentKind; amount: Money; cycle_months: number; next_due: string; end_on: string | null; country: string | null;
  match_pattern: string | null; account_id: string | null; liability_id: string | null; asset_id: string | null; for_member_id: string | null;
  shares: Share[]; status: 'paid' | 'due' | 'overdue' | 'upcoming'; last_paid: { day: string; txn_id: string } | null; fund_id: string | null;
}
export type DetectedCommitment = Omit<Commitment, 'id'> & { evidence_txn_ids: string[] };
export interface Fund { id: string; name: string; target: Money; due_on: string; saved: Money; monthly: Money; on_track: boolean; commitment_id: string | null }
export interface Milestone { id: string; name: string; due_on: string; amount: Money; paid: boolean; paid_on?: string | null; paid_txn_id?: string | null; liability_id?: string | null; disbursed_on?: string | null }
export interface AssetCost { txn_id: string; day: string; merchant: string; cost_type: string; amount: Money }
export interface AssetSharer { id?: string; cost_type: string; name: string; member_id?: string | null; contact_id?: string | null; share_pct: number }
export interface AssetDetails {
  market_value?: { minor: number; as_of: string; source?: string }; disposal?: { status: 'sold' | 'written_off'; on: string; proceeds_minor: number; note?: string };
  area_sqft?: number; depreciation_pct?: number; bought_on?: string; builder?: string; photo_url?: string; paid_cash_minor?: number;
  [label: string]: unknown;
}
export interface Asset {
  id: string; kind: 'property' | 'vehicle' | 'investment'; name: string; currency: Currency; cost: Money; value: Money; paid: Money; financed: Money;
  remaining: Money; milestones: Milestone[]; next_milestone: Milestone | null; monthly_cost: Money; my_monthly_cost: Money;
  costs_by_type: Record<string, Money>; sharers: AssetSharer[];
  liability_id: string | null; details: AssetDetails; value_as_of?: string;
  // api-v3.md "Asset pages": what it is worth, how it was paid for, and whether it was a good buy
  status?: 'owned' | 'sold' | 'written_off'; under_construction?: boolean;
  valuation?: { value: Money; as_of: string; basis: 'market' | 'depreciation' | 'recorded' | 'cost' | 'sold' | 'written_off'; note: string; depreciation_pct: number; bought_on: string };
  funding?: { own: Money; loan: Money; interest: Money; cost_to_date: Money; own_sources: { name: string; amount: Money }[] };
  verdict?: { cost: Money; gain: Money; fd_gain: Money; edge: Money; net_cost: Money; annual_pct: number | null; fd_rate_bp: number; provisional: boolean;
    tone: 'good' | 'warn' | 'bad' | 'info'; text: string; assumptions: string[] };
  costs?: AssetCost[]; cost_totals?: Record<string, Money>; cost_total?: Money; my_cost_total?: Money;
  sharer_totals?: { member_id: string | null; contact_id: string | null; name: string; amount: Money }[];
}
export interface Claim { id: string; name: string; payer: string; status: 'draft' | 'submitted' | 'paid' | 'partly'; member_id: string; items: Txn[]; expected: Money; received: Money; age_days: number; submitted_on: string | null;
  suggestion?: { txn_id: string; day: string; amount: Money } | null; reimbursement_txn_ids?: string[] }
export interface SalaryEntry { id: string; member_id: string | null; member_name: string; from_month: string; amount: Money; kind: 'base' | 'arrears' | 'bonus'; note: string }
export interface Settings { salary: Money | null; salary_day: number | null; emergency_months: number; debt_strategy: 'avalanche' | 'snowball'; extra_to_debt_minor: number; fd_rates_bp?: Record<string, number> | null }

export interface MonthInsight {
  month: string; currency: Currency; income: Money; spent: Money; committed_due: Money; committed_paid: Money; set_aside: Money; free: Money;
  by_category: { category: string; amount: Money }[]; by_purpose: Record<string, Money> | { purpose: string; amount: Money }[]; other_out?: Money;
  owed_by_you: { loans: Money; cards: Money; bnpl: Money; people: Money; total: Money };
  owed_to_you: { people: Money; claims: Money; total: Money }; interest_month: Money; fx: { SAR_INR: number; at: string };
}
export interface LookMonth { month: string; income: Money; commitments: Money; funds: Money; everyday: Money; free: Money; warnings: string[] }
export interface Lookahead { months: LookMonth[]; debt_free: { month: string | null; months: number | null }; interest_per_month: Money }
export interface WhatIf { verdict: 'ok' | 'tight' | 'no'; why: string; month_free_after: Money; debt_free_before: DebtFree | string | null; debt_free_after: DebtFree | string | null; delay_months: number; extra_interest: Money }
export type DebtFree = { month: string | null; months: number | null };
export interface Advice { note?: string; emergency: { months_covered: number | null; target: Money }; steps: { title: string; why: string; amount: Money | null }[] }
export interface Alert { level: 'info' | 'warn' | 'bad'; text: string; link: string | null }
export interface Home { month: MonthInsight; next_dues: Commitment[]; lookahead: Lookahead; review_count: number; alerts: Alert[] }
export interface Statement { id: string; account_id: string; file_name: string; period_from: string; period_to: string; rows: number; imported_at: string }
export interface Items<T> { items: T[] }

// Trips (api-v3.md "Trips"). totals/by_* are in the trip's currency, totals_base in the base currency.
// claimed = what claims cover; burden = what you pay (spent − claimed): personal, missed, unreviewed and unclaimed parts.
export type TripStatus = 'claimed' | 'personal' | 'missed' | 'unreviewed';
export type TripSplit = { spent: Money; claimed: Money; burden: Money };
export interface Trip {
  id: string; name: string; city: string; country: string; start_on: string; end_on: string; kind: 'business' | 'personal'; claim_ids: string[];
  currency: string; totals: TripTotals; totals_base?: TripTotals; count: number;
  by_category: (TripSplit & { category: string })[]; by_day: (TripSplit & { day: string })[];
}
export type TripTotals = TripSplit & { total: Money; personal: Money; missed: Money; unreviewed: Money };
export type TripExpense = Txn & { trip_status: TripStatus; claimed: Money; burden: Money; claimed_trip: Money; burden_trip: Money };
export interface TripDetail extends Trip { expenses: TripExpense[]; claims: Claim[] }
export interface FlowNode { id: string; name: string; kind: 'inflow' | 'account' | 'spending' | 'outflow' }
export interface Flows { from: string; to: string; currency: string; nodes: FlowNode[]; links: { source: string; target: string; amount: Money }[] }
export interface Coverage {
  account_id: string; name: string; kind: AccountKind; currency: string; first_month: string | null; last_day: string | null;
  months: { month: string; sources: ('sms' | 'statement' | 'manual' | 'shortcut' | 'peer')[]; covered: boolean }[];
  missing_months: string[]; days_quiet: number | null; status: 'no_data' | 'gaps' | 'stale' | 'ok';
}
export interface ClaimRow { row: number; day: string; description: string; amount: Money; claimed: Money | null; txn_id?: string }
export interface ClaimImport { claim: Claim | null; matched: ClaimRow[]; unmatched: ClaimRow[] }
