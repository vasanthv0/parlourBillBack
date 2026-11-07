// The appointments SQL, run for real in PostgreSQL. Needs the database from your .env (run `npm run db:init` once);
// it does NOT need the API running.      npm run test:db
//
// The services commit their own transactions, so this test cannot roll everything back. Instead it makes its own parlours
// (named "Appt Test ...") and deletes them at the end, which removes everything they own. Nothing else is touched.
const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, query } = require('../src/config/db');
const appointments = require('../src/modules/appointments/appointments.service');
const invoices = require('../src/modules/invoices/invoices.service');
const performers = require('../src/modules/performers/performers.service');

const made = [];
test.after(async () => {
  if (made.length) await pool.query(`DELETE FROM parlours WHERE id = ANY($1::uuid[])`, [made]);
  await pool.end();
});

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

async function makeParlour(label) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const { rows: [p] } = await query(`INSERT INTO parlours (name, phone) VALUES ($1, '9840012345') RETURNING id`, [`Appt Test ${label} ${stamp}`]);
  made.push(p.id);
  const add = async (sql, params) => (await query(sql, params)).rows[0];
  const cut = await add(`INSERT INTO services (parlour_id, name, price, duration_min) VALUES ($1, 'Haircut', 200, 30) RETURNING id`, [p.id]);
  const massage = await add(`INSERT INTO services (parlour_id, name, price, duration_min) VALUES ($1, 'Massage', 1000, 45) RETURNING id`, [p.id]);
  const asha = await add(`INSERT INTO performers (parlour_id, name) VALUES ($1, 'Asha') RETURNING id`, [p.id]);
  const ravi = await add(`INSERT INTO performers (parlour_id, name) VALUES ($1, 'Ravi') RETURNING id`, [p.id]);
  const customer = await add(`INSERT INTO customers (parlour_id, name, phone) VALUES ($1, 'Priya', '98400 54321') RETURNING id`, [p.id]);
  return { parlourId: p.id, auth: { userId: null, parlourId: p.id, role: 'admin' }, cut: cut.id, massage: massage.id, asha: asha.id, ravi: ravi.id, customerId: customer.id };
}

