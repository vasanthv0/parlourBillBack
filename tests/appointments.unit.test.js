// No database and no running API: node --test tests/appointments.unit.test.js   (or: npm run test:unit)
// The rules, the input checks, the reminder message, the switches and the idempotency fingerprint of Phase 6.
const test = require('node:test');
const assert = require('node:assert/strict');

// whatsapp.js reads the country code from the environment config, which needs a .env file; stand it in.
const envFile = require.resolve('../src/config/env');
require.cache[envFile] = { id: envFile, filename: envFile, loaded: true, exports: { whatsappCountryCode: '91' } };

const rules = require('../src/modules/appointments/appointments.rules');
const schemas = require('../src/modules/appointments/appointments.schemas');
const reminder = require('../src/modules/appointments/reminder');
const idempotency = require('../src/modules/invoices/idempotency');
const { FEATURES, KEYS, effectiveFeatures } = require('../src/config/features');

const SVC = '11111111-1111-4111-8111-111111111111';
const SVC2 = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const parse = (schema, value) => schema.safeParse(value);
const fieldsOf = (result) => Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]));

// ── What a visit can do ───────────────────────────────────────────────────────────────

test('rules: which statuses each action is allowed from', () => {
  const allowed = (action) => ['booked', 'waiting', 'in_service', 'completed', 'cancelled', 'no_show'].filter((s) => rules.can(action, s));
  assert.deepEqual(allowed('start'), ['booked', 'waiting']);
  assert.deepEqual(allowed('cancel'), ['booked', 'waiting', 'in_service']);
  assert.deepEqual(allowed('noShow'), ['booked'], 'only a booking can fail to turn up');
  assert.deepEqual(allowed('bill'), ['booked', 'waiting', 'in_service']);
});

test('rules: a closed visit says why, and a billed one has its own code', () => {
  assert.equal(rules.refusal('bill', 'completed').code, 'APPOINTMENT_ALREADY_BILLED');
  assert.match(rules.refusal('bill', 'completed').message, /already been billed/);
  assert.equal(rules.refusal('start', 'cancelled').code, 'APPOINTMENT_CLOSED');
  assert.match(rules.refusal('start', 'no_show').message, /no-show/);
  assert.equal(rules.refusal('noShow', 'in_service').code, 'APPOINTMENT_STATE');
  assert.match(rules.refusal('noShow', 'waiting').message, /booked/);
});

// ── When a booking may be made ────────────────────────────────────────────────────────

test('rules: a booking may be up to a day in the past and a year ahead, to the millisecond', () => {
  const now = new Date('2026-11-05T10:00:00.000Z');
  const at = (ms) => new Date(now.getTime() + ms).toISOString();
  assert.equal(rules.bookingWindowError(at(0), now), null);
  assert.equal(rules.bookingWindowError(at(-rules.PAST_LIMIT_MS), now), null, 'exactly a day ago is fine');
  assert.equal(rules.bookingWindowError(at(-rules.PAST_LIMIT_MS - 1), now).code, 'TIME_TOO_EARLY');
  assert.equal(rules.bookingWindowError(at(rules.FUTURE_LIMIT_MS), now), null, 'exactly a year ahead is fine');
  assert.equal(rules.bookingWindowError(at(rules.FUTURE_LIMIT_MS + 1), now).code, 'TIME_TOO_FAR');
  assert.equal(rules.bookingWindowError('not a date', now).code, 'INVALID_TIME');
});

// ── What it is for, and how long it takes ─────────────────────────────────────────────

test('rules: the same service twice becomes one line with the quantities added, in the order first given', () => {
  assert.deepEqual(
    rules.mergeLines([{ serviceId: 'a', quantity: 1 }, { serviceId: 'b', quantity: 2 }, { serviceId: 'a', quantity: 3 }]),
    [{ serviceId: 'a', quantity: 4 }, { serviceId: 'b', quantity: 2 }]
  );
});

test('rules: the length of a visit is each service\'s minutes times its quantity, kept between 5 and 600', () => {
  assert.equal(rules.durationFrom([{ duration_min: 45, quantity: 1 }, { duration_min: 20, quantity: 2 }]), 85);
  assert.equal(rules.durationFrom([{ duration_min: 2, quantity: 1 }]), 5, 'never shorter than the database allows');
  assert.equal(rules.durationFrom([{ duration_min: 180, quantity: 10 }]), 600, 'cut to ten hours, not refused');
  assert.equal(rules.durationFrom([{ duration_min: '30', quantity: '2' }]), 60, 'numbers that arrive as text from the database still add up');
});

