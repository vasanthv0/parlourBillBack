// Attendance by Staff, run for real in PostgreSQL. Needs the database from your .env (run `npm run db:init` once);
// it does NOT need the API running.      npm run test:db
//
// The services commit their own transactions, so this test cannot roll everything back. Instead it makes its own parlours
// (named "PerfAtt Test ...") and deletes them at the end, which removes everything they own. Nothing else is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { pool, query } = require('../src/config/db');
const service = require('../src/modules/performerAttendance/performerAttendance.service');
const performers = require('../src/modules/performers/performers.service');

const made = [];
test.after(async () => {
  if (made.length) await pool.query(`DELETE FROM parlours WHERE id = ANY($1::uuid[])`, [made]);
  await pool.end();
});

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
let seq = 0;
const stamp = () => `${Date.now()}${seq++}${Math.floor(Math.random() * 1e6)}`;
const one = async (sql, params) => (await query(sql, params)).rows[0];
const code = (c) => (e) => e.code === c;

async function makeUser(parlourId, name, role = 'staff') {
  const u = await one(
    `INSERT INTO users (parlour_id, name, email, password_hash, role) VALUES ($1, $2, $3, 'not-a-real-hash', $4) RETURNING id`,
    [parlourId, name, `${name.toLowerCase()}${stamp()}@perfatt.test`, role]
  );
  return { id: u.id, auth: { userId: u.id, parlourId, role } };
}

async function makeParlour(label, timezone = 'Asia/Kolkata') {
  const p = await one(`INSERT INTO parlours (name, phone, timezone) VALUES ($1, '9840012345', $2) RETURNING id`, [`PerfAtt Test ${label} ${stamp()}`, timezone]);
  made.push(p.id);
  const riya = await makeUser(p.id, 'Riya');
  const farah = await makeUser(p.id, 'Farah');
  const owner = await makeUser(p.id, 'Owner', 'admin');
  const priya = await one(`INSERT INTO performers (parlour_id, name) VALUES ($1, 'Priya') RETURNING id`, [p.id]);
  const divya = await one(`INSERT INTO performers (parlour_id, name) VALUES ($1, 'Divya') RETURNING id`, [p.id]);
  const old = await one(`INSERT INTO performers (parlour_id, name, is_active) VALUES ($1, 'Old Hand', false) RETURNING id`, [p.id]);
  return { parlourId: p.id, timezone, riya, farah, owner, priya: priya.id, divya: divya.id, old: old.id };
}
const localToday = async (tz) => (await one(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [tz])).d;
const rowsOf = async (parlourId) => (await query(`SELECT * FROM performer_attendance_records WHERE parlour_id = $1 ORDER BY created_at`, [parlourId])).rows;

// ───────────── the migration ─────────────

test('the schema can be run again and again: no error, no change to rows already there', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const p = await makeParlour('migrate');
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  const before = await rowsOf(p.parlourId);
  await pool.query(sql);
  await pool.query(sql);
  const after = await rowsOf(p.parlourId);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0], before[0], 'the saved record is exactly as it was');
  const { rows } = await query(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'performer_attendance_records'`);
  assert.ok(rows[0].n >= 5, 'its indexes exist (once each)');
});

test('the table has what the design needs: keys, the one-per-day rule, and indexes for date and performer lookups', async () => {
  const cols = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'performer_attendance_records'`)).rows.map((r) => r.column_name);
  for (const c of ['id', 'parlour_id', 'performer_id', 'work_date', 'check_in_at', 'check_out_at', 'marked_by_user_id', 'check_out_marked_by_user_id', 'created_at', 'updated_at']) assert.ok(cols.includes(c), c);
  const idx = (await query(`SELECT indexname FROM pg_indexes WHERE tablename = 'performer_attendance_records'`)).rows.map((r) => r.indexname);
  for (const i of ['performer_attendance_parlour_date_idx', 'performer_attendance_performer_date_idx', 'performer_attendance_one_per_day']) assert.ok(idx.includes(i), i);
});

// ───────────── the workflow, for real ─────────────

