const crypto = require('node:crypto');
const logger = require('../utils/logger');

const HEADER = 'X-Request-Id';

// A caller (or a proxy in front of us) may send its own id. We keep it only if it is short and made of
// harmless characters, so it cannot be used to forge log lines; otherwise we make a fresh one.
const GOOD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;
const sanitizeRequestId = (raw) => (typeof raw === 'string' && GOOD_ID.test(raw) ? raw : null);

// Health checks and CORS pre-flights are frequent and uninteresting: logged at debug level only.
const QUIET_PATHS = new Set(['/', '/api/v1/health']);

const routeOf = (req) => {
  try {
    return req.route ? `${req.baseUrl || ''}${String(req.route.path)}` : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Gives every request an id (req.id, and the X-Request-Id response header), and writes ONE log line when
 * the response is done: method, path, status, duration, who (ids only) and the request id.
 * It never logs bodies, query strings, cookies or Authorization headers, by construction: it only reads the
 * fields named below.
 */
function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const id = sanitizeRequestId(req.headers?.['x-request-id']) ?? crypto.randomUUID();
  req.id = id;
  res.setHeader(HEADER, id);

  const path = String(req.originalUrl || req.url || '').split('?')[0]; // the query string can hold names and phone numbers
  let logged = false;

  const log = (aborted) => {
    if (logged) return;
    logged = true;
    const status = res.statusCode;
    let level = 'info';
    if (aborted || (status >= 400 && status < 500)) level = 'warn';
    else if (status >= 500) level = 'error';
    else if (req.method === 'OPTIONS' || QUIET_PATHS.has(path)) level = 'debug';

    logger[level]('request', {
      reqId: id,
      method: req.method,
      path,
      route: routeOf(req),
      status,
      durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100,
      bytes: Number(res.getHeader?.('content-length')) || undefined,
      userId: req.auth?.userId,
      parlourId: req.auth?.parlourId,
      role: req.auth?.role,
      ip: req.ip,
      ua: String(req.headers?.['user-agent'] ?? '').slice(0, 200) || undefined,
      errorCode: res.locals?.errorCode,
      aborted: aborted || undefined,
    });
  };

  res.on('finish', () => log(false));
  res.on('close', () => log(!res.writableFinished)); // the client went away before we answered
  next();
}

module.exports = requestLogger;
module.exports.sanitizeRequestId = sanitizeRequestId;
module.exports.REQUEST_ID_HEADER = HEADER;
