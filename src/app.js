const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const { pool } = require('./config/db');
const requestLogger = require('./middleware/requestLogger');
const authenticate = require('./middleware/authenticate');
const authorize = require('./middleware/authorize');
const { apiLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.set('trust proxy', 1); // running behind a proxy (Render, Nginx, etc.)
app.disable('x-powered-by');
app.use(requestLogger); // first, so every request gets an id and a log line, even ones refused further down
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Non-browser clients send no Origin header; browsers must be on the allow-list.
      if (!origin || env.clientOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    // So the app can read them: the id to quote when reporting a problem, and whether a bill was a replay.
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replay'],
  })
);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.get('/', (_req, res) => res.json({ name: 'Parlour billing API', status: 'ok' }));

const api = express.Router();
api.use(apiLimiter);

api.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});

// Public: sign-in and token refresh. There is no public sign-up: the platform admin creates parlours.
api.use('/auth', require('./modules/auth/auth.routes'));

// Everything below requires a signed-in user. parlourId is taken from the token, never from the request.
api.use(authenticate);

// Platform admin (the developer): creates and manages parlours. Belongs to no parlour.
api.use('/platform', authorize('super_admin'), require('./modules/platform/platform.routes'));

// Everything below belongs to a parlour, so the platform admin (who has none) is kept out.
const tenant = authorize('admin', 'staff');

// Shared by admin and staff.
api.use('/parlour', tenant, require('./modules/parlour/parlour.routes'));
api.use('/services', tenant, require('./modules/services/services.routes'));
api.use('/customers', tenant, require('./modules/customers/customers.routes'));
api.use('/combos', tenant, require('./modules/combos/combos.routes'));
api.use('/referrers', tenant, require('./modules/referrers/referrers.routes'));
// The people who perform services (names only; admin manages, the billing counter reads) and the commission they earn (admin only).
api.use('/performers', tenant, require('./modules/performers/performers.routes'));
api.use('/commissions', tenant, require('./modules/commissions/commissions.routes'));
// The calendar and the walk-in queue are shared by admin and staff; each route checks the Appointments switch.
api.use('/appointments', tenant, require('./modules/appointments/appointments.routes'));
api.use('/invoices', tenant, require('./modules/invoices/invoices.routes'));
api.use('/reports', tenant, require('./modules/reports/reports.routes'));
// Admin and staff mark their own attendance; the routes themselves limit settings and the team log to admins.
api.use('/attendance', tenant, require('./modules/attendance/attendance.routes'));
// Attendance by Staff: admin and staff record check-in and check-out for performers (who do not sign in). A separate workflow from /attendance;
// every route checks the Attendance by Staff switch, and the admin-only report limits itself to admins.
api.use('/performer-attendance', tenant, require('./modules/performerAttendance/performerAttendance.routes'));

// Parlour admin only.
api.use('/staff', authorize('admin'), require('./modules/staff/staff.routes'));

app.use('/api/v1', api);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
