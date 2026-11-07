const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const json = (message) => ({ error: { code: 'RATE_LIMITED', message } });

exports.apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.api.rateLimit, // 600 unless API_RATE_LIMIT says otherwise
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: json('Too many requests. Please slow down.'),
});

exports.authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.auth.rateLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: json('Too many attempts. Try again in a few minutes.'),
});

// Attendance calls (location checks, check-in, check-out) are counted per signed-in person, not per IP,
// because a shared salon tablet puts every staff member behind one address.
exports.attendanceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  keyGenerator: (req) => `attendance:${req.auth.userId}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: json('Too many attendance requests. Please wait a few minutes.'),
});

// Attendance by Staff is counted per signed-in person too, and separately from their own attendance above. Someone at the counter may
// record a whole team's check-ins in a few minutes, so the allowance is larger.
exports.performerAttendanceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  keyGenerator: (req) => `performer-attendance:${req.auth.userId}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: json('Too many attendance requests. Please wait a few minutes.'),
});
