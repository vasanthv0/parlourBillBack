// Checks the GST columns and rules in PostgreSQL itself. Needs the database from your .env (run `npm run db:init` once);
// it does NOT need the API running.      npm run test:db
//
// Everything happens inside ONE transaction that is always rolled back, so the database is left exactly as it was found.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pool } = require('../src/config/db');

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

async function makeParlour(client) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const { rows: [p] } = await client.query(`INSERT INTO parlours (name) VALUES ($1) RETURNING id`, [`GST Test ${stamp}`]);
  return p.id;
}

let counter = 0;
const addInvoice = (client, parlourId, cols = {}) => {
  const row = { number: `T-${Date.now()}-${++counter}`, subtotal: '100.00', tax: '0.00', total: '100.00', payment_method: 'cash', ...cols };
  const keys = ['parlour_id', ...Object.keys(row)];
  return client.query(
    `INSERT INTO invoices (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    [parlourId, ...Object.values(row)]
  );
};

test('a parlour starts with GST added on top; the setting only accepts the two known values', () => withRolledBackTransaction(async (c) => {
  const id = await makeParlour(c);
  assert.equal((await c.query(`SELECT gst_price_mode FROM parlours WHERE id = $1`, [id])).rows[0].gst_price_mode, 'exclusive');
  await c.query(`UPDATE parlours SET gst_price_mode = 'inclusive' WHERE id = $1`, [id]);
  await refused(c, CHECK_VIOLATION, `UPDATE parlours SET gst_price_mode = 'both' WHERE id = $1`, [id]);
  await refused(c, '23502', `UPDATE parlours SET gst_price_mode = NULL WHERE id = $1`, [id]); // not-null violation
}));

test('a SAC is 6 digits or nothing', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  const add = (name, sac) => c.query(`INSERT INTO services (parlour_id, name, price, sac_code) VALUES ($1, $2, 100, $3) RETURNING sac_code`, [parlourId, name, sac]);
  assert.equal((await add('with sac', '999721')).rows[0].sac_code, '999721');
  assert.equal((await add('without', null)).rows[0].sac_code, null);
  for (const [i, bad] of ['99972', '9997211', 'abc123', '99 721', '999721\n', ''].entries()) {
    await refused(c, CHECK_VIOLATION, `INSERT INTO services (parlour_id, name, price, sac_code) VALUES ($1, $2, 100, $3)`, [parlourId, `bad ${i}`, bad]);
  }
}));

test('a bill made the old way (no split) is accepted as it is, and reads as an exclusive, split-less bill', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  const { rows: [inv] } = await addInvoice(c, parlourId, { tax_percent: '5.00', tax: '45.00', subtotal: '900.00', total: '945.00' });
  assert.deepEqual([inv.price_mode, inv.cgst, inv.sgst, inv.gstin], ['exclusive', null, null, null]);
}));

test('the split must add up to the tax, with the odd paisa on CGST and nothing else', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  const split = (tax, cgst, sgst) => addInvoice(c, parlourId, { tax, cgst, sgst, total: '100.00', price_mode: 'exclusive' });

  // accepted: even tax, odd tax with the extra paisa on CGST, and no tax at all
  assert.deepEqual((await split('0.50', '0.25', '0.25')).rows.map((r) => [r.cgst, r.sgst]), [['0.25', '0.25']]);
  assert.deepEqual((await split('0.25', '0.13', '0.12')).rows.map((r) => [r.cgst, r.sgst]), [['0.13', '0.12']]);
  assert.deepEqual((await split('0.01', '0.01', '0.00')).rows.map((r) => [r.cgst, r.sgst]), [['0.01', '0.00']]);
  assert.deepEqual((await split('0.00', '0.00', '0.00')).rows.map((r) => [r.cgst, r.sgst]), [['0.00', '0.00']]);

  // refused
  const insert = `INSERT INTO invoices (parlour_id, number, subtotal, tax, total, payment_method, cgst, sgst) VALUES ($1, $2, 100, $3, 100, 'cash', $4, $5)`;
  const bad = (n, tax, cgst, sgst) => refused(c, CHECK_VIOLATION, insert, [parlourId, `BAD-${n}-${Date.now()}`, tax, cgst, sgst]);
  await bad(1, '0.25', '0.12', '0.13');  // the odd paisa on SGST instead of CGST
  await bad(2, '0.25', '0.12', '0.12');  // does not add up to the tax
  await bad(3, '0.50', '0.26', '0.24');  // two paise apart
  await bad(4, '0.50', '0.50', '0.00');  // all on one side
  await bad(5, '0.50', '0.25', null);    // half a split
  await bad(6, '0.50', null, '0.25');    // half a split
  await bad(7, '0.00', '-0.01', '0.01'); // negative
}));

test('a bill\'s price mode is one of the two known values, and its lines can carry a SAC', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  const { rows: [inv] } = await addInvoice(c, parlourId, { price_mode: 'inclusive', tax: '4.76', cgst: '2.38', sgst: '2.38', gstin: '33ABCDE1234F1Z5' });
  assert.deepEqual([inv.price_mode, inv.gstin], ['inclusive', '33ABCDE1234F1Z5']);
  await refused(c, CHECK_VIOLATION, `INSERT INTO invoices (parlour_id, number, subtotal, total, payment_method, price_mode) VALUES ($1, $2, 1, 1, 'cash', 'both')`, [parlourId, `BAD-MODE-${Date.now()}`]);
  const { rows: [line] } = await c.query(
    `INSERT INTO invoice_items (invoice_id, name, unit_price, quantity, line_total, sac_code) VALUES ($1, 'Haircut', 100, 1, 100, '999721') RETURNING sac_code`, [inv.id]);
  assert.equal(line.sac_code, '999721');
}));

test('running db:init again changes nothing: existing bills, services and settings survive exactly', () => withRolledBackTransaction(async (c) => {
  const parlourId = await makeParlour(c);
  await c.query(`UPDATE parlours SET gst_price_mode = 'inclusive', tax_percent = 18, gst_number = '33ABCDE1234F1Z5' WHERE id = $1`, [parlourId]);
  await c.query(`INSERT INTO services (parlour_id, name, price, sac_code) VALUES ($1, 'Cut', 200, '999721')`, [parlourId]);
  const old = (await addInvoice(c, parlourId, { number: 'OLD-1', tax_percent: '5.00', tax: '45.00', subtotal: '900.00', total: '945.00' })).rows[0];
  const split = (await addInvoice(c, parlourId, { number: 'NEW-1', tax: '0.25', cgst: '0.13', sgst: '0.12', gstin: '33ABCDE1234F1Z5', price_mode: 'inclusive' })).rows[0];

  const snapshot = async () => ({
    parlour: (await c.query(`SELECT gst_price_mode, tax_percent, gst_number FROM parlours WHERE id = $1`, [parlourId])).rows,
    services: (await c.query(`SELECT name, price, sac_code FROM services WHERE parlour_id = $1`, [parlourId])).rows,
    invoices: (await c.query(`SELECT * FROM invoices WHERE parlour_id = $1 ORDER BY number`, [parlourId])).rows,
  });
  const before = await snapshot();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await c.query(sql);
  await c.query(sql);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual([before.invoices.find((r) => r.id === old.id).cgst, before.invoices.find((r) => r.id === split.id).cgst], [null, '0.13']);
}));
