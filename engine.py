"""The money engine: month view, 12-month look-ahead, debt-free date, what-if, advice and commitment detection.
Pure functions over plain data (no database), so every number is unit-testable. See docs/brain/domain-model.md.

Shapes (amounts in minor units):
  txn        {id, day 'YYYY-MM-DD', amount_minor, currency, direction, purpose, theirs_minor, category, merchant, commitment_id, person_id}
  commitment {id, name, kind, amount_minor, currency, cycle_months, next_due, match, sharers: [{person_id, share_minor}]}
  fund       {id, name, target_minor, saved_minor, currency, due, commitment_id, cycle_months}
  loan       {id, name, kind, balance_now, rate_bp, emi_minor, currency}  (server.money() holdings)
"""
from collections import defaultdict
from datetime import date, timedelta
import re

USD_SAR = 3.75  # the riyal is pegged to the dollar
SPENDING = {'spend', 'fee', 'support'}  # what counts as your spending (your share)
OUT_OF_POCKET = {'loan_payment', 'asset', 'saving', 'lend', 'repay'}  # not spending, but money gone this month
HIGH_RATE_BP = 1000  # 10% a year and up: pay it off before saving more than an emergency fund
NRE_FD_RATE_BP = 700  # what an NRE fixed deposit in India pays, roughly (tax-free, repatriable)
CARD_RATE_BP = 3600  # a credit card's yearly rate when none is known
CYCLES = (1, 3, 6, 12)


def money(minor, currency):
    return {'minor': int(round(minor)), 'currency': currency}


# Units of each currency per US dollar (official pegs).
USD_PEGS = {'USD': 1, 'SAR': 3.75, 'QAR': 3.64, 'AED': 3.6725, 'BHD': 0.376, 'OMR': 0.3845, 'KWD': 0.307}


def conv(minor, cur, to, rate):
    """Convert at `rate` (INR per SAR); USD-pegged Gulf currencies through their fixed pegs."""
    if cur == to or not minor:
        return minor
    sar_per = {'SAR': 1, 'INR': 1 / rate, **{c: USD_SAR / p for c, p in USD_PEGS.items()}}
    if cur not in sar_per or to not in sar_per:
        raise ValueError(f'no exchange rate for {cur} to {to}')
    return minor * sar_per[cur] / sar_per[to]


