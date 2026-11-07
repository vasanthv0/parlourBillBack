const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { offsetOf, pageMeta } = require('../../utils/pagination');
const { confirmPassword } = require('../auth/auth.service');
const geo = require('./attendance.geo');

// `query` (the pool) and a transaction client both expose .query(text, params), so helpers take either.
const pool = { query };

// ── Shaping rows for the API ──────────────────────────────────────────────────────────
const RECORD_FIELDS = [
  'id', 'user_id', 'status',
  'check_in_at', 'check_in_lat', 'check_in_lng', 'check_in_accuracy_m', 'check_in_distance_m', 'check_in_device_type',
  'check_out_at', 'check_out_lat', 'check_out_lng', 'check_out_accuracy_m', 'check_out_distance_m', 'check_out_device_type',
];
/** Column list for attendance_records. work_date is sent as text so it never shifts with the server's time zone. */
const recordColumns = (alias) => {
  const p = alias ? `${alias}.` : '';
  return [...RECORD_FIELDS.map((f) => p + f), `to_char(${p}work_date, 'YYYY-MM-DD') AS work_date`].join(', ');
};

const punch = (r, prefix) => ({
  at: r[`${prefix}_at`],
  latitude: r[`${prefix}_lat`],
  longitude: r[`${prefix}_lng`],
  accuracyM: r[`${prefix}_accuracy_m`],
  distanceM: r[`${prefix}_distance_m`],
  deviceType: r[`${prefix}_device_type`],
});

const mapRecord = (r) => ({
  id: r.id,
  userId: r.user_id,
  ...(r.user_name !== undefined && { userName: r.user_name }),
  workDate: r.work_date,
  status: r.status,
  checkIn: punch(r, 'check_in'),
  checkOut: r.check_out_at ? punch(r, 'check_out') : null,
});

const mapSettings = (s) =>
  s
    ? { configured: true, latitude: s.latitude, longitude: s.longitude, radiusM: s.radius_m, maxAccuracyM: s.max_accuracy_m, updatedAt: s.updated_at }
    : { configured: false, latitude: null, longitude: null, radiusM: geo.DEFAULT_RADIUS_M, maxAccuracyM: geo.DEFAULT_MAX_ACCURACY_M, updatedAt: null };

// What a staff screen needs. It never includes the salon's coordinates.
const todayPayload = (actor, settings, record) => ({
  workDate: record ? record.work_date : actor.today,
  timezone: actor.timezone,
  configured: !!settings,
  radiusM: settings ? settings.radius_m : geo.DEFAULT_RADIUS_M,
  maxAccuracyM: settings ? settings.max_accuracy_m : geo.DEFAULT_MAX_ACCURACY_M,
  record: record ? mapRecord(record) : null,
});

const toGeoSettings = (s) => ({ latitude: s.latitude, longitude: s.longitude, radiusM: s.radius_m, maxAccuracyM: s.max_accuracy_m });

// ── Who is asking ─────────────────────────────────────────────────────────────────────
// The access token is valid for up to 15 minutes after someone is deactivated, so every attendance action
// checks the database again. The user must exist in the parlour named in the token, be active, and the
// parlour must not be suspended. "today" is the parlour's local date, not the server's.
const ACTOR_SQL = `
  SELECT u.id, u.role, u.is_active, u.password_hash, u.failed_login_count, u.locked_until,
         p.status AS parlour_status, p.timezone,
         to_char((now() AT TIME ZONE p.timezone)::date, 'YYYY-MM-DD') AS today
    FROM users u
    JOIN parlours p ON p.id = u.parlour_id
   WHERE u.id = $1 AND u.parlour_id = $2`;

async function loadActor(db, auth) {
  const { rows: [actor] } = await db.query(ACTOR_SQL, [auth.userId, auth.parlourId]);
  if (!actor || !actor.is_active || actor.parlour_status !== 'active') {
    throw AppError.unauthorized('Session expired', 'ACCOUNT_DISABLED');
  }
  return actor;
}

// Role comes from the database here, not only the token, because these routes change who may clock in where.
const requireAdmin = (actor) => {
  if (actor.role !== 'admin') throw AppError.forbidden();
};

async function loadSettings(db, parlourId) {
  const { rows: [s] } = await db.query(
    `SELECT latitude, longitude, radius_m, max_accuracy_m, updated_at FROM attendance_settings WHERE parlour_id = $1`,
    [parlourId]
  );
  return s || null;
}

