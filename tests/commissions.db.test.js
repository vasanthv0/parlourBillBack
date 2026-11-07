// Checks performers, commission rules, the commission snapshot on bill lines, the payouts, and the reports, in PostgreSQL itself.
// Needs the database from your .env (run `npm run db:init` once); it does NOT need the API running.      npm run test:db
//
// Everything happens inside ONE transaction per test that is always rolled back, so the database is left exactly as it was found.
// The real services run here: they are pointed at that one transaction, so what they write is what the test then reads back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const realDb = require('../src/config/db');
let current = null; // the transaction of the test that is running
const dbFile = require.resolve('../src/config/db');
require.cache[dbFile].exports = {
  pool: realDb.pool,
  query: (text, params) => current.query(text, params),
  withTransaction: (fn) => fn(current), // already inside the test's transaction, which is rolled back at the end
};
const invoices = require('../src/modules/invoices/invoices.service');
const commissions = require('../src/modules/commissions/commissions.service');
const referrers = require('../src/modules/referrers/referrers.service');
const performers = require('../src/modules/performers/performers.service');
const reports = require('../src/modules/reports/reports.service');

test.after(() => realDb.pool.end());

async function inRolledBackTransaction(fn) {
  const client = await realDb.pool.connect();
  try {
    await client.query('BEGIN');
    current = client;
    return await fn(client);
  } finally {
    current = null;
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** Runs a statement that the database must refuse for this reason, then carries on (the transaction is kept alive). */
async function refused(client, code, text, params = []) {
  await client.query('SAVEPOINT attempt');
  try {
    await client.query(text, params);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    assert.equal(err.code, code, `expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  await client.query('ROLLBACK TO SAVEPOINT attempt');
  assert.fail(`the database accepted this: ${text.slice(0, 80)} ${JSON.stringify(params)}`);
}

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

let counter = 0;
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}${++counter}`;
const rupees = (n) => Math.round(n * 100);

/** A parlour with 5% GST (on top of its prices unless said otherwise), an admin, a menu (Cut ₹200, Massage ₹1,000) and two people. */
async function makeParlour(c, { priceMode = 'exclusive' } = {}) {
  const { rows: [p] } = await c.query(`INSERT INTO parlours (name, tax_percent, gst_price_mode) VALUES ($1, 5, $2) RETURNING id`, [`Commission Test ${stamp()}`, priceMode]);
  const { rows: [u] } = await c.query(
    `INSERT INTO users (parlour_id, name, email, password_hash, role) VALUES ($1, 'Owner', $2, 'x', 'admin') RETURNING id`, [p.id, `owner${stamp()}@test.parlour`]);
  const service = async (name, price) =>
    (await c.query(`INSERT INTO services (parlour_id, name, category, price, duration_min) VALUES ($1,$2,'General',$3,30) RETURNING id`, [p.id, name, price])).rows[0].id;
  const person = async (name) => (await c.query(`INSERT INTO performers (parlour_id, name) VALUES ($1,$2) RETURNING id`, [p.id, name])).rows[0].id;
  return {
    parlourId: p.id, auth: { userId: u.id, parlourId: p.id, role: 'admin' },
    cut: await service('Cut', 200), massage: await service('Massage', 1000),
    meena: await person('Meena'), asha: await person('Asha'),
  };
}
const bill = async (world, items, extra = {}) => (await invoices.create(world.auth, { discount: 0, paymentMethod: 'cash', items, ...extra })).invoice;
const itemsOf = async (c, invoiceId) =>
  (await c.query(`SELECT name, net_amount, performed_by, performer_name, commission_kind, commission_rate, commission, commission_payout_id FROM invoice_items WHERE invoice_id = $1 ORDER BY name, performer_name`, [invoiceId])).rows;

/** Yesterday to tomorrow in the parlour's own time zone: wide enough to hold a bill made now, narrow enough for a report (a year at most). */
async function around(c, parlourId) {
  const { rows: [r] } = await c.query(
    `SELECT to_char((now() AT TIME ZONE timezone)::date - 1, 'YYYY-MM-DD') AS from_date,
            to_char((now() AT TIME ZONE timezone)::date + 1, 'YYYY-MM-DD') AS to_date FROM parlours WHERE id = $1`, [parlourId]);
  return { from: r.from_date, to: r.to_date };
}

// ───────────── the schema ─────────────

test('db:init can be run again and again: bill lines from before this existed are untouched, and get no performer, no commission and no share', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  const { rows: [inv] } = await c.query(`INSERT INTO invoices (parlour_id, number, subtotal, tax, total, payment_method) VALUES ($1, $2, 200, 0, 200, 'cash') RETURNING id`, [w.parlourId, `OLD-${stamp()}`]);
  await c.query(`INSERT INTO invoice_items (invoice_id, name, unit_price, quantity, line_total) VALUES ($1, 'Haircut', 200, 1, 200)`, [inv.id]);
  const snapshot = async () => (await c.query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [inv.id])).rows;
  const before = await snapshot();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await c.query(sql);
  await c.query(sql);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual([before[0].net_amount, before[0].performed_by, before[0].commission_kind, before[0].commission, before[0].commission_payout_id], [null, null, null, '0.00', null]);
}));

test('performers: a name is used once in a parlour whatever its capitalisation, but another parlour may use it', () => inRolledBackTransaction(async (c) => {
  const a = await makeParlour(c);
  const b = await makeParlour(c);
  await refused(c, UNIQUE_VIOLATION, `INSERT INTO performers (parlour_id, name) VALUES ($1, 'MEENA')`, [a.parlourId]);
  await refused(c, UNIQUE_VIOLATION, `INSERT INTO performers (parlour_id, name) VALUES ($1, 'meena')`, [a.parlourId]);
  // makeParlour already gave each parlour its own 'Meena': the same name in two parlours is fine.
  for (const w of [a, b]) {
    assert.equal((await c.query(`SELECT COUNT(*)::int AS n FROM performers WHERE parlour_id = $1 AND lower(name) = 'meena'`, [w.parlourId])).rows[0].n, 1);
  }
}));

test('commission rules: one target only, a sensible value, and one rule per person or service', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  const insert = (performer, service, kind, value) => [`INSERT INTO commission_rules (parlour_id, performer_id, service_id, kind, value) VALUES ($1,$2,$3,$4,$5)`, [w.parlourId, performer, service, kind, value]];
  await refused(c, CHECK_VIOLATION, ...insert(w.meena, w.cut, 'percent', 10));    // both
  await refused(c, CHECK_VIOLATION, ...insert(null, null, 'percent', 10));        // neither
  await refused(c, CHECK_VIOLATION, ...insert(w.meena, null, 'percent', 0));      // nothing
  await refused(c, CHECK_VIOLATION, ...insert(w.meena, null, 'percent', -5));
  await refused(c, CHECK_VIOLATION, ...insert(w.meena, null, 'percent', 100.01)); // over 100%
  await refused(c, CHECK_VIOLATION, ...insert(w.meena, null, 'bonus', 10));       // not a kind
  await c.query(...insert(w.meena, null, 'percent', 100));                        // 100% is allowed
  await c.query(...insert(null, w.cut, 'flat', 5000));                            // a flat amount can be large
  await refused(c, UNIQUE_VIOLATION, ...insert(w.meena, null, 'flat', 50));       // one rule per person
  await refused(c, UNIQUE_VIOLATION, ...insert(null, w.cut, 'percent', 5));       // one rule per service
  await c.query(...insert(w.asha, null, 'flat', 50));                             // another person is fine
}));

