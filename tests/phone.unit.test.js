// No database and no running API: node --test tests/phone.unit.test.js   (or: npm run test:unit)
const test = require('node:test');
const assert = require('node:assert/strict');

const { digitsOf, last10 } = require('../src/utils/phone');
const schemas = require('../src/modules/customers/customers.schemas');

// ───────────── the helper ─────────────

test('last10: however a number is typed, its last 10 digits are the same', () => {
  for (const typed of ['9840012345', '98400 12345', '+91 98400-12345', '091 98400 12345', '098400-12345', '(98400) 12345', ' 9840012345 ']) {
    assert.equal(last10(typed), '9840012345', `typed as ${JSON.stringify(typed)}`);
  }
});

test('last10: shorter numbers stay whole; nothing at all gives an empty string', () => {
  assert.equal(last10('1234567'), '1234567');
  assert.equal(last10('-------'), '');
  assert.equal(last10(''), '');
  assert.equal(last10(null), '');
  assert.equal(last10(undefined), '');
});

test('last10: a different country code does not change the last 10 digits (that is for the report to flag)', () => {
  assert.equal(last10('+44 9876543210'), last10('9876543210'));
  assert.equal(digitsOf('+44 9876543210'), '449876543210');
});

test('digitsOf only keeps ASCII digits', () => {
  assert.equal(digitsOf('+91 (984) 001-2345 ext.'), '919840012345');
  assert.equal(digitsOf(12345), '12345');
});

// ───────────── the customer rule ─────────────

const create = (phone) => schemas.create.body.safeParse({ name: 'Test Person', phone });
const update = (body) => schemas.update.body.safeParse(body);
const messageFor = (result) => result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

test('customer phone: normal and formatted 10-digit numbers are accepted', () => {
  for (const p of ['9840012345', '98400 12345', '+91 98400-12345', '(044) 2345 6789', '  98400 12345  ']) {
    assert.equal(create(p).success, true, `should accept ${JSON.stringify(p)}`);
  }
});

test('customer phone: input with no digits, or fewer than 10, is refused with a clear message', () => {
  for (const p of ['-------', '((((((((', '+ + + + + +', '1234567', '12345678', '123456789']) {
    const r = create(p);
    assert.equal(r.success, false, `should refuse ${JSON.stringify(p)}`);
    assert.match(messageFor(r), /phone: Enter a phone number with at least 10 digits/);
  }
});

test('customer phone: letters and symbols outside the allowed set are still refused as before', () => {
  for (const p of ['abc', '98400x12345', '9840012345; DROP TABLE customers', '1'.repeat(21)]) {
    const r = create(p);
    assert.equal(r.success, false, `should refuse ${JSON.stringify(p)}`);
    assert.match(messageFor(r), /phone: Enter a valid phone number/);
  }
});

test('customer phone: exactly 10 digits is enough, and the number is kept as typed (after trimming)', () => {
  const r = create('  98400 12345 ');
  assert.equal(r.success, true);
  assert.equal(r.data.phone, '98400 12345');
});

test('customer update: changing only the name does not need a phone; changing the phone applies the same rule', () => {
  assert.equal(update({ name: 'New Name' }).success, true);
  assert.equal(update({ phone: '9840099999' }).success, true);
  assert.equal(update({ phone: '---------' }).success, false);
  assert.equal(update({ phone: '123456789' }).success, false);
  assert.equal(update({}).success, false, 'an empty update is still refused');
});
