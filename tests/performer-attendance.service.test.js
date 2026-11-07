// Logic tests for Attendance by Staff (performerAttendance.service.js, its schemas, and its switch) against a scripted
// in-memory fake of the database. No server, no PostgreSQL:   npm run test:unit
//
// What this proves: the ORDER of checks, which error each failure gives, that identity and parlour come from the token and
// never from the request, that writes happen inside a transaction, and that the person's own attendance table is never touched.
// What it does NOT prove: that the SQL is valid PostgreSQL. That is what tests/performer-attendance.db.test.js and
// tests/performer-attendance.test.js (run against a real database) are for.
const test = require('node:test');
const assert = require('node:assert/strict');
const AppError = require('../src/utils/AppError');

const PARLOUR = 'p-1';
const OTHER_PARLOUR = 'p-2';
const RIYA = 'u-riya';     // staff
const FARAH = 'u-farah';   // staff
const OWNER = 'u-owner';   // admin
const PRIYA = 'pf-priya';
const DIVYA = 'pf-divya';
const OLD = 'pf-old';       // inactive
const STRANGER = 'pf-other-parlour';
const TODAY = '2026-10-29';

// ───────────── the fake database ─────────────
const state = {};
function reset(over = {}) {
  Object.assign(state, {
    users: {
      [RIYA]: { id: RIYA, parlour_id: PARLOUR, name: 'Riya', role: 'staff', is_active: true },
      [FARAH]: { id: FARAH, parlour_id: PARLOUR, name: 'Farah', role: 'staff', is_active: true },
      [OWNER]: { id: OWNER, parlour_id: PARLOUR, name: 'Olive Owner', role: 'admin', is_active: true },
    },
    parlourStatus: 'active',
    performers: [
      { id: PRIYA, parlour_id: PARLOUR, name: 'Priya', is_active: true },
      { id: DIVYA, parlour_id: PARLOUR, name: 'Divya', is_active: true },
      { id: OLD, parlour_id: PARLOUR, name: 'Old Hand', is_active: false },
      { id: STRANGER, parlour_id: OTHER_PARLOUR, name: 'Someone Else', is_active: true },
    ],
    records: [],
    log: [],
    after: null,
    hideNextLookup: false, // simulates a request that slips in between our "is there a record?" read and our insert
    clock: 0,
    ...over,
  });
}

const statusOf = (r) => (r.check_out_at ? 'checked_out' : r.work_date < TODAY ? 'missed_checkout' : 'checked_in');
const joined = (r) => ({
  ...r,
  performer_name: state.performers.find((p) => p.id === r.performer_id)?.name,
  marked_by_name: state.users[r.marked_by_user_id]?.name,
  check_out_marked_by_name: r.check_out_marked_by_user_id ? state.users[r.check_out_marked_by_user_id]?.name : null,
  status: statusOf(r),
});
const stamp = () => new Date(Date.UTC(2026, 9, 29, 4, 0, 0) + state.clock++ * 60_000);

