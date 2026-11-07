// No database and no running API: node --test tests/commission.unit.test.js   (or: npm run test:unit)
// The commission arithmetic on its own: sharing a bill's taxable value across its lines, picking the rule, and the commission
// on a line, all in whole paise. Also checked together with the real GST arithmetic, with referral and manual discounts.
const test = require('node:test');
const assert = require('node:assert/strict');

const { allocate, pickRule, forLine, KINDS } = require('../src/modules/commissions/commission');
const gst = require('../src/modules/invoices/gst');

const sum = (a) => a.reduce((x, y) => x + y, 0);

// Deterministic pseudo-random numbers, so a failure can be reproduced.
let seed = 20261103;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ───────────── allocate: the shares always add up to the total ─────────────

test('allocate: three equal lines share 100 paise as 34, 33, 33 (the odd paisa goes to the earliest line)', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(101, [1, 1, 1]), [34, 34, 33]);
  assert.deepEqual(allocate(2, [5, 5, 5]), [1, 1, 0]);
});

test('allocate: shares are in proportion to the weights', () => {
  assert.deepEqual(allocate(81_000, [60_000, 30_000]), [54_000, 27_000]);   // a ₹900 bill taken down to ₹810
  assert.deepEqual(allocate(90_000, [60_000, 30_000]), [60_000, 30_000]);   // nothing taken off: each keeps its own price
  assert.deepEqual(allocate(1_000, [1, 3]), [250, 750]);
});

test('allocate: the paisa that is left over goes to the share that lost the most to rounding, and the earlier line wins a tie', () => {
  // 10 × [1,2,3] / 6 = 1.666…, 3.333…, 5 → floors 1, 3, 5 leave 1 paisa; the first line lost most (.666)
  assert.deepEqual(allocate(10, [1, 2, 3]), [2, 3, 5]);
  // 5 × [1,1] / 2 = 2.5 and 2.5: a tie, so the earlier line takes the paisa
  assert.deepEqual(allocate(5, [1, 1]), [3, 2]);
});

test('allocate: a line with no weight gets nothing, and everything is zero when there is nothing to share', () => {
  assert.deepEqual(allocate(500, [0, 100, 0]), [0, 500, 0]);
  assert.deepEqual(allocate(0, [10, 20]), [0, 0]);
  assert.deepEqual(allocate(0, [0, 0]), [0, 0]);
  assert.deepEqual(allocate(0, []), []);
  assert.deepEqual(allocate(777, [42]), [777]);
});

test('allocate: refuses what cannot be shared, instead of guessing', () => {
  assert.throws(() => allocate(100, [0, 0]), RangeError);          // nothing to be in proportion to
  assert.throws(() => allocate(-1, [1]), RangeError);
  assert.throws(() => allocate(10.5, [1]), RangeError);            // not whole paise
  assert.throws(() => allocate(10, [1, -1]), RangeError);
  assert.throws(() => allocate(10, [1, 0.5]), RangeError);
  assert.throws(() => allocate(10, [NaN]), RangeError);
});

test('allocate: always adds up to the total exactly, and never gives a line more than one paisa above its exact share (40,000 random bills)', () => {
  for (let n = 0; n < 40_000; n++) {
    const weights = Array.from({ length: between(1, 12) }, () => between(0, 5_000_000));
    const total = between(0, sum(weights));
    if (sum(weights) === 0) continue;
    const shares = allocate(total, weights);
    assert.equal(sum(shares), total, `total ${total} of ${weights}`);
    const W = sum(weights);
    shares.forEach((s, i) => {
      const exact = (total * weights[i]) / W;
      assert.ok(s >= Math.floor(exact) - 1e-9 && s <= Math.ceil(exact) + 1e-9, `share ${s} of exact ${exact}`);
      assert.ok(Number.isInteger(s) && s >= 0);
    });
    if (weights.some((w) => w === 0)) weights.forEach((w, i) => { if (w === 0) assert.equal(shares[i], 0); });
  }
});

