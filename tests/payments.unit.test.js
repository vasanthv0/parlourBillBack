// No database and no running API: node --test tests/payments.unit.test.js   (or: npm run test:unit)
// The payment rules (what was paid per method, and whether it settles the bill to the paisa), the request validation
// for split payments and tips, and the idempotency fingerprint. The service and WhatsApp message are in payments.service.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

const payments = require('../src/modules/invoices/payments');
const gst = require('../src/modules/invoices/gst');
const schemas = require('../src/modules/invoices/invoices.schemas');
const validate = require('../src/middleware/validate');
const idem = require('../src/modules/invoices/idempotency');

const S1 = '11111111-1111-4111-8111-111111111111';
const baseBody = (over = {}) => ({ items: [{ serviceId: S1, quantity: 1 }], discount: 0, paymentMethod: 'cash', ...over });

// ───────────── what the request says was paid ─────────────

test('one paymentMethod means the whole bill by that method, to the paisa', () => {
  assert.deepEqual(payments.fromRequest({ paymentMethod: 'upi' }, 79_800), [{ method: 'upi', paise: 79_800 }]);
  assert.deepEqual(payments.fromRequest({ paymentMethod: 'cash' }, 0), [{ method: 'cash', paise: 0 }]);
});

test('a list of payments becomes whole paise in a fixed order (cash, UPI, card), however it was listed', () => {
  const rows = payments.fromRequest({ payments: [{ method: 'card', amount: 200 }, { method: 'cash', amount: 99.5 }, { method: 'upi', amount: 10.1 }] }, 30_960);
  assert.deepEqual(rows, [{ method: 'cash', paise: 9_950 }, { method: 'upi', paise: 1_010 }, { method: 'card', paise: 20_000 }]);
});

test('rupee amounts that floating point cannot hold are still exact paise (10.10, 20.20, 0.07, 19.99, 1234.56)', () => {
  const rows = payments.fromRequest({ payments: [{ method: 'cash', amount: 10.1 }, { method: 'upi', amount: 20.2 }, { method: 'card', amount: 0.07 }] }, 3_037);
  assert.deepEqual(rows.map((r) => r.paise), [1_010, 2_020, 7]);
  assert.equal(payments.fromRequest({ payments: [{ method: 'cash', amount: 19.99 }] }, 1_999)[0].paise, 1_999);
  assert.equal(payments.fromRequest({ payments: [{ method: 'cash', amount: 1234.56 }] }, 123_456)[0].paise, 123_456);
});

test('a request that names no payment at all has no rows, and check() will not accept it', () => {
  const rows = payments.fromRequest({}, 10_000);
  assert.deepEqual(rows, []);
  assert.deepEqual(payments.check(rows, 10_000), { ok: false, paid: 0, difference: 10_000 });
});

// ───────────── do the payments settle the bill ─────────────

test('payments that add up to the total to the paisa settle it', () => {
  assert.deepEqual(payments.check([{ method: 'cash', paise: 30_000 }, { method: 'upi', paise: 49_800 }], 79_800), { ok: true, paid: 79_800, difference: 0 });
});

test('one paisa short or one paisa over is refused, and says by how much', () => {
  assert.deepEqual(payments.check([{ method: 'cash', paise: 30_000 }, { method: 'upi', paise: 49_799 }], 79_800), { ok: false, paid: 79_799, difference: 1 });
  assert.deepEqual(payments.check([{ method: 'cash', paise: 30_000 }, { method: 'upi', paise: 49_801 }], 79_800), { ok: false, paid: 79_801, difference: -1 });
});

test('a bill with a total of 0 is settled by a single method at 0, and by nothing more', () => {
  assert.equal(payments.check([{ method: 'cash', paise: 0 }], 0).ok, true);
  assert.equal(payments.check([{ method: 'cash', paise: 100 }], 0).ok, false);
});

