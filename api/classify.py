"""What a transaction means (purpose, category, confidence), in the order of docs/brain/domain-model.md "Classification":
1. transfer: paired with the opposite movement on another own account (same amount, or FX-converted), or card payment /
   top-up words; 2. a commitment, liability or asset rule; 3. the household's learned merchant rules; 4. fee words and the
   merchants dataset (parse.categorize); 5. otherwise spend / Uncategorized with low confidence (the Review inbox).
A meaning the user set (txn_meta.set_by = 'user') is never overwritten."""
import json
import re
from datetime import date, datetime
from pathlib import Path

import domain  # FEE, CARD_PAY, LOAN word lists (v2)
import server  # transfer words and FX ratios (v2): transfer_like, PURCHASE, REFUND, FX_RATIO
from api import valid
from api.db import new_id, now
from parse import FEES, categorize, compile_rules, merchant_of

REVIEW_BELOW = 0.7  # confidence under this lands in the Review inbox
LINK_DAYS = 4       # the two legs of a transfer at most this many days apart
SMS_LINK_DAYS = 1   # two SMS legs: banks text within minutes, so a day is plenty
OWN_TRANSFER = 'Own transfer'
RULES = compile_rules(json.loads((Path(__file__).parent.parent / 'rules.json').read_text(encoding='utf-8')))
KIND_PURPOSE = {'emi': 'loan_payment', 'support': 'support', 'milestone': 'asset'}
KIND_CATEGORY = {'rent': 'Rent & EMI', 'emi': 'Rent & EMI', 'bill': 'Bills & Utilities', 'subscription': 'Subscriptions',
                 'insurance': 'Insurance', 'school': 'Education', 'support': 'Family'}
# A bounced/returned EMI or cheque: the bank's charge for it is a fee, even when the text names the loan.
BOUNCE = re.compile(r'bounce|dishono?u?r|insufficient (?:funds|bal)|\b(?:ecs|ach|nach|si|chq|cheque|emi|mandate)[ -]?(?:return|rtn|rej)'
                    r'|\breturn(?:ed)? (?:emi|ecs|ach|nach|chq|cheque|mandate|debit)', re.I)
CHARGE = re.compile(r'charge|\bchg|\bchrg|\bfee|penal', re.I)
SELECT = ('SELECT t.*, r.body AS raw_body, a.kind AS account_kind FROM transactions t '
          'LEFT JOIN raw_messages r ON r.id = t.raw_message_id AND r.household_id = t.household_id '
          'LEFT JOIN accounts a ON a.id = t.account_id AND a.household_id = t.household_id ')


def merchant_key(m):
    return ' '.join(re.sub(r'[^\w&@.\- ]+', ' ', (m or '').lower()).split())[:80]


def text_of(t):
    return f"{t.get('merchant') or ''} {t.get('raw_body') or t.get('merchant_raw') or ''}"


def merchant_name(body):
    return merchant_of(body or '')


def _rule_for(rules, merchant):
    """Exact merchant first, else the longest learned pattern found inside it as whole words."""
    m = merchant_key(merchant)
    if not m:
        return None
    if m in rules:
        return rules[m]
    inside = [k for k in rules if re.search(r'(?<!\w)' + re.escape(k) + r'(?!\w)', m)]
    return rules[max(inside, key=len)] if inside else None


def _within(t, o, days):
    return abs((date.fromisoformat(t['day']) - date.fromisoformat(o['day'])).days) <= days


def _pair(hh, t):
    """The other leg of a transfer for t, or None: opposite direction, another own account, same amount (or a
    plausible FX conversion), close in time, and transfer words where two SMS are involved."""
    if not t['account_id'] or (t['direction'] == 'debit' and server.PURCHASE.search(text_of(t))):
        return None
    lo, hi = (date.fromordinal(date.fromisoformat(t['day']).toordinal() + k).isoformat() for k in (-LINK_DAYS, LINK_DAYS))
    rows = hh.run(SELECT + "WHERE t.household_id = :hid AND t.direction = :d AND t.account_id IS NOT NULL AND t.account_id != :a "
                  "AND t.deleted_at IS NULL AND t.day >= :lo AND t.day <= :hi AND t.id != :id "
                  "AND t.id NOT IN (SELECT from_txn FROM txn_links WHERE household_id = :hid AND kind = 'transfer') "
                  "AND t.id NOT IN (SELECT to_txn FROM txn_links WHERE household_id = :hid AND kind = 'transfer') "
                  "AND t.id NOT IN (SELECT txn_id FROM txn_meta WHERE household_id = :hid AND set_by = 'user' AND purpose != 'transfer')",
                  d='credit' if t['direction'] == 'debit' else 'debit', a=t['account_id'], lo=lo, hi=hi, id=t['id'])
    debit_first = t['direction'] == 'debit'
    best = None
    for o in rows:
        d, c = (t, o) if debit_first else (o, t)
        if d is o and server.PURCHASE.search(text_of(o)):
            continue
        words_d, words_c = server.transfer_like({'body': text_of(d)}), server.transfer_like({'body': text_of(c)})
        sms = d['source'] == 'sms' and c['source'] == 'sms'
        if d['currency'] == c['currency']:
            if d['amount_minor'] != c['amount_minor'] or not _within(d, c, SMS_LINK_DAYS if sms else LINK_DAYS):
                continue
            if not (words_d and words_c if sms else words_d or words_c):
                continue
        else:
            rng = server.FX_RATIO.get((d['currency'], c['currency']))
            if not rng or not rng[0] <= c['amount_minor'] / d['amount_minor'] <= rng[1] or not words_d:
                continue
        gap = abs((datetime.fromisoformat(t['occurred_at']) - datetime.fromisoformat(o['occurred_at'])).total_seconds())
        if best is None or gap < best[0]:
            best = (gap, o)
    return best and best[1]


