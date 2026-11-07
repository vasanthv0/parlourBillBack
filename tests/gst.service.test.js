// No database and no running API: node --test tests/gst.service.test.js   (or: npm run test:unit)
// The real invoice service and WhatsApp builder run here against a scripted stand-in for the database,
// so the test sees exactly what would be written to the bill, and what an old and a new bill look like when read back.
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
const S_FACIAL = '22222222-2222-4222-8222-222222222222';
const S_COSTLY = '33333333-3333-4333-8333-333333333333';
const COMBO = '44444444-4444-4444-8444-444444444444';
const REF = '55555555-5555-4555-8555-555555555555';
const staff = { userId: 'user-A', parlourId: 'parlour-A', role: 'staff' };

const MENU = {
  [S_CUT]: { id: S_CUT, name: 'Haircut', price: '200.00', sac_code: '999721' },
  [S_FACIAL]: { id: S_FACIAL, name: 'Facial', price: '500.00', sac_code: null },   // a service with no SAC
  [S_COSTLY]: { id: S_COSTLY, name: 'Massage', price: '1000.00', sac_code: '999722' },
  odd: { id: 'odd', name: 'Odd job', price: '10.10', sac_code: null },
};

/** A scripted transaction client for one bill. */
function billClient({ parlour, referrer = null, menu = MENU } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM services WHERE/.test(text)) return { rows: params[1].map((id) => menu[id]) };
      if (/FROM combos WHERE/.test(text)) return { rows: [{ id: COMBO, name: 'Glow Pack', price: '600.00' }] };
      if (/FROM combo_items ci/.test(text)) return { rows: [{ combo_id: COMBO, quantity: 1, name: 'Haircut', is_active: true }, { combo_id: COMBO, quantity: 1, name: 'Facial', is_active: true }] };
      if (/FROM referrers WHERE/.test(text)) return { rows: referrer ? [referrer] : [] };
      if (/UPDATE parlours SET invoice_seq/.test(text)) return { rows: [{ invoice_prefix: 'DP', invoice_seq: 7, ...parlour }] };
      if (/INSERT INTO invoices/.test(text)) return { rows: [{ id: 'new-invoice-id' }] };
      if (/INSERT INTO invoice_items/.test(text)) return { rows: [] };
      if (/INSERT INTO invoice_payments/.test(text)) return { rows: [] };
      throw new Error(`unexpected query in the transaction: ${text.slice(0, 70)}`);
    },
  };
}

/** Makes a bill and returns what was written to the invoices table, and to each line. */
async function makeBill(body, clientOptions) {
  const client = billClient(clientOptions);
  world.runTransaction = (fn) => fn(client);
  service.getWith = async () => ({ ok: true });
  try {
    await service.create(staff, { discount: 0, paymentMethod: 'cash', ...body });
  } finally {
    service.getWith = realGetWith;
  }
  const insert = client.calls.find((c) => /INSERT INTO invoices/.test(c.text));
  const p = insert?.params;
  return {
    client,
    wrote: p && {
      subtotal: p[5], discount: p[6], referralPercent: p[8], referralDiscount: p[9], taxPercent: p[10], tax: p[11], total: p[12],
      priceMode: p[17], cgst: p[18], sgst: p[19], gstin: p[20],
    },
    items: client.calls.filter((c) => /INSERT INTO invoice_items/.test(c.text)).map((c) => ({ name: c.params[4], lineTotal: c.params[7], sacCode: c.params[8] })),
  };
}

const gstParlour = (over = {}) => ({ tax_percent: '5.00', gst_price_mode: 'exclusive', gst_number: '33ABCDE1234F1Z5', ...over });

// ───────────── what is written when a bill is made ─────────────

test('GST on top: a referral and a manual discount come off first, GST is worked out on what is left, and split in half', async () => {
  const { wrote } = await makeBill(
    { items: [{ serviceId: S_CUT, quantity: 2 }, { serviceId: S_FACIAL, quantity: 1 }], referrerId: REF, discount: 50 },
    { parlour: gstParlour(), referrer: { id: REF, contact: '9841100001', percent: '10.00' } }
  );
  // 2 × ₹200 + ₹500 = ₹900; referral 10% = ₹90; discount ₹50; ₹760 to tax; 5% = ₹38 (₹19 + ₹19); total ₹798
  assert.deepEqual(wrote, {
    subtotal: '900.00', discount: '50.00', referralPercent: '10.00', referralDiscount: '90.00', taxPercent: '5.00',
    tax: '38.00', total: '798.00', priceMode: 'exclusive', cgst: '19.00', sgst: '19.00', gstin: '33ABCDE1234F1Z5',
  });
});

