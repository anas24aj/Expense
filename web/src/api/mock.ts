// Dev-only fake backend: patches window.fetch for /api/* with contract-shaped data (docs/brain/api-v3.md).
// Loaded only behind import.meta.env.DEV / VITE_MOCK in main.tsx, so production builds never include it.
import type {
  Account, Asset, Claim, Commitment, Contact, DetectedCommitment, Device, Fund, Invite, Liability, Member, Money,
  Person, ReviewTxn, SalaryEntry, Settings, Trip, TripStatus, Txn,
} from './types';

const SAR = (v: number): Money => ({ minor: Math.round(v * 100), currency: 'SAR' });
const INR = (v: number): Money => ({ minor: Math.round(v * 100), currency: 'INR' });
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const NOW = new Date();
const day = (offset: number) => { const d = new Date(NOW); d.setDate(d.getDate() + offset); return iso(d); };
const ym = (offset: number) => { const d = new Date(NOW.getFullYear(), NOW.getMonth() + offset, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const onDay = (monthOffset: number, dom: number) => `${ym(monthOffset)}-${pad(dom)}`;
let seq = 1000;
const id = () => (seq++).toString(16).padStart(32, '0');

const household = { id: 'h'.padEnd(32, '0'), name: 'Menon family', base_currency: 'SAR', home_currency: 'INR', timezone: 'Asia/Riyadh' };
const user = { id: 'u'.padEnd(32, '0'), email: 'arjun@example.com', username: 'arjun', name: 'Arjun Menon' };
const members: Member[] = [
  { id: 'm1', display_name: 'Arjun', relation: 'self', role: 'owner', user_id: user.id, email: user.email },
  { id: 'm2', display_name: 'Priya', relation: 'spouse', role: 'admin', user_id: 'u2', email: 'priya@example.com' },
  { id: 'm3', display_name: 'Amma', relation: 'mother', role: 'viewer', user_id: null, email: null },
  { id: 'm4', display_name: 'Achan', relation: 'father', role: 'viewer', user_id: null, email: null },
];
const contacts: Contact[] = [
  { id: 'c1', name: 'Rahul Nair', email: 'rahul@example.com', phone: null, on_app: true },
  { id: 'c2', name: 'Imran Shaikh', email: null, phone: '+966 55 123 4567', on_app: false },
  { id: 'c3', name: 'Sameer Khan', email: 'sameer@example.com', phone: null, on_app: true },
  { id: 'c4', name: 'Vineeth K', email: null, phone: '+91 98470 12345', on_app: false },
  { id: 'c5', name: 'Rohan', email: 'rohan@example.com', phone: '+966 50 765 4321', on_app: true },
  { id: 'c6', name: 'Faisal (tenant)', email: null, phone: '+966 55 222 1100', on_app: false },
];
const invites: Invite[] = [{ id: 'i1', email: 'amma.menon@example.com', role: 'viewer', link: location.origin + '/join?t=demo-invite', expires_at: day(6) }];

const accounts: Account[] = [
  acct('a1', 'bank', 'Al Rajhi Bank', 'Current account', 'SAR', 'SA', '4471', SAR(18420)),
  acct('a2', 'credit_card', 'SNB', 'Platinum card', 'SAR', 'SA', '9012', SAR(-6850), SAR(20000), 34, 2700),
  acct('a3', 'wallet', 'STC Pay', 'STC Pay', 'SAR', 'SA', null, SAR(640)),
  acct('a4', 'bank', 'HDFC Bank', 'NRE savings', 'INR', 'IN', '2231', INR(42000)),
  acct('a5', 'bank', 'ICICI Bank', 'NRO savings', 'INR', 'IN', '7780', INR(8650)),
  acct('a6', 'credit_card', 'HDFC Bank', 'Regalia card', 'INR', 'IN', '5518', INR(-38400), INR(200000), 19, 4200),
  acct('a7', 'loan', 'HDFC Bank', 'Home loan', 'INR', 'IN', '0093', INR(-3862000), null, null, 865),
  acct('a8', 'loan', 'Al Rajhi Bank', 'Auto finance', 'SAR', 'SA', '3302', SAR(-41200), null, null, 450),
  acct('a9', 'bnpl', 'Tabby', 'Tabby', 'SAR', 'SA', null, SAR(-900)),
  // Priya's own accounts, shown under her name
  { ...acct('a10', 'bank', 'Riyad Bank', 'Salary account', 'SAR', 'SA', '6620', SAR(9340)), owner_member_id: 'm2' },
  { ...acct('a11', 'bank', 'Federal Bank', 'NRE savings', 'INR', 'IN', '1184', INR(126000)), owner_member_id: 'm2' },
  { ...acct('a12', 'credit_card', 'Riyad Bank', 'Visa Signature', 'SAR', 'SA', '3051', SAR(-1240), SAR(15000), 8, 2600), owner_member_id: 'm2' },
];
function acct(id: string, kind: Account['kind'], institution: string, name: string, currency: string, country: string, last4: string | null,
  balance: Money, credit_limit: Money | null = null, used_pct: number | null = null, rate_bp: number | null = null): Account {
  return { id, kind, institution, name, currency, country, last4, owner_member_id: 'm1', visibility: 'household', balance, balance_at: day(0) + 'T06:00:00Z',
    credit_limit, used_pct, due_day: kind === 'credit_card' ? 18 : null, statement_day: kind === 'credit_card' ? 28 : null, rate_bp, archived: false };
}
const acctName = (aid: string) => { const a = accounts.find(x => x.id === aid)!; return `${a.institution} ${a.last4 ? '··' + a.last4 : a.name}`; };

const categories = ['Groceries', 'Dining', 'Fuel', 'Transport', 'Shopping', 'Rent', 'Utilities', 'Subscriptions', 'Family', 'Health',
  'Education', 'Travel', 'Fees & interest', 'Loan EMI', 'Salary', 'Transfer', 'Home', 'Entertainment', 'Ignored']
  .map((name, i) => ({ id: 'cat' + i, name, parent: null, kind: name === 'Salary' ? 'income' : name === 'Ignored' || name === 'Transfer' ? 'excluded' : 'spend', icon: null }));

const T = (offset: number, merchant: string, amt: Money, account_id: string | null, category: string | null, purpose: Txn['purpose'] = 'spend',
  extra: Partial<Txn> = {}): Txn => ({
  id: id(), day: day(offset), occurred_at: day(offset) + 'T1' + (Math.abs(offset) % 10) + ':24:00Z', amount: amt,
  direction: purpose === 'income' || purpose === 'repaid' || purpose === 'reimbursement' ? 'credit' : 'debit', merchant, category, purpose,
  confidence: 0.95, account_id, account_name: account_id ? acctName(account_id) : null, member_id: 'm1', note: null, source: 'sms', person: null, split_mine: null,
  claim_id: null, commitment_id: null, ...extra,
});
const txns: Txn[] = [
  T(0, 'Panda Retail', SAR(186.4), 'a1', 'Groceries'),
  T(0, 'Starbucks', SAR(24), 'a2', 'Dining'),
  T(0, 'Uber', SAR(38.5), 'a2', 'Transport', 'spend', { confidence: 0.55 }),
  T(-1, 'Aldrees Petrol', SAR(120), 'a3', 'Fuel', 'spend', { split_mine: SAR(60), person: { kind: 'contact', id: 'c3', name: 'Sameer Khan' } }),
  T(-1, 'Al Baik', SAR(64), 'a2', 'Dining'),
  T(-1, 'Nahdi Pharmacy', SAR(92.75), 'a1', 'Health'),
  T(-2, 'SNB card payment', SAR(4000), 'a1', 'Transfer', 'transfer'),
  T(-2, 'Amazon.sa', SAR(349), 'a2', 'Shopping', 'spend', { confidence: 0.6 }),
  T(-3, 'Marriott Jeddah', SAR(1840), 'a2', 'Travel', 'claim', { claim_id: 'cl1' }),
  T(-3, 'Careem', SAR(212), 'a2', 'Transport', 'claim', { claim_id: 'cl1' }),
  T(-4, 'Saudia Airlines', SAR(860), 'a2', 'Travel', 'claim', { claim_id: 'cl1' }),
  T(-4, 'Netflix', SAR(65), 'a2', 'Subscriptions', 'spend', { split_mine: SAR(21.66), commitment_id: 'k3' }),
  T(-5, 'Swiggy', INR(640), 'a6', 'Dining', 'spend', { member_id: 'm3', confidence: 0.5 }),
  T(-5, 'Tamimi Markets', SAR(412.3), 'a1', 'Groceries'),
  T(-6, 'Remitly to HDFC NRE', SAR(5000), 'a1', 'Transfer', 'transfer'),
  T(-6, 'HDFC NRE credit', INR(117100), 'a4', 'Transfer', 'transfer', { direction: 'credit' }),
  T(-7, 'Rahul Nair', SAR(150), 'a1', null, 'lend', { person: { kind: 'contact', id: 'c1', name: 'Rahul Nair' } }),
  T(-8, 'SEC electricity', SAR(386), 'a1', 'Utilities', 'spend', { confidence: 0.62 }),
  T(-9, 'IKEA', SAR(1249), 'a2', 'Home'),
  T(-10, 'Card interest', SAR(84.2), 'a2', 'Fees & interest', 'fee'),
  T(-11, 'STC fibre', SAR(299), 'a1', 'Utilities', 'spend', { commitment_id: 'k6' }),
  T(-12, 'Big Bazaar Kochi', INR(4380), 'a6', 'Groceries', 'spend', { confidence: 0.58 }),
  T(-14, 'Claude Pro', SAR(75), 'a2', 'Subscriptions'),
  T(-16, 'Jarir Bookstore', SAR(218), 'a2', 'Education', 'spend', { confidence: 0.52 }),
  T(-18, 'HDFC home loan EMI', INR(39500), 'a4', 'Loan EMI', 'loan_payment', { commitment_id: 'k4' }),
  T(-21, 'Amma — monthly', INR(25000), 'a5', 'Family', 'support', { person: { kind: 'member', id: 'm3', name: 'Amma' }, commitment_id: 'k2' }),
  T(-21, 'Achan — medicines', INR(8000), 'a5', 'Family', 'support', { person: { kind: 'member', id: 'm4', name: 'Achan' } }),
  T(-22, 'Kochi flat — 9th slab', INR(650000), 'a4', 'Home', 'asset'),
  T(-27, 'Salary — Nov', SAR(26000), 'a1', 'Salary', 'income'),
  T(-30, 'Danube', SAR(268), 'a1', 'Groceries'),
  T(-33, 'Hyper Panda', SAR(301), 'a1', 'Groceries'),
  T(-36, 'Nando’s', SAR(142), 'a2', 'Dining'),
  T(-3, 'Hyper Panda — house shop', SAR(486), 'a1', 'Groceries', 'spend', { split_mine: SAR(243), person: { kind: 'contact', id: 'c5', name: 'Rohan' } }),
  T(-9, 'Jahez — dinner at home', SAR(132), 'a2', 'Dining', 'spend', { split_mine: SAR(66), person: { kind: 'contact', id: 'c5', name: 'Rohan' } }),
  T(-13, 'Rohan — Patrol EMI share', SAR(1350), 'a1', null, 'lend', { person: { kind: 'contact', id: 'c5', name: 'Rohan' } }),
  T(-20, 'Transfer from Rohan', SAR(800), 'a1', null, 'repaid', { person: { kind: 'contact', id: 'c5', name: 'Rohan' } }),
];
// who else carries part of a split payment: txn id -> the other people's shares
const splits: Record<string, { member_id: string | null; contact_id: string | null; share_minor: number }[]> = {};
for (const t of txns) if (t.split_mine && t.person) splits[t.id] = [{ member_id: t.person.kind === 'member' ? t.person.id : null,
  contact_id: t.person.kind === 'contact' ? t.person.id : null, share_minor: t.amount.minor - t.split_mine.minor }];
// Last month is a busy one (over 300 rows), so Activity's paging (200 a page) and its server-side day totals get exercised.
{
  const shops: [string, string, string][] = [['Panda Retail', 'Groceries', 'a1'], ['Al Baik', 'Dining', 'a2'], ['Uber', 'Transport', 'a2'], ['Aldrees Petrol', 'Fuel', 'a3'], ['Starbucks', 'Dining', 'a2'], ['Nahdi Pharmacy', 'Health', 'a1']];
  for (let i = 0; i < 320; i++) {
    const [m, c, a] = shops[i % shops.length], d = onDay(-1, 1 + (i % 28));
    txns.push(T(0, m, SAR(12 + (i * 37) % 180), a, c, 'spend', { day: d, occurred_at: `${d}T${pad(8 + (i % 12))}:${pad(i % 60)}:00Z` }));
  }
}
// Trips: the Doha project trip (QAR; the hotel and a client dinner only partly claimed), a finished Dubai workshop,
// the Jeddah visit happening now (so Home shows "Current trip") and last year's family trip home.
const AED = (v: number): Money => ({ minor: Math.round(v * 100), currency: 'AED' });
const QAR = (v: number): Money => ({ minor: Math.round(v * 100), currency: 'QAR' });
const SAR_PER: Record<string, number> = { SAR: 1, QAR: 3.75 / 3.64, AED: 3.75 / 3.6725, INR: 1 / 24.9 };
const conv = (minor: number, from: string, to: string) => minor * SAR_PER[from] / SAR_PER[to];
const tripStatus: Record<string, TripStatus> = {};
const claimPart: Record<string, number> = {}; // txn id -> claimed minor, when the claim covers only part of the bill
const tripOwn: Record<string, string[]> = {};
type TripRow = [string, string, Money, string, TripStatus, number?];
const addTrip = (trip: string, claim: string, account: string, rows: TripRow[]) => {
  for (const [d, merchant, amt, cat, st, part] of rows) {
    const t = T(0, merchant, amt, account, cat, st === 'claimed' ? 'claim' : 'spend', { day: d, occurred_at: d + 'T12:00:00Z', claim_id: st === 'claimed' ? claim : null });
    txns.push(t); tripStatus[t.id] = st; (tripOwn[trip] ||= []).push(t.id);
    if (part !== undefined) claimPart[t.id] = Math.round(part * 100);
  }
};
addTrip('t3', 'cl4', 'a2', [
  ['2026-11-08', 'Qatar Airways — RUH to DOH', SAR(1265), 'Travel', 'claimed'], ['2026-11-08', 'Karwa taxi — airport', QAR(68), 'Transport', 'claimed'],
  ['2026-11-08', 'Marriott Marquis West Bay — 4 nights', QAR(2960), 'Travel', 'claimed', 2600],
  ['2026-11-09', 'Starbucks — Lusail', QAR(31), 'Dining', 'personal'], ['2026-11-09', 'Uber — Lusail site', QAR(42), 'Transport', 'claimed'],
  ['2026-11-10', 'Client dinner — Nobu Doha', QAR(412), 'Dining', 'claimed', 380], ['2026-11-10', 'Ooredoo — travel SIM', QAR(100), 'Telecom & Internet', 'missed'],
  ['2026-11-11', 'Villaggio — Zara', QAR(389), 'Shopping', 'personal'], ['2026-11-11', 'Talabat', QAR(58), 'Dining', 'unreviewed'],
  ['2026-11-12', 'Uber — Hamad airport', QAR(47), 'Transport', 'claimed'], ['2026-11-12', 'Qatar Duty Free', QAR(145), 'Shopping', 'unreviewed'],
  ['2026-11-12', 'Intl. transaction fee + VAT', SAR(96.6), 'Fees & interest', 'personal'],
]);
for (const x of txns) if (x.merchant === 'Intl. transaction fee + VAT') x.purpose = 'fee';
addTrip('t1', 'cl3', 'a2', [
  ['2026-10-12', 'Emirates — RUH to DXB', AED(1450), 'Travel', 'claimed'], ['2026-10-12', 'Careem DXB airport', AED(96), 'Transport', 'claimed'],
  ['2026-10-13', 'Address Downtown — 4 nights', AED(3820), 'Travel', 'claimed', 3400], ['2026-10-13', 'Client lunch — Zuma', AED(640), 'Dining', 'claimed'],
  ['2026-10-14', 'RTA Metro Nol top-up', AED(50), 'Transport', 'missed'], ['2026-10-14', 'Dubai Mall — Bath & Body Works', AED(285), 'Shopping', 'personal'],
  ['2026-10-15', 'Careem — DIFC office', AED(72), 'Transport', 'missed'], ['2026-10-15', 'Team dinner — Ravi Restaurant', AED(210), 'Dining', 'claimed'],
  ['2026-10-16', 'Dubai Duty Free', AED(168), 'Shopping', 'unreviewed'],
]);
addTrip('t4', '', 'a6', [
  ['2025-08-30', 'Air India Express — DMM to COK', INR(18450), 'Travel', 'personal'], ['2025-09-01', 'Lulu Mall Kochi', INR(6820), 'Shopping', 'personal'],
  ['2025-09-03', 'Uber', INR(640), 'Transport', 'personal'], ['2025-09-05', 'Zomato', INR(1180), 'Dining', 'personal'],
]);
const trips: Trip[] = ([
  { id: 't3', name: 'Doha — Lusail project', city: 'Doha', country: 'QA', start_on: '2026-11-08', end_on: '2026-11-12', kind: 'business', claim_ids: ['cl4'], currency: 'QAR' },
  { id: 't1', name: 'Dubai — client workshop', city: 'Dubai', country: 'AE', start_on: '2026-10-12', end_on: '2026-10-16', kind: 'business', claim_ids: ['cl3'], currency: 'AED' },
  { id: 't2', name: 'Jeddah site visit', city: 'Jeddah', country: 'SA', start_on: day(-4), end_on: day(1), kind: 'business', claim_ids: ['cl1'], currency: 'SAR' },
  { id: 't4', name: 'Kochi — Onam at home', city: 'Kochi', country: 'IN', start_on: '2025-08-30', end_on: '2025-09-07', kind: 'personal', claim_ids: [], currency: 'INR' },
] as Omit<Trip, 'totals' | 'count' | 'by_category' | 'by_day'>[]).map(t => ({ ...t, totals: null!, count: 0, by_category: [], by_day: [] }));
const tripTxns = (t: Trip) => txns.filter(x => tripOwn[t.id] ? tripOwn[t.id].includes(x.id)
  : x.day >= t.start_on && x.day <= t.end_on && (t.id !== 't2' || (x.account_id === 'a2' && !x.commitment_id)));
const statusOf = (x: Txn): TripStatus => tripStatus[x.id] || (x.claim_id ? 'claimed' : 'unreviewed');
const claimedOf = (x: Txn) => statusOf(x) === 'claimed' ? claimPart[x.id] ?? x.amount.minor : 0;
const tripOut = (t: Trip): Trip => {
  const xs = tripTxns(t), cur = t.currency, m = (v: number): Money => ({ minor: Math.round(v), currency: cur });
  const tot = { total: 0, spent: 0, claimed: 0, burden: 0, personal: 0, missed: 0, unreviewed: 0, fees: 0,
    reimbursed: claims.filter(c => t.claim_ids.includes(c.id)).reduce((a, c) => a + conv(c.received.minor, c.received.currency, cur), 0) };
  const cats = new Map<string, number[]>(), days = new Map<string, number[]>();
  for (const x of xs) {
    const st = statusOf(x), a = conv(x.amount.minor, x.amount.currency, cur), p = conv(claimedOf(x), x.amount.currency, cur);
    if (st === 'excluded') continue;
    if (x.purpose === 'fee') tot.fees += a;
    tot.total += a; tot.spent += a; tot.claimed += p; tot.burden += a - p;
    if (st !== 'claimed') tot[st] += a;
    for (const [g, k] of [[cats, x.category || 'Uncategorized'], [days, x.day]] as const) { const v = g.get(k) || [0, 0, 0]; g.set(k, [v[0] + a, v[1] + p, v[2] + a - p]); }
  }
  const trio = (v: number[]) => ({ spent: m(v[0]), claimed: m(v[1]), burden: m(v[2]) });
  return { ...t, count: xs.length, totals: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, m(v)])) as Trip['totals'],
    by_category: [...cats].sort((a, b) => b[1][0] - a[1][0]).map(([category, v]) => ({ category, ...trio(v) })),
    by_day: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, ...trio(v) })) };
};
const tripExpense = (t: Trip, x: Txn) => {
  const c = claimedOf(x), cur = t.currency, m = (v: number): Money => ({ minor: Math.round(v), currency: cur });
  return { ...x, trip_status: statusOf(x), claimed: { minor: c, currency: x.amount.currency }, burden: { minor: x.amount.minor - c, currency: x.amount.currency },
    claimed_trip: m(conv(c, x.amount.currency, cur)), burden_trip: m(conv(x.amount.minor - c, x.amount.currency, cur)) };
};

