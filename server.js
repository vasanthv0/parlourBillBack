const env = require('./src/config/env');
const logger = require('./src/utils/logger');

logger.configure({ level: env.log.level, format: env.log.format });

const app = require('./src/app');
const { pool } = require('./src/config/db');
const { startRefreshTokenCleanup } = require('./src/jobs/refreshTokenCleanup');

let cleanup;
const server = app.listen(env.port, () => {
  logger.info('API listening', { port: env.port, env: env.nodeEnv, logLevel: env.log.level });
  // Started here, not in app.js, so tests that load the app never start a timer.
  cleanup = startRefreshTokenCleanup({ db: pool });
});

// Finish in-flight requests, then close the pool, on deploys and Ctrl+C.
let shuttingDown = false;
const shutdown = (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  cleanup?.stop();
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(exitCode);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last resort: write the failure to the log (redacted), then stop so the host restarts a clean process.
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { err });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { err: reason });
  shutdown('unhandledRejection', 1);
});