function handle(text, params, inTx) {
  state.log.push({ text, params, inTx });

  if (/JOIN parlours p\s+ON p\.id = u\.parlour_id/.test(text)) {
    const u = state.users[params[0]];
    return u && u.parlour_id === params[1] ? [{ ...u, parlour_status: state.parlourStatus, timezone: 'Asia/Kolkata', today: TODAY }] : [];
  }
  if (/FROM performers WHERE id = \$1 AND parlour_id = \$2/.test(text)) {
    return state.performers.filter((p) => p.id === params[0] && p.parlour_id === params[1]);
  }
  // report
  if (/COUNT\(r\.id\) FILTER/.test(text)) {
    const [parlour, from, to, today] = params;
    return state.performers.filter((p) => p.parlour_id === parlour).map((p) => {
      const mine = state.records.filter((r) => r.performer_id === p.id && r.work_date >= from && r.work_date <= to);
      return { id: p.id, name: p.name, is_active: p.is_active, days: mine.length, complete: mine.filter((r) => r.check_out_at).length,
        missed: mine.filter((r) => !r.check_out_at && r.work_date < today).length,
        minutes: mine.filter((r) => r.check_out_at).reduce((n, r) => n + Math.round((r.check_out_at - r.check_in_at) / 60_000), 0) };
    }).filter((p) => p.is_active || p.days > 0);
  }
  // today: every active performer of this parlour, with today's record if there is one
  if (/FROM performers pf\s+LEFT JOIN performer_attendance_records r/.test(text)) {
    return state.performers.filter((p) => p.parlour_id === params[0] && p.is_active).sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const rec = state.records.find((r) => r.parlour_id === params[0] && r.performer_id === p.id && r.work_date === params[1]);
      const base = { performer_id: p.id, performer_name: p.name, id: null };
      if (!rec) return base;
      const j = joined(rec);
      return { ...base, id: j.id, work_date: j.work_date, check_in_at: j.check_in_at, check_out_at: j.check_out_at,
        marked_by_user_id: j.marked_by_user_id, marked_by_name: j.marked_by_name,
        check_out_marked_by_user_id: j.check_out_marked_by_user_id, check_out_marked_by_name: j.check_out_marked_by_name };
    });
  }
  if (/FROM performer_attendance_records r[\s\S]*WHERE r\.parlour_id = \$1 AND r\.performer_id = \$2 AND r\.work_date = \$3::date/.test(text) && !/ORDER BY/.test(text)) {
    if (state.hideNextLookup) { state.hideNextLookup = false; return []; }
    return state.records.filter((r) => r.parlour_id === params[0] && r.performer_id === params[1] && r.work_date === params[2]).map(joined);
  }
  if (/WHERE r\.id = \$1 AND r\.parlour_id = \$2/.test(text)) {
    return state.records.filter((r) => r.id === params[0] && r.parlour_id === params[1]).map(joined);
  }
  if (/INSERT INTO performer_attendance_records/.test(text)) {
    const [parlour, performer, , by] = params;
    if (state.records.some((r) => r.parlour_id === parlour && r.performer_id === performer && r.work_date === TODAY)) return []; // ON CONFLICT DO NOTHING
    const row = { id: `rec-${state.records.length + 1}`, parlour_id: parlour, performer_id: performer, work_date: TODAY, check_in_at: stamp(), check_out_at: null, marked_by_user_id: by, check_out_marked_by_user_id: null };
    state.records.push(row);
    return [{ id: row.id }];
  }
  if (/SELECT id, check_out_at FROM performer_attendance_records[\s\S]*FOR UPDATE/.test(text)) {
    return state.records.filter((r) => r.parlour_id === params[0] && r.performer_id === params[1] && r.work_date === params[2]).map((r) => ({ id: r.id, check_out_at: r.check_out_at }));
  }
  if (/UPDATE performer_attendance_records/.test(text)) {
    const [id, parlour, performer, by] = params;
    const r = state.records.find((x) => x.id === id && x.parlour_id === parlour && x.performer_id === performer && !x.check_out_at);
    if (!r) return [];
    Object.assign(r, { check_out_at: stamp(), check_out_marked_by_user_id: by });
    return [{ id: r.id }];
  }
  // history
  if (/ORDER BY r\.work_date DESC/.test(text)) {
    const [parlour, from, to, performer, status, markedBy] = params;
    return state.records.map(joined).filter((r) =>
      r.parlour_id === parlour && r.work_date >= from && r.work_date <= to
      && (!performer || r.performer_id === performer) && (!status || r.status === status)
      && (!markedBy || r.marked_by_user_id === markedBy || r.check_out_marked_by_user_id === markedBy));
  }
  if (/SELECT COUNT\(\*\)::int AS count FROM performer_attendance_records/.test(text)) {
    const [parlour, from, to, performer, status, markedBy] = params;
    return [{ count: state.records.map(joined).filter((r) =>
      r.parlour_id === parlour && r.work_date >= from && r.work_date <= to
      && (!performer || r.performer_id === performer) && (!status || r.status === status)
      && (!markedBy || r.marked_by_user_id === markedBy || r.check_out_marked_by_user_id === markedBy)).length }];
  }
  throw new Error(`Fake database got SQL it does not know: ${text}`);
}

// state.after(text) runs right after a statement has been answered: lets a test make something change "between" two steps of the service.
const answered = (text, params, inTx) => { const rows = handle(text, params, inTx); state.after?.(text, params, inTx); return rows; };
const fakeDb = {
  query: async (text, params) => ({ rows: answered(text, params, false) }),
  // Like the real one: if anything inside throws, nothing it wrote stays.
  withTransaction: async (fn) => {
    const snapshot = state.records.map((r) => ({ ...r }));
    try {
      return await fn({ query: async (text, params) => ({ rows: answered(text, params, true) }) });
    } catch (err) {
      state.records = snapshot;
      throw err;
    }
  },
};