test('rows that are malformed are refused outright, never saved: a repeated method, an unknown method, part of a paisa, a negative amount', () => {
  assert.throws(() => payments.check([{ method: 'cash', paise: 100 }, { method: 'cash', paise: 100 }], 200), /more than once/);
  assert.throws(() => payments.check([{ method: 'cheque', paise: 200 }], 200), /Unknown payment method/);
  assert.throws(() => payments.check([{ method: 'cash', paise: 100.5 }, { method: 'upi', paise: 99.5 }], 200), /whole number of paise/);
  assert.throws(() => payments.check([{ method: 'cash', paise: -100 }, { method: 'upi', paise: 300 }], 200), /whole number of paise/);
  assert.throws(() => payments.check([{ method: 'cash', paise: 100 }], 100.5), /whole number of paise/);
});

// ───────────── the method written on the bill, and how a bill shows its payments ─────────────

test('the bill says the one method used, or "split" when two or more were used', () => {
  assert.equal(payments.methodOnBill([{ method: 'upi', paise: 1 }]), 'upi');
  assert.equal(payments.methodOnBill([{ method: 'cash', paise: 1 }, { method: 'card', paise: 1 }]), 'split');
  assert.equal(payments.methodOnBill([{ method: 'cash', paise: 1 }, { method: 'upi', paise: 1 }, { method: 'card', paise: 1 }]), 'split');
});

test('payments are shown in rupees in a fixed order; a bill from before payments existed shows its one method for the whole total', () => {
  assert.deepEqual(payments.forDisplay([{ method: 'card', amount: '200.00' }, { method: 'cash', amount: '99.50' }], { method: 'split', total: '299.50' }),
    [{ method: 'cash', amount: 99.5 }, { method: 'card', amount: 200 }]);
  assert.deepEqual(payments.forDisplay([], { method: 'upi', total: '850.50' }), [{ method: 'upi', amount: 850.5 }]);
  assert.deepEqual(payments.forDisplay([], { method: 'split', total: '10.00' }), [], 'nothing is invented for a bill that has no rows and no single method');
});

// ───────────── money: the bill (GST, referral, manual discount) and the payments, to the paisa ─────────────
// Each case builds the bill with the same arithmetic the API uses, then asks whether a given split settles it.

const total = (b) => gst.computeBill(b).total;
const settles = (b, list) => payments.check(payments.fromRequest({ payments: list }, total(b)), total(b));

test('GST on top, with a referral and a manual discount: ₹900 − ₹90 − ₹50 = ₹760, 5% GST = ₹38, total ₹798', () => {
  const bill = { subtotal: 90_000, referral: gst.percentOf(90_000, 10), discount: 5_000, taxPercent: 5, priceMode: 'exclusive' };
  assert.equal(total(bill), 79_800);
  assert.equal(settles(bill, [{ method: 'cash', amount: 300 }, { method: 'upi', amount: 498 }]).ok, true);
  assert.equal(settles(bill, [{ method: 'cash', amount: 300 }, { method: 'upi', amount: 497.99 }]).difference, 1);
  assert.equal(settles(bill, [{ method: 'cash', amount: 800 }]).difference, -200);
});

test('GST inside the price, with a referral and a manual discount: ₹1,000 − ₹100 − ₹50, the customer pays ₹850 (₹40.48 of it is GST)', () => {
  const bill = { subtotal: 100_000, referral: gst.percentOf(100_000, 10), discount: 5_000, taxPercent: 5, priceMode: 'inclusive' };
  assert.equal(total(bill), 85_000, 'the total is the menu price less the discounts; GST is inside it');
  assert.equal(settles(bill, [{ method: 'cash', amount: 425.01 }, { method: 'card', amount: 424.99 }]).ok, true);
  assert.equal(settles(bill, [{ method: 'cash', amount: 425 }, { method: 'card', amount: 424.99 }]).difference, 1);
});

test('an odd paisa of tax: 2.5% on ₹10.10 makes the total ₹10.35, and ₹5.17 + ₹5.18 settles it', () => {
  const bill = { subtotal: 1_010, taxPercent: 2.5, priceMode: 'exclusive' };
  assert.equal(total(bill), 1_035);
  assert.equal(settles(bill, [{ method: 'cash', amount: 5.17 }, { method: 'upi', amount: 5.18 }]).ok, true);
  assert.equal(settles(bill, [{ method: 'cash', amount: 5.17 }, { method: 'upi', amount: 5.17 }]).difference, 1);
});