const review = (): ReviewTxn[] => txns.filter(t => t.confidence < 0.7).map(t => ({
  ...t, suggestions: t.merchant === 'Uber' ? [
    { purpose: 'claim', category: 'Transport', person: null, label: 'Work trip — claim it' },
    { purpose: 'spend', category: 'Transport', person: null, label: 'Personal ride' },
  ] : t.merchant === 'Swiggy' ? [
    { purpose: 'support', category: 'Family', person: { kind: 'member', id: 'm3', name: 'Amma' }, label: 'For Amma' },
    { purpose: 'spend', category: 'Dining', person: null, label: 'My food order' },
  ] : t.merchant === 'SEC electricity' ? [
    { purpose: 'spend', category: 'Utilities', person: null, label: 'Electricity bill' },
    { purpose: 'spend', category: 'Utilities', person: { kind: 'contact', id: 'c2', name: 'Imran Shaikh' }, label: 'Split with Imran' },
  ] : [
    { purpose: 'spend', category: t.category, person: null, label: t.category || 'Shopping' },
    { purpose: 'lend', category: null, person: { kind: 'contact', id: 'c1', name: 'Rahul Nair' }, label: 'Paid for Rahul' },
    { purpose: 'claim', category: t.category, person: null, label: 'Company claim' },
  ],
}));

