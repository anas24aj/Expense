"""Read a bank, card, wallet or loan statement (PDF, Excel .xlsx/.xls, CSV, or the HTML 'xls' some Indian banks send)
into rows: {day, desc, amount_minor, direction, balance_minor}. Columns are found from their header words (English
and Arabic); when a PDF's columns can't be told apart, the running balance says which way each amount went.
The file type is sniffed from its bytes, not its name."""
import csv
import io
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser

from parse import ARABIC_DIGITS

MONTHS = {m: i for i, m in enumerate('jan feb mar apr may jun jul aug sep oct nov dec'.split(), 1)}
_MON = r'(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*'
DATE = re.compile(rf'(\d{{4}})[-/.](\d{{1,2}})[-/.](\d{{1,2}})|(\d{{1,2}})[-/.](\d{{1,2}})[-/.](\d{{4}}|\d{{2}})(?!\d)'
                  rf'|(\d{{1,2}})[- ]({_MON})[- ,]*(\d{{4}}|\d{{2}})(?!\d)|({_MON})[- ](\d{{1,2}}),?[- ](\d{{4}})', re.I)
# Header words for each column. The first matching column wins, so 'Txn Date' beats a later 'Value Date'.
HEAD = {
    'date': re.compile(r'\bdate\b|\bdt\b|تاريخ', re.I),
    'desc': re.compile(r'narration|description|particulars|details|remarks|transaction|merchant|beneficiary|البيان|الوصف|التفاصيل|الشرح|العملية', re.I),
    'debit': re.compile(r'debit|withdrawal|\bdr\b|money out|paid out|مدين|سحب|مسحوب|خصم', re.I),
    'credit': re.compile(r'credit|deposit|\bcr\b|money in|paid in|دائن|إيداع|ايداع|مودع', re.I),
    'amount': re.compile(r'amount|\bamt\b|المبلغ|مبلغ', re.I),
    'balance': re.compile(r'balance|\bbal\b|الرصيد|رصيد', re.I),
    'type': re.compile(r'^\s*(?:dr\s*/\s*cr|cr\s*/\s*dr|type|txn type|d/c|c/d)\s*$', re.I),
}
NUMBER = re.compile(r'\(?-?\d[\d,]*(?:\.\d{1,3})?\)?(?:\s*(?:cr|dr)\b)?', re.I)
MONEY_TOKEN = re.compile(r'(?<![\w/:.-])\(?-?\d{1,3}(?:,\d{2,3})*(?:\.\d{2})\)?(?:\s{0,8}(?:cr|dr)\b)?(?![\w/:-])|(?<![\w/:.-])-?\d+\.\d{2}(?:\s{0,8}(?:cr|dr)\b)?(?![\w/:-])', re.I)
CR_DR = re.compile(r'\b(cr|dr)\.?\s*$', re.I)
SKIP_DESC = re.compile(r'^\s*(?:opening|closing|brought|carried)\s*(?:balance|forward)?|^\s*(?:b/f|c/f)\b|total', re.I)
PAGE_NOISE = re.compile(r'page\s*\d|statement of account|account (?:no|number|statement)|customer|ifsc|branch|generated on|this is a (?:computer|system)', re.I)
MAX_ROWS = 20000


class StatementError(ValueError):
    pass


def day_of(v):
    """'YYYY-MM-DD' from a cell: a date/datetime, or text such as 05/02/2025, 2025-02-05, 05-Feb-25, Feb 5, 2025.
    Day first, as Indian and Saudi banks write it (a 'month' above 12 means the file is month first)."""
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    m = DATE.search(str(v or '').translate(ARABIC_DIGITS))
    if not m:
        return None
    g = m.groups()
    try:
        if g[0]:
            y, mo, d = int(g[0]), int(g[1]), int(g[2])
        elif g[3]:
            d, mo, y = int(g[3]), int(g[4]), int(g[5])
            if mo > 12 and d <= 12:
                d, mo = mo, d
        elif g[6]:
            d, mo, y = int(g[6]), MONTHS[g[7][:3].lower()], int(g[8])
        else:
            mo, d, y = MONTHS[g[9][:3].lower()], int(g[10]), int(g[11])
        y += 2000 if y < 100 else 0
        return date(y, mo, d).isoformat() if 1990 < y < 2100 else None
    except (ValueError, KeyError):
        return None


