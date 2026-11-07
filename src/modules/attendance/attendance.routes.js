const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const { attendanceLimiter } = require('../../middleware/rateLimit');
const schemas = require('./attendance.schemas');
const service = require('./attendance.service');

// Everything here needs the Attendance page to be switched on for this parlour, and is limited per person.
router.use(requireFeature('page.attendance'), attendanceLimiter);

// ── Admin and staff: their own attendance ─────────────────────────────────────────────
// Who is acting, and for which parlour, comes only from the signed token (req.auth). The body is never trusted for it.
router.get('/today', async (req, res) => res.json({ data: await service.today(req.auth) }));

router.post('/location-check', validate(schemas.locationCheck), async (req, res) =>
  res.json({ data: await service.locationCheck(req.auth, req.valid.body) }));

router.post('/check-in', validate(schemas.action), async (req, res) =>
  res.status(201).json({ data: await service.checkIn(req.auth, req.valid.body) }));

router.post('/check-out', validate(schemas.action), async (req, res) =>
  res.json({ data: await service.checkOut(req.auth, req.valid.body) }));

// ── Admin only: the salon's location and the team's records ───────────────────────────
router.get('/settings', authorize('admin'), async (req, res) => res.json({ data: await service.getSettings(req.auth) }));

router.put('/settings', authorize('admin'), validate(schemas.settings), async (req, res) =>
  res.json({ data: await service.saveSettings(req.auth, req.valid.body) }));

router.get('/records', authorize('admin'), validate(schemas.records), async (req, res) => {
  const { items, meta } = await service.list(req.auth, req.valid.query);
  res.json({ data: items, meta });
});

module.exports = router;
