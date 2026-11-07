const { z } = require('zod');
const AppError = require('../utils/AppError');

/**
 * validate({ body, query, params, headers }) with zod schemas.
 * Parsed values land on req.valid.{body,query,params,headers} (Express 5 makes req.query read-only).
 * Header names arrive lower-case. Unknown headers are dropped from req.valid.headers, never rejected.
 */
module.exports = (schemas) => (req, _res, next) => {
  req.valid = {};
  const fields = {};
  for (const part of ['params', 'query', 'body', 'headers']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (result.success) {
      req.valid[part] = result.data;
    } else {
      for (const issue of result.error.issues) {
        fields[issue.path.join('.') || part] = issue.message;
      }
    }
  }
  if (Object.keys(fields).length) {
    return next(AppError.badRequest('Please check the highlighted fields', 'VALIDATION_ERROR', fields));
  }
  next();
};

module.exports.z = z;
