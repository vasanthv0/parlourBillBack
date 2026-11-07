// End-to-end tests for Attendance by Staff. Needs the API running on a real database with the demo seed loaded:
//   npm run db:init && npm run db:seed
//   AUTH_RATE_LIMIT=1000 npm start       (restart between suites: the IP limiter is in memory)
//   API_URL=http://localhost:3000 npm run test:performer-attendance
//
// Every test makes its own parlours (through the platform admin) and the suite deletes them afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SALON, readingAt } = require('./helpers/geo');

// A mobile number belongs to one account across the whole platform, so every test member gets a number of their own.
let mobileSeed = 6000000000 + Math.floor(Math.random() * 900000000);
const nextMobile = () => String(mobileSeed++);

const BASE = (process.env.API_URL || 'http://localhost:3000') + '/api/v1';
const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'Demo@12345';
const STAFF_PASSWORD = 'Secret123';
const KEY = 'page.attendance_by_staff';

/** Tiny client that keeps the refresh cookie like a browser would (same shape as in attendance.test.js). */
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

/** A parlour with an admin, two staff and three performers (Priya, Divya, and Old Hand who is inactive). */
async function makeParlour({ features } = {}) {
  const sa = await signedIn('super@demo.parlour', DEMO_PASSWORD);
  const s = stamp();
  const name = `PerfAtt Salon ${s}`;
  const adminEmail = `owner${s}@test.parlour`;
  const r = await sa.call('POST', '/platform/parlours', { parlourName: name, adminName: 'Olive Owner', email: adminEmail, password: STAFF_PASSWORD, ...(features && { features }) });
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
  parlour.performers = {};
  for (const n of ['Priya', 'Divya', 'Old Hand']) {
    const p = await parlour.admin.call('POST', '/performers', { name: n });
    assert.equal(p.status, 201, JSON.stringify(p.json));
    parlour.performers[n] = p.json.data.id;
  }
  const off = await parlour.admin.call('PATCH', `/performers/${parlour.performers['Old Hand']}`, { isActive: false });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  return parlour;
}
test.after(async () => {
  const sa = await signedIn('super@demo.parlour', DEMO_PASSWORD);
  for (const p of created) await sa.call('DELETE', `/platform/parlours/${p.id}`, { confirmName: p.name });
});

const setFeatures = async (p, features) => {
  const r = await p.sa.call('PATCH', `/platform/parlours/${p.id}`, { features });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.data;
};
const checkIn = (api, performerId) => api.call('POST', '/performer-attendance/check-in', { performerId });
const checkOut = (api, performerId) => api.call('POST', '/performer-attendance/check-out', { performerId });
const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.code, 'FEATURE_DISABLED'); };

// ───────────── the switch (platform admin) ─────────────

test('switch: the platform admin sees it in the feature list, it is on for a new parlour, and the platform admin can turn it off and on', async () => {
  const p = await makeParlour();
  const defs = (await p.sa.call('GET', '/platform/features')).json.data;
  const def = defs.find((f) => f.key === KEY);
  assert.ok(def, 'listed on the platform admin screen');
  assert.equal(def.group, 'page');
  assert.equal(def.label, 'Attendance by Staff');

  const detail = (await p.sa.call('GET', `/platform/parlours/${p.id}`)).json.data;
  assert.equal(detail.features[KEY], true, 'on by default, like every new switch');
  assert.equal((await p.admin.call('GET', '/auth/me')).json.data.features[KEY], true);

  const off = await setFeatures(p, { [KEY]: false });
  assert.equal(off.features[KEY], false);
  assert.equal((await p.admin.call('GET', '/auth/me')).json.data.features[KEY], false, 'the web app reads this to hide the sidebar item');
  assert.equal((await p.staff[0].api.call('GET', '/auth/me')).json.data.features[KEY], false);
  const on = await setFeatures(p, { [KEY]: true });
  assert.equal(on.features[KEY], true);
  assert.equal((await p.admin.call('GET', '/auth/me')).json.data.features[KEY], true);
});

