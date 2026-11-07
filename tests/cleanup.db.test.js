// Runs the real cleanup SQL against PostgreSQL. Needs the database from your .env (run `npm run db:init` once);
// it does NOT need the API running.      npm run test:db
//
// Everything happens inside ONE transaction that is always rolled back, so the database is left exactly as it was
// found, including any genuinely old tokens the cleanup deletes along the way.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../src/config/db');
const { cleanupRefreshTokens } = require('../src/jobs/refreshTokenCleanup');

test.after(() => pool.end());

async function withRolledBackTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function makeUser(client) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const { rows: [parlour] } = await client.query(`INSERT INTO parlours (name) VALUES ($1) RETURNING id`, [`Cleanup Test ${stamp}`]);
  const { rows: [user] } = await client.query(
    `INSERT INTO users (parlour_id, name, email, password_hash, role) VALUES ($1, 'Cleanup Test', $2, 'not-a-real-hash', 'admin') RETURNING id`,
    [parlour.id, `cleanup${stamp}@test.parlour`]
  );
  return { parlourId: parlour.id, userId: user.id };
}

/** Days are counted from now: negative is the past, null means "never revoked". */
async function addToken(client, userId, label, { expiresInDays, revokedInDays = null }) {
  await client.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, revoked_at, user_agent)
     VALUES ($1, gen_random_uuid(), $2, now() + ($3::float8 * interval '1 day'),
             CASE WHEN $4::float8 IS NULL THEN NULL ELSE now() + ($4::float8 * interval '1 day') END, $5)`,
    [userId, crypto.randomBytes(32).toString('hex'), expiresInDays, revokedInDays, label]
  );
}

const survivors = async (client, userId) => {
  const { rows } = await client.query(`SELECT user_agent FROM refresh_tokens WHERE user_id = $1 ORDER BY user_agent`, [userId]);
  return rows.map((r) => r.user_agent);
};

// What each token is, and whether the 30-day rule should remove it.
const CASES = {
  'expired 40 days ago': { expiresInDays: -40, remove: true },
  'expired 31 days ago': { expiresInDays: -31, remove: true },
  'expired 29 days ago': { expiresInDays: -29, remove: false },
  'expired yesterday': { expiresInDays: -1, remove: false },
  'revoked 40 days ago (not yet expired)': { expiresInDays: 5, revokedInDays: -40, remove: true },
  'revoked 31 days ago (not yet expired)': { expiresInDays: 5, revokedInDays: -31, remove: true },
  'revoked 29 days ago': { expiresInDays: 5, revokedInDays: -29, remove: false },
  'revoked just now': { expiresInDays: 5, revokedInDays: 0, remove: false },
  'active, never revoked': { expiresInDays: 7, remove: false },
  'expired long ago, revoked recently': { expiresInDays: -40, revokedInDays: -2, remove: true },
  'revoked long ago, expired recently': { expiresInDays: -2, revokedInDays: -40, remove: true },
};

test('the real SQL removes exactly the tokens that expired or were revoked more than 30 days ago', async () => {
  await withRolledBackTransaction(async (client) => {
    const { userId } = await makeUser(client);
    for (const [label, c] of Object.entries(CASES)) await addToken(client, userId, label, c);

    // Whatever else is in the database is none of this test's business; count only the rows that are ours.
    const removed = await cleanupRefreshTokens(client);
    assert.ok(removed >= Object.values(CASES).filter((c) => c.remove).length);

    const left = await survivors(client, userId);
    const expectedLeft = Object.entries(CASES).filter(([, c]) => !c.remove).map(([label]) => label).sort();
    assert.deepEqual(left, expectedLeft);
  });
});

test('a second run removes nothing more', async () => {
  await withRolledBackTransaction(async (client) => {
    const { userId } = await makeUser(client);
    for (const [label, c] of Object.entries(CASES)) await addToken(client, userId, label, c);
    await cleanupRefreshTokens(client);
    assert.equal(await cleanupRefreshTokens(client), 0);
  });
});

test('batching works in real PostgreSQL: a batch size of 2 clears 5 old tokens in three rounds and keeps the rest', async () => {
  await withRolledBackTransaction(async (client) => {
    await cleanupRefreshTokens(client); // clear any genuinely old tokens first, so the count below is only ours
    const { userId } = await makeUser(client);
    for (let i = 0; i < 5; i++) await addToken(client, userId, `old ${i}`, { expiresInDays: -60 - i });
    await addToken(client, userId, 'keep me', { expiresInDays: 3 });

    let queries = 0;
    const counting = { query: (text, params) => { queries += 1; return client.query(text, params); } };
    assert.equal(await cleanupRefreshTokens(counting, { batchSize: 2 }), 5);
    assert.equal(queries, 3, 'rounds of 2, 2, 1');
    assert.deepEqual(await survivors(client, userId), ['keep me']);
  });
});

test('it only ever touches refresh_tokens: users and parlours (and the tokens\' owners) are untouched', async () => {
  await withRolledBackTransaction(async (client) => {
    const { userId, parlourId } = await makeUser(client);
    await addToken(client, userId, 'ancient', { expiresInDays: -400 });
    const count = async (sql) => Number((await client.query(sql)).rows[0].n);
    const before = { users: await count('SELECT count(*) n FROM users'), parlours: await count('SELECT count(*) n FROM parlours'), invoices: await count('SELECT count(*) n FROM invoices') };
    await cleanupRefreshTokens(client);
    const after = { users: await count('SELECT count(*) n FROM users'), parlours: await count('SELECT count(*) n FROM parlours'), invoices: await count('SELECT count(*) n FROM invoices') };
    assert.deepEqual(after, before);
    assert.equal((await client.query('SELECT 1 FROM users WHERE id = $1 AND parlour_id = $2', [userId, parlourId])).rowCount, 1);
  });
});

test('the transaction really was rolled back: nothing from these tests is left behind', async () => {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM parlours WHERE name LIKE 'Cleanup Test %'`);
  assert.equal(rows[0].n, 0);
});
