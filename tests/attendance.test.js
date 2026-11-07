// End-to-end tests for GPS attendance. Needs the API running on a real database with the demo seed loaded:
//   npm run db:init && npm run db:seed
//   AUTH_RATE_LIMIT=1000 npm start       (restart between this suite and smoke.test.js: the IP limiter is in memory)
//   API_URL=http://localhost:3000 npm run test:attendance
//
// Every test makes its own parlours (through the platform admin) and the suite deletes them afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');

// A mobile number belongs to one account across the whole platform, so every test member gets a number of their own.
let mobileSeed = 5000000000 + Math.floor(Math.random() * 900000000);
const nextMobile = () => String(mobileSeed++);
const { SALON, readingAt } = require('./helpers/geo');

const BASE = (process.env.API_URL || 'http://localhost:3000') + '/api/v1';
const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'Demo@12345';
const STAFF_PASSWORD = 'Secret123';

/** Tiny client that keeps the refresh cookie like a browser would (same shape as in smoke.test.js). */
function client() {
  let cookie = '';
  let token = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...(cookie && { Cookie: cookie }), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.().find((c) => c.startsWith('refresh_token='));
    if (set) cookie = set.split(';')[0];
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json, code: json?.error?.code };
  };
  return {
    call,
    async login(email, password) {
      const r = await call('POST', '/auth/login', { email, password });
      if (r.status === 200) token = r.json.data.accessToken;
      return r;
    },
  };
}
const signedIn = async (email, password) => { const c = client(); const r = await c.login(email, password); assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.json)}`); return c; };

// ───────────── fixtures ─────────────
const created = [];
let counter = 0;
const stamp = () => `${Date.now()}${counter++}${Math.floor(Math.random() * 1000)}`;

/** A parlour with an admin, two staff, and (unless told otherwise) the salon location already set. */
async function makeParlour({ withLocation = true } = {}) {
  const sa = await signedIn('super@demo.parlour', DEMO_PASSWORD);
  const s = stamp();
  const name = `Attendance Salon ${s}`;
  const adminEmail = `owner${s}@test.parlour`;
  const r = await sa.call('POST', '/platform/parlours', { parlourName: name, adminName: 'Olive Owner', email: adminEmail, password: STAFF_PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const parlour = { id: r.json.data.id, name, sa };
  created.push(parlour);

  parlour.admin = await signedIn(adminEmail, STAFF_PASSWORD);
  parlour.staff = [];
  for (const who of ['Riya', 'Farah']) {
    const email = `${who.toLowerCase()}${s}@test.parlour`;
    const c = await parlour.admin.call('POST', '/staff', { name: who, email, mobile: nextMobile(), password: STAFF_PASSWORD, role: 'staff' });
    assert.equal(c.status, 201, JSON.stringify(c.json));
    parlour.staff.push({ id: c.json.data.id, name: who, email, api: await signedIn(email, STAFF_PASSWORD) });
  }
  if (withLocation) {
    const set = await parlour.admin.call('PUT', '/attendance/settings', { latitude: SALON.latitude, longitude: SALON.longitude });
    assert.equal(set.status, 200, JSON.stringify(set.json));
  }
  return parlour;
}
test.after(async () => {
  const sa = await signedIn('super@demo.parlour', DEMO_PASSWORD);
  for (const p of created) await sa.call('DELETE', `/platform/parlours/${p.id}`, { confirmName: p.name });
});

const personal = (r) => ({ ...r, deviceType: 'personal' });
const shared = (r, password = STAFF_PASSWORD) => ({ ...r, deviceType: 'shared', password });
const inside = (accuracy = 12) => readingAt(30, 40, accuracy); // 50 m from the salon
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

// ───────────── the salon location (admin) ─────────────

test('settings: only an admin can read or set the location; defaults are 100 m and ±50 m', async () => {
  const p = await makeParlour({ withLocation: false });
  const [riya] = p.staff;

  assert.equal((await riya.api.call('GET', '/attendance/settings')).status, 403);
  assert.equal((await riya.api.call('PUT', '/attendance/settings', { latitude: 13.08, longitude: 80.27 })).status, 403);
  assert.equal((await client().call('GET', '/attendance/settings')).status, 401, 'signed-out callers are refused');

  const before = (await p.admin.call('GET', '/attendance/settings')).json.data;
  assert.equal(before.configured, false);
  assert.equal(before.radiusM, 100);

  const set = await p.admin.call('PUT', '/attendance/settings', { latitude: 13.0827, longitude: 80.2707 });
  assert.equal(set.status, 200);
  assert.deepEqual([set.json.data.configured, set.json.data.radiusM, set.json.data.maxAccuracyM], [true, 100, 50]);

  // Changing the radius alone keeps the accuracy limit; changing the location alone keeps the radius.
  const wider = (await p.admin.call('PUT', '/attendance/settings', { latitude: 13.0827, longitude: 80.2707, radiusM: 150 })).json.data;
  assert.deepEqual([wider.radiusM, wider.maxAccuracyM], [150, 50]);
  const moved = (await p.admin.call('PUT', '/attendance/settings', { latitude: 13.09, longitude: 80.28 })).json.data;
  assert.deepEqual([moved.latitude, moved.radiusM], [13.09, 150]);
});

test('settings: bad values are refused with field errors', async () => {
  const p = await makeParlour({ withLocation: false });
  const put = (b) => p.admin.call('PUT', '/attendance/settings', b);
  for (const [body, field] of [
    [{ latitude: 91, longitude: 80 }, 'latitude'],
    [{ latitude: 13, longitude: -181 }, 'longitude'],
    [{ latitude: 13, longitude: 80, radiusM: 5 }, 'radiusM'],
    [{ latitude: 13, longitude: 80, radiusM: 501 }, 'radiusM'],
    [{ latitude: 13, longitude: 80, maxAccuracyM: 500 }, 'maxAccuracyM'],
    [{ latitude: 0, longitude: 0 }, 'latitude'],
    [{ latitude: '13', longitude: 80 }, 'latitude'],
  ]) {
    const r = await put(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.code, 'VALIDATION_ERROR');
    assert.ok(r.json.error.details[field], `${field} error for ${JSON.stringify(body)}`);
  }
});

test('before a location is set: today works and says so, check-in is refused clearly', async () => {
  const p = await makeParlour({ withLocation: false });
  const [riya] = p.staff;
  const t = (await riya.api.call('GET', '/attendance/today')).json.data;
  assert.equal(t.configured, false);
  assert.equal(t.record, null);
  const r = await riya.api.call('POST', '/attendance/check-in', personal(inside()));
  assert.equal(r.status, 409);
  assert.equal(r.code, 'LOCATION_NOT_CONFIGURED');
});

// ───────────── check-in ─────────────

test('check-in inside the radius: recorded with the server’s distance, device type and the parlour’s local date', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  const r = await riya.api.call('POST', '/attendance/check-in', personal(inside()));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const rec = r.json.data.record;
  assert.equal(rec.status, 'checked_in');
  assert.equal(rec.userId, riya.id);
  assert.equal(rec.workDate, localToday());
  assert.ok(Math.abs(rec.checkIn.distanceM - 50) < 1, `distance ${rec.checkIn.distanceM}`);
  assert.equal(rec.checkIn.deviceType, 'personal');
  assert.equal(rec.checkIn.accuracyM, 12);
  assert.ok(rec.checkIn.at && !Number.isNaN(Date.parse(rec.checkIn.at)));
  assert.equal(rec.checkOut, null);
  assert.equal(JSON.stringify(r.json).includes(String(SALON.latitude)), false, 'staff are not sent the salon coordinates');

  const today = (await riya.api.call('GET', '/attendance/today')).json.data;
  assert.equal(today.record.id, rec.id);
});

test('check-in outside the radius is refused and records nothing', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  const r = await riya.api.call('POST', '/attendance/check-in', personal(readingAt(0, 250)));
  assert.equal(r.status, 403);
  assert.equal(r.code, 'OUT_OF_RANGE');
  assert.match(r.json.error.message, /m from the salon/);
  assert.equal((await riya.api.call('GET', '/attendance/today')).json.data.record, null);
});

test('location-check tells the screen where it stands without recording anything', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  const near = (await riya.api.call('POST', '/attendance/location-check', inside())).json.data;
  assert.equal(near.verdict, 'ok');
  assert.equal(near.withinRadius, true);
  const far = (await riya.api.call('POST', '/attendance/location-check', readingAt(0, 400))).json.data;
  assert.equal(far.verdict, 'out_of_range');
  assert.ok(far.distanceM > 390 && far.distanceM < 410);
  assert.equal((await riya.api.call('GET', '/attendance/today')).json.data.record, null);
});

test('inaccurate GPS is refused; the admin can loosen the limit', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  const vague = personal(readingAt(20, 0, 80)); // 20 m away but only ±80 m sure
  const r = await riya.api.call('POST', '/attendance/check-in', vague);
  assert.equal(r.status, 422);
  assert.equal(r.code, 'LOCATION_INACCURATE');

  // far away AND vague is plainly out of range
  assert.equal((await riya.api.call('POST', '/attendance/check-in', personal(readingAt(3000, 0, 300)))).code, 'OUT_OF_RANGE');

  await p.admin.call('PUT', '/attendance/settings', { latitude: SALON.latitude, longitude: SALON.longitude, maxAccuracyM: 100 });
  assert.equal((await riya.api.call('POST', '/attendance/check-in', { ...vague, capturedAt: Date.now() })).status, 201);
});

test('a reading with an old timestamp is refused as stale', async () => {
  const p = await makeParlour();
  const r = await p.staff[0].api.call('POST', '/attendance/check-in', personal(readingAt(10, 0, 10, Date.now() - 30 * 60_000)));
  assert.equal(r.status, 422);
  assert.equal(r.code, 'LOCATION_STALE');
});

test('malformed coordinates and smuggled identities are refused before anything happens', async () => {
  const p = await makeParlour();
  const [riya, farah] = p.staff;
  const post = (b) => riya.api.call('POST', '/attendance/check-in', b);
  const ok = personal(inside());
  for (const bad of [{ latitude: 91 }, { longitude: 200 }, { latitude: '13.08' }, { latitude: null }, { accuracy: 0 }, { accuracy: -5 }, { capturedAt: 'now' }, { deviceType: 'tablet' }]) {
    const r = await post({ ...ok, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.code, 'VALIDATION_ERROR');
  }
  assert.equal((await post({ latitude: 13.08 })).status, 400, 'missing fields');
  // Trying to check someone else in by naming them is refused outright, not ignored.
  assert.equal((await post({ ...ok, userId: farah.id })).status, 400);
  assert.equal((await post({ ...ok, parlourId: p.id })).status, 400);
  assert.equal((await farah.api.call('GET', '/attendance/today')).json.data.record, null, 'nobody was checked in');
});

test('one record per person per day: a second check-in is refused, and so are five at once', async () => {
  const p = await makeParlour();
  const [riya, farah] = p.staff;
  assert.equal((await riya.api.call('POST', '/attendance/check-in', personal(inside()))).status, 201);
  const again = await riya.api.call('POST', '/attendance/check-in', personal(inside()));
  assert.equal(again.status, 409);
  assert.equal(again.code, 'ALREADY_CHECKED_IN');

  // The database's unique key decides a race: exactly one of five simultaneous requests wins.
  const results = await Promise.all(Array.from({ length: 5 }, () => farah.api.call('POST', '/attendance/check-in', personal(inside()))));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409], JSON.stringify(results.map((r) => r.json?.error?.code ?? 'ok')));
});

// ───────────── check-out ─────────────

test('check-out stores its own time, place and distance; the day then counts as complete', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  assert.equal((await riya.api.call('POST', '/attendance/check-out', personal(inside()))).code, 'NOT_CHECKED_IN', 'nothing to check out of yet');

  await riya.api.call('POST', '/attendance/check-in', personal(inside()));
  const out = await riya.api.call('POST', '/attendance/check-out', personal(readingAt(-20, 10, 8)));
  assert.equal(out.status, 200, JSON.stringify(out.json));
  const rec = out.json.data.record;
  assert.equal(rec.status, 'checked_out');
  assert.ok(Date.parse(rec.checkOut.at) >= Date.parse(rec.checkIn.at));
  assert.ok(Math.abs(rec.checkOut.distanceM - 22.4) < 1);
  assert.equal(rec.checkOut.accuracyM, 8);
  assert.notEqual(rec.checkOut.latitude, rec.checkIn.latitude);

  assert.equal((await riya.api.call('POST', '/attendance/check-out', personal(inside()))).code, 'ALREADY_CHECKED_OUT');
  assert.equal((await riya.api.call('POST', '/attendance/check-in', personal(inside()))).code, 'ATTENDANCE_COMPLETE');
});

test('check-out is geofenced too: from outside, the person stays checked in', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  await riya.api.call('POST', '/attendance/check-in', personal(inside()));
  const r = await riya.api.call('POST', '/attendance/check-out', personal(readingAt(0, 600)));
  assert.equal(r.status, 403);
  assert.equal(r.code, 'OUT_OF_RANGE');
  assert.equal((await riya.api.call('GET', '/attendance/today')).json.data.record.status, 'checked_in');
});

// ───────────── shared salon tablet ─────────────

test('shared device: each person proves who they are with their own password, every time', async () => {
  const p = await makeParlour();
  const [riya, farah] = p.staff;

  const noPassword = await riya.api.call('POST', '/attendance/check-in', { ...inside(), deviceType: 'shared' });
  assert.equal(noPassword.status, 400);
  assert.ok(noPassword.json.error.details.password, 'a field error for the password box');

  // Wrong password: a 400 (never 401, which would sign the person out in the web app), and nothing is recorded.
  const wrong = await riya.api.call('POST', '/attendance/check-in', shared(inside(), 'Not-the-password1'));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.code, 'WRONG_PASSWORD');
  assert.equal((await riya.api.call('GET', '/attendance/today')).json.data.record, null);


  const ok = await riya.api.call('POST', '/attendance/check-in', shared(inside()));
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.record.checkIn.deviceType, 'shared');

  // The tablet is then used by Farah, signed in as herself, and her record is her own.
  const hers = await farah.api.call('POST', '/attendance/check-in', shared(inside()));
  assert.equal(hers.json.data.record.userId, farah.id);

  const out = await riya.api.call('POST', '/attendance/check-out', shared(inside()));
  assert.equal(out.json.data.record.checkOut.deviceType, 'shared');
});

test('shared device: repeated wrong passwords lock the account, the same as at sign-in', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  let last;
  for (let i = 0; i < 5; i++) last = await riya.api.call('POST', '/attendance/check-in', shared(inside(), 'Wrong-pass-1'));
  assert.equal(last.code, 'WRONG_PASSWORD');
  const locked = await riya.api.call('POST', '/attendance/check-in', shared(inside()));
  assert.equal(locked.status, 429);
  assert.equal(locked.code, 'ACCOUNT_LOCKED');
  assert.equal((await client().login(riya.email, STAFF_PASSWORD)).status, 429, 'sign-in is locked as well');
});

// ───────────── who may do what, and which parlour ─────────────

test('tenant isolation: one parlour never sees, changes or is measured against another’s attendance', async () => {
  const a = await makeParlour();
  const b = await makeParlour();
  const [aRiya] = a.staff;
  const [bRiya] = b.staff;

  await aRiya.api.call('POST', '/attendance/check-in', personal(inside()));

  // B's admin sees nothing of A's, even when asking for A's person by id.
  const all = await b.admin.call('GET', `/attendance/records?from=${localToday()}&to=${localToday()}`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.data, []);
  const byId = await b.admin.call('GET', `/attendance/records?userId=${aRiya.id}`);
  assert.equal(byId.status, 200);
  assert.deepEqual(byId.json.data, []);

  // B's staff see only their own day.
  assert.equal((await bRiya.api.call('GET', '/attendance/today')).json.data.record, null);

  // B moving its own salon elsewhere does not touch A's geofence.
  await b.admin.call('PUT', '/attendance/settings', { latitude: 28.6139, longitude: 77.209 }); // Delhi
  const aSettings = (await a.admin.call('GET', '/attendance/settings')).json.data;
  assert.equal(aSettings.latitude, SALON.latitude);
  assert.equal(aSettings.longitude, SALON.longitude);

  // B's staff standing at A's salon are nowhere near B's.
  const far = await bRiya.api.call('POST', '/attendance/check-in', personal(inside()));
  assert.equal(far.status, 403);
  assert.equal(far.code, 'OUT_OF_RANGE');

  // A's admin still sees A's record, and only that.
  const mine = (await a.admin.call('GET', `/attendance/records?from=${localToday()}&to=${localToday()}`)).json.data;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].userId, aRiya.id);
});

test('records: an admin sees the team with names and can filter; staff cannot see the log; dates are validated', async () => {
  const p = await makeParlour();
  const [riya, farah] = p.staff;
  await riya.api.call('POST', '/attendance/check-in', personal(inside()));
  await farah.api.call('POST', '/attendance/check-in', shared(inside()));

  const list = await p.admin.call('GET', '/attendance/records');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data.map((r) => r.userName).sort(), ['Farah', 'Riya']);
  assert.equal(list.json.meta.total, 2);
  assert.equal(list.json.data.find((r) => r.userName === 'Farah').checkIn.deviceType, 'shared');

  const one = await p.admin.call('GET', `/attendance/records?userId=${riya.id}`);
  assert.deepEqual(one.json.data.map((r) => r.userName), ['Riya']);

  assert.equal((await riya.api.call('GET', '/attendance/records')).status, 403);
  for (const q of ['from=2026-02-30', 'from=29/10/2026', 'from=2026-10-29&to=2026-10-01', 'userId=nope']) {
    const r = await p.admin.call('GET', `/attendance/records?${q}`);
    assert.equal(r.status, 400, q);
  }
  const past = await p.admin.call('GET', '/attendance/records?from=2020-01-01&to=2020-01-31');
  assert.deepEqual(past.json.data, []);
});

test('a deactivated person’s still-valid token cannot mark attendance', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  assert.equal((await p.admin.call('PATCH', `/staff/${riya.id}`, { isActive: false })).status, 200);
  // Their access token has not expired yet (up to 15 minutes), but the database says they are inactive.
  const r = await riya.api.call('POST', '/attendance/check-in', personal(inside()));
  assert.equal(r.status, 401);
  assert.equal(r.code, 'ACCOUNT_DISABLED');
  assert.deepEqual((await p.admin.call('GET', '/attendance/records')).json.data, []);
});

test('the platform admin has no parlour, so every attendance route refuses them', async () => {
  const sa = await signedIn('super@demo.parlour', DEMO_PASSWORD);
  for (const [m, path, body] of [['GET', '/attendance/today'], ['GET', '/attendance/settings'], ['GET', '/attendance/records'], ['POST', '/attendance/check-in', personal(inside())]]) {
    assert.equal((await sa.call(m, path, body)).status, 403, `${m} ${path}`);
  }
});

test('the platform admin’s switch turns attendance off and on per parlour, immediately', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  const features = (await p.sa.call('GET', '/platform/features')).json.data.map((f) => f.key);
  assert.ok(features.includes('page.attendance'));
  assert.equal((await p.admin.call('GET', '/auth/me')).json.data.features['page.attendance'], true, 'on by default, like every new switch');

  await p.sa.call('PATCH', `/platform/parlours/${p.id}`, { features: { 'page.attendance': false } });
  for (const [api, m, path] of [[riya.api, 'GET', '/attendance/today'], [riya.api, 'POST', '/attendance/check-in'], [p.admin, 'GET', '/attendance/settings'], [p.admin, 'GET', '/attendance/records']]) {
    const r = await api.call(m, path, m === 'POST' ? personal(inside()) : undefined);
    assert.equal(r.status, 403, `${m} ${path}`);
    assert.equal(r.code, 'FEATURE_DISABLED');
  }

  await p.sa.call('PATCH', `/platform/parlours/${p.id}`, { features: { 'page.attendance': true } });
  assert.equal((await riya.api.call('GET', '/attendance/today')).status, 200);
});

test('an admin can also mark their own attendance (owners often work the floor)', async () => {
  const p = await makeParlour();
  const r = await p.admin.call('POST', '/attendance/check-in', personal(inside()));
  assert.equal(r.status, 201);
  assert.equal(r.json.data.record.userName, undefined, 'own record, no name needed');
});
