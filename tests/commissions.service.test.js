// No database and no running API: node --test tests/commissions.service.test.js   (or: npm run test:unit)
// The real invoice, commissions and referrers services run here against a scripted stand-in for the database, so the test sees
// exactly what is written to each bill line (who performed it, its share of the bill, the commission and the rule it came from),
// what is refused before anything is saved, and what "Mark as paid" writes and refuses.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (modulePath, exports) => {
  const file = require.resolve(modulePath);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const world = { runTransaction: null, poolQuery: null };
stub('../src/config/db', {
  pool: {},
  query: async (text, params) => {
    if (world.poolQuery) return world.poolQuery(text, params);
    throw new Error(`unexpected query on the pool: ${text.slice(0, 70)}`);
  },
  withTransaction: async (fn) => world.runTransaction(fn),
});
stub('../src/config/env', { whatsappCountryCode: '91' });

const invoices = require('../src/modules/invoices/invoices.service');
const commissions = require('../src/modules/commissions/commissions.service');
const referrers = require('../src/modules/referrers/referrers.service');
const { fingerprintOf } = require('../src/modules/invoices/idempotency');
const realGetWith = invoices.getWith;

const S_CUT = '11111111-1111-4111-8111-111111111111';
const S_COSTLY = '33333333-3333-4333-8333-333333333333';
const COMBO = '44444444-4444-4444-8444-444444444444';
const MEENA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASHA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REF = '55555555-5555-4555-8555-555555555555';
const staff = { userId: 'user-A', parlourId: 'parlour-A', role: 'staff' };
const admin = { userId: 'admin-A', parlourId: 'parlour-A', role: 'admin' };

const MENU = {
  [S_CUT]: { id: S_CUT, name: 'Haircut', price: '200.00', sac_code: '999721' },
  [S_COSTLY]: { id: S_COSTLY, name: 'Massage', price: '1000.00', sac_code: '999722' },
};
const PEOPLE = { [MEENA]: { id: MEENA, name: 'Meena' }, [ASHA]: { id: ASHA, name: 'Asha' } };
const gstParlour = (over = {}) => ({ tax_percent: '5.00', gst_price_mode: 'exclusive', gst_number: '33ABCDE1234F1Z5', ...over });

/**
 * A scripted transaction client for one bill.
 *   people  which performers exist, are active and belong to this parlour (the rows the performers query returns)
 *   rules   the commission_rules rows the rules query returns
 */
function billClient({ parlour = gstParlour(), people = [PEOPLE[MEENA], PEOPLE[ASHA]], rules = [], referrer = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM services WHERE/.test(text)) return { rows: params[1].map((id) => MENU[id]) };
      if (/FROM combos WHERE/.test(text)) return { rows: [{ id: COMBO, name: 'Glow Pack', price: '600.00' }] };
      if (/FROM combo_items/.test(text)) return { rows: [{ combo_id: COMBO, quantity: 1, name: 'Facial', is_active: true }, { combo_id: COMBO, quantity: 1, name: 'Wax', is_active: true }] };
      if (/FROM performers WHERE/.test(text)) return { rows: people.filter((p) => params[1].includes(p.id)) };
      if (/FROM commission_rules\s+WHERE/.test(text)) return { rows: rules };
      if (/FROM referrers WHERE/.test(text)) return { rows: referrer ? [referrer] : [] };
      if (/UPDATE parlours SET invoice_seq/.test(text)) return { rows: [{ invoice_prefix: 'DP', invoice_seq: 7, ...parlour }] };
      if (/INSERT INTO invoices/.test(text)) return { rows: [{ id: 'new-invoice-id' }] };
      if (/INSERT INTO invoice_items/.test(text)) return { rows: [] };
      if (/INSERT INTO invoice_payments/.test(text)) return { rows: [] };
      throw new Error(`unexpected query in the transaction: ${text.slice(0, 70)}`);
    },
  };
}

