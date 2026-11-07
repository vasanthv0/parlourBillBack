const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const env = require('../../config/env');
const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { signAccessToken, generateRefreshToken, hashToken } = require('../../utils/tokens');
const { effectiveFeatures } = require('../../config/features');
const logger = require('../../utils/logger');

const BCRYPT_COST = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const REUSE_GRACE_MS = 10_000; // two tabs refreshing at once is not an attack

// Compared against when the email or mobile number is unknown, so response time does not reveal which ones exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_COST);

// Every user is loaded with their parlour (a super admin has none, hence LEFT JOIN).
const USER_WITH_PARLOUR = `
  SELECT u.*, p.name AS parlour_name, p.status AS parlour_status, p.features AS parlour_features
    FROM users u LEFT JOIN parlours p ON p.id = u.parlour_id`;

const parlourSuspended = (u) => u.role !== 'super_admin' && u.parlour_status !== 'active';

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email ?? null, // staff made with a mobile number only have none
  mobile: u.mobile ?? null,
  role: u.role,
  parlourId: u.parlour_id,
  parlourName: u.parlour_name ?? null,
  // What this parlour is allowed to see. The web app uses it for the sidebar and buttons; the API enforces it separately.
  features: u.role === 'super_admin' ? null : effectiveFeatures(u.parlour_features),
});

async function createRefreshToken(db, { userId, familyId, meta }) {
  const raw = generateRefreshToken();
  const { rows } = await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5, $6)
     RETURNING id`,
    [userId, familyId, hashToken(raw), String(env.auth.refreshTtlDays), (meta.userAgent || '').slice(0, 300), meta.ip || null]
  );
  return { raw, id: rows[0].id };
}

async function startSession(db, user, meta) {
  const { raw } = await createRefreshToken(db, { userId: user.id, familyId: crypto.randomUUID(), meta });
  return { accessToken: signAccessToken(user), refreshToken: raw, user: publicUser(user) };
}

/**
 * Finds the one account an email or a mobile number belongs to. Both kinds do exactly one query and then the same
 * password check, so nothing about the answer (or how long it takes) tells which kind it was or whether it exists.
 * A mobile number that more than one account holds (only possible in a database where the unique index could not be
 * created because of old data) names nobody: signing in by it is refused rather than guessing, and those accounts can
 * still sign in by email.
 */
async function findByIdentifier({ kind, value }) {
  if (kind === 'email') {
    const { rows } = await query(`${USER_WITH_PARLOUR} WHERE lower(u.email) = $1`, [value]);
    return rows[0];
  }
  const { rows } = await query(`${USER_WITH_PARLOUR} WHERE u.mobile_normalised = $1 LIMIT 2`, [value]);
  if (rows.length > 1) {
    logger.warn('sign-in by mobile refused: the number belongs to more than one account (run npm run report:user-mobiles)');
    return undefined;
  }
  return rows[0];
}

exports.login = async ({ identifier, password }, meta) => {
  const invalid = AppError.unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');

  const user = await findByIdentifier(identifier);

  if (user?.locked_until && user.locked_until > new Date()) {
    const mins = Math.ceil((user.locked_until - Date.now()) / 60000);
    throw new AppError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'ACCOUNT_LOCKED');
  }

  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    if (user) {
      await query(
        `UPDATE users
            SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= $2
                                    THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
          WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, String(LOCK_MINUTES)]
      );
    }
    throw invalid;
  }

  // Only reveal account state after the password is proven correct.
  if (!user.is_active) throw AppError.forbidden('This account has been deactivated. Contact your admin.', 'ACCOUNT_DISABLED');
  if (parlourSuspended(user)) throw AppError.forbidden('This parlour account is suspended.', 'PARLOUR_SUSPENDED');

  await query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
  return withTransaction((db) => startSession(db, user, meta));
};

/**
 * Rotates the refresh token. Presenting an already-used token revokes the whole session family.
 * The transaction returns a `fail` instead of throwing, because a throw would roll back the revocation.
 */
exports.refresh = async (rawToken, meta) => {
  if (!rawToken) throw AppError.unauthorized('Session expired', 'NO_REFRESH_TOKEN');

  const outcome = await withTransaction(async (db) => {
    const revokeFamily = (familyId) =>
      db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);

    const { rows } = await db.query(`SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [hashToken(rawToken)]);
    const token = rows[0];
    if (!token) return { fail: AppError.unauthorized('Session expired', 'REFRESH_INVALID') };

    if (token.revoked_at) {
      if (Date.now() - token.revoked_at.getTime() > REUSE_GRACE_MS) await revokeFamily(token.family_id);
      return { fail: AppError.unauthorized('Session expired', 'REFRESH_REUSED') };
    }
    if (token.expires_at < new Date()) return { fail: AppError.unauthorized('Session expired', 'REFRESH_EXPIRED') };

    const { rows: [user] } = await db.query(`${USER_WITH_PARLOUR} WHERE u.id = $1`, [token.user_id]);
    if (!user || !user.is_active || parlourSuspended(user)) {
      await revokeFamily(token.family_id);
      return { fail: AppError.unauthorized('Session expired', 'ACCOUNT_DISABLED') };
    }

    const next = await createRefreshToken(db, { userId: user.id, familyId: token.family_id, meta });
    await db.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [token.id, next.id]);
    return { session: { accessToken: signAccessToken(user), refreshToken: next.raw, user: publicUser(user) } };
  });

  if (outcome.fail) throw outcome.fail; // thrown only after the transaction has committed
  return outcome.session;
};

exports.logout = async (rawToken) => {
  if (!rawToken) return;
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [hashToken(rawToken)]
  );
};

exports.me = async (userId) => {
  const { rows } = await query(`${USER_WITH_PARLOUR} WHERE u.id = $1 AND u.is_active`, [userId]);
  if (!rows[0] || parlourSuspended(rows[0])) throw AppError.unauthorized('Session expired', 'ACCOUNT_DISABLED');
  return publicUser(rows[0]);
};

/** Changing the password signs out every device, then starts a fresh session on this one. */
exports.changePassword = async (userId, { currentPassword, newPassword }, meta) => {
  const { rows: [user] } = await query(`${USER_WITH_PARLOUR} WHERE u.id = $1`, [userId]);
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw AppError.badRequest('Current password is incorrect', 'WRONG_PASSWORD', { currentPassword: 'Current password is incorrect' });
  }
  const passwordHash = await hashPassword(newPassword);
  return withTransaction(async (db) => {
    await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
    await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    return startSession(db, user, meta);
  });
};

/**
 * Proves that the person at the keyboard knows this account's password, for actions that must not ride on a
 * session someone else left open (e.g. marking attendance on a shared tablet). `user` needs id, password_hash,
 * failed_login_count and locked_until. Uses the same lockout as sign-in: 5 wrong passwords lock the account
 * for 15 minutes.
 *
 * A wrong password is a 400 with a field error, not a 401: the web app treats every 401 as "session over".
 */
exports.confirmPassword = async (user, password) => {
  if (user.locked_until && user.locked_until > new Date()) {
    const mins = Math.ceil((user.locked_until - Date.now()) / 60000);
    throw new AppError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'ACCOUNT_LOCKED');
  }
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) {
    await query(
      `UPDATE users
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= $2
                                  THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [user.id, MAX_FAILED_LOGINS, String(LOCK_MINUTES)]
    );
    throw AppError.badRequest('Incorrect password', 'WRONG_PASSWORD', { password: 'Incorrect password' });
  }
  if (user.failed_login_count > 0) {
    await query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
  }
};

exports.hashPassword = hashPassword;
