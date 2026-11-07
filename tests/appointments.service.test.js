// No database and no running API: node --test tests/appointments.service.test.js   (or: npm run test:unit)
// The real appointments service and the real invoice service run here against a scripted stand-in for the database, so the
// test sees exactly what would be written, what is refused before anything is written, and which parlour every query is
// limited to. (The SQL itself, overlap and constraints, is checked against PostgreSQL by tests/appointments.db.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');

// Load the services without a database or a .env file.
const stub = (modulePath, exports) => {
  const file = require.resolve(modulePath);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const world = { runTransaction: null, pool: null };
stub('../src/config/db', {
  pool: {},
  query: async (text, params) => world.pool(text, params),
  withTransaction: async (fn) => world.runTransaction(fn),
});
stub('../src/config/env', { whatsappCountryCode: '91' });

const service = require('../src/modules/appointments/appointments.service');
const invoices = require('../src/modules/invoices/invoices.service');
const performers = require('../src/modules/performers/performers.service');
const realGetWith = service.getWith;

const SVC_CUT = '11111111-1111-4111-8111-111111111111';
const SVC_MASSAGE = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const OTHER_PERSON = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';
const APPT = '66666666-6666-4666-8666-666666666666';

const staff = { userId: 'user-A', parlourId: 'parlour-A', role: 'staff' };
const admin = { userId: 'admin-A', parlourId: 'parlour-A', role: 'admin' };

const MENU = {
  [SVC_CUT]: { id: SVC_CUT, name: 'Haircut', duration_min: 30, price: '200.00', sac_code: null },
  [SVC_MASSAGE]: { id: SVC_MASSAGE, name: 'Massage', duration_min: 45, price: '1000.00', sac_code: null },
};
const NOW = '2026-11-05T10:00:00.000Z';

/**
 * A scripted transaction client. `over` replaces any answer; anything the script does not know about throws, so a query the
 * service was never meant to make fails the test.
 */
function fakeDb(over = {}) {
  const calls = [];
  const answers = {
    services: (_t, p) => ({ rows: p[1].map((id) => MENU[id]).filter(Boolean) }),
    customer: (_t, p) => ({ rows: p[1] === 'parlour-A' && p[0] === CUSTOMER ? [{ id: CUSTOMER, name: 'Ananya Iyer', phone: '9840012345' }] : [] }),
    performer: (_t, p) => ({ rows: p[1] === 'parlour-A' && [PERSON, OTHER_PERSON].includes(p[0]) ? [{ id: p[0], name: p[0] === PERSON ? 'Meena' : 'Asha' }] : [] }),
    start: () => ({ rows: [{ starts_at: '2026-11-06T10:00:00.000Z', now: NOW }] }),
    now: () => ({ rows: [{ now: NOW }] }),
    lockPerson: () => ({ rows: [] }),
    clash: () => ({ rows: [] }),
    insertAppointment: () => ({ rows: [{ id: APPT }] }),
    other: () => ({ rows: [] }),
    ...over,
  };
  const routes = [
    [/FROM services WHERE/, 'services'],
    [/FROM customers WHERE/, 'customer'],
    [/FROM performers WHERE/, 'performer'],
    [/AT TIME ZONE timezone\) AS starts_at, now\(\) AS now/, 'start'],
    [/^SELECT now\(\) AS now$/, 'now'],
    [/pg_advisory_xact_lock/, 'lockPerson'],
    [/JOIN performers pf ON pf.id = a.performer_id/, 'clash'],
    [/INSERT INTO appointments/, 'insertAppointment'],
    [/FROM appointments a WHERE a.id = \$1 AND a.parlour_id = \$2 FOR UPDATE/, 'lockAppointment'],
    [/DELETE FROM appointment_services|INSERT INTO appointment_services|UPDATE appointments SET/, 'other'],
  ];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      for (const [re, name] of routes) if (re.test(text.trim())) {
        if (!answers[name]) throw new Error(`the test gave no answer for: ${name}`);
        return answers[name](text, params);
      }
      throw new Error(`unexpected query in the transaction: ${text.slice(0, 90)}`);
    },
  };
}

/** Runs fn with a fake database; gives back what happened, including the error if it was refused. */
async function run(db, fn) {
  world.runTransaction = (work) => work(db);
  service.getWith = async (_db, _auth, id) => ({ id, read: true });
  let error = null;
  let result;
  try { result = await fn(); } catch (err) { error = err; } finally { service.getWith = realGetWith; }
  const wrote = (re) => db.calls.filter((c) => re.test(c.text));
  return { error, result, calls: db.calls, wrote, wroteAnything: db.calls.some((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.text)) };
}