test('check-in then check-out: one row, the right people recorded, times from the database clock', async () => {
  const p = await makeParlour('flow');
  const inn = await service.checkIn(p.riya.auth, { performerId: p.priya });
  assert.equal(inn.performer.status, 'checked_in');
  assert.equal(inn.workDate, await localToday(p.timezone));
  const out = await service.checkOut(p.farah.auth, { performerId: p.priya });
  assert.equal(out.performer.status, 'checked_out');

  const rows = await rowsOf(p.parlourId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].performer_id, p.priya);
  assert.equal(rows[0].marked_by_user_id, p.riya.id, 'Riya recorded the check-in');
  assert.equal(rows[0].check_out_marked_by_user_id, p.farah.id, 'Farah recorded the check-out');
  assert.ok(rows[0].check_out_at >= rows[0].check_in_at);
  assert.ok(rows[0].updated_at >= rows[0].created_at);
});

test('the rules: duplicate check-in, check-out without check-in, duplicate check-out, inactive performer', async () => {
  const p = await makeParlour('rules');
  await assert.rejects(service.checkOut(p.riya.auth, { performerId: p.priya }), code('NOT_CHECKED_IN'));
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  await assert.rejects(service.checkIn(p.farah.auth, { performerId: p.priya }), code('ALREADY_CHECKED_IN'));
  await service.checkOut(p.riya.auth, { performerId: p.priya });
  await assert.rejects(service.checkOut(p.farah.auth, { performerId: p.priya }), code('ALREADY_CHECKED_OUT'));
  await assert.rejects(service.checkIn(p.farah.auth, { performerId: p.priya }), code('ATTENDANCE_COMPLETE'));
  await assert.rejects(service.checkIn(p.riya.auth, { performerId: p.old }), code('PERFORMER_INACTIVE'));
  assert.equal((await rowsOf(p.parlourId)).length, 1, 'only the one valid record exists');
});