test('switch: it is per parlour, not global', async () => {
  const a = await makeParlour();
  const b = await makeParlour({ features: { [KEY]: false } });
  assert.equal((await a.admin.call('GET', '/auth/me')).json.data.features[KEY], true);
  assert.equal((await b.admin.call('GET', '/auth/me')).json.data.features[KEY], false);
  assert.equal((await a.staff[0].api.call('GET', '/performer-attendance/today')).status, 200);
  refused(await b.staff[0].api.call('GET', '/performer-attendance/today'));
});

test('switch OFF: every Attendance by Staff API is refused for admin and staff, and nothing else is switched off', async () => {
  const p = await makeParlour({ features: { [KEY]: false } });
  const [riya] = p.staff;
  for (const who of [riya.api, p.admin]) {
    refused(await who.call('GET', '/performer-attendance/today'));
    refused(await checkIn(who, p.performers.Priya));
    refused(await checkOut(who, p.performers.Priya));
    refused(await who.call('GET', '/performer-attendance/history'));
  }
  refused(await p.admin.call('GET', '/performer-attendance/report'));
  // Everything that already existed still answers.
  assert.equal((await riya.api.call('GET', '/attendance/today')).status, 200, "a person's own attendance");
  assert.equal((await p.admin.call('GET', '/performers')).status, 200, 'the Performers module');
  assert.equal((await p.admin.call('GET', '/attendance/records')).status, 200, 'the team attendance report');
  // Turn it on: the same call now works.
  await setFeatures(p, { [KEY]: true });
  assert.equal((await checkIn(riya.api, p.performers.Priya)).status, 201);
});

test('switch OFF after use: the history is kept, hidden while off and back when turned on again', async () => {
  const p = await makeParlour();
  await checkIn(p.staff[0].api, p.performers.Priya);
  await setFeatures(p, { [KEY]: false });
  refused(await p.admin.call('GET', '/performer-attendance/history'));
  await setFeatures(p, { [KEY]: true });
  assert.equal((await p.admin.call('GET', '/performer-attendance/history')).json.meta.total, 1);
});

test('switch: a parlour admin or staff member cannot turn it on or off themselves', async () => {
  const p = await makeParlour({ features: { [KEY]: false } });
  for (const who of [p.admin, p.staff[0].api]) {
    const r = await who.call('PATCH', `/platform/parlours/${p.id}`, { features: { [KEY]: true } });
    assert.ok([401, 403].includes(r.status), `platform route refused (${r.status})`);
    assert.equal((await who.call('GET', '/platform/features')).status, 403);
    // Trying to slip a feature into the parlour's own settings changes nothing either.
    await who.call('PATCH', '/parlour', { features: { [KEY]: true } });
  }
  assert.equal((await p.admin.call('GET', '/auth/me')).json.data.features[KEY], false);
  refused(await p.staff[0].api.call('GET', '/performer-attendance/today'));
});

// ───────────── marking attendance ─────────────

test('staff see the active performers with their status, mark check-in and check-out, and the right people are recorded', async () => {
  const p = await makeParlour();
  const [riya, farah] = p.staff;

  const t0 = (await riya.api.call('GET', '/performer-attendance/today')).json.data;
  assert.deepEqual(t0.performers.map((x) => [x.name, x.status]), [['Divya', 'not_checked_in'], ['Priya', 'not_checked_in']], 'active performers only');
  assert.match(t0.workDate, /^\d{4}-\d{2}-\d{2}$/);

  const inn = await checkIn(riya.api, p.performers.Priya);
  assert.equal(inn.status, 201, JSON.stringify(inn.json));
  assert.equal(inn.json.data.performer.status, 'checked_in');
  assert.equal(inn.json.data.performer.record.markedBy.id, riya.id, 'recorded by the signed-in person');

  const out = await checkOut(farah.api, p.performers.Priya);
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(out.json.data.performer.status, 'checked_out');
  assert.equal(out.json.data.performer.record.markedBy.id, riya.id, 'the check-in is still Riya\'s');
  assert.equal(out.json.data.performer.record.checkOutMarkedBy.id, farah.id, 'the check-out is Farah\'s');

  const t1 = (await farah.api.call('GET', '/performer-attendance/today')).json.data;
  assert.deepEqual(t1.performers.map((x) => [x.name, x.status]), [['Divya', 'not_checked_in'], ['Priya', 'checked_out']]);
});

