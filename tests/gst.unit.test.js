// No database, no API, no packages: node --test tests/gst.unit.test.js   (also part of: npm run test:unit)
// The GST arithmetic, to the paisa. Every amount here is whole paise (₹1 = 100).
const test = require('node:test');
const assert = require('node:assert/strict');
const gst = require('../src/modules/invoices/gst');

const bill = (subtotal, taxPercent, priceMode, referral = 0, discount = 0) => gst.computeBill({ subtotal, referral, discount, taxPercent, priceMode });
const pick = (b) => [b.taxable, b.tax, b.cgst, b.sgst, b.total];

// ───────────── hand-worked bills (the same table is in billfront/src/app/core/gst.spec.ts) ─────────────
// [what it is, subtotal, rate %, mode, referral, discount, expected [taxable, tax, cgst, sgst, total]]
const VECTORS = [
  // GST added on top
  ['₹1,000 − ₹100 referral − ₹50 off, 5% on top: tax ₹42.50, total ₹892.50', 100000, 5, 'exclusive', 10000, 5000, [85000, 4250, 2125, 2125, 89250]],
  ['no discounts, 18% on ₹499: tax is exactly ₹89.82', 49900, 18, 'exclusive', 0, 0, [49900, 8982, 4491, 4491, 58882]],
  ['18% on ₹499.99: ₹89.9982 rounds up to ₹90.00', 49999, 18, 'exclusive', 0, 0, [49999, 9000, 4500, 4500, 58999]],
  ['2.5% on ₹10.10: 25.25 paise rounds down to 25; the odd paisa is on CGST', 1010, 2.5, 'exclusive', 0, 0, [1010, 25, 13, 12, 1035]],
  ['2.5% on ₹10.20: exactly 25.5 paise rounds UP to 26', 1020, 2.5, 'exclusive', 0, 0, [1020, 26, 13, 13, 1046]],
  ['5% on 50 paise: exactly 2.5 paise rounds up to 3, split 2 + 1', 50, 5, 'exclusive', 0, 0, [50, 3, 2, 1, 53]],
  ['5% on 10 paise: exactly half a paisa rounds up to 1, all of it on CGST', 10, 5, 'exclusive', 0, 0, [10, 1, 1, 0, 11]],
  ['5% on 4 paise: 0.2 paise rounds to nothing', 4, 5, 'exclusive', 0, 0, [4, 0, 0, 0, 4]],
  ['0% GST: no tax, no split', 123456, 0, 'exclusive', 0, 0, [123456, 0, 0, 0, 123456]],
  ['everything discounted away: nothing to tax', 50000, 18, 'exclusive', 50000, 0, [0, 0, 0, 0, 0]],
  // GST already inside the price
  ['₹1,000 with 5% inside: tax ₹47.62 (47.619…), taxable ₹952.38', 100000, 5, 'inclusive', 0, 0, [95238, 4762, 2381, 2381, 100000]],
  ['₹1,180 with 18% inside: tax is exactly ₹180', 118000, 18, 'inclusive', 0, 0, [100000, 18000, 9000, 9000, 118000]],
  ['₹999 with 18% inside: tax ₹152.39 (152.389…), odd paisa on CGST', 99900, 18, 'inclusive', 0, 0, [84661, 15239, 7620, 7619, 99900]],
  ['₹1,000 − ₹100 referral − ₹50 off, 5% inside: customer pays ₹850, tax ₹40.48', 100000, 5, 'inclusive', 10000, 5000, [80952, 4048, 2024, 2024, 85000]],
  ['12% inside 14 paise: exactly 1.5 paise rounds up to 2', 14, 12, 'inclusive', 0, 0, [12, 2, 1, 1, 14]],
  ['0% inside: the whole price is the taxable value', 55500, 0, 'inclusive', 0, 0, [55500, 0, 0, 0, 55500]],
  ['inclusive, everything discounted away', 50000, 18, 'inclusive', 20000, 30000, [0, 0, 0, 0, 0]],
];

for (const [what, subtotal, rate, mode, referral, discount, expected] of VECTORS) {
  test(`worked example: ${what}`, () => {
    const b = bill(subtotal, rate, mode, referral, discount);
    assert.deepEqual(pick(b), expected);
    assert.equal(b.priceMode, mode);
  });
}

test('a bill is the same whether the discounts are named or left out', () => {
  assert.deepEqual(gst.computeBill({ subtotal: 5000, taxPercent: 5, priceMode: 'exclusive' }), bill(5000, 5, 'exclusive', 0, 0));
});