const booking = (over = {}) => ({ kind: 'booked', date: '2026-11-06', time: '15:30', customerName: 'Priya Das', items: [{ serviceId: SVC_CUT, quantity: 1 }], allowOverlap: false, ...over });
const walkIn = (over = {}) => ({ kind: 'walk_in', items: [{ serviceId: SVC_CUT, quantity: 1 }], allowOverlap: false, ...over });
const insertOf = (r) => r.wrote(/INSERT INTO appointments/)[0]?.params;
// INSERT order: parlour, kind, status, customer_id, customer_name, customer_phone, performer_id, starts_at, duration_min, notes, created_by
const row = (p) => p && { parlour: p[0], kind: p[1], status: p[2], customerId: p[3], name: p[4], phone: p[5], performerId: p[6], startsAt: p[7], durationMin: p[8], notes: p[9], createdBy: p[10] };

// ── Making a booking ──────────────────────────────────────────────────────────────────

test('a booking is saved for the parlour and the person in the token, with the services as named and timed that day, and no price', async () => {
  const r = await run(fakeDb(), () => service.create(staff, booking({ items: [{ serviceId: SVC_CUT, quantity: 1 }, { serviceId: SVC_MASSAGE, quantity: 2 }], notes: 'Allergic to ammonia' })));
  assert.equal(r.error, null);
  assert.deepEqual(row(insertOf(r)), {
    parlour: 'parlour-A', kind: 'booked', status: 'booked', customerId: null, name: 'Priya Das', phone: null, performerId: null,
    startsAt: '2026-11-06T10:00:00.000Z', durationMin: 30 + 45 * 2, notes: 'Allergic to ammonia', createdBy: 'user-A',
  });
  const lines = r.wrote(/INSERT INTO appointment_services/).map((c) => c.params);
  assert.deepEqual(lines.map((p) => [p[1], p[2], p[3], p[4]]), [[SVC_CUT, 'Haircut', 30, 1], [SVC_MASSAGE, 'Massage', 45, 2]]);
  assert.ok(!JSON.stringify(r.calls.map((c) => c.params)).includes('1000.00'), 'no price is written anywhere: the bill works it out on the day');
});

test('a typed length wins over the sum of the services', async () => {
  const r = await run(fakeDb(), () => service.create(staff, booking({ durationMin: 90 })));
  assert.equal(row(insertOf(r)).durationMin, 90);
});

test('a saved customer supplies the name and number; a number typed for this booking wins for the reminder', async () => {
  const a = await run(fakeDb(), () => service.create(staff, booking({ customerId: CUSTOMER, customerName: undefined })));
  assert.equal(a.error, null);
  assert.deepEqual([row(insertOf(a)).customerId, row(insertOf(a)).name, row(insertOf(a)).phone], [CUSTOMER, 'Ananya Iyer', '9840012345']);
  const b = await run(fakeDb(), () => service.create(staff, booking({ customerId: CUSTOMER, customerPhone: '98400 99999' })));
  assert.equal(row(insertOf(b)).phone, '98400 99999');
});

test('a customer who is not this parlour\'s is refused and nothing is saved', async () => {
  const r = await run(fakeDb(), () => service.create(staff, booking({ customerId: '99999999-9999-4999-8999-999999999999' })));
  assert.equal(r.error.code, 'CUSTOMER_NOT_FOUND');
  assert.equal(r.error.status, 400);
  assert.equal(r.wroteAnything, false);
});

test('a service that is gone, inactive or another parlour\'s is refused and nothing is saved', async () => {
  const r = await run(fakeDb(), () => service.create(staff, booking({ items: [{ serviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: 1 }] })));
  assert.equal(r.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(r.wroteAnything, false);
});

test('a person who is not this parlour\'s (or is deactivated) is refused and nothing is saved', async () => {
  const r = await run(fakeDb({ performer: () => ({ rows: [] }) }), () => service.create(staff, booking({ performerId: PERSON })));
  assert.equal(r.error.code, 'PERFORMER_UNAVAILABLE');
  assert.equal(r.wroteAnything, false);
});

test('a time more than a day ago, or more than a year ahead, is refused as a field error and nothing is saved', async () => {
  for (const [starts_at, code] of [['2026-11-04T09:59:00.000Z', 'TIME_TOO_EARLY'], ['2027-11-07T10:00:01.000Z', 'TIME_TOO_FAR']]) {
    const r = await run(fakeDb({ start: () => ({ rows: [{ starts_at, now: NOW }] }) }), () => service.create(staff, booking()));
    assert.equal(r.error.code, code);
    assert.equal(r.error.status, 400);
    assert.ok(r.error.details.time, 'the message goes on the time field');
    assert.equal(r.wroteAnything, false);
  }
});

test('the date and time are turned into an instant by the database using the parlour\'s own zone, never by the browser', async () => {
  const r = await run(fakeDb(), () => service.create(staff, booking({ date: '2026-12-25', time: '09:05' })));
  const q = r.calls.find((c) => /AT TIME ZONE timezone\) AS starts_at/.test(c.text));
  assert.deepEqual(q.params, ['parlour-A', '2026-12-25', '09:05']);
});