test('an admin can mark attendance too', async () => {
  const p = await makeParlour();
  const r = await checkIn(p.admin, p.performers.Divya);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.data.performer.record.markedBy.name, 'Olive Owner');
});

test('the rules over the API: duplicate check-in, check-out first, duplicate check-out', async () => {
  const p = await makeParlour();
  const api = p.staff[0].api;
  assert.equal((await checkOut(api, p.performers.Priya)).code, 'NOT_CHECKED_IN');
  assert.equal((await checkIn(api, p.performers.Priya)).status, 201);
  const dup = await checkIn(p.staff[1].api, p.performers.Priya);
  assert.equal(dup.status, 409);
  assert.equal(dup.code, 'ALREADY_CHECKED_IN');
  assert.equal((await checkOut(api, p.performers.Priya)).status, 200);
  assert.equal((await checkOut(p.staff[1].api, p.performers.Priya)).code, 'ALREADY_CHECKED_OUT');
  assert.equal((await checkIn(api, p.performers.Priya)).code, 'ATTENDANCE_COMPLETE');
});

test('simultaneous check-ins: one succeeds, the rest are refused, and one record exists', async () => {
  const p = await makeParlour();
  const results = await Promise.all([p.staff[0].api, p.staff[1].api, p.admin, p.staff[0].api, p.staff[1].api].map((a) => checkIn(a, p.performers.Priya)));
  assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join());
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
  assert.equal((await p.admin.call('GET', '/performer-attendance/history')).json.meta.total, 1);
});

test('an inactive performer cannot be checked in, and is not on the list', async () => {
  const p = await makeParlour();
  const r = await checkIn(p.staff[0].api, p.performers['Old Hand']);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'PERFORMER_INACTIVE');
  const names = (await p.staff[0].api.call('GET', '/performer-attendance/today')).json.data.performers.map((x) => x.name);
  assert.ok(!names.includes('Old Hand'));
});

test("another parlour's performer: a staff member cannot mark, check out or filter by them, and learns nothing about them", async () => {
  const a = await makeParlour();
  const b = await makeParlour();
  const theirs = b.performers.Priya;
  const inn = await checkIn(a.staff[0].api, theirs);
  assert.equal(inn.status, 404);
  assert.equal(inn.code, 'PERFORMER_NOT_FOUND');
  assert.equal((await checkOut(a.staff[0].api, theirs)).status, 404);
  assert.equal((await checkIn(a.staff[0].api, '00000000-0000-4000-8000-000000000000')).code, 'PERFORMER_NOT_FOUND', 'the same answer as for an id nobody has');
  // They can see nothing of the other parlour either, and nothing was written there.
  await checkIn(b.staff[0].api, theirs);
  const mine = await a.admin.call('GET', `/performer-attendance/history?performerId=${theirs}`);
  assert.equal(mine.json.meta.total, 0);
  assert.equal((await a.admin.call('GET', '/performer-attendance/history')).json.meta.total, 0);
  assert.equal((await b.admin.call('GET', '/performer-attendance/history')).json.meta.total, 1);
});