// ───────────── the rules that must always hold ─────────────

// A different way of rounding, kept deliberately apart from the code under test: whole part and remainder, with BigInt.
const exactTax = (payable, rate, mode) => {
  const bp = BigInt(Math.round(rate * 100));
  const num = BigInt(payable) * bp;
  const den = mode === 'inclusive' ? 10000n + bp : 10000n;
  const whole = num / den;
  const rest = num % den;
  return Number(2n * rest >= den ? whole + 1n : whole); // nearest, halves up
};

// A repeatable pseudo-random sequence, so a failure can be reproduced.
let seed = 20261102;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const RATES = [0, 0.25, 1.5, 2.5, 3, 5, 6, 9, 12, 12.5, 14, 18, 28, 100];
const REFERRAL_PERCENTS = [0, 5, 7.35, 10, 12.5, 20, 100];

test('20,000 random bills: the tax is the nearest paisa, the parts add up, and CGST + SGST is exactly the tax', () => {
  for (let n = 0; n < 20_000; n++) {
    const subtotal = rand() < 0.1 ? between(0, 5_000_000_000) : between(0, 2_000_000);
    const mode = rand() < 0.5 ? 'inclusive' : 'exclusive';
    const rate = RATES[between(0, RATES.length - 1)];
    const referral = gst.percentOf(subtotal, REFERRAL_PERCENTS[between(0, REFERRAL_PERCENTS.length - 1)]);
    const discount = rand() < 0.5 ? 0 : between(0, subtotal - referral);
    const payable = subtotal - referral - discount;
    const b = bill(subtotal, rate, mode, referral, discount);
    const ctx = JSON.stringify({ subtotal, rate, mode, referral, discount, b });

    assert.equal(b.tax, exactTax(payable, rate, mode), `tax is the nearest paisa: ${ctx}`);
    assert.equal(b.cgst + b.sgst, b.tax, `cgst + sgst = tax: ${ctx}`);
    assert.ok(b.cgst - b.sgst === 0 || b.cgst - b.sgst === 1, `the odd paisa is on CGST, never on SGST: ${ctx}`);
    assert.equal(b.taxable + b.tax, b.total, `taxable value + tax = total: ${ctx}`);
    assert.equal(b.total, mode === 'inclusive' ? payable : payable + b.tax, `total: ${ctx}`);
    assert.equal(b.taxable, mode === 'inclusive' ? payable - b.tax : payable, `taxable value: ${ctx}`);
    assert.ok(b.taxable >= 0 && b.tax >= 0 && b.sgst >= 0, `nothing is negative: ${ctx}`);
    for (const v of Object.values(pick(b))) assert.ok(Number.isSafeInteger(v), `whole paise only: ${ctx}`);
  }
});

test('more to pay never means less tax (checked paisa by paisa, both ways of pricing)', () => {
  for (const mode of ['exclusive', 'inclusive']) {
    for (const rate of [2.5, 5, 12, 18, 28]) {
      let last = -1;
      for (let paise = 0; paise <= 6000; paise++) {
        const { tax } = bill(paise, rate, mode);
        assert.ok(tax >= last, `${mode} ${rate}% at ${paise} paise`);
        last = tax;
      }
    }
  }
});

test('inclusive and exclusive agree: pricing ₹x + GST on top, and ₹x + GST inside, give the same split of the same total', () => {
  for (const rate of [5, 12, 18, 28]) {
    for (let taxable = 0; taxable <= 3000; taxable += 7) {
      const on = bill(taxable, rate, 'exclusive');                 // customer pays taxable + tax
      const inside = bill(on.total, rate, 'inclusive');            // the same total, priced as GST-inclusive
      assert.ok(Math.abs(inside.tax - on.tax) <= 1, `${rate}% on ${taxable}: ${on.tax} vs ${inside.tax}`);   // may differ by a paisa of rounding, no more
      assert.equal(inside.total, on.total);
    }
  }
});

// ───────────── the referral percentage uses the same exact rounding ─────────────

test('referral discount: percent of the subtotal, nearest paisa, halves up', () => {
  assert.equal(gst.percentOf(100000, 10), 10000);
  assert.equal(gst.percentOf(12345, 12.5), 1543);   // 1543.125
  assert.equal(gst.percentOf(10, 5), 1);            // exactly half a paisa
  assert.equal(gst.percentOf(0, 10), 0);
  assert.equal(gst.percentOf(777, 100), 777);
  assert.equal(gst.percentOf(777, '0.00'), 0);      // numeric(5,2) comes back from the database as a string
  assert.equal(gst.percentOf(100000, '10.00'), 10000);
});

