// No database and no running API: node --test tests/mobile-login.unit.test.js   (or: npm run test:unit)
const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseMobile, MOBILE_FORMAT } = require('../src/utils/phone');
const authSchemas = require('../src/modules/auth/auth.schemas');
const staffSchemas = require('../src/modules/staff/staff.schemas');
const { buildReport, formatReport } = require('../db/report-user-mobile-collisions');

const parseLogin = (body) => authSchemas.login.body.safeParse(body);
const problems = (result) => Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));

// ───────────── the comparable form of a mobile number ─────────────

test('normaliseMobile: however a number is typed, its last 10 digits are the same', () => {
  for (const typed of ['9840012345', '98400 12345', '+91 98400-12345', '091 98400 12345', '098400-12345', '(98400) 12345', ' 9840012345 ']) {
    assert.equal(normaliseMobile(typed), '9840012345', `typed as ${JSON.stringify(typed)}`);
  }
});

test('normaliseMobile: fewer than 10 digits, wrong characters, or nothing at all is not a usable number', () => {
  for (const bad of ['1234567', '123456789', '-------', 'abcdefghij', '98400 12345 ext 9', '', '   ', null, undefined]) {
    assert.equal(normaliseMobile(bad), null, `${JSON.stringify(bad)}`);
  }
  assert.ok(MOBILE_FORMAT.test('+91 98400-12345'));
});

// ───────────── what someone may type to sign in ─────────────

test('login identifier: an email is lower-cased, a mobile number is reduced to its last 10 digits', () => {
  assert.deepEqual(authSchemas.parseLoginIdentifier('  Admin@Demo.Parlour '), { kind: 'email', value: 'admin@demo.parlour' });
  assert.deepEqual(authSchemas.parseLoginIdentifier('+91 98400-12345'), { kind: 'mobile', value: '9840012345' });
  assert.deepEqual(authSchemas.parseLoginIdentifier('098400 12345'), { kind: 'mobile', value: '9840012345' });
});

test('login identifier: anything with an @ must be a valid email; anything else must be a usable mobile number', () => {
  for (const bad of ['', '   ', 'nope', 'a@b', '@x.co', 'a@b@c.co', '12345', '98400 1234', 'abcdefghij', "x'; DROP TABLE users;--", 'a'.repeat(30) + '@']) {
    assert.equal(authSchemas.parseLoginIdentifier(bad), null, `${JSON.stringify(bad)}`);
  }
  // An email never passes as a mobile number, so the two can never be confused.
  assert.equal(authSchemas.parseLoginIdentifier('9840012345@x.co').kind, 'email');
});

// ───────────── the login request ─────────────

test('login request: the new "identifier" field works for an email and for a mobile number', () => {
  const byEmail = parseLogin({ identifier: 'Admin@Demo.Parlour', password: 'x' });
  assert.deepEqual(byEmail.data, { identifier: { kind: 'email', value: 'admin@demo.parlour' }, password: 'x' });
  const byMobile = parseLogin({ identifier: '98400 12345', password: 'x' });
  assert.deepEqual(byMobile.data, { identifier: { kind: 'mobile', value: '9840012345' }, password: 'x' });
});

test('login request: the old "email" field still works, so a web app that is not updated yet keeps signing in', () => {
  const old = parseLogin({ email: 'Admin@Demo.Parlour', password: 'x' });
  assert.deepEqual(old.data, { identifier: { kind: 'email', value: 'admin@demo.parlour' }, password: 'x' });
});

test('login request: if both fields are sent, "identifier" wins', () => {
  const both = parseLogin({ identifier: '9840012345', email: 'someone@x.co', password: 'x' });
  assert.deepEqual(both.data.identifier, { kind: 'mobile', value: '9840012345' });
});

test('login request: a problem is reported on the field the caller used, so existing clients still find it', () => {
  assert.deepEqual(problems(parseLogin({ email: 'nope', password: '' })), { password: 'Enter your password', email: 'Enter a valid email address or mobile number' });
  assert.deepEqual(problems(parseLogin({ identifier: '12345', password: 'x' })), { identifier: 'Enter a valid email address or mobile number' });
  assert.deepEqual(problems(parseLogin({ password: 'x' })), { identifier: 'Enter your email or mobile number' });
  assert.deepEqual(problems(parseLogin({ identifier: '', password: 'x' })), { identifier: 'Enter your email or mobile number' });
  assert.deepEqual(problems(parseLogin({ identifier: 'a@b.co' })), { password: 'Enter your password' });
});

test('login request: the password limit of 72 characters (bcrypt reads no more) is kept', () => {
  assert.equal(parseLogin({ identifier: 'a@b.co', password: 'p'.repeat(72) }).success, true);
  assert.equal(parseLogin({ identifier: 'a@b.co', password: 'p'.repeat(73) }).success, false);
});

test('login request: values that are not text are refused, not coerced', () => {
  for (const identifier of [12345678901, { $ne: null }, ['a@b.co'], true]) {
    assert.equal(parseLogin({ identifier, password: 'x' }).success, false, JSON.stringify(identifier));
  }
});

// ───────────── adding a team member ─────────────

const base = { name: 'Priya', password: 'Secret123' };
const create = (extra) => staffSchemas.create.body.safeParse({ ...base, ...extra });

