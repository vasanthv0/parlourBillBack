const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

exports.notFound = (req, _res, next) => next(AppError.notFound(`Route not found: ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND'));

// The one place errors are answered and logged. What is logged: the request id, who, which route and a
// redacted copy of the error (see utils/redact.js). Request bodies, headers and cookies are never passed in.
// Client mistakes (4xx) are not logged here: the request log line already carries the status and error code.
// eslint-disable-next-line no-unused-vars
exports.errorHandler = (err, req, res, next) => {
  const requestId = req.id;
  const where = {
    reqId: requestId,
    method: req.method,
    path: String(req.originalUrl || req.url || '').split('?')[0],
    userId: req.auth?.userId,
    parlourId: req.auth?.parlourId,
  };

  // Too late to send a proper answer: record it and drop the connection rather than send half a response.
  if (res.headersSent) {
    logger.error('error after the response had started', { ...where, err });
    return res.destroy();
  }

  const send = (status, code, message, details) => {
    res.locals.errorCode = code; // picked up by the request log line
    return res.status(status).json({ error: { code, message, details, requestId } });
  };

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error('request failed', { ...where, err });
    return send(err.status, err.code, err.message, err.details);
  }
  // body-parser / malformed JSON
  if (err.type === 'entity.parse.failed') return send(400, 'INVALID_JSON', 'Request body is not valid JSON');
  if (err.type === 'entity.too.large') return send(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  // PostgreSQL: invalid uuid text, etc.
  if (err.code === '22P02') return send(400, 'INVALID_ID', 'Invalid identifier');

  logger.error('unhandled error', { ...where, err });
  return send(500, 'INTERNAL', 'Something went wrong on our side');
};