const plant = (rel, exports) => { const file = require.resolve(rel); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
plant('../src/config/db', fakeDb);
const service = require('../src/modules/performerAttendance/performerAttendance.service');
const schemas = require('../src/modules/performerAttendance/performerAttendance.schemas');
const { FEATURES, KEYS, effectiveFeatures, storedFeatures } = require('../src/config/features');

// ───────────── helpers ─────────────
const auth = (userId = RIYA, over = {}) => ({ userId, parlourId: PARLOUR, role: state.users[userId]?.role ?? 'staff', ...over });
const rejects = (promise, status, code) =>
  assert.rejects(promise, (e) => { assert.ok(e instanceof AppError, `expected AppError, got ${e}`); assert.equal(e.status, status); assert.equal(e.code, code); return true; });
const writes = () => state.log.filter((l) => /^\s*(INSERT|UPDATE)/.test(l.text));
const history = (a, q = {}) => service.history(a, { page: 1, limit: 20, ...q });

// ───────────── the switch ─────────────

test('switch: attendance_by_staff is registered as a sidebar page, on by default, and off only when the platform admin turns it off', () => {
  const def = FEATURES.find((f) => f.key === 'page.attendance_by_staff');
  assert.ok(def, 'registered in config/features.js');
  assert.equal(def.group, 'page');
  assert.equal(def.label, 'Attendance by Staff');
  assert.ok(KEYS.includes('page.attendance_by_staff'));
  assert.equal(effectiveFeatures({})['page.attendance_by_staff'], true, 'on for every parlour, existing ones included');
  assert.equal(effectiveFeatures({ 'page.attendance_by_staff': false })['page.attendance_by_staff'], false);
  assert.equal(storedFeatures({ 'page.attendance_by_staff': false })['page.attendance_by_staff'], false);
});

test('switch: it is independent of the existing Attendance switch, in both directions', () => {
  const byStaffOff = effectiveFeatures({ 'page.attendance_by_staff': false });
  assert.equal(byStaffOff['page.attendance'], true, 'own attendance still on');
  const ownOff = effectiveFeatures({ 'page.attendance': false });
  assert.equal(ownOff['page.attendance_by_staff'], true, 'Attendance by Staff still on');
  assert.equal(ownOff['page.attendance'], false);
});

test('switch: turning it off changes no other switch', () => {
  const before = effectiveFeatures({});
  const after = effectiveFeatures({ 'page.attendance_by_staff': false });
  for (const key of Object.keys(before)) if (key !== 'page.attendance_by_staff') assert.equal(after[key], before[key], key);
});

// ───────────── check-in ─────────────

test('check-in saves the record for the performer, recorded by the signed-in person, inside a transaction', async () => {
  reset();
  const out = await service.checkIn(auth(RIYA), { performerId: PRIYA });
  assert.equal(out.performer.status, 'checked_in');
  assert.equal(out.performer.performerId, PRIYA);
  assert.equal(out.performer.name, 'Priya');
  assert.equal(out.workDate, TODAY);
  assert.equal(out.performer.record.markedBy.id, RIYA);
  assert.equal(out.performer.record.markedBy.name, 'Riya');
  assert.equal(out.performer.record.checkOutAt, null);
  assert.equal(out.performer.record.checkOutMarkedBy, null);

  const [insert] = writes();
  assert.equal(insert.inTx, true, 'the insert is inside a transaction');
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].performer_id, PRIYA, "the performer's id goes in performer_id");
  assert.equal(state.records[0].marked_by_user_id, RIYA, "the staff member's id goes in marked_by_user_id");
  assert.notEqual(state.records[0].marked_by_user_id, PRIYA, "a performer's id is never stored as the person who recorded it");
});

test('check-in takes who and which parlour from the token, never from the request', async () => {
  reset();
  // The caller tries to slip other identities into the input; the service must ignore them.
  await service.checkIn(auth(RIYA), { performerId: PRIYA, userId: FARAH, markedBy: FARAH, markedByUserId: OWNER, parlourId: OTHER_PARLOUR });
  const [insert] = writes();
  assert.equal(insert.params[0], PARLOUR);
  assert.equal(insert.params[3], RIYA);
  assert.equal(state.records[0].marked_by_user_id, RIYA);
  assert.equal(state.records[0].parlour_id, PARLOUR);
});