test('GST inside the price: the customer pays the menu price less discounts, and the tax is the part of it that is GST', async () => {
  const { wrote } = await makeBill({ items: [{ serviceId: S_COSTLY, quantity: 1 }] }, { parlour: gstParlour({ gst_price_mode: 'inclusive' }) });
  // ₹1,000 with 5% inside: tax 47.62 (₹23.81 + ₹23.81), taxable ₹952.38
  assert.deepEqual([wrote.subtotal, wrote.tax, wrote.total, wrote.priceMode, wrote.cgst, wrote.sgst], ['1000.00', '47.62', '1000.00', 'inclusive', '23.81', '23.81']);
});

test('GST inside the price, with a referral and a manual discount: the customer pays ₹850 and ₹40.48 of it is GST', async () => {
  const { wrote } = await makeBill(
    { items: [{ serviceId: S_COSTLY, quantity: 1 }], referrerId: REF, discount: 50 },
    { parlour: gstParlour({ gst_price_mode: 'inclusive' }), referrer: { id: REF, contact: '9841100001', percent: '10.00' } }
  );
  assert.deepEqual([wrote.referralDiscount, wrote.discount, wrote.tax, wrote.total, wrote.cgst, wrote.sgst], ['100.00', '50.00', '40.48', '850.00', '20.24', '20.24']);
});

test('an odd number of paise of tax: the extra paisa goes to CGST, and the two halves add up to the tax', async () => {
  const { wrote } = await makeBill({ items: [{ serviceId: 'odd', quantity: 1 }] }, { parlour: gstParlour({ tax_percent: '2.50' }) });
  // 2.5% of ₹10.10 = 25.25 paise → 25 paise: CGST 13, SGST 12
  assert.deepEqual([wrote.tax, wrote.cgst, wrote.sgst, wrote.total], ['0.25', '0.13', '0.12', '10.35']);
});

test('a parlour that charges no GST still gets a split (all zero), so its bills are new-style bills', async () => {
  const { wrote } = await makeBill({ items: [{ serviceId: S_CUT, quantity: 1 }] }, { parlour: gstParlour({ tax_percent: '0.00', gst_number: null }) });
  assert.deepEqual([wrote.tax, wrote.cgst, wrote.sgst, wrote.total, wrote.gstin], ['0.00', '0.00', '0.00', '200.00', null]);
});

test('the GSTIN is written onto the bill, trimmed; a blank one is saved as nothing', async () => {
  const a = await makeBill({ items: [{ serviceId: S_CUT, quantity: 1 }] }, { parlour: gstParlour({ gst_number: '  33ABCDE1234F1Z5 ' }) });
  const b = await makeBill({ items: [{ serviceId: S_CUT, quantity: 1 }] }, { parlour: gstParlour({ gst_number: '   ' }) });
  assert.equal(a.wrote.gstin, '33ABCDE1234F1Z5');
  assert.equal(b.wrote.gstin, null);
});

test('the SAC of each service is copied onto its line; a combo line has none; money on the lines is unchanged', async () => {
  const { items } = await makeBill(
    { items: [{ serviceId: S_CUT, quantity: 2 }, { serviceId: S_FACIAL, quantity: 1 }, { comboId: COMBO, quantity: 1 }] },
    { parlour: gstParlour() }
  );
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.deepEqual([by.Haircut.sacCode, by.Haircut.lineTotal], ['999721', '400.00']);
  assert.deepEqual([by.Facial.sacCode, by.Facial.lineTotal], [null, '500.00']);
  assert.deepEqual([by['Glow Pack'].sacCode, by['Glow Pack'].lineTotal], [null, '600.00']);
});

test('a parlour whose price setting is missing or unknown cannot make a bill: nothing is written', async () => {
  for (const mode of [undefined, null, '', 'both']) {
    const client = billClient({ parlour: gstParlour({ gst_price_mode: mode }) });
    world.runTransaction = (fn) => fn(client);
    await assert.rejects(service.create(staff, { items: [{ serviceId: S_CUT, quantity: 1 }], discount: 0, paymentMethod: 'cash' }), /priceMode/);
    assert.equal(client.calls.some((c) => /INSERT INTO/.test(c.text)), false, `mode ${mode}: no bill and no lines`);
  }
});