// ── Double booking ────────────────────────────────────────────────────────────────────

test('double booking: a person who already has someone at that time is refused (409), and nothing is saved', async () => {
  const clash = () => ({ rows: [{ customer_name: 'Divya Raman', starts_at: '2026-11-06T09:45:00.000Z', duration_min: 45, timezone: 'Asia/Kolkata', performer_name: 'Meena' }] });
  const r = await run(fakeDb({ clash }), () => service.create(staff, booking({ performerId: PERSON })));
  assert.equal(r.error.status, 409);
  assert.equal(r.error.code, 'SLOT_TAKEN');
  assert.equal(r.error.message, 'Meena already has Divya Raman from 15:15 to 16:00.', 'the times are the parlour\'s clock');
  assert.equal(r.wroteAnything, false);
});

test('double booking: the person is locked first, then the question is asked about exactly this person, time and length', async () => {
  const r = await run(fakeDb(), () => service.create(staff, booking({ performerId: PERSON, durationMin: 50 })));
  assert.equal(r.error, null);
  const order = r.calls.map((c) => (/pg_advisory_xact_lock/.test(c.text) ? 'lock' : /JOIN performers pf ON pf.id = a.performer_id/.test(c.text) ? 'check' : /INSERT INTO appointments/.test(c.text) ? 'insert' : null)).filter(Boolean);
  assert.deepEqual(order, ['lock', 'check', 'insert'], 'two people booking at once take turns on the same person');
  assert.equal(r.calls.find((c) => /pg_advisory_xact_lock/.test(c.text)).params[0], `appointments:${PERSON}`);
  assert.deepEqual(r.calls.find((c) => /JOIN performers pf ON pf.id = a.performer_id/.test(c.text)).params, ['parlour-A', PERSON, '2026-11-06T10:00:00.000Z', 50, null]);
});

test('double booking: the screen can book anyway after seeing the warning; nobody chosen, or a walk-in who is only waiting, is never checked', async () => {
  const clashing = { clash: () => { throw new Error('the clash check must not run'); } };
  assert.equal((await run(fakeDb(clashing), () => service.create(staff, booking({ performerId: PERSON, allowOverlap: true })))).error, null);
  assert.equal((await run(fakeDb(clashing), () => service.create(staff, booking({ performerId: null })))).error, null);
  const waiting = await run(fakeDb(clashing), () => service.create(staff, walkIn({ performerId: PERSON })));
  assert.equal(waiting.error, null);
  assert.equal(row(insertOf(waiting)).performerId, PERSON, 'the walk-in is saved with the person they asked for');
});

// ── Walk-ins ──────────────────────────────────────────────────────────────────────────

test('a walk-in joins the queue at the database\'s clock, with no name needed', async () => {
  const r = await run(fakeDb(), () => service.create(staff, walkIn()));
  assert.equal(r.error, null);
  assert.deepEqual([row(insertOf(r)).kind, row(insertOf(r)).status, row(insertOf(r)).name, row(insertOf(r)).startsAt], ['walk_in', 'waiting', 'Walk-in', NOW]);
  assert.ok(!r.calls.some((c) => /AT TIME ZONE timezone\) AS starts_at/.test(c.text)), 'no time from the browser is used');
});

// ── Tenant isolation ──────────────────────────────────────────────────────────────────

test('every query that reaches a business table is limited to the parlour in the token', async () => {
  const db = fakeDb();
  await run(db, () => service.create(staff, booking({ customerId: CUSTOMER, performerId: PERSON })));
  const scoped = db.calls.filter((c) => /\b(services|customers|performers|appointments)\b/.test(c.text) && !/appointment_services/.test(c.text) && !/^\s*INSERT/.test(c.text));
  assert.ok(scoped.length >= 4);
  for (const c of scoped) assert.ok(c.params.includes('parlour-A'), `not limited to the parlour: ${c.text.slice(0, 80)}`);
  assert.equal(row(insertOf({ wrote: (re) => db.calls.filter((c) => re.test(c.text)) })).parlour, 'parlour-A');
});

test('another parlour\'s appointment is "not found" to read, change, start, cancel and mark as no-show', async () => {
  const none = { lockAppointment: () => ({ rows: [] }) };
  for (const [name, call] of [
    ['update', () => service.update(staff, APPT, { notes: 'x' })],
    ['start', () => service.start(staff, APPT, { allowOverlap: false })],
    ['cancel', () => service.cancel(staff, APPT, {})],
    ['noShow', () => service.noShow(staff, APPT)],
  ]) {
    const db = fakeDb(none);
    const r = await run(db, call);
    assert.equal(r.error.status, 404, name);
    assert.equal(r.wroteAnything, false, name);
    assert.deepEqual(db.calls[0].params, [APPT, 'parlour-A'], `${name} asked for it within its own parlour`);
  }
  world.pool = async () => ({ rows: [] });
  await assert.rejects(() => service.get(staff, APPT), (e) => e.status === 404);
  await assert.rejects(() => service.markReminded(staff, APPT), (e) => e.status === 404);
});