test('check-in: the request body schema refuses client-supplied identity, dates and times', () => {
  const ok = schemas.mark.body.safeParse({ performerId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(ok.success, true);
  for (const extra of [{ userId: 'x' }, { parlourId: 'x' }, { markedByUserId: 'x' }, { workDate: '2026-01-01' }, { checkInAt: '2026-01-01T00:00:00Z' }]) {
    assert.equal(schemas.mark.body.safeParse({ performerId: '11111111-1111-4111-8111-111111111111', ...extra }).success, false, JSON.stringify(extra));
  }
  assert.equal(schemas.mark.body.safeParse({}).success, false, 'a performer must be chosen');
  assert.equal(schemas.mark.body.safeParse({ performerId: 'not-a-uuid' }).success, false);
});

test('a duplicate check-in is refused with ALREADY_CHECKED_IN and writes nothing more', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  const before = writes().length;
  await rejects(service.checkIn(auth(FARAH), { performerId: PRIYA }), 409, 'ALREADY_CHECKED_IN');
  assert.equal(writes().length, before, 'no second write');
  assert.equal(state.records.length, 1);
});

test('after a check-out, a second check-in the same day is refused with ATTENDANCE_COMPLETE', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  await service.checkOut(auth(RIYA), { performerId: PRIYA });
  await rejects(service.checkIn(auth(RIYA), { performerId: PRIYA }), 409, 'ATTENDANCE_COMPLETE');
  assert.equal(state.records.length, 1);
});

test('two requests racing for the same check-in: the loser gets ALREADY_CHECKED_IN and only one record exists', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  state.hideNextLookup = true; // the second request did not see the record when it looked, so it reaches the insert
  await rejects(service.checkIn(auth(FARAH), { performerId: PRIYA }), 409, 'ALREADY_CHECKED_IN');
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].marked_by_user_id, RIYA, 'the first one stands');
});

test('different performers can each be checked in on the same day', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  await service.checkIn(auth(RIYA), { performerId: DIVYA });
  assert.equal(state.records.length, 2);
});

test('an inactive performer cannot be checked in, and nothing is written', async () => {
  reset();
  await rejects(service.checkIn(auth(RIYA), { performerId: OLD }), 409, 'PERFORMER_INACTIVE');
  assert.equal(state.records.length, 0);
  assert.equal(writes().length, 0);
});

test('a performer deactivated between the first look and the write is still refused (the row is checked again inside the transaction)', async () => {
  reset();
  let flipped = false;
  state.after = (text) => {
    if (!flipped && /FROM performer_attendance_records r/.test(text)) { flipped = true; state.performers.find((p) => p.id === PRIYA).is_active = false; }
  };
  await rejects(service.checkIn(auth(RIYA), { performerId: PRIYA }), 409, 'PERFORMER_INACTIVE');
  assert.equal(state.records.length, 0, 'the rolled-back transaction left nothing behind');
});

test("another parlour's performer is reported as not found for check-in and check-out, and nothing is written", async () => {
  reset();
  await rejects(service.checkIn(auth(RIYA), { performerId: STRANGER }), 404, 'PERFORMER_NOT_FOUND');
  await rejects(service.checkOut(auth(RIYA), { performerId: STRANGER }), 404, 'PERFORMER_NOT_FOUND');
  assert.equal(writes().length, 0);
  assert.equal(state.records.length, 0);
});

test('an id that belongs to nobody is the same 404 as another parlour\'s performer (nothing leaks)', async () => {
  reset();
  await rejects(service.checkIn(auth(RIYA), { performerId: 'pf-nobody' }), 404, 'PERFORMER_NOT_FOUND');
});

test('a token that names a parlour the person does not belong to is refused outright', async () => {
  reset();
  const asOther = { userId: RIYA, parlourId: OTHER_PARLOUR, role: 'staff' }; // a token naming a parlour the user is not in
  await rejects(service.checkIn(asOther, { performerId: STRANGER }), 401, 'ACCOUNT_DISABLED');
  assert.equal(state.records.length, 0);
});

// ───────────── check-out ─────────────

