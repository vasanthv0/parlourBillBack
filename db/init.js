// Applies db/schema.sql. Safe to run repeatedly.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');

// Phase 5: the unique mobile-number index is only created when no two accounts share a number. If it is missing,
// say so plainly (the schema itself only raises a notice, which is easy to miss). This never fails the run and never
// changes any data.
async function warnIfMobileIndexMissing() {
  const { rows: [idx] } = await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_mobile_key'`);
  if (idx) return;
  const { rows: [shared] } = await pool.query(
    `SELECT count(*)::int AS numbers, COALESCE(sum(n), 0)::int AS accounts
       FROM (SELECT count(*) AS n FROM users WHERE mobile_normalised IS NOT NULL GROUP BY mobile_normalised HAVING count(*) > 1) s`
  );
  console.warn('');
  console.warn('WARNING: one account per mobile number is NOT enforced yet.');
  console.warn(`  ${shared.numbers} mobile number(s) are shared by ${shared.accounts} accounts, so the unique index could not be created.`);
  console.warn('  Nothing was changed or deleted. Run  npm run report:user-mobiles  to list them, then decide how to handle each one.');
  console.warn('  Until then, the API still refuses new or changed numbers that another account has, and signing in by a');
  console.warn('  shared number is refused (those accounts can still sign in by email). Run  npm run db:init  again once fixed.');
}

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Database schema is up to date.');
    await warnIfMobileIndexMissing();
  } catch (err) {
    console.error('Schema setup failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
