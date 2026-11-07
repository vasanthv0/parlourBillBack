// The sign-in rules, checked against the real login service with a fake database (no PostgreSQL, no API, no network).
//   node --test tests/mobile-login.service.test.js      (or: npm run test:unit)
//
// What must hold now that someone can sign in with an email OR a mobile number:
//   - an email and a mobile number each do ONE lookup, and the same password check (a real hash, or the dummy one)
//   - every way of failing gives the identical answer: wrong password, unknown email, unknown number, shared number
//   - lockout counts failures on the account whichever way it was reached, and a locked account says so the same way
//   - a number that two accounts hold (old data) names nobody: it is refused, never guessed
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const AppError = require('../src/utils/AppError');

const state = { log: [], rows: [] };
const reset = (rows) => { state.log = []; state.rows = rows; };

const fakeDb = {
  query: async (text, params) => {
    state.log.push({ text, params });
    if (/^\s*SELECT u\.\*/.test(text)) {
      if (/lower\(u\.email\) = \$1/.test(text)) return { rows: state.rows.filter((u) => u.email && u.email.toLowerCase() === params[0]) };
      if (/u\.mobile_normalised = \$1 LIMIT 2/.test(text)) return { rows: state.rows.filter((u) => u.mobile_normalised === params[0]).slice(0, 2) };
      throw new Error(`Fake database got a lookup it does not know: ${text}`);
    }
    if (/^\s*UPDATE users/.test(text)) return { rows: [], rowCount: 1 };
    throw new Error(`Fake database got SQL it does not know: ${text}`);
  },
  withTransaction: async () => { throw new Error('a failed sign-in must never start a session'); },
};
const file = require.resolve('../src/config/db');
require.cache[file] = { id: file, filename: file, loaded: true, exports: fakeDb };

// Count every password comparison, so "the same check every time" is measured and not assumed.
const realCompare = bcrypt.compare;
let compares = [];
bcrypt.compare = (plain, hash) => { compares.push(hash); return realCompare(plain, hash); };

const logger = require('../src/utils/logger');
const warnings = [];
logger.warn = (msg) => warnings.push(msg);

const service = require('../src/modules/auth/auth.service');

const HASH = bcrypt.hashSync('Secret123', 4);
const user = (over = {}) => ({
  id: 'u1', parlour_id: 'p1', name: 'Priya', email: 'priya@x.test', mobile: '98400 12345', mobile_normalised: '9840012345', password_hash: HASH,
  role: 'staff', is_active: true, failed_login_count: 0, locked_until: null, parlour_name: 'Demo', parlour_status: 'active', parlour_features: {}, ...over,
});
const email = (value) => ({ kind: 'email', value });
const mobile = (value) => ({ kind: 'mobile', value });
const meta = { ip: '127.0.0.1', userAgent: 'test' };

const outcome = async (identifier, password = 'Wrong-password-1') => {
  compares = [];
  try { await service.login({ identifier, password }, meta); } catch (e) { assert.ok(e instanceof AppError, `expected AppError, got ${e}`); return { status: e.status, code: e.code, message: e.message, compares: compares.length, dummy: compares.length === 1 && compares[0] !== HASH }; }
  assert.fail('the sign-in should have been refused');
};
const failureCounts = () => state.log.filter((l) => /SET failed_login_count = failed_login_count \+ 1/.test(l.text));

test('an email is looked up by its lower-cased value, a mobile number by its last 10 digits, each with one query', async () => {
  reset([user()]);
  await outcome(email('priya@x.test'));
  assert.equal(state.log[0].params[0], 'priya@x.test');
  assert.match(state.log[0].text, /lower\(u\.email\) = \$1/);

  reset([user()]);
  await outcome(mobile('9840012345'));
  assert.equal(state.log[0].params[0], '9840012345');
  assert.match(state.log[0].text, /u\.mobile_normalised = \$1 LIMIT 2/);
  assert.equal(state.log.filter((l) => /^\s*SELECT/.test(l.text)).length, 1, 'one lookup, nothing else that would show which kind it was');
});

test('every way of failing gives the identical answer and the same single password check', async () => {
  reset([user(), user({ id: 'u2', email: 'x@x.test', mobile: '98100 00001', mobile_normalised: '9810000001' }), user({ id: 'u3', email: null, mobile: '98100 00002', mobile_normalised: '9810000002' })]);
  const results = {
    'wrong password by email': await outcome(email('priya@x.test')),
    'wrong password by mobile': await outcome(mobile('9840012345')),
    'wrong password, mobile-only account': await outcome(mobile('9810000002')),
    'unknown email': await outcome(email('nobody@x.test')),
    'unknown mobile number': await outcome(mobile('9000000000')),
  };
  const first = Object.values(results)[0];
  for (const [what, r] of Object.entries(results)) {
    assert.equal(r.status, 401, what);
    assert.equal(r.code, 'INVALID_CREDENTIALS', what);
    assert.equal(r.message, first.message, `${what}: the message must not tell these apart`);
    assert.equal(r.compares, 1, `${what}: exactly one password comparison`);
  }
  assert.equal(results['unknown email'].dummy, true, 'an unknown email is compared against the dummy hash');
  assert.equal(results['unknown mobile number'].dummy, true, 'an unknown number is compared against the dummy hash');
  assert.equal(results['wrong password by mobile'].dummy, false, 'a known account is compared against its own hash');
});

test('a mobile number held by two accounts names nobody: refused like an unknown number, nobody is blamed, and it is logged', async () => {
  reset([user({ id: 'u1' }), user({ id: 'u2', email: 'other@x.test' })]);
  warnings.length = 0;
  const shared = await outcome(mobile('9840012345'), 'Secret123'); // even the RIGHT password must not sign anyone in
  assert.equal(shared.status, 401);
  assert.equal(shared.code, 'INVALID_CREDENTIALS');
  assert.equal(shared.compares, 1);
  assert.equal(shared.dummy, true, 'compared against the dummy hash, like an unknown number');
  assert.equal(failureCounts().length, 0, 'no account is given a failed attempt it did not make');
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('9840012345'), 'the number itself is never logged');

  // Both accounts can still sign in by email: the failure above is only about the number.
  reset([user({ id: 'u1' }), user({ id: 'u2', email: 'other@x.test' })]);
  const byEmail = await outcome(email('other@x.test'));
  assert.equal(byEmail.compares, 1);
  assert.equal(byEmail.dummy, false);
});

test('lockout counts a failed attempt on the account whichever way it was reached', async () => {
  reset([user()]);
  await outcome(mobile('9840012345'));
  assert.equal(failureCounts().length, 1);
  assert.deepEqual(failureCounts()[0].params.slice(0, 2), ['u1', 5], 'locks at 5 failures, like email sign-in always did');

  reset([user()]);
  await outcome(email('priya@x.test'));
  assert.equal(failureCounts().length, 1);

  reset([user({ id: 'none' })]);
  await outcome(mobile('9000000000'));
  assert.equal(failureCounts().length, 0, 'an unknown number has no account to count against');
});

test('a locked account answers the same way by email and by mobile, before any password is checked', async () => {
  const locked = { locked_until: new Date(Date.now() + 10 * 60000) };
  reset([user(locked)]);
  const a = await outcome(email('priya@x.test'));
  reset([user(locked)]);
  const b = await outcome(mobile('9840012345'));
  for (const r of [a, b]) { assert.equal(r.status, 429); assert.equal(r.code, 'ACCOUNT_LOCKED'); assert.equal(r.compares, 0); }
  assert.equal(a.message, b.message);
});

test.after(() => { bcrypt.compare = realCompare; });