const liabilities: Liability[] = [
  { id: 'l1', kind: 'loan', name: 'Home loan', lender: 'HDFC Bank', currency: 'INR', principal: INR(4500000), outstanding: INR(3862000), rate_bp: 865,
    emi: INR(39500), due_day: 5, start_on: '2023-04-05', end_on: '2043-03-05', paid_pct: 14, payoff_month: '2041-03', interest_month: INR(27840), account_id: 'a7', contact_id: null },
  { id: 'l2', kind: 'loan', name: 'Camry auto finance', lender: 'Al Rajhi Bank', currency: 'SAR', principal: SAR(96000), outstanding: SAR(41200), rate_bp: 450,
    emi: SAR(2150), due_day: 28, start_on: '2023-07-28', end_on: '2028-06-28', paid_pct: 57, payoff_month: '2028-06', interest_month: SAR(155), account_id: 'a8', contact_id: null },
  { id: 'l3', kind: 'credit_card', name: 'SNB Platinum', lender: 'SNB', currency: 'SAR', principal: SAR(6850), outstanding: SAR(6850), rate_bp: 2700,
    emi: SAR(1200), due_day: 18, start_on: null, end_on: null, paid_pct: 0, payoff_month: ym(6), interest_month: SAR(154), account_id: 'a2', contact_id: null },
  // Rohan's personal loan pays for the shared Patrol: the list shows my 50%; `shared` has the whole loan
  { id: 'l5', kind: 'loan', name: 'Patrol loan (Rohan’s name)', lender: 'Al Rajhi Bank', currency: 'SAR', principal: SAR(30000), opening_balance: SAR(30000), outstanding: SAR(21900), rate_bp: 0,
    emi: SAR(2700), due_day: 27, start_on: '2026-03-27', end_on: '2027-02-27', paid_pct: 27, payoff_month: '2027-07', interest_month: SAR(0), account_id: null, contact_id: null,
    holder_contact_id: 'c5', my_share_pct: 50,
    shared: { holder: { id: 'c5', name: 'Rohan' }, loan_principal: SAR(60000), loan_opening_balance: SAR(60000), loan_emi: SAR(5400), sent_this_month: false, sent_txn_id: null } },
  { id: 'l4', kind: 'bnpl', name: 'Tabby — Extra', lender: 'Tabby', currency: 'SAR', principal: SAR(1200), outstanding: SAR(900), rate_bp: 0,
    emi: SAR(300), due_day: 12, start_on: day(-40), end_on: day(50), paid_pct: 25, payoff_month: ym(2), interest_month: SAR(0), account_id: 'a9', contact_id: null },
];

const C = (cid: string, name: string, kind: string, amount: Money, cycle: number, next_due: string, status: Commitment['status'], extra: Partial<Commitment> = {}): Commitment => ({
  id: cid, name, kind, amount, cycle_months: cycle, next_due, end_on: null, country: amount.currency === 'INR' ? 'IN' : 'SA', match_pattern: null,
  account_id: null, liability_id: null, asset_id: null, for_member_id: null, shares: [], status, last_paid: status === 'paid' ? { day: day(-10), txn_id: txns[0].id } : null,
  fund_id: null, ...extra,
});
const commitments: Commitment[] = [
  C('k1', 'Riyadh flat rent', 'rent', SAR(21000), 6, onDay(2, 15), 'upcoming', { fund_id: 'f1' }),
  C('k2', 'Amma — monthly support', 'support', INR(25000), 1, onDay(1, 1), 'paid', { for_member_id: 'm3' }),
  C('k3', 'Netflix Premium', 'subscription', SAR(65), 1, onDay(1, 19), 'paid', { shares: [
    { contact_id: 'c1', name: 'Rahul', share: SAR(21.67), paid_this_cycle: true },
    { contact_id: 'c2', name: 'Imran', share: SAR(21.67), paid_this_cycle: false }] }),
  C('k4', 'HDFC home loan EMI', 'emi', INR(39500), 1, onDay(1, 5), 'paid', { liability_id: 'l1' }),
  C('k5', 'Camry EMI', 'emi', SAR(2150), 1, day(5), 'due', { liability_id: 'l2' }),
  C('k6', 'STC fibre', 'bill', SAR(299), 1, onDay(1, 12), 'paid'),
  C('k7', 'SEC electricity', 'bill', SAR(386), 1, day(2), 'due'),
  C('k8', 'KSEB — Kochi', 'bill', INR(2400), 1, day(-2), 'overdue'),
  C('k9', 'Aarav school fees', 'school', SAR(7800), 3, onDay(1, 5), 'upcoming', { fund_id: 'f3' }),
  C('k10', 'Tawuniya car insurance', 'insurance', SAR(3200), 12, onDay(4, 1), 'upcoming'),
  C('k11', 'Claude Pro', 'subscription', SAR(75), 1, onDay(1, 9), 'paid'),
  C('k12', 'Kochi flat — 10th slab', 'milestone', INR(650000), 0, onDay(2, 10), 'upcoming', { asset_id: 'as1', fund_id: 'f4' }),
  C('k13', 'Achan — medicines', 'support', INR(5000), 1, onDay(1, 1), 'paid', { for_member_id: 'm4' }),
];
let detected: DetectedCommitment[] = [
  { ...C('', 'Spotify Family', 'subscription', SAR(26.99), 1, onDay(1, 3), 'upcoming'), evidence_txn_ids: [] },
  { ...C('', 'Jio postpaid', 'bill', INR(599), 1, onDay(1, 8), 'upcoming'), evidence_txn_ids: [] },
  { ...C('', 'Fitness Time', 'subscription', SAR(199), 1, onDay(1, 2), 'upcoming'), evidence_txn_ids: [] },
];

const funds: Fund[] = [
  { id: 'f1', name: 'January rent', target: SAR(21000), due_on: onDay(2, 15), saved: SAR(14000), monthly: SAR(3500), on_track: true, commitment_id: 'k1' },
  { id: 'f2', name: 'Flights home — Onam', target: SAR(6000), due_on: onDay(9, 1), saved: SAR(1400), monthly: SAR(575), on_track: false, commitment_id: null },
  { id: 'f3', name: 'School fees', target: SAR(7800), due_on: onDay(1, 5), saved: SAR(5200), monthly: SAR(2600), on_track: true, commitment_id: 'k9' },
  { id: 'f4', name: 'Flat — 10th slab', target: INR(650000), due_on: onDay(2, 10), saved: INR(410000), monthly: INR(120000), on_track: true, commitment_id: 'k12' },
  { id: 'f6', name: 'House groceries (rent pot)', target: SAR(0), due_on: '2026-05-01', saved: SAR(420), monthly: SAR(0), on_track: true, commitment_id: null, pot: {
    tenant: { id: 'c6', name: 'Faisal (tenant)' }, rent: SAR(1000), rent_from: '2026-05-01', match_pattern: 'faisal', received: SAR(6000), spent: SAR(5580), balance: SAR(420), from_pocket: SAR(0),
    mine: { share_pct: 50, part: SAR(0) }, shares: [{ member_id: null, contact_id: 'c5', name: 'Rohan', share_pct: 50, part: SAR(0), owes_you: SAR(0) }],
    pending_months: [ym(0)], rent_due: SAR(1000), waived_months: [] } },
  { id: 'f5', name: 'Emergency fund', target: SAR(60000), due_on: onDay(14, 1), saved: SAR(32000), monthly: SAR(2000), on_track: true, commitment_id: null },
];