test('bill lines: a rule is all there or not there at all, no rule means no commission, and only commission that exists can be paid out', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  const { rows: [inv] } = await c.query(`INSERT INTO invoices (parlour_id, number, subtotal, tax, total, payment_method) VALUES ($1, $2, 200, 0, 200, 'cash') RETURNING id`, [w.parlourId, `CK-${stamp()}`]);
  const { rows: [po] } = await c.query(
    `INSERT INTO commission_payouts (parlour_id, performer_id, performer_name, from_date, to_date, amount, line_count) VALUES ($1,$2,'Meena','2026-11-01','2026-11-07',20,1) RETURNING id`, [w.parlourId, w.meena]);
  const item = (cols) => {
    const row = { invoice_id: inv.id, name: 'Haircut', unit_price: 200, quantity: 1, line_total: 200, ...cols };
    return [`INSERT INTO invoice_items (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row)];
  };
  await c.query(...item({ commission_kind: 'percent', commission_rate: 10, commission: 20 }));                                  // ok
  await c.query(...item({ commission_kind: 'flat', commission_rate: 50, commission: 0 }));                                      // a rule that came to 0 is ok
  await c.query(...item({ commission_kind: 'percent', commission_rate: 10, commission: 20, commission_payout_id: po.id }));    // paid out, ok
  await refused(c, CHECK_VIOLATION, ...item({ commission_kind: 'percent', commission: 20 }));                                    // a kind with no rate
  await refused(c, CHECK_VIOLATION, ...item({ commission_rate: 10, commission: 20 }));                                          // a rate with no kind
  await refused(c, CHECK_VIOLATION, ...item({ commission: 20 }));                                                               // commission with no rule at all
  await refused(c, CHECK_VIOLATION, ...item({ commission_kind: 'percent', commission_rate: 10, commission: 0, commission_payout_id: po.id })); // nothing to pay out
  await refused(c, CHECK_VIOLATION, ...item({ commission_kind: 'percent', commission_rate: 10, commission: -1 }));               // never negative
  await refused(c, CHECK_VIOLATION, ...item({ net_amount: -1 }));
}));

test('payouts: an amount above 0, at least one line or bill, and dates in order', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  const commission = (amount, lines, from, to) => [`INSERT INTO commission_payouts (parlour_id, performer_name, from_date, to_date, amount, line_count) VALUES ($1,'Meena',$4,$5,$2,$3)`, [w.parlourId, amount, lines, from, to]];
  await c.query(...commission(20, 1, '2026-11-01', '2026-11-07'));
  await c.query(...commission(20, 1, '2026-11-07', '2026-11-07'));
  await refused(c, CHECK_VIOLATION, ...commission(0, 1, '2026-11-01', '2026-11-07'));
  await refused(c, CHECK_VIOLATION, ...commission(20, 0, '2026-11-01', '2026-11-07'));
  await refused(c, CHECK_VIOLATION, ...commission(20, 1, '2026-11-08', '2026-11-07'));
  const referral = (amount, bills) => [`INSERT INTO referral_payouts (parlour_id, referrer_name, referrer_code, amount, bill_count) VALUES ($1,'Anita','REF-0001',$2,$3)`, [w.parlourId, amount, bills]];
  await c.query(...referral(40, 1));
  await refused(c, CHECK_VIOLATION, ...referral(0, 1));
  await refused(c, CHECK_VIOLATION, ...referral(40, 0));
}));

test('deleting a parlour removes everything of it, including payouts that bill lines point at (no foreign-key error)', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  await commissions.putRule(w.parlourId, { performerId: w.meena, kind: 'percent', value: 10 });
  const inv = await bill(w, [{ serviceId: w.cut, quantity: 1, performedBy: w.meena }]);
  const person = await commissions.pay(w.auth, { performerId: w.meena, from: '2000-01-01', to: '2099-12-31', expectedAmount: 20 });
  const { rows: [r] } = await c.query(`INSERT INTO referrers (parlour_id, code, name, contact, percent) VALUES ($1,'REF-0001','Anita','9841100001',10) RETURNING id`, [w.parlourId]);
  await c.query(`UPDATE invoices SET referrer_id = $2, referral_percent = 10, referral_discount = 20 WHERE id = $1`, [inv.id, r.id]);
  await referrers.pay(w.auth, r.id, { expectedAmount: 20 });
  assert.equal(person.amount, 20);
  await c.query(`DELETE FROM parlours WHERE id = $1`, [w.parlourId]);
  for (const t of ['performers', 'commission_rules', 'commission_payouts', 'referral_payouts', 'invoices']) {
    assert.equal((await c.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE parlour_id = $1`, [w.parlourId])).rows[0].n, 0, t);
  }
  assert.equal((await c.query(`SELECT COUNT(*)::int AS n FROM invoice_items WHERE invoice_id = $1`, [inv.id])).rows[0].n, 0);
}));

