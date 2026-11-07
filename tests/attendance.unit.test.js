// Unit tests for the attendance module's pure logic. No database, no server:
//   npm run test:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/modules/attendance/attendance.geo');
const schemas = require('../src/modules/attendance/attendance.schemas');

const { SALON, offset, readingAt } = require('./helpers/geo');

const NOW = Date.UTC(2026, 9, 29, 4, 0, 0);
const reading = (north, east, accuracy = 10, capturedAt = NOW) => readingAt(north, east, accuracy, capturedAt);
const assess = (r, s = SALON, now = NOW) => geo.assessReading(r, s, now);

// ───────────────────────── Haversine ─────────────────────────

test('haversine: the same point is 0 m away', () => {
  assert.equal(geo.haversineMeters(13.0827, 80.2707, 13.0827, 80.2707), 0);
});

test('haversine: one degree of latitude is about 111.19 km', () => {
  const d = geo.haversineMeters(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111195) < 20, `got ${d}`); // 2πR/360 with R = 6,371,008.8 m
});

test('haversine: one degree of longitude shrinks with latitude (cos 60° = 0.5)', () => {
  const equator = geo.haversineMeters(0, 0, 0, 1);
  const sixty = geo.haversineMeters(60, 0, 60, 1);
  assert.ok(Math.abs(sixty / equator - 0.5) < 0.001, `ratio ${sixty / equator}`);
});

test('haversine: known city pair, London to Paris, is about 343.5 km', () => {
  const d = geo.haversineMeters(51.5074, -0.1278, 48.8566, 2.3522);
  assert.ok(Math.abs(d - 343_500) < 1_500, `got ${(d / 1000).toFixed(1)} km`);
});

test('haversine: crosses the antimeridian the short way', () => {
  const d = geo.haversineMeters(0, 179.9995, 0, -179.9995); // 0.001° apart, not 359.999°
  assert.ok(d > 100 && d < 120, `got ${d}`);
});

test('haversine: opposite points on the globe do not produce NaN', () => {
  const d = geo.haversineMeters(0, 0, 0, 180);
  assert.ok(Number.isFinite(d));
  assert.ok(Math.abs(d - Math.PI * geo.EARTH_RADIUS_M) < 1);
});

test('haversine: is symmetric', () => {
  const a = geo.haversineMeters(13.0827, 80.2707, 13.05, 80.2824);
  const b = geo.haversineMeters(13.05, 80.2824, 13.0827, 80.2707);
  assert.equal(a, b);
});

test('test helper: offset(100, 0) really is 100 m away', () => {
  const p = offset(100, 0);
  assert.ok(Math.abs(geo.haversineMeters(SALON.latitude, SALON.longitude, p.latitude, p.longitude) - 100) < 0.5);
});

// ───────────────────────── verdicts ─────────────────────────

test('inside the radius with a good fix → ok', () => {
  const a = assess(reading(30, 40, 12)); // 50 m away
  assert.equal(a.verdict, 'ok');
  assert.equal(a.withinRadius, true);
  assert.ok(Math.abs(a.distanceM - 50) < 0.5, `distance ${a.distanceM}`);
  assert.equal(a.radiusM, 100);
  assert.equal(a.accuracyM, 12);
});

test('standing at the salon → ok, distance about 0', () => {
  const a = assess(reading(0, 0, 8));
  assert.equal(a.verdict, 'ok');
  assert.ok(a.distanceM < 0.5);
});

test('just inside and just outside the 100 m edge', () => {
  assert.equal(assess(reading(99, 0, 5)).verdict, 'ok');
  assert.equal(assess(reading(101, 0, 5)).verdict, 'out_of_range');
});

test('outside the radius with a good fix → out_of_range', () => {
  const a = assess(reading(0, 250, 10));
  assert.equal(a.verdict, 'out_of_range');
  assert.equal(a.withinRadius, false);
});

test('a vague fix near the salon → inaccurate (cannot tell if inside)', () => {
  const a = assess(reading(40, 0, 120)); // 40 m away but ±120 m
  assert.equal(a.verdict, 'inaccurate');
});

test('a vague fix that is outside even on the best case → out_of_range, not inaccurate', () => {
  // 2 km away, ±120 m: even if the true position is 120 m closer it is nowhere near 100 m
  assert.equal(assess(reading(2000, 0, 120)).verdict, 'out_of_range');
});

test('accuracy exactly at the limit is accepted; one metre worse is not', () => {
  assert.equal(assess(reading(10, 0, 50)).verdict, 'ok');
  assert.equal(assess(reading(10, 0, 51)).verdict, 'inaccurate');
});

test('a worse accuracy limit set by the admin is honoured', () => {
  const loose = { ...SALON, maxAccuracyM: 100 };
  assert.equal(assess(reading(10, 0, 80), loose).verdict, 'ok');
  assert.equal(assess(reading(10, 0, 80)).verdict, 'inaccurate');
});

test('a bigger radius set by the admin is honoured', () => {
  const wide = { ...SALON, radiusM: 300 };
  assert.equal(assess(reading(0, 250, 10), wide).verdict, 'ok');
});

