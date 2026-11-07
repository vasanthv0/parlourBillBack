// Logic tests for attendance.service.js against a scripted in-memory fake of the database. No server, no
// PostgreSQL:   npm run test:unit
//
// What this proves: the ORDER of checks, which error each failure gives, that identity and parlour come from the
// token and never from the request, and that writes happen inside a transaction. What it does NOT prove: that
// the SQL is valid PostgreSQL. That is what tests/attendance.test.js (run against a real database) is for.
const test = require('node:test');
const assert = require('node:assert/strict');
const AppError = require('../src/utils/AppError');
const { readingAt } = require('./helpers/geo');

const PARLOUR = 'p-1';
const USER = 'u-staff';
const TODAY = '2026-10-29';

// ───────────── the fake database ─────────────
const state = {};
function reset(over = {}) {
  Object.assign(state, {
    actor: { id: USER, role: 'staff', is_active: true, password_hash: 'hash', failed_login_count: 0, locked_until: null, parlour_status: 'active', timezone: 'Asia/Kolkata', today: TODAY },
    settings: { latitude: 13.0827, longitude: 80.2707, radius_m: 100, max_accuracy_m: 50, updated_at: new Date('2026-10-01T00:00:00Z') },
    records: [],
    log: [],
    passwordChecks: [],
    hideNextLookup: false, // simulates a request that slips in between our "is there a record?" read and our insert
    ...over,
  });
}

const nullPunch = { check_out_at: null, check_out_lat: null, check_out_lng: null, check_out_accuracy_m: null, check_out_distance_m: null, check_out_device_type: null };

function handle(text, params, inTx) {
  state.log.push({ text, params, inTx });
  if (/JOIN parlours p ON p\.id = u\.parlour_id/.test(text)) {
    const a = state.actor;
    return a && params[0] === a.id && params[1] === PARLOUR ? [a] : [];
  }
  if (/FROM attendance_settings WHERE parlour_id/.test(text)) return state.settings && params[0] === PARLOUR ? [state.settings] : [];
  if (/FROM attendance_records r\s+WHERE r\.parlour_id = \$1 AND r\.user_id = \$2 AND r\.work_date = \$3::date/.test(text)) {
    if (state.hideNextLookup) { state.hideNextLookup = false; return []; }
    return state.records.filter((r) => r.parlour_id === params[0] && r.user_id === params[1] && r.work_date === params[2]);
  }
  if (/INSERT INTO attendance_records/.test(text)) {
    const [parlour, user, , lat, lng, acc, dist, device] = params;
    if (state.records.some((r) => r.parlour_id === parlour && r.user_id === user && r.work_date === TODAY)) return []; // ON CONFLICT DO NOTHING
    const row = { id: `rec-${state.records.length + 1}`, parlour_id: parlour, user_id: user, work_date: TODAY, status: 'checked_in',
      check_in_at: new Date('2026-10-29T03:30:00Z'), check_in_lat: lat, check_in_lng: lng, check_in_accuracy_m: acc, check_in_distance_m: dist, check_in_device_type: device, ...nullPunch };
    state.records.push(row);
    return [row];
  }
  if (/SELECT status FROM attendance_records[\s\S]*FOR UPDATE/.test(text)) {
    return state.records.filter((r) => r.id === params[0] && r.parlour_id === params[1] && r.user_id === params[2]);
  }
  if (/UPDATE attendance_records/.test(text)) {
    const [id, parlour, user, lat, lng, acc, dist, device] = params;
    const r = state.records.find((x) => x.id === id && x.parlour_id === parlour && x.user_id === user && x.status === 'checked_in');
    if (!r) return [];
    Object.assign(r, { status: 'checked_out', check_out_at: new Date('2026-10-29T12:30:00Z'), check_out_lat: lat, check_out_lng: lng, check_out_accuracy_m: acc, check_out_distance_m: dist, check_out_device_type: device });
    return [r];
  }
  if (/INSERT INTO attendance_settings/.test(text)) {
    const [parlour, lat, lng, radius, acc] = params;
    const prev = state.settings;
    state.settings = { latitude: lat, longitude: lng, radius_m: radius ?? prev?.radius_m ?? 100, max_accuracy_m: acc ?? prev?.max_accuracy_m ?? 50, updated_at: new Date('2026-10-29T04:00:00Z'), parlour };
    return [state.settings];
  }
  if (/FROM attendance_records r\s+JOIN users u/.test(text)) return state.records.filter((r) => r.parlour_id === params[0]).map((r) => ({ ...r, user_name: 'Riya' }));
  if (/SELECT COUNT\(\*\)::int AS count FROM attendance_records/.test(text)) return [{ count: state.records.filter((r) => r.parlour_id === params[0]).length }];
  throw new Error(`Fake database got SQL it does not know: ${text}`);
}