test('many simultaneous check-ins for one performer: exactly one wins, the rest are refused, one row', async () => {
  const p = await makeParlour('race-in');
  const people = [p.riya.auth, p.farah.auth, p.owner.auth, p.riya.auth, p.farah.auth, p.owner.auth];
  const results = await Promise.allSettled(people.map((a) => service.checkIn(a, { performerId: p.priya })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.ok(['ALREADY_CHECKED_IN', 'ATTENDANCE_COMPLETE'].includes(r.reason.code), String(r.reason.code ?? r.reason));
  assert.equal((await rowsOf(p.parlourId)).length, 1);
});

test('many simultaneous check-outs: exactly one wins and its recorder is kept', async () => {
  const p = await makeParlour('race-out');
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  const people = [p.riya.auth, p.farah.auth, p.owner.auth, p.farah.auth];
  const results = await Promise.allSettled(people.map((a) => service.checkOut(a, { performerId: p.priya })));
  const won = results.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'ALREADY_CHECKED_OUT');
  const [row] = await rowsOf(p.parlourId);
  assert.equal(row.check_out_marked_by_user_id, won[0].value.performer.record.checkOutMarkedBy.id);
});

test("another parlour's performer: not found for the service, and refused by the database even when the service is bypassed", async () => {
  const a = await makeParlour('tenant-a');
  const b = await makeParlour('tenant-b');
  await assert.rejects(service.checkIn(a.riya.auth, { performerId: b.priya }), code('PERFORMER_NOT_FOUND'));
  await assert.rejects(service.checkOut(a.riya.auth, { performerId: b.priya }), code('PERFORMER_NOT_FOUND'));
  assert.equal((await rowsOf(a.parlourId)).length + (await rowsOf(b.parlourId)).length, 0);

  // Straight SQL, skipping every check in the API: a performer or a user from another parlour is still refused (23503).
  await assert.rejects(query(`INSERT INTO performer_attendance_records (parlour_id, performer_id, work_date, marked_by_user_id) VALUES ($1, $2, current_date, $3)`,
    [a.parlourId, b.priya, a.riya.id]), code(FK_VIOLATION), "a performer of another parlour");
  await assert.rejects(query(`INSERT INTO performer_attendance_records (parlour_id, performer_id, work_date, marked_by_user_id) VALUES ($1, $2, current_date, $3)`,
    [a.parlourId, a.priya, b.riya.id]), code(FK_VIOLATION), "a recorder from another parlour");
});

test('the database itself refuses a second row for the same performer and day, and a check-out with no recorder or before the check-in', async () => {
  const p = await makeParlour('constraints');
  const ins = () => query(`INSERT INTO performer_attendance_records (parlour_id, performer_id, work_date, marked_by_user_id) VALUES ($1, $2, '2026-01-05', $3)`, [p.parlourId, p.priya, p.riya.id]);
  await ins();
  await assert.rejects(ins(), code(UNIQUE_VIOLATION));
  await assert.rejects(query(`UPDATE performer_attendance_records SET check_out_at = now() WHERE parlour_id = $1`, [p.parlourId]), code(CHECK_VIOLATION), 'a check-out needs its recorder');
  await assert.rejects(query(`UPDATE performer_attendance_records SET check_out_at = check_in_at - interval '1 minute', check_out_marked_by_user_id = $2 WHERE parlour_id = $1`, [p.parlourId, p.riya.id]), code(CHECK_VIOLATION), 'not before the check-in');
});

test("work_date is the parlour's own calendar day, whatever the server's time zone", async () => {
  const east = await makeParlour('tz-east', 'Pacific/Kiritimati');   // UTC+14
  const west = await makeParlour('tz-west', 'Pacific/Pago_Pago');    // UTC-11
  const e = await service.checkIn(east.riya.auth, { performerId: east.priya });
  const w = await service.checkIn(west.riya.auth, { performerId: west.priya });
  assert.equal(e.workDate, await localToday('Pacific/Kiritimati'));
  assert.equal(w.workDate, await localToday('Pacific/Pago_Pago'));
  assert.notEqual(e.workDate, w.workDate, 'the two parlours are on different calendar days right now');
  assert.equal((await service.today(east.riya.auth)).workDate, e.workDate);
});

// ───────────── the two workflows stay apart ─────────────

test("a person's own GPS attendance and a performer's attendance recorded by that same person are separate rows in separate tables", async () => {
  const p = await makeParlour('independent');
  // The staff member's own attendance, inserted the way the existing workflow does.
  await query(
    `INSERT INTO attendance_records (parlour_id, user_id, work_date, check_in_lat, check_in_lng, check_in_accuracy_m, check_in_distance_m, check_in_device_type)
     VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date, 13.0, 80.0, 10, 5, 'personal')`, [p.parlourId, p.riya.id]);
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  await service.checkOut(p.riya.auth, { performerId: p.priya });

  assert.equal((await one(`SELECT count(*)::int AS n FROM attendance_records WHERE parlour_id = $1`, [p.parlourId])).n, 1, 'her own attendance record is untouched, and still one');
  const own = await one(`SELECT status, check_out_at FROM attendance_records WHERE parlour_id = $1`, [p.parlourId]);
  assert.equal(own.status, 'checked_in');
  assert.equal(own.check_out_at, null, 'recording a performer out did not check the staff member out');
  assert.equal((await rowsOf(p.parlourId)).length, 1);
});

test("a performer's id is never stored as a user: no row of attendance_records names a performer", async () => {
  const p = await makeParlour('no-user-id');
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  const { rows } = await query(`SELECT 1 FROM attendance_records WHERE user_id = ANY($1::uuid[])`, [[p.priya, p.divya, p.old]]);
  assert.equal(rows.length, 0);
});

// ───────────── today, history and the report ─────────────

test('today lists active performers of this parlour with their status', async () => {
  const p = await makeParlour('today');
  const other = await makeParlour('today-other');
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  await service.checkIn(p.riya.auth, { performerId: p.divya });
  await service.checkOut(p.farah.auth, { performerId: p.divya });
  const t = await service.today(p.owner.auth);
  assert.deepEqual(t.performers.map((x) => [x.name, x.status]), [['Divya', 'checked_out'], ['Priya', 'checked_in']]);
  assert.equal(t.performers[0].record.checkOutMarkedBy.name, 'Farah');
  assert.deepEqual((await service.today(other.owner.auth)).performers.map((x) => [x.name, x.status]), [['Divya', 'not_checked_in'], ['Priya', 'not_checked_in']]);
});

test('history: date range, performer and status filters; staff see only what they recorded; an earlier open day is a missed check-out', async () => {
  const p = await makeParlour('history');
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  await service.checkOut(p.riya.auth, { performerId: p.priya });
  await service.checkIn(p.farah.auth, { performerId: p.divya });
  // Two earlier days: one closed, one left open.
  await query(`INSERT INTO performer_attendance_records (parlour_id, performer_id, work_date, check_in_at, check_out_at, marked_by_user_id, check_out_marked_by_user_id)
               VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date - 2, now() - interval '2 days 8 hours', now() - interval '2 days', $3, $3)`, [p.parlourId, p.priya, p.riya.id]);
  await query(`INSERT INTO performer_attendance_records (parlour_id, performer_id, work_date, check_in_at, marked_by_user_id)
               VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date - 1, now() - interval '1 day 8 hours', $3)`, [p.parlourId, p.divya, p.farah.id]);

  const all = await service.history(p.owner.auth, { page: 1, limit: 50 });
  assert.equal(all.meta.total, 4);
  assert.deepEqual(all.items.map((r) => r.status).sort(), ['checked_in', 'checked_out', 'checked_out', 'missed_checkout']);
  const missed = await service.history(p.owner.auth, { page: 1, limit: 50, status: 'missed_checkout' });
  assert.deepEqual(missed.items.map((r) => r.performerName), ['Divya']);
  assert.equal(missed.items[0].markedBy.name, 'Farah');
  assert.equal((await service.history(p.owner.auth, { page: 1, limit: 50, performerId: p.priya })).meta.total, 2);
  const today = await localToday(p.timezone);
  assert.equal((await service.history(p.owner.auth, { page: 1, limit: 50, from: today, to: today })).meta.total, 2);
  assert.equal((await service.history(p.riya.auth, { page: 1, limit: 50 })).meta.total, 2, 'Riya recorded two');
  assert.equal((await service.history(p.farah.auth, { page: 1, limit: 50 })).meta.total, 2, 'Farah recorded two');
  assert.equal((await service.history(p.owner.auth, { page: 1, limit: 1 })).items.length, 1, 'paging');
});

test('report: per-person totals, missed check-outs and minutes; admin only; other parlours never included', async () => {
  const p = await makeParlour('report');
  const other = await makeParlour('report-other');
  await service.checkIn(other.riya.auth, { performerId: other.priya });
  await query(`INSERT INTO performer_attendance_records (parlour_id, performer_id, work_date, check_in_at, check_out_at, marked_by_user_id, check_out_marked_by_user_id)
               VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date - 2, now() - interval '2 days 8 hours', now() - interval '2 days', $3, $3)`, [p.parlourId, p.priya, p.riya.id]);
  await query(`INSERT INTO performer_attendance_records (parlour_id, performer_id, work_date, check_in_at, marked_by_user_id)
               VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Kolkata')::date - 1, now() - interval '1 day 8 hours', $3)`, [p.parlourId, p.priya, p.farah.id]);
  await assert.rejects(service.report(p.riya.auth, {}), code('FORBIDDEN'));
  const r = await service.report(p.owner.auth, {});
  const priya = r.people.find((x) => x.name === 'Priya');
  assert.equal(priya.days, 2);
  assert.equal(priya.complete, 1);
  assert.equal(priya.missedCheckout, 1);
  assert.equal(priya.minutesWorked, 480);
  assert.equal(r.totals.records, 2, "nothing from the other parlour's record");
  assert.ok(!r.people.some((x) => x.name === 'Old Hand'), 'an inactive person with no records in range is left out');
});

// ───────────── what the Performers module still does ─────────────

test('a performer with attendance on record cannot be deleted (409), one without can, and nothing is lost', async () => {
  const p = await makeParlour('delete');
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  await assert.rejects(performers.remove(p.parlourId, p.priya), code('PERFORMER_HAS_ATTENDANCE'));
  assert.equal((await rowsOf(p.parlourId)).length, 1, 'the record is still there');
  await performers.remove(p.parlourId, p.divya); // never had attendance
  assert.equal((await one(`SELECT count(*)::int AS n FROM performers WHERE id = $1`, [p.divya])).n, 0);
  // Even straight SQL cannot orphan the record (checked at commit).
  await assert.rejects(query(`DELETE FROM performers WHERE id = $1`, [p.priya]), code(FK_VIOLATION));
});

test('deactivating a performer keeps their attendance history, and they disappear from today', async () => {
  const p = await makeParlour('deactivate');
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  await performers.update(p.parlourId, p.priya, { isActive: false });
  assert.equal((await service.history(p.owner.auth, { page: 1, limit: 20 })).meta.total, 1);
  assert.ok(!(await service.today(p.owner.auth)).performers.some((x) => x.name === 'Priya'));
  await assert.rejects(service.checkIn(p.farah.auth, { performerId: p.priya }), code('PERFORMER_INACTIVE'));
});

test('deleting a whole parlour (as the platform admin does) removes its attendance with it, without error', async () => {
  const p = await makeParlour('cascade');
  await service.checkIn(p.riya.auth, { performerId: p.priya });
  await service.checkOut(p.farah.auth, { performerId: p.priya });
  await query(`DELETE FROM parlours WHERE id = $1`, [p.parlourId]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM performer_attendance_records WHERE parlour_id = $1`, [p.parlourId])).n, 0);
});