test('referral discount: percentages that floating point gets wrong by a paisa are exact here', () => {
  // The earlier formula, Math.round(paise * percent / 100), gave 34, 28 and 56 for these. The true values are exact ties.
  assert.equal(gst.percentOf(3000, 1.15), 35);      // 34.5
  assert.equal(gst.percentOf(5000, 0.57), 29);      // 28.5
  assert.equal(gst.percentOf(5000, 1.13), 57);      // 56.5
  assert.equal(Math.round((3000 * 1.15) / 100), 34, 'the old formula really did round this one down');
});

test('referral discount: for ordinary percentages the exact maths gives the same answer as the formula it replaced', () => {
  for (const percent of [1, 2.5, 5, 7.5, 8, 10, 12, 12.5, 15, 18, 20, 25, 50]) {
    for (let paise = 0; paise <= 120_000; paise += 3) {
      assert.equal(gst.percentOf(paise, percent), Math.round((paise * percent) / 100), `${percent}% of ${paise}`);
    }
  }
});

// ───────────── the split ─────────────

test('splitTax: halves, with the odd paisa on CGST', () => {
  assert.deepEqual(gst.splitTax(0), { cgst: 0, sgst: 0 });
  assert.deepEqual(gst.splitTax(1), { cgst: 1, sgst: 0 });
  assert.deepEqual(gst.splitTax(2), { cgst: 1, sgst: 1 });
  assert.deepEqual(gst.splitTax(4251), { cgst: 2126, sgst: 2125 });
  for (let tax = 0; tax < 500; tax++) {
    const { cgst, sgst } = gst.splitTax(tax);
    assert.equal(cgst + sgst, tax);
    assert.equal(cgst - sgst, tax % 2);
  }
});

test('halfRate: CGST and SGST are each half the rate', () => {
  assert.equal(gst.halfRate(5), 2.5);
  assert.equal(gst.halfRate('18.00'), 9);
  assert.equal(gst.halfRate(28), 14);
  assert.equal(gst.halfRate(0), 0);
});

// ───────────── bad input is refused, never guessed at ─────────────

test('a bill that cannot be right is refused', () => {
  const ok = { subtotal: 1000, taxPercent: 5, priceMode: 'exclusive' };
  assert.throws(() => gst.computeBill({ ...ok, priceMode: undefined }), /priceMode/);
  assert.throws(() => gst.computeBill({ ...ok, priceMode: 'both' }), /priceMode/);
  assert.throws(() => gst.computeBill({ ...ok, subtotal: -1 }), /whole number of paise/);
  assert.throws(() => gst.computeBill({ ...ok, subtotal: 10.5 }), /whole number of paise/, 'rupees with a fraction of a paisa');
  assert.throws(() => gst.computeBill({ ...ok, subtotal: NaN }), /whole number of paise/);
  assert.throws(() => gst.computeBill({ ...ok, referral: -5 }), /whole number of paise/);
  assert.throws(() => gst.computeBill({ ...ok, discount: 1.5 }), /whole number of paise/);
  assert.throws(() => gst.computeBill({ ...ok, referral: 600, discount: 401 }), /more than the subtotal/);
  assert.throws(() => gst.computeBill({ ...ok, taxPercent: -1 }), /0 to 100/);
  assert.throws(() => gst.computeBill({ ...ok, taxPercent: 100.01 }), /0 to 100/);
  assert.throws(() => gst.computeBill({ ...ok, taxPercent: 'abc' }), /0 to 100/);
  assert.throws(() => gst.computeBill({ ...ok, taxPercent: undefined }), /0 to 100/);
  assert.doesNotThrow(() => gst.computeBill({ ...ok, referral: 600, discount: 400 }), 'discounts equal to the subtotal are allowed');
  assert.throws(() => gst.splitTax(-1), /whole number of paise/);
  assert.throws(() => gst.percentOf(100, 101), /0 to 100/);
});

test('an amount too large to calculate exactly is refused rather than rounded wrongly', () => {
  assert.throws(() => bill(Number.MAX_SAFE_INTEGER, 28, 'exclusive'), /too large|whole number/);
  assert.doesNotThrow(() => bill(150_000_000_000, 28, 'inclusive'), '₹150 crore, far above anything a parlour bills, still exact');
});