// ───────────── a bill, end to end ─────────────

test('a bill with performers: each line records who, its share of the taxable value, the rule and the commission; the shares add up to the paisa', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  await commissions.putRule(w.parlourId, { performerId: w.meena, kind: 'percent', value: 10 });
  await commissions.putRule(w.parlourId, { serviceId: w.massage, kind: 'flat', value: 50 });
  // ₹200 by Meena + ₹1,000 by Asha; manual discount ₹30 → taxable ₹1,170 → shares ₹195 and ₹975
  const inv = await bill(w, [{ serviceId: w.cut, quantity: 1, performedBy: w.meena }, { serviceId: w.massage, quantity: 1, performedBy: w.asha }], { discount: 30 });
  const rows = await itemsOf(c, inv.id);
  const taxable = rupees(inv.total - inv.tax);
  assert.equal(rows.reduce((s, r) => s + rupees(Number(r.net_amount)), 0), taxable, 'the shares add up to the taxable value to the paisa');
  const cut = rows.find((r) => r.name === 'Cut');
  const massage = rows.find((r) => r.name === 'Massage');
  assert.deepEqual([cut.net_amount, cut.performer_name, cut.commission_kind, cut.commission_rate, cut.commission], ['195.00', 'Meena', 'percent', '10.00', '19.50']);
  assert.deepEqual([massage.net_amount, massage.performer_name, massage.commission_kind, massage.commission_rate, massage.commission], ['975.00', 'Asha', 'flat', '50.00', '50.00'], 'Asha has no rule of her own, so the Massage rule applies');
  assert.deepEqual(inv.items.map((i) => i.performerName).sort(), ['Asha', 'Meena']);
}));