// ── Changing a visit ──────────────────────────────────────────────────────────────────

const open = (over = {}) => ({
  id: APPT, parlour_id: 'parlour-A', kind: 'booked', status: 'booked', customer_id: null, customer_name: 'Priya Das', customer_phone: '9840011111',
  performer_id: PERSON, starts_at: '2026-11-06T10:00:00.000Z', duration_min: 45, notes: null, reminder_sent_at: '2026-11-05T08:00:00.000Z', db_now: NOW, ...over,
});
const locked = (over) => ({ lockAppointment: () => ({ rows: [open(over)] }) });
const updateOf = (r) => { const p = r.wrote(/UPDATE appointments SET customer_id/)[0]?.params; return p && { customerId: p[2], name: p[3], phone: p[4], performerId: p[5], startsAt: p[6], durationMin: p[7], notes: p[8], reminderSentAt: p[9] }; };

test('changing a visit that is closed (billed, cancelled, no-show) is refused: it is a record', async () => {
  for (const status of ['completed', 'cancelled', 'no_show']) {
    const r = await run(fakeDb(locked({ status, invoice_id: status === 'completed' ? 'inv' : null })), () => service.update(staff, APPT, { notes: 'x' }));
    assert.equal(r.error.status, 409, status);
    assert.equal(r.wroteAnything, false, status);
  }
  const billed = await run(fakeDb(locked({ status: 'completed' })), () => service.update(staff, APPT, { notes: 'x' }));
  assert.equal(billed.error.code, 'APPOINTMENT_ALREADY_BILLED');
});

test('moving a booking resets its reminder, and the new time is checked against the person\'s other visits (not against itself)', async () => {
  const db = fakeDb({ ...locked(), start: () => ({ rows: [{ starts_at: '2026-11-06T12:00:00.000Z', now: NOW }] }) });
  const r = await run(db, () => service.update(staff, APPT, { date: '2026-11-06', time: '17:30', allowOverlap: false }));
  assert.equal(r.error, null);
  assert.equal(updateOf(r).startsAt, '2026-11-06T12:00:00.000Z');
  assert.equal(updateOf(r).reminderSentAt, null, 'the old reminder named the old time');
  assert.equal(r.calls.find((c) => /JOIN performers pf ON pf.id = a.performer_id/.test(c.text)).params[4], APPT, 'its own slot never clashes with itself');
});

test('changing only the notes keeps the reminder, and asks no clash question', async () => {
  const r = await run(fakeDb({ ...locked(), clash: () => { throw new Error('must not ask'); } }), () => service.update(staff, APPT, { notes: 'Bring photo' }));
  assert.equal(r.error, null);
  assert.deepEqual([updateOf(r).notes, updateOf(r).reminderSentAt, updateOf(r).startsAt], ['Bring photo', '2026-11-05T08:00:00.000Z', '2026-11-06T10:00:00.000Z']);
});

test('giving it to someone else is checked, refused when they are busy, and allowed when the screen says book anyway', async () => {
  const busy = () => ({ rows: [{ customer_name: 'Divya', starts_at: '2026-11-06T10:15:00.000Z', duration_min: 30, timezone: 'Asia/Kolkata', performer_name: 'Asha' }] });
  const refused = await run(fakeDb({ ...locked(), clash: busy }), () => service.update(staff, APPT, { performerId: OTHER_PERSON }));
  assert.equal(refused.error.code, 'SLOT_TAKEN');
  assert.equal(refused.wroteAnything, false);
  const forced = await run(fakeDb({ ...locked(), clash: busy }), () => service.update(staff, APPT, { performerId: OTHER_PERSON, allowOverlap: true }));
  assert.equal(forced.error, null);
  assert.equal(updateOf(forced).performerId, OTHER_PERSON);
});

test('taking the person off, or choosing one who is not this parlour\'s', async () => {
  const off = await run(fakeDb(locked()), () => service.update(staff, APPT, { performerId: null }));
  assert.equal(updateOf(off).performerId, null);
  const stranger = await run(fakeDb({ ...locked(), performer: () => ({ rows: [] }) }), () => service.update(staff, APPT, { performerId: OTHER_PERSON }));
  assert.equal(stranger.error.code, 'PERFORMER_UNAVAILABLE');
  assert.equal(stranger.wroteAnything, false);
});