/** Makes a bill. Returns the lines as written, the queries asked, or the error if it was refused. */
async function makeBill(body, clientOptions = {}) {
  const client = billClient(clientOptions);
  world.runTransaction = (fn) => fn(client);
  invoices.getWith = async () => ({ ok: true });
  let error = null;
  try {
    await invoices.create(staff, { discount: 0, paymentMethod: 'cash', ...body });
  } catch (err) {
    error = err;
  } finally {
    invoices.getWith = realGetWith;
  }
  const items = client.calls.filter((c) => /INSERT INTO invoice_items/.test(c.text)).map((c) => ({
    name: c.params[4], quantity: c.params[6], lineTotal: c.params[7],
    net: c.params[9], performedBy: c.params[10], performerName: c.params[11],
    kind: c.params[12], rate: c.params[13], commission: c.params[14],
  }));
  const bill = client.calls.find((c) => /INSERT INTO invoices/.test(c.text))?.params;
  return { error, items, bill, calls: client.calls, asked: (re) => client.calls.filter((c) => re.test(c.text)) };
}

const by = (id, extra) => ({ serviceId: S_CUT, quantity: 1, performedBy: id, ...extra });
const rule = (kind, value, target) => ({ kind, value, performer_id: null, service_id: null, ...target });

// ───────────── nobody named: nothing changes except the share of the bill ─────────────

test('a bill that names nobody asks no performer or rule questions, earns no commission, and still records each line\'s share', async () => {
  const r = await makeBill({ items: [{ serviceId: S_CUT, quantity: 1 }, { serviceId: S_COSTLY, quantity: 1 }] });
  assert.equal(r.error, null);
  assert.equal(r.asked(/performers|commission_rules/).length, 0, 'no extra queries for a bill that names nobody');
  // ₹1,200 + 5% GST: the taxable value is ₹1,200, so each line keeps its own price
  assert.deepEqual(r.items.map((i) => [i.name, i.net, i.performedBy, i.performerName, i.kind, i.rate, i.commission]),
    [['Haircut', '200.00', null, null, null, null, '0.00'], ['Massage', '1000.00', null, null, null, null, '0.00']]);
});

// ───────────── a person named ─────────────

test('a person with a percentage rule: the line records who, their share, the rule as it was, and the commission', async () => {
  const r = await makeBill({ items: [by(MEENA)] }, { rules: [rule('percent', '10.00', { performer_id: MEENA })] });
  assert.equal(r.error, null);
  assert.deepEqual(r.items, [{ name: 'Haircut', quantity: 1, lineTotal: '200.00', net: '200.00', performedBy: MEENA, performerName: 'Meena', kind: 'percent', rate: '10.00', commission: '20.00' }]);
});

test('a person with no rule and no service rule is recorded as the performer and earns nothing', async () => {
  const r = await makeBill({ items: [by(ASHA)] });
  assert.deepEqual([r.items[0].performedBy, r.items[0].performerName, r.items[0].kind, r.items[0].rate, r.items[0].commission], [ASHA, 'Asha', null, null, '0.00']);
});

test('the PERSON\'s rule wins when the service has one too; the service\'s rule applies when the person has none', async () => {
  const rules = [rule('percent', '10.00', { performer_id: MEENA }), rule('flat', '50.00', { service_id: S_CUT })];
  const both = await makeBill({ items: [by(MEENA)] }, { rules });
  assert.deepEqual([both.items[0].kind, both.items[0].rate, both.items[0].commission], ['percent', '10.00', '20.00']);
  const serviceOnly = await makeBill({ items: [by(ASHA)] }, { rules });
  assert.deepEqual([serviceOnly.items[0].kind, serviceOnly.items[0].rate, serviceOnly.items[0].commission], ['flat', '50.00', '50.00']);
});

test('a flat amount is paid for each unit, and never more than the line took in', async () => {
  const rules = [rule('flat', '150.00', { service_id: S_CUT })];
  const two = await makeBill({ items: [by(ASHA, { quantity: 2 })] }, { rules });            // ₹400 line, ₹150 × 2 = ₹300
  assert.equal(two.items[0].commission, '300.00');
  const capped = await makeBill({ items: [by(ASHA, { quantity: 1 })], discount: 100 }, { rules });  // ₹200 − ₹100 = ₹100 taken, ₹150 flat → ₹100
  assert.deepEqual([capped.items[0].net, capped.items[0].commission], ['100.00', '100.00']);
});

