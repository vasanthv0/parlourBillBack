const AppError = require('../utils/AppError');

// A custom header forces a CORS preflight, so a third-party page cannot trigger
// cookie-based endpoints (refresh / logout) with a plain form POST.
module.exports = (req, _res, next) => {
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    return next(AppError.forbidden('Missing required header', 'CSRF_BLOCKED'));
  }
  next();
};
