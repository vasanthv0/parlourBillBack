const { query } = require('../config/db');
const AppError = require('../utils/AppError');
const { effectiveFeatures } = require('../config/features');

/** What this parlour can use right now. Read from the database every time, so a change by the platform admin is immediate. */
const featuresOf = async (parlourId) => {
  const { rows } = await query(`SELECT features FROM parlours WHERE id = $1`, [parlourId]);
  return effectiveFeatures(rows[0]?.features);
};

/**
 * Blocks the request unless every named feature is on for the caller's parlour.
 * Reads the switch from the database on each call, so a change by the platform admin takes effect immediately
 * (the web app only hides things; this is what actually refuses them).
 */
module.exports = (...keys) => async (req, _res, next) => {
  const features = await featuresOf(req.auth.parlourId);
  if (keys.some((k) => !features[k])) {
    return next(AppError.forbidden('This feature is not enabled for your parlour.', 'FEATURE_DISABLED'));
  }
  next();
};

/** For code that must ADAPT to a switch instead of refusing: is this feature on for this parlour? */
module.exports.isOn = async (parlourId, key) => !!(await featuresOf(parlourId))[key];