test('new services replace the old ones and set the length, unless a length is typed', async () => {
  const a = await run(fakeDb(locked()), () => service.update(staff, APPT, { items: [{ serviceId: SVC_MASSAGE, quantity: 2 }] }));
  assert.equal(updateOf(a).durationMin, 90);
  assert.equal(a.wrote(/DELETE FROM appointment_services/).length, 1, 'the old lines are replaced, not added to');
  assert.equal(a.wrote(/INSERT INTO appointment_services/).length, 1);
  const b = await run(fakeDb(locked()), () => service.update(staff, APPT, { items: [{ serviceId: SVC_MASSAGE, quantity: 2 }], durationMin: 75 }));
  assert.equal(updateOf(b).durationMin, 75);
  const c = await run(fakeDb(locked()), () => service.update(staff, APPT, { notes: 'x' }));
  assert.equal(c.wrote(/DELETE FROM appointment_services/).length, 0, 'the services are left alone when not sent');
});

test('a walk-in has no booked time to move, and a visit that has started cannot be moved', async () => {
  const walk = await run(fakeDb(locked({ kind: 'walk_in', status: 'waiting', performer_id: null })), () => service.update(staff, APPT, { date: '2026-11-06', time: '17:30' }));
  assert.equal(walk.error.code, 'NOT_A_BOOKING');
  const started = await run(fakeDb(locked({ status: 'in_service' })), () => service.update(staff, APPT, { date: '2026-11-06', time: '17:30' }));
  assert.equal(started.error.code, 'ALREADY_STARTED');
  assert.equal(started.wroteAnything, false);
});

test('linking a saved customer takes their name and number; detaching keeps what was written', async () => {
  const link = await run(fakeDb(locked()), () => service.update(staff, APPT, { customerId: CUSTOMER }));
  assert.deepEqual([updateOf(link).customerId, updateOf(link).name, updateOf(link).phone], [CUSTOMER, 'Ananya Iyer', '9840012345']);
  const detach = await run(fakeDb(locked({ customer_id: CUSTOMER })), () => service.update(staff, APPT, { customerId: null }));
  assert.deepEqual([updateOf(detach).customerId, updateOf(detach).name, updateOf(detach).phone], [null, 'Priya Das', '9840011111']);
});

// ── Starting, cancelling, no-shows ────────────────────────────────────────────────────

test('start: the visit moves to in service at the database clock, and a walk-in is given the person who will do it', async () => {
  const r = await run(fakeDb(locked({ kind: 'walk_in', status: 'waiting', performer_id: null })), () => service.start(staff, APPT, { performerId: PERSON, allowOverlap: false }));
  assert.equal(r.error, null);
  const update = r.wrote(/UPDATE appointments SET status = 'in_service'/)[0];
  assert.match(update.text, /starts_at = now\(\)/);
  assert.deepEqual(update.params, [APPT, 'parlour-A', PERSON]);
  assert.deepEqual(r.calls.find((c) => /JOIN performers pf ON pf.id = a.performer_id/.test(c.text)).params, ['parlour-A', PERSON, NOW, 45, APPT], 'checked from now, for its length, not against itself');
});

test('start: a person who is busy right now is refused unless the screen says go ahead; one already chosen is kept', async () => {
  const busy = () => ({ rows: [{ customer_name: 'Divya', starts_at: NOW, duration_min: 30, timezone: 'Asia/Kolkata', performer_name: 'Meena' }] });
  assert.equal((await run(fakeDb({ ...locked(), clash: busy }), () => service.start(staff, APPT, { allowOverlap: false }))).error.code, 'SLOT_TAKEN');
  const forced = await run(fakeDb({ ...locked(), clash: busy }), () => service.start(staff, APPT, { allowOverlap: true }));
  assert.equal(forced.error, null);
  assert.equal(forced.wrote(/UPDATE appointments SET status = 'in_service'/)[0].params[2], PERSON, 'the person already on it is kept');
});

test('start: a closed or already started visit cannot be started', async () => {
  for (const [status, code] of [['in_service', 'APPOINTMENT_STATE'], ['completed', 'APPOINTMENT_ALREADY_BILLED'], ['cancelled', 'APPOINTMENT_CLOSED'], ['no_show', 'APPOINTMENT_CLOSED']]) {
    const r = await run(fakeDb(locked({ status })), () => service.start(staff, APPT, { allowOverlap: false }));
    assert.equal(r.error.code, code, status);
    assert.equal(r.wroteAnything, false, status);
  }
});

test('cancel: an open visit is cancelled with its reason; a billed one never is', async () => {
  const r = await run(fakeDb(locked()), () => service.cancel(staff, APPT, { reason: 'Customer called' }));
  assert.equal(r.error, null);
  assert.deepEqual(r.wrote(/UPDATE appointments SET status = 'cancelled'/)[0].params, [APPT, 'parlour-A', 'Customer called']);
  const none = await run(fakeDb(locked()), () => service.cancel(staff, APPT, {}));
  assert.equal(none.wrote(/status = 'cancelled'/)[0].params[2], null);
  for (const status of ['completed', 'cancelled', 'no_show']) {
    const closed = await run(fakeDb(locked({ status })), () => service.cancel(staff, APPT, {}));
    assert.equal(closed.error.status, 409, status);
    assert.equal(closed.wroteAnything, false, status);
  }
});