const M = (name: string, due_on: string, amount: number, paid: boolean) => ({ id: id(), name, due_on, amount: INR(amount), paid });
const assets: Asset[] = [
  { id: 'as1', kind: 'property', name: 'Riverside Residences 3BHK', currency: 'INR', cost: INR(9200000), value: INR(9800000), paid: INR(5150000),
    financed: INR(3300000), remaining: INR(4050000),
    milestones: [M('Booking', '2023-02-14', 920000, true), M('Agreement', '2023-04-01', 1380000, true), M('Foundation', '2024-01-10', 920000, true),
      M('5th slab', '2025-03-20', 650000, true), M('9th slab', day(-22), 650000, true), M('10th slab', onDay(2, 10), 650000, false),
      M('Brickwork', onDay(7, 1), 920000, false), M('Flooring & finishes', onDay(13, 1), 920000, false), M('Handover', onDay(18, 1), 910000, false)],
    next_milestone: null, monthly_cost: INR(42300), my_monthly_cost: INR(42300),
    costs_by_type: { 'Loan EMI': INR(39500), Maintenance: INR(0), 'Property tax': INR(800), Insurance: INR(2000) }, sharers: [], liability_id: 'l1',
    details: { builder: 'Riverside Developers', bought_on: '2023-02-14', area_sqft: 1420, City: 'Kochi, Kerala', Possession: 'Mar 2028',
      market_value: { minor: 980000000, as_of: day(-12), source: '₹6,900 a sq ft × 1,420 sq ft, resale listings in the project' } },
    status: 'owned', under_construction: true,
    valuation: { value: INR(9800000), as_of: day(-12), basis: 'market', note: '₹6,900 a sq ft × 1,420 sq ft, resale listings in the project', depreciation_pct: 15, bought_on: '2023-02-14' },
    funding: { own: INR(5150000), loan: INR(3300000), interest: INR(486000), cost_to_date: INR(8936000),
      own_sources: [{ name: 'Canara savings', amount: INR(3300000) }, { name: 'Cash or not linked to a payment', amount: INR(1850000) }] },
    verdict: { cost: INR(8936000), gain: INR(864000), fd_gain: INR(1218000), edge: INR(-354000), net_cost: INR(-864000), annual_pct: 4.6, fd_rate_bp: 700, provisional: true, tone: 'warn',
      text: 'Provisional, still under construction: okay, not great: up INR 864,000 (+4.6% a year), but a 7% FD on the same money would have earned INR 1,218,000, INR 354,000 more. An unfinished flat\'s value is an estimate and stages are still to pay, so this can change a lot by handover.',
      assumptions: ['Value INR 9,800,000 on ' + day(-12) + ' (₹6,900 a sq ft × 1,420 sq ft, resale listings in the project)', 'Cost counts your own money, the loan\'s payouts and interest paid, each from the day it went in',
        'The FD pays 7% a year, compounded yearly, before tax', 'Leaves out rent saved or earned, tax benefits and selling costs unless you add them as costs'] } },
  { id: 'as2', kind: 'vehicle', name: 'Toyota Camry 2023', currency: 'SAR', cost: SAR(118000), value: SAR(92000), paid: SAR(54800), financed: SAR(96000),
    remaining: SAR(41200), milestones: [], next_milestone: null, monthly_cost: SAR(3237), my_monthly_cost: SAR(2917),
    costs_by_type: { Fuel: SAR(640), Service: SAR(180), Insurance: SAR(267), 'Loan EMI': SAR(2150) },
    sharers: [{ cost_type: 'Fuel', name: 'Sameer Khan', contact_id: 'c3', share_pct: 50 }], liability_id: 'l2',
    details: { builder: 'Toyota', bought_on: '2023-07-28', Plate: 'RUH 4821', Odometer: '38,420 km', 'Next service': 'Jan 2027', Insurance: 'Tawuniya, renews Mar' },
    status: 'owned', valuation: { value: SAR(92000), as_of: day(0), basis: 'depreciation', note: '15% a year since 2023-07-28', depreciation_pct: 15, bought_on: '2023-07-28' },
    funding: { own: SAR(22000), loan: SAR(96000), interest: SAR(9800), cost_to_date: SAR(127800), own_sources: [{ name: 'Al Rajhi current', amount: SAR(22000) }] },
    verdict: { cost: SAR(127800), gain: SAR(-35800), fd_gain: SAR(21400), edge: SAR(-57200), net_cost: SAR(54100), annual_pct: -10.2, fd_rate_bp: 500, provisional: false, tone: 'bad',
      text: 'Worth about SAR 92,000 against SAR 127,800 paid with interest: SAR 35,800 less (-10.2% a year). With SAR 18,300 of running costs, owning it has cost you SAR 54,100 net. The same money in a 5% FD would have earned SAR 21,400.',
      assumptions: ['Value SAR 92,000 on ' + day(0) + ' (15% a year since 2023-07-28)', 'Cost counts your own money, the loan\'s payouts and interest paid, each from the day it went in',
        'The FD pays 5% a year, compounded yearly, before tax', 'Leaves out rent saved or earned, tax benefits and selling costs unless you add them as costs'] } },
  { id: 'as5', kind: 'vehicle', name: 'Toyota Fortuner 2024', currency: 'SAR', cost: SAR(152000), value: SAR(80000), paid: SAR(12000), financed: SAR(140000),
    remaining: SAR(0), milestones: [], next_milestone: null, monthly_cost: SAR(0), my_monthly_cost: SAR(0), costs_by_type: {}, sharers: [], liability_id: null,
    cost_totals: { fuel: SAR(4200), service: SAR(900) }, cost_total: SAR(5100), my_cost_total: SAR(5100), costs: [],
    details: { builder: 'Toyota', bought_on: '2025-01-12', disposal: { status: 'written_off', on: '2026-06-03', proceeds_minor: 8000000, note: 'Tawuniya payout after the accident' } },
    status: 'written_off', valuation: { value: SAR(80000), as_of: '2026-06-03', basis: 'written_off', note: 'Tawuniya payout after the accident', depreciation_pct: 15, bought_on: '2025-01-12' },
    funding: { own: SAR(12000), loan: SAR(140000), interest: SAR(11200), cost_to_date: SAR(163200), own_sources: [{ name: 'Al Rajhi current', amount: SAR(12000) }] },
    verdict: { cost: SAR(163200), gain: SAR(-83200), fd_gain: SAR(11100), edge: SAR(-94300), net_cost: SAR(88300), annual_pct: -40.1, fd_rate_bp: 500, provisional: false, tone: 'bad',
      text: 'Written off: it cost SAR 163,200 with interest and brought back SAR 80,000, a loss of SAR 83,200 (-40.1% a year). With SAR 5,100 of running costs, owning it has cost you SAR 88,300 net. The same money in a 5% FD would have earned SAR 11,100.',
      assumptions: ['Value SAR 80,000 on 2026-06-03 (Tawuniya payout after the accident)', 'Cost counts your own money, the loan\'s payouts and interest paid, each from the day it went in',
        'The FD pays 5% a year, compounded yearly, before tax', 'Leaves out rent saved or earned, tax benefits and selling costs unless you add them as costs'] } },
  { id: 'as3', kind: 'investment', name: 'HDFC NRE fixed deposit', currency: 'INR', cost: INR(500000), value: INR(538400), paid: INR(500000), financed: INR(0),
    remaining: INR(0), milestones: [], next_milestone: null, monthly_cost: INR(0), my_monthly_cost: INR(0), costs_by_type: {}, sharers: [], liability_id: null,
    details: { Rate: '7.10%', Matures: 'Aug 2027', 'Tax': 'Tax-free (NRE)' } },
  { id: 'as4', kind: 'investment', name: 'Parag Parikh Flexi Cap SIP', currency: 'INR', cost: INR(240000), value: INR(291600), paid: INR(240000), financed: INR(0),
    remaining: INR(0), milestones: [], next_milestone: null, monthly_cost: INR(10000), my_monthly_cost: INR(10000), costs_by_type: { SIP: INR(10000) }, sharers: [], liability_id: null,
    details: { 'Monthly SIP': '₹10,000', Since: 'Dec 2024', Return: '+21.5%' } },
];
assets[0].next_milestone = assets[0].milestones.find(m => !m.paid) || null;

// The shared Patrol (Rohan pays some costs himself: "Rohan paid") and the rented Riyadh flat (a place: rent, bills, the rent pot).
const cost = (offset: number, merchant: string, cost_type: string, amount: number, extra: Partial<NonNullable<Asset['costs']>[number]> = {}) =>
  ({ txn_id: id(), day: day(offset), merchant, cost_type, amount: SAR(amount), paid_by: null, auto: false, from_pot: false, ...extra });
const patrolCosts = [cost(-2, 'Aldrees', 'fuel', 240), cost(-6, 'Petromin', 'fuel', 210, { paid_by: 'Rohan' }), cost(-15, 'Nissan Abdul Latif Jameel', 'service', 1180),
  cost(-24, 'Aldrees', 'fuel', 230, { paid_by: 'Rohan' }), cost(-38, 'Tawuniya', 'insurance', 2600), cost(-41, 'Saher fine', 'other', 300, { paid_by: 'Rohan' }),
  cost(-52, 'Aldrees', 'fuel', 225), cost(-66, 'Al Jomaih tyres', 'repairs', 1640, { paid_by: 'Rohan' })];
const homeCosts = [cost(-1, 'SEC electricity', 'electricity', 412, { auto: true }), cost(-3, 'Panda', 'groceries', 286, { from_pot: true }),
  cost(-9, 'STC fibre', 'internet', 299, { auto: true }), cost(-12, 'Maid — Musaned', 'maid', 900), cost(-19, 'IKEA', 'furnishing', 1249),
  cost(-33, 'SEC electricity', 'electricity', 455, { auto: true }), cost(-36, 'Danube', 'groceries', 268, { from_pot: true }), cost(-41, 'STC fibre', 'internet', 299, { auto: true }),
  cost(-62, 'SEC electricity', 'electricity', 520, { auto: true }), cost(-70, 'Riyadh flat rent', 'rent', 21000, { auto: true })];
const byType = (cs: typeof patrolCosts) => cs.reduce((o, c) => ({ ...o, [c.cost_type]: SAR((o[c.cost_type]?.minor || 0) / 100 + c.amount.minor / 100) }), {} as Record<string, Money>);
const byMonth = (cs: typeof patrolCosts, myPct: number) => [...new Set(cs.map(c => c.day.slice(0, 7)))].sort().map(m => {
  const t = cs.filter(c => c.day.startsWith(m)).reduce((x, c) => x + c.amount.minor, 0); return { month: m, total: SAR(t / 100), mine: SAR(t * myPct / 10000) }; });
const sum = (cs: typeof patrolCosts) => cs.reduce((x, c) => x + c.amount.minor, 0) / 100;
assets.splice(2, 0,
  { id: 'as6', kind: 'vehicle', name: 'Nissan Patrol 2021', currency: 'SAR', cost: SAR(145000), value: SAR(118000), paid: SAR(145000), financed: SAR(0), remaining: SAR(0),
    milestones: [], next_milestone: null, monthly_cost: SAR(1830), my_monthly_cost: SAR(3615), costs_by_type: { fuel: SAR(445), service: SAR(393), insurance: SAR(867) },
    sharers: [{ id: 'sh1', cost_type: '*', name: 'Rohan', contact_id: 'c5', share_pct: 50 }], liability_id: null,
    costs: patrolCosts, cost_totals: byType(patrolCosts), cost_total: SAR(sum(patrolCosts)), my_cost_total: SAR(sum(patrolCosts) / 2), cost_by_month: byMonth(patrolCosts, 50),
    sharer_totals: [{ member_id: null, contact_id: 'c5', name: 'Rohan', amount: SAR(sum(patrolCosts) / 2), net_owes_you: SAR(-(210 + 230 + 300 + 1640) / 2 + (240 + 1180 + 2600 + 225) / 2) }],
    details: { builder: 'Nissan', bought_on: '2026-03-20', Plate: 'RUH 7713', 'Paid with': 'Rohan’s personal loan, EMI split 50/50' },
    status: 'owned', valuation: { value: SAR(118000), as_of: day(0), basis: 'depreciation', note: '15% a year since 2026-03-20', depreciation_pct: 15, bought_on: '2026-03-20' } },
  { id: 'as7', kind: 'home', name: 'Riyadh flat (Al Olaya)', currency: 'SAR', cost: SAR(0), value: SAR(0), paid: SAR(0), financed: SAR(0), remaining: SAR(0),
    milestones: [], next_milestone: null, monthly_cost: SAR(4870), my_monthly_cost: SAR(2435), costs_by_type: { rent: SAR(3500), electricity: SAR(462), internet: SAR(299), maid: SAR(300) },
    sharers: [{ id: 'sh2', cost_type: '*', name: 'Rohan', contact_id: 'c5', share_pct: 50 }], liability_id: null,
    costs: homeCosts, cost_totals: byType(homeCosts), cost_total: SAR(sum(homeCosts)), my_cost_total: SAR((sum(homeCosts) - 286 - 268) / 2 + 277), cost_by_month: byMonth(homeCosts, 50),
    sharer_totals: [{ member_id: null, contact_id: 'c5', name: 'Rohan', amount: SAR((sum(homeCosts) - 286 - 268) / 2), net_owes_you: SAR(1162) }],
    details: { builder: 'Al Olaya Towers', auto_tag: { currency: 'SAR', country: 'SA', categories: { 'Rent & EMI': 'rent', 'Bills & Utilities': 'utilities', 'Telecom & Internet': 'internet', Groceries: 'groceries' } }, fund_id: 'f6' },
    status: 'owned', verdict: undefined, rent: [], pot: { fund_id: 'f6', name: 'House groceries (rent pot)', ...funds.find(f => f.id === 'f6')!.pot! },
    auto_tag: { currency: 'SAR', country: 'SA', categories: { 'Rent & EMI': 'rent', 'Bills & Utilities': 'utilities', 'Telecom & Internet': 'internet', Groceries: 'groceries' } } });
commitments[0].asset_id = 'as7';
assets.find(a => a.id === 'as7')!.rent = [commitments[0]];

const claims: Claim[] = [
  { id: 'cl1', name: 'Jeddah site visit', payer: 'Company', status: 'submitted', member_id: 'm1', items: txns.filter(t => t.claim_id === 'cl1'),
    expected: SAR(2912), received: SAR(0), age_days: 3, submitted_on: day(-2) },
  { id: 'cl4', name: 'Doha — Lusail project', payer: 'Company', status: 'submitted', member_id: 'm1', items: txns.filter(t => t.claim_id === 'cl4'),
    expected: QAR(4364.89), received: QAR(0), age_days: 9, submitted_on: '2026-11-14' },
  { id: 'cl3', name: 'Dubai workshop — Oct', payer: 'Company', status: 'paid', member_id: 'm1', items: txns.filter(t => t.claim_id === 'cl3'),
    expected: AED(5796), received: AED(5796), age_days: 36, submitted_on: '2026-10-18' },
  { id: 'cl2', name: 'Client dinner — Oct', payer: 'Company', status: 'paid', member_id: 'm1', items: [], expected: SAR(640), received: SAR(640), age_days: 34, submitted_on: day(-34) },
];

