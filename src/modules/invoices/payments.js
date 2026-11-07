/**
 * Payments on a bill. Pure functions: no database, no clock, nothing but whole paise in and whole paise out.
 * The invoice service calls this once per bill; the tests call it directly.
 *
 * A bill is paid with one or more of cash / UPI / card. The amounts must add up to the bill total EXACTLY, in whole
 * paise: not "about", not "within a rupee". Everything is compared as integers, so 10.10 + 20.20 is 30.30 and never
 * 30.299999999999997.
 *
 * A tip is separate. It is extra money on top of the bill: it is not part of the total, it is not taxed, and it is
 * not paid against the bill, so it never takes part in the sum above.
 *
 * What is stored:
 *   invoice_payments   one row per method used (a bill made before payments existed has none)
 *   invoices.payment_method   the one method used, or 'split' when two or more were used
 */

const { toPaise } = require('../../utils/money');

const METHODS = ['cash', 'upi', 'card'];
const SPLIT = 'split';

const LABELS = { cash: 'cash', upi: 'UPI', card: 'card' };
const orderOf = (method) => METHODS.indexOf(method);

const wholePaise = (n, what) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a whole number of paise, zero or more (got ${n})`);
  return n;
};

/**
 * What the request says was paid: [{ method, paise }] in a fixed order (cash, UPI, card).
 *   `payments`       a list of { method, amount in rupees }
 *   `paymentMethod`  shorthand for "the whole bill, by this method" (what every client sent before payments could be split)
 * The caller's validation guarantees exactly one of them is present; if neither is, the result is empty and
 * check() will refuse it.
 */
function fromRequest({ paymentMethod, payments }, totalPaise) {
  if (payments?.length) {
    return payments.map((p) => ({ method: p.method, paise: toPaise(p.amount) })).sort((a, b) => orderOf(a.method) - orderOf(b.method));
  }
  if (paymentMethod) return [{ method: paymentMethod, paise: wholePaise(totalPaise, 'The bill total') }];
  return [];
}

const sum = (rows) => rows.reduce((s, r) => s + r.paise, 0);

/**
 * Do these payments settle this bill? Returns { ok, paid, difference } where difference is what is still to be paid
 * (positive) or what was paid too much (negative). Throws if the rows themselves are malformed, because rows that are
 * not whole paise, name an unknown method, or repeat a method must never be saved.
 */
function check(rows, totalPaise) {
  wholePaise(totalPaise, 'The bill total');
  if (!rows.length) return { ok: false, paid: 0, difference: totalPaise };
  const seen = new Set();
  for (const r of rows) {
    if (!METHODS.includes(r.method)) throw new RangeError(`Unknown payment method "${r.method}"`);
    if (seen.has(r.method)) throw new RangeError(`Payment method "${r.method}" appears more than once`);
    seen.add(r.method);
    wholePaise(r.paise, 'A payment');
  }
  const paid = sum(rows);
  return { ok: paid === totalPaise, paid, difference: totalPaise - paid };
}

/** What goes in invoices.payment_method: the one method used, or 'split' when there are two or more. */
const methodOnBill = (rows) => (rows.length > 1 ? SPLIT : rows[0].method);

/**
 * The payments of a bill as the API shows them, [{ method, amount }] in rupees, in the fixed order. A bill from before
 * payments existed has no rows: it was paid in full by invoices.payment_method, so that is what it shows.
 */
function forDisplay(rows, legacy) {
  if (rows.length) return [...rows].sort((a, b) => orderOf(a.method) - orderOf(b.method)).map((r) => ({ method: r.method, amount: Number(r.amount) }));
  return METHODS.includes(legacy?.method) ? [{ method: legacy.method, amount: Number(legacy.total) }] : [];
}

module.exports = { METHODS, SPLIT, LABELS, fromRequest, check, sum, methodOnBill, forDisplay };