def _linked(hh, tid):
    return hh.one("SELECT * FROM txn_links WHERE household_id = :hid AND kind = 'transfer' AND (from_txn = :t OR to_txn = :t)", t=tid)


def infer(hh, t, ctx):
    """{purpose, category, confidence, person_member_id?, commitment_id?, liability_id?, asset_id?} for one transaction."""
    text, debit = text_of(t).lower(), t['direction'] == 'debit'
    out = lambda purpose, category, conf, **kw: {'purpose': purpose, 'category': category, 'confidence': conf, **kw}
    if _linked(hh, t['id']):
        return out('transfer', OWN_TRANSFER, 0.95)
    if ctx.get('pair', True):
        other = _pair(hh, t)
        if other:
            d, c = (t, other) if debit else (other, t)
            hh.insert('txn_links', kind='transfer', from_txn=d['id'], to_txn=c['id'], set_by='rule', created_at=now(),
                      fx_rate=None if d['currency'] == c['currency'] else round(c['amount_minor'] / d['amount_minor'], 6))
            ctx.setdefault('also', []).append(other['id'])
            return out('transfer', OWN_TRANSFER, 0.95)
    if debit and BOUNCE.search(text) and CHARGE.search(text):
        return out('fee', FEES, 0.9)
    if debit:
        for c in ctx['commitments']:
            if c['match_pattern'] and c['match_pattern'].lower() in text and c['currency'] == t['currency'] \
                    and c['amount_minor'] / 2 <= t['amount_minor'] <= c['amount_minor'] * 2:
                return out(KIND_PURPOSE.get(c['kind'], 'spend'), KIND_CATEGORY.get(c['kind'], t['category'] or 'Other'), 0.9,
                           commitment_id=c['id'], liability_id=c['liability_id'], asset_id=c['asset_id'],
                           person_member_id=c['for_member_id'] if c['kind'] == 'support' else None)
        for l in ctx['liabilities']:
            if l['match_pattern'] and l['match_pattern'].lower() in text and l['currency'] == t['currency']:
                return out('loan_payment', 'Rent & EMI', 0.9, liability_id=l['id'])
        for a in ctx['assets']:
            if a['match_pattern'] and a['match_pattern'].lower() in text:
                return out('asset', t['category'] or 'Other', 0.85, asset_id=a['id'])
    if not debit:  # a tenant's rent goes to its pot
        for f in ctx.get('pots', ()):
            if f['match_pattern'].lower() in text and f['currency'] == t['currency']:
                return out('income', 'Income', 0.9, fund_id=f['id'], person_contact_id=f['tenant_contact_id'])
    rule = _rule_for(ctx['rules'], t['merchant'])
    if rule and (rule['purpose'] or rule['category']):
        return out(rule['purpose'] or ('spend' if debit else 'income'), rule['category'] or t['category'] or 'Uncategorized', 0.9,
                   person_member_id=rule['person_member_id'], person_contact_id=rule['person_contact_id'])
    category = categorize(t['merchant'] or '', text, RULES)
    if debit and (category == FEES or domain.FEE.search(text)):
        return out('fee', FEES, 0.9)
    if domain.CARD_PAY.search(text) or (not debit and t.get('account_kind') == 'credit_card' and re.search(r'\bpayment\b', text)):
        return out('transfer', OWN_TRANSFER, 0.8)
    if debit and domain.LOAN.search(text):
        return out('loan_payment', 'Rent & EMI', 0.7)
    if not debit:
        if server.REFUND.search(text):
            return out('refund', category if category not in ('Uncategorized', 'Salary') else 'Income', 0.8)
        if category == 'Salary':
            return out('income', 'Salary', 0.95)
        return out('income', 'Income', 0.5)
    if category == 'Family':
        return out('support', 'Family', 0.7)
    return out('spend', category, 0.4 if category == 'Uncategorized' else 0.85)