test('a combo has no single service, so only the person\'s rule can apply to it', async () => {
  const rules = [rule('percent', '10.00', { performer_id: MEENA }), rule('flat', '99.00', { service_id: S_CUT })];
  const mine = await makeBill({ items: [{ comboId: COMBO, quantity: 1, performedBy: MEENA }] }, { rules });
  assert.deepEqual([mine.items[0].name, mine.items[0].net, mine.items[0].kind, mine.items[0].commission], ['Glow Pack', '600.00', 'percent', '60.00']);
  const noRule = await makeBill({ items: [{ comboId: COMBO, quantity: 1, performedBy: ASHA }] }, { rules });
  assert.deepEqual([noRule.items[0].kind, noRule.items[0].commission], [null, '0.00'], 'a service rule never applies to a combo');
});

test('commission is on what the line took in: after the referral and manual discounts, before GST', async () => {
  // ₹1,200 = Haircut ₹200 + Massage ₹1,000; referral 10% = ₹120; manual ₹30 → taxable ₹1,050
  const rules = [rule('percent', '10.00', { performer_id: MEENA })];
  const r = await makeBill({ items: [by(MEENA), { serviceId: S_COSTLY, quantity: 1, performedBy: MEENA }], referrerId: REF, discount: 30 },
    { rules, referrer: { id: REF, contact: '9841100001', percent: '10.00' } });
  assert.equal(r.error, null);
  assert.deepEqual(r.items.map((i) => i.net), ['175.00', '875.00']);                    // 200/1200 and 1000/1200 of ₹1,050
  assert.deepEqual(r.items.map((i) => i.commission), ['17.50', '87.50']);
  assert.equal(r.items.reduce((s, i) => s + Math.round(Number(i.net) * 100), 0), 105_000, 'the shares add up to the taxable value');
});

test('with GST inside the prices, commission is on the value before GST, to the paisa', async () => {
  const rules = [rule('percent', '10.00', { performer_id: MEENA })];
  const r = await makeBill({ items: [{ serviceId: S_COSTLY, quantity: 1, performedBy: MEENA }] }, { parlour: gstParlour({ gst_price_mode: 'inclusive' }), rules });
  assert.deepEqual([r.items[0].lineTotal, r.items[0].net, r.items[0].commission], ['1000.00', '952.38', '95.24']);
});

test('the tip is never part of the base', async () => {
  const rules = [rule('percent', '10.00', { performer_id: MEENA })];
  const r = await makeBill({ items: [by(MEENA)], tip: 40 }, { rules });
  assert.deepEqual([r.items[0].net, r.items[0].commission], ['200.00', '20.00']);
});

// ───────────── lines for different people stay apart ─────────────

test('the same service by two people is two lines, each credited to its own person; by the same person it is one line', async () => {
  const rules = [rule('percent', '10.00', { performer_id: MEENA }), rule('percent', '20.00', { performer_id: ASHA })];
  const two = await makeBill({ items: [by(MEENA), by(ASHA)] }, { rules });
  assert.deepEqual(two.items.map((i) => [i.performerName, i.quantity, i.commission]), [['Meena', 1, '20.00'], ['Asha', 1, '40.00']]);
  assert.equal(two.asked(/FROM services WHERE/)[0].params[1].length, 1, 'the service is looked up once');
  const same = await makeBill({ items: [by(MEENA), by(MEENA, { quantity: 2 })] }, { rules });
  assert.deepEqual(same.items.map((i) => [i.performerName, i.quantity, i.lineTotal]), [['Meena', 3, '600.00']]);
  const mixed = await makeBill({ items: [{ serviceId: S_CUT, quantity: 1 }, by(MEENA)] }, { rules });
  assert.equal(mixed.items.length, 2, 'a line nobody was chosen for stays apart from one somebody was');
});

// ───────────── refused before anything is saved ─────────────

test('a person who is not available (unknown, inactive, or in another parlour) is refused and the bill is not saved', async () => {
  const r = await makeBill({ items: [by(MEENA)] }, { people: [] });
  assert.equal(r.error?.code, 'PERFORMER_UNAVAILABLE');
  assert.equal(r.error?.status, 400);
  assert.equal(r.asked(/INSERT INTO/).length, 0, 'nothing is written');
  assert.equal(r.asked(/UPDATE parlours SET invoice_seq/).length, 0, 'no bill number is taken');
  // one of two missing is still refused
  const half = await makeBill({ items: [by(MEENA), by(ASHA)] }, { people: [PEOPLE[MEENA]] });
  assert.equal(half.error?.code, 'PERFORMER_UNAVAILABLE');
});