test('team member: staff can be made with a mobile number and no email (blank or missing)', () => {
  assert.deepEqual(create({ mobile: '9840012345' }).data, { name: 'Priya', email: null, mobile: '9840012345', password: 'Secret123', role: 'staff' });
  assert.equal(create({ mobile: '9840012345', email: '' }).data.email, null);
  assert.equal(create({ mobile: '9840012345', email: '   ' }).data.email, null);
  assert.equal(create({ mobile: '9840012345', email: null }).data.email, null);
});

test('team member: an email, when given, is still checked and lower-cased', () => {
  assert.equal(create({ mobile: '9840012345', email: ' Priya@X.Test ' }).data.email, 'priya@x.test');
  assert.deepEqual(problems(create({ mobile: '9840012345', email: 'nope' })), { email: 'Enter a valid email address' });
});

test('team member: an admin must have an email; only staff may sign in with a mobile number alone', () => {
  assert.deepEqual(problems(create({ mobile: '9840012345', role: 'admin' })), { email: 'Enter an email address for an admin' });
  assert.equal(create({ mobile: '9840012345', role: 'admin', email: 'boss@x.test' }).success, true);
});

test('team member: a mobile number is always required, and a new one needs at least 10 digits', () => {
  assert.deepEqual(problems(create({})), { mobile: 'Required' });
  assert.deepEqual(problems(create({ mobile: 'abc' })), { mobile: 'Enter a valid mobile number' });
  assert.deepEqual(problems(create({ mobile: '12345' })), { mobile: 'Enter a valid mobile number' });
  assert.deepEqual(problems(create({ mobile: '1234567' })), { mobile: 'Enter a mobile number with at least 10 digits' });
  assert.deepEqual(problems(create({ mobile: '123-456-789' })), { mobile: 'Enter a mobile number with at least 10 digits' });
  assert.equal(create({ mobile: ' +91 98400-12345 ' }).data.mobile, '+91 98400-12345', 'kept as typed, minus stray spaces');
});

test('team member: editing keeps the loose format, so an older short number can be sent back unchanged', () => {
  const update = (body) => staffSchemas.update.body.safeParse(body);
  assert.equal(update({ mobile: '1234567' }).success, true, 'the service decides: it only enforces 10 digits when the number changes');
  assert.equal(update({ mobile: 'nope' }).success, false);
  assert.equal(update({}).success, false);
});

// ───────────── the report of numbers that block the unique rule ─────────────

const row = (id, parlour, mobile, over = {}) => ({
  id, name: `User ${id}`, email: `${id}@x.test`, mobile, role: 'staff', is_active: true, created_at: `2026-10-0${id.length}T00:00:00Z`, last_login_at: null,
  parlour_id: parlour, parlour_name: `Parlour ${parlour}`, digits: String(mobile).replace(/\D/g, ''), ...over,
});

test('report: groups accounts that share a number however it was typed, across parlours or inside one', () => {
  const rows = [
    row('a', 'p1', '98400 12345'), row('bb', 'p2', '+91 98400-12345'), row('ccc', 'p2', '9840099999'), row('dddd', 'p2', '098400 99999'),
    row('e', 'p3', '9810000001'),
  ];
  const r = buildReport(rows, { totals: { users: 9, with_mobile: 5 } });
  assert.equal(r.totals.collisionGroups, 2);
  assert.equal(r.totals.accountsInCollisions, 4);
  assert.equal(r.totals.accounts, 9);
  const [g1, g2] = r.groups;
  assert.equal(g1.mobile10, '9840012345');
  assert.equal(g1.acrossParlours, true);
  assert.equal(g2.mobile10, '9840099999');
  assert.equal(g2.acrossParlours, false, 'both in parlour p2');
  assert.equal(r.groups.flatMap((g) => g.accounts).some((a) => a.id === 'e'), false, 'a number held once is not a collision');
});

test('report: short numbers and numbers with no digits are listed but are never collisions', () => {
  const rows = [row('a', 'p1', '1234567'), row('bb', 'p2', '1234567'), row('ccc', 'p1', '-------'), row('dddd', 'p1', '------ -')];
  const r = buildReport(rows);
  assert.equal(r.totals.collisionGroups, 0);
  assert.equal(r.short.length, 2);
  assert.equal(r.noDigits.length, 2);
});

test('report: a different country code is flagged as possibly a different person, a +91 or 0 prefix is not', () => {
  const same = buildReport([row('a', 'p1', '9840012345'), row('bb', 'p2', '+91 9840012345')]);
  assert.equal(same.groups[0].mixedPrefixes, false);
  const mixed = buildReport([row('a', 'p1', '+44 9840012345'), row('bb', 'p2', '+91 9840012345')]);
  assert.equal(mixed.groups[0].mixedPrefixes, true);
});

test('report: masking hides digits, surnames and email names but keeps ids; the text says nothing was changed', () => {
  const rows = [row('a', 'p1', '9840012345', { name: 'Priya Raman', email: 'priya.raman@x.test' }), row('bb', 'p2', '9840012345')];
  const masked = buildReport(rows, { mask: true });
  const text = formatReport(masked, { masked: true, database: 'db' });
  assert.ok(!text.includes('9840012345') && !text.includes('Raman') && !text.includes('priya.raman'), text);
  assert.ok(text.includes('id a'));
  assert.match(text, /Nothing was merged, edited or deleted/);
  assert.match(text, /Read-only: nothing was changed/);
  const clean = formatReport(buildReport([row('a', 'p1', '9840012345')]), { database: 'db' });
  assert.match(clean, /SHARED NUMBERS: none/);
});