const people = (): Person[] => [
  ...members.filter(m => m.relation !== 'self').map(m => ({ kind: 'member' as const, id: m.id, name: m.display_name, relation: m.relation, role: m.role, on_app: !!m.user_id,
    owes_you: [], you_owe: [], support_month: m.id === 'm3' ? INR(25000) : m.id === 'm4' ? INR(8000) : null, support_plan: m.id === 'm3' ? INR(25000) : m.id === 'm4' ? INR(5000) : null })),
  ...contacts.map(c => ({ kind: 'contact' as const, id: c.id, name: c.name, relation: c.id === 'c3' ? 'colleague' : 'friend', role: null, on_app: c.on_app,
    owes_you: ({ c1: [SAR(171.67)], c2: [SAR(21.67)], c4: [INR(4500)], c5: [SAR(1094.5)] } as Record<string, Money[]>)[c.id] || [], you_owe: c.id === 'c3' ? [SAR(120)] : [], support_month: null, support_plan: null })),
];

let settings: Settings = { salary: SAR(26000), salary_day: 27, emergency_months: 6, debt_strategy: 'avalanche', extra_to_debt_minor: 50000 };
const devices: Device[] = [
  { id: 'd1', name: 'Arjun’s iPhone', platform: 'iphone', member_id: 'm1', created_at: day(-60) + 'T09:00:00Z', last_seen: day(0) + 'T07:12:00Z' },
  { id: 'd2', name: 'Priya’s Pixel', platform: 'android', member_id: 'm2', created_at: day(-40) + 'T09:00:00Z', last_seen: day(-1) + 'T19:40:00Z' },
];

function month() {
  return {
    month: ym(0), currency: 'SAR', income: SAR(26000), spent: SAR(11240), committed_due: SAR(2830), committed_paid: SAR(6960), set_aside: SAR(5300), free: SAR(4630),
    by_category: [['Rent', 3500], ['Family', 1409], ['Groceries', 1167], ['Dining', 912], ['Utilities', 685], ['Shopping', 1598], ['Fuel', 520], ['Transport', 410], ['Subscriptions', 162], ['Fees & interest', 84]]
      .map(([c, v]) => ({ category: c as string, amount: SAR(v as number) })),
    by_purpose: [{ purpose: 'spend', amount: SAR(9747) }, { purpose: 'support', amount: SAR(1409) }, { purpose: 'fee', amount: SAR(84) }],
    owed_by_you: { loans: SAR(206102), cards: SAR(8490), bnpl: SAR(900), people: SAR(120), total: SAR(215612) },
    owed_to_you: { people: SAR(385), claims: SAR(2912), total: SAR(3297) }, interest_month: SAR(1498), fx: { SAR_INR: 24.9, at: day(0) },
    spent_by_currency: [INR(54420), SAR(8916)],
  };
}
const look = (n: number) => {
  const months = Array.from({ length: n }, (_, i) => {
    const commit = [8960, 9120, 30120, 8960, 12160, 8960, 8960, 29960, 8960, 8960, 8960, 12160][i % 12];
    const fundsV = [5300, 5300, 0, 5300, 5300, 5300, 5300, 0, 5300, 5300, 5300, 5300][i % 12];
    const funded = commit > 20000 ? 21000 : 0;
    const everyday = 4900 + (i % 3) * 180;
    const free = 26000 - (commit - funded) - fundsV - everyday;
    return { month: ym(i), income: SAR(26000), commitments: SAR(commit), funds: SAR(fundsV), everyday: SAR(everyday), free: SAR(free),
      warnings: commit > 20000 ? ['Rent due — paid from the rent fund'] : free < 1500 ? ['Tight month'] : [] };
  });
  return { months, debt_free: { month: '2039-04', months: 149 }, interest_per_month: SAR(1498) };
};

// --- tiny router ------------------------------------------------------------------------------------------------
type H = (m: RegExpMatchArray, body: any, q: URLSearchParams) => unknown;
const routes: [string, RegExp, H][] = [];
const on = (method: string, path: string, h: H) => routes.push([method, new RegExp('^' + path.replace(/\{\w+\}/g, '([^/]+)') + '$'), h]);
class Err { constructor(public status: number, public msg: string) {} }
const signedIn = () => sessionStorage.getItem('mock-signed-out') !== '1';
const me = () => ({ user, household, member: members[0], households: [{ id: household.id, name: household.name, role: 'owner' }, { id: 'h2', name: 'Menon parents', role: 'admin' }] });

on('GET', '/auth/me', () => { if (!signedIn()) throw new Err(401, 'sign in first'); return me(); });
on('POST', '/auth/login', (_m, b) => { if (b.password !== 'demo1234' && b.password?.length < 8) throw new Err(401, 'Wrong email or password'); sessionStorage.removeItem('mock-signed-out'); return { user }; });
on('POST', '/auth/signup', (_m, b) => { sessionStorage.removeItem('mock-signed-out'); localStorage.removeItem('onboarded'); user.name = b.name || user.name; return { user, household }; });
on('POST', '/auth/logout', () => { sessionStorage.setItem('mock-signed-out', '1'); return { ok: true }; });
on('POST', '/auth/forgot', () => ({ ok: true }));
on('POST', '/auth/reset', () => { sessionStorage.removeItem('mock-signed-out'); return { user }; });
on('POST', '/auth/password', (_m, b) => { if (b.current?.length < 4) throw new Err(403, 'Current password is wrong'); return { ok: true }; });
on('PATCH', '/auth/me', (_m, b) => Object.assign(user, b));
on('GET', '/invites/{t}/preview', () => ({ household_name: 'Menon family', invited_by: 'Arjun Menon', email: 'amma.menon@example.com' }));
on('GET', '/households/current', () => ({ household, members, contacts, invites }));
on('PATCH', '/households/current', (_m, b) => Object.assign(household, b));
on('POST', '/households/switch', () => me());
on('POST', '/members', (_m, b) => { const m: Member = { id: id(), display_name: b.display_name, relation: b.relation, role: b.role || 'member', user_id: null, email: b.email || null };
  members.push(m); if (b.email) { const inv = { id: id(), email: b.email, link: location.origin + '/join?t=' + id() }; invites.push(inv); return { ...m, invite: inv }; } return m; });
on('PATCH', '/members/{id}', (m, b) => { const x = members.find(x => x.id === m[1])!; const { email, ...rest } = b; Object.assign(x, rest);
  if (email && !x.user_id) { x.email = email; const inv = { id: id(), email, link: location.origin + '/join?t=' + id() }; invites.push(inv); return { ...x, invite: inv }; } return x; });