test('check-out sets the time and who recorded it, and keeps who recorded the check-in', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  const out = await service.checkOut(auth(FARAH), { performerId: PRIYA });
  assert.equal(out.performer.status, 'checked_out');
  assert.ok(out.performer.record.checkOutAt, 'a check-out time');
  assert.ok(Date.parse(out.performer.record.checkOutAt) >= Date.parse(out.performer.record.checkInAt));
  assert.equal(out.performer.record.markedBy.id, RIYA, 'the check-in is still credited to Riya');
  assert.equal(out.performer.record.checkOutMarkedBy.id, FARAH, 'the check-out is credited to Farah');
  assert.equal(state.records.length, 1, 'the same record, not a second one');
  const update = writes().find((w) => /UPDATE/.test(w.text));
  assert.equal(update.inTx, true);
});

test('check-out takes who from the token, not the request', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  await service.checkOut(auth(FARAH), { performerId: PRIYA, userId: OWNER, markedBy: OWNER });
  assert.equal(state.records[0].check_out_marked_by_user_id, FARAH);
});

test('check-out with no check-in is refused with NOT_CHECKED_IN and writes nothing', async () => {
  reset();
  await rejects(service.checkOut(auth(RIYA), { performerId: PRIYA }), 409, 'NOT_CHECKED_IN');
  assert.equal(writes().length, 0);
  assert.equal(state.records.length, 0);
});

test('a second check-out is refused with ALREADY_CHECKED_OUT and changes nothing', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  await service.checkOut(auth(RIYA), { performerId: PRIYA });
  const first = state.records[0].check_out_at;
  await rejects(service.checkOut(auth(FARAH), { performerId: PRIYA }), 409, 'ALREADY_CHECKED_OUT');
  assert.equal(state.records[0].check_out_at, first, 'the first check-out time stands');
  assert.equal(state.records[0].check_out_marked_by_user_id, RIYA);
});

test('two check-outs racing: the second finds the row already closed and does not overwrite the first', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  // Both requests passed the cheap look at an open record; the first one closes it before the second reaches the lock.
  let closedByOther = false;
  state.after = (text) => {
    if (!closedByOther && /FROM performer_attendance_records r/.test(text)) {
      closedByOther = true;
      Object.assign(state.records[0], { check_out_at: stamp(), check_out_marked_by_user_id: RIYA });
    }
  };
  await rejects(service.checkOut(auth(FARAH), { performerId: PRIYA }), 409, 'ALREADY_CHECKED_OUT');
  assert.equal(state.records[0].check_out_marked_by_user_id, RIYA, 'Farah did not overwrite Riya');
});

test('a performer who was deactivated after being checked in can still be checked out, so no record is left open', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  state.performers.find((p) => p.id === PRIYA).is_active = false;
  const out = await service.checkOut(auth(RIYA), { performerId: PRIYA });
  assert.equal(out.performer.status, 'checked_out');
});

test('an earlier day never blocks today: yesterday\'s open record does not stop a new check-in or count as today\'s', async () => {
  reset();
  state.records.push({ id: 'old-1', parlour_id: PARLOUR, performer_id: PRIYA, work_date: '2026-10-28', check_in_at: stamp(), check_out_at: null, marked_by_user_id: RIYA, check_out_marked_by_user_id: null });
  await rejects(service.checkOut(auth(RIYA), { performerId: PRIYA }), 409, 'NOT_CHECKED_IN');
  const out = await service.checkIn(auth(RIYA), { performerId: PRIYA });
  assert.equal(out.performer.status, 'checked_in');
  assert.equal(state.records.length, 2);
  assert.equal(state.records.find((r) => r.id === 'old-1').check_out_at, null, 'yesterday\'s record is untouched');
});

// ───────────── who may act ─────────────

test('a deactivated account is refused even with a still-valid token', async () => {
  reset();
  state.users[RIYA].is_active = false;
  await rejects(service.checkIn(auth(RIYA), { performerId: PRIYA }), 401, 'ACCOUNT_DISABLED');
  await rejects(service.today(auth(RIYA)), 401, 'ACCOUNT_DISABLED');
  assert.equal(writes().length, 0);
});

test('a suspended parlour is refused', async () => {
  reset({ parlourStatus: 'suspended' });
  await rejects(service.checkIn(auth(RIYA), { performerId: PRIYA }), 401, 'ACCOUNT_DISABLED');
});

