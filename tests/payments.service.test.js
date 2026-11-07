// No database and no running API: node --test tests/payments.service.test.js   (or: npm run test:unit)
// The real invoice service and WhatsApp builder run here against a scripted stand-in for the database, so the test sees
// exactly what would be written to the bill and to invoice_payments, what is refused before anything is written,
// and what an old bill and a new bill look like when read back.
const test = require('node:test');
const assert = require('node:assert/strict');

// Load the service without a database or a .env file.
const stub = (modulePath, exports) => {
  const file = require.resolve(modulePath);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const world = { runTransaction: null };
stub('../src/config/db', {
  pool: {},
  query: async (text) => { throw new Error(`unexpected query on the pool: ${text.slice(0, 70)}`); },
  withTransaction: async (fn) => world.runTransaction(fn),
});
stub('../src/config/env', { whatsappCountryCode: '91' });

const service = require('../src/modules/invoices/invoices.service');
const whatsapp = require('../src/modules/invoices/whatsapp');
const realGetWith = service.getWith;

const S_CUT = '11111111-1111-4111-8111-111111111111';
const S_COSTLY = '33333333-3333-4333-8333-333333333333';
const REF = '55555555-5555-4555-8555-555555555555';
const staff = { userId: 'user-A', parlourId: 'parlour-A', role: 'staff' };

const MENU = {
  [S_CUT]: { id: S_CUT, name: 'Haircut', price: '200.00', sac_code: '999721' },
  [S_COSTLY]: { id: S_COSTLY, name: 'Massage', price: '1000.00', sac_code: '999722' },
  odd: { id: 'odd', name: 'Odd job', price: '10.10', sac_code: null },
};
const gstParlour = (over = {}) => ({ tax_percent: '5.00', gst_price_mode: 'exclusive', gst_number: '33ABCDE1234F1Z5', ...over });

/** A scripted transaction client for one bill. */
function billClient({ parlour, referrer = null }) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM services WHERE/.test(text)) return { rows: params[1].map((id) => MENU[id]) };
      if (/FROM referrers WHERE/.test(text)) return { rows: referrer ? [referrer] : [] };
      if (/UPDATE parlours SET invoice_seq/.test(text)) return { rows: [{ invoice_prefix: 'DP', invoice_seq: 7, ...parlour }] };
      if (/INSERT INTO invoices/.test(text)) return { rows: [{ id: 'new-invoice-id' }] };
      if (/INSERT INTO invoice_items/.test(text)) return { rows: [] };
      if (/INSERT INTO invoice_payments/.test(text)) return { rows: [] };
      throw new Error(`unexpected query in the transaction: ${text.slice(0, 70)}`);
    },
  };
}

/** Makes a bill. Returns what was written to invoices and invoice_payments, or the error if it was refused. */
async function makeBill(body, clientOptions = { parlour: gstParlour() }) {
  const client = billClient(clientOptions);
  world.runTransaction = (fn) => fn(client);
  service.getWith = async () => ({ ok: true });
  let error = null;
  try {
    await service.create(staff, { discount: 0, ...body });
  } catch (err) {
    error = err;
  } finally {
    service.getWith = realGetWith;
  }
  const insert = client.calls.find((c) => /INSERT INTO invoices/.test(c.text))?.params;
  return {
    error,
    client,
    wrote: insert && { subtotal: insert[5], tax: insert[11], total: insert[12], paymentMethod: insert[13], cgst: insert[18], sgst: insert[19], tip: insert[21] },
    paid: client.calls.filter((c) => /INSERT INTO invoice_payments/.test(c.text)).map((c) => ({ invoiceId: c.params[0], method: c.params[1], amount: c.params[2] })),
    wroteAnything: client.calls.some((c) => /INSERT INTO/.test(c.text)),
  };
}

const items = (id = S_CUT, quantity = 1) => [{ serviceId: id, quantity }];
const sumOf = (paid) => paid.reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0);

// ───────────── what is written when a bill is made ─────────────

test('one method (the shorthand every client has sent so far): the bill says that method and one payment row holds the whole total', async () => {
  const { wrote, paid, error } = await makeBill({ items: items(), paymentMethod: 'upi' });
  assert.equal(error, null);
  assert.deepEqual([wrote.paymentMethod, wrote.total, wrote.tip], ['upi', '210.00', '0.00']);
  assert.deepEqual(paid, [{ invoiceId: 'new-invoice-id', method: 'upi', amount: '210.00' }]);
});