test('no-show: only a booking whose time has passed; early is refused with the advice to cancel; a walk-in cannot be one', async () => {
  const late = await run(fakeDb(locked({ starts_at: '2026-11-05T09:00:00.000Z' })), () => service.noShow(staff, APPT));
  assert.equal(late.error, null);
  assert.equal(late.wrote(/status = 'no_show'/).length, 1);
  const early = await run(fakeDb(locked({ starts_at: '2026-11-05T10:00:00.001Z' })), () => service.noShow(staff, APPT));
  assert.equal(early.error.code, 'TOO_EARLY_FOR_NO_SHOW');
  assert.match(early.error.message, /Cancel it instead/);
  assert.equal(early.wroteAnything, false);
  const walk = await run(fakeDb(locked({ kind: 'walk_in', status: 'waiting', starts_at: '2026-11-05T09:00:00.000Z' })), () => service.noShow(staff, APPT));
  assert.equal(walk.error.code, 'APPOINTMENT_STATE');
});

// ── Reading ───────────────────────────────────────────────────────────────────────────

const dbRow = (over = {}) => ({
  id: APPT, kind: 'booked', status: 'booked', local_date: '2026-11-06', local_time: '15:30', starts_at: new Date('2026-11-06T10:00:00.000Z'), duration_min: 75,
  customer_id: null, customer_name: 'Priya Das', customer_phone: '9840011111', performer_id: PERSON, performer_name: 'Meena', notes: null, cancel_reason: null,
  reminder_sent_at: null, invoice_id: null, invoice_number: null, invoice_created_by: null, created_by_name: 'Riya', created_at: NOW, ...over,
});
const readsWith = (rows, lines = []) => async (text) => (/FROM appointment_services/.test(text) ? { rows: lines } : { rows });
const lineOf = (over = {}) => ({ appointment_id: APPT, service_id: SVC_CUT, name: 'Haircut', duration_min: 30, quantity: 1, ...over });

test('a visit reads back with its date and time on the parlour\'s clock, its end, its services, and no price', async () => {
  world.pool = readsWith([dbRow()], [lineOf(), lineOf({ service_id: SVC_MASSAGE, name: 'Massage', duration_min: 45 })]);
  const a = await service.get(staff, APPT);
  assert.deepEqual([a.date, a.time, a.startsAt, a.endsAt, a.durationMin], ['2026-11-06', '15:30', '2026-11-06T10:00:00.000Z', '2026-11-06T11:15:00.000Z', 75]);
  assert.deepEqual(a.services.map((s) => [s.name, s.durationMin, s.quantity]), [['Haircut', 30, 1], ['Massage', 45, 1]]);
  assert.equal(JSON.stringify(a).includes('price'), false);
  assert.equal(a.canOpenInvoice, false);
});

test('the link to a bill is offered to an admin, and to staff only for a bill they made themselves', async () => {
  world.pool = readsWith([dbRow({ status: 'completed', invoice_id: 'inv-1', invoice_number: 'DP-00007', invoice_created_by: 'user-A' })]);
  assert.equal((await service.get(staff, APPT)).canOpenInvoice, true, 'their own bill');
  world.pool = readsWith([dbRow({ status: 'completed', invoice_id: 'inv-1', invoice_number: 'DP-00007', invoice_created_by: 'someone-else' })]);
  assert.equal((await service.get(staff, APPT)).canOpenInvoice, false, 'a colleague\'s bill, which staff cannot open');
  assert.equal((await service.get(admin, APPT)).canOpenInvoice, true);
  assert.equal((await service.get(admin, APPT)).invoiceNumber, 'DP-00007');
});

