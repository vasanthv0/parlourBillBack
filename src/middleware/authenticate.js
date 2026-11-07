const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/tokens');

/** Requires a valid access token. Sets req.auth = { userId, parlourId, role }. */
module.exports = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(AppError.unauthorized('Authentication required'));
  }
  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub, parlourId: payload.pid, role: payload.role };
    next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    next(AppError.unauthorized(expired ? 'Session expired' : 'Invalid session', expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'));
  }
};
