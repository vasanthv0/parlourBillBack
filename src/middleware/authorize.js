const AppError = require('../utils/AppError');

/** authorize('admin') or authorize('admin', 'staff'). Must run after authenticate. */
module.exports = (...roles) => (req, _res, next) => {
  if (!req.auth) return next(AppError.unauthorized());
  if (!roles.includes(req.auth.role)) return next(AppError.forbidden());
  next();
};