test('the day: the parlour\'s own today, the visits of that day, and how many from earlier days are still open', async () => {
  const seen = [];
  world.pool = async (text, params) => {
    seen.push({ text, params });
    if (/to_char\(now\(\) AT TIME ZONE timezone/.test(text)) return { rows: [{ timezone: 'Asia/Kolkata', today: '2026-11-05' }] };
    if (/COUNT\(\*\)::int AS count/.test(text)) return { rows: [{ count: 2, oldest: '2026-11-03' }] };
    if (/FROM appointment_services/.test(text)) return { rows: [lineOf()] };
    return { rows: [dbRow()] };
  };
  const day = await service.day(staff, { date: '2026-11-06' });
  assert.deepEqual([day.date, day.today, day.timezone, day.earlierOpen], ['2026-11-06', '2026-11-05', 'Asia/Kolkata', { count: 2, oldest: '2026-11-03' }]);
  assert.equal(day.appointments.length, 1);
  assert.deepEqual(seen.find((c) => /::date = \$2::date/.test(c.text)).params, ['parlour-A', '2026-11-06']);
  const noDate = await service.day(staff, {});
  assert.equal(noDate.date, '2026-11-05', 'no date means the parlour\'s today');
});

test('the queue lists the waiting, longest first, numbered, and flags anyone left from an earlier day', async () => {
  world.pool = async (text) => {
    if (/to_char\(now\(\) AT TIME ZONE timezone/.test(text)) return { rows: [{ timezone: 'Asia/Kolkata', today: '2026-11-05' }] };
    if (/FROM appointment_services/.test(text)) return { rows: [] };
    return { rows: [
      dbRow({ id: 'w1', kind: 'walk_in', status: 'waiting', local_date: '2026-11-04', starts_at: new Date('2026-11-04T09:00:00Z'), created_at: '2026-11-04T09:00:00Z' }),
      dbRow({ id: 'w2', kind: 'walk_in', status: 'waiting', local_date: '2026-11-05', starts_at: new Date('2026-11-05T09:30:00Z'), created_at: '2026-11-05T09:30:00Z' }),
    ] };
  };
  const { queue } = await service.queue(staff);
  assert.deepEqual(queue.map((q) => [q.id, q.position, q.fromEarlierDay]), [['w1', 1, true], ['w2', 2, false]]);
});

// ── Reminder ──────────────────────────────────────────────────────────────────────────

const parlourRow = { name: 'Demo Parlour', phone: '9840000000', timezone: 'Asia/Kolkata' };
const remindWith = (rows, lines = [lineOf()]) => async (text) => {
  if (/FROM appointment_services/.test(text)) return { rows: lines };
  if (/FROM parlours WHERE id/.test(text)) return { rows: [parlourRow] };
  return { rows };
};
const inFuture = () => new Date(Date.now() + 3 * 86_400_000);

test('the reminder is a WhatsApp link to the number on the booking, written on the server', async () => {
  world.pool = remindWith([dbRow({ starts_at: inFuture() })]);
  const r = await service.reminder(staff, APPT, {});
  assert.equal(r.phone, '919840011111');
  assert.match(r.url, /^https:\/\/wa\.me\/919840011111\?text=/);
  assert.match(r.message, /Hello Priya, this is a reminder of your appointment at \*Demo Parlour\*/);
  assert.match(r.message, /Services: Haircut/);
  assert.match(r.message, /With: Meena/);
});

test('the reminder: a number typed now replaces the saved one; no number at all asks for one', async () => {
  world.pool = remindWith([dbRow({ starts_at: inFuture() })]);
  assert.equal((await service.reminder(staff, APPT, { phone: '98400 22222' })).phone, '919840022222');
  world.pool = remindWith([dbRow({ starts_at: inFuture(), customer_phone: null })]);
  await assert.rejects(() => service.reminder(staff, APPT, {}), (e) => e.code === 'PHONE_REQUIRED');
});

test('the reminder: only a booked visit that is still to come can be reminded', async () => {
  for (const over of [{ status: 'completed' }, { status: 'cancelled' }, { status: 'in_service' }, { kind: 'walk_in', status: 'waiting' }, { starts_at: new Date(Date.now() - 60_000) }]) {
    world.pool = remindWith([dbRow({ starts_at: inFuture(), ...over })]);
    await assert.rejects(() => service.reminder(staff, APPT, {}), (e) => e.code === 'NOT_REMINDABLE', JSON.stringify(over));
  }
});

test('marking as reminded records the time, only for a booked visit of this parlour', async () => {
  const seen = [];
  world.pool = async (text, params) => { seen.push({ text, params }); return /^\s*UPDATE/.test(text) ? { rowCount: 1, rows: [] } : /FROM appointment_services/.test(text) ? { rows: [] } : { rows: [dbRow({ reminder_sent_at: NOW })] }; };
  const a = await service.markReminded(staff, APPT);
  assert.equal(a.reminderSentAt, NOW);
  const update = seen.find((c) => /^\s*UPDATE/.test(c.text));
  assert.match(update.text, /status = 'booked'/);
  assert.deepEqual(update.params, [APPT, 'parlour-A']);
  world.pool = async (text) => (/^\s*UPDATE/.test(text) ? { rowCount: 0, rows: [] } : /FROM appointment_services/.test(text) ? { rows: [] } : { rows: [dbRow({ status: 'cancelled' })] });
  await assert.rejects(() => service.markReminded(staff, APPT), (e) => e.code === 'NOT_REMINDABLE');
});

// ── Billing a visit ───────────────────────────────────────────────────────────────────

/** A scripted transaction for one bill, the same shape as the one in payments.service.test.js, plus the appointment lock. */
function billDb({ appointment = { id: APPT, status: 'booked' } } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM appointments WHERE id = \$1 AND parlour_id = \$2 FOR UPDATE/.test(text)) return { rows: appointment ? [appointment] : [] };
      if (/FROM services WHERE/.test(text)) return { rows: params[1].map((id) => MENU[id]) };
      if (/UPDATE parlours SET invoice_seq/.test(text)) return { rows: [{ invoice_prefix: 'DP', invoice_seq: 7, tax_percent: '5.00', gst_price_mode: 'exclusive', gst_number: '33ABCDE1234F1Z5' }] };
      if (/INSERT INTO invoices/.test(text)) return { rows: [{ id: 'new-invoice-id' }] };
      if (/INSERT INTO invoice_items|INSERT INTO invoice_payments|UPDATE appointments SET status = 'completed'/.test(text)) return { rows: [] };
      throw new Error(`unexpected query in the transaction: ${text.slice(0, 80)}`);
    },
  };
}
async function bill(db, extra = {}) {
  world.runTransaction = (fn) => fn(db);
  const real = invoices.getWith;
  invoices.getWith = async () => ({ ok: true });
  let error = null;
  try { await invoices.create(staff, { discount: 0, items: [{ serviceId: SVC_CUT, quantity: 1 }], paymentMethod: 'cash', ...extra }); } catch (err) { error = err; } finally { invoices.getWith = real; }
  return { error, calls: db.calls, wrote: (re) => db.calls.filter((c) => re.test(c.text)), wroteAnything: db.calls.some((c) => /^\s*(INSERT|UPDATE)/.test(c.text)) };
}

