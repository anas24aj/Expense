import type { Money } from '../api/types';

const SYMBOL: Record<string, string> = { INR: '₹', SAR: 'SAR ', USD: '$', AED: 'AED ', EUR: '€', GBP: '£' };
const DIGITS: Record<string, number> = { INR: 2, SAR: 2 };

/** 1234567.5 INR → "₹12,34,567.50" (Indian grouping); SAR → "SAR 1,234,567.50". */
export function fmt(m: Money | null | undefined, opts: { cents?: boolean; sign?: boolean; compact?: boolean } = {}) {
  if (!m) return '—';
  const digits = DIGITS[m.currency] ?? 2;
  const v = m.minor / 10 ** digits;
  const neg = v < 0;
  const abs = Math.abs(v);
  const sym = SYMBOL[m.currency] ?? m.currency + ' ';
  let body: string;
  if (opts.compact && m.currency === 'INR' && abs >= 1e5) {
    body = abs >= 1e7 ? trim(abs / 1e7) + ' Cr' : trim(abs / 1e5) + ' L';
  } else if (opts.compact && abs >= 1e4) {
    body = abs >= 1e6 ? trim(abs / 1e6) + 'M' : trim(abs / 1e3) + 'K';
  } else {
    const cents = opts.cents ?? (abs < 1000 && abs % 1 !== 0);
    body = new Intl.NumberFormat(m.currency === 'INR' ? 'en-IN' : 'en-US', {
      minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
    }).format(abs);
  }
  return (neg ? '−' : opts.sign ? '+' : '') + sym + body;
}
const trim = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export const major = (m: Money) => m.minor / 10 ** (DIGITS[m.currency] ?? 2);
export const toMinor = (v: number, currency: string) => Math.round(v * 10 ** (DIGITS[currency] ?? 2));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym: string, long = false) => {
  const [y, m] = ym.split('-').map(Number);
  return long ? new Date(y, m - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' }) : MONTHS[m - 1];
};
export const shiftMonth = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const thisMonth = () => new Date().toISOString().slice(0, 7);
export const today = () => new Date().toISOString().slice(0, 10);

export function dayLabel(day: string) {
  const d = new Date(day + 'T00:00:00');
  const t = new Date(today() + 'T00:00:00');
  const diff = Math.round((t.getTime() - d.getTime()) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'short' });
}
export function dueLabel(day: string) {
  const d = new Date(day + 'T00:00:00');
  const diff = Math.round((d.getTime() - new Date(today() + 'T00:00:00').getTime()) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 0) return `${-diff}d late`;
  if (diff < 7) return `In ${diff} days`;
  return d.toLocaleDateString('en', { day: 'numeric', month: 'short' });
}
export const shortDate = (day: string) => new Date(day + 'T00:00:00').toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });

// self-check: Indian grouping, compact lakh/crore, SAR, negatives (runs once per load; cheap)
if (import.meta.env.DEV) {
  const eq = (a: string, b: string) => { if (a !== b) console.error(`fmt self-check: ${a} !== ${b}`); };
  eq(fmt({ minor: 123456750, currency: 'INR' }), '₹12,34,568');
  eq(fmt({ minor: 123456750, currency: 'INR' }, { compact: true }), '₹12.3 L');
  eq(fmt({ minor: 2_50_00_000_00, currency: 'INR' }, { compact: true }), '₹2.5 Cr');
  eq(fmt({ minor: 1234550, currency: 'SAR' }), 'SAR 12,346');
  eq(fmt({ minor: 10_000_000, currency: 'SAR' }, { compact: true }), 'SAR 100K');
  eq(fmt({ minor: -4550, currency: 'SAR' }), '−SAR 45.50');
}
