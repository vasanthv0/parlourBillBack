/**
 * GST on a bill. Pure functions: no database, no clock, nothing but whole paise in and whole paise out.
 * The invoice service calls this once per bill; the tests call it directly.
 *
 * The order of everything, which is also the order printed on the bill:
 *
 *   subtotal              services and combos at the menu price
 *   − referral discount   the referrer's percentage of the subtotal
 *   − discount            any extra amount the counter takes off
 *   = payable             what is left
 *
 *   exclusive prices (GST is added on top of the menu price)
 *     tax     = payable × rate / 100
 *     total   = payable + tax          taxable value = payable
 *
 *   inclusive prices (the menu price already contains GST)
 *     tax     = payable × rate / (100 + rate)
 *     total   = payable                taxable value = payable − tax
 *
 * Either way:  taxable value + tax = total,  and  cgst + sgst = tax.
 *
 * Rounding: every division rounds to the nearest paisa, and exactly half a paisa rounds UP. It is done on integers,
 * not floating point, so 2.5% of ₹10.10 is never 25.249999… paise. When the tax is an odd number of paise the
 * extra paisa goes to CGST, so CGST is never less than SGST and the two always add up to the tax exactly.
 */

const MODES = ['exclusive', 'inclusive'];

const wholePaise = (n, what) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a whole number of paise, zero or more (got ${n})`);
  return n;
};

/** A percentage with up to 2 decimals as hundredths of a percent: 5 → 500, 2.5 → 250, 12.5 → 1250, "18.00" → 1800. */
const toBasisPoints = (percent) => {
  const bp = Math.round(Number(percent) * 100);
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new RangeError(`A percentage must be from 0 to 100 (got ${percent})`);
  return bp;
};

/** n ÷ d rounded to the nearest whole number, halves up. For whole n ≥ 0 and d > 0. */
const roundDiv = (n, d) => {
  const twice = 2 * n + d;
  if (!Number.isSafeInteger(twice)) throw new RangeError('That amount is too large to calculate exactly');
  return Math.floor(twice / (2 * d));
};

/** `percent` of an amount in paise, to the nearest paisa (halves up). Used for the referral discount. */
const percentOf = (paise, percent) => roundDiv(wholePaise(paise, 'The amount') * toBasisPoints(percent), 10_000);

/** Splits the tax into CGST and SGST. An odd paisa goes to CGST. */
const splitTax = (tax) => {
  wholePaise(tax, 'The tax');
  const sgst = Math.floor(tax / 2);
  return { cgst: tax - sgst, sgst };
};

/**
 * The whole bill, from the subtotal down to the total. All amounts are whole paise.
 * `referral` and `discount` have already been checked by the caller; they are checked again here
 * because a bill that does not add up must never be saved.
 */
function computeBill({ subtotal, referral = 0, discount = 0, taxPercent, priceMode }) {
  if (!MODES.includes(priceMode)) throw new RangeError(`priceMode must be "exclusive" or "inclusive" (got ${priceMode})`);
  wholePaise(subtotal, 'The subtotal');
  wholePaise(referral, 'The referral discount');
  wholePaise(discount, 'The discount');
  if (referral + discount > subtotal) throw new RangeError('The discounts cannot be more than the subtotal');

  const payable = subtotal - referral - discount;
  const bp = toBasisPoints(taxPercent);

  const inclusive = priceMode === 'inclusive';
  const tax = inclusive ? roundDiv(payable * bp, 10_000 + bp) : roundDiv(payable * bp, 10_000);
  const total = inclusive ? payable : payable + tax;
  const { cgst, sgst } = splitTax(tax);

  return { priceMode, subtotal, referral, discount, taxable: total - tax, tax, cgst, sgst, total };
}

/** Each of CGST and SGST is half the rate (5% → 2.5% + 2.5%). */
const halfRate = (taxPercent) => Number(taxPercent) / 2;

module.exports = { MODES, toBasisPoints, roundDiv, percentOf, splitTax, computeBill, halfRate };