test('the platform admin (no parlour, another role) cannot mark attendance', async () => {
  reset();
  state.users['u-super'] = { id: 'u-super', parlour_id: PARLOUR, name: 'Super', role: 'super_admin', is_active: true };
  await rejects(service.checkIn({ userId: 'u-super', parlourId: PARLOUR, role: 'super_admin' }, { performerId: PRIYA }), 403, 'FORBIDDEN');
});

test('an admin can mark attendance too, and is recorded as the person who did it', async () => {
  reset();
  await service.checkIn(auth(OWNER), { performerId: DIVYA });
  assert.equal(state.records[0].marked_by_user_id, OWNER);
});

// ───────────── today ─────────────

test('today lists the active performers of this parlour only, each with where they stand', async () => {
  reset();
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  await service.checkIn(auth(RIYA), { performerId: DIVYA });
  await service.checkOut(auth(FARAH), { performerId: DIVYA });

  const t = await service.today(auth(RIYA));
  assert.equal(t.workDate, TODAY);
  assert.equal(t.timezone, 'Asia/Kolkata');
  assert.deepEqual(t.performers.map((p) => p.name), ['Divya', 'Priya'], 'sorted by name; no inactive Old Hand; nobody from another parlour');
  const [divya, priya] = t.performers;
  assert.equal(divya.status, 'checked_out');
  assert.equal(divya.record.checkOutMarkedBy.name, 'Farah');
  assert.equal(priya.status, 'checked_in');
  assert.equal(priya.record.markedBy.name, 'Riya');
});

test('today shows a performer with no record as not_checked_in, with no record', async () => {
  reset();
  const t = await service.today(auth(RIYA));
  assert.deepEqual(t.performers.map((p) => [p.name, p.status, p.record]), [['Divya', 'not_checked_in', null], ['Priya', 'not_checked_in', null]]);
});

test('today does not touch the existing attendance tables', async () => {
  reset();
  await service.today(auth(RIYA));
  await service.checkIn(auth(RIYA), { performerId: PRIYA });
  await service.checkOut(auth(RIYA), { performerId: PRIYA });
  await history(auth(OWNER));
  await service.report(auth(OWNER), {});
  for (const l of state.log) {
    assert.equal(/(^|[^_a-z])attendance_records/.test(l.text), false, `this workflow must not touch attendance_records: ${l.text.slice(0, 80)}`);
    assert.equal(/attendance_settings/.test(l.text), false, 'and does not need the salon location');
  }
});

// ───────────── history and report ─────────────

function seedHistory() {
  const rec = (id, performer, date, by, out) => ({ id, parlour_id: PARLOUR, performer_id: performer, work_date: date, check_in_at: stamp(),
    check_out_at: out ? stamp() : null, marked_by_user_id: by, check_out_marked_by_user_id: out ? by : null });
  state.records.push(
    rec('h1', PRIYA, '2026-10-29', RIYA, true),
    rec('h2', DIVYA, '2026-10-29', FARAH, false),
    rec('h3', PRIYA, '2026-10-27', FARAH, false),   // an earlier day, never checked out
    rec('h4', DIVYA, '2026-10-26', RIYA, true),
    rec('h5', PRIYA, '2026-10-01', RIYA, true),     // outside the default 7 days
    { ...rec('x1', STRANGER, '2026-10-29', 'u-elsewhere', true), parlour_id: OTHER_PARLOUR },
  );
}

test('history: an admin sees every record of the parlour (default last 7 days) and none from another parlour', async () => {
  reset(); seedHistory();
  const out = await history(auth(OWNER));
  assert.deepEqual([...out.items.map((r) => r.id)].sort(), ['h1', 'h2', 'h3', 'h4']);
  assert.equal(out.meta.total, 4);
  assert.ok(!out.items.some((r) => r.id === 'x1'));
});

test('history: shows who recorded each action and the status of each record', async () => {
  reset(); seedHistory();
  const byId = Object.fromEntries((await history(auth(OWNER))).items.map((r) => [r.id, r]));
  assert.equal(byId.h1.markedBy.name, 'Riya');
  assert.equal(byId.h1.status, 'checked_out');
  assert.equal(byId.h2.status, 'checked_in', 'today and still open is just "checked in"');
  assert.equal(byId.h3.status, 'missed_checkout', 'an earlier day with no check-out is flagged');
  assert.equal(byId.h1.performerName, 'Priya');
});