test('a rule, a name or a price changed later never changes a bill already made', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  await commissions.putRule(w.parlourId, { performerId: w.meena, kind: 'percent', value: 10 });
  const first = await bill(w, [{ serviceId: w.cut, quantity: 1, performedBy: w.meena }]);
  await commissions.putRule(w.parlourId, { performerId: w.meena, kind: 'percent', value: 50 });
  const second = await bill(w, [{ serviceId: w.cut, quantity: 1, performedBy: w.meena }]);
  await c.query(`UPDATE performers SET name = 'Meena R' WHERE id = $1`, [w.meena]);
  await c.query(`UPDATE services SET price = 999 WHERE id = $1`, [w.cut]);
  assert.deepEqual((await itemsOf(c, first.id)).map((r) => [r.commission, r.commission_rate, r.performer_name, r.net_amount]), [['20.00', '10.00', 'Meena', '200.00']]);
  assert.deepEqual((await itemsOf(c, second.id)).map((r) => [r.commission, r.commission_rate]), [['100.00', '50.00']]);
}));

test('with GST inside the prices, commission is on the value before GST', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c, { priceMode: 'inclusive' });
  await commissions.putRule(w.parlourId, { performerId: w.meena, kind: 'percent', value: 10 });
  const inv = await bill(w, [{ serviceId: w.massage, quantity: 1, performedBy: w.meena }]);
  assert.equal(inv.total, 1000);
  assert.deepEqual((await itemsOf(c, inv.id)).map((r) => [r.net_amount, r.commission]), [['952.38', '95.24']]);
}));

test('tenant isolation: another parlour\'s person cannot be put on a bill, given a rule, paid, or looked at', () => inRolledBackTransaction(async (c) => {
  const a = await makeParlour(c);
  const b = await makeParlour(c);
  await assert.rejects(bill(a, [{ serviceId: a.cut, quantity: 1, performedBy: b.meena }]), (e) => e.code === 'PERFORMER_UNAVAILABLE');
  await assert.rejects(commissions.putRule(a.parlourId, { performerId: b.meena, kind: 'percent', value: 10 }), (e) => e.status === 404);
  await assert.rejects(commissions.putRule(a.parlourId, { serviceId: b.cut, kind: 'percent', value: 10 }), (e) => e.status === 404);
  await assert.rejects(commissions.pay(a.auth, { performerId: b.meena, from: '2000-01-01', to: '2099-12-31', expectedAmount: 1 }), (e) => e.status === 404);
  await assert.rejects(commissions.lines(a.parlourId, b.meena, {}), (e) => e.status === 404);
  // B's rules, bills and people never show up in A's reports
  await commissions.putRule(b.parlourId, { performerId: b.meena, kind: 'percent', value: 10 });
  await bill(b, [{ serviceId: b.cut, quantity: 1, performedBy: b.meena }]);
  const report = await commissions.report(a.parlourId, {});
  assert.deepEqual(report.people.map((p) => p.id).sort(), [a.asha, a.meena].sort());
  assert.equal(report.totals.earned, 0);
  assert.deepEqual(await commissions.rules(a.parlourId), []);
  const summary = await reports.summary(a.parlourId, {}, { performers: true });
  assert.deepEqual(summary.byPerformer, { people: [], unassigned: 0 });
  // and a rule can only be removed by the parlour that owns it
  const rule = (await commissions.rules(b.parlourId))[0];
  await assert.rejects(commissions.removeRule(a.parlourId, rule.id), (e) => e.status === 404);
  assert.equal((await commissions.rules(b.parlourId)).length, 1);
}));