def minor_of(v):
    """Amount in paise/halalas from a cell; sign: '-', '(…)' or a 'Dr' suffix is negative. None if not a number."""
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return round(Decimal(str(v)) * 100)
    s = str(v).translate(ARABIC_DIGITS).strip()
    neg = s.startswith('(') and s.endswith(')') or s.startswith('-') or bool(re.search(r'\bdr\.?$', s, re.I))
    s = re.sub(r'(?i)\b(?:cr|dr)\.?$|[^\d.]', '', s)
    if not s or s.count('.') > 1:
        return None
    try:
        n = round(Decimal(s) * 100)
    except InvalidOperation:
        return None
    return -n if neg else n


# ---------- tables (Excel, CSV, HTML) ----------

def _header(row):
    """{'date': col, ...} if this row is a header row: a date column and money columns."""
    cols = {}
    for i, cell in enumerate(row):
        text = str(cell or '').strip()
        if not text or len(text) > 40:
            continue
        for key in ('type', 'balance', 'date', 'debit', 'credit', 'amount', 'desc'):
            if HEAD[key].search(text):
                if key == 'date' and 'date' in cols:
                    break  # 'Value Date' after 'Txn Date'
                if key not in cols:
                    cols[key] = i
                break
    if 'date' in cols and ({'debit', 'credit'} <= cols.keys() or 'amount' in cols):
        return cols
    return None


def rows_from_table(table):
    """Transactions from a grid of cells (any number of title rows above the header row)."""
    out, cols = [], None
    for row in table:
        row = list(row)
        if cols is None:
            cols = _header(row)
            continue
        if _header(row):  # a repeated header on the next page of an export
            continue
        cell = lambda k: row[cols[k]] if k in cols and cols[k] < len(row) else None
        day = day_of(cell('date'))
        desc = ' '.join(str(row[i]).strip() for i in sorted({cols.get('desc', -1)} - {-1}) if i < len(row) and row[i] not in (None, ''))
        if not day:
            if out and desc and not any(minor_of(cell(k)) for k in ('debit', 'credit', 'amount')):
                out[-1]['desc'] = (out[-1]['desc'] + ' ' + desc).strip()[:240]  # a narration wrapped onto the next row
            continue
        if SKIP_DESC.match(desc):
            continue
        debit, credit = minor_of(cell('debit')), minor_of(cell('credit'))
        if debit or credit:
            amount, direction = (abs(debit), 'debit') if debit else (abs(credit), 'credit')
        else:
            a = minor_of(cell('amount'))
            if not a:
                continue
            kind = str(cell('type') or '').strip().lower()
            raw = str(cell('amount') or '')
            direction = ('debit' if kind.startswith('d') or a < 0 or re.search(r'\bdr\.?$', raw, re.I) else
                         'credit' if kind.startswith('c') or re.search(r'\bcr\.?$', raw, re.I) else None)
            amount = abs(a)
        out.append({'day': day, 'desc': desc[:240], 'amount_minor': amount, 'direction': direction,
                    'balance_minor': minor_of(cell('balance'))})
    return out, cols is not None


def _xlsx(data):
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    return [list(ws.iter_rows(values_only=True)) for ws in wb.worksheets]


def _xls(data):
    import xlrd
    book = xlrd.open_workbook(file_contents=data)
    sheets = []
    for sh in book.sheets():
        grid = []
        for r in range(sh.nrows):
            row = []
            for c in range(sh.ncols):
                v, t = sh.cell_value(r, c), sh.cell_type(r, c)
                row.append(xlrd.xldate_as_datetime(v, book.datemode) if t == xlrd.XL_CELL_DATE else v)
            grid.append(row)
        sheets.append(grid)
    return sheets


