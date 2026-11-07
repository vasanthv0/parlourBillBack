const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./reports.schemas');
const service = require('./reports.service');

// Parlour-wide analytics are admin only.
router.get('/summary', authorize('admin'), requireFeature('page.dashboard'), validate(schemas.summary), async (req, res) =>
  res.json({ data: await service.summary(req.auth.parlourId, req.valid.query, { performers: await requireFeature.isOn(req.auth.parlourId, 'page.performers') }) }));

// Everyone can see their own day.
router.get('/my-day', async (req, res) => res.json({ data: await service.myDay(req.auth) }));

module.exports = router;