test('a reading stamped far from server time → stale (old payload replayed, or a wrong clock)', () => {
  assert.equal(assess(reading(10, 0, 10, NOW - 6 * 60_000)).verdict, 'stale');
  assert.equal(assess(reading(10, 0, 10, NOW + 6 * 60_000)).verdict, 'stale');
  assert.equal(assess(reading(10, 0, 10, NOW - 4 * 60_000)).verdict, 'ok'); // within the 5-minute tolerance
});

test('stale wins over everything else, because nothing in an old reading can be trusted', () => {
  assert.equal(assess(reading(5000, 0, 500, NOW - 10 * 60_000)).verdict, 'stale');
});

test('the reported distance is rounded to one decimal place', () => {
  const a = assess(reading(33.333, 0, 10));
  assert.equal(a.distanceM, Math.round(a.distanceM * 10) / 10);
});

// ───────────────────────── request schemas ─────────────────────────

const good = { latitude: 13.0827, longitude: 80.2707, accuracy: 12.5, capturedAt: NOW };
const parse = (schema, body) => schema.body.safeParse(body);
const fieldsOf = (r) => Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));

test('schema: a normal personal-device check-in is accepted', () => {
  assert.equal(parse(schemas.action, { ...good, deviceType: 'personal' }).success, true);
});

test('schema: latitude and longitude ranges are enforced', () => {
  for (const bad of [{ latitude: 91 }, { latitude: -90.5 }, { longitude: 181 }, { longitude: -180.1 }]) {
    const r = parse(schemas.action, { ...good, deviceType: 'personal', ...bad });
    assert.equal(r.success, false, JSON.stringify(bad));
  }
});

test('schema: non-numbers, NaN-like strings and missing fields are refused', () => {
  for (const bad of [{ latitude: '13.08' }, { longitude: null }, { accuracy: '10' }, { accuracy: 0 }, { accuracy: -3 }, { capturedAt: 1.5 }, { capturedAt: 'now' }]) {
    assert.equal(parse(schemas.action, { ...good, deviceType: 'personal', ...bad }).success, false, JSON.stringify(bad));
  }
  const { latitude, ...missing } = good;
  assert.equal(parse(schemas.action, { ...missing, deviceType: 'personal' }).success, false);
});

test('schema: Infinity is refused (JSON cannot carry it, but a caller can build it in code)', () => {
  assert.equal(parse(schemas.action, { ...good, deviceType: 'personal', accuracy: Infinity }).success, false);
});

test('schema: someone else’s identity cannot be smuggled in the body', () => {
  for (const extra of [{ userId: '11111111-1111-1111-1111-111111111111' }, { parlourId: 'x' }, { status: 'checked_out' }, { distanceM: 0 }]) {
    assert.equal(parse(schemas.action, { ...good, deviceType: 'personal', ...extra }).success, false, JSON.stringify(extra));
    assert.equal(parse(schemas.locationCheck, { ...good, ...extra }).success, false);
  }
});

test('schema: device type must be personal or shared', () => {
  assert.equal(parse(schemas.action, { ...good, deviceType: 'tablet' }).success, false);
  assert.equal(parse(schemas.action, { ...good }).success, false);
});

test('schema: a shared device must send a password, a personal one need not', () => {
  const shared = parse(schemas.action, { ...good, deviceType: 'shared' });
  assert.equal(shared.success, false);
  assert.match(fieldsOf(shared)['password'], /password/i);
  assert.equal(parse(schemas.action, { ...good, deviceType: 'shared', password: 'Secret123' }).success, true);
});

test('schema: settings need a real location; radius and accuracy are optional but bounded', () => {
  const ok = { latitude: 13.0827, longitude: 80.2707 };
  assert.equal(parse(schemas.settings, ok).success, true);
  assert.equal(parse(schemas.settings, { ...ok, radiusM: 100, maxAccuracyM: 50 }).success, true);
  for (const bad of [{ radiusM: 5 }, { radiusM: 501 }, { radiusM: 99.5 }, { maxAccuracyM: 5 }, { maxAccuracyM: 101 }]) {
    assert.equal(parse(schemas.settings, { ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
  assert.equal(parse(schemas.settings, { latitude: 0, longitude: 0 }).success, false, '0,0 is the middle of the ocean');
  assert.equal(parse(schemas.settings, { latitude: 13.08 }).success, false);
});

test('schema: records filters accept real dates only, in order', () => {
  const q = (o) => schemas.records.query.safeParse(o);
  assert.equal(q({}).success, true);
  assert.equal(q({ from: '2026-10-01', to: '2026-10-29' }).success, true);
  assert.equal(q({ from: '2026-10-29', to: '2026-10-01' }).success, false, 'end before start');
  assert.equal(q({ from: '2026-02-30' }).success, false, 'no 30 February');
  assert.equal(q({ from: '29/10/2026' }).success, false);
  assert.equal(q({ userId: 'not-a-uuid' }).success, false);
  assert.equal(q({}).data.limit, 20);
});
