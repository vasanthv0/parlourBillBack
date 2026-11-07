const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { offsetOf, pageMeta } = require('../../utils/pagination');

// Attendance by Staff: a signed-in admin or staff member records check-in and check-out for a performer.
// Performers are names, not users, so the record is in its own table (performer_attendance_records) and names BOTH people:
// performer_id is the person who attended, marked_by_user_id is the signed-in person who recorded it. A performer's id is
// never put in a users column, and attendance_records (a person's own GPS attendance) is never read or written here.

// `query` (the pool) and a transaction client both expose .query(text, params), so helpers take either.
const pool = { query };

// ── Who is asking ─────────────────────────────────────────────────────────────────────
// The access token is valid for up to 15 minutes after someone is deactivated, so every action checks the database again:
// the user must exist in the parlour named in the token, be active, and the parlour must not be suspended.
// "today" is the parlour's local date, not the server's.
const ACTOR_SQL = `
  SELECT u.id, u.role, u.name, u.is_active,
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
  // The role comes from the database, not only the token. The platform admin has no parlour, so cannot get here.
  if (actor.role !== 'admin' && actor.role !== 'staff') throw AppError.forbidden();
  return actor;
}

const requireAdmin = (actor) => {
  if (actor.role !== 'admin') throw AppError.forbidden();
};

// ── Shaping rows for the API ──────────────────────────────────────────────────────────
// work_date is sent as text so it never shifts with the server's time zone.
// 'missed_checkout' is a past day with a check-in and no check-out; a check-in from today that is still open is simply 'checked_in'.
const STATUS_SQL = `(CASE WHEN r.check_out_at IS NOT NULL THEN 'checked_out'
                          WHEN r.work_date < (now() AT TIME ZONE p.timezone)::date THEN 'missed_checkout'
                          ELSE 'checked_in' END)`;

const RECORD_SELECT = `
  SELECT r.id, r.performer_id, pf.name AS performer_name,
         to_char(r.work_date, 'YYYY-MM-DD') AS work_date,
         r.check_in_at, r.check_out_at,
         r.marked_by_user_id, mu.name AS marked_by_name,
         r.check_out_marked_by_user_id, ou.name AS check_out_marked_by_name,
         ${STATUS_SQL} AS status
    FROM performer_attendance_records r
    JOIN parlours p    ON p.id = r.parlour_id
    JOIN performers pf ON pf.id = r.performer_id AND pf.parlour_id = r.parlour_id
    JOIN users mu      ON mu.id = r.marked_by_user_id
    LEFT JOIN users ou ON ou.id = r.check_out_marked_by_user_id`;

const mapRecord = (r) => ({
  id: r.id,
  performerId: r.performer_id,
  performerName: r.performer_name,
  workDate: r.work_date,
  status: r.status,
  checkInAt: r.check_in_at,
  checkOutAt: r.check_out_at ?? null,
  markedBy: { id: r.marked_by_user_id, name: r.marked_by_name },
  checkOutMarkedBy: r.check_out_marked_by_user_id ? { id: r.check_out_marked_by_user_id, name: r.check_out_marked_by_name } : null,
});

/** One performer's line on the "today" screen. status is what the screen shows: not_checked_in, checked_in or checked_out. */
const mapToday = (performer, record) => ({
  performerId: performer.id,
  name: performer.name,
  status: !record ? 'not_checked_in' : record.check_out_at ? 'checked_out' : 'checked_in',
  record: record ? mapRecord({ ...record, performer_id: performer.id, performer_name: performer.name }) : null,
});

// ── Looking things up (always inside the caller's parlour) ────────────────────────────

/** A performer of THIS parlour. Someone else's performer is reported exactly like one that does not exist. */
async function loadPerformer(db, parlourId, performerId) {
  const { rows: [pf] } = await db.query(`SELECT id, name, is_active FROM performers WHERE id = $1 AND parlour_id = $2`, [performerId, parlourId]);
  if (!pf) throw AppError.notFound('Performer not found', 'PERFORMER_NOT_FOUND');
  return pf;
}

const inactive = (pf) => AppError.conflict(`${pf.name} is not active, so attendance cannot be recorded for them. Ask your admin to make them active first.`, 'PERFORMER_INACTIVE');

async function findRecord(db, parlourId, performerId, workDate) {
  const { rows: [r] } = await db.query(
    `${RECORD_SELECT}
      WHERE r.parlour_id = $1 AND r.performer_id = $2 AND r.work_date = $3::date`,
    [parlourId, performerId, workDate]
  );
  return r || null;
}

async function findRecordById(db, parlourId, id) {
  const { rows: [r] } = await db.query(`${RECORD_SELECT} WHERE r.id = $1 AND r.parlour_id = $2`, [id, parlourId]);
  return r || null;
}

const alreadyIn = (record, performer) =>
  record && record.check_out_at
    ? AppError.conflict(`${performer.name} has already been checked in and out today. Only one check-in per day is recorded.`, 'ATTENDANCE_COMPLETE')
    : AppError.conflict(`${performer.name} is already checked in for today.`, 'ALREADY_CHECKED_IN');

const notCheckedIn = (performer) =>
  AppError.conflict(`${performer.name} has not been checked in today, so there is nothing to check out.`, 'NOT_CHECKED_IN');
const alreadyOut = (performer) => AppError.conflict(`${performer.name} has already been checked out today.`, 'ALREADY_CHECKED_OUT');

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── Today: the active performers and where each stands ────────────────────────────────

exports.today = async (auth) => {
  const actor = await loadActor(pool, auth);
  const { rows } = await pool.query(
    `SELECT pf.id AS performer_id, pf.name AS performer_name,
            r.id, to_char(r.work_date, 'YYYY-MM-DD') AS work_date, r.check_in_at, r.check_out_at,
            r.marked_by_user_id, mu.name AS marked_by_name,
            r.check_out_marked_by_user_id, ou.name AS check_out_marked_by_name
       FROM performers pf
       LEFT JOIN performer_attendance_records r
              ON r.performer_id = pf.id AND r.parlour_id = pf.parlour_id AND r.work_date = $2::date
       LEFT JOIN users mu ON mu.id = r.marked_by_user_id
       LEFT JOIN users ou ON ou.id = r.check_out_marked_by_user_id
      WHERE pf.parlour_id = $1 AND pf.is_active
      ORDER BY lower(pf.name), pf.id`,
    [auth.parlourId, actor.today]
  );
  return {
    workDate: actor.today,
    timezone: actor.timezone,
    performers: rows.map((r) =>
      mapToday({ id: r.performer_id, name: r.performer_name }, r.id ? { ...r, status: r.check_out_at ? 'checked_out' : 'checked_in' } : null)),
  };
};

// ── Check-in and check-out ────────────────────────────────────────────────────────────

exports.checkIn = async (auth, { performerId }) => {
  const actor = await loadActor(pool, auth);
  const performer = await loadPerformer(pool, auth.parlourId, performerId);
  if (!performer.is_active) throw inactive(performer);

  // Cheap refusals first.
  const existing = await findRecord(pool, auth.parlourId, performerId, actor.today);
  if (existing) throw alreadyIn(existing, performer);

  const id = await withTransaction(async (db) => {
    // Hold the performer row while we write, so they cannot be deactivated between the check above and the insert.
    const { rows: [pf] } = await db.query(
      `SELECT id, name, is_active FROM performers WHERE id = $1 AND parlour_id = $2 FOR SHARE`,
      [performerId, auth.parlourId]
    );
    if (!pf) throw AppError.notFound('Performer not found', 'PERFORMER_NOT_FOUND');
    if (!pf.is_active) throw inactive(pf);

    // The unique (parlour_id, performer_id, work_date) key is the real guard: if two requests race, one insert wins.
    // The time is the database clock and the date is the parlour's own today; neither comes from the request.
    const { rows: [row] } = await db.query(
      `INSERT INTO performer_attendance_records (parlour_id, performer_id, work_date, marked_by_user_id)
       VALUES ($1, $2, (now() AT TIME ZONE $3)::date, $4)
       ON CONFLICT (parlour_id, performer_id, work_date) DO NOTHING
       RETURNING id`,
      [auth.parlourId, performerId, actor.timezone, auth.userId]
    );
    if (row) return row.id;
    throw alreadyIn(await findRecord(db, auth.parlourId, performerId, actor.today), performer); // lost the race
  });

  return afterWrite(actor, performer, await findRecordById(pool, auth.parlourId, id));
};

exports.checkOut = async (auth, { performerId }) => {
  const actor = await loadActor(pool, auth);
  // An inactive performer who is already checked in can still be checked out, so a record is never left open by a deactivation.
  const performer = await loadPerformer(pool, auth.parlourId, performerId);

  const existing = await findRecord(pool, auth.parlourId, performerId, actor.today);
  if (!existing) throw notCheckedIn(performer);
  if (existing.check_out_at) throw alreadyOut(performer);

  const id = await withTransaction(async (db) => {
    // Lock the row so two simultaneous check-outs cannot both pass the test below.
    const { rows: [current] } = await db.query(
      `SELECT id, check_out_at FROM performer_attendance_records
        WHERE parlour_id = $1 AND performer_id = $2 AND work_date = $3::date FOR UPDATE`,
      [auth.parlourId, performerId, actor.today]
    );
    if (!current) throw notCheckedIn(performer);
    if (current.check_out_at) throw alreadyOut(performer);

    const { rows: [row] } = await db.query(
      `UPDATE performer_attendance_records
          SET check_out_at = now(), check_out_marked_by_user_id = $4, updated_at = now()
        WHERE id = $1 AND parlour_id = $2 AND performer_id = $3 AND check_out_at IS NULL
        RETURNING id`,
      [current.id, auth.parlourId, performerId, auth.userId]
    );
    if (!row) throw alreadyOut(performer);
    return row.id;
  });

  return afterWrite(actor, performer, await findRecordById(pool, auth.parlourId, id));
};

/** What the screen needs after an action: that performer's line, with the day and time zone it applies to. */
function afterWrite(actor, performer, record) {
  if (!record) throw AppError.conflict('That attendance record changed while it was being saved. Reload and check.', 'ATTENDANCE_CHANGED');
  return { workDate: record.work_date, timezone: actor.timezone, performer: mapToday(performer, record) };
}

// ── History and the admin report ──────────────────────────────────────────────────────

/** The range every list uses: both ends default to today in the parlour's time zone, and a lone end date means just that day. */
function rangeOf(q, today, defaultDays) {
  const to = q.to ?? q.from ?? today;
  const from = q.from ?? (q.to ? q.to : addDays(today, -(defaultDays - 1)));
  return { from: from <= to ? from : to, to };
}

/**
 * Attendance records for a date range, newest first. An admin sees every record in the parlour;
 * staff see only the records they recorded themselves (the check-in or the check-out).
 */
exports.history = async (auth, q) => {
  const actor = await loadActor(pool, auth);
  const { from, to } = rangeOf(q, actor.today, 7);
  const filter = `r.parlour_id = $1 AND r.work_date BETWEEN $2::date AND $3::date
                  AND ($4::uuid IS NULL OR r.performer_id = $4)
                  AND ($5::text IS NULL OR ${STATUS_SQL} = $5)
                  AND ($6::uuid IS NULL OR r.marked_by_user_id = $6 OR r.check_out_marked_by_user_id = $6)`;
  const args = [auth.parlourId, from, to, q.performerId ?? null, q.status ?? null, actor.role === 'admin' ? null : auth.userId];

  const { rows } = await pool.query(
    `${RECORD_SELECT}
      WHERE ${filter}
      ORDER BY r.work_date DESC, r.check_in_at DESC, r.id
      LIMIT $7 OFFSET $8`,
    [...args, q.limit, offsetOf(q)]
  );
  const { rows: [{ count }] } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM performer_attendance_records r JOIN parlours p ON p.id = r.parlour_id WHERE ${filter}`,
    args
  );
  return { items: rows.map(mapRecord), meta: pageMeta(q, count) };
};

