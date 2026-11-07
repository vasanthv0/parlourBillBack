const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./parlour.schemas');
const service = require('./parlour.service');

router.get('/', async (req, res) => res.json({ data: await service.get(req.auth.parlourId) }));

router.patch('/', authorize('admin'), requireFeature('page.settings'), validate(schemas.update), async (req, res) =>
  res.json({ data: await service.update(req.auth.parlourId, req.valid.body) }));

module.exports = router;