test('three methods on a total that does not divide by three: ₹333.33 + ₹333.33 + ₹333.34 settles ₹1,000; ₹333.33 three times is one paisa short', () => {
  const bill = { subtotal: 100_000, taxPercent: 0, priceMode: 'exclusive' };
  assert.equal(settles(bill, [{ method: 'cash', amount: 333.33 }, { method: 'upi', amount: 333.33 }, { method: 'card', amount: 333.34 }]).ok, true);
  assert.deepEqual(settles(bill, [{ method: 'cash', amount: 333.33 }, { method: 'upi', amount: 333.33 }, { method: 'card', amount: 333.33 }]), { ok: false, paid: 99_999, difference: 1 });
});

test('floating point cannot fool the sum: ₹10.10 + ₹20.20 is ₹30.30, though 10.1 + 20.2 is 30.299999999999997 in floating point', () => {
  assert.notEqual(10.1 + 20.2, 30.3);
  const bill = { subtotal: 3_030, taxPercent: 0, priceMode: 'exclusive' };
  assert.equal(settles(bill, [{ method: 'cash', amount: 10.1 }, { method: 'upi', amount: 20.2 }]).ok, true);
});

test('a referral of 100% leaves a total of 0, which one method at 0 settles', () => {
  const bill = { subtotal: 50_000, referral: gst.percentOf(50_000, 100), taxPercent: 5, priceMode: 'exclusive' };
  assert.equal(total(bill), 0);
  assert.equal(payments.check(payments.fromRequest({ paymentMethod: 'upi' }, 0), 0).ok, true);
  assert.equal(settles(bill, [{ method: 'cash', amount: 1 }]).ok, false);
});

// ───────────── the request, through the real validate middleware ─────────────

function validated(body, headers = {}) {
  const req = { headers, params: {}, query: {}, body };
  let err;
  validate(schemas.create)(req, {}, (e) => { err = e; });
  return { req, err, fields: err?.details ?? {} };
}

test('a single paymentMethod is accepted exactly as before, and the tip defaults to 0', () => {
  const { req, err } = validated(baseBody());
  assert.equal(err, undefined);
  assert.equal(req.valid.body.paymentMethod, 'cash');
  assert.equal(req.valid.body.payments, undefined);
  assert.equal(req.valid.body.tip, 0);
});

test('a list of payments is accepted: one, two or all three methods', () => {
  for (const list of [
    [{ method: 'upi', amount: 100 }],
    [{ method: 'cash', amount: 60.5 }, { method: 'upi', amount: 39.5 }],
    [{ method: 'cash', amount: 1 }, { method: 'upi', amount: 2 }, { method: 'card', amount: 0.01 }],
  ]) {
    const { req, err } = validated({ ...baseBody(), paymentMethod: undefined, payments: list });
    assert.equal(err, undefined, JSON.stringify(list));
    assert.equal(req.valid.body.payments.length, list.length);
  }
});

test('how it was paid must be said exactly once: both is refused, and so is neither', () => {
  const both = validated({ ...baseBody(), payments: [{ method: 'upi', amount: 100 }] });
  assert.match(both.fields.payments, /either paymentMethod or payments/);
  const neither = validated({ ...baseBody(), paymentMethod: undefined });
  assert.match(neither.fields.paymentMethod, /Choose how the bill was paid/);
});

test('a payment needs a known method and a real amount: 0, negative, three decimals, too large, or not a number are refused', () => {
  const one = (amount, method = 'cash') => validated({ ...baseBody(), paymentMethod: undefined, payments: [{ method, amount }] });
  assert.match(one(0).fields['payments.0.amount'], /above 0/);
  assert.ok(one(-5).fields['payments.0.amount']);
  assert.match(one(10.005).fields['payments.0.amount'], /2 decimal places/);
  assert.ok(one(10_000_001).fields['payments.0.amount']);
  assert.ok(one('100').fields['payments.0.amount'], 'a string is not an amount');
  assert.ok(one(100, 'cheque').fields['payments.0.method']);
});