test('rules: the queue is longest-waiting first, ties broken by who was added first, and numbered from 1', () => {
  const rows = [
    { id: 'c', starts_at: '2026-11-05T10:05:00Z', created_at: '2026-11-05T10:05:00Z' },
    { id: 'a', starts_at: '2026-11-05T10:00:00Z', created_at: '2026-11-05T10:00:02Z' },
    { id: 'b', starts_at: '2026-11-05T10:00:00Z', created_at: '2026-11-05T10:00:01Z' },
  ];
  assert.deepEqual(rules.queueOrder(rows).map((q) => [q.row.id, q.position]), [['b', 1], ['a', 2], ['c', 3]]);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'a', 'b'], 'the list given is not reordered in place');
});

// ── Input checks ──────────────────────────────────────────────────────────────────────

const booking = (over = {}) => ({ kind: 'booked', date: '2026-11-06', time: '15:30', customerName: 'Priya Das', items: [{ serviceId: SVC, quantity: 1 }], ...over });

test('create: a good booking passes, and a booked time needs a date, a time and a name', () => {
  const ok = parse(schemas.create.body, booking());
  assert.equal(ok.success, true);
  assert.equal(ok.data.allowOverlap, false, 'double booking is refused unless the screen says otherwise');

  assert.deepEqual(fieldsOf(parse(schemas.create.body, booking({ date: undefined }))), { date: 'Choose the date' });
  assert.deepEqual(fieldsOf(parse(schemas.create.body, booking({ time: undefined }))), { time: 'Choose the time' });
  assert.match(fieldsOf(parse(schemas.create.body, booking({ customerName: undefined }))).customerName, /customer name/);
  assert.equal(parse(schemas.create.body, booking({ customerName: undefined, customerId: PERSON })).success, true, 'a saved customer replaces the typed name');
});

test('create: a walk-in needs no name and no time, and refuses a time (the server clock is the arrival)', () => {
  assert.equal(parse(schemas.create.body, { kind: 'walk_in', items: [{ serviceId: SVC, quantity: 1 }] }).success, true);
  const r = parse(schemas.create.body, { kind: 'walk_in', time: '10:00', items: [{ serviceId: SVC, quantity: 1 }] });
  assert.match(fieldsOf(r).time, /no time/);
});

test('create: dates and times must be real', () => {
  for (const date of ['2026-02-31', '2026-13-01', '2026-11-5', '06/11/2026', '', '2026-11-06T10:00']) {
    assert.equal(parse(schemas.create.body, booking({ date })).success, false, `date ${JSON.stringify(date)}`);
  }
  for (const time of ['24:00', '9:30', '15:60', '3:30 pm', '', '15:30:00']) {
    assert.equal(parse(schemas.create.body, booking({ time })).success, false, `time ${JSON.stringify(time)}`);
  }
  for (const [date, time] of [['2028-02-29', '00:00'], ['2026-12-31', '23:59']]) assert.equal(parse(schemas.create.body, booking({ date, time })).success, true);
});

test('create: services are required, limited, and need real ids and sensible quantities', () => {
  assert.match(fieldsOf(parse(schemas.create.body, booking({ items: [] }))).items, /at least one service/);
  assert.equal(parse(schemas.create.body, booking({ items: Array.from({ length: 11 }, () => ({ serviceId: SVC, quantity: 1 })) })).success, false);
  assert.equal(parse(schemas.create.body, booking({ items: [{ serviceId: 'nope', quantity: 1 }] })).success, false);
  assert.equal(parse(schemas.create.body, booking({ items: [{ serviceId: SVC, quantity: 0 }] })).success, false);
  assert.equal(parse(schemas.create.body, booking({ items: [{ serviceId: SVC, quantity: 11 }] })).success, false);
  assert.equal(parse(schemas.create.body, booking({ items: [{ serviceId: SVC, quantity: 1.5 }] })).success, false);
});

test('create: length 5 to 600 minutes; phone follows the customers rule; blank phone and notes mean none', () => {
  for (const durationMin of [4, 601, 30.5, '30']) assert.equal(parse(schemas.create.body, booking({ durationMin })).success, false, String(durationMin));
  for (const durationMin of [5, 600]) assert.equal(parse(schemas.create.body, booking({ durationMin })).success, true);

  assert.equal(parse(schemas.create.body, booking({ customerPhone: '98400 12345' })).success, true);
  assert.equal(parse(schemas.create.body, booking({ customerPhone: '+91 98400-12345' })).success, true);
  assert.match(fieldsOf(parse(schemas.create.body, booking({ customerPhone: '12345678' }))).customerPhone, /at least 10 digits/);
  assert.match(fieldsOf(parse(schemas.create.body, booking({ customerPhone: 'call me' }))).customerPhone, /valid phone/);
  const blank = parse(schemas.create.body, booking({ customerPhone: '   ', notes: '  ' }));
  assert.equal(blank.data.customerPhone, null);
  assert.equal(blank.data.notes, null);
  assert.equal(parse(schemas.create.body, booking({ notes: 'x'.repeat(301) })).success, false);
});