class _Tables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.tables.append([])
        elif tag == 'tr' and self.tables:
            self.row = []
        elif tag in ('td', 'th') and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.cell is not None:
            self.row.append(' '.join(''.join(self.cell).split()))
            self.cell = None
        elif tag == 'tr' and self.row is not None:
            self.tables[-1].append(self.row)
            self.row = None

    def handle_data(self, d):
        if self.cell is not None:
            self.cell.append(d)


def _text(data):
    for enc in ('utf-8-sig', 'utf-16', 'cp1252'):
        try:
            text = data.decode(enc)
            if enc != 'utf-16' or '\x00' not in text:
                return text
        except UnicodeDecodeError:
            pass
    return data.decode('latin-1')


def _csv(data):
    text = _text(data)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=',;\t|')
    except csv.Error:
        dialect = csv.excel
    return [list(csv.reader(io.StringIO(text), dialect))]


# ---------- PDF ----------

def _pdf_lines(data, password):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try:
            ok = reader.decrypt(password or '')
        except Exception as e:  # AES needs the 'cryptography' package; a wrong key raises on some files
            raise StatementError(f'could not open the locked PDF: {e}')
        if not ok:
            raise StatementError('this PDF is locked: type its password (often in the bank\'s email) and try again'
                                 if not password else 'that password did not open the PDF')
    lines = []
    for page in reader.pages:
        try:
            text = page.extract_text(extraction_mode='layout')
        except Exception:
            text = page.extract_text()
        lines += [l.rstrip() for l in (text or '').splitlines() if l.strip()]
    return lines


def _columns(line):
    """Centre positions of the money column headers in a PDF header line."""
    cols = {}
    for m in re.finditer(r'\S+(?: \S+)*', line):
        word = m.group(0)
        if HEAD['type'].search(word):
            continue
        for key in ('balance', 'debit', 'credit', 'amount'):
            if HEAD[key].search(word):
                cols.setdefault(key, (m.start() + m.end()) / 2)
                break
    return cols


def rows_from_lines(lines):
    """Transactions from a PDF's text lines: a line that starts with a date (after an optional serial number) and
    ends in amounts is a row; lines without a date after it continue its description. Each amount goes to the
    nearest money column of the header line; without one, the last amount is the balance."""
    out, cols = [], {}
    start = re.compile(rf'^\s*(?:\d{{1,5}}\s+)?({DATE.pattern})', re.I)
    for line in lines:
        text = line.translate(ARABIC_DIGITS)
        m = start.match(text)
        if not m and not MONEY_TOKEN.search(text) and len(found := _columns(text)) >= 2:
            cols = found  # the header line (again on each page)
            continue
        money = list(MONEY_TOKEN.finditer(text))
        if not m or not money or money[-1].start() < m.end():
            if out and not m and not money and not PAGE_NOISE.search(text) and len(text.strip()) < 120 and not out[-1].get('closed'):
                out[-1]['desc'] = (out[-1]['desc'] + ' ' + ' '.join(text.split())).strip()[:240]
            elif out:
                out[-1]['closed'] = True
            continue
        day = day_of(m.group(1))
        if not day:
            continue
        rest = text[m.end():money[0].start()]
        rest = DATE.sub(' ', rest, count=1) if DATE.match(rest.strip()) else rest  # a value date after the txn date
        desc = ' '.join(rest.split())
        if SKIP_DESC.match(desc):
            continue
        row = {'day': day, 'desc': desc[:240], 'amount_minor': None, 'direction': None, 'balance_minor': None}
        amounts = []
        for tok in money:
            v = minor_of(tok.group(0))
            centre = (tok.start() + tok.end()) / 2
            key = min(cols, key=lambda k: abs(cols[k] - centre)) if cols else None
            amounts.append((key, v, tok.group(0)))
        if cols:
            for key, v, raw in amounts:
                if key == 'balance':
                    row['balance_minor'] = abs(v) * (-1 if CR_DR.search(raw) and CR_DR.search(raw).group(1).lower() == 'dr' else 1)
                elif key in ('debit', 'credit') and v:
                    row['amount_minor'], row['direction'] = abs(v), key
                elif key == 'amount' and v:
                    row['amount_minor'] = abs(v)
                    row['direction'] = 'debit' if v < 0 else 'credit' if CR_DR.search(raw) else None
        if row['amount_minor'] is None:  # no header seen: amount, then balance
            if len(amounts) >= 2:
                row['amount_minor'], row['balance_minor'] = abs(amounts[-2][1]), amounts[-1][1]
                raw = amounts[-2][2]
            else:
                row['amount_minor'], raw = abs(amounts[0][1]), amounts[0][2]
            if CR_DR.search(raw):
                row['direction'] = 'debit' if CR_DR.search(raw).group(1).lower() == 'dr' else 'credit'
        if row['amount_minor']:
            out.append(row)
    for r in out:
        r.pop('closed', None)
    return out