/** The signed-in person plus their parlour's GPS settings. Refuses when the admin has not set a location yet. */
async function actorAndSettings(auth) {
  const actor = await loadActor(pool, auth);
  const settings = await loadSettings(pool, auth.parlourId);
  if (!settings) {
    throw AppError.conflict('Your admin has not set the salon location yet, so attendance cannot be recorded.', 'LOCATION_NOT_CONFIGURED');
  }
  return { actor, settings };
}

async function findToday(db, auth, actor) {
  const { rows: [r] } = await db.query(
    `SELECT ${recordColumns('r')}
       FROM attendance_records r
      WHERE r.parlour_id = $1 AND r.user_id = $2 AND r.work_date = $3::date`,
    [auth.parlourId, auth.userId, actor.today]
  );
  return r || null;
}

// ── Turning a verdict into an error ───────────────────────────────────────────────────
const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.ceil(m)} m`);

function rejectionFor(a) {
  switch (a.verdict) {
    case 'out_of_range':
      return new AppError(403, `You are ${metres(a.distanceM)} from the salon. You need to be within ${a.radiusM} m.`, 'OUT_OF_RANGE');
    case 'inaccurate':
      return new AppError(
        422,
        `Your GPS accuracy is about ±${Math.round(a.accuracyM)} m, but ±${a.maxAccuracyM} m or better is needed. Move near a window or outdoors and try again.`,
        'LOCATION_INACCURATE'
      );
    case 'stale':
      return new AppError(422, 'Your location reading is out of date. Check that your device date and time are set to automatic, then try again.', 'LOCATION_STALE');
    default:
      return null;
  }
}

/** Throws unless this reading is inside the geofence with an acceptable fix. Returns the assessment otherwise. */
function assertInside(input, settings) {
  const assessment = geo.assessReading(input, toGeoSettings(settings));
  const error = rejectionFor(assessment);
  if (error) throw error;
  return assessment;
}

const alreadyIn = (record) =>
  record && record.status === 'checked_out'
    ? AppError.conflict('You have already checked in and out today. Only one check-in per day is recorded.', 'ATTENDANCE_COMPLETE')
    : AppError.conflict('You are already checked in for today.', 'ALREADY_CHECKED_IN');

// ── Staff: today, location check, check-in, check-out ────────────────────────────────

/** Today's status for the signed-in person. Works even before a location is set, so the screen can explain. */
exports.today = async (auth) => {
  const actor = await loadActor(pool, auth);
  const settings = await loadSettings(pool, auth.parlourId);
  return todayPayload(actor, settings, await findToday(pool, auth, actor));
};

/** "Where do I stand?" Records nothing; the check-in and check-out calls re-do this check themselves. */
exports.locationCheck = async (auth, input) => {
  const { settings } = await actorAndSettings(auth);
  return geo.assessReading(input, toGeoSettings(settings));
};

exports.checkIn = async (auth, input) => {
  const { actor, settings } = await actorAndSettings(auth);

  // Cheap refusals first, so a duplicate never costs a password check.
  const existing = await findToday(pool, auth, actor);
  if (existing) throw alreadyIn(existing);

  const assessment = assertInside(input, settings);
  if (input.deviceType === 'shared') await confirmPassword(actor, input.password);

  const record = await withTransaction(async (db) => {
    // The unique (parlour_id, user_id, work_date) key is the real guard: if two requests race, one insert wins.
    const { rows: [row] } = await db.query(
      `INSERT INTO attendance_records
              (parlour_id, user_id, work_date,
               check_in_lat, check_in_lng, check_in_accuracy_m, check_in_distance_m, check_in_device_type)
       VALUES ($1, $2, (now() AT TIME ZONE $3)::date, $4, $5, $6, $7, $8)
       ON CONFLICT (parlour_id, user_id, work_date) DO NOTHING
       RETURNING ${recordColumns()}`,
      [auth.parlourId, auth.userId, actor.timezone, input.latitude, input.longitude, assessment.accuracyM, assessment.distanceM, input.deviceType]
    );
    if (row) return row;
    throw alreadyIn(await findToday(db, auth, actor)); // lost the race
  });

  return todayPayload(actor, settings, record);
};

exports.checkOut = async (auth, input) => {
  const { actor, settings } = await actorAndSettings(auth);

  const existing = await findToday(pool, auth, actor);
  if (!existing) throw AppError.conflict('You have not checked in today, so there is nothing to check out of.', 'NOT_CHECKED_IN');
  if (existing.status === 'checked_out') throw AppError.conflict('You have already checked out today.', 'ALREADY_CHECKED_OUT');

  const assessment = assertInside(input, settings);
  if (input.deviceType === 'shared') await confirmPassword(actor, input.password);

  const record = await withTransaction(async (db) => {
    // Lock the row so two simultaneous check-outs cannot both pass the status test.
    const { rows: [current] } = await db.query(
      `SELECT status FROM attendance_records WHERE id = $1 AND parlour_id = $2 AND user_id = $3 FOR UPDATE`,
      [existing.id, auth.parlourId, auth.userId]
    );
    if (!current) throw AppError.conflict('You have not checked in today, so there is nothing to check out of.', 'NOT_CHECKED_IN');
    if (current.status === 'checked_out') throw AppError.conflict('You have already checked out today.', 'ALREADY_CHECKED_OUT');

    const { rows: [row] } = await db.query(
      `UPDATE attendance_records
          SET status = 'checked_out',
              check_out_at = now(),
              check_out_lat = $4, check_out_lng = $5, check_out_accuracy_m = $6, check_out_distance_m = $7,
              check_out_device_type = $8
        WHERE id = $1 AND parlour_id = $2 AND user_id = $3 AND status = 'checked_in'
        RETURNING ${recordColumns()}`,
      [existing.id, auth.parlourId, auth.userId, input.latitude, input.longitude, assessment.accuracyM, assessment.distanceM, input.deviceType]
    );
    if (!row) throw AppError.conflict('You have already checked out today.', 'ALREADY_CHECKED_OUT');
    return row;
  });

  return todayPayload(actor, settings, record);
};

// ── Admin: salon location and the team's records ──────────────────────────────────────

exports.getSettings = async (auth) => {
  requireAdmin(await loadActor(pool, auth));
  return mapSettings(await loadSettings(pool, auth.parlourId));
};

/**
 * Sets or changes the salon's location. One row per parlour. Leaving radiusM or maxAccuracyM out keeps the
 * current value (or the default of 100 m / 50 m the first time).
 */
exports.saveSettings = async (auth, body) => {
  requireAdmin(await loadActor(pool, auth));
  const { rows: [row] } = await query(
    `INSERT INTO attendance_settings (parlour_id, latitude, longitude, radius_m, max_accuracy_m, updated_by)
     VALUES ($1, $2, $3, COALESCE($4::integer, ${geo.DEFAULT_RADIUS_M}), COALESCE($5::integer, ${geo.DEFAULT_MAX_ACCURACY_M}), $6)
     ON CONFLICT (parlour_id) DO UPDATE SET
       latitude       = EXCLUDED.latitude,
       longitude      = EXCLUDED.longitude,
       radius_m       = COALESCE($4::integer, attendance_settings.radius_m),
       max_accuracy_m = COALESCE($5::integer, attendance_settings.max_accuracy_m),
       updated_by     = EXCLUDED.updated_by,
       updated_at     = now()
     RETURNING latitude, longitude, radius_m, max_accuracy_m, updated_at`,
    [auth.parlourId, body.latitude, body.longitude, body.radiusM ?? null, body.maxAccuracyM ?? null, auth.userId]
  );
  return mapSettings(row);
};

/** The team's records for a date range (default: today in the parlour's time zone). Only this parlour's rows. */
exports.list = async (auth, q) => {
  const actor = await loadActor(pool, auth);
  requireAdmin(actor);

  const from = q.from ?? q.to ?? actor.today;
  const to = q.to ?? q.from ?? actor.today;
  const filter = `r.parlour_id = $1 AND r.work_date BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR r.user_id = $4)`;
  const args = [auth.parlourId, from, to, q.userId ?? null];

  const { rows } = await query(
    `SELECT ${recordColumns('r')}, u.name AS user_name
       FROM attendance_records r
       JOIN users u ON u.id = r.user_id
      WHERE ${filter}
      ORDER BY r.work_date DESC, r.check_in_at DESC, r.id
      LIMIT $5 OFFSET $6`,
    [...args, q.limit, offsetOf(q)]
  );
  const { rows: [{ count }] } = await query(`SELECT COUNT(*)::int AS count FROM attendance_records r WHERE ${filter}`, args);
  return { items: rows.map(mapRecord), meta: pageMeta(q, count) };
};
