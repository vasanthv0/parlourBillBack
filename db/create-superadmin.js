// Creates the platform super admin (you, the developer). This is deliberately not an API endpoint.
//
//   node db/create-superadmin.js you@example.com "Your Name"
//
// The password is read from the SUPERADMIN_PASSWORD environment variable, or typed at a hidden prompt.
// If the account already exists, add --reset-password to set a new password for it.
const readline = require('readline');
const { pool, withTransaction } = require('../src/config/db');
const { hashPassword } = require('../src/modules/auth/auth.service');
const schemas = require('../src/modules/auth/auth.schemas');

const args = process.argv.slice(2);
const reset = args.includes('--reset-password');
const [emailArg, nameArg] = args.filter((a) => !a.startsWith('--'));

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (text) => { if (!muted) process.stdout.write(text); else if (text.includes('\n')) process.stdout.write('\n'); };
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
    muted = true; // the question is already on screen; hide what is typed
  });
}

const fail = (message) => { console.error(message); process.exit(1); };

(async () => {
  if (!emailArg) fail('Usage: node db/create-superadmin.js <email> ["Full Name"] [--reset-password]');
  const email = schemas.email.safeParse(emailArg);
  if (!email.success) fail('That email address is not valid.');

  const password = process.env.SUPERADMIN_PASSWORD || (await promptHidden('Password (12+ characters): '));
  // This account can see and change everything, so hold it to a stricter rule than parlour users.
  if (password.length < 12) fail('Use at least 12 characters for the super admin password.');
  const strength = schemas.password.safeParse(password);
  if (!strength.success) fail(strength.error.issues[0].message);

  try {
    const passwordHash = await hashPassword(password);
    await withTransaction(async (db) => {
      const { rows: [existing] } = await db.query(`SELECT id, role FROM users WHERE lower(email) = $1`, [email.data]);
      if (existing) {
        if (existing.role !== 'super_admin') throw new Error('That email already belongs to a parlour account. Use a different one.');
        if (!reset) throw new Error('That super admin already exists. Add --reset-password to set a new password.');
        await db.query(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, is_active = true WHERE id = $1`, [existing.id, passwordHash]);
        await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [existing.id]);
        console.log('Password updated. Existing sessions were signed out.');
      } else {
        await db.query(
          `INSERT INTO users (parlour_id, name, email, password_hash, role) VALUES (NULL, $1, $2, $3, 'super_admin')`,
          [nameArg || 'Platform Admin', email.data, passwordHash]
        );
        console.log(`Super admin created: ${email.data}`);
      }
    });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