test('a split bill: the bill says "split" and there is one payment row per method, in the order cash, UPI, card', async () => {
  const { wrote, paid, error } = await makeBill({
    items: items(S_COSTLY), payments: [{ method: 'card', amount: 450 }, { method: 'cash', amount: 400 }, { method: 'upi', amount: 200 }],
  });
  assert.equal(error, null);
  assert.deepEqual([wrote.total, wrote.paymentMethod], ['1050.00', 'split']);
  assert.deepEqual(paid.map((p) => [p.method, p.amount]), [['cash', '400.00'], ['upi', '200.00'], ['card', '450.00']]);
  assert.equal(sumOf(paid), 105_000, 'the rows add up to the total');
});

test('a list with just one method is the same as the shorthand: the bill says that method, not "split"', async () => {
  const { wrote, paid } = await makeBill({ items: items(), payments: [{ method: 'card', amount: 210 }] });
  assert.equal(wrote.paymentMethod, 'card');
  assert.deepEqual(paid.map((p) => [p.method, p.amount]), [['card', '210.00']]);
});

// ───────────── payments that do not add up to the bill are refused, and nothing is written ─────────────

test('₹1 short: refused with PAYMENTS_MISMATCH, and not one row is written', async () => {
  const { error, wroteAnything } = await makeBill({ items: items(), payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 109 }] });
  assert.equal(error.status, 400);
  assert.equal(error.code, 'PAYMENTS_MISMATCH');
  assert.match(error.message, /₹1\.00 short of the bill total of ₹210\.00/);
  assert.equal(error.details.payments, error.message, 'the message is also on the field, so the app can show it under the payments');
  assert.equal(wroteAnything, false);
});

test('one paisa over: refused, and the message says so', async () => {
  const { error, wroteAnything } = await makeBill({ items: items(), payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 110.01 }] });
  assert.equal(error.code, 'PAYMENTS_MISMATCH');
  assert.match(error.message, /₹0\.01 more than the bill total of ₹210\.00/);
  assert.equal(wroteAnything, false);
});

test('the shorthand can never be refused for its amount: it always pays the whole total', async () => {
  for (const mode of ['exclusive', 'inclusive']) {
    const { error, paid, wrote } = await makeBill({ items: items('odd'), paymentMethod: 'cash' }, { parlour: gstParlour({ tax_percent: '2.50', gst_price_mode: mode }) });
    assert.equal(error, null);
    assert.equal(paid[0].amount, wrote.total);
  }
});

test('the server works out the total itself, so a payment list built on the wrong total is refused (client-side maths is never trusted)', async () => {
  // The client thinks 2 × ₹200 = ₹400 with no GST. The server adds 5% GST: ₹420.
  const { error } = await makeBill({ items: items(S_CUT, 2), payments: [{ method: 'cash', amount: 400 }] });
  assert.equal(error.code, 'PAYMENTS_MISMATCH');
  assert.match(error.message, /₹20\.00 short of the bill total of ₹420\.00/);
});

// ───────────── rounding to the paisa, with a referral and a manual discount ─────────────

test('GST on top with a referral: 2 × ₹200, 10% off, 5% GST makes ₹378, so ₹78 + ₹300 settles it and ₹78 + ₹299.99 does not', async () => {
  const opts = { parlour: gstParlour(), referrer: { id: REF, contact: '9841100001', percent: '10.00' } };
  const body = { items: items(S_CUT, 2), referrerId: REF, discount: 0 };
  // 2 × ₹200 = ₹400 subtotal; referral 10% = ₹40; ₹360 to tax; 5% = ₹18; total ₹378
  const ok = await makeBill({ ...body, payments: [{ method: 'cash', amount: 78 }, { method: 'upi', amount: 300 }] }, opts);
  assert.equal(ok.error, null);
  assert.deepEqual([ok.wrote.total, sumOf(ok.paid)], ['378.00', 37_800]);
  const short = await makeBill({ ...body, payments: [{ method: 'cash', amount: 78 }, { method: 'upi', amount: 299.99 }] }, opts);
  assert.equal(short.error.code, 'PAYMENTS_MISMATCH');
  assert.match(short.error.message, /₹0\.01 short/);
});

test('GST inside the price with a referral and a manual discount: the customer pays ₹850, split ₹425.01 + ₹424.99', async () => {
  const opts = { parlour: gstParlour({ gst_price_mode: 'inclusive' }), referrer: { id: REF, contact: '9841100001', percent: '10.00' } };
  const body = { items: items(S_COSTLY), referrerId: REF, discount: 50 };
  const ok = await makeBill({ ...body, payments: [{ method: 'cash', amount: 425.01 }, { method: 'card', amount: 424.99 }] }, opts);
  assert.equal(ok.error, null);
  assert.deepEqual([ok.wrote.total, ok.wrote.tax, ok.wrote.cgst, ok.wrote.sgst], ['850.00', '40.48', '20.24', '20.24']);
  const wrong = await makeBill({ ...body, payments: [{ method: 'cash', amount: 425 }, { method: 'card', amount: 424.99 }] }, opts);
  assert.equal(wrong.error.code, 'PAYMENTS_MISMATCH');
});

