// Checks the payments tables, columns and report query in PostgreSQL itself. Needs the database from your .env
// (run `npm run db:init` once); it does NOT need the API running.      npm run test:db
//
// Everything happens inside ONE transaction that is always rolled back, so the database is left exactly as it was found.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pool } = require('../src/config/db');
const reports = require('../src/modules/reports/reports.service');

test.after(() => pool.end());

async function withRolledBackTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
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
const NOT_NULL_VIOLATION = '23502';
const FOREIGN_KEY_VIOLATION = '23503';

async function makeParlour(client) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const { rows: [p] } = await client.query(`INSERT INTO parlours (name) VALUES ($1) RETURNING id`, [`Payments Test ${stamp}`]);
  return p.id;
}

let counter = 0;
const addInvoice = async (client, parlourId, cols = {}) => {
  const row = { number: `P-${Date.now()}-${++counter}`, subtotal: '100.00', tax: '0.00', total: '100.00', payment_method: 'cash', ...cols };
  const keys = ['parlour_id', ...Object.keys(row)];
  const { rows: [inv] } = await client.query(
    `INSERT INTO invoices (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    [parlourId, ...Object.values(row)]
  );
  return inv;
};
const addPayment = (client, invoiceId, method, amount) =>
  client.query(`INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1, $2, $3) RETURNING *`, [invoiceId, method, amount]);

test('a bill\'s method is cash, upi, card, or split; nothing else', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  for (const method of ['cash', 'upi', 'card', 'split']) assert.equal((await addInvoice(c, parlourId, { payment_method: method })).payment_method, method);
  for (const [i, bad] of ['cheque', 'SPLIT', 'wallet', ''].entries()) {
    await refused(c, CHECK_VIOLATION, `INSERT INTO invoices (parlour_id, number, subtotal, total, payment_method) VALUES ($1, $2, 1, 1, $3)`, [parlourId, `BAD-M-${i}-${Date.now()}`, bad]);
  }
}));

test('a payment row: a known method, an amount of 0 or more, one row per method per bill, and a real bill', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  const inv = await addInvoice(c, parlourId, { payment_method: 'split', total: '500.00' });

  assert.deepEqual((await addPayment(c, inv.id, 'cash', '200.00')).rows.map((r) => [r.method, r.amount]), [['cash', '200.00']]);
  assert.deepEqual((await addPayment(c, inv.id, 'upi', '300.00')).rows.map((r) => [r.method, r.amount]), [['upi', '300.00']]);

  await refused(c, UNIQUE_VIOLATION, `INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1, 'cash', 1)`, [inv.id]);  // a method once per bill
  await refused(c, CHECK_VIOLATION, `INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1, 'cheque', 1)`, [inv.id]);  // unknown method
  await refused(c, CHECK_VIOLATION, `INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1, 'card', -0.01)`, [inv.id]); // negative
  await refused(c, NOT_NULL_VIOLATION, `INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1, 'card', NULL)`, [inv.id]);
  await refused(c, NOT_NULL_VIOLATION, `INSERT INTO invoice_payments (invoice_id, method, amount) VALUES ($1, NULL, 1)`, [inv.id]);
  await refused(c, FOREIGN_KEY_VIOLATION, `INSERT INTO invoice_payments (invoice_id, method, amount) VALUES (gen_random_uuid(), 'cash', 1)`);

  // 0 is allowed: a bill whose total is 0 is paid by one method at 0.
  const free = await addInvoice(c, parlourId, { payment_method: 'cash', subtotal: '100.00', total: '0.00' });
  assert.equal((await addPayment(c, free.id, 'cash', '0.00')).rows[0].amount, '0.00');
}));

test('a tip is 0 unless given, has two decimals, and is never negative; an old-style insert gets 0', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  assert.equal((await addInvoice(c, parlourId)).tip, '0.00', 'a bill made without saying anything about a tip');
  assert.equal((await addInvoice(c, parlourId, { tip: '50.25' })).tip, '50.25');
  await refused(c, CHECK_VIOLATION, `INSERT INTO invoices (parlour_id, number, subtotal, total, payment_method, tip) VALUES ($1, $2, 1, 1, 'cash', -1)`, [parlourId, `BAD-TIP-${Date.now()}`]);
  await refused(c, NOT_NULL_VIOLATION, `INSERT INTO invoices (parlour_id, number, subtotal, total, payment_method, tip) VALUES ($1, $2, 1, 1, 'cash', NULL)`, [parlourId, `BAD-TIP2-${Date.now()}`]);
}));

test('deleting a bill deletes its payment rows, and so does deleting its parlour', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  const a = await addInvoice(c, parlourId, { payment_method: 'split' });
  const b = await addInvoice(c, parlourId, { payment_method: 'card' });
  await addPayment(c, a.id, 'cash', '40.00');
  await addPayment(c, a.id, 'upi', '60.00');
  await addPayment(c, b.id, 'card', '100.00');
  const count = async () => Number((await c.query(`SELECT COUNT(*) FROM invoice_payments WHERE invoice_id IN ($1, $2)`, [a.id, b.id])).rows[0].count);

  assert.equal(await count(), 3);
  await c.query(`DELETE FROM invoices WHERE id = $1`, [a.id]);
  assert.equal(await count(), 1, 'only the deleted bill\'s rows went');
  await c.query(`DELETE FROM parlours WHERE id = $1`, [parlourId]);
  assert.equal(await count(), 0);
}));

test('running db:init again changes nothing: old bills, split bills, their payments and tips survive exactly', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  const old = await addInvoice(c, parlourId, { number: 'OLD-1', payment_method: 'upi', total: '945.00', subtotal: '945.00' });
  const split = await addInvoice(c, parlourId, { number: 'NEW-1', payment_method: 'split', total: '500.00', subtotal: '500.00', tip: '25.00' });
  await addPayment(c, split.id, 'cash', '200.00');
  await addPayment(c, split.id, 'upi', '300.00');

  const snapshot = async () => ({
    invoices: (await c.query(`SELECT * FROM invoices WHERE parlour_id = $1 ORDER BY number`, [parlourId])).rows,
    payments: (await c.query(`SELECT invoice_id, method, amount FROM invoice_payments WHERE invoice_id IN ($1, $2) ORDER BY invoice_id, method`, [old.id, split.id])).rows,
  });
  const before = await snapshot();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await c.query(sql);
  await c.query(sql);
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.payments.filter((p) => p.invoice_id === old.id).length, 0, 'an old bill is not given payment rows by db:init');
  assert.deepEqual(before.payments.map((p) => [p.method, p.amount]), [['cash', '200.00'], ['upi', '300.00']]);
}));

// ───────────── the report: takings by payment method ─────────────

test('byPayment: new bills count by their payment rows, old bills by their one method, void bills and other parlours not at all, and the methods add up to the revenue', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  const otherId = await makeParlour(c);

  // Parlour A
  await addInvoice(c, parlourId, { payment_method: 'cash', subtotal: '100.00', total: '100.00' });                       // old bill, no rows
  await addInvoice(c, parlourId, { payment_method: 'upi', subtotal: '250.00', total: '250.00' });                        // old bill, no rows
  const card = await addInvoice(c, parlourId, { payment_method: 'card', subtotal: '300.00', total: '300.00' });          // new, one method
  await addPayment(c, card.id, 'card', '300.00');
  const split = await addInvoice(c, parlourId, { payment_method: 'split', subtotal: '500.00', total: '500.00', tip: '40.00' }); // new, split, with a tip
  await addPayment(c, split.id, 'cash', '200.00');
  await addPayment(c, split.id, 'upi', '300.00');
  const voided = await addInvoice(c, parlourId, { payment_method: 'split', subtotal: '999.00', total: '999.00', status: 'void' });
  await addPayment(c, voided.id, 'cash', '999.00');
  // Parlour B: must never show up in A's numbers
  await addInvoice(c, otherId, { payment_method: 'cash', subtotal: '777.00', total: '777.00' });
  const otherSplit = await addInvoice(c, otherId, { payment_method: 'split', subtotal: '888.00', total: '888.00', tip: '99.00' });
  await addPayment(c, otherSplit.id, 'cash', '400.00');
  await addPayment(c, otherSplit.id, 'card', '488.00');

  const { rows: [{ today }] } = await c.query(`SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today FROM parlours WHERE id = $1`, [parlourId]);
  const args = [parlourId, today, today];

  const { rows } = await c.query(reports.byPaymentSql(reports.BASE), args);
  const got = rows.map((r) => [r.method, r.invoices, r.revenue]);
  // upi: ₹250 (old) + ₹300 (split part) · card: ₹300 · cash: ₹100 (old) + ₹200 (split part). Ties on revenue are ordered by method.
  assert.deepEqual(got, [['upi', 2, '550.00'], ['card', 1, '300.00'], ['cash', 2, '300.00']]);

  const { rows: [t] } = await c.query(`SELECT COUNT(*)::int AS invoices, SUM(i.total) AS revenue, SUM(i.tip) AS tips ${reports.BASE}`, args);
  assert.deepEqual([t.invoices, t.revenue, t.tips], [4, '1150.00', '40.00']);
  const methodsTotal = rows.reduce((s, r) => s + Math.round(Number(r.revenue) * 100), 0);
  assert.equal(methodsTotal, Math.round(Number(t.revenue) * 100), 'the methods add up to the revenue, so nothing is counted twice or missed');

  // The other parlour sees only its own.
  const { rows: theirs } = await c.query(reports.byPaymentSql(reports.BASE), [otherId, today, today]);
  assert.deepEqual(theirs.map((r) => [r.method, r.invoices, r.revenue]).sort(), [['card', 1, '488.00'], ['cash', 2, '1177.00']].sort());
}));