// ───────────── what each person has earned, and marking it as paid ─────────────

test('commissions report and "mark as paid": voided bills are left out, what was paid is not paid again, the amount must be what was seen, and a void after payment is shown', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  await commissions.putRule(w.parlourId, { performerId: w.meena, kind: 'percent', value: 10 });
  const meena = { performedBy: w.meena };
  const b1 = await bill(w, [{ serviceId: w.cut, quantity: 1, ...meena }]);                  // ₹20.00
  const b2 = await bill(w, [{ serviceId: w.massage, quantity: 1, ...meena }]);              // ₹100.00
  const b3 = await bill(w, [{ serviceId: w.cut, quantity: 2, ...meena }]);                  // ₹40.00, voided below
  await invoices.void(w.auth, b3.id, { reason: 'Entered twice' });
  await bill(w, [{ serviceId: w.cut, quantity: 1 }]);                                       // nobody named: not in anyone's commission

  const range = await around(c, w.parlourId);
  let r = await commissions.report(w.parlourId, range);
  const meenaRow = () => r.people.find((p) => p.id === w.meena);
  assert.deepEqual([meenaRow().lines, meenaRow().sales, meenaRow().earned, meenaRow().paid, meenaRow().due, meenaRow().voidedAfterPaid], [2, 1200, 120, 0, 120, 0], 'the voided bill is not counted');
  assert.deepEqual([r.totals.earned, r.totals.due], [120, 120]);
  assert.equal(r.people.find((p) => p.id === w.asha).earned, 0, 'a person with no work is still listed');

  // the lines behind the numbers, including the voided one, marked as void
  const detail = await commissions.lines(w.parlourId, w.meena, range);
  assert.deepEqual(detail.lines.map((l) => [l.number, l.status, l.commission, l.paid]).sort(), [[b1.number, 'paid', 20, false], [b2.number, 'paid', 100, false], [b3.number, 'void', 40, false]].sort());

  // the amount must be exactly what was on screen
  await assert.rejects(commissions.pay(w.auth, { performerId: w.meena, ...range, expectedAmount: 119.99 }), (e) => e.code === 'AMOUNT_CHANGED');
  assert.equal((await commissions.payouts(w.parlourId, { limit: 50 })).length, 0, 'a refused payout writes nothing');

  // a payout only covers the dates asked for
  await assert.rejects(commissions.pay(w.auth, { performerId: w.meena, from: '2000-01-01', to: '2000-12-31', expectedAmount: 120 }), (e) => e.code === 'NOTHING_TO_PAY');

  const paid = await commissions.pay(w.auth, { performerId: w.meena, ...range, expectedAmount: 120 });
  assert.deepEqual([paid.amount, paid.lines, paid.performerName], [120, 2, 'Meena']);
  const payouts = await commissions.payouts(w.parlourId, { limit: 50 });
  assert.deepEqual(payouts.map((p) => [p.performerName, p.amount, p.lines, p.from, p.to]), [['Meena', 120, 2, range.from, range.to]]);
  assert.equal(payouts[0].paidByName, 'Owner');

  r = await commissions.report(w.parlourId, range);
  assert.deepEqual([meenaRow().earned, meenaRow().paid, meenaRow().due], [120, 120, 0]);
  const rows = (await c.query(`SELECT commission_payout_id FROM invoice_items WHERE performed_by = $1 ORDER BY commission`, [w.meena])).rows;
  assert.deepEqual(rows.map((x) => x.commission_payout_id !== null), [true, false, true], 'lines of ₹20 and ₹100 stand and were paid; the voided ₹40 line was not');

  // pressing it again pays nothing
  await assert.rejects(commissions.pay(w.auth, { performerId: w.meena, ...range, expectedAmount: 120 }), (e) => e.code === 'NOTHING_TO_PAY');
  assert.equal((await commissions.payouts(w.parlourId, { limit: 50 })).length, 1);

  // a bill voided AFTER its commission was paid: nothing is changed for you, but it is shown
  await invoices.void(w.auth, b2.id, { reason: 'Customer returned' });
  r = await commissions.report(w.parlourId, range);
  assert.deepEqual([meenaRow().earned, meenaRow().paid, meenaRow().due, meenaRow().voidedAfterPaid], [20, 20, 0, 100]);
  assert.equal(r.totals.voidedAfterPaid, 100);
}));