/** A date on the parlour's own calendar, `days` from today. */
const dateIn = async (days) => (await query(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata') + make_interval(days => $1::int), 'YYYY-MM-DD') AS d`, [days])).rows[0].d;
const book = (p, over = {}) => appointments.create(p.auth, {
  kind: 'booked', customerName: 'Meena', performerId: p.asha, items: [{ serviceId: p.cut, quantity: 1 }], allowOverlap: false, ...over,
});
const bill = (auth, extra = {}, serviceId) => invoices.create(auth, { discount: 0, items: [{ serviceId, quantity: 1 }], paymentMethod: 'cash', ...extra });
const seq = async (parlourId) => (await query(`SELECT invoice_seq FROM parlours WHERE id = $1`, [parlourId])).rows[0].invoice_seq;
const invoiceCount = async (parlourId) => (await query(`SELECT COUNT(*)::int AS n FROM invoices WHERE parlour_id = $1`, [parlourId])).rows[0].n;
const code = (c) => (e) => e.code === c;

test('a booking is saved with its services, takes its length from them, and shows on the parlour\'s own calendar day', async () => {
  const p = await makeParlour('book');
  const date = await dateIn(1);
  const a = await book(p, { date, time: '10:30', items: [{ serviceId: p.cut, quantity: 2 }, { serviceId: p.massage, quantity: 1 }, { serviceId: p.cut, quantity: 1 }] });
  assert.equal(a.status, 'booked');
  assert.equal(a.durationMin, 30 * 3 + 45, 'the repeated haircut is merged: 3 x 30 + 45 minutes');
  assert.deepEqual(a.services.map((s) => [s.name, s.quantity]), [['Haircut', 3], ['Massage', 1]]);
  assert.equal([a.date, a.time].join(' '), `${date} 10:30`, 'read back on the parlour\'s wall clock, not the server\'s');
  const day = await appointments.day(p.auth, { date });
  assert.deepEqual(day.appointments.map((x) => x.id), [a.id]);
  assert.equal((await appointments.day(p.auth, { date: await dateIn(2) })).appointments.length, 0);
});

test('a saved customer fills in the name and number; a typed name works without one', async () => {
  const p = await makeParlour('customer');
  const a = await book(p, { date: await dateIn(1), time: '09:00', customerId: p.customerId, customerName: undefined });
  assert.deepEqual([a.customerName, a.customerPhone, a.customerId], ['Priya', '98400 54321', p.customerId]);
  await assert.rejects(async () => book(p, { date: await dateIn(1), time: '12:00', customerId: '00000000-0000-4000-8000-000000000000' }), code('CUSTOMER_NOT_FOUND'));
});

test('one person cannot be double-booked; back-to-back is fine; allowOverlap is the person\'s own decision', async () => {
  const p = await makeParlour('clash');
  const date = await dateIn(1);
  await book(p, { date, time: '10:00' });                                                // 10:00 to 10:30
  await assert.rejects(() => book(p, { date, time: '10:15' }), code('SLOT_TAKEN'));       // overlaps its second half
  await assert.rejects(() => book(p, { date, time: '09:45' }), code('SLOT_TAKEN'));       // overlaps its first half
  await book(p, { date, time: '10:30' });                                                // starts exactly when it ends
  await book(p, { date, time: '09:30' });                                                // ends exactly when it starts
  await book(p, { date, time: '10:15', performerId: p.ravi });                           // somebody else is free
  await book(p, { date, time: '10:15', allowOverlap: true });                            // chosen on purpose
  const day = await appointments.day(p.auth, { date });
  assert.equal(day.appointments.length, 5);
});

test('two people booking the same slot at the same moment: exactly one gets it', async () => {
  const p = await makeParlour('race');
  const date = await dateIn(1);
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => book(p, { date, time: '15:00' })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'SLOT_TAKEN');
});

test('the walk-in queue: arrival order, place in line, and it never clashes until it starts', async () => {
  const p = await makeParlour('queue');
  const w = (name) => appointments.create(p.auth, { kind: 'walk_in', customerName: name, performerId: p.asha, items: [{ serviceId: p.cut, quantity: 1 }], allowOverlap: false });
  const one = await w('First'); const two = await w('Second'); const three = await w('Third');
  assert.deepEqual([one.status, one.kind], ['waiting', 'walk_in']);
  const { queue } = await appointments.queue(p.auth);
  assert.deepEqual(queue.map((q) => [q.customerName, q.position]), [['First', 1], ['Second', 2], ['Third', 3]]);

  const started = await appointments.start(p.auth, one.id, { allowOverlap: false });
  assert.equal(started.status, 'in_service');
  assert.deepEqual((await appointments.queue(p.auth)).queue.map((q) => [q.customerName, q.position]), [['Second', 1], ['Third', 2]], 'everyone moves up');
  await assert.rejects(() => appointments.start(p.auth, two.id, { allowOverlap: false }), code('SLOT_TAKEN'), 'Asha is busy with the first walk-in');
  const other = await appointments.start(p.auth, two.id, { performerId: p.ravi, allowOverlap: false });
  assert.equal(other.performerName, 'Ravi');
  await assert.rejects(() => appointments.start(p.auth, two.id, { allowOverlap: false }), code('APPOINTMENT_STATE'), 'already started');
});

test('cancel, no-show and moving follow the rules', async () => {
  const p = await makeParlour('rules');
  const future = await book(p, { date: await dateIn(2), time: '11:00' });
  await assert.rejects(() => appointments.noShow(p.auth, future.id), code('TOO_EARLY_FOR_NO_SHOW'));
  const moved = await appointments.update(p.auth, future.id, { date: await dateIn(2), time: '12:00' });
  assert.equal(moved.time, '12:00');
  const cancelled = await appointments.cancel(p.auth, future.id, { reason: 'Customer called' });
  assert.deepEqual([cancelled.status, cancelled.cancelReason], ['cancelled', 'Customer called']);
  await assert.rejects(() => appointments.cancel(p.auth, future.id, {}), code('APPOINTMENT_CLOSED'));
  await assert.rejects(() => appointments.update(p.auth, future.id, { notes: 'x' }), code('APPOINTMENT_CLOSED'));

  const wasToday = await query(`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d, to_char((now() - interval '2 hours') AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS t, to_char((now() - interval '2 hours') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d2`);
  const { d2, t } = wasToday.rows[0];
  const past = await book(p, { date: d2, time: t });
  const missed = await appointments.noShow(p.auth, past.id);
  assert.equal(missed.status, 'no_show');
  const tooOld = await dateIn(-3);
  await assert.rejects(() => book(p, { date: tooOld, time: '10:00' }), code('TIME_TOO_EARLY'));
});

test('billing a visit: it is completed, points at its bill, and is priced on the day by the server in paise', async () => {
  const p = await makeParlour('bill');
  const a = await book(p, { date: await dateIn(1), time: '10:00', customerId: p.customerId, customerName: undefined });
  const before = await seq(p.parlourId);
  const { invoice } = await bill(p.auth, { appointmentId: a.id, customerId: p.customerId }, p.massage);
  const after = await appointments.get(p.auth, a.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.invoiceId, invoice.id);
  assert.equal(after.invoiceNumber, invoice.number);
  assert.equal(await seq(p.parlourId), before + 1);
  assert.equal(await invoiceCount(p.parlourId), 1);
  // A billed visit is a record: it cannot be changed, cancelled, started or billed again.
  await assert.rejects(() => appointments.cancel(p.auth, a.id, {}), code('APPOINTMENT_ALREADY_BILLED'));
  await assert.rejects(() => appointments.update(p.auth, a.id, { notes: 'x' }), code('APPOINTMENT_ALREADY_BILLED'));
  await assert.rejects(() => bill(p.auth, { appointmentId: a.id }, p.cut), code('APPOINTMENT_ALREADY_BILLED'));
  assert.equal(await invoiceCount(p.parlourId), 1, 'no second bill');
  assert.equal(await seq(p.parlourId), before + 1, 'and no bill number used up');
});

test('the same visit billed twice at once: one bill, one refusal', async () => {
  const p = await makeParlour('billrace');
  const a = await book(p, { date: await dateIn(1), time: '10:00' });
  const results = await Promise.allSettled([1, 2, 3].map(() => bill(p.auth, { appointmentId: a.id }, p.cut)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'APPOINTMENT_ALREADY_BILLED');
  assert.equal(await invoiceCount(p.parlourId), 1);
});

test('a cancelled or no-show visit cannot be billed, and a plain bill needs no visit at all', async () => {
  const p = await makeParlour('closed');
  const a = await book(p, { date: await dateIn(1), time: '10:00' });
  await appointments.cancel(p.auth, a.id, {});
  const before = await seq(p.parlourId);
  await assert.rejects(() => bill(p.auth, { appointmentId: a.id }, p.cut), code('APPOINTMENT_CLOSED'));
  assert.equal(await seq(p.parlourId), before);
  const { invoice } = await bill(p.auth, {}, p.cut);
  assert.ok(invoice.id);
});

test('TENANT ISOLATION: another parlour can never see, change, start, cancel, remind or bill your visits', async () => {
  const a = await makeParlour('A');
  const b = await makeParlour('B');
  const date = await dateIn(1);
  const mine = await book(a, { date, time: '10:00', customerName: 'Secret Customer' });
  const waiting = await appointments.create(a.auth, { kind: 'walk_in', customerName: 'Secret Walkin', items: [{ serviceId: a.cut, quantity: 1 }], allowOverlap: false });

  assert.equal((await appointments.day(b.auth, { date })).appointments.length, 0);
  assert.equal((await appointments.queue(b.auth)).queue.length, 0);
  for (const [name, fn] of [
    ['get', () => appointments.get(b.auth, mine.id)],
    ['update', () => appointments.update(b.auth, mine.id, { notes: 'hijack' })],
    ['start', () => appointments.start(b.auth, waiting.id, { allowOverlap: false })],
    ['cancel', () => appointments.cancel(b.auth, mine.id, {})],
    ['noShow', () => appointments.noShow(b.auth, mine.id)],
    ['reminder', () => appointments.reminder(b.auth, mine.id, {})],
    ['markReminded', () => appointments.markReminded(b.auth, mine.id)],
  ]) await assert.rejects(fn, (e) => e.status === 404, name);

  // Billing A's visit from B: not found, no bill, no invoice number used in either parlour.
  const [seqA, seqB] = [await seq(a.parlourId), await seq(b.parlourId)];
  await assert.rejects(() => bill(b.auth, { appointmentId: mine.id }, b.cut), code('APPOINTMENT_NOT_FOUND'));
  assert.deepEqual([await seq(a.parlourId), await seq(b.parlourId)], [seqA, seqB]);
  assert.deepEqual([await invoiceCount(a.parlourId), await invoiceCount(b.parlourId)], [0, 0]);

  // B cannot book A's people, services or customers either.
  await assert.rejects(() => book(b, { date, time: '10:00', performerId: a.asha }), code('PERFORMER_UNAVAILABLE'));
  await assert.rejects(() => book(b, { date, time: '10:00', items: [{ serviceId: a.cut, quantity: 1 }] }), code('SERVICE_UNAVAILABLE'));
  await assert.rejects(() => book(b, { date, time: '10:00', customerId: a.customerId, customerName: undefined }), code('CUSTOMER_NOT_FOUND'));
  // Same time, same names in two parlours do not clash with each other.
  await book(b, { date, time: '10:00' });

  const untouched = await appointments.get(a.auth, mine.id);
  assert.deepEqual([untouched.status, untouched.notes], ['booked', null]);
});

test('a person with unfinished visits cannot be deleted; once they are closed the person can be', async () => {
  const p = await makeParlour('perf');
  const a = await book(p, { date: await dateIn(1), time: '10:00' });
  await assert.rejects(() => performers.remove(p.parlourId, p.asha), code('PERFORMER_HAS_APPOINTMENTS'));
  await appointments.cancel(p.auth, a.id, {});
  await performers.remove(p.parlourId, p.asha);
  const kept = await appointments.get(p.auth, a.id);
  assert.equal(kept.performerId, null, 'the cancelled visit stays on record, with nobody named');
});

test('the reminder is a WhatsApp link for a booked visit still to come, and opening it is recorded', async () => {
  const p = await makeParlour('remind');
  const a = await book(p, { date: await dateIn(1), time: '16:00', customerId: p.customerId, customerName: undefined });
  const r = await appointments.reminder(p.auth, a.id, {});
  assert.match(r.url, /^https:\/\/wa\.me\/919840054321\?text=/);
  assert.match(decodeURIComponent(r.url), /Hello Priya, this is a reminder of your appointment at \*Appt Test remind/);
  assert.equal((await appointments.get(p.auth, a.id)).reminderSentAt, null, 'building the link sends and records nothing');
  assert.ok((await appointments.markReminded(p.auth, a.id)).reminderSentAt);
  // Moving the visit makes the old reminder out of date.
  assert.equal((await appointments.update(p.auth, a.id, { date: await dateIn(1), time: '17:00' })).reminderSentAt, null);
  await appointments.cancel(p.auth, a.id, {});
  await assert.rejects(() => appointments.reminder(p.auth, a.id, {}), code('NOT_REMINDABLE'));
});

test('earlier days left open are counted, so a visit nobody closed cannot be forgotten', async () => {
  const p = await makeParlour('earlier');
  const walkIn = await appointments.create(p.auth, { kind: 'walk_in', customerName: 'Old', items: [{ serviceId: p.cut, quantity: 1 }], allowOverlap: false });
  await query(`UPDATE appointments SET starts_at = now() - interval '2 days' WHERE id = $1`, [walkIn.id]);
  const day = await appointments.day(p.auth, {});
  assert.equal(day.earlierOpen.count, 1);
  const { queue } = await appointments.queue(p.auth);
  assert.deepEqual([queue[0].id, queue[0].fromEarlierDay], [walkIn.id, true]);
});

test('the table itself refuses impossible rows', async () => {
  const p = await makeParlour('table');
  const insert = (cols) => {
    const row = { parlour_id: p.parlourId, kind: 'booked', status: 'booked', customer_name: 'X', starts_at: new Date().toISOString(), duration_min: 30, ...cols };
    const keys = Object.keys(row);
    return pool.query(`INSERT INTO appointments (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  };
  await insert({});
  for (const bad of [{ status: 'sleeping' }, { kind: 'online' }, { duration_min: 4 }, { duration_min: 601 }, { kind: 'walk_in', status: 'booked' }, { kind: 'walk_in', status: 'no_show' }, { kind: 'booked', status: 'waiting' }]) {
    await assert.rejects(() => insert(bad), (e) => e.code === CHECK_VIOLATION, JSON.stringify(bad));
  }
  const a = await book(p, { date: await dateIn(1), time: '08:00' });
  const { invoice } = await bill(p.auth, { appointmentId: a.id }, p.cut);
  await assert.rejects(() => insert({ status: 'completed', invoice_id: invoice.id }), (e) => e.code === UNIQUE_VIOLATION, 'a bill closes one visit at most');
  await assert.rejects(() => insert({ status: 'booked', invoice_id: invoice.id }), (e) => e.code === CHECK_VIOLATION, 'only a completed visit points at a bill');
});

test('removing a customer, a person or a service keeps the visit and its written-down names', async () => {
  const p = await makeParlour('keep');
  const a = await book(p, { date: await dateIn(1), time: '10:00', customerId: p.customerId, customerName: undefined });
  await query(`DELETE FROM customers WHERE id = $1`, [p.customerId]);
  await query(`DELETE FROM services WHERE id = $1`, [p.cut]);
  const kept = await appointments.get(p.auth, a.id);
  assert.deepEqual([kept.customerId, kept.customerName, kept.services[0].name, kept.services[0].serviceId], [null, 'Priya', 'Haircut', null]);
});