test('who is acting and which parlour come only from the token: client-supplied identity is rejected', async () => {
  const a = await makeParlour();
  const b = await makeParlour();
  const api = a.staff[0].api;
  for (const extra of [{ userId: a.staff[1].id }, { markedByUserId: a.staff[1].id }, { parlourId: b.id }, { workDate: '2026-01-01' }, { checkInAt: '2026-01-01T09:00:00Z' }]) {
    const r = await api.call('POST', '/performer-attendance/check-in', { performerId: a.performers.Priya, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.code, 'VALIDATION_ERROR');
  }
  assert.equal((await api.call('POST', '/performer-attendance/check-in', {})).code, 'VALIDATION_ERROR');
  assert.equal((await api.call('POST', '/performer-attendance/check-in', { performerId: 'nope' })).code, 'VALIDATION_ERROR');
  assert.equal((await a.admin.call('GET', '/performer-attendance/history')).json.meta.total, 0, 'none of the bad requests saved anything');
});

test('sign-in is required, and the platform admin (who has no parlour) is kept out', async () => {
  const p = await makeParlour();
  const anon = client();
  assert.equal((await anon.call('GET', '/performer-attendance/today')).status, 401);
  assert.equal((await checkIn(anon, p.performers.Priya)).status, 401);
  assert.equal((await p.sa.call('GET', '/performer-attendance/today')).status, 403);
  assert.equal((await checkIn(p.sa, p.performers.Priya)).status, 403);
});

test('a deactivated staff member is refused immediately, even with a token that has not expired', async () => {
  const p = await makeParlour();
  const [riya] = p.staff;
  assert.equal((await riya.api.call('GET', '/performer-attendance/today')).status, 200);
  assert.equal((await p.admin.call('PATCH', `/staff/${riya.id}`, { isActive: false })).status, 200);
  assert.equal((await checkIn(riya.api, p.performers.Priya)).status, 401);
});

// ───────────── history and the report ─────────────

test('history: an admin sees every record, staff only what they recorded; filters work; the report is admin only', async () => {
  const p = await makeParlour();
  const [riya, farah] = p.staff;
  await checkIn(riya.api, p.performers.Priya);
  await checkOut(riya.api, p.performers.Priya);
  await checkIn(farah.api, p.performers.Divya);

  const all = (await p.admin.call('GET', '/performer-attendance/history')).json;
  assert.equal(all.meta.total, 2);
  const priya = all.data.find((r) => r.performerName === 'Priya');
  assert.equal(priya.status, 'checked_out');
  assert.equal(priya.markedBy.name, 'Riya');
  assert.equal(all.data.find((r) => r.performerName === 'Divya').status, 'checked_in');

  assert.deepEqual((await riya.api.call('GET', '/performer-attendance/history')).json.data.map((r) => r.performerName), ['Priya']);
  assert.deepEqual((await farah.api.call('GET', '/performer-attendance/history')).json.data.map((r) => r.performerName), ['Divya']);

  const day = all.data[0].workDate;
  assert.equal((await p.admin.call('GET', `/performer-attendance/history?from=${day}&to=${day}`)).json.meta.total, 2);
  assert.equal((await p.admin.call('GET', '/performer-attendance/history?from=2000-01-01&to=2000-01-02')).json.meta.total, 0);
  assert.equal((await p.admin.call('GET', `/performer-attendance/history?performerId=${p.performers.Divya}`)).json.meta.total, 1);
  assert.equal((await p.admin.call('GET', '/performer-attendance/history?status=checked_out')).json.meta.total, 1);
  assert.equal((await p.admin.call('GET', '/performer-attendance/history?status=missed_checkout')).json.meta.total, 0, 'today\'s open check-in is not "missed"');
  assert.equal((await p.admin.call('GET', '/performer-attendance/history?from=2026-10-29&to=2026-10-01')).code, 'VALIDATION_ERROR');
  assert.equal((await p.admin.call('GET', '/performer-attendance/history?status=late')).code, 'VALIDATION_ERROR');

  assert.equal((await riya.api.call('GET', '/performer-attendance/report')).status, 403);
  const report = (await p.admin.call('GET', '/performer-attendance/report')).json.data;
  assert.equal(report.totals.records, 2);
  assert.equal(report.people.find((x) => x.name === 'Priya').complete, 1);
  assert.ok(!report.people.some((x) => x.name === 'Old Hand'));
});

// ───────────── the two workflows stay independent ─────────────

test('own GPS attendance and Attendance by Staff work side by side and never touch each other\'s records', async () => {
  const p = await makeParlour();
  const [riya, farah] = p.staff;
  const set = await p.admin.call('PUT', '/attendance/settings', { latitude: SALON.latitude, longitude: SALON.longitude });
  assert.equal(set.status, 200, JSON.stringify(set.json));

  // Riya marks a performer in...
  assert.equal((await checkIn(riya.api, p.performers.Priya)).status, 201);
  // ...and then checks herself in with GPS, exactly as before.
  const own = await riya.api.call('POST', '/attendance/check-in', { ...readingAt(30, 40, 12), deviceType: 'personal' });
  assert.equal(own.status, 201, JSON.stringify(own.json));
  assert.equal(own.json.data.record.userId, riya.id, 'her own record carries her own id');

  // Her own check-out does not touch the performer, and the performer's check-out does not touch her.
  assert.equal((await riya.api.call('POST', '/attendance/check-out', { ...readingAt(30, 40, 12), deviceType: 'personal' })).status, 200);
  assert.equal((await p.staff[1].api.call('GET', '/performer-attendance/today')).json.data.performers.find((x) => x.name === 'Priya').status, 'checked_in');
  assert.equal((await checkOut(farah.api, p.performers.Priya)).status, 200);
  assert.equal((await riya.api.call('GET', '/attendance/today')).json.data.record.status, 'checked_out');

  // The team report of staff attendance lists people only, and the performer report lists performers only.
  const team = (await p.admin.call('GET', '/attendance/records')).json.data;
  assert.deepEqual(team.map((r) => r.userName), ['Riya']);
  assert.ok(team.every((r) => r.userId !== p.performers.Priya));
  const perf = (await p.admin.call('GET', '/performer-attendance/history')).json.data;
  assert.deepEqual(perf.map((r) => r.performerName), ['Priya']);
});

test('switching Attendance by Staff off does not stop own attendance, and switching own Attendance off does not stop Attendance by Staff', async () => {
  const p = await makeParlour();
  await setFeatures(p, { 'page.attendance': false });
  assert.equal((await p.staff[0].api.call('GET', '/attendance/today')).code, 'FEATURE_DISABLED');
  assert.equal((await checkIn(p.staff[0].api, p.performers.Priya)).status, 201, 'Attendance by Staff still works');
  await setFeatures(p, { 'page.attendance': true, [KEY]: false });
  assert.equal((await p.staff[0].api.call('GET', '/attendance/today')).status, 200, 'own attendance still works');
  refused(await p.staff[0].api.call('GET', '/performer-attendance/today'));
});

test('the Performers module: a performer with attendance cannot be deleted but can be deactivated; billing still lists them', async () => {
  const p = await makeParlour();
  await checkIn(p.staff[0].api, p.performers.Priya);
  const del = await p.admin.call('DELETE', `/performers/${p.performers.Priya}`);
  assert.equal(del.status, 409);
  assert.equal(del.code, 'PERFORMER_HAS_ATTENDANCE');
  // A performer with no attendance and no bills still deletes as before.
  assert.equal((await p.admin.call('DELETE', `/performers/${p.performers.Divya}`)).status, 204);
  // The billing counter's list is unchanged: active people, names only for staff.
  const list = (await p.staff[0].api.call('GET', '/performers')).json.data;
  assert.deepEqual(list.map((x) => x.name), ['Priya']);
  assert.equal((await p.admin.call('PATCH', `/performers/${p.performers.Priya}`, { isActive: false })).status, 200);
  assert.equal((await p.admin.call('GET', '/performer-attendance/history')).json.meta.total, 1, 'the history stays after deactivation');
});
