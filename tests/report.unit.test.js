// No database and no running API: node --test tests/report.unit.test.js   (or: npm run test:unit)
// Tests the report's grouping, masking and read-only guarantees. The SQL against a real database is run by you:
//   npm run report:customer-phones
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SQL, buildReport, formatReport, maskPhone, maskName, maskEmail, domesticPrefix } = require('../db/report-customer-phone-collisions');

const GLOW = 'aaaaaaaa-0000-4000-8000-000000000001';
const STYLE = 'bbbbbbbb-0000-4000-8000-000000000002';

// A row exactly as the query returns it (bill counts and money arrive as strings from PostgreSQL).
const row = (id, parlour, name, phone, createdAt, extra = {}) => ({
  parlour_id: parlour === 'A' ? GLOW : STYLE,
  parlour_name: parlour === 'A' ? 'Glow Salon' : 'Style Studio',
  id, name, phone, email: null, created_at: createdAt,
  digits: phone.replace(/\D/g, ''),
  bills: '0', void_bills: '0', spent: '0', last_visit: null,
  ...extra,
});

const ROWS = [
  row('c-a1', 'A', 'Meera Krishnan', '98400 12345', '2025-03-02T10:00:00Z', { email: 'meera@x.test', bills: '2', void_bills: '1', spent: '1845.50', last_visit: '2026-10-20T09:00:00Z' }),
  row('c-a2', 'A', 'Meera K', '+91 9840012345', '2025-09-14T10:00:00Z', { bills: '1', spent: '500.00', last_visit: '2026-09-30T09:00:00Z' }),
  row('c-a3', 'A', 'M Krishnan', '098400-12345', '2026-01-05T10:00:00Z'),
  row('c-a4', 'A', 'Priya Nair', '9841111111', '2025-04-01T10:00:00Z'),
  row('c-a5', 'A', 'No Digits One', '-------', '2025-05-01T10:00:00Z'),
  row('c-a6', 'A', 'No Digits Two', '((((((((', '2025-05-02T10:00:00Z'),
  row('c-a7', 'A', 'Short Number', '1234567', '2025-06-01T10:00:00Z'),
  row('c-b1', 'B', 'Meera Krishnan', '9840012345', '2025-07-01T10:00:00Z'),   // same number, DIFFERENT parlour
  row('c-b2', 'B', 'Sam UK', '+44 9876543210', '2025-08-01T10:00:00Z'),
  row('c-b3', 'B', 'Sam Local', '9876543210', '2025-08-02T10:00:00Z'),
];

// ───────────── grouping ─────────────

test('a number typed three ways in one parlour is one collision group, oldest customer first', () => {
  const g = buildReport(ROWS).groups.find((x) => x.parlourName === 'Glow Salon' && x.phone10 === '9840012345');
  assert.deepEqual(g.customers.map((c) => c.id), ['c-a1', 'c-a2', 'c-a3']);
  assert.equal(g.mixedPrefixes, false, '+91, 91 and a leading 0 are the same local number');
});

test('the same number in a DIFFERENT parlour is not a collision (parlours are separate)', () => {
  const { groups } = buildReport(ROWS);
  assert.equal(groups.some((g) => g.parlourName === 'Style Studio' && g.phone10 === '9840012345'), false);
  assert.equal(groups.every((g) => new Set(g.customers.map((c) => c.parlourId)).size === 1), true, 'a group never mixes parlours');
});

test('two numbers that differ in extra leading digits (+44 vs local) are flagged as possibly different people', () => {
  const g = buildReport(ROWS).groups.find((x) => x.phone10 === '9876543210');
  assert.equal(g.customers.length, 2);
  assert.equal(g.mixedPrefixes, true);
});

test('customers with no digits at all collide with each other (they would all share an empty number)', () => {
  const { groups, totals } = buildReport(ROWS);
  const empty = groups.find((g) => g.noDigits);
  assert.deepEqual(empty.customers.map((c) => c.id), ['c-a5', 'c-a6']);
  assert.equal(totals.noDigits, 2);
});

test('numbers with fewer than 10 digits are listed separately, collision or not', () => {
  const { short } = buildReport(ROWS);
  assert.deepEqual(short.map((c) => c.id), ['c-a7']);
});

test('totals add up', () => {
  const { totals } = buildReport(ROWS);
  assert.deepEqual(totals, { customers: 10, parlours: 2, collisionGroups: 3, customersInCollisions: 7, shortNumbers: 1, noDigits: 2 });
});

test('bill counts, money and last visit come from the row; voided bills are counted apart', () => {
  const [first, second, third] = buildReport(ROWS).groups.find((g) => g.phone10 === '9840012345').customers;
  assert.deepEqual([first.bills, first.voidBills, first.spent], [2, 1, 1845.5]);
  assert.deepEqual([second.bills, second.voidBills, second.spent], [1, 0, 500]);
  assert.deepEqual([third.bills, third.voidBills, third.spent], [0, 0, 0]);
  assert.equal(third.lastVisit, null);
});

