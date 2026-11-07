/**
 * Commission on a bill. Pure functions: no database, no clock, nothing but whole paise in and whole paise out.
 * The invoice service calls this once per bill; the tests call it directly.
 *
 * WHAT COMMISSION IS WORKED OUT ON  ("the base", written on every bill line as invoice_items.net_amount)
 *   A line's share of the bill's TAXABLE VALUE: what the customer actually paid for it, after the referral discount and
 *   any manual discount, and before GST. The shares of all lines add up to the taxable value to the paisa (see allocate).
 *   The tip is not part of it: a tip is not revenue and does not belong to one service.
 *   To change the base later (say, to the price before discounts) change only what the invoice service passes as `net`:
 *   nothing below cares where the number came from.
 *
 * WHICH RULE APPLIES
 *   A rule belongs to one person or to one service. If both match a line, the PERSON's rule wins.
 *   A combo has no single service, so only the person's rule can apply to it.
 *   No rule, no commission.
 *
 * HOW MUCH
 *   percent  the rule's percentage of the base, to the nearest paisa, halves up (the same rounding as GST)
 *   flat     the rule's rupees for each unit performed, but never more than the base: a line that took nothing in
 *            (a free service, a 100% discount) earns nothing, and commission can never be more than the line earned
 *
 * Every figure is an integer. A line keeps the rule it was made under, so changing a rule never changes an old bill.
 */

const { percentOf } = require('../invoices/gst');
const { toPaise } = require('../../utils/money');

const KINDS = ['percent', 'flat'];

const wholePaise = (n, what) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a whole number of paise, zero or more (got ${n})`);
  return n;
};

/**
 * Shares out `total` paise in proportion to `weights` (each a whole number of paise), in whole paise, so that the shares
 * add up to `total` EXACTLY. Each share is rounded down, and the paise left over go one each to the shares that lost the
 * most to rounding (the earlier line wins a tie). Uses BigInt: total × weight can be larger than a float holds exactly.
 *
 *   allocate(100, [1, 1, 1])  →  [34, 33, 33]
 */
function allocate(total, weights) {
  wholePaise(total, 'The amount to share out');
  weights.forEach((w) => wholePaise(w, 'A weight'));
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    if (total === 0) return weights.map(() => 0);
    throw new RangeError('Nothing to share the amount in proportion to');
  }
  const T = BigInt(total);
  const W = BigInt(sum);
  const parts = weights.map((w, i) => { const n = T * BigInt(w); return { i, q: n / W, r: n % W }; });
  const left = total - parts.reduce((s, p) => s + Number(p.q), 0);
  [...parts]
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
    .slice(0, left)
    .forEach((p) => { p.q += 1n; });
  return parts.map((p) => Number(p.q));
}

/** The rule that applies: the person's if they have one, else the service's, else none. A rule is { kind, value }. */
const pickRule = ({ performerRule = null, serviceRule = null } = {}) => performerRule ?? serviceRule ?? null;

/**
 * The commission on one line.  net = the line's base in paise, quantity = units performed, rule = { kind, value } or null.
 * Returns { kind, rate, amount }: the rule as it was that day (kind and value, both null for no rule) and the amount in paise.
 */
function forLine({ net, quantity = 1, rule = null }) {
  wholePaise(net, 'The base');
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError(`quantity must be a whole number, 1 or more (got ${quantity})`);
  if (!rule) return { kind: null, rate: null, amount: 0 };
  if (!KINDS.includes(rule.kind)) throw new RangeError(`Unknown commission kind "${rule.kind}"`);
  const value = Number(rule.value);
  if (!(value > 0)) throw new RangeError(`A commission value must be above 0 (got ${rule.value})`);
  const amount = rule.kind === 'percent'
    ? percentOf(net, value)
    : Math.min(toPaise(value) * quantity, net);
  return { kind: rule.kind, rate: value, amount };
}

module.exports = { KINDS, allocate, pickRule, forLine };