test('people and rules are only ever looked up inside the caller\'s own parlour, and the people are held until the bill is saved', async () => {
  const r = await makeBill({ items: [by(MEENA)] }, { rules: [] });
  const people = r.asked(/FROM performers WHERE/)[0];
  assert.equal(people.params[0], 'parlour-A');
  assert.match(people.text, /parlour_id = \$1/);
  assert.match(people.text, /is_active/);
  assert.match(people.text, /FOR SHARE/);
  const rules = r.asked(/FROM commission_rules\s+WHERE/)[0];
  assert.equal(rules.params[0], 'parlour-A');
  assert.match(rules.text, /parlour_id = \$1/);
});

// ───────────── the request fingerprint (idempotency) ─────────────

test('idempotency: naming a person changes the fingerprint; naming nobody leaves it exactly as it was; line order does not matter', () => {
  const base = { items: [{ serviceId: S_CUT, quantity: 1 }], discount: 0, paymentMethod: 'cash' };
  const withPerson = { ...base, items: [{ serviceId: S_CUT, quantity: 1, performedBy: MEENA }] };
  const withNull = { ...base, items: [{ serviceId: S_CUT, quantity: 1, performedBy: null }] };
  assert.notEqual(fingerprintOf(base), fingerprintOf(withPerson));
  assert.equal(fingerprintOf(base), fingerprintOf(withNull), 'null means nobody, the same as not naming anyone');
  assert.notEqual(fingerprintOf(withPerson), fingerprintOf({ ...base, items: [{ serviceId: S_CUT, quantity: 1, performedBy: ASHA }] }));
  const ab = { ...base, items: [{ serviceId: S_CUT, quantity: 1, performedBy: MEENA }, { serviceId: S_COSTLY, quantity: 1, performedBy: ASHA }] };
  const ba = { ...base, items: [ab.items[1], ab.items[0]] };
  assert.equal(fingerprintOf(ab), fingerprintOf(ba));
  // the fingerprint of an old-shape request is the one it has always had (a retry across an upgrade still finds its bill)
  assert.equal(fingerprintOf(base), require('node:crypto').createHash('sha256').update(JSON.stringify({
    customerId: null, walkInName: '', lines: [[`service:${S_CUT}`, 1]], referrerId: null, discountPaise: 0, paymentMethod: 'cash', notes: '',
  })).digest('hex'));
});

// ───────────── reading a bill back ─────────────

test('reading a bill shows who performed each line, and never what they earned', async () => {
  const itemRows = [
    { id: 'it1', combo_id: null, description: null, name: 'Haircut', sac_code: '999721', unit_price: '200.00', quantity: 1, line_total: '200.00', performed_by: MEENA, performer_name: 'Meena' },
    { id: 'it2', combo_id: null, description: null, name: 'Massage', sac_code: '999722', unit_price: '1000.00', quantity: 1, line_total: '1000.00' },   // a bill from before this existed
  ];
  const row = {
    id: 'inv-1', number: 'DP-00001', status: 'paid', customer_id: null, customer_name: 'Walk-in', customer_phone: null, created_by: 'user-A', created_by_name: 'Crew',
    subtotal: '1200.00', discount: '0.00', tax_percent: '5.00', tax: '60.00', total: '1260.00', payment_method: 'cash', created_at: new Date('2026-11-01T05:00:00Z'),
    referral_percent: '0', referral_discount: '0.00', price_mode: 'exclusive', cgst: '30.00', sgst: '30.00', tip: '0.00',
  };
  const inv = await realGetWith({ query: async (text) => (/FROM invoice_items/.test(text) ? { rows: itemRows } : /FROM invoice_payments/.test(text) ? { rows: [] } : { rows: [row] }) }, admin, 'inv-1');
  assert.deepEqual(inv.items.map((i) => [i.name, i.performedBy, i.performerName]), [['Haircut', MEENA, 'Meena'], ['Massage', null, null]]);
  assert.equal(JSON.stringify(inv).includes('commission'), false, 'commission is not on the bill the customer or staff can see');
});

// ───────────── "Mark as paid": commission ─────────────