test('an odd paisa of tax: ₹10.10 at 2.5% is ₹10.35, settled by ₹5.17 + ₹5.18', async () => {
  const opts = { parlour: gstParlour({ tax_percent: '2.50' }) };
  const ok = await makeBill({ items: items('odd'), payments: [{ method: 'cash', amount: 5.17 }, { method: 'upi', amount: 5.18 }] }, opts);
  assert.equal(ok.error, null);
  assert.deepEqual([ok.wrote.total, ok.wrote.cgst, ok.wrote.sgst], ['10.35', '0.13', '0.12']);
});

test('a bill whose total is 0 (everything discounted) is paid by one method at ₹0.00; a payment of money is refused', async () => {
  const free = await makeBill({ items: items(), discount: 200, paymentMethod: 'cash' });
  assert.equal(free.error, null);
  assert.deepEqual([free.wrote.total, free.wrote.paymentMethod, free.paid.map((p) => p.amount)], ['0.00', 'cash', ['0.00']]);
  const paying = await makeBill({ items: items(), discount: 200, payments: [{ method: 'cash', amount: 5 }] });
  assert.equal(paying.error.code, 'PAYMENTS_MISMATCH');
});

// ───────────── a tip ─────────────

test('a tip is saved on the bill and changes nothing else: not the total, not the tax, not the split, not what must be paid', async () => {
  const without = await makeBill({ items: items(S_COSTLY), tip: 0, paymentMethod: 'cash' });
  const withTip = await makeBill({ items: items(S_COSTLY), tip: 50, paymentMethod: 'cash' });
  assert.equal(withTip.wrote.tip, '50.00');
  assert.equal(without.wrote.tip, '0.00');
  for (const k of ['subtotal', 'tax', 'cgst', 'sgst', 'total']) assert.equal(withTip.wrote[k], without.wrote[k], k);
  assert.equal(withTip.paid[0].amount, '1050.00', 'the payment is the bill total, without the tip');
});

test('payments must add up to the total WITHOUT the tip: ₹1,050 is right with a ₹50 tip, ₹1,100 is not', async () => {
  const right = await makeBill({ items: items(S_COSTLY), tip: 50, payments: [{ method: 'cash', amount: 1000 }, { method: 'upi', amount: 50 }] });
  assert.equal(right.error, null);
  const tipIncluded = await makeBill({ items: items(S_COSTLY), tip: 50, payments: [{ method: 'cash', amount: 1000 }, { method: 'upi', amount: 100 }] });
  assert.equal(tipIncluded.error.code, 'PAYMENTS_MISMATCH');
  assert.match(tipIncluded.error.message, /₹50\.00 more than the bill total of ₹1050\.00/);
});

test('a tip with a rupee amount that floating point cannot hold is exact (₹33.33, ₹0.10)', async () => {
  assert.equal((await makeBill({ items: items(), tip: 33.33, paymentMethod: 'cash' })).wrote.tip, '33.33');
  assert.equal((await makeBill({ items: items(), tip: 0.1, paymentMethod: 'cash' })).wrote.tip, '0.10');
});

// ───────────── what an old bill and a new bill look like when read back ─────────────

const billRow = (over = {}) => ({
  id: 'inv-1', number: 'DP-00001', customer_id: null, customer_name: 'Walk-in', created_by: 'user-A', created_by_name: 'Riya',
  subtotal: '900.00', discount: '0.00', referrer_id: null, referral_percent: '0.00', referral_discount: '0.00',
  tax_percent: '5.00', tax: '45.00', total: '945.00', payment_method: 'cash', notes: null, status: 'paid', void_reason: null, voided_at: null,
  created_at: '2026-10-18T10:30:00.000Z', price_mode: 'exclusive', cgst: '22.50', sgst: '22.50', gstin: '33ABC', tip: '0.00',
  parlour_name: 'Demo Parlour', parlour_phone: '9840000000', parlour_address: '12 Lake View Road', parlour_gst: '33LIVE0000L1Z5',
  parlour_timezone: 'Asia/Kolkata', customer_phone: null, referrer_code: null, referrer_name: null,
  ...over,
});
const ITEMS = [{ id: 'it1', combo_id: null, description: null, name: 'Haircut', sac_code: null, unit_price: '900.00', quantity: 1, line_total: '900.00' }];

