const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');

// Performers are names the admin keeps. They are not users: they have no login, no password and no role.

const map = (r) => ({
  id: r.id,
  name: r.name,
  isActive: r.is_active,
  // Admin only: how many bill lines name this person. Someone who has done work is deactivated, never deleted.
  ...(r.lines !== undefined && { lines: r.lines, canDelete: r.lines === 0 }),
});

const exists = () => AppError.conflict('There is already someone with this name', 'PERFORMER_EXISTS');

/**
 * The billing counter (admin or staff) needs the people it can choose from: active ones, names only.
 * Only an admin sees the inactive ones and how many bill lines each has.
 */
exports.list = async (auth, { includeInactive }) => {
  if (auth.role !== 'admin') {
    const { rows } = await query(`SELECT id, name, is_active FROM performers WHERE parlour_id = $1 AND is_active ORDER BY lower(name)`, [auth.parlourId]);
    return rows.map(map);
  }
  const { rows } = await query(
    `SELECT p.id, p.name, p.is_active, (SELECT COUNT(*)::int FROM invoice_items it WHERE it.performed_by = p.id) AS lines
       FROM performers p
      WHERE p.parlour_id = $1 ${includeInactive === 'true' ? '' : 'AND p.is_active'}
      ORDER BY p.is_active DESC, lower(p.name)`,
    [auth.parlourId]
  );
  return rows.map(map);
};

exports.get = async (parlourId, id) => {
  const { rows } = await query(
    `SELECT p.id, p.name, p.is_active, (SELECT COUNT(*)::int FROM invoice_items it WHERE it.performed_by = p.id) AS lines
       FROM performers p WHERE p.id = $1 AND p.parlour_id = $2`,
    [id, parlourId]
  );
  if (!rows[0]) throw AppError.notFound('Person not found');
  return map(rows[0]);
};

exports.create = async (parlourId, { name }) => {
  try {
    const { rows: [r] } = await query(`INSERT INTO performers (parlour_id, name) VALUES ($1, $2) RETURNING id`, [parlourId, name]);
    return await exports.get(parlourId, r.id);
  } catch (err) {
    if (err.code === '23505') throw exists();
    throw err;
  }
};

/** A new name shows on reports from now on; every past bill line keeps the name it was made with. */
exports.update = async (parlourId, id, p) => {
  try {
    const { rowCount } = await query(
      `UPDATE performers SET name = COALESCE($3, name), is_active = COALESCE($4, is_active) WHERE id = $1 AND parlour_id = $2`,
      [id, parlourId, p.name ?? null, p.isActive ?? null]
    );
    if (!rowCount) throw AppError.notFound('Person not found');
    return await exports.get(parlourId, id);
  } catch (err) {
    if (err.code === '23505') throw exists();
    throw err;
  }
};

exports.remove = async (parlourId, id) => {
  return withTransaction(async (db) => {
    const { rows: [r] } = await db.query(`SELECT id FROM performers WHERE id = $1 AND parlour_id = $2 FOR UPDATE`, [id, parlourId]);
    if (!r) throw AppError.notFound('Person not found');
    const { rows: [{ lines }] } = await db.query(`SELECT COUNT(*)::int AS lines FROM invoice_items WHERE performed_by = $1`, [id]);
    if (lines > 0) throw AppError.conflict('This person is on past bills, so they cannot be deleted. Deactivate them instead.', 'PERFORMER_IN_USE');
    // A person with visits still to happen cannot be removed from under the calendar. Closed visits stay on record with nobody named.
    const { rows: [{ open }] } = await db.query(
      `SELECT COUNT(*)::int AS open FROM appointments WHERE performer_id = $1 AND status IN ('booked', 'waiting', 'in_service')`, [id]);
    if (open > 0) throw AppError.conflict('This person has appointments still to come. Cancel or move them first, or deactivate the person instead.', 'PERFORMER_HAS_APPOINTMENTS');
    // Attendance recorded for this person (Attendance by Staff) is a permanent record, like their bill lines: deactivate instead.
    const { rows: [{ days }] } = await db.query(`SELECT COUNT(*)::int AS days FROM performer_attendance_records WHERE performer_id = $1`, [id]);
    if (days > 0) throw AppError.conflict('Attendance has been recorded for this person, so they cannot be deleted. Deactivate them instead.', 'PERFORMER_HAS_ATTENDANCE');
    await db.query(`DELETE FROM performers WHERE id = $1`, [id]);
  });
};