/** Per-person totals for a date range (default: the last 7 days). Admin only. */
exports.report = async (auth, q) => {
  const actor = await loadActor(pool, auth);
  requireAdmin(actor);
  const { from, to } = rangeOf(q, actor.today, 7);

  const { rows } = await pool.query(
    `SELECT pf.id, pf.name, pf.is_active,
            COUNT(r.id)::int AS days,
            COUNT(r.id) FILTER (WHERE r.check_out_at IS NOT NULL)::int AS complete,
            COUNT(r.id) FILTER (WHERE r.check_out_at IS NULL AND r.work_date < $4::date)::int AS missed,
            COALESCE(SUM(EXTRACT(EPOCH FROM (r.check_out_at - r.check_in_at)) / 60) FILTER (WHERE r.check_out_at IS NOT NULL), 0)::int AS minutes
       FROM performers pf
       LEFT JOIN performer_attendance_records r
              ON r.performer_id = pf.id AND r.parlour_id = pf.parlour_id AND r.work_date BETWEEN $2::date AND $3::date
      WHERE pf.parlour_id = $1 AND ($5::uuid IS NULL OR pf.id = $5)
      GROUP BY pf.id, pf.name, pf.is_active
     HAVING pf.is_active OR COUNT(r.id) > 0
      ORDER BY lower(pf.name), pf.id`,
    [auth.parlourId, from, to, actor.today, q.performerId ?? null]
  );
  const people = rows.map((r) => ({ performerId: r.id, name: r.name, isActive: r.is_active, days: r.days, complete: r.complete, missedCheckout: r.missed, minutesWorked: r.minutes }));
  const sum = (k) => people.reduce((n, p) => n + p[k], 0);
  return {
    range: { from, to },
    timezone: actor.timezone,
    totals: { records: sum('days'), complete: sum('complete'), missedCheckout: sum('missedCheckout'), minutesWorked: sum('minutesWorked') },
    people,
  };
};
