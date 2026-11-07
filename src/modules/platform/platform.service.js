const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { offsetOf, pageMeta } = require('../../utils/pagination');
const { storedFeatures } = require('../../config/features');
const { hashPassword } = require('../auth/auth.service');

// A parlour's "owner" is its earliest admin, the account created together with the parlour.
const PARLOUR_ROWS = `
  SELECT p.id, p.name, p.status, p.features, p.created_at,
         o.id AS owner_id, o.name AS owner_name, o.email AS owner_email,
         o.is_active AS owner_active, o.last_login_at AS owner_last_login,
         (SELECT COUNT(*)::int FROM users u WHERE u.parlour_id = p.id AND u.is_active) AS team_count,
         (SELECT COUNT(*)::int FROM invoices i WHERE i.parlour_id = p.id AND i.status = 'paid') AS bill_count,
         (SELECT COUNT(*)::int FROM customers c WHERE c.parlour_id = p.id) AS customer_count,
         (SELECT COUNT(*)::int FROM services s WHERE s.parlour_id = p.id AND s.is_active) AS service_count
    FROM parlours p
    LEFT JOIN LATERAL (
      SELECT u.* FROM users u WHERE u.parlour_id = p.id AND u.role = 'admin' ORDER BY u.created_at, u.id LIMIT 1
    ) o ON true`;

const map = (p) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  createdAt: p.created_at,
  features: storedFeatures(p.features),
  owner: p.owner_id
    ? { id: p.owner_id, name: p.owner_name, email: p.owner_email, isActive: p.owner_active, lastLoginAt: p.owner_last_login }
    : null,
  counts: { team: p.team_count, bills: p.bill_count, customers: p.customer_count, services: p.service_count },
});

/** Only switched-off keys are stored; a missing key means "on", so new features default to on for everyone. */
function applyFeaturePatch(current, patch) {
  const next = { ...(current || {}) };
  for (const [key, on] of Object.entries(patch)) {
    if (on === false) next[key] = false;
    else delete next[key];
  }
  return next;
}

const emailTaken = () => AppError.conflict('An account with this email already exists', 'EMAIL_TAKEN');
const revokeParlourSessions = (db, parlourId) =>
  db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE parlour_id = $1)`,
    [parlourId]
  );

async function getWith(db, id) {
  const { rows } = await db.query(`${PARLOUR_ROWS} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw AppError.notFound('Parlour not found');
  return map(rows[0]);
}
async function ownerIdOf(db, parlourId) {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE parlour_id = $1 AND role = 'admin' ORDER BY created_at, id LIMIT 1`,
    [parlourId]
  );
  if (!rows[0]) throw AppError.notFound('This parlour has no admin account');
  return rows[0].id;
}

exports.summary = async () => {
  const { rows: [r] } = await query(
    `SELECT COUNT(*)::int AS parlours,
            COUNT(*) FILTER (WHERE status = 'active')::int AS active,
            COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
            (SELECT COUNT(*)::int FROM invoices WHERE status = 'paid') AS bills
       FROM parlours`
  );
  return r;
};

exports.list = async (q) => {
  const search = q.search ? `%${q.search.replace(/[%_\\]/g, '\\$&')}%` : null;
  const where = `WHERE ($1::text IS NULL OR p.name ILIKE $1 OR o.email ILIKE $1 OR o.name ILIKE $1)`;
  const { rows } = await query(`${PARLOUR_ROWS} ${where} ORDER BY p.created_at DESC, p.id LIMIT $2 OFFSET $3`, [search, q.limit, offsetOf(q)]);
  const { rows: [{ count }] } = await query(
    `SELECT COUNT(*)::int AS count FROM parlours p
       LEFT JOIN LATERAL (SELECT u.* FROM users u WHERE u.parlour_id = p.id AND u.role = 'admin' ORDER BY u.created_at, u.id LIMIT 1) o ON true
     ${where}`,
    [search]
  );
  return { items: rows.map(map), meta: pageMeta(q, count) };
};

exports.get = (id) => getWith({ query }, id);

/** A new parlour and its first admin, created together. */
exports.create = async ({ parlourName, adminName, email, password, features }) => {
  const passwordHash = await hashPassword(password);
  try {
    return await withTransaction(async (db) => {
      const { rows: [parlour] } = await db.query(
        `INSERT INTO parlours (name, features) VALUES ($1, $2::jsonb) RETURNING id`,
        [parlourName, JSON.stringify(applyFeaturePatch({}, features || {}))]
      );
      await db.query(
        `INSERT INTO users (parlour_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, 'admin')`,
        [parlour.id, adminName, email, passwordHash]
      );
      return getWith(db, parlour.id);
    });
  } catch (err) {
    if (err.code === '23505') throw emailTaken();
    throw err;
  }
};

exports.update = async (id, patch) => {
  return withTransaction(async (db) => {
    const { rows: [current] } = await db.query(`SELECT features FROM parlours WHERE id = $1 FOR UPDATE`, [id]);
    if (!current) throw AppError.notFound('Parlour not found');

    const features = patch.features ? applyFeaturePatch(current.features, patch.features) : current.features;
    await db.query(
      `UPDATE parlours SET name = COALESCE($2, name), status = COALESCE($3, status), features = $4::jsonb WHERE id = $1`,
      [id, patch.name ?? null, patch.status ?? null, JSON.stringify(features)]
    );
    // Suspending signs everyone in that parlour out (already-issued access tokens lapse within 15 minutes).
    if (patch.status === 'suspended') await revokeParlourSessions(db, id);
    return getWith(db, id);
  });
};

exports.updateOwner = async (id, patch) => {
  return withTransaction(async (db) => {
    const ownerId = await ownerIdOf(db, id);
    try {
      await db.query(`UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email) WHERE id = $1`, [ownerId, patch.name ?? null, patch.email ?? null]);
    } catch (err) {
      if (err.code === '23505') throw emailTaken();
      throw err;
    }
    return getWith(db, id);
  });
};

exports.resetOwnerPassword = async (id, password) => {
  const passwordHash = await hashPassword(password);
  return withTransaction(async (db) => {
    const ownerId = await ownerIdOf(db, id);
    await db.query(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [ownerId, passwordHash]);
    await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [ownerId]);
  });
};

/** Permanently deletes a parlour and everything in it. The caller must type the parlour's name. */
exports.remove = async (id, { confirmName }) => {
  return withTransaction(async (db) => {
    const { rows: [p] } = await db.query(`SELECT name FROM parlours WHERE id = $1 FOR UPDATE`, [id]);
    if (!p) throw AppError.notFound('Parlour not found');
    if (p.name.trim().toLowerCase() !== confirmName.trim().toLowerCase()) {
      throw AppError.badRequest('The name does not match, so nothing was deleted', 'CONFIRM_MISMATCH', { confirmName: 'Type the parlour name exactly' });
    }
    await db.query(`DELETE FROM parlours WHERE id = $1`, [id]); // cascades to users, services, customers, bills
  });
};