test('allocate: stays exact when total × weight is bigger than a float can hold', () => {
  // ₹1,00,00,000 (10,000,000.00) is the biggest bill the API takes: 1e9 paise. 1e9 × 1e9 = 1e18, past 2^53.
  const total = 999_999_999;
  const shares = allocate(total, [999_999_999, 1]);
  assert.equal(sum(shares), total);
  assert.deepEqual(shares, [999_999_998, 1]);   // 999,999,999 × 999,999,999 / 1,000,000,000 = 999,999,998.000000001
});

// ───────────── pickRule: the person's rule wins ─────────────

test('pickRule: the person\'s rule wins over the service\'s; either alone applies; neither means no rule', () => {
  const person = { kind: 'percent', value: 10 };
  const service = { kind: 'flat', value: 50 };
  assert.equal(pickRule({ performerRule: person, serviceRule: service }), person);
  assert.equal(pickRule({ performerRule: person }), person);
  assert.equal(pickRule({ serviceRule: service }), service);
  assert.equal(pickRule({}), null);
  assert.equal(pickRule(), null);
  assert.equal(pickRule({ performerRule: null, serviceRule: null }), null);
});

// ───────────── forLine ─────────────

test('forLine: a percentage of the line\'s base', () => {
  assert.deepEqual(forLine({ net: 60_000, rule: { kind: 'percent', value: 10 } }), { kind: 'percent', rate: 10, amount: 6_000 });
  assert.deepEqual(forLine({ net: 60_000, rule: { kind: 'percent', value: '12.50' } }), { kind: 'percent', rate: 12.5, amount: 7_500 }); // numeric(10,2) arrives as a string
  assert.equal(forLine({ net: 60_000, rule: { kind: 'percent', value: 100 } }).amount, 60_000);
  assert.equal(forLine({ net: 0, rule: { kind: 'percent', value: 50 } }).amount, 0);
});

test('forLine: a percentage rounds to the nearest paisa and exactly half a paisa rounds UP, with no floating-point drift', () => {
  // 2.5% of ₹10.10 (1010 paise) = 25.25 → 25;  2.5% of ₹10.30 = 25.75 → 26
  assert.equal(forLine({ net: 1010, rule: { kind: 'percent', value: 2.5 } }).amount, 25);
  assert.equal(forLine({ net: 1030, rule: { kind: 'percent', value: 2.5 } }).amount, 26);
  // exactly half: 50% of 1 paisa = 0.5 → 1; 10% of 5 paise = 0.5 → 1; 10% of 4 paise = 0.4 → 0
  assert.equal(forLine({ net: 1, rule: { kind: 'percent', value: 50 } }).amount, 1);
  assert.equal(forLine({ net: 5, rule: { kind: 'percent', value: 10 } }).amount, 1);
  assert.equal(forLine({ net: 4, rule: { kind: 'percent', value: 10 } }).amount, 0);
  // 1.15% of ₹30.00 is 34.5 paise: the classic case where Math.round(3000 * 1.15 / 100) comes out a paisa short
  assert.equal(forLine({ net: 3000, rule: { kind: 'percent', value: 1.15 } }).amount, 35);
});

test('forLine: a flat amount is paid for each unit performed', () => {
  assert.deepEqual(forLine({ net: 500_000, quantity: 1, rule: { kind: 'flat', value: 50 } }), { kind: 'flat', rate: 50, amount: 5_000 });
  assert.equal(forLine({ net: 500_000, quantity: 3, rule: { kind: 'flat', value: 50 } }).amount, 15_000);
  assert.equal(forLine({ net: 500_000, quantity: 2, rule: { kind: 'flat', value: '12.34' } }).amount, 2_468);
});