/** A scripted client for one payout. `owed` are the unpaid lines the query returns; `person` is the performers row (null = not this parlour's). */
function payClient({ person = { id: MEENA, name: 'Meena' }, owed = [], updated } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM performers WHERE/.test(text)) return { rows: person ? [person] : [] };
      if (/FROM invoice_items it/.test(text)) return { rows: owed };
      if (/INSERT INTO commission_payouts/.test(text)) return { rows: [{ id: 'payout-1', paid_at: new Date('2026-11-04T05:00:00Z') }] };
      if (/UPDATE invoice_items SET commission_payout_id/.test(text)) return { rowCount: updated ?? params[1].length, rows: [] };
      throw new Error(`unexpected query in the payout: ${text.slice(0, 70)}`);
    },
  };
}
async function pay(body, opts) {
  const client = payClient(opts);
  world.runTransaction = (fn) => fn(client);
  let result = null;
  let error = null;
  try { result = await commissions.pay(admin, { performerId: MEENA, from: '2026-11-01', to: '2026-11-07', ...body }); } catch (err) { error = err; }
  return { result, error, calls: client.calls, wrote: client.calls.filter((c) => /^\s*(INSERT|UPDATE)/.test(c.text)) };
}
const OWED = [{ id: 'l1', commission: '20.00' }, { id: 'l2', commission: '87.50' }, { id: 'l3', commission: '0.05' }];   // ₹107.55

test('commission payout: pays exactly what is owed, links every line to the payout, records who paid and the dates', async () => {
  const r = await pay({ expectedAmount: 107.55 }, { owed: OWED });
  assert.equal(r.error, null);
  assert.deepEqual([r.result.amount, r.result.lines, r.result.performerName, r.result.from, r.result.to], [107.55, 3, 'Meena', '2026-11-01', '2026-11-07']);
  const insert = r.calls.find((c) => /INSERT INTO commission_payouts/.test(c.text)).params;
  assert.deepEqual(insert, ['parlour-A', MEENA, 'Meena', '2026-11-01', '2026-11-07', '107.55', 3, 'admin-A']);
  assert.deepEqual(r.calls.find((c) => /UPDATE invoice_items SET commission_payout_id/.test(c.text)).params, ['payout-1', ['l1', 'l2', 'l3']]);
});

test('commission payout: the sum is exact in paise (no floating-point drift across many lines)', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `l${i}`, commission: '0.10' }));   // 300 × ₹0.10 = ₹30.00 exactly
  const r = await pay({ expectedAmount: 30 }, { owed: many });
  assert.equal(r.error, null, r.error?.message);
  assert.equal(r.result.amount, 30);
  const tenths = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, commission: '0.10' }));
  assert.equal((await pay({ expectedAmount: 0.3 }, { owed: tenths })).error, null, '0.1 + 0.1 + 0.1 is ₹0.30, not 0.30000000000000004');
});

test('commission payout: if what is owed is not exactly what the admin saw, NOTHING is paid and the new amount is told', async () => {
  const r = await pay({ expectedAmount: 100 }, { owed: OWED });
  assert.equal(r.error?.status, 409);
  assert.equal(r.error?.code, 'AMOUNT_CHANGED');
  assert.match(r.error.message, /₹107\.55/);
  assert.match(r.error.message, /₹100\.00/);
  assert.equal(r.wrote.length, 0, 'nothing is written');
  assert.equal((await pay({ expectedAmount: 107.54 }, { owed: OWED })).error?.code, 'AMOUNT_CHANGED', 'a paisa off is still refused');
});

test('commission payout: pressing it again, with nothing left to pay, pays nothing', async () => {
  const r = await pay({ expectedAmount: 107.55 }, { owed: [] });
  assert.equal(r.error?.code, 'NOTHING_TO_PAY');
  assert.equal(r.error?.status, 409);
  assert.equal(r.wrote.length, 0);
});

test('commission payout: someone who is not this parlour\'s person is "not found", and nothing else is asked', async () => {
  const r = await pay({ expectedAmount: 50 }, { person: null, owed: OWED });
  assert.equal(r.error?.status, 404);
  assert.equal(r.calls.length, 1, 'stops at the person lookup');
  assert.deepEqual(r.calls[0].params, [MEENA, 'parlour-A']);
});

test('commission payout: only commission from bills that stand and is still unpaid, in this parlour, for this person and these dates, is asked for and locked', async () => {
  const r = await pay({ expectedAmount: 107.55 }, { owed: OWED });
  const q = r.calls.find((c) => /FROM invoice_items it/.test(c.text));
  assert.deepEqual(q.params, ['parlour-A', MEENA, '2026-11-01', '2026-11-07']);
  assert.match(q.text, /i\.parlour_id = \$1/);
  assert.match(q.text, /it\.performed_by = \$2/);
  assert.match(q.text, /i\.status = 'paid'/, 'void bills are not paid out');
  assert.match(q.text, /commission_payout_id IS NULL/, 'what was paid before is not paid again');
  assert.match(q.text, /FOR UPDATE OF it, i/, 'the lines and their bills are locked while paying');
  assert.match(r.calls[0].text, /FOR UPDATE/, 'the person is locked, so two payouts for one person run one after the other');
});