def by_balance(rows):
    """Fill in missing directions from the running balance (in either order the file lists them), and say how
    many rows the balances confirm."""
    def fits(seq):
        n = 0
        for prev, r in zip(seq, seq[1:]):
            if prev['balance_minor'] is None or r['balance_minor'] is None:
                continue
            change = r['balance_minor'] - prev['balance_minor']
            if change == r['amount_minor'] or change == -r['amount_minor']:
                n += 1
        return n
    seq = rows if fits(rows) >= fits(rows[::-1]) else rows[::-1]
    checked = 0
    for prev, r in zip(seq, seq[1:]):
        if prev['balance_minor'] is None or r['balance_minor'] is None:
            continue
        change = r['balance_minor'] - prev['balance_minor']
        if abs(change) == r['amount_minor']:
            way = 'credit' if change > 0 else 'debit'
            checked += r['direction'] in (None, way)
            r['direction'] = r['direction'] or way
    return checked


def read_statement(data, password=None):
    """{'rows': [...], 'checked': rows confirmed by the balance, 'currency': guess or None, 'kind': file type}."""
    head = data[:8]
    if head.startswith(b'%PDF'):
        kind = 'PDF'
        lines = _pdf_lines(data, password)
        rows, text = rows_from_lines(lines), '\n'.join(lines)
        if not lines:
            raise StatementError('this PDF has no text (a scan or photo): download the statement from the bank\'s website or app instead')
    else:
        if head.startswith(b'PK'):
            kind, sheets = 'Excel', _xlsx(data)
        elif head.startswith(b'\xd0\xcf\x11\xe0'):
            kind, sheets = 'Excel', _xls(data)
        elif b'<table' in data[:200000].lower():
            parser = _Tables()
            parser.feed(_text(data))
            kind, sheets = 'Excel', parser.tables
        else:
            kind, sheets = 'CSV', _csv(data)
        rows, found = [], False
        for sheet in sheets:
            got, header = rows_from_table(sheet)
            rows, found = rows + got, found or header
        if not found:
            raise StatementError('no table with Date and Debit/Credit (or Amount) columns was found in this file')
        text = '\n'.join(' '.join(str(c) for c in r if c is not None) for s in sheets for r in s[:60])
    if len(rows) > MAX_ROWS:
        raise StatementError(f'more than {MAX_ROWS} rows: split the statement by year')
    checked = by_balance(rows)
    for r in rows:  # still unknown: words in the description
        if r['direction'] is None:
            r['direction'] = 'credit' if re.search(r'\b(?:credit|cr|received|deposit|salary|refund|reversal|inward)\b|إيداع|راتب', r['desc'], re.I) else 'debit'
    t = text.lower()
    counts = {'SAR': len(re.findall(r'\bsar\b|ريال|\bsr\b', t)), 'INR': len(re.findall(r'\binr\b|₹|\brs\.?\s', t)), 'USD': len(re.findall(r'\busd\b', t))}
    currency = max(counts, key=counts.get) if max(counts.values()) else None
    return {'rows': rows, 'checked': checked, 'currency': currency, 'kind': kind}


def span(rows):
    days = sorted(r['day'] for r in rows)
    return (days[0], days[-1]) if days else (None, None)


def within(a, b, days):
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days) <= days


def shift(day, n):
    return (date.fromisoformat(day) + timedelta(days=n)).isoformat()
