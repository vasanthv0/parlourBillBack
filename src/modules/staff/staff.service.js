const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { hashPassword } = require('../auth/auth.service');
const { normaliseMobile, MOBILE_MIN_DIGITS } = require('../../utils/phone');

const map = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  mobile: u.mobile,
  role: u.role,
  isActive: u.is_active,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

const COLUMNS = 'id, name, email, mobile, role, is_active, last_login_at, created_at';

const emailTaken = () => AppError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
// The 409 also names the field, so the form can put the message next to the mobile number.
const mobileTaken = () => {
  const message = 'An account with this mobile number already exists';
  const err = AppError.conflict(message, 'MOBILE_TAKEN');
  err.details = { mobile: message };
  return err;
};

/** A database "already exists" error, turned into the matching message by which rule was broken. */
const asTaken = (err) => {
  if (err.code === '23505') {
    if (err.constraint === 'users_mobile_key') return mobileTaken();
    if (err.constraint === 'users_email_key') return emailTaken();
  }
  return err;
};

/**
 * One account per mobile number across the whole platform. The unique index is the real guarantee; this check comes
 * first so the answer is the friendly one, and so the rule also holds in a database where the index could not be
 * created because of old shared numbers (see db/schema.sql). The advisory lock makes two requests for the same number
 * wait for each other. Only a yes or no leaves this function: nothing about the other account is revealed.
 */
async function assertMobileFree(db, mobile, exceptUserId = null) {
  const normalised = normaliseMobile(mobile);
  if (!normalised) return;
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`users.mobile:${normalised}`]);
  const { rowCount } = await db.query(
    `SELECT 1 FROM users WHERE mobile_normalised = $1 AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
    [normalised, exceptUserId]
  );
  if (rowCount) throw mobileTaken();
}

exports.list = async (parlourId) => {
  const { rows } = await query(`SELECT ${COLUMNS} FROM users WHERE parlour_id = $1 ORDER BY is_active DESC, role, lower(name)`, [parlourId]);
  return rows.map(map);
};

exports.create = async (parlourId, { name, email, mobile, password, role }) => {
  const passwordHash = await hashPassword(password);
  try {
    return await withTransaction(async (db) => {
      await assertMobileFree(db, mobile);
      const { rows } = await db.query(
        `INSERT INTO users (parlour_id, name, email, mobile, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [parlourId, name, email ?? null, mobile, passwordHash, role]
      );
      return map(rows[0]);
    });
  } catch (err) {
    throw asTaken(err);
  }
};

exports.update = async (auth, id, patch) => {
  try {
    return await updateInTransaction(auth, id, patch);
  } catch (err) {
    throw asTaken(err);
  }
};

const updateInTransaction = async (auth, id, patch) => {
  return withTransaction(async (db) => {
    // Lock this parlour's admins so two concurrent edits cannot both remove "the last admin".
    const { rows: users } = await db.query(`SELECT id, role, is_active, email, mobile FROM users WHERE parlour_id = $1 FOR UPDATE`, [auth.parlourId]);
    const target = users.find((u) => u.id === id);
    if (!target) throw AppError.notFound('Team member not found');

    const nextRole = patch.role ?? target.role;
    const nextActive = patch.isActive ?? target.is_active;

    // The database requires every admin to have an email; a member who signs in with a mobile number alone cannot be one.
    if (nextRole === 'admin' && !target.email) {
      throw AppError.badRequest('An admin needs an email address, and this team member signs in with a mobile number only', 'ADMIN_NEEDS_EMAIL', { role: 'Only members with an email can be admins' });
    }

    if (id === auth.userId && (nextRole !== 'admin' || !nextActive)) {
      throw AppError.badRequest('You cannot remove your own admin access', 'SELF_LOCKOUT');
    }
    const remainingAdmins = users.filter((u) => (u.id === id ? nextRole === 'admin' && nextActive : u.role === 'admin' && u.is_active)).length;
    if (remainingAdmins === 0) throw AppError.badRequest('At least one active admin is required', 'LAST_ADMIN');

    // A number that is only being sent back unchanged is left alone (an older member may have a shorter one).
    // A different number must have at least 10 digits and must not belong to anybody else on the platform.
    if (patch.mobile !== undefined && patch.mobile !== target.mobile) {
      if (!normaliseMobile(patch.mobile)) {
        const message = `Enter a mobile number with at least ${MOBILE_MIN_DIGITS} digits`;
        throw AppError.badRequest('Please check the highlighted fields', 'VALIDATION_ERROR', { mobile: message });
      }
      await assertMobileFree(db, patch.mobile, id);
    }

    const { rows } = await db.query(
      `UPDATE users SET name = COALESCE($3, name), mobile = COALESCE($6, mobile), role = $4, is_active = $5
        WHERE id = $1 AND parlour_id = $2 RETURNING ${COLUMNS}`,
      [id, auth.parlourId, patch.name ?? null, nextRole, nextActive, patch.mobile ?? null]
    );
    // A deactivated or demoted user must not keep working on an old session.
    if (!nextActive || nextRole !== target.role) {
      await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    }
    return map(rows[0]);
  });
};

exports.resetPassword = async (parlourId, id, password) => {
  const passwordHash = await hashPassword(password);
  return withTransaction(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE users SET password_hash = $3, failed_login_count = 0, locked_until = NULL WHERE id = $1 AND parlour_id = $2`,
      [id, parlourId, passwordHash]
    );
    if (!rowCount) throw AppError.notFound('Team member not found');
    await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
  });
};
