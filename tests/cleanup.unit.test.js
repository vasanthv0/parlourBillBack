// No database and no running API: node --test tests/cleanup.unit.test.js   (or: npm run test:unit)
// The real SQL against a real database is checked by tests/cleanup.db.test.js (npm run test:db).
const test = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../src/utils/logger');
const { cleanupRefreshTokens, startRefreshTokenCleanup, RETENTION_DAYS, BATCH_SIZE, DAY_MS } = require('../src/jobs/refreshTokenCleanup');

const written = [];
logger.configure({ level: 'debug', format: 'json', sink: (level, line) => written.push({ level, entry: JSON.parse(line), line }) });

/** A database stand-in that "deletes" the counts it is given, one batch per call. */
const fakeDb = (...counts) => {
  const calls = [];
  return { calls, query: async (text, params) => { calls.push({ text, params }); return { rowCount: counts.length ? counts.shift() : 0 }; } };
};

// ───────────── the delete ─────────────

test('retention is 30 days and the batch is 1000 rows', () => {
  assert.equal(RETENTION_DAYS, 30);
  assert.equal(BATCH_SIZE, 1000);
  assert.equal(DAY_MS, 86_400_000);
});

test('the SQL removes tokens expired OR revoked more than the retention ago, and nothing else', async () => {
  const db = fakeDb(0);
  await cleanupRefreshTokens(db);
  const sql = db.calls[0].text.replace(/\s+/g, ' ');
  assert.match(sql, /DELETE FROM refresh_tokens/);
  assert.match(sql, /expires_at < now\(\) - \(\$1::int \* interval '1 day'\)/);
  assert.match(sql, /OR revoked_at < now\(\) - \(\$1::int \* interval '1 day'\)/);
  assert.deepEqual(db.calls[0].params, [30, 1000]);
  // A token that is still valid, or was revoked recently, can never match: both conditions are "older than".
  assert.equal(/expires_at\s*>|revoked_at\s*>|revoked_at IS NULL|expires_at IS NULL/.test(sql), false);
  // Deleting only ever touches refresh_tokens.
  assert.equal(/\b(users|invoices|customers|parlours)\b/i.test(sql.replace(/refresh_tokens/g, '')), false);
});

test('the SQL locks rows with SKIP LOCKED, so two servers cleaning at once never wait on or deadlock with each other', async () => {
  const db = fakeDb(0);
  await cleanupRefreshTokens(db);
  assert.match(db.calls[0].text.replace(/\s+/g, ' '), /LIMIT \$2 FOR UPDATE SKIP LOCKED/);
});

test('it works in batches until a batch comes back short, and reports the total removed', async () => {
  const db = fakeDb(1000, 1000, 250);
  assert.equal(await cleanupRefreshTokens(db), 2250);
  assert.equal(db.calls.length, 3);
});

test('nothing to delete: one query, zero removed', async () => {
  const db = fakeDb(0);
  assert.equal(await cleanupRefreshTokens(db), 0);
  assert.equal(db.calls.length, 1);
});

test('an exactly full last batch costs one extra empty query, then stops', async () => {
  const db = fakeDb(1000, 0);
  assert.equal(await cleanupRefreshTokens(db), 1000);
  assert.equal(db.calls.length, 2);
});

test('it never loops forever: at most maxBatches queries per run, the rest waits for the next run', async () => {
  const db = { calls: 0, query: async () => { db.calls += 1; return { rowCount: 1000 }; } };
  assert.equal(await cleanupRefreshTokens(db, { maxBatches: 5 }), 5000);
  assert.equal(db.calls, 5);
  const db2 = { calls: 0, query: async () => { db2.calls += 1; return { rowCount: 1000 }; } };
  await cleanupRefreshTokens(db2);
  assert.equal(db2.calls, 100, 'default cap is 100 batches (100,000 rows)');
});

test('retention and batch size can be changed, and are passed as parameters, never put into the SQL text', async () => {
  const db = fakeDb(0);
  await cleanupRefreshTokens(db, { retentionDays: 45, batchSize: 50 });
  assert.deepEqual(db.calls[0].params, [45, 50]);
  assert.equal(db.calls[0].text.includes('45'), false);
});