test('client-supplied tax, split, SAC or GSTIN is never used: the server works them out', async () => {
  const { wrote, items } = await makeBill(
    { items: [{ serviceId: S_CUT, quantity: 1, sacCode: '000000', unitPrice: 1 }], tax: 1, cgst: 1, sgst: 1, gstin: 'FAKE', priceMode: 'inclusive', total: 1 },
    { parlour: gstParlour() }
  );
  assert.deepEqual([wrote.tax, wrote.cgst, wrote.sgst, wrote.total, wrote.gstin, wrote.priceMode], ['10.00', '5.00', '5.00', '210.00', '33ABCDE1234F1Z5', 'exclusive']);
  assert.equal(items[0].sacCode, '999721');
});

// ───────────── what an old bill and a new bill look like when read back ─────────────

const billRow = (over = {}) => ({
  id: 'inv-1', number: 'DP-00001', customer_id: null, customer_name: 'Walk-in', created_by: 'user-A', created_by_name: 'Riya',
  subtotal: '900.00', discount: '0.00', referrer_id: null, referral_percent: '0.00', referral_discount: '0.00',
  tax_percent: '5.00', tax: '45.00', total: '945.00', payment_method: 'cash', notes: null, status: 'paid', void_reason: null, voided_at: null,
  created_at: '2026-10-18T10:30:00.000Z', price_mode: 'exclusive', cgst: null, sgst: null, gstin: null,
  parlour_name: 'Demo Parlour', parlour_phone: '9840000000', parlour_address: '12 Lake View Road', parlour_gst: '33LIVE0000L1Z5',
  parlour_timezone: 'Asia/Kolkata', customer_phone: null, referrer_code: null, referrer_name: null,
  ...over,
});
const readBack = (row, itemRows = [{ id: 'it1', combo_id: null, description: null, name: 'Haircut', sac_code: null, unit_price: '900.00', quantity: 1, line_total: '900.00' }], paymentRows = []) =>
  realGetWith({ query: async (text) => (/FROM invoice_items/.test(text) ? { rows: itemRows } : /FROM invoice_payments/.test(text) ? { rows: paymentRows } : { rows: [row] }) }, staff, 'inv-1');

test('an old bill (no split saved) reads back as it always did: one tax line, and the parlour\'s GSTIN as it is today', async () => {
  const inv = await readBack(billRow());
  assert.deepEqual([inv.cgst, inv.sgst, inv.priceMode, inv.tax, inv.taxPercent, inv.total], [null, null, 'exclusive', 45, 5, 945]);
  assert.equal(inv.gstin, '33LIVE0000L1Z5');
  assert.equal(inv.taxable, 900);
  assert.equal(inv.items[0].sacCode, null);
});

test('a new bill reads back with its own split and the GSTIN it was made under, whatever the parlour uses now', async () => {
  const inv = await readBack(
    billRow({ cgst: '22.50', sgst: '22.50', gstin: '33OLD00000O1Z5', price_mode: 'exclusive' }),
    [{ id: 'it1', combo_id: null, description: null, name: 'Haircut', sac_code: '999721', unit_price: '900.00', quantity: 1, line_total: '900.00' }]
  );
  assert.deepEqual([inv.cgst, inv.sgst, inv.taxable], [22.5, 22.5, 900]);
  assert.equal(inv.gstin, '33OLD00000O1Z5', 'the snapshot, not the parlour\'s current number');
  assert.equal(inv.items[0].sacCode, '999721');
});

test('a new bill made without a GSTIN stays without one, even if the parlour has added one since', async () => {
  const inv = await readBack(billRow({ cgst: '0.00', sgst: '0.00', tax: '0.00', tax_percent: '0.00', total: '900.00', gstin: null }));
  assert.equal(inv.gstin, null);
});

test('taxable value is worked out in whole paise (₹1,050.30 − ₹50.01 is ₹1,000.29, with no floating-point dust)', async () => {
  const inv = await readBack(billRow({ cgst: '25.01', sgst: '25.00', tax: '50.01', total: '1050.30', subtotal: '1000.29', price_mode: 'exclusive' }));
  assert.equal(inv.taxable, 1000.29);
});

// ───────────── the WhatsApp message ─────────────