test('the commission shown as due is exactly the commission paid, with many lines and awkward paise (no drift)', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  const odd = (await c.query(`INSERT INTO services (parlour_id, name, category, price, duration_min) VALUES ($1,'Odd','General',10.10,10) RETURNING id`, [w.parlourId])).rows[0].id;
  await commissions.putRule(w.parlourId, { performerId: w.asha, kind: 'percent', value: 12.5 });
  for (let i = 0; i < 12; i++) await bill(w, [{ serviceId: odd, quantity: 1 + (i % 3), performedBy: w.asha }], { discount: i % 2 ? 0.07 : 0 });
  const range = await around(c, w.parlourId);
  const due = (await commissions.report(w.parlourId, range)).people.find((p) => p.id === w.asha).due;
  const sum = (await c.query(`SELECT SUM(commission) AS s FROM invoice_items WHERE performed_by = $1`, [w.asha])).rows[0].s;
  assert.equal(rupees(due), rupees(Number(sum)));
  const paid = await commissions.pay(w.auth, { performerId: w.asha, ...range, expectedAmount: due });
  assert.equal(rupees(paid.amount), rupees(Number(sum)));
}));

test('dashboard: sales by performer plus what nobody was credited for adds up to the taxable value of every bill', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  // an old bill (no shares at all), a new bill nobody is named on, and a new bill with two people and a manual discount
  const { rows: [old] } = await c.query(`INSERT INTO invoices (parlour_id, number, subtotal, tax, total, payment_method) VALUES ($1, $2, 300, 15, 315, 'cash') RETURNING id`, [w.parlourId, `OLD-${stamp()}`]);
  await c.query(`INSERT INTO invoice_items (invoice_id, name, unit_price, quantity, line_total) VALUES ($1, 'Haircut', 300, 1, 300)`, [old.id]);
  await bill(w, [{ serviceId: w.cut, quantity: 1 }]);
  await bill(w, [{ serviceId: w.cut, quantity: 1, performedBy: w.meena }, { serviceId: w.massage, quantity: 1, performedBy: w.asha }], { discount: 33.33 });
  const voided = await bill(w, [{ serviceId: w.massage, quantity: 1, performedBy: w.asha }]);
  await invoices.void(w.auth, voided.id, { reason: 'Test' });

  const s = await reports.summary(w.parlourId, {}, { performers: true });
  const taxable = (await c.query(`SELECT SUM(total - tax) AS t FROM invoices WHERE parlour_id = $1 AND status = 'paid'`, [w.parlourId])).rows[0].t;
  const credited = s.byPerformer.people.reduce((sum, p) => sum + rupees(p.sales), 0);
  assert.equal(credited + rupees(s.byPerformer.unassigned), rupees(Number(taxable)), 'people + unassigned = taxable value of every bill that stands');
  assert.deepEqual(s.byPerformer.people.map((p) => p.name).sort(), ['Asha', 'Meena'], 'the voided bill is not counted');
  assert.equal(s.byPerformer.unassigned, 500, '₹300 old bill + ₹200 bill with nobody named');
  // switched off, it is not worked out at all
  assert.equal((await reports.summary(w.parlourId, {}, { performers: false })).byPerformer, null);
  assert.equal((await reports.summary(w.parlourId, {})).byPerformer, null);
}));