test('create: the kind must be one of the two, and ids must be uuids', () => {
  assert.equal(parse(schemas.create.body, booking({ kind: 'drop_in' })).success, false);
  assert.equal(parse(schemas.create.body, booking({ performerId: '123' })).success, false);
  assert.equal(parse(schemas.create.body, booking({ performerId: null })).success, true, 'nobody chosen yet is fine');
});

test('update: needs something to change; the date and the time travel together; allowOverlap alone is not a change', () => {
  const body = (b) => parse(schemas.update.body, b);
  assert.match(fieldsOf(body({}))[''], /Nothing to update/);
  assert.match(fieldsOf(body({ allowOverlap: true }))[''], /Nothing to update/);
  assert.match(fieldsOf(body({ date: '2026-11-06' })).time, /together/);
  assert.match(fieldsOf(body({ time: '10:00' })).date, /together/);
  assert.equal(body({ date: '2026-11-06', time: '10:00' }).success, true);
  assert.equal(body({ performerId: null }).success, true, 'null takes the person off');
  assert.equal(body({ notes: '' }).data.notes, null);
  assert.equal(body({ items: [{ serviceId: SVC2, quantity: 2 }], durationMin: 90 }).success, true);
});

test('start, cancel, reminder and ids: shapes', () => {
  assert.deepEqual(parse(schemas.start.body, {}).data, { allowOverlap: false });
  assert.equal(parse(schemas.start.body, { performerId: PERSON }).data.performerId, PERSON);
  assert.equal(parse(schemas.cancel.body, { reason: '  ' }).data.reason, null);
  assert.equal(parse(schemas.cancel.body, { reason: 'x'.repeat(201) }).success, false);
  assert.equal(parse(schemas.reminder.query, {}).success, true);
  assert.equal(parse(schemas.reminder.query, { phone: '9'.repeat(26) }).success, false);
  assert.equal(parse(schemas.byId.params, { id: 'nope' }).success, false);
  assert.equal(parse(schemas.day.query, { date: '2026-11-05' }).success, true);
  assert.equal(parse(schemas.day.query, {}).success, true, 'no date means today');
  assert.equal(parse(schemas.day.query, { date: '2026-02-30' }).success, false);
});

// ── The reminder ──────────────────────────────────────────────────────────────────────

const parlour = { name: 'Demo Parlour', phone: '9840000000', timezone: 'Asia/Kolkata' };
const visit = (over = {}) => ({
  phone: '98400 12345', customerName: 'Ananya Iyer', startsAt: '2026-11-06T10:00:00Z', // 3:30 pm in India
  services: [{ name: 'Haircut', quantity: 1 }, { name: 'Head Massage', quantity: 2 }], performerName: 'Meena', parlour, ...over,
});

test('reminder: the message names the time on the parlour\'s clock, the services, the person and a phone to call', () => {
  const m = reminder.buildMessage(visit());
  assert.match(m, /^Hello Ananya, this is a reminder of your appointment at \*Demo Parlour\*\./);
  // Node's date data differs a little between versions ("6 Nov 2026" or "6 Nov, 2026"), so the commas are optional.
  assert.match(m, /When: Fri,? 6 Nov,? 2026,? (at )?3:30 pm/i);
  assert.match(m, /Services: Haircut, Head Massage × 2/);
  assert.match(m, /With: Meena/);
  assert.match(m, /Call 9840000000/);
  assert.match(m, /See you soon!$/);
});

test('reminder: the clock is the parlour\'s, not the server\'s', () => {
  assert.match(reminder.buildMessage(visit({ parlour: { ...parlour, timezone: 'America/New_York' } })), /5:00 am/i);
});

test('reminder: what is not known is left out rather than written as blank', () => {
  const m = reminder.buildMessage(visit({ performerName: null, parlour: { ...parlour, phone: null }, services: [] }));
  assert.doesNotMatch(m, /With:|Services:|Call /);
  assert.match(reminder.buildMessage(visit({ customerName: 'Walk-in' })), /^Hello, this/);
  assert.match(reminder.buildMessage(visit({ customerName: '  ' })), /^Hello, this/);
});

