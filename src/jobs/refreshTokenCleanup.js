// Housekeeping for the refresh_tokens table, which grows with every sign-in and every token rotation.
// Deletes tokens that expired, or were revoked, more than RETENTION_DAYS ago. Newer ones stay: a
// recently revoked token is still needed to spot a stolen token being replayed (see auth.service.refresh).
// Runs once when the server starts and then every 24 hours. Safe to run on several instances at once.
const logger = require('../utils/logger');

const RETENTION_DAYS = 30;
const BATCH_SIZE = 1000;
const MAX_BATCHES = 100;              // at most 100,000 rows per run; the rest waits for tomorrow
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete old tokens in small batches (so no long lock is held) and return how many were removed.
 * SKIP LOCKED lets two instances run at the same moment without waiting on, or deadlocking with, each other.
 * `db` is anything with query(text, params): the pg pool in the server, a fake in tests.
 */
async function cleanupRefreshTokens(db, { retentionDays = RETENTION_DAYS, batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES } = {}) {
  let removed = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { rowCount } = await db.query(
      `WITH doomed AS (
         SELECT id FROM refresh_tokens
          WHERE expires_at < now() - ($1::int * interval '1 day')
             OR revoked_at < now() - ($1::int * interval '1 day')
          LIMIT $2
            FOR UPDATE SKIP LOCKED
       )
       DELETE FROM refresh_tokens WHERE id IN (SELECT id FROM doomed)`,
      [retentionDays, batchSize]
    );
    removed += rowCount;
    if (rowCount < batchSize) break;
  }
  return removed;
}

/**
 * Run the cleanup now and then on a timer. A failure is logged and never stops the server.
 * Returns { stop, runNow }. The timer is unref()'d, so it never keeps the process alive on its own.
 */
function startRefreshTokenCleanup({ db, intervalMs = DAY_MS, run = cleanupRefreshTokens, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await run(db);
      logger.info('refresh token cleanup', { removed, retentionDays: RETENTION_DAYS });
    } catch (err) {
      logger.error('refresh token cleanup failed', { err });
    } finally {
      running = false;
    }
  };
  const done = tick(); // at server start, without delaying it
  const handle = setIntervalFn(tick, intervalMs);
  if (typeof handle?.unref === 'function') handle.unref();
  return { stop: () => clearIntervalFn(handle), runNow: tick, firstRun: done };
}

module.exports = { cleanupRefreshTokens, startRefreshTokenCleanup, RETENTION_DAYS, BATCH_SIZE, DAY_MS };