test('performers: a person who has been on a bill is deactivated, never deleted; one who has not can be deleted; staff only see active names', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  await bill(w, [{ serviceId: w.cut, quantity: 1, performedBy: w.meena }]);
  await assert.rejects(performers.remove(w.parlourId, w.meena), (e) => e.code === 'PERFORMER_IN_USE');
  await performers.remove(w.parlourId, w.asha);
  await performers.update(w.parlourId, w.meena, { isActive: false });
  await assert.rejects(bill(w, [{ serviceId: w.cut, quantity: 1, performedBy: w.meena }]), (e) => e.code === 'PERFORMER_UNAVAILABLE', 'a deactivated person cannot go on new bills');
  const asAdmin = await performers.list(w.auth, { includeInactive: 'true' });
  assert.deepEqual(asAdmin.map((p) => [p.name, p.isActive, p.lines, p.canDelete]), [['Meena', false, 1, false]]);
  assert.deepEqual(await performers.list({ ...w.auth, role: 'staff' }, { includeInactive: 'true' }), [], 'staff see active names only, and asking for more changes nothing');
  await assert.rejects(performers.create(w.parlourId, { name: 'meena' }), (e) => e.code === 'PERFORMER_EXISTS'); // last: a refused insert ends the transaction
}));

// ───────────── what referrers are owed ─────────────

test('referrals: owed counts bills that stand and are not yet paid; "mark as paid" pays exactly that; a void after payment is shown; nothing is paid twice', () => inRolledBackTransaction(async (c) => {
  const w = await makeParlour(c);
  const other = await makeParlour(c);
  const { rows: [r] } = await c.query(`INSERT INTO referrers (parlour_id, code, name, contact, percent) VALUES ($1,'REF-0001','Anita Rao','9841100001',10) RETURNING id`, [w.parlourId]);
  const b1 = await bill(w, [{ serviceId: w.massage, quantity: 1 }], { referrerId: r.id });   // 10% of ₹1,000 = ₹100
  const b2 = await bill(w, [{ serviceId: w.cut, quantity: 1 }], { referrerId: r.id });       // ₹20
  const b3 = await bill(w, [{ serviceId: w.cut, quantity: 2 }], { referrerId: r.id });       // ₹40, voided below
  await invoices.void(w.auth, b3.id, { reason: 'Entered twice' });

  let d = await referrers.get(w.parlourId, r.id);
  assert.deepEqual([d.owed, d.paidOut, d.voidedAfterPaid, d.totalDiscount], [120, 0, 0, 120]);
  assert.deepEqual(d.history.map((h) => [h.number, h.paid]).sort(), [[b1.number, false], [b2.number, false], [b3.number, false]].sort());
  assert.equal((await referrers.list(w.parlourId, { page: 1, limit: 20 })).items[0].owed, 120);

  await assert.rejects(referrers.pay(w.auth, r.id, { expectedAmount: 100 }), (e) => e.code === 'AMOUNT_CHANGED');
  await assert.rejects(referrers.pay(other.auth, r.id, { expectedAmount: 120 }), (e) => e.status === 404, 'another parlour cannot pay this referrer');
  const paid = await referrers.pay(w.auth, r.id, { expectedAmount: 120 });
  assert.deepEqual([paid.amount, paid.bills, paid.referrerName], [120, 2, 'Anita Rao']);

  d = await referrers.get(w.parlourId, r.id);
  assert.deepEqual([d.owed, d.paidOut], [0, 120]);
  assert.deepEqual(d.history.filter((h) => h.paid).map((h) => h.number).sort(), [b1.number, b2.number].sort(), 'the voided bill is not marked as paid');
  assert.deepEqual(d.payouts.map((p) => [p.amount, p.bills, p.paidByName]), [[120, 2, 'Owner']]);
  await assert.rejects(referrers.pay(w.auth, r.id, { expectedAmount: 120 }), (e) => e.code === 'NOTHING_TO_PAY');

  // a new bill is owed on its own; and a bill voided after it was paid is shown, not silently changed
  await bill(w, [{ serviceId: w.cut, quantity: 1 }], { referrerId: r.id });
  await invoices.void(w.auth, b1.id, { reason: 'Customer returned' });
  d = await referrers.get(w.parlourId, r.id);
  assert.deepEqual([d.owed, d.paidOut, d.voidedAfterPaid], [20, 20, 100]);
}));