def _context(hh, pair=True):
    return {'pair': pair,
            'commitments': hh.run('SELECT * FROM commitments WHERE household_id = :hid AND ended_at IS NULL'),
            'liabilities': hh.run('SELECT * FROM liabilities WHERE household_id = :hid AND closed_at IS NULL'),
            'assets': hh.run('SELECT * FROM assets WHERE household_id = :hid AND sold_at IS NULL'),
            'pots': hh.run("SELECT * FROM funds WHERE household_id = :hid AND closed_at IS NULL AND tenant_contact_id IS NOT NULL AND match_pattern != ''"),
            'rules': {r['pattern']: r for r in hh.run('SELECT * FROM merchant_rules WHERE household_id = :hid')}}


def save_meta(hh, txn_id, meta, set_by='rule'):
    cols = {'purpose': meta['purpose'], 'confidence': float(meta.get('confidence', 1.0)), 'set_by': set_by, 'updated_at': now(),
            **{k: meta.get(k) for k in ('person_member_id', 'person_contact_id', 'liability_id', 'asset_id', 'commitment_id', 'claim_id', 'fund_id')}}
    old = hh.one('SELECT claim_id, fund_id FROM txn_meta WHERE txn_id = :t AND household_id = :hid', t=txn_id)
    if old:  # a claim or fund the plan side attached stays attached
        cols['claim_id'] = cols['claim_id'] or old['claim_id']
        cols['fund_id'] = cols['fund_id'] or old['fund_id']
        hh.run(f'UPDATE txn_meta SET {", ".join(f"{k} = :{k}" for k in cols)} WHERE txn_id = :t AND household_id = :hid', t=txn_id, **cols)
    else:
        hh.db.run(f'INSERT INTO txn_meta (txn_id, household_id, {", ".join(cols)}) VALUES (:t, :h, {", ".join(":" + k for k in cols)})',
                  t=txn_id, h=hh.hid, **cols)  # txn_meta has no id column, so not Scoped.insert
    if meta.get('category'):
        hh.run('UPDATE transactions SET category = :c WHERE id = :t AND household_id = :hid', c=meta['category'], t=txn_id)


def reclassify(hh, txn_ids=None, pair=True):
    """Classify the household's transactions (all, or `txn_ids`) whose meaning the user hasn't set. plan.py calls this
    after a commitment/liability/asset is created or changed. Returns the ids it (re)classified."""
    where, params = '', {}
    if txn_ids is not None:
        txn_ids = list(txn_ids)
        if not txn_ids:
            return []
        sql, params = valid.inlist('i', txn_ids)
        where = f'AND t.id IN {sql} '
    rows = hh.run(SELECT + "WHERE t.household_id = :hid AND t.deleted_at IS NULL " + where +
                  "AND t.id NOT IN (SELECT txn_id FROM txn_meta WHERE household_id = :hid AND set_by = 'user') ORDER BY t.occurred_at, t.dedupe_key, t.id", **params)
    ctx, done = _context(hh, pair), []
    for t in rows:
        save_meta(hh, t['id'], infer(hh, t, ctx))
        done.append(t['id'])
    for other in set(ctx.get('also', [])) - set(done):  # the other leg of a new pair, unless the user set it
        if not hh.one("SELECT txn_id FROM txn_meta WHERE txn_id = :t AND household_id = :hid AND set_by = 'user'", t=other):
            save_meta(hh, other, {'purpose': 'transfer', 'category': OWN_TRANSFER, 'confidence': 0.95})
            done.append(other)
    return done


def apply_rule(hh, merchant, category='', purpose='', person_member_id=None, person_contact_id=None):
    """Learn a merchant correction and re-apply it to that merchant's past transactions (not ones the user set one by one)."""
    pattern = merchant_key(merchant)
    if not pattern:
        return []
    hh.run('DELETE FROM merchant_rules WHERE household_id = :hid AND pattern = :p', p=pattern)
    hh.insert('merchant_rules', id=new_id(), pattern=pattern, category=category, purpose=purpose,
              person_member_id=person_member_id, person_contact_id=person_contact_id, created_at=now())
    ids = [r['id'] for r in hh.run("SELECT id, merchant FROM transactions WHERE household_id = :hid AND deleted_at IS NULL AND merchant != ''")
           if _rule_for({pattern: True}, r['merchant'])]
    return reclassify(hh, ids)