test('forLine: a flat amount is never more than the line took in (a free or heavily discounted line earns less, never more than it made)', () => {
  assert.equal(forLine({ net: 3_000, quantity: 1, rule: { kind: 'flat', value: 50 } }).amount, 3_000);  // ₹30 line, ₹50 flat → ₹30
  assert.equal(forLine({ net: 0, quantity: 2, rule: { kind: 'flat', value: 50 } }).amount, 0);
  assert.equal(forLine({ net: 5_000, quantity: 1, rule: { kind: 'flat', value: 50 } }).amount, 5_000);   // exactly the cap
  assert.equal(forLine({ net: 5_001, quantity: 1, rule: { kind: 'flat', value: 50 } }).amount, 5_000);
});

test('forLine: no rule means no commission, and says so (the bill line records no rule)', () => {
  assert.deepEqual(forLine({ net: 60_000, rule: null }), { kind: null, rate: null, amount: 0 });
  assert.deepEqual(forLine({ net: 60_000 }), { kind: null, rate: null, amount: 0 });
});

test('forLine: refuses nonsense instead of guessing', () => {
  assert.throws(() => forLine({ net: -1, rule: { kind: 'percent', value: 10 } }), RangeError);
  assert.throws(() => forLine({ net: 10.5, rule: { kind: 'percent', value: 10 } }), RangeError);
  assert.throws(() => forLine({ net: 100, quantity: 0, rule: { kind: 'flat', value: 5 } }), RangeError);
  assert.throws(() => forLine({ net: 100, quantity: 1.5, rule: { kind: 'flat', value: 5 } }), RangeError);
  assert.throws(() => forLine({ net: 100, rule: { kind: 'bonus', value: 5 } }), RangeError);
  assert.throws(() => forLine({ net: 100, rule: { kind: 'percent', value: 0 } }), RangeError);
  assert.throws(() => forLine({ net: 100, rule: { kind: 'percent', value: -5 } }), RangeError);
  assert.throws(() => forLine({ net: 100, rule: { kind: 'percent', value: 101 } }), RangeError);
  assert.deepEqual(KINDS, ['percent', 'flat']);
});

// ───────────── together with the real GST arithmetic ─────────────

/** What the invoice service does for one bill: GST first, then each line's share of the taxable value, then commission. */
function billWithCommission({ lines, referralPercent = 0, discount = 0, taxPercent, priceMode, rules }) {
  const subtotal = sum(lines.map((l) => l.unit * l.quantity));
  const referral = referralPercent ? gst.percentOf(subtotal, referralPercent) : 0;
  const bill = gst.computeBill({ subtotal, referral, discount, taxPercent, priceMode });
  const nets = allocate(bill.taxable, lines.map((l) => l.unit * l.quantity));
  const commissions = lines.map((l, i) => forLine({ net: nets[i], quantity: l.quantity, rule: rules[i] }));
  return { bill, nets, commissions };
}

test('together: with GST on top, the shares of a ₹900 bill with a 10% referral discount add up to the taxable value, and commission follows', () => {
  // ₹600 combo + ₹300 wax = ₹900; referral 10% = ₹90 → payable ₹810; GST 5% = ₹40.50; total ₹850.50
  const { bill, nets, commissions } = billWithCommission({
    lines: [{ unit: 60_000, quantity: 1 }, { unit: 30_000, quantity: 1 }], referralPercent: 10, taxPercent: 5, priceMode: 'exclusive',
    rules: [{ kind: 'percent', value: 10 }, { kind: 'flat', value: 50 }],
  });
  assert.equal(bill.taxable, 81_000);
  assert.deepEqual(nets, [54_000, 27_000]);
  assert.equal(sum(nets), bill.taxable);
  assert.deepEqual(commissions.map((c) => c.amount), [5_400, 5_000]);   // 10% of ₹540.00, and ₹50 flat
});