test('commission payout: if the update did not cover every line it counted, the whole payout is rolled back (it throws)', async () => {
  const r = await pay({ expectedAmount: 107.55 }, { owed: OWED, updated: 2 });
  assert.ok(r.error, 'an error is thrown so the transaction rolls back');
  assert.equal(r.result, null);
});

// ───────────── "Mark as paid": referral ─────────────

function refClient({ referrer = { id: REF, code: 'REF-0001', name: 'Anita Rao' }, owed = [], updated } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM referrers WHERE/.test(text)) return { rows: referrer ? [referrer] : [] };
      if (/FROM invoices\s+WHERE/.test(text)) return { rows: owed };
      if (/INSERT INTO referral_payouts/.test(text)) return { rows: [{ id: 'rp-1', paid_at: new Date('2026-11-04T05:00:00Z') }] };
      if (/UPDATE invoices SET referral_payout_id/.test(text)) return { rowCount: updated ?? params[1].length, rows: [] };
      throw new Error(`unexpected query in the referral payout: ${text.slice(0, 70)}`);
    },
  };
}
async function payReferrer(expectedAmount, opts) {
  const client = refClient(opts);
  world.runTransaction = (fn) => fn(client);
  let result = null;
  let error = null;
  try { result = await referrers.pay(admin, REF, { expectedAmount }); } catch (err) { error = err; }
  return { result, error, calls: client.calls, wrote: client.calls.filter((c) => /^\s*(INSERT|UPDATE)/.test(c.text)) };
}
const BILLS = [{ id: 'b1', referral_discount: '100.00' }, { id: 'b2', referral_discount: '40.50' }];   // ₹140.50

test('referral payout: pays what is owed, links every bill to it, records the name and ID as they were', async () => {
  const r = await payReferrer(140.5, { owed: BILLS });
  assert.equal(r.error, null, r.error?.message);
  assert.deepEqual([r.result.amount, r.result.bills, r.result.referrerName], [140.5, 2, 'Anita Rao']);
  assert.deepEqual(r.calls.find((c) => /INSERT INTO referral_payouts/.test(c.text)).params, ['parlour-A', REF, 'Anita Rao', 'REF-0001', '140.50', 2, 'admin-A']);
  assert.deepEqual(r.calls.find((c) => /UPDATE invoices SET referral_payout_id/.test(c.text)).params, ['rp-1', ['b1', 'b2']]);
});

test('referral payout: a changed amount pays nothing; nothing owed pays nothing; another parlour\'s referrer is not found', async () => {
  const changed = await payReferrer(100, { owed: BILLS });
  assert.deepEqual([changed.error?.status, changed.error?.code, changed.wrote.length], [409, 'AMOUNT_CHANGED', 0]);
  assert.match(changed.error.message, /₹140\.50/);
  const none = await payReferrer(140.5, { owed: [] });
  assert.deepEqual([none.error?.status, none.error?.code, none.wrote.length], [409, 'NOTHING_TO_PAY', 0]);
  const other = await payReferrer(140.5, { referrer: null, owed: BILLS });
  assert.equal(other.error?.status, 404);
  assert.equal(other.calls.length, 1);
});

test('referral payout: only this referrer\'s bills that stand and are still unpaid, in this parlour, are asked for and locked', async () => {
  const r = await payReferrer(140.5, { owed: BILLS });
  const q = r.calls.find((c) => /FROM invoices\s+WHERE/.test(c.text));
  assert.deepEqual(q.params, ['parlour-A', REF]);
  assert.match(q.text, /parlour_id = \$1/);
  assert.match(q.text, /referrer_id = \$2/);
  assert.match(q.text, /status = 'paid'/, 'a voided bill takes its referral amount with it');
  assert.match(q.text, /referral_payout_id IS NULL/);
  assert.match(q.text, /FOR UPDATE/);
  assert.match(r.calls[0].text, /parlour_id = \$2 FOR UPDATE/);
});