const waBill = (over = {}) => ({
  number: 'DP-00007', createdAt: '2026-10-18T10:30:00.000Z', customerName: 'Cara Customer', gstin: '33ABCDE1234F1Z5',
  parlour: { name: 'Demo Parlour', phone: '9840000000', timezone: 'Asia/Kolkata' },
  items: [{ name: 'Haircut', quantity: 2, lineTotal: 400, description: null, sacCode: '999721' }, { name: 'Glow Pack', quantity: 1, lineTotal: 600, description: 'Haircut + Facial', sacCode: null }],
  subtotal: 1000, referralDiscount: 100, referralPercent: 10, referrer: { name: 'Anita Rao' }, discount: 50,
  taxPercent: 5, tax: 42.5, taxable: 850, cgst: 21.25, sgst: 21.25, priceMode: 'exclusive', total: 892.5, paymentMethod: 'upi',
  ...over,
});
const linesOf = (inv) => whatsapp.buildMessage(inv).split('\n');

test('WhatsApp, GST on top: GSTIN, SAC, taxable value, CGST and SGST, then the total', () => {
  const lines = linesOf(waBill());
  assert.equal(lines[0], '*Demo Parlour*');
  assert.equal(lines[1], 'GSTIN: 33ABCDE1234F1Z5');
  assert.ok(lines.includes('• Haircut × 2: ₹400'));
  assert.ok(lines.includes('   SAC 999721'));
  assert.ok(lines.includes('   (Haircut + Facial)'));
  const at = (s) => lines.indexOf(s);
  const order = ['Subtotal: ₹1,000', 'Referral discount (Anita Rao, 10%): − ₹100', 'Discount: − ₹50', 'Taxable value: ₹850', 'CGST 2.5%: ₹21.25', 'SGST 2.5%: ₹21.25', '*Total: ₹892.50*', 'Paid by UPI'].map(at);
  assert.ok(order.every((n) => n >= 0), `every line is there: ${lines.join(' | ')}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in this order');
  assert.equal(lines.some((l) => /^GST \d/.test(l)), false, 'no single GST line on a bill with a split');
});

test('WhatsApp, GST inside the price: the split is shown under the total as the part of it that is GST', () => {
  const lines = linesOf(waBill({ priceMode: 'inclusive', subtotal: 1000, referralDiscount: 100, discount: 50, tax: 40.48, taxable: 809.52, cgst: 20.24, sgst: 20.24, total: 850 }));
  const at = (s) => lines.indexOf(s);
  assert.ok(lines.includes('Subtotal (incl. GST): ₹1,000'));
  const order = ['*Total: ₹850*', 'Total includes GST of ₹40.48:', 'Taxable value: ₹809.52', 'CGST 2.5%: ₹20.24', 'SGST 2.5%: ₹20.24'].map(at);
  assert.ok(order.every((n) => n >= 0), lines.join(' | '));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('WhatsApp, an old bill: still one "GST 5%" line and no CGST/SGST, with the GSTIN it has always had on screen', () => {
  const lines = linesOf(waBill({ cgst: null, sgst: null, taxable: 850, items: [{ name: 'Haircut', quantity: 2, lineTotal: 400, description: null, sacCode: null }] }));
  assert.ok(lines.includes('GST 5%: ₹42.50'));
  assert.equal(lines.some((l) => /CGST|SGST|Taxable value/.test(l)), false);
  assert.equal(lines.some((l) => /SAC/.test(l)), false);
  assert.equal(lines[1], 'GSTIN: 33ABCDE1234F1Z5');
});

test('WhatsApp: no GSTIN line without a GSTIN, and no GST lines on a bill with no tax', () => {
  const lines = linesOf(waBill({ gstin: null, tax: 0, taxPercent: 0, taxable: 850, cgst: 0, sgst: 0, total: 850 }));
  assert.equal(lines.some((l) => /GSTIN|GST|CGST|SGST|Taxable/.test(l)), false);
  assert.ok(lines.includes('*Total: ₹850*'));
});

test('WhatsApp: a half rate with a decimal is shown as it is (18% is 9% + 9%, 12.5% is 6.25% + 6.25%)', () => {
  assert.ok(linesOf(waBill({ taxPercent: 18 })).includes('CGST 9%: ₹21.25'));
  assert.ok(linesOf(waBill({ taxPercent: 12.5 })).includes('SGST 6.25%: ₹21.25'));
});