test('reminder: the link is wa.me with the country code added to a 10-digit number and the message encoded', () => {
  const r = reminder.build(visit());
  assert.equal(r.phone, '919840012345');
  assert.ok(r.url.startsWith('https://wa.me/919840012345?text='));
  assert.equal(decodeURIComponent(r.url.split('?text=')[1]), r.message);
  assert.equal(reminder.build(visit({ phone: '+44 7911 123456' })).phone, '447911123456', 'a number with its own country code is kept');
});

test('reminder: no number, or a number that is not one, is refused with a field message (the same rule as a bill\'s WhatsApp link)', () => {
  assert.throws(() => reminder.build(visit({ phone: null })), (e) => e.code === 'PHONE_REQUIRED' && e.status === 400);
  assert.throws(() => reminder.build(visit({ phone: '12345' })), (e) => e.code === 'INVALID_PHONE' && e.status === 400);
});

// ── The switches ──────────────────────────────────────────────────────────────────────

test('switches: Appointments and its two buttons exist, are on by default, and the buttons need the page', () => {
  for (const key of ['page.appointments', 'action.appointments.remind', 'action.appointments.bill']) assert.ok(KEYS.includes(key), key);
  assert.equal(FEATURES.find((f) => f.key === 'page.appointments').group, 'page');
  for (const key of ['action.appointments.remind', 'action.appointments.bill']) {
    const f = FEATURES.find((x) => x.key === key);
    assert.equal(f.group, 'action');
    assert.equal(f.requires, 'page.appointments');
  }
  const on = effectiveFeatures({});
  assert.equal(on['page.appointments'] && on['action.appointments.remind'] && on['action.appointments.bill'], true, 'on for every parlour, existing ones included');
});

test('switches: turning the page off takes both buttons with it; turning a button off leaves the page and the other button', () => {
  const pageOff = effectiveFeatures({ 'page.appointments': false });
  assert.deepEqual([pageOff['page.appointments'], pageOff['action.appointments.remind'], pageOff['action.appointments.bill']], [false, false, false]);
  const remindOff = effectiveFeatures({ 'action.appointments.remind': false });
  assert.deepEqual([remindOff['page.appointments'], remindOff['action.appointments.remind'], remindOff['action.appointments.bill']], [true, false, true]);
  // Performers has nothing to do with it: a parlour can run a one-column calendar.
  assert.equal(effectiveFeatures({ 'page.performers': false })['page.appointments'], true);
});

test('switches: every other switch is unchanged by adding these', () => {
  const before = ['page.dashboard', 'page.customers', 'page.services', 'page.team', 'page.settings', 'page.combos', 'page.attendance', 'page.referrals', 'page.performers', 'page.commissions',
    'action.services.add', 'action.team.add', 'action.team.edit', 'action.team.reset', 'action.team.deactivate', 'action.combos.add', 'action.referrals.add', 'action.referrals.pay',
    'action.performers.add', 'action.commissions.pay', 'action.whatsapp.send', 'action.payments.split', 'action.payments.tip'];
  for (const key of before) assert.ok(KEYS.includes(key), `${key} is still there`);
  // Appointments added 3 (its page and two buttons). Attendance by Staff later added 1 more (its page), so the total is now 4 above `before`.
  assert.equal(KEYS.length, before.length + 3 + 1);
  assert.ok(KEYS.includes('page.attendance_by_staff'), 'the Attendance by Staff switch is registered');
});

// ── Idempotency of a bill made from a visit ───────────────────────────────────────────

const bill = (over = {}) => ({ items: [{ serviceId: SVC, quantity: 1 }], discount: 0, paymentMethod: 'cash', ...over });

test('idempotency: a bill with no appointment has exactly the fingerprint it always had', () => {
  assert.equal(idempotency.fingerprintOf(bill()), idempotency.fingerprintOf(bill({ appointmentId: undefined })));
  assert.equal(idempotency.fingerprintOf(bill()), idempotency.fingerprintOf(bill({ appointmentId: null })));
});

test('idempotency: the same lines billed from a visit are a different request from the same lines billed without one', () => {
  const A = '44444444-4444-4444-8444-444444444444';
  const B = '55555555-5555-4555-8555-555555555555';
  assert.notEqual(idempotency.fingerprintOf(bill()), idempotency.fingerprintOf(bill({ appointmentId: A })));
  assert.notEqual(idempotency.fingerprintOf(bill({ appointmentId: A })), idempotency.fingerprintOf(bill({ appointmentId: B })));
  assert.equal(idempotency.fingerprintOf(bill({ appointmentId: A })), idempotency.fingerprintOf(bill({ appointmentId: A })));
});