test('a database error is raised to the caller (the scheduler is what catches it)', async () => {
  const db = { query: async () => { throw new Error('connection terminated'); } };
  await assert.rejects(cleanupRefreshTokens(db), /connection terminated/);
});

// ───────────── the schedule ─────────────

const fakeTimers = () => {
  const t = { handle: { unrefCalled: false, unref() { this.unrefCalled = true; } }, scheduled: [], cleared: [] };
  t.setIntervalFn = (fn, ms) => { t.scheduled.push({ fn, ms }); return t.handle; };
  t.clearIntervalFn = (h) => t.cleared.push(h);
  return t;
};

test('it runs once at start, then every 24 hours, and the timer does not keep the process alive', async () => {
  written.length = 0;
  const timers = fakeTimers();
  const runs = [];
  const job = startRefreshTokenCleanup({ db: 'DB', run: async (db) => { runs.push(db); return 7; }, ...timers });
  await job.firstRun;
  assert.deepEqual(runs, ['DB'], 'ran once, immediately, with the database it was given');
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].ms, 24 * 60 * 60 * 1000);
  assert.equal(timers.handle.unrefCalled, true);
  // when the timer fires:
  await timers.scheduled[0].fn();
  assert.equal(runs.length, 2);
  const info = written.filter((w) => w.entry.msg === 'refresh token cleanup');
  assert.equal(info.length, 2);
  assert.equal(info[0].entry.removed, 7);
  assert.equal(info[0].entry.retentionDays, 30);
});

test('a failing run is logged (redacted) and never throws or stops the schedule', async () => {
  written.length = 0;
  const timers = fakeTimers();
  let n = 0;
  const job = startRefreshTokenCleanup({
    db: 'DB',
    run: async () => { n += 1; if (n === 1) throw new Error('boom password=hunter2'); return 0; },
    ...timers,
  });
  await assert.doesNotReject(job.firstRun);
  const failure = written.find((w) => w.entry.msg === 'refresh token cleanup failed');
  assert.ok(failure, 'the failure was logged');
  assert.equal(failure.level, 'error');
  assert.equal(failure.line.includes('hunter2'), false);
  await timers.scheduled[0].fn(); // the next scheduled run still happens, and succeeds
  assert.equal(n, 2);
  assert.ok(written.some((w) => w.entry.msg === 'refresh token cleanup'));
});

test('a run that is still going when the next one fires is not started twice', async () => {
  const timers = fakeTimers();
  let release;
  let started = 0;
  const job = startRefreshTokenCleanup({ db: 'DB', run: () => { started += 1; return new Promise((r) => { release = r; }); }, ...timers });
  await timers.scheduled[0].fn(); // fires while the first run is still pending
  assert.equal(started, 1);
  release(0);
  await job.firstRun;
  const second = timers.scheduled[0].fn(); // the first run is over, so this one goes ahead
  assert.equal(started, 2, 'after it finished, the next run goes ahead');
  release(0);
  await second;
});

test('stop() clears the timer', () => {
  const timers = fakeTimers();
  const job = startRefreshTokenCleanup({ db: 'DB', run: async () => 0, ...timers });
  job.stop();
  assert.deepEqual(timers.cleared, [timers.handle]);
});

test('with real timers it still starts, runs, and can be stopped (the process is free to exit)', async () => {
  let ran = 0;
  const job = startRefreshTokenCleanup({ db: 'DB', run: async () => { ran += 1; return 0; }, intervalMs: 3_600_000 });
  await job.firstRun;
  assert.equal(ran, 1);
  job.stop();
});

test('server.js starts the job after listening, and app.js never does (so tests that load the app start no timer)', () => {
  const read = (f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
  assert.match(read('server.js'), /startRefreshTokenCleanup\(\{ db: pool \}\)/);
  assert.equal(/refreshTokenCleanup|startRefreshTokenCleanup/.test(read('src/app.js')), false);
});