test('together: with GST inside the prices, commission is on the value BEFORE GST, not on what the customer handed over', () => {
  // ₹1,000 with GST 5% inside: tax = 1000 × 5/105 = ₹47.62, taxable ₹952.38
  const { bill, nets, commissions } = billWithCommission({
    lines: [{ unit: 100_000, quantity: 1 }], taxPercent: 5, priceMode: 'inclusive', rules: [{ kind: 'percent', value: 10 }],
  });
  assert.deepEqual([bill.total, bill.tax, bill.taxable], [100_000, 4_762, 95_238]);
  assert.deepEqual(nets, [95_238]);
  assert.equal(commissions[0].amount, 9_524);   // 10% of ₹952.38 = ₹95.238 → ₹95.24, not ₹100
});

test('together: a manual discount comes off the base, so the person is paid on what was actually taken', () => {
  // ₹500 facial, ₹100 off: taxable ₹400; 20% commission = ₹80, not ₹100
  const { nets, commissions } = billWithCommission({
    lines: [{ unit: 50_000, quantity: 1 }], discount: 10_000, taxPercent: 5, priceMode: 'exclusive', rules: [{ kind: 'percent', value: 20 }],
  });
  assert.deepEqual(nets, [40_000]);
  assert.equal(commissions[0].amount, 8_000);
});

test('together: a tip never changes the base (it is not part of the bill)', () => {
  // The tip is not an input to the bill at all: the same bill with or without one has the same shares.
  const args = { lines: [{ unit: 20_000, quantity: 1 }], taxPercent: 5, priceMode: 'exclusive', rules: [{ kind: 'percent', value: 10 }] };
  assert.deepEqual(billWithCommission(args).nets, [20_000]);
});

test('together: a bill taken down to ₹0 earns no commission, and shares nothing', () => {
  const { bill, nets, commissions } = billWithCommission({
    lines: [{ unit: 20_000, quantity: 1 }], referralPercent: 0, discount: 20_000, taxPercent: 5, priceMode: 'exclusive',
    rules: [{ kind: 'percent', value: 10 }],
  });
  assert.equal(bill.total, 0);
  assert.deepEqual(nets, [0]);
  assert.equal(commissions[0].amount, 0);
});

test('together: for every kind of bill, the shares add up to the taxable value to the paisa and commission is never more than a line took (30,000 random bills)', () => {
  for (let n = 0; n < 30_000; n++) {
    const lines = Array.from({ length: between(1, 8) }, () => ({ unit: between(0, 2_000_000), quantity: between(1, 5) }));
    const subtotal = sum(lines.map((l) => l.unit * l.quantity));
    const referralPercent = rand() < 0.4 ? [5, 7.5, 10, 12.5, 33.33][between(0, 4)] : 0;
    const referral = referralPercent ? gst.percentOf(subtotal, referralPercent) : 0;
    const discount = rand() < 0.4 ? between(0, subtotal - referral) : 0;
    const taxPercent = [0, 5, 12, 18, 2.5, 28][between(0, 5)];
    const priceMode = rand() < 0.5 ? 'inclusive' : 'exclusive';
    const rules = lines.map(() => (rand() < 0.2 ? null : rand() < 0.5
      ? { kind: 'percent', value: [1, 5, 7.5, 10, 12.5, 33.33, 100][between(0, 6)] }
      : { kind: 'flat', value: between(1, 20_000) / 100 }));
    const { bill, nets, commissions } = billWithCommission({ lines, referralPercent, discount, taxPercent, priceMode, rules });
    assert.equal(sum(nets), bill.taxable, JSON.stringify({ lines, referralPercent, discount, taxPercent, priceMode }));
    nets.forEach((net, i) => {
      assert.ok(Number.isInteger(net) && net >= 0);
      assert.ok(commissions[i].amount >= 0 && commissions[i].amount <= net, `commission ${commissions[i].amount} on a line that took ${net}`);
      if (rules[i] === null) assert.equal(commissions[i].amount, 0);
    });
  }
});