function readBack(row, paymentRows = []) {
  const calls = [];
  const db = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM invoice_items/.test(text)) return { rows: ITEMS };
      if (/FROM invoice_payments/.test(text)) return { rows: paymentRows };
      return { rows: [row] };
    },
  };
  return realGetWith(db, staff, 'inv-1').then((inv) => ({ inv, calls }));
}

test('a bill made before payments existed (no rows, no tip column value) shows its one method for the whole total, and no tip', async () => {
  const { inv } = await readBack(billRow({ payment_method: 'upi', tip: undefined, cgst: null, sgst: null }), []);
  assert.deepEqual(inv.payments, [{ method: 'upi', amount: 945 }]);
  assert.deepEqual([inv.paymentMethod, inv.tip], ['upi', 0]);
});

test('a split bill reads back with each method and amount, in order, and its tip', async () => {
  const { inv } = await readBack(
    billRow({ payment_method: 'split', tip: '50.00' }),
    [{ method: 'upi', amount: '445.00' }, { method: 'cash', amount: '500.00' }]
  );
  assert.deepEqual(inv.payments, [{ method: 'cash', amount: 500 }, { method: 'upi', amount: 445 }]);
  assert.deepEqual([inv.paymentMethod, inv.tip, inv.total], ['split', 50, 945]);
  assert.equal(inv.payments.reduce((s, p) => s + Math.round(p.amount * 100), 0), Math.round(inv.total * 100));
});

test('payments are read through the invoice AND the parlour, so another parlour\'s bill can never leak its payments', async () => {
  const { calls } = await readBack(billRow(), []);
  const q = calls.find((c) => /FROM invoice_payments/.test(c.text));
  assert.match(q.text, /JOIN invoices i ON i\.id = ip\.invoice_id/);
  assert.match(q.text, /i\.parlour_id = \$2/);
  assert.deepEqual(q.params, ['inv-1', 'parlour-A']);
});

// ───────────── the WhatsApp message ─────────────

const waBill = (over = {}) => ({
  number: 'DP-00007', createdAt: '2026-10-18T10:30:00.000Z', customerName: 'Cara Customer', gstin: '33ABCDE1234F1Z5',
  parlour: { name: 'Demo Parlour', phone: '9840000000', timezone: 'Asia/Kolkata' },
  items: [{ name: 'Haircut', quantity: 2, lineTotal: 400, description: null, sacCode: '999721' }],
  subtotal: 400, referralDiscount: 0, referralPercent: 0, referrer: null, discount: 0,
  taxPercent: 5, tax: 20, taxable: 400, cgst: 10, sgst: 10, priceMode: 'exclusive', total: 420, paymentMethod: 'upi', tip: 0,
  ...over,
});
const linesOf = (inv) => whatsapp.buildMessage(inv).split('\n');

test('WhatsApp, one method: reads exactly as it always has ("Paid by UPI"), with or without a payments list, and no tip line', () => {
  assert.ok(linesOf(waBill()).includes('Paid by UPI'), 'a bill with no payments list');
  assert.ok(linesOf(waBill({ payments: [{ method: 'upi', amount: 420 }] })).includes('Paid by UPI'));
  assert.ok(linesOf(waBill({ paymentMethod: 'cash', payments: [{ method: 'cash', amount: 420 }] })).includes('Paid by cash'));
  assert.ok(linesOf(waBill({ paymentMethod: 'card', payments: undefined })).includes('Paid by card'));
  assert.equal(linesOf(waBill()).some((l) => /Tip/.test(l)), false);
});

test('WhatsApp, a split bill: each method with its amount, after the total', () => {
  const lines = linesOf(waBill({ paymentMethod: 'split', payments: [{ method: 'cash', amount: 120.5 }, { method: 'upi', amount: 299.5 }] }));
  assert.ok(lines.includes('Paid by cash ₹120.50 + UPI ₹299.50'), lines.join(' | '));
  assert.ok(lines.indexOf('*Total: ₹420*') < lines.indexOf('Paid by cash ₹120.50 + UPI ₹299.50'));
  assert.equal(lines.some((l) => /Paid by split/.test(l)), false);
});

test('WhatsApp, a tip: shown after how it was paid, and said not to be in the total', () => {
  const lines = linesOf(waBill({ paymentMethod: 'split', payments: [{ method: 'cash', amount: 20 }, { method: 'card', amount: 400 }], tip: 50 }));
  const paidAt = lines.findIndex((l) => l.startsWith('Paid by'));
  assert.equal(lines[paidAt + 1], 'Tip: ₹50 (not included in the total)');
  assert.ok(lines.includes('*Total: ₹420*'), 'the total does not include the tip');
});