const fakeDb = {
  query: async (text, params) => ({ rows: handle(text, params, false) }),
  withTransaction: async (fn) => fn({ query: async (text, params) => ({ rows: handle(text, params, true) }) }),
};
const fakeAuth = {
  confirmPassword: async (_user, password) => {
    state.passwordChecks.push(password);
    if (password !== 'Secret123') throw AppError.badRequest('Incorrect password', 'WRONG_PASSWORD', { password: 'Incorrect password' });
  },
};

// Replace the two modules that need a real database / bcrypt, then load the real service on top of them.
const plant = (rel, exports) => { const file = require.resolve(rel); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
plant('../src/config/db', fakeDb);
plant('../src/modules/auth/auth.service', fakeAuth);
const service = require('../src/modules/attendance/attendance.service');

// ───────────── helpers ─────────────
const auth = (over = {}) => ({ userId: USER, parlourId: PARLOUR, role: 'staff', ...over });
const personal = (r) => ({ ...r, deviceType: 'personal' });
const shared = (r, password = 'Secret123') => ({ ...r, deviceType: 'shared', password });
const inside = () => readingAt(30, 40, 12);
const rejects = (promise, status, code) =>
  assert.rejects(promise, (e) => { assert.ok(e instanceof AppError, `expected AppError, got ${e}`); assert.equal(e.status, status); assert.equal(e.code, code); return true; });
const writes = () => state.log.filter((l) => /^\s*(INSERT|UPDATE)/.test(l.text) && /attendance_records/.test(l.text));

// ───────────── check-in ─────────────

test('check-in inside the radius is recorded with the server-measured distance', async () => {
  reset();
  const out = await service.checkIn(auth(), personal(inside()));
  assert.equal(out.record.status, 'checked_in');
  assert.equal(out.record.workDate, TODAY);
  assert.ok(Math.abs(out.record.checkIn.distanceM - 50) < 0.5, `distance ${out.record.checkIn.distanceM}`);
  assert.equal(out.record.checkIn.accuracyM, 12);
  assert.equal(out.record.checkIn.deviceType, 'personal');
  assert.equal(out.record.checkOut, null);
  assert.equal(out.configured, true);
  assert.equal(JSON.stringify(out).includes('13.0827'), false, 'the salon coordinates are not sent to staff');
});

test('check-in writes inside a transaction, and who/where come from the token, not the request', async () => {
  reset();
  // The caller tries to pass someone else's identity in the input; the service must ignore it.
  await service.checkIn(auth(), { ...personal(inside()), userId: 'someone-else', parlourId: 'other-parlour' });
  const [insert] = writes();
  assert.equal(insert.inTx, true);
  assert.equal(insert.params[0], PARLOUR);
  assert.equal(insert.params[1], USER);
  assert.equal(state.records[0].user_id, USER);
});

test('check-in outside the radius is refused with OUT_OF_RANGE and writes nothing', async () => {
  reset();
  await rejects(service.checkIn(auth(), personal(readingAt(0, 250))), 403, 'OUT_OF_RANGE');
  assert.equal(state.records.length, 0);
  assert.equal(writes().length, 0);
});

test('the out-of-range message says how far away the person is', async () => {
  reset();
  await assert.rejects(service.checkIn(auth(), personal(readingAt(0, 250))), /25\d m from the salon.*within 100 m/);
});

test('check-in with an inaccurate GPS fix is refused with LOCATION_INACCURATE', async () => {
  reset();
  await rejects(service.checkIn(auth(), personal(readingAt(20, 0, 300))), 422, 'LOCATION_INACCURATE');
  assert.equal(state.records.length, 0);
});

test('a vague fix that is clearly far away is OUT_OF_RANGE, not "inaccurate"', async () => {
  reset();
  await rejects(service.checkIn(auth(), personal(readingAt(3000, 0, 300))), 403, 'OUT_OF_RANGE');
});

test('a stale reading (old timestamp) is refused with LOCATION_STALE', async () => {
  reset();
  await rejects(service.checkIn(auth(), personal(readingAt(10, 0, 10, Date.now() - 20 * 60_000))), 422, 'LOCATION_STALE');
});

test('a second check-in the same day is refused with ALREADY_CHECKED_IN', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  await rejects(service.checkIn(auth(), personal(inside())), 409, 'ALREADY_CHECKED_IN');
  assert.equal(state.records.length, 1);
});