on('DELETE', '/members/{id}', m => { members.splice(members.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('POST', '/invites/{id}/resend', m => invites.find(x => x.id === m[1]));
on('DELETE', '/invites/{id}', m => { invites.splice(invites.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('POST', '/contacts', (_m, b) => { const c = { id: id(), name: b.name, email: b.email || null, phone: b.phone || null, on_app: false }; contacts.push(c); return c; });
on('PATCH', '/contacts/{id}', (m, b) => { const c = contacts.find(x => x.id === m[1])!; Object.assign(c, { ...b, email: b.email ?? c.email ?? null, phone: b.phone ?? c.phone ?? null }); return c; });
on('DELETE', '/contacts/{id}', m => { contacts.splice(contacts.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('GET', '/people', () => ({ items: people() }));
on('GET', '/shared', () => ({ items: [] }));
on('GET', '/devices', () => ({ items: devices, shortcut_url: '' }));
on('POST', '/devices', (_m, b) => { const d: Device = { id: id(), name: b.name, platform: b.platform, member_id: 'm1', created_at: new Date().toISOString(), last_seen: null };
  devices.push(d); const key = 'dk_' + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14);
  const sms_url = location.origin + '/api/ingest/sms/batch';
  return { device: d, key, sms_url, setup: JSON.stringify({ url: sms_url, key }), shortcut_url: '' }; });
on('DELETE', '/devices/{id}', m => { devices.splice(devices.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('GET', '/mcp-key', () => ({ url: location.origin + '/mcp/mk_7f3a9c21d84e4b0a' }));
on('POST', '/mcp-key', () => ({ url: location.origin + '/mcp/mk_' + Math.random().toString(16).slice(2, 18) }));

on('GET', '/accounts', () => ({ items: accounts, recent_ids: [...new Set(txns.map(t => t.account_id).filter(Boolean))] }));
on('POST', '/accounts', (_m, b) => { const a = acct(id(), b.kind, b.institution, b.name || b.institution, b.currency, b.country || 'SA', b.last4 || null, { minor: 0, currency: b.currency }); accounts.push(a); return a; });
on('PATCH', '/accounts/{id}', (m, b) => Object.assign(accounts.find(x => x.id === m[1])!, b));
const usedBy = [{ id: 'ub1', account_id: 'a2', person: { kind: 'contact', id: 'c5', name: 'Rohan' }, from: '2026-04-20', to: '2026-05-21', purpose: 'lend' as const }];
on('GET', '/accounts/{id}/used-by', m => ({ items: usedBy.filter(r => r.account_id === m[1]) }));
on('DELETE', '/accounts/{id}/used-by/{rid}', m => { usedBy.splice(usedBy.findIndex(r => r.id === m[2]), 1); return { id: m[2], deleted: true, untagged: 0 }; });
on('POST', '/accounts/{id}/used-by', (m, b) => { const xs = txns.filter(t => t.account_id === m[1] && t.direction === 'debit' && t.purpose === 'spend' && t.day >= b.from && t.day <= b.to); for (const t of xs) t.purpose = b.person.kind === 'member' ? 'support' : 'lend';
  const who = [...members.map(p => ({ id: p.id, name: p.display_name })), ...contacts].find(p => p.id === b.person.id);
  const rule = { id: id(), account_id: m[1], person: { ...b.person, name: who?.name || '' }, from: b.from, to: b.to, purpose: (b.person.kind === 'member' ? 'support' : 'lend') as 'lend' }; usedBy.push(rule);
  return { account_id: m[1], tagged: xs.length, rule }; });
on('GET', '/transactions', (_m, _b, q) => {
  let items = txns.filter(t => t.purpose !== 'ignore');
  const mo = q.get('month'); if (mo) items = items.filter(t => t.day.startsWith(mo));
  for (const k of ['account_id', 'category', 'purpose', 'member_id'] as const) { const v = q.get(k); if (v) items = items.filter(t => t[k] === v); }
  const s = q.get('q')?.toLowerCase(); if (s) items = items.filter(t => t.merchant.toLowerCase().includes(s) || (t.category || '').toLowerCase().includes(s));
  if (q.get('review')) items = items.filter(t => t.confidence < 0.7);
  items = [...items].sort((a, b) => b.day.localeCompare(a.day) || b.occurred_at.localeCompare(a.occurred_at)); // the API's order: newest day first
  const limit = Math.min(200, Number(q.get('limit')) || 50), before = q.get('before'), from = before ? items.findIndex(t => t.id === before.split('_')[1]) + 1 : 0;
  const page = items.slice(from, from + limit), more = from + limit < items.length;
  const out = { items: page, next_before: more ? `${page[page.length - 1].day}_${page[page.length - 1].id}` : null };
  if (before) return out;
  const days: Record<string, Record<string, number>> = {};
  for (const t of items) if (t.direction === 'debit' && ['spend', 'fee', 'support'].includes(t.purpose)) {
    const m = t.split_mine || t.amount; (days[t.day] ||= {})[m.currency] = (days[t.day][m.currency] || 0) + m.minor;
  }
  return { ...out, total: items.length, days: Object.fromEntries(Object.entries(days).map(([d, c]) => [d, Object.entries(c).map(([currency, minor]) => ({ minor, currency }))])) };
});
on('GET', '/transactions/{id}', m => { const t = txns.find(x => x.id === m[1]); if (!t) throw new Err(404, 'not found');
  return { ...t, raw: t.source === 'sms' ? { sender: t.account_name?.split(' ')[0].toUpperCase() || 'BANK', body: `Purchase of ${(t.amount.minor / 100).toFixed(2)} ${t.amount.currency} at ${t.merchant.toUpperCase()} with card ending ${accounts.find(a => a.id === t.account_id)?.last4 || ''}. Avl bal ...` } : null,
    links: [], splits: t.split_mine ? [{ id: 'sp1', member_id: null, contact_id: t.person?.id, name: t.person?.name, share: { ...t.amount, minor: t.amount.minor - t.split_mine.minor }, settled: false }] : [], claim: claims.filter(c => c.id === t.claim_id).map(c => ({ id: c.id, name: c.name, status: c.status }))[0] || null,
    trips: trips.filter(x => x.start_on <= t.day && t.day <= x.end_on).map(x => ({ id: x.id, name: x.name, status: 'unreviewed' })) }; });
on('PATCH', '/transactions/{id}', (m, b) => { const t = txns.find(x => x.id === m[1])!;
  const targets = b.apply_to_merchant ? txns.filter(x => x.merchant === t.merchant) : [t];
  for (const x of targets) { if (b.category !== undefined) x.category = b.category; if (b.purpose) x.purpose = b.purpose; if (b.note !== undefined) x.note = b.note;
    if (b.person) x.person = { ...b.person, name: [...members.map(p => ({ id: p.id, name: p.display_name })), ...contacts].find(p => p.id === b.person.id)?.name || '' };
    if (b.fund_id !== undefined) x.fund_id = b.fund_id;
    if (b.account_id !== undefined) { x.account_id = b.account_id; x.account_name = b.account_id ? acctName(b.account_id) : null; }
    if (b.liability_id !== undefined) { x.liability_id = b.liability_id; if (b.liability_id && !b.purpose) x.purpose = 'loan_payment'; } x.confidence = 1; }
  return t; });
on('POST', '/transactions/{id}/split', (m, b) => { const t = txns.find(x => x.id === m[1])!; const others = b.shares.reduce((s: number, x: any) => s + x.share_minor, 0);
  splits[t.id] = b.shares.map((x: any) => ({ member_id: x.member_id || null, contact_id: x.contact_id || null, share_minor: x.share_minor }));
  t.split_mine = b.shares.length ? { ...t.amount, minor: t.amount.minor - others } : null; t.confidence = 1; return t; });
on('POST', '/transactions', (_m, b) => { const t = T(0, b.merchant, { minor: b.amount_minor, currency: b.currency }, b.account_id || null, b.category || null, b.purpose || 'spend', { source: 'manual', day: b.day, direction: b.direction }); txns.unshift(t); return t; });
on('DELETE', '/transactions/{id}', m => { txns.splice(txns.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('GET', '/review', () => { const items = review(); return { items, count: items.length }; });
on('GET', '/categories', () => ({ items: categories }));
on('POST', '/settle', () => ({ ok: true }));

on('POST', '/ingest/statement', (_m, b) => { const s = { id: id(), account_id: b.account_id, file_name: b.file_name, period_from: day(-60), period_to: day(-30), rows: 84, imported_at: new Date().toISOString() };
  statements.unshift(s); return { statement: s, rows: 84, new: 61, duplicates: 23 }; });
const statements = [{ id: 's1', account_id: 'a4', file_name: 'HDFC_NRE_Sep2026.pdf', period_from: '2026-09-01', period_to: '2026-09-30', rows: 52, imported_at: day(-20) + 'T10:00:00Z' }];
on('GET', '/ingest/statements', () => ({ items: statements }));
on('GET', '/ingest/log', () => ({ items: [
  { at: day(0) + 'T07:12:00Z', device: 'Arjun’s iPhone', sender: 'AlRajhiBank', outcome: 'stored' },
  { at: day(0) + 'T06:40:00Z', device: 'Arjun’s iPhone', sender: 'SNB-AlAhli', outcome: 'stored' },
  { at: day(-1) + 'T19:40:00Z', device: 'Priya’s Pixel', sender: 'HDFCBK', outcome: 'duplicate' }] }));

on('GET', '/liabilities', () => ({ items: liabilities }));
on('GET', '/liabilities/{id}', m => liabilities.find(x => x.id === m[1]));
const liab = (l: Liability, b: any): Liability => {  // the fields LoanSheet sends, in the response shape
  const cur = b.currency || l.currency, M = (v: number | undefined, d: Money) => (v === undefined ? d : { minor: v, currency: cur });
  const principal = M(b.principal_minor, l.principal);
  return Object.assign(l, { kind: b.kind ?? l.kind, name: b.name ?? l.name, lender: b.lender ?? l.lender, currency: cur, principal,
    opening_balance: M(b.opening_balance_minor ?? (l.opening_balance ? undefined : b.principal_minor), l.opening_balance || principal), as_of: b.as_of ?? l.as_of,
    outstanding: M(b.opening_balance_minor ?? (l.opening_balance ? undefined : b.principal_minor), l.outstanding), rate_bp: b.rate_bp ?? l.rate_bp,
    emi: M(b.emi_minor, l.emi), start_on: b.start_on !== undefined ? b.start_on : l.start_on, end_on: b.end_on !== undefined ? b.end_on : l.end_on,
    match_pattern: b.match_pattern ?? l.match_pattern, closed: b.closed ?? l.closed ?? false });
};
on('POST', '/liabilities', (_m, b) => { const z = { minor: 0, currency: b.currency };
  const l = liab({ id: id(), kind: b.kind, name: b.name, lender: '', currency: b.currency, principal: z, outstanding: z, rate_bp: 0, emi: z, due_day: null, start_on: null, end_on: null,
    paid_pct: 0, payoff_month: null, interest_month: z, account_id: null, contact_id: null }, b);
  liabilities.push(l); return l; });
on('PATCH', '/liabilities/{id}', (m, b) => liab(liabilities.find(x => x.id === m[1])!, b));
on('DELETE', '/liabilities/{id}', m => { liabilities.splice(liabilities.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('GET', '/commitments', () => ({ items: commitments }));
on('GET', '/commitments/detect', () => ({ items: detected }));
on('POST', '/commitments', (_m, b) => { const c = C(id(), b.name, b.kind, { minor: b.amount_minor, currency: b.currency }, b.cycle_months || 1, b.next_due || day(30), 'upcoming', {
    country: b.country ?? null, shares: (b.shares || []).map((s: any) => ({ ...s, share: { minor: s.share_minor, currency: b.currency }, paid_this_cycle: false,
      name: people().find(p => p.id === (s.member_id || s.contact_id))?.name || '' })) });
  commitments.push(c); detected = detected.filter(d => d.name !== b.name); return c; });
on('PATCH', '/commitments/{id}', (m, b) => Object.assign(commitments.find(x => x.id === m[1])!, b));
on('DELETE', '/commitments/{id}', m => { commitments.splice(commitments.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('POST', '/commitments/{id}/paid', (m, b) => { const c = commitments.find(x => x.id === m[1])!;
  if (b.payer) { const s = c.shares.find(s => (s.contact_id || s.member_id) === b.payer.id); if (s) s.paid_this_cycle = true; } else c.status = 'paid'; return c; });
on('GET', '/funds', () => ({ items: funds }));
on('GET', '/funds/{id}', m => funds.find(x => x.id === m[1]));
on('POST', '/funds/{id}/months', (m, b) => { const p = funds.find(x => x.id === m[1])!.pot!;
  p.pending_months = p.pending_months.filter(x => x !== b.month); p.waived_months = p.waived_months.filter(x => x !== b.month);
  if (b.status === 'waived') p.waived_months.push(b.month); if (b.status === 'due') p.pending_months.push(b.month);
  p.rent_due = { ...p.rent, minor: p.rent.minor * p.pending_months.length }; return funds.find(x => x.id === m[1]); });
on('POST', '/contacts/{id}/invite', m => ({ email: contacts.find(c => c.id === m[1])?.email, link: location.origin + '/signup', sent: false }));
on('POST', '/funds', (_m, b) => { if (b.rent) {  // a rent pot: empty until rent and groceries are tagged
    const r = b.rent, z = { minor: 0, currency: b.currency }, rent = { minor: r.amount_minor, currency: b.currency };
    const t = r.tenant.contact_id ? contacts.find(c => c.id === r.tenant.contact_id)! : (contacts.push({ id: id(), name: r.tenant.name, email: r.tenant.email || null, phone: null, on_app: false }), contacts[contacts.length - 1]);
    const named = (x: any) => [...members.map(p => ({ id: p.id, name: p.display_name })), ...contacts].find(p => p.id === (x.member_id || x.contact_id))?.name || '';
    const f: Fund = { id: id(), name: b.name, target: z, due_on: r.from, saved: z, monthly: z, on_track: true, commitment_id: null, pot: {
      tenant: { id: t.id, name: t.name }, rent, rent_from: r.from, match_pattern: r.match_pattern || t.name, received: z, spent: z, balance: z, from_pocket: z,
      mine: { share_pct: 100 - r.shares.reduce((a: number, x: any) => a + x.share_pct, 0), part: z },
      shares: r.shares.map((x: any) => ({ member_id: x.member_id || null, contact_id: x.contact_id || null, name: named(x), share_pct: x.share_pct, part: z, owes_you: z })),
      pending_months: [r.from.slice(0, 7)], rent_due: rent, waived_months: [] } };
    funds.push(f); return f; }
  const f: Fund = { id: id(), name: b.name, target: { minor: b.target_minor, currency: b.currency }, due_on: b.due_on, saved: { minor: 0, currency: b.currency },
  monthly: { minor: Math.round(b.target_minor / 6), currency: b.currency }, on_track: true, commitment_id: null }; funds.push(f); return f; });
on('POST', '/funds/{id}/move', (m, b) => { const f = funds.find(x => x.id === m[1])!; f.saved = { ...f.saved, minor: f.saved.minor + b.amount_minor }; return f; });
on('GET', '/assets', () => ({ items: assets }));
on('GET', '/assets/{id}', m => assets.find(a => a.id === m[1]));
on('PATCH', '/assets/{id}', (m, b) => {  // details merge like the server (null removes a key); the verdict is not recomputed here
  const a = assets.find(x => x.id === m[1])!;
  if (b.details) { a.details = { ...a.details, ...b.details }; for (const k of Object.keys(a.details)) if (a.details[k] === null) delete a.details[k]; }
  const mv = a.details.market_value, d = a.details.disposal;
  if (d) { a.status = d.status; a.value = { minor: d.proceeds_minor, currency: a.currency }; } else a.status = 'owned';
  if (!d && mv) a.value = { minor: mv.minor, currency: a.currency };
  if (a.valuation) a.valuation = { ...a.valuation, value: a.value, basis: d ? d.status : mv ? 'market' : a.valuation.basis, as_of: d?.on || mv?.as_of || a.valuation.as_of, note: d?.note || mv?.source || '' };
  return a;
});
on('POST', '/assets/{id}/costs', (m, b) => { if (!b.txn_id || !b.cost_type) throw new Err(400, 'cost_type is required (fuel, service, insurance…)'); return assets.find(a => a.id === m[1]); });
on('POST', '/assets', (_m, b) => { const M0 = { minor: 0, currency: b.currency }; const a: Asset = { id: id(), kind: b.kind, name: b.name, currency: b.currency, cost: { minor: b.cost_minor || 0, currency: b.currency },
  value: { minor: b.value_minor || 0, currency: b.currency }, paid: M0, financed: M0, remaining: M0, milestones: [], next_milestone: null, monthly_cost: M0, my_monthly_cost: M0,
  costs_by_type: {}, sharers: [], liability_id: null, details: {} }; assets.push(a); return a; });
on('GET', '/claims', () => ({ items: claims, pending: [SAR(2912)] }));
on('POST', '/claims', (_m, b) => { const c: Claim = { id: id(), name: b.name, payer: b.payer || 'Company', status: 'draft', member_id: 'm1', items: [], expected: SAR(0), received: SAR(0), age_days: 0, submitted_on: null }; claims.unshift(c); return c; });
on('POST', '/claims/{id}/items', (m, b) => { const c = claims.find(x => x.id === m[1])!; for (const tid of b.txn_ids) { const t = txns.find(x => x.id === tid)!; t.purpose = 'claim'; t.claim_id = c.id; c.items.push(t); c.expected = { ...c.expected, minor: c.expected.minor + t.amount.minor }; } return c; });
on('PATCH', '/claims/{id}', (m, b) => Object.assign(claims.find(x => x.id === m[1])!, b));
on('GET', '/trips', () => ({ items: trips.map(tripOut).sort((a, b) => b.start_on.localeCompare(a.start_on)) }));
on('GET', '/trips/{id}', m => { const t = trips.find(x => x.id === m[1]); if (!t) throw new Err(404, 'not found');
  return { ...tripOut(t), expenses: tripTxns(t).sort((a, b) => a.day.localeCompare(b.day)).map(x => tripExpense(t, x)), claims: claims.filter(c => t.claim_ids.includes(c.id)) }; });
on('POST', '/trips', (_m, b) => { const t: Trip = { id: id(), claim_ids: [], totals: null!, count: 0, kind: 'business', currency: b.country === 'IN' ? 'INR' : b.country === 'AE' ? 'AED' : 'SAR', ...b }; trips.push(t); return tripOut(t); });
on('PATCH', '/trips/{id}', (m, b) => tripOut(Object.assign(trips.find(x => x.id === m[1])!, b)));
on('DELETE', '/trips/{id}', m => { trips.splice(trips.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('POST', '/trips/{id}/tag', (m, b) => { for (const tid of b.txn_ids) tripStatus[tid] = b.status; return tripOut(trips.find(x => x.id === m[1])!); });
on('POST', '/trips/{id}/claim', (m, b) => { const t = trips.find(x => x.id === m[1])!;
  const ids: string[] = b.txn_ids || tripTxns(t).filter(x => ['missed', 'unreviewed'].includes(statusOf(x))).map(x => x.id);
  const items = txns.filter(x => ids.includes(x.id));
  const c: Claim = { id: id(), name: b.name, payer: 'Company', status: 'draft', member_id: 'm1', items, age_days: 0, submitted_on: null,
    expected: { minor: items.reduce((a, x) => a + x.amount.minor, 0), currency: items[0]?.amount.currency || 'SAR' }, received: SAR(0) };
  for (const x of items) { tripStatus[x.id] = 'claimed'; x.claim_id = c.id; x.purpose = 'claim'; }
  claims.unshift(c); t.claim_ids.push(c.id); return c; });
on('POST', '/claims/import', (_m, b) => { const t = trips.find(x => x.id === b.trip_id) || trips[0];
  const xs = tripTxns(t).filter(x => statusOf(x) === 'claimed');
  const row = (x: Txn, i: number) => ({ row: i + 2, day: x.day, description: x.merchant, amount: x.amount, claimed: x.amount, txn_id: x.id });
  return { claim: claims.find(c => t.claim_ids.includes(c.id)) || claims[0], matched: xs.map(row),
    unmatched: [{ row: 12, day: t.start_on, description: 'Per diem (4 days)', amount: AED(800), claimed: AED(800) }, { row: 13, day: t.end_on, description: 'Visa fee', amount: AED(350), claimed: AED(350) }] }; });
on('GET', '/accounts/coverage', () => {
  const span = Array.from({ length: 12 }, (_, i) => ym(i - 11));
  const make = (a: Account, missing: string[], quiet: number | null, src: (m: string, i: number) => string[]) => {
    const months = a.kind === 'bnpl' ? [] : span.map((m, i) => ({ month: m, sources: missing.includes(m) ? [] : src(m, i), covered: !missing.includes(m) }));
    return { account_id: a.id, name: `${a.institution} ${a.last4 ? '··' + a.last4 : a.name}`, kind: a.kind, currency: a.currency, first_month: months[0]?.month || null,
      last_day: quiet === null ? null : day(-quiet), months, missing_months: missing, days_quiet: quiet,
      status: !months.length ? 'no_data' : missing.length ? 'gaps' : quiet !== null && quiet > 45 ? 'stale' : 'ok' };
  };
  return { this_month: ym(0), items: accounts.map(a =>
    a.id === 'a4' ? make(a, [ym(-7), ym(-6)], 6, (_m, i) => (i < 6 ? ['statement'] : ['sms', 'statement']))
    : a.id === 'a5' ? make(a, [], 52, (_m, i) => (i < 10 ? ['statement'] : ['sms']))
    : a.id === 'a6' ? make(a, [ym(-3)], 5, () => ['sms'])
    : a.id === 'a9' ? make(a, [], null, () => [])
    : make(a, [], a.id === 'a7' ? 18 : 0, (_m, i) => (i < 3 ? ['statement'] : ['sms']))) };
});
on('GET', '/settings', () => settings);
const salary: SalaryEntry[] = [];
on('GET', '/salary', () => ({ items: salary, expected_this_month: salary.find(e => e.kind === 'base')?.amount || settings.salary || SAR(0) }));
on('POST', '/salary', (_m, b) => { const e: SalaryEntry = { id: id(), member_id: b.member_id || 'm1', member_name: 'Arjun', from_month: b.from_month, amount: { minor: b.amount_minor, currency: b.currency },
  kind: b.kind || 'base', note: b.note || '' }; salary.unshift(e); return e; });
on('DELETE', '/salary/{id}', m => { salary.splice(salary.findIndex(x => x.id === m[1]), 1); return { id: m[1], deleted: true }; });
on('PUT', '/settings', (_m, b) => (settings = { ...settings, ...b, salary: b.salary_minor !== undefined ? { minor: b.salary_minor, currency: b.salary_currency || 'SAR' } : settings.salary }));

on('GET', '/insights/month', () => month());
on('GET', '/insights/lookahead', (_m, _b, q) => look(Number(q.get('months') || 12)));
on('GET', '/insights/whatif', (_m, _b, q) => {
  const a = Number(q.get('amount_minor')) / 100, pay = q.get('pay');
  const verdict = a <= 3000 ? 'ok' : a <= 9000 ? 'tight' : 'no';
  return { verdict, why: verdict === 'ok' ? `You'd still have SAR ${(4630 - a).toLocaleString()} free this month and every fund stays on track.`
    : verdict === 'tight' ? `It fits only if you pause the flights fund for ${Math.ceil(a / 575 / 4)} months${pay === 'card' ? ' — and the card would cost ~SAR ' + Math.round(a * 0.0225) + '/month in interest' : ''}.`
    : 'January rent and school fees land in the next 8 weeks. Wait until after the rent, or split it over 3 months.',
    month_free_after: SAR(4630 - a), debt_free_before: '2039-04', debt_free_after: verdict === 'ok' ? '2039-04' : verdict === 'tight' ? '2039-05' : '2039-07',
    free_per_month: SAR(3900), recover_months: Math.ceil(a / 3900),
    delay_months: verdict === 'ok' ? 0 : verdict === 'tight' ? 1 : 3, extra_interest: SAR(verdict === 'ok' ? 0 : Math.round(a * (pay === 'card' ? 0.09 : 0.03))) };
});
on('GET', '/insights/advice', () => ({ emergency: { months_covered: 2.9, target: SAR(60000) }, steps: [
  { title: 'Clear the SNB card first', why: 'It charges 27% a year — more than anything else you owe. Every riyal here saves the most.', amount: SAR(6850) },
  { title: 'Top up the emergency fund', why: 'You have 2.9 months of expenses set aside; aim for 6 while you work abroad.', amount: SAR(2000) },
  { title: 'Keep the NRE FD, don’t prepay the home loan yet', why: 'Loan costs 8.65% but is tax-deductible; the FD earns 7.1% tax-free. Close to even — liquidity wins.', amount: null },
  { title: 'Then raise the SIP', why: 'With the card cleared, put ₹10,000 more a month into the flexi-cap fund for long-term growth.', amount: INR(10000) },
] }));
on('GET', '/insights/home', () => ({ month: month(), next_dues: [...commitments].filter(c => c.status !== 'paid').sort((a, b) => a.next_due.localeCompare(b.next_due)).slice(0, 5),
  lookahead: look(6), review_count: merchants.reduce((a, g) => a + g.count, 0), alerts: [
    { level: 'warn', text: 'KSEB electricity for Kochi is 2 days late', link: '/plan' },
    { level: 'info', text: 'Imran hasn’t paid his Netflix share this month', link: '/people' },
  ] }));

// --- overview: net worth by country, the month planner, money moved, one person's ledger, to-sort by shop -----------
const toSAR = (m: Money) => conv(m.minor, m.currency, 'SAR');
const sumC = (xs: Money[], cur: string): Money => ({ minor: Math.round(xs.reduce((a, x) => a + conv(x.minor, x.currency, cur), 0)), currency: cur });
on('GET', '/insights/networth', () => {
  const tracked = new Set(liabilities.map(l => l.account_id).filter(Boolean));
  const countries = (['SA', 'IN'] as const).map(code => {
    const cur = code === 'SA' ? 'SAR' : 'INR', here = accounts.filter(a => a.currency === cur && !a.archived);
    const cash = sumC(here.filter(a => !['credit_card', 'bnpl', 'loan'].includes(a.kind) && (a.balance?.minor || 0) > 0).map(a => a.balance!), cur);
    const cards = sumC(here.filter(a => ['credit_card', 'bnpl'].includes(a.kind) && !tracked.has(a.id)).map(a => ({ ...a.balance!, minor: -a.balance!.minor })), cur);
    const owe = liabilities.filter(l => l.currency === cur && !l.closed);
    const loans = sumC(owe.filter(l => l.kind !== 'credit_card' && l.kind !== 'bnpl').map(l => l.outstanding), cur);
    const cardsAll = sumC([cards, ...owe.filter(l => l.kind === 'credit_card' || l.kind === 'bnpl').map(l => l.outstanding)], cur);
    const property = sumC(assets.filter(a => a.currency === cur && a.kind !== 'home' && a.status !== 'sold' && a.status !== 'written_off').map(a => a.value), cur);
    const assetsC = sumC([cash, property], cur), liab = sumC([cardsAll, loans], cur), net = { minor: assetsC.minor - liab.minor, currency: cur };
    return { code, currency: cur, cash, property, cards: cardsAll, loans, assets: assetsC, liabilities: liab, net, net_base: sumC([net], 'SAR') };
  });
  const fees = txns.filter(t => t.purpose === 'fee');
  return { currency: 'SAR', fx: { SAR_INR: 24.9, at: day(0) }, countries,
    assets: sumC(countries.map(c => c.assets), 'SAR'), liabilities: sumC(countries.map(c => c.liabilities), 'SAR'), net: sumC(countries.map(c => c.net), 'SAR'),
    losses: { month: sumC(fees.filter(t => t.day.startsWith(ym(0))).map(t => t.amount), 'SAR'), year: sumC([...fees.map(t => t.amount), SAR(1240)], 'SAR'),
      loan_interest_month: sumC([INR(27840), SAR(155)], 'SAR'), items: fees } };
});
const planFor = (off: number) => {
  const mo = ym(off), A = (id: string) => [id, acctName(id)] as const;
  type L = { kind: string; name: string; amount: Money; day: string | null; acct: readonly [string, string]; paid?: boolean; counted?: boolean; link: string; country: string };
  const ls: L[] = [];
  for (const c of commitments) {
    if (c.cycle_months !== 1 && !c.next_due.startsWith(mo)) continue;
    const ind = c.amount.currency === 'INR';
    ls.push({ kind: c.kind === 'emi' ? 'emi' : 'commitment', name: c.name, amount: c.amount, day: `${mo}-${c.next_due.slice(8)}`, link: '/plan#commitments',
      acct: A(ind ? (c.kind === 'support' ? 'a5' : 'a4') : 'a1'), paid: off === 0 && c.status === 'paid', counted: !(c.fund_id && c.cycle_months !== 1), country: ind ? 'IN' : 'SA' });
  }
  ls.push({ kind: 'emi', name: 'Patrol loan — my half to Rohan', amount: SAR(1350), day: `${mo}-27`, acct: A('a1'), link: '/plan#debts', country: 'SA' });
  ls.push({ kind: 'card', name: off ? 'SNB Platinum (estimate)' : 'SNB Platinum', amount: SAR(off ? 3800 : 6850), day: `${mo}-18`, acct: A('a1'), link: '/accounts/a2', country: 'SA' });
  ls.push({ kind: 'card', name: off ? 'HDFC Regalia (estimate)' : 'HDFC Regalia', amount: INR(off ? 15000 : 38400), day: `${mo}-19`, acct: A('a4'), link: '/accounts/a6', country: 'IN' });
  if (!off) ls.push({ kind: 'person', name: 'You owe Sameer Khan', amount: SAR(120), day: null, acct: A('a1'), link: '/people/contact/c3', country: 'SA' });
  for (const f of funds) if (f.monthly.minor) ls.push({ kind: 'fund', name: f.name, amount: f.monthly, day: null, acct: A(f.monthly.currency === 'INR' ? 'a4' : 'a1'), link: '/plan#funds', country: f.monthly.currency === 'INR' ? 'IN' : 'SA' });
  const lines = ls.map(l => ({ kind: l.kind, name: l.name, amount: l.amount, base: SAR(toSAR(l.amount) / 100), day: l.day, country: l.country,
    account_id: l.acct[0], account_name: l.acct[1], paid: !!l.paid, counted: l.counted !== false, link: l.link }));
  const out = lines.filter(l => l.counted).reduce((a, l) => a + l.base.minor, 0), income = 2600000;
  const open = lines.filter(l => !l.paid && l.counted), pay = new Map<string, typeof open>();
  for (const l of open) pay.set(l.account_id, [...(pay.get(l.account_id) || []), l]);
  const dueIN = open.filter(l => l.country === 'IN').reduce((a, l) => a + l.amount.minor, 0);
  const cash = off ? 190000 : 5065000, need = Math.max(0, dueIN - cash), sar = Math.ceil(need / 24.9 / 10000) * 10000;
  return { month: mo, income: SAR(26000), out: SAR(out / 100), surplus: SAR(Math.max(0, income - out) / 100), short: out > income ? SAR((out - income) / 100) : null, lines,
    pay_from: [...pay].map(([aid, xs]) => { const a = accounts.find(x => x.id === aid)!;
      return { account_id: aid, account_name: acctName(aid), currency: a.currency, total: sumC(xs.map(x => x.amount), a.currency), items: xs.map(x => ({ name: x.name, amount: x.amount, day: x.day })) }; }),
    move_to_india: sar ? { amount: SAR(sar / 100), inr: INR(sar * 24.9 / 100), by: `${mo}-${off ? '01' : '25'}`, from: 'a1', to: 'a4' } : null,
    india: { due: INR(dueIN / 100), cash: INR(cash / 100) } };
};
on('GET', '/insights/plan', () => ({ currency: 'SAR', fx: { SAR_INR: 24.9 }, months: [planFor(0), planFor(1)] }));
const side = (kind: 'account' | 'member' | 'contact', sid: string) => kind === 'account' ? { kind, id: sid, name: acctName(sid), country: accounts.find(a => a.id === sid)!.country }
  : { kind, id: sid, name: kind === 'member' ? members.find(m => m.id === sid)!.display_name : contacts.find(c => c.id === sid)!.name, country: null };
const mv = (group: string, from: ReturnType<typeof side>, to: ReturnType<typeof side>, amount: Money, received: Money | null = null, count = 1) => ({ group, from, to, amount, received, count, txn_ids: [] });
on('GET', '/insights/movements', (_m, _b, q) => {
  const month = q.get('month') || ym(0);
  if (month < ym(-2)) return { month, currency: 'SAR', groups: [] };
  const groups = [
    ['remit', 'Sent home', [mv('remit', side('account', 'a1'), side('account', 'a4'), SAR(5000), INR(117100))]],
    ['cards', 'Card payments', [mv('cards', side('account', 'a1'), side('account', 'a2'), SAR(4000), null, 2), mv('cards', side('account', 'a4'), side('account', 'a6'), INR(30000))]],
    ['own', 'Between your accounts', [mv('own', side('account', 'a4'), side('account', 'a5'), INR(40000))]],
    ['family', 'Family', [mv('family', side('account', 'a5'), side('member', 'm3'), INR(25000)), mv('family', side('account', 'a5'), side('member', 'm4'), INR(8000))]],
    ['to_people', 'To people', [mv('to_people', side('account', 'a1'), side('contact', 'c5'), SAR(1350)), mv('to_people', side('account', 'a1'), side('contact', 'c1'), SAR(150))]],
    ['from_people', 'From people', [mv('from_people', side('contact', 'c5'), side('account', 'a1'), SAR(800))]],
  ] as const;
  return { month, currency: 'SAR', groups: groups.map(([key, title, items]) => ({ key, title, items, total: sumC(items.map(x => x.amount), 'SAR') })) };
});
const byCur = (xs: Money[]) => Object.values(xs.reduce((o, x) => ({ ...o, [x.currency]: { minor: (o[x.currency]?.minor || 0) + x.minor, currency: x.currency } }), {} as Record<string, Money>));
on('GET', '/people/{kind}/{id}', m => {
  const person = people().find(p => p.kind === m[1] && p.id === m[2]); if (!person) throw new Err(404, 'not found');
  const col = m[1] === 'member' ? 'member_id' : 'contact_id';
  const shared = txns.filter(t => splits[t.id]?.some(s => s[col] === m[2])).map(t => {
    const mine = splits[t.id].find(s => s[col] === m[2])!;
    return { txn: t, share: { minor: mine.share_minor, currency: t.amount.currency }, settled: false, splits: splits[t.id] }; });
  const own = txns.filter(t => t.person?.id === m[2] && !splits[t.id]);
  const sent = own.filter(t => t.direction === 'debit'), received = own.filter(t => t.direction === 'credit');
  const shared_costs = m[2] === 'c5' ? patrolCosts.slice(0, 4).map(c => ({ day: c.day, what: `Patrol — ${c.merchant}`, amount: SAR(c.amount.minor / 200) })) : [];
  return { person, shared, sent, received, shared_costs, totals: { shared: byCur(shared.map(x => x.txn.amount)), their_part: byCur(shared.map(x => x.share)),
    sent: byCur(sent.map(t => t.amount)), received: byCur(received.map(t => t.amount)) } };
});
const merchants = ([['Panda Retail', 412, 46, 'a1'], ['Al Baik', 236, 38, 'a2'], ['Uber', 198, 27, 'a2'], ['STC Pay transfer', 164, 120, 'a3'], ['Aldrees Petrol', 151, 95, 'a3'],
  ['Amazon.sa', 122, 140, 'a2'], ['Jahez', 118, 58, 'a2'], ['HungerStation', 96, 52, 'a2'], ['Careem', 88, 31, 'a2'], ['Nahdi Pharmacy', 74, 44, 'a1'],
  ['Al Rajhi ATM', 61, 400, 'a1'], ['Transfer from ROHAN', 37, 650, 'a1'], ['Mada refund', 22, 75, 'a1'], ['Swiggy', 21, 380, 'a6']] as const)
  .map(([merchant, count, avg, acc], i) => { const a = accounts.find(x => x.id === acc)!, credit = /^(Transfer from|Mada refund)/.test(merchant);
    return { merchant: merchant as string, count: count as number, direction: credit ? 'credit' : 'debit', totals: [{ minor: count * avg * 100, currency: a.currency }],
      last_day: day(-i), category: null, account_name: acctName(acc), txn_ids: [] }; });
on('GET', '/review/merchants', () => ({ items: merchants, count: merchants.reduce((a, g) => a + g.count, 0) }));
on('POST', '/review/merchant', (_m, b) => { if (!b.category && !b.purpose) throw new Err(400, 'category or purpose is required');
  const i = merchants.findIndex(g => g.merchant === b.merchant); const updated = i < 0 ? 0 : merchants.splice(i, 1)[0].count;
  return { merchant: b.merchant, updated, left: merchants.reduce((a, g) => a + g.count, 0) }; });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const method = (init?.method || 'GET').toUpperCase();
  const path = url.pathname.slice(4);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  await new Promise(r => setTimeout(r, 120 + Math.random() * 180));
  for (const [m, rx, h] of routes) {
    const hit = path.match(rx);
    if (!hit || m !== method) continue;
    try {
      const out = h(hit, body, url.searchParams);
      return new Response(JSON.stringify(out ?? {}), { status: method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      if (e instanceof Err) return new Response(JSON.stringify({ error: e.msg }), { status: e.status, headers: { 'Content-Type': 'application/json' } });
      throw e;
    }
  }
  return new Response(JSON.stringify({ error: `mock: no route for ${method} ${path}` }), { status: 404 });
};
console.info('%cLedger mock API on', 'color:#0a84ff');