def add_months(day, n):
    """'2026-11-30' + 3 → '2027-02-28'; works on 'YYYY-MM' too."""
    y, m = int(day[:4]), int(day[5:7]) + n
    y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
    if len(day) == 7:
        return f'{y:04d}-{m:02d}'
    last = [31, 29 if y % 4 == 0 and (y % 100 or y % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return f'{y:04d}-{m:02d}-{min(int(day[8:10]), last):02d}'


def months_between(a, b):
    """Whole months from month a to month b ('YYYY-MM...')."""
    return (int(b[:4]) - int(a[:4])) * 12 + int(b[5:7]) - int(a[5:7])


def counted(t):
    """Signed spending of one transaction (your share): purchases add, refunds (a credit marked spend) subtract."""
    if t.get('category') == 'Ignored' or t['purpose'] not in SPENDING:
        return 0
    mine = t['amount_minor'] - (t.get('theirs_minor') or 0)
    return mine if t['direction'] == 'debit' else -t['amount_minor']


def spent(txns, month, cur, rate, everyday=False):
    """Your spending in a month, converted to `cur`. everyday: leave out payments of commitments."""
    return sum(conv(counted(t), t['currency'], cur, rate) for t in txns
               if t['day'].startswith(month) and not (everyday and t.get('commitment_id')))


def everyday_avg(txns, month, cur, rate):
    """Average everyday spending over the 3 full months before `month` (months with no data at all are skipped)."""
    seen = {t['day'][:7] for t in txns}
    months = [m for m in (add_months(month, -k) for k in (1, 2, 3)) if m in seen]
    return sum(spent(txns, m, cur, rate, everyday=True) for m in months) / len(months) if months else 0


def income_of(txns, month, cur, rate):
    return sum(conv(t['amount_minor'], t['currency'], cur, rate) for t in txns
               if t['day'].startswith(month) and t['direction'] == 'credit' and t['purpose'] == 'income' and t.get('category') != 'Ignored')


def salary_in(settings, month, cur, rate):
    """(base, extra) from the salary history for `month`: base = each member's latest `base` entry from on or before the
    month, summed (None when nobody has one yet); extra = `arrears`/`bonus` entries paid in that month (one-offs)."""
    latest, extra = {}, 0
    for e in sorted(settings.get('salary_history') or (), key=lambda e: e['from_month']):
        amt = conv(e['amount_minor'], e['currency'], cur, rate)
        if e['kind'] == 'base' and e['from_month'] <= month:
            latest[e.get('member_id')] = amt
        elif e['kind'] != 'base' and e['from_month'] == month:
            extra += amt
    return (sum(latest.values()) if latest else None), extra


def expected_income(settings, txns, month, cur, rate):
    """Salary history for the month (+ one-off arrears/bonus), else the old single salary setting, else the median
    monthly salary credit of the last 3 months, else the average income."""
    base, extra = salary_in(settings, month, cur, rate)
    return (base if base is not None else _income_guess(settings, txns, month, cur, rate)) + extra


def _income_guess(settings, txns, month, cur, rate):
    if settings.get('salary'):
        return conv(round(float(settings['salary']) * 100), settings.get('salary_currency') or 'SAR', cur, rate)
    months = [add_months(month, -k) for k in (1, 2, 3)]
    pay = sorted(sum(conv(t['amount_minor'], t['currency'], cur, rate) for t in txns
                     if t['day'].startswith(m) and t['direction'] == 'credit' and t.get('category') == 'Salary') for m in months)
    if pay[1]:
        return pay[1]
    return sum(income_of(txns, m, cur, rate) for m in months) / 3


def your_share(c):
    return max(0, c['amount_minor'] - sum(s.get('share_minor') or 0 for s in c.get('sharers') or ()))


def dues(c, first, last):
    """Due dates of a commitment between months first..last (inclusive)."""
    out, d, n = [], c['next_due'], 0
    while d[:7] <= last and n < 600 and not (c.get('end_on') and d > c['end_on']):
        if d[:7] >= first:
            out.append(d)
        if not c['cycle_months']:
            break
        d, n = add_months(d, c['cycle_months']), n + 1
    return out


def fund_projection(f, first, months):
    """Monthly set-asides from month `first` for `months` months, carrying savings forward."""
    out, saved, due, target = [], f['saved_minor'], f['due'], f['target_minor']
    for k in range(months):
        m = add_months(first, k)
        if m > due[:7]:
            if f.get('cycle_months', 0) > 1:  # the payment came out of the fund; the next cycle starts empty
                due, saved = add_months(due, f['cycle_months']), 0
            else:
                out.append(0)
                continue
        need = max(0, target - saved) / max(1, months_between(m, due) + 1)
        out.append(need)
        saved += need
    return out


def pot(lines, others_pct, due_months=()):
    """A shared pot (rent that pays for groceries), month by month. lines: [(day, minor)], + money in, - spent from it.
    A month's money in pays that month's spending and a surplus carries on; a shortfall was paid from pocket by the
    household, so each co-owner owes their pct of it (`owed`), and the pot restarts at 0. others_pct: {person: pct}.
    due_months: months rent was due; those with no money in at all come back as `missing`."""
    months = defaultdict(lambda: [0, 0])
    for d, v in lines:
        months[d[:7]][v < 0] += abs(v)
    bal = short = 0
    for m in sorted(months):
        bal += months[m][0] - months[m][1]
        if bal < 0:
            short, bal = short - bal, 0
    part = lambda v: {p: round(v * pct / 100) for p, pct in others_pct.items()}
    parts = part(bal)
    return {'in': sum(v[0] for v in months.values()), 'out': sum(v[1] for v in months.values()), 'balance': bal, 'short': short,
            'parts': parts, 'my_part': bal - sum(parts.values()), 'owed': part(short),
            'missing': [m for m in due_months if not (m in months and months[m][0])]}


def commitment_status(c, txns, today):
    """Roll a commitment's due date past the payments matched to it (a payment up to 15 days early counts).
    {next_due, status: paid|due|overdue|upcoming, last_paid_txn}."""
    paid = sorted((t for t in txns if t.get('commitment_id') == c['id'] and t['direction'] == 'debit'), key=lambda t: t['day'])
    nd, covered, n = c['next_due'], None, 0
    early = lambda d: (date.fromisoformat(d) - timedelta(days=15)).isoformat()
    while paid and paid[-1]['day'][:10] >= early(nd) and n < 600:
        covered = nd
        if not c['cycle_months']:
            break
        nd, n = add_months(nd, c['cycle_months']), n + 1
    if covered and not c['cycle_months']:
        status = 'paid'
    elif nd < today:
        status = 'overdue'
    elif nd[:7] == today[:7]:
        status = 'due'
    else:
        status = 'paid' if covered else 'upcoming'
    return {'next_due': nd, 'status': status, 'last_paid_txn': paid[-1]['id'] if paid else None}


BNPL = re.compile(r'tamara|tabby|postpay|spotii|simpl|lazypay|pay later', re.I)


def month_view(txns, commitments, funds, loans, settings, month, today, cur, rate, people_owe_you=0, you_owe_people=0, claims_pending=0):
    """One month: income − spending − other money out (EMIs, lending, assets, saving) − commitments still due −
    fund set-asides = free money. Commitments with a fund are covered by its set-aside, not counted twice."""
    inside = [t for t in txns if t['day'].startswith(month) and t.get('category') != 'Ignored']
    income = income_of(txns, month, cur, rate)
    if month >= today[:7]:  # the salary may not have arrived yet
        income = max(income, expected_income(settings, txns, month, cur, rate))
    sp = spent(txns, month, cur, rate)
    out = sum(conv(t['amount_minor'], t['currency'], cur, rate) for t in inside if t['direction'] == 'debit' and t['purpose'] in OUT_OF_POCKET)
    funded = {f['commitment_id'] for f in funds if f.get('commitment_id')}
    due = 0
    for c in commitments:
        st = commitment_status(c, txns, today)
        if c['id'] not in funded and st['status'] in ('due', 'overdue') and st['next_due'][:7] <= month:
            due += conv(your_share(c), c['currency'], cur, rate)
    paid = sum(conv(t['amount_minor'] - (t.get('theirs_minor') or 0), t['currency'], cur, rate) for t in inside if t.get('commitment_id') and t['direction'] == 'debit')
    put = sum(conv(fund_projection(f, month, 1)[0], f['currency'], cur, rate) for f in funds)
    by_purpose = defaultdict(float)
    for t in inside:
        by_purpose[t['purpose']] += conv(t['amount_minor'], t['currency'], cur, rate)
    base = to_cur(loans, cur, rate)
    kind = lambda l: 'bnpl' if BNPL.search(l['name']) else 'cards' if l['kind'] == 'card' else 'loans'
    owed = {k: sum(l['balance_now'] for l in base if kind(l) == k) for k in ('loans', 'cards', 'bnpl')}
    owed['people'] = you_owe_people
    return {'month': month, 'currency': cur, 'income': money(income, cur), 'spent': money(sp, cur), 'other_out': money(out, cur),
            'committed_due': money(due, cur), 'committed_paid': money(paid, cur), 'set_aside': money(put, cur),
            'free': money(income - sp - out - due - put, cur), 'by_purpose': {k: money(v, cur) for k, v in sorted(by_purpose.items())},
            'owed_by_you': {**{k: money(v, cur) for k, v in owed.items()}, 'total': money(sum(owed.values()), cur)},
            'owed_to_you': {'people': money(people_owe_you, cur), 'claims': money(claims_pending, cur), 'total': money(people_owe_you + claims_pending, cur)},
            'interest_this_month': money(interest_per_month(base), cur)}


def debt_free(loans, extra, today, strategy='avalanche'):
    """Avalanche (highest rate first; or snowball) with `extra` a month on top of the EMIs. {month, months, interest}:
    month None = never at these payments; months 0 = no debt."""
    import server
    live = [l for l in loans if l['balance_now'] > 0]
    if not live:
        return {'month': today[:7], 'months': 0, 'interest': 0}
    p = server.plan(live, max(0, int(extra)), strategy)
    return {'month': add_months(today[:7], p['months']) if p['months'] is not None else None, 'months': p['months'], 'interest': p['interest']}


def interest_per_month(loans):
    return sum(l['balance_now'] * l['rate_bp'] / 120000 for l in loans if l['balance_now'] > 0)


def to_cur(loans, cur, rate):
    return [{**l, 'balance_now': round(conv(l['balance_now'], l['currency'], cur, rate)),
             'emi_minor': round(conv(l['emi_minor'], l['currency'], cur, rate)),
             'pre_emi_minor': round(conv(l.get('pre_emi_minor') or 0, l['currency'], cur, rate)), 'currency': cur} for l in loans]


def emi_in(l, month):
    """What a loan takes in `month`: the full EMI, or before a construction loan's `emi_from` only the pre-EMI interest
    (shortcut: the pre-EMI is today's; a tranche disbursed later raises it, add it when tranches get planned dates)."""
    return l['emi_minor'] if not l.get('emi_from') or month >= l['emi_from'][:7] else l.get('pre_emi_minor') or 0


# ---------- loans: amortisation, construction tranches, missed EMIs ----------

def emi(principal, rate_bp, months):
    """The equal monthly instalment for a loan (reducing balance)."""
    r = rate_bp / 120000
    return principal / months if not r else principal * r * (1 + r) ** months / ((1 + r) ** months - 1)


def loan_walk(opening, rate_bp, payments, tranches=()):
    """Walk a loan in day order. Each tranche (day, minor) adds to the balance on its day (before a payment that day);
    each payment {id, day, amount} pays the month's interest (balance × rate / 12) first and the rest is principal.
    So on a construction loan, a pre-EMI payment (interest on what is disbursed so far) leaves the balance as it is.
    → (balance, {payment id: interest})."""
    bal, rate, interest = opening, rate_bp / 120000, {}
    events = sorted([(d, 0, a, None) for d, a in tranches] + [(p['day'], 1, p['amount'], p['id']) for p in payments], key=lambda e: e[:2])
    for day, kind, amt, pid in events:
        if kind == 0:
            bal += amt
            continue
        i = min(amt, round(max(bal, 0) * rate))
        interest[pid] = i
        bal -= amt - i
    return bal, interest


def construction(sanctioned, tranches, outstanding, rate_bp, emi_minor, emi_from, today):
    """A loan paid out in tranches while a property is built: disbursed so far, what the bank still holds back, the
    monthly pre-EMI (interest only on what is out: outstanding × rate / 12) and whether full EMIs have started."""
    disbursed = sum(a for d, a in tranches if d <= today)
    phase = 'emi' if emi_from and today >= emi_from else 'pre_emi'
    return {'disbursed': disbursed, 'undisbursed': max(0, sanctioned - disbursed), 'pre_emi': round(max(outstanding, 0) * rate_bp / 120000),
            'phase': phase, 'emi_from': emi_from or None, 'monthly': emi_minor if phase == 'emi' else round(max(outstanding, 0) * rate_bp / 120000)}


def missed_months(due_day, paid_days, since, today, grace=3, back=3):
    """Months (of the last `back`) whose due date is after `since` (tracking start) and at least `grace` days past,
    with no payment that month: a bounced or forgotten EMI. due_day 0 = end of month."""
    out = []
    for k in range(back - 1, -1, -1):
        m = add_months(today[:7], -k)
        due = f'{m}-{min(due_day or 31, _days_in(m)):02d}'
        if due <= since or (date.fromisoformat(today) - date.fromisoformat(due)).days < grace:
            continue
        if not any(d.startswith(m) for d in paid_days):
            out.append(m)
    return out


def _days_in(month):
    return (date.fromisoformat(add_months(month, 1) + '-01') - timedelta(days=1)).day


def _emi_commitment(c, loans):
    """An EMI commitment for a loan already on the Debt tab is counted there, not twice."""
    return c['kind'] == 'emi' and any(c['name'].lower() == l['name'].lower() or (c.get('match') and c['match'] == (l.get('pattern') or '').lower())
                                      for l in loans if l['kind'] == 'loan')


def lookahead(txns, commitments, funds, loans, settings, today, cur, rate, months=12):
    """Each month from this one: expected income, commitments due (monthly and one-off; longer cycles come out of
    their fund), fund set-asides, everyday spending (trailing 3-month average without commitments) → free money."""
    first = today[:7]
    guess = _income_guess(settings, txns, first, cur, rate)  # anchored on this month: future months have no credits yet
    everyday = everyday_avg(txns, first, cur, rate)
    funded = {f['commitment_id'] for f in funds if f.get('commitment_id')}
    loans_cur = to_cur(loans, cur, rate)
    as_is = {}
    if loans_cur:
        import server
        as_is = server.plan([l for l in loans_cur if l['balance_now'] > 0], 0)['payoff']
    sets = [fund_projection(f, first, months) for f in funds]
    out = []
    for k in range(months):
        m = add_months(first, k)
        base, extra = salary_in(settings, m, cur, rate)
        income = (base if base is not None else guess) + extra
        committed = sum(conv(your_share(c), c['currency'], cur, rate) * len(dues(c, m, m))
                        for c in commitments if c['id'] not in funded and not _emi_commitment(c, loans))
        committed += sum(emi_in(l, m) for l in loans_cur if l['kind'] == 'loan' and l['balance_now'] > 0 and (as_is.get(l['id']) or 10 ** 6) > k)
        put = sum(conv(s[k], f['currency'], cur, rate) for s, f in zip(sets, funds))
        free = income - committed - put - everyday
        warnings = [f'{c["name"]} due: {fmt(your_share(c), c["currency"])} (from its fund)'
                    for c in commitments if c['id'] in funded and dues(c, m, m)]
        if free < 0:
            warnings.append(f'Short by {fmt(-free, cur)}: spend less or move a set-aside')
        out.append({'month': m, 'income': money(income, cur), 'commitments': money(committed, cur), 'funds': money(put, cur),
                    'everyday': money(everyday, cur), 'free': money(free, cur), 'warnings': warnings})
    frees = [r['free']['minor'] for r in out]
    extra = max(0, sum(frees) / len(frees)) if frees else 0
    if settings.get('extra_to_debt') is not None:  # the extra a month you chose, instead of the average free money
        extra = conv(settings['extra_to_debt'], settings.get('extra_currency') or cur, cur, rate)
    df = debt_free(loans_cur, extra, today, settings.get('debt_strategy') or 'avalanche')
    return {'months': out, 'debt_free': {'month': df['month'], 'months': df['months']},
            'interest_per_month': money(interest_per_month(loans_cur), cur), 'extra_to_debt': money(extra, cur)}


def fmt(minor, cur):
    return f'{cur} {minor / 100:,.0f}'


def what_if(loans, extra, month_free, amount, cur, pay, today, months=12, rate_bp=0):
    """Spend `amount` now: from cash (that money no longer goes to the highest-rate debt), on a card (a new card
    debt at the highest card rate you have, else 36%) or on an EMI plan (`months` instalments at `rate_bp`, 0 = no-cost
    EMI; the instalment comes out of each month's free money). Reruns the debt-free simulation."""
    before = debt_free(loans, extra, today)
    live = [l for l in loans if l['balance_now'] > 0]
    if pay == 'card':
        rate = max([l['rate_bp'] for l in live if l['kind'] == 'card'] or [CARD_RATE_BP])
        after_loans = live + [{'id': 'what-if', 'name': 'this purchase', 'kind': 'card', 'balance_now': amount, 'rate_bp': rate, 'emi_minor': 0, 'currency': cur}]
        free_after = month_free
    elif pay == 'emi':
        n, r = max(1, int(months)), rate_bp / 120000
        emi = amount / n if not r else amount * r / (1 - (1 + r) ** -n)
        after_loans = live + [{'id': 'what-if', 'name': 'this purchase', 'kind': 'loan', 'balance_now': amount, 'rate_bp': rate_bp,
                               'emi_minor': round(emi), 'currency': cur}]
        free_after = month_free - emi
    else:
        top = max(live, key=lambda l: l['rate_bp'], default=None)
        after_loans = [{**l, 'balance_now': l['balance_now'] + amount} if l is top else l for l in live]
        free_after = month_free - amount
    after = debt_free(after_loans, extra, today) if live or pay in ('card', 'emi') else before
    never = after['months'] is None and before['months'] is not None
    delay = None if never else (after['months'] or 0) - (before['months'] or 0) if before['months'] is not None else 0
    extra_interest = max(0, after['interest'] - before['interest'])
    if never or free_after < 0 and (delay or 0) > 3:
        verdict = 'no'
    elif free_after < 0 or (delay or 0) > 1 or (pay in ('card', 'emi') and extra_interest > amount / 20):
        verdict = 'tight'
    else:
        verdict = 'ok'
    why = []
    if free_after < 0:
        why.append(f'it is {fmt(-free_after, cur)} more than this month’s free money')
    else:
        why.append(f'{fmt(free_after, cur)} stays free this month')
    if never:
        why.append('your payments would no longer cover the interest, so the debt would never close')
    elif delay:
        why.append(f'debt-free {delay} month{"s" if delay != 1 else ""} later')
    elif live:
        why.append('your debt-free month doesn’t move')
    if extra_interest:
        why.append(f'{fmt(extra_interest, cur)} more interest')
    return {'debt_free_before': {'month': before['month'], 'months': before['months']},
            'debt_free_after': {'month': after['month'], 'months': after['months']},
            'delay_months': delay, 'extra_interest': money(extra_interest, cur), 'month_free_after': money(free_after, cur),
            'verdict': verdict, 'why': (lambda s: s[:1].upper() + s[1:])('; '.join(why)) + '.'}


def advice(loans, savings_minor, essentials, free, funds_monthly, settings, cur):
    """Rules-based, plain words, not financial advice: a starter emergency fund, then high-interest debt, then the
    full emergency fund, then sinking funds, then cheap debt vs an NRE FD, then investing."""
    target_months = float(settings.get('emergency_months') or 6)
    target = essentials * target_months
    covered = savings_minor / essentials if essentials else None
    left, steps = max(0, free), []

    def step(title, why, amount):
        nonlocal left
        amount = max(0, min(left, amount))
        steps.append({'title': title, 'why': why, 'amount': money(amount, cur)})
        left -= amount

    live = sorted([l for l in loans if l['balance_now'] > 0], key=lambda l: -l['rate_bp'])
    high = [l for l in live if l['rate_bp'] >= HIGH_RATE_BP]
    if essentials and savings_minor < essentials:
        step('Keep one month of costs in cash', f'A first cushion of {fmt(essentials, cur)} so a surprise bill doesn’t go on a card.', essentials - savings_minor)
    for l in high:
        step(f'Pay extra on {l["name"]}', f'At {l["rate_bp"] / 100:g}% a year it costs about {fmt(l["balance_now"] * l["rate_bp"] / 120000, cur)} a month in interest; '
             'no saving or investment reliably earns that much, so every extra riyal or rupee here is a sure return.', l['balance_now'])
    if essentials and savings_minor < target:
        step(f'Build the emergency fund to {target_months:g} months',
             f'{fmt(target, cur)} covers {target_months:g} months of costs — job changes abroad can leave a gap before the next salary.', (target - savings_minor) / 6)
    if funds_monthly:
        step('Set aside for your funds', 'Rent, fees and trips you know are coming: saving monthly avoids borrowing when they fall due.', funds_monthly)
    low = [l for l in live if l['rate_bp'] < HIGH_RATE_BP]
    for l in low:
        if l['rate_bp'] > NRE_FD_RATE_BP:
            step(f'Prepay {l["name"]} rather than open an FD', f'The loan charges {l["rate_bp"] / 100:g}%; an NRE fixed deposit pays about {NRE_FD_RATE_BP / 100:g}%. '
                 'Paying the loan earns more, with no risk.', l['balance_now'])
    if left > 0:
        why = (f'Your remaining loans charge less than an NRE FD pays (about {NRE_FD_RATE_BP / 100:g}%, tax-free and repatriable), '
               if low else 'You have no costly debt. ')
        step('Invest the rest', why + 'Keep SAR for Saudi costs; for goals in India an NRE FD or a diversified index fund via an NRE account; '
             'NRO only for income earned in India.', left)
    return {'emergency_fund': {'months_covered': round(covered, 1) if covered is not None else None, 'target': money(target, cur)}, 'steps': steps}


RENT = re.compile(r'\brent\b|ejar|إيجار|landlord', re.I)
_KINDS = {'Subscriptions': 'subscription', 'Bills & Utilities': 'bill', 'Insurance': 'insurance', 'Education': 'school'}


def detect_commitments(txns, today, known=()):
    """Recurring payments: the same merchant, a steady amount (within 15% of the median) at a steady interval
    (monthly, quarterly, 6-monthly or yearly, within 25%). Three payments for a monthly cycle, two for longer ones.
    `known`: match texts of commitments you already have."""
    groups = defaultdict(list)
    for t in txns:
        if t['direction'] == 'debit' and t['purpose'] in ('spend', 'support', 'loan_payment', 'fee') and (t.get('merchant') or '').strip() \
                and not t.get('commitment_id') and t.get('category') != 'Ignored':
            groups[t['merchant'].strip().lower(), t['currency']].append(t)
    out = []
    for (name, cur), ts in groups.items():
        if any(k and k in name for k in known):
            continue
        ts.sort(key=lambda t: t['day'])
        days = [date.fromisoformat(t['day'][:10]) for t in ts]
        gaps = sorted((b - a).days for a, b in zip(days, days[1:]) if (b - a).days > 3)  # same-week repeats are one payment
        if not gaps:
            continue
        gap = gaps[len(gaps) // 2]
        cycle = min(CYCLES, key=lambda c: abs(c * 30.44 - gap))
        if abs(cycle * 30.44 - gap) > cycle * 30.44 * 0.25 or len(gaps) + 1 < (3 if cycle == 1 else 2):
            continue
        if any(abs(g - gap) > gap * 0.25 for g in gaps):
            continue
        amounts = sorted(t['amount_minor'] for t in ts)
        mid = amounts[len(amounts) // 2]
        if any(abs(a - mid) > mid * 0.15 for a in amounts):
            continue
        nxt = add_months(ts[-1]['day'][:10], cycle)
        if months_between(nxt, today) > cycle:  # stopped: the next one is long overdue
            continue
        p = ts[-1]['purpose']
        kind = ('rent' if RENT.search(name) else 'emi' if p == 'loan_payment' else 'support' if p == 'support'
                else _KINDS.get(ts[-1].get('category'), 'subscription' if cycle in (1, 12) and mid < 50000 else 'other'))
        out.append({'name': ts[-1]['merchant'].strip(), 'kind': kind, 'amount': money(mid, cur), 'cycle_months': cycle,
                    'next_due': nxt, 'match': name, 'evidence_txn_ids': [t['id'] for t in ts]})
    return sorted(out, key=lambda c: c['next_due'])
