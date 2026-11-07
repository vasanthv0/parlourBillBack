// Checks the Phase 5 rules in PostgreSQL itself. Needs the database from your .env (run `npm run db:init` once);
// it does NOT need the API running.      npm run test:db
//
// Everything happens inside ONE transaction that is always rolled back (the "old database" scenario even builds its
// tables in a throw-away schema), so the database is left exactly as it was found.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pool } = require('../src/config/db');
const { normaliseMobile } = require('../src/utils/phone');

test.after(() => pool.end());

const SCHEMA = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
const PHASE5_MARKER = '-- ── Sign in with mobile or email (Phase 5)';
const SCHEMA_BEFORE_PHASE5 = SCHEMA.slice(0, SCHEMA.indexOf(PHASE5_MARKER));

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
async function refused(client, code, text, params = [], constraint = null) {
  await client.query('SAVEPOINT attempt');
  try {
    await client.query(text, params);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    assert.equal(err.code, code, `expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
    if (constraint) assert.equal(err.constraint, constraint);
    return err;
  }
  await client.query('ROLLBACK TO SAVEPOINT attempt');
  assert.fail(`the database accepted this: ${text.slice(0, 90)} ${JSON.stringify(params)}`);
}

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
// A 10-digit number starting with 6 that no seeded or test account uses.
const randomMobile = () => `6${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

async function makeParlour(client) {
  const { rows: [p] } = await client.query(`INSERT INTO parlours (name) VALUES ($1) RETURNING id`, [`Mobile Test ${stamp()}`]);
  return p.id;
}
const addUser = (client, parlourId, { email = null, mobile = null, role = 'staff', name = 'Test User' } = {}) =>
  client.query(`INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, $2, $3, $4, 'x', $5) RETURNING *`, [parlourId, name, email, mobile, role]);

test('the database works out the comparable number exactly as the application does', () => withRolledBackTransaction(async (c) => {
  const p = await makeParlour(c);
  const b = randomMobile();
  const typings = [
    b, `${b.slice(0, 5)} ${b.slice(5)}`, `+91 ${b.slice(0, 5)}-${b.slice(5)}`, `0${b}`, `(${b.slice(0, 5)}) ${b.slice(5)}`, ` ${b} `, `+91-${b}`,
    '1234567', '123456789', '-------', 'not a number', '', '98400 12345 ext 9',
  ];
  for (const typed of typings) {
    await c.query('SAVEPOINT one');
    const { rows: [u] } = await addUser(c, p, { email: `p5-${stamp()}@x.test`, mobile: typed });
    // The database rule is "at least 10 digits, then the last 10". The application adds a check on which characters
    // may be typed; for everything it accepts, the two must give the same answer.
    const digits = typed.replace(/\D/g, '');
    assert.equal(u.mobile_normalised, digits.length >= 10 ? digits.slice(-10) : null, `typed as ${JSON.stringify(typed)}`);
    if (/^[0-9+\-\s()]{7,20}$/.test(typed.trim())) assert.equal(u.mobile_normalised, normaliseMobile(typed), `application and database agree on ${JSON.stringify(typed)}`);
    assert.equal(u.mobile, typed, 'what was typed is stored untouched');
    await c.query('ROLLBACK TO SAVEPOINT one');
  }
  const { rows: [none] } = await addUser(c, p, { email: `p5-${stamp()}@x.test`, mobile: null });
  assert.equal(none.mobile_normalised, null);
}));

test('a team member can have a mobile number and no email, but only staff, and never nothing at all', () => withRolledBackTransaction(async (c) => {
  const p = await makeParlour(c);
  const m = randomMobile();

  const { rows: [staff] } = await addUser(c, p, { email: null, mobile: m, role: 'staff' });
  assert.equal(staff.email, null);
  assert.equal(staff.mobile_normalised, m);

  const noEmailAdmin = await refused(c, CHECK_VIOLATION, `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, 'A', NULL, $2, 'x', 'admin')`, [p, randomMobile()]);
  assert.equal(noEmailAdmin.constraint, 'users_email_role_check', 'a parlour admin keeps an email');
  await refused(c, CHECK_VIOLATION, `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, 'A', NULL, '1234567', 'x', 'staff')`, [p], 'users_identifier_check');
  await refused(c, CHECK_VIOLATION, `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, 'A', NULL, NULL, 'x', 'staff')`, [p], 'users_identifier_check');
  await refused(c, CHECK_VIOLATION, `UPDATE users SET mobile = NULL WHERE id = $1`, [staff.id], 'users_identifier_check'); // cannot be left with no way to sign in
  await refused(c, CHECK_VIOLATION, `UPDATE users SET role = 'admin' WHERE id = $1`, [staff.id], 'users_email_role_check');

  // The platform admin has no parlour and must keep an email.
  await refused(c, CHECK_VIOLATION, `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES (NULL, 'S', NULL, $1, 'x', 'super_admin')`, [randomMobile()], 'users_email_role_check');
}));

test('one account per mobile number across the whole platform, however the number was typed', () => withRolledBackTransaction(async (c) => {
  const [p1, p2] = [await makeParlour(c), await makeParlour(c)];
  const b = randomMobile();
  await addUser(c, p1, { email: `p5-${stamp()}@x.test`, mobile: b });

  const same = await refused(c, UNIQUE_VIOLATION, `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, 'B', $2, $3, 'x', 'staff')`, [p2, `p5-${stamp()}@x.test`, `+91 ${b.slice(0, 5)}-${b.slice(5)}`], 'users_mobile_key');
  assert.equal(same.constraint, 'users_mobile_key', 'a different parlour, a different way of typing it: still the same person');
  await refused(c, UNIQUE_VIOLATION, `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, 'B', NULL, $2, 'x', 'staff')`, [p1, `0${b}`], 'users_mobile_key');

  // Editing one account to another's number is refused too.
  const { rows: [other] } = await addUser(c, p2, { email: `p5-${stamp()}@x.test`, mobile: randomMobile() });
  await refused(c, UNIQUE_VIOLATION, `UPDATE users SET mobile = $2 WHERE id = $1`, [other.id, b], 'users_mobile_key');

  // Numbers with no comparable form (too short) and accounts with no number never collide.
  await addUser(c, p1, { email: `p5-${stamp()}@x.test`, mobile: '1234567' });
  await addUser(c, p2, { email: `p5-${stamp()}@x.test`, mobile: '1234567' });
  await addUser(c, p1, { email: `p5-${stamp()}@x.test`, mobile: null });
  await addUser(c, p2, { email: `p5-${stamp()}@x.test`, mobile: null });
}));

test('email stays unique without regard to capital letters, and many accounts may have no email', () => withRolledBackTransaction(async (c) => {
  const p = await makeParlour(c);
  const e = `p5-${stamp()}@x.test`;
  await addUser(c, p, { email: e, mobile: randomMobile() });
  await refused(c, UNIQUE_VIOLATION, `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, 'B', $2, $3, 'x', 'staff')`, [p, e.toUpperCase(), randomMobile()], 'users_email_key');
  await addUser(c, p, { email: null, mobile: randomMobile() });
  await addUser(c, p, { email: null, mobile: randomMobile() });
}));

// ───────────── an OLD database: the real worry ─────────────

test('an old database with shared and short numbers upgrades without a single user row changing, and says what is wrong', () => withRolledBackTransaction(async (c) => {
  // Build the tables as they were before Phase 5, in a throw-away schema that disappears with the rollback.
  await c.query('CREATE SCHEMA p5_old');
  await c.query('SET LOCAL search_path = p5_old, public');
  await c.query(SCHEMA_BEFORE_PHASE5);
  const before = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'p5_old' AND table_name = 'users'`);
  assert.ok(!before.rows.some((r) => r.column_name === 'mobile_normalised'), 'this really is the old shape');

  const { rows: [pa] } = await c.query(`INSERT INTO parlours (name) VALUES ('Parlour A') RETURNING id`);
  const { rows: [pb] } = await c.query(`INSERT INTO parlours (name) VALUES ('Parlour B') RETURNING id`);
  const legacy = [
    [pa.id, 'Asha', 'asha@a.test', '98400 12345', 'admin'],
    [pa.id, 'Bala', 'bala@a.test', '+91 98400-12345', 'staff'],      // the same number as Asha, typed differently
    [pb.id, 'Chitra', 'chitra@b.test', '9840012345', 'admin'],        // and in another parlour
    [pb.id, 'Devi', 'devi@b.test', '1234567', 'staff'],               // too short to sign in with
    [pb.id, 'Esha', 'esha@b.test', '1234567', 'staff'],               // short and shared: allowed, never compared
    [pb.id, 'Firoz', 'firoz@b.test', null, 'staff'],                  // no number
    [pb.id, 'Gita', 'gita@b.test', '99999 88888', 'staff'],           // an ordinary, unshared number
  ];
  for (const [parlour, name, email, mobile, role] of legacy) {
    await c.query(`INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1,$2,$3,$4,'hash-' || $2,$5)`, [parlour, name, email, mobile, role]);
  }
  const FINGERPRINT = `SELECT count(*)::int AS n, md5(string_agg(concat_ws('|', id, parlour_id, name, email, mobile, password_hash, role, is_active, failed_login_count, locked_until, last_login_at, created_at), E'\\n' ORDER BY id)) AS fp FROM users`;
  const { rows: [then] } = await c.query(FINGERPRINT);

  // Upgrade it, twice (the schema must be safe to re-run).
  await c.query(SCHEMA);
  await c.query(SCHEMA);
  const { rows: [now] } = await c.query(FINGERPRINT);
  assert.deepEqual(now, then, 'every existing user row is exactly as it was: nothing edited, merged or deleted');

  const index = await c.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'p5_old' AND indexname = 'users_mobile_key'`);
  assert.equal(index.rowCount, 0, 'the unique rule is NOT forced on data that already breaks it');

  // The new column is filled in for the existing rows, and the shared number can be found.
  const { rows: shared } = await c.query(`SELECT name FROM users WHERE mobile_normalised = '9840012345' ORDER BY name`);
  assert.deepEqual(shared.map((r) => r.name), ['Asha', 'Bala', 'Chitra']);
  const { rows: short } = await c.query(`SELECT name FROM users WHERE mobile = '1234567' AND mobile_normalised IS NULL ORDER BY name`);
  assert.deepEqual(short.map((r) => r.name), ['Devi', 'Esha']);

  // The report sees the old shape too: it never needs the new column.
  const { SQL, TOTALS_SQL, buildReport } = require('../db/report-user-mobile-collisions');
  const { rows } = await c.query(SQL);
  const { rows: [totals] } = await c.query(TOTALS_SQL);
  const report = buildReport(rows, { totals });
  assert.equal(report.totals.collisionGroups, 1);
  assert.deepEqual(report.groups[0].accounts.map((a) => a.name).sort(), ['Asha', 'Bala', 'Chitra']);
  assert.equal(report.groups[0].acrossParlours, true);
  assert.equal(report.short.length, 2);

  // Once the owner has decided and fixed the data by hand, the next run creates the rule.
  await c.query(`UPDATE users SET mobile = '98400 55555' WHERE name = 'Chitra'`);
  await c.query(`UPDATE users SET mobile = '98400 66666' WHERE name = 'Bala'`);
  await c.query(SCHEMA);
  const created = await c.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'p5_old' AND indexname = 'users_mobile_key'`);
  assert.equal(created.rowCount, 1, 'created as soon as no number is shared');
  await refused(c, UNIQUE_VIOLATION, `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, 'Late', 'late@a.test', '098400 12345', 'x', 'staff')`, [pa.id], 'users_mobile_key');
}));