test('checking in again after checking out says the day is complete', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  await service.checkOut(auth(), personal(inside()));
  await rejects(service.checkIn(auth(), personal(inside())), 409, 'ATTENDANCE_COMPLETE');
  assert.equal(state.records.length, 1);
});

test('two check-ins racing: the one that loses the insert still gets a clean ALREADY_CHECKED_IN', async () => {
  reset();
  await service.checkIn(auth({ userId: USER }), personal(inside())); // the "other" request got in first
  state.hideNextLookup = true;                                       // ...after our own "is there a record?" read
  await rejects(service.checkIn(auth(), personal(inside())), 409, 'ALREADY_CHECKED_IN');
  assert.equal(state.records.length, 1, 'still exactly one record');
});

test('location checks come before the password check, so a far-away request costs no password attempt', async () => {
  reset();
  await rejects(service.checkIn(auth(), shared(readingAt(0, 500), 'wrong')), 403, 'OUT_OF_RANGE');
  assert.deepEqual(state.passwordChecks, []);
});

// ───────────── shared devices ─────────────

test('personal device: no password is asked for', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  assert.deepEqual(state.passwordChecks, []);
});

test('shared device: the person’s own password is checked, and the record says "shared"', async () => {
  reset();
  const out = await service.checkIn(auth(), shared(inside()));
  assert.deepEqual(state.passwordChecks, ['Secret123']);
  assert.equal(out.record.checkIn.deviceType, 'shared');
});

test('shared device: a wrong password is a 400 WRONG_PASSWORD (never a 401) and records nothing', async () => {
  reset();
  await rejects(service.checkIn(auth(), shared(inside(), 'nope')), 400, 'WRONG_PASSWORD');
  assert.equal(state.records.length, 0);
});

test('shared device: the password is also required to check out', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  await rejects(service.checkOut(auth(), shared(inside(), 'nope')), 400, 'WRONG_PASSWORD');
  assert.equal(state.records[0].status, 'checked_in', 'still checked in');
  const out = await service.checkOut(auth(), shared(inside()));
  assert.equal(out.record.status, 'checked_out');
  assert.equal(out.record.checkOut.deviceType, 'shared');
});

// ───────────── check-out ─────────────

test('check-out stores its own time, coordinates, distance and device type', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  const out = await service.checkOut(auth(), personal(readingAt(-20, 10, 8)));
  assert.equal(out.record.status, 'checked_out');
  assert.ok(out.record.checkOut.at);
  assert.equal(out.record.checkOut.accuracyM, 8);
  assert.ok(Math.abs(out.record.checkOut.distanceM - 22.4) < 0.5, `distance ${out.record.checkOut.distanceM}`);
  assert.notEqual(out.record.checkOut.latitude, out.record.checkIn.latitude);
  const update = writes().find((w) => /^\s*UPDATE/.test(w.text));
  assert.equal(update.inTx, true);
  assert.ok(state.log.some((l) => /FOR UPDATE/.test(l.text) && l.inTx), 'the row is locked while it changes');
});

test('check-out without a check-in is refused with NOT_CHECKED_IN', async () => {
  reset();
  await rejects(service.checkOut(auth(), personal(inside())), 409, 'NOT_CHECKED_IN');
});

test('checking out twice is refused with ALREADY_CHECKED_OUT', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  await service.checkOut(auth(), personal(inside()));
  await rejects(service.checkOut(auth(), personal(inside())), 409, 'ALREADY_CHECKED_OUT');
});

test('check-out is geofenced too: from far away it is refused and the person stays checked in', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  await rejects(service.checkOut(auth(), personal(readingAt(0, 900))), 403, 'OUT_OF_RANGE');
  assert.equal(state.records[0].status, 'checked_in');
});

test('"not checked in" is reported before "out of range", so the message is the useful one', async () => {
  reset();
  await rejects(service.checkOut(auth(), personal(readingAt(0, 900))), 409, 'NOT_CHECKED_IN');
});

// ───────────── who may act ─────────────

