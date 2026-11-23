"""Read the company travel-claim Excel files into plain item dicts, and store them as a claim linked to a trip.
Layouts: simple list (Sheet1: Bill Ref | Expense type | Amount in QR | Amount in SAR | Date), Pack lists (Travel_Misc and
Food_Daily sheets). The manager pack (one card per bill) is not read: use the Pack lists of the same trip.
CLI: python -m api.claims <household_id> <trip_id> <file.xlsx>"""
import re
import sys
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

QAR_TO_SAR = Decimal('1.08')
MONTHS = {m: i for i, m in enumerate('jan feb mar apr may jun jul aug sep oct nov dec'.split(), 1)}
DAY = re.compile(r'(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s*(\d{4})?')
AMOUNT = re.compile(r'(QAR|SAR)\s*([\d,]+(?:\.\d+)?)', re.I)


def minor(v):
    """'1,234.5' / 12 / None -> minor units (0 when empty or not a number, e.g. a dash)."""
    try:
        return int((Decimal(str(v).replace(',', '').strip()) * 100).to_integral_value(ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        return 0


def day_of(v):
    """A date cell or text like 'Mon 05 Oct 2026', '05 Oct 2026 (booked 03 Sep)', '05 Oct – 31 Oct 2026 (26 nights)' -> 'YYYY-MM-DD' of its first day."""
    if hasattr(v, 'date'):
        return v.date().isoformat()
    text = str(v or '')
    hit = DAY.search(text)
    if not hit or hit.group(2).lower() not in MONTHS:
        return ''
    year = hit.group(3) or (re.search(r'\d{4}', text) or [None])[0]
    return date(int(year), MONTHS[hit.group(2).lower()], int(hit.group(1))).isoformat() if year else ''


def _item(day, vendor, kind, receipt, receipt_cur, qar, sar, ref):
    return {'day': day, 'vendor': str(vendor or '').strip(), 'kind': str(kind or '').strip(), 'receipt_minor': receipt,
            'receipt_currency': receipt_cur, 'qar_minor': qar, 'sar_minor': sar, 'bill_ref': str(ref or '').strip()}


def _header(rows, first):
    """Index of the header row (the first of the first 8 rows whose first cell is `first`), found rather than fixed: title rows vary."""
    for i, r in enumerate(rows[:8]):
        if r and str(r[0] or '').strip().lower() == first:
            return i
    return None


def read_claim(path):
    """-> list of items {day, vendor, kind, receipt_minor, receipt_currency, qar_minor, sar_minor, bill_ref}. ValueError: no known layout."""
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    items = []
    for ws in wb:
        rows = [list(r) + [None] * 10 for r in ws.iter_rows(values_only=True)]
        h = _header(rows, 'bill ref')
        if h is not None:  # simple list
            last = None  # a row with amounts but no date or type continues the row above it
            for r in rows[h + 1:]:
                qar, sar = minor(r[2]), minor(r[3])
                if 'total' in (str(r[0]).strip().lower(), str(r[1]).strip().lower()) or not (qar or sar):
                    continue
                last = (day_of(r[4]), r[1]) if day_of(r[4]) else last
                if last:
                    items.append(_item(last[0], '', last[1], qar or sar, 'QAR' if qar else 'SAR', qar, sar, r[0]))
            continue
        h = _header(rows, 'date')
        if h is not None and 'claimed' in str(rows[h][3]).lower():  # Pack list: travel and misc
            for r in rows[h + 1:]:
                if not day_of(r[0]):
                    continue
                amounts = {c.upper(): minor(a) for c, a in AMOUNT.findall(str(r[3] or ''))}
                qar, sar = amounts.get('QAR', 0), amounts.get('SAR', 0)
                items.append(_item(day_of(r[0]), r[1], 'Travel', qar or sar, 'QAR' if qar else 'SAR', qar, sar, r[6] if len(r) > 6 else ''))
            continue
        h = _header(rows, 'day')
        if h is not None and 'claimed' in str(rows[h][5]).lower():  # Pack list: food, claimed in QAR only
            for r in rows[h + 1:]:
                if not day_of(r[0]):
                    continue
                qar = minor(r[5])
                sar = int((Decimal(qar) * QAR_TO_SAR).to_integral_value(ROUND_HALF_UP))
                items.append(_item(day_of(r[0]), r[2], 'Food', minor(r[4]), 'QAR', qar, sar, r[8] if len(r) > 8 else ''))
    if not items:
        raise ValueError('no claim rows found: expected a simple list or a Pack list (the manager pack is not supported)')
    return items


def import_claim(hh, trip_id, path, name=None):
    """Store the file as a draft claim of the trip. Importing the same name again replaces the earlier import. Returns {claim_id, items}."""
    from api.db import now
    name = name or Path(path).stem
    items = read_claim(path)
    with hh.db.tx():
        for old in hh.run('SELECT id FROM claims WHERE household_id = :hid AND trip_id = :t AND name = :n', t=trip_id, n=name):
            hh.run('DELETE FROM claim_lines WHERE household_id = :hid AND claim_id = :c', c=old['id'])
            hh.run('DELETE FROM claims WHERE household_id = :hid AND id = :c', c=old['id'])
        claim = hh.insert('claims', name=name, trip_id=trip_id, status='draft', created_at=now())
        for it in items:
            hh.insert('claim_lines', claim_id=claim['id'], **it)
    return {'claim_id': claim['id'], 'items': len(items)}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    from api.db import DB, Scoped
    db = DB()
    print(import_claim(Scoped(db, sys.argv[1]), sys.argv[2], sys.argv[3]))