test('history: filters by date range, by performer and by status', async () => {
  reset(); seedHistory();
  const own = (r) => r.items.map((x) => x.id).sort();
  assert.deepEqual(own(await history(auth(OWNER), { from: '2026-10-01', to: '2026-10-01' })), ['h5']);
  assert.deepEqual(own(await history(auth(OWNER), { from: '2026-10-01', to: '2026-10-29' })), ['h1', 'h2', 'h3', 'h4', 'h5']);
  assert.deepEqual(own(await history(auth(OWNER), { performerId: DIVYA })), ['h2', 'h4']);
  assert.deepEqual(own(await history(auth(OWNER), { status: 'missed_checkout' })), ['h3']);
  assert.deepEqual(own(await history(auth(OWNER), { status: 'checked_out' })), ['h1', 'h4']);
  assert.deepEqual(own(await history(auth(OWNER), { status: 'checked_in' })), ['h2']);
});

test("history: another parlour's performer id as a filter finds nothing, never their records", async () => {
  reset(); seedHistory();
  assert.equal((await history(auth(OWNER), { performerId: STRANGER })).items.length, 0);
});

test('history: staff see only the records they recorded themselves; the admin sees everything', async () => {
  reset(); seedHistory();
  assert.deepEqual((await history(auth(RIYA))).items.map((r) => r.id).sort(), ['h1', 'h4']);
  assert.deepEqual((await history(auth(FARAH))).items.map((r) => r.id).sort(), ['h2', 'h3']);
  assert.equal((await history(auth(OWNER))).items.length, 4);
});

test('history: a staff member cannot widen their view by asking for another person (the scope comes from the token, not the query)', async () => {
  reset(); seedHistory();
  const out = await history(auth(RIYA), { performerId: DIVYA });
  assert.deepEqual(out.items.map((r) => r.id), ['h4'], "Riya's own record for Divya only");
});

test('history: the query schema checks dates, the range, ids and the status', () => {
  const parse = (q) => schemas.history.query.safeParse(q);
  assert.equal(parse({}).success, true);
  assert.equal(parse({ from: '2026-10-01', to: '2026-10-29', status: 'missed_checkout' }).success, true);
  assert.equal(parse({ from: '2026-10-29', to: '2026-10-01' }).success, false, 'end before start');
  assert.equal(parse({ from: '2026-02-30' }).success, false, 'a date that does not exist');
  assert.equal(parse({ from: 'yesterday' }).success, false);
  assert.equal(parse({ performerId: 'nope' }).success, false);
  assert.equal(parse({ status: 'late' }).success, false);
});

test('report: admin only, with per-person totals, missed check-outs, and minutes worked', async () => {
  reset(); seedHistory();
  await rejects(service.report(auth(RIYA), {}), 403, 'FORBIDDEN');
  const r = await service.report(auth(OWNER), {});
  assert.deepEqual(r.range, { from: '2026-10-23', to: '2026-10-29' });
  const byName = Object.fromEntries(r.people.map((p) => [p.name, p]));
  assert.equal(byName.Priya.days, 2);
  assert.equal(byName.Priya.complete, 1);
  assert.equal(byName.Priya.missedCheckout, 1);
  assert.equal(byName.Divya.days, 2);
  assert.equal(byName.Divya.missedCheckout, 0);
  assert.equal(r.totals.records, 4);
  assert.equal(r.totals.missedCheckout, 1);
  assert.ok(!r.people.some((p) => p.name === 'Someone Else'), "no other parlour's people");
});

test('report: an inactive performer appears only if they have records in the range', async () => {
  reset(); seedHistory();
  assert.ok(!(await service.report(auth(OWNER), {})).people.some((p) => p.name === 'Old Hand'));
  state.records.push({ id: 'o1', parlour_id: PARLOUR, performer_id: OLD, work_date: '2026-10-28', check_in_at: stamp(), check_out_at: stamp(), marked_by_user_id: OWNER, check_out_marked_by_user_id: OWNER });
  assert.ok((await service.report(auth(OWNER), {})).people.some((p) => p.name === 'Old Hand'));
});

// ───────────── nothing else changed ─────────────

test('the new service exports exactly what the routes use', () => {
  assert.deepEqual(Object.keys(service).sort(), ['checkIn', 'checkOut', 'history', 'report', 'today']);
});