test('billing a visit: the visit is locked before the bill counter, the bill is saved, then the visit is completed and points at the bill', async () => {
  const r = await bill(billDb(), { appointmentId: APPT });
  assert.equal(r.error, null);
  const order = r.calls.map((c) => (/FROM appointments WHERE id/.test(c.text) ? 'lock-visit' : /UPDATE parlours SET invoice_seq/.test(c.text) ? 'counter' : /INSERT INTO invoices/.test(c.text) ? 'bill' : /UPDATE appointments SET status = 'completed'/.test(c.text) ? 'complete' : null)).filter(Boolean);
  assert.deepEqual(order, ['lock-visit', 'counter', 'bill', 'complete']);
  assert.deepEqual(r.wrote(/FROM appointments WHERE id/)[0].params, [APPT, 'parlour-A'], 'looked up inside the parlour in the token');
  assert.deepEqual(r.wrote(/UPDATE appointments SET status = 'completed'/)[0].params, [APPT, 'parlour-A', 'new-invoice-id']);
});

test('billing a visit that is not there, or is another parlour\'s: refused, no bill number used, nothing saved', async () => {
  const r = await bill(billDb({ appointment: null }), { appointmentId: APPT });
  assert.equal(r.error.code, 'APPOINTMENT_NOT_FOUND');
  assert.equal(r.error.status, 400);
  assert.equal(r.wroteAnything, false);
  assert.ok(!r.calls.some((c) => /UPDATE parlours/.test(c.text)), 'the invoice number was not even taken');
});

test('billing a visit twice: the second is refused, and a cancelled or no-show visit cannot be billed at all', async () => {
  const again = await bill(billDb({ appointment: { id: APPT, status: 'completed' } }), { appointmentId: APPT });
  assert.equal(again.error.code, 'APPOINTMENT_ALREADY_BILLED');
  assert.equal(again.error.status, 409);
  assert.equal(again.wroteAnything, false);
  for (const status of ['cancelled', 'no_show']) {
    const r = await bill(billDb({ appointment: { id: APPT, status } }), { appointmentId: APPT });
    assert.equal(r.error.code, 'APPOINTMENT_CLOSED', status);
    assert.equal(r.wroteAnything, false, status);
  }
});

test('billing a visit works from booked, waiting and in service', async () => {
  for (const status of ['booked', 'waiting', 'in_service']) assert.equal((await bill(billDb({ appointment: { id: APPT, status } }), { appointmentId: APPT })).error, null, status);
});

test('a bill with no appointment makes no appointment queries at all, exactly as before', async () => {
  const r = await bill(billDb());
  assert.equal(r.error, null);
  assert.ok(!r.calls.some((c) => /appointments/.test(c.text)));
});

// ── Performers ────────────────────────────────────────────────────────────────────────

test('a person with open appointments cannot be deleted; one with none can', async () => {
  const del = (open) => ({
    query: async (text) => {
      if (/FROM performers WHERE id/.test(text)) return { rows: [{ id: PERSON }] };
      if (/FROM invoice_items/.test(text)) return { rows: [{ lines: 0 }] };
      if (/FROM appointments WHERE performer_id/.test(text)) return { rows: [{ open }] };
      if (/FROM performer_attendance_records WHERE performer_id/.test(text)) return { rows: [{ days: 0 }] };
      if (/DELETE FROM performers/.test(text)) return { rows: [] };
      throw new Error(`unexpected: ${text.slice(0, 80)}`);
    },
  });
  world.runTransaction = (fn) => fn(del(2));
  await assert.rejects(() => performers.remove('parlour-A', PERSON), (e) => e.status === 409 && e.code === 'PERFORMER_HAS_APPOINTMENTS');
  world.runTransaction = (fn) => fn(del(0));
  await performers.remove('parlour-A', PERSON);
});
