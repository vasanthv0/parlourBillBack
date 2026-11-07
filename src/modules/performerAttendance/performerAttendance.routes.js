const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const { performerAttendanceLimiter } = require('../../middleware/rateLimit');
const schemas = require('./performerAttendance.schemas');
const service = require('./performerAttendance.service');

// Attendance by Staff: a signed-in admin or staff member records attendance for performers, who do not sign in.
// Every route here needs the Attendance by Staff switch on for this parlour (the platform admin decides; the parlour cannot override it).
// This is a separate workflow from /attendance (a person's own GPS attendance): nothing here reads or writes attendance_records.
router.use(requireFeature('page.attendance_by_staff'), performerAttendanceLimiter);

// Who is acting, and for which parlour, comes only from the signed token (req.auth). The body is never trusted for it.
router.get('/today', async (req, res) => res.json({ data: await service.today(req.auth) }));

router.post('/check-in', validate(schemas.mark), async (req, res) =>
  res.status(201).json({ data: await service.checkIn(req.auth, req.valid.body) }));

router.post('/check-out', validate(schemas.mark), async (req, res) =>
  res.json({ data: await service.checkOut(req.auth, req.valid.body) }));

// History: an admin sees every record; staff see only the records they recorded themselves.
router.get('/history', validate(schemas.history), async (req, res) => {
  const { items, meta } = await service.history(req.auth, req.valid.query);
  res.json({ data: items, meta });
});

// Per-person totals for a date range: admin only.
router.get('/report', authorize('admin'), validate(schemas.report), async (req, res) =>
  res.json({ data: await service.report(req.auth, req.valid.query) }));

module.exports = router;
