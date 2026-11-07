class AppError extends Error {
  constructor(status, message, code = 'ERROR', details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static badRequest(msg, code = 'BAD_REQUEST', details) { return new AppError(400, msg, code, details); }
  static unauthorized(msg = 'Authentication required', code = 'UNAUTHORIZED') { return new AppError(401, msg, code); }
  static forbidden(msg = 'You do not have permission to do that', code = 'FORBIDDEN') { return new AppError(403, msg, code); }
  static notFound(msg = 'Not found', code = 'NOT_FOUND') { return new AppError(404, msg, code); }
  static conflict(msg, code = 'CONFLICT') { return new AppError(409, msg, code); }
}
module.exports = AppError;