test('a method can be used once; an empty list and a list of four are refused', () => {
  const dup = validated({ ...baseBody(), paymentMethod: undefined, payments: [{ method: 'cash', amount: 50 }, { method: 'upi', amount: 20 }, { method: 'cash', amount: 30 }] });
  assert.match(dup.fields['payments.2.method'], /once/);
  assert.ok(validated({ ...baseBody(), paymentMethod: undefined, payments: [] }).fields.payments);
  const four = ['cash', 'upi', 'card', 'cash'].map((method) => ({ method, amount: 1 }));
  assert.ok(validated({ ...baseBody(), paymentMethod: undefined, payments: four }).fields.payments);
});

test('a tip is an optional amount of 0 or more, with at most 2 decimals', () => {
  assert.equal(validated({ ...baseBody(), tip: 50 }).req.valid.body.tip, 50);
  assert.equal(validated({ ...baseBody(), tip: 0 }).err, undefined);
  assert.equal(validated({ ...baseBody(), tip: 12.5 }).req.valid.body.tip, 12.5);
  assert.ok(validated({ ...baseBody(), tip: -1 }).fields.tip);
  assert.match(validated({ ...baseBody(), tip: 1.005 }).fields.tip, /2 decimal places/);
  assert.ok(validated({ ...baseBody(), tip: 'lots' }).fields.tip);
  assert.ok(validated({ ...baseBody(), tip: 10_000_001 }).fields.tip);
});

// ───────────── the idempotency fingerprint ─────────────

test('a request in the old shape has exactly the fingerprint it always had, so a retry just after an upgrade still finds its bill', () => {
  const old = {
    customerId: S1, walkInName: ' Cara ', items: [{ serviceId: '22222222-2222-4222-8222-222222222222', quantity: 2 }, { comboId: '33333333-3333-4333-8333-333333333333', quantity: 1 }],
    referrerId: null, discount: 50.5, paymentMethod: 'upi', notes: ' hi ',
  };
  // Recorded from the code as it was before payments and tips existed.
  assert.equal(idem.fingerprintOf(old), '1d746e7ccdd73384182a253acaf90b767aed74b955fbca978c6297a13aac5d7a');
  assert.equal(idem.fingerprintOf({ items: [{ serviceId: '22222222-2222-4222-8222-222222222222', quantity: 1 }], discount: 0, paymentMethod: 'cash' }),
    'eaa4daf4a63b8dc0ff431fb3fbf32ea777bbad60c25ce6c24c8374600ed9f1d6');
});

test('fingerprint: split payments count (each amount and method), but the order they were listed in does not; a tip counts, a tip of 0 does not', () => {
  const split = (list, extra = {}) => ({ ...baseBody(), paymentMethod: undefined, payments: list, ...extra });
  const a = [{ method: 'cash', amount: 300 }, { method: 'upi', amount: 498 }];
  assert.equal(idem.fingerprintOf(split(a)), idem.fingerprintOf(split([...a].reverse())));
  assert.equal(idem.fingerprintOf(split(a)), idem.fingerprintOf(split([{ method: 'cash', amount: 300.0 }, { method: 'upi', amount: 498.0 }])));
  assert.notEqual(idem.fingerprintOf(split(a)), idem.fingerprintOf(split([{ method: 'cash', amount: 301 }, { method: 'upi', amount: 497 }])));
  assert.notEqual(idem.fingerprintOf(split(a)), idem.fingerprintOf(split([{ method: 'cash', amount: 300 }, { method: 'card', amount: 498 }])));
  assert.notEqual(idem.fingerprintOf(split(a)), idem.fingerprintOf(baseBody()), 'a split bill is not the same request as a one-method bill');
  assert.notEqual(idem.fingerprintOf(baseBody({ tip: 50 })), idem.fingerprintOf(baseBody()));
  assert.notEqual(idem.fingerprintOf(baseBody({ tip: 50 })), idem.fingerprintOf(baseBody({ tip: 50.01 })));
  assert.equal(idem.fingerprintOf(baseBody({ tip: 0 })), idem.fingerprintOf(baseBody()));
});