test('no customers, no collisions: an empty, tidy report', () => {
  const r = buildReport([]);
  assert.deepEqual(r.totals, { customers: 0, parlours: 0, collisionGroups: 0, customersInCollisions: 0, shortNumbers: 0, noDigits: 0 });
  assert.match(formatReport(r), /COLLISIONS: none/);
});

test('a clean list says so and mentions no groups', () => {
  const clean = ROWS.filter((r) => ['c-a4', 'c-b1'].includes(r.id));
  const r = buildReport(clean);
  assert.equal(r.groups.length, 0);
  const text = formatReport(r, { database: 'parlourbill' });
  assert.match(text, /COLLISIONS: none/);
  assert.equal(/Group \d+ of/.test(text), false);
});

test('domesticPrefix: 91, 0 and nothing are the same; any other prefix stays distinct', () => {
  assert.equal(domesticPrefix(''), '');
  assert.equal(domesticPrefix('0'), '');
  assert.equal(domesticPrefix('91'), '');
  assert.equal(domesticPrefix('44'), '44');
});

// ───────────── text output ─────────────

test('the text report shows each group with ids, the number as typed, bills, money and last visit, and ends by asking you', () => {
  const text = formatReport(buildReport(ROWS), { database: 'parlourbill' });
  assert.match(text, /Read-only: nothing was changed/);
  assert.match(text, /Database: parlourbill/);
  assert.match(text, /Group \d of 3 · Glow Salon \(parlour aaaaaaaa…\) · last 10 digits 9840012345 · 3 customers/);
  assert.match(text, /id c-a1 {2}Meera Krishnan {2}"98400 12345" {2}meera@x\.test/);
  assert.match(text, /2 paid bills \(₹1,845\.50, last visit 2026-10-20\) · 1 voided bill/);
  assert.match(text, /! The numbers differ in extra leading digits/);
  assert.match(text, /SHORT NUMBERS \(1\)/);
  assert.match(text, /NO DIGITS \(2\)/);
  assert.match(text, /Nothing was merged, edited or deleted\. Tell me how you want each group handled/);
});

// ───────────── masking ─────────────

test('maskPhone / maskName / maskEmail', () => {
  assert.equal(maskPhone('+91 98400-12345'), '91*******345');
  assert.equal(maskPhone('98400 12345'), '98*****345');
  assert.equal(maskPhone('12345'), '*****');
  assert.equal(maskPhone('-------'), '');
  assert.equal(maskName('Meera Krishnan'), 'Meera K.');
  assert.equal(maskName('Meera Devi Krishnan'), 'Meera K.');
  assert.equal(maskName('Meera'), 'Meera');
  assert.equal(maskName(''), '');
  assert.equal(maskEmail('meera@x.test'), 'm***@x.test');
  assert.equal(maskEmail(null), null);
});

test('--mask: no real number, surname or email appears anywhere, in text or in JSON, but the ids do', () => {
  const masked = buildReport(ROWS, { mask: true });
  const text = formatReport(masked, { masked: true, database: 'parlourbill' });
  const json = JSON.stringify(masked);
  for (const secret of ['9840012345', '98400 12345', '098400-12345', '9876543210', '9841111111', '1234567', 'meera@x.test', 'Krishnan', 'Nair']) {
    assert.equal(text.includes(secret), false, `text contains ${secret}`);
    assert.equal(json.includes(secret), false, `json contains ${secret}`);
  }
  assert.match(text, /id c-a1/);
  assert.match(text, /Masked: digits, surnames and email names are hidden\. Ids are real\./);
  // grouping is still correct: it was done on the real digits before masking
  assert.equal(masked.totals.collisionGroups, 3);
});

// ───────────── read-only guarantees ─────────────

test('the SQL only reads: no write keyword anywhere, and it asks for the digits the same way the referrers index does', () => {
  assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|COPY)\b/i.test(SQL), false);
  assert.match(SQL, /regexp_replace\(c\.phone, '\\D', '', 'g'\)/);
  assert.match(SQL, /^\s*SELECT/);
});

test('the script runs inside a READ ONLY transaction, rolls it back, and has no write statement of its own', () => {
  const source = fs.readFileSync(path.join(__dirname, '../db/report-customer-phone-collisions.js'), 'utf8');
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.equal(/\bCOMMIT\b/.test(source), false);
  assert.equal(/client\.query\(\s*[`'"]\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)/i.test(source), false);
});

test('it is wired into npm as report:customer-phones', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.scripts['report:customer-phones'], 'node db/report-customer-phone-collisions.js');
});

test('on failure it prints only the error message, never a connection string or query', () => {
  const source = fs.readFileSync(path.join(__dirname, '../db/report-customer-phone-collisions.js'), 'utf8');
  assert.match(source, /console\.error\('Report failed:', err\.message\)/);
});