test('a deactivated person with a still-valid token is refused (ACCOUNT_DISABLED)', async () => {
  reset();
  state.actor.is_active = false;
  await rejects(service.checkIn(auth(), personal(inside())), 401, 'ACCOUNT_DISABLED');
  await rejects(service.today(auth()), 401, 'ACCOUNT_DISABLED');
  assert.equal(state.records.length, 0);
});

test('a suspended parlour cannot record attendance', async () => {
  reset();
  state.actor.parlour_status = 'suspended';
  await rejects(service.checkIn(auth(), personal(inside())), 401, 'ACCOUNT_DISABLED');
});

test('a token naming a different parlour than the person belongs to finds nobody', async () => {
  reset();
  await rejects(service.checkIn(auth({ parlourId: 'other-parlour' }), personal(inside())), 401, 'ACCOUNT_DISABLED');
  assert.equal(state.records.length, 0);
});

test('with no salon location set, check-in is refused with LOCATION_NOT_CONFIGURED but today() still answers', async () => {
  reset({ settings: null });
  await rejects(service.checkIn(auth(), personal(inside())), 409, 'LOCATION_NOT_CONFIGURED');
  await rejects(service.locationCheck(auth(), inside()), 409, 'LOCATION_NOT_CONFIGURED');
  const t = await service.today(auth());
  assert.equal(t.configured, false);
  assert.equal(t.radiusM, 100);
  assert.equal(t.record, null);
});

// ───────────── today and location-check ─────────────

test('today(): shows only this person’s record for the parlour’s local date, without the salon coordinates', async () => {
  reset();
  assert.equal((await service.today(auth())).record, null);
  await service.checkIn(auth(), personal(inside()));
  const t = await service.today(auth());
  assert.equal(t.record.status, 'checked_in');
  assert.equal(t.workDate, TODAY);
  assert.equal(t.timezone, 'Asia/Kolkata');
  assert.equal('latitude' in t, false);
});

test('someone else’s record is never returned as mine', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  state.actor.id = 'u-other';
  const t = await service.today(auth({ userId: 'u-other' }));
  assert.equal(t.record, null);
});

test('location-check reports the verdict and distance and records nothing', async () => {
  reset();
  const near = await service.locationCheck(auth(), inside());
  assert.equal(near.verdict, 'ok');
  const far = await service.locationCheck(auth(), readingAt(0, 400));
  assert.equal(far.verdict, 'out_of_range');
  assert.ok(far.distanceM > 390 && far.distanceM < 410);
  assert.equal(state.records.length, 0);
  assert.equal(writes().length, 0);
});

// ───────────── admin: settings and records ─────────────

test('staff cannot read or change the salon location or list the team’s records', async () => {
  reset();
  await rejects(service.getSettings(auth()), 403, 'FORBIDDEN');
  await rejects(service.saveSettings(auth(), { latitude: 13, longitude: 80 }), 403, 'FORBIDDEN');
  await rejects(service.list(auth(), { page: 1, limit: 20 }), 403, 'FORBIDDEN');
});

test('a token that still says "admin" after demotion is not enough: the role is read from the database', async () => {
  reset(); // database says staff
  await rejects(service.saveSettings(auth({ role: 'admin' }), { latitude: 13, longitude: 80 }), 403, 'FORBIDDEN');
});

test('admin sets the location; omitted radius and accuracy keep their value (default 100 m / 50 m the first time)', async () => {
  reset({ settings: null });
  state.actor.role = 'admin';
  const first = await service.saveSettings(auth(), { latitude: 13.0827, longitude: 80.2707 });
  assert.deepEqual([first.configured, first.radiusM, first.maxAccuracyM], [true, 100, 50]);
  await service.saveSettings(auth(), { latitude: 13.0, longitude: 80.0, radiusM: 150 });
  const after = await service.saveSettings(auth(), { latitude: 13.1, longitude: 80.1 });
  assert.equal(after.radiusM, 150, 'radius kept when not sent');
  assert.equal(after.latitude, 13.1);
  assert.equal((await service.getSettings(auth())).latitude, 13.1);
});

test('admin sees the team’s records, each with the person’s name', async () => {
  reset();
  await service.checkIn(auth(), personal(inside()));
  state.actor.role = 'admin';
  const { items, meta } = await service.list(auth(), { page: 1, limit: 20 });
  assert.equal(items.length, 1);
  assert.equal(items[0].userName, 'Riya');
  assert.equal(meta.total, 1);
});
