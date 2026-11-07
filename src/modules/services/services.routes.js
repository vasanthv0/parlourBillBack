const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./services.schemas');
const service = require('./services.service');

// Admin and staff can read the active catalogue (staff need it at the billing counter).
router.get('/', validate(schemas.list), async (req, res) => {
  // Archived services are visible to admins only.
  const includeInactive = req.valid.query.includeInactive === 'true' && req.auth.role === 'admin';
  res.json({ data: await service.list(req.auth.parlourId, { includeInactive }) });
});

// Only admins change the catalogue and prices, and only if the parlour has the Services page / Add button.
router.post('/', authorize('admin'), requireFeature('action.services.add'), validate(schemas.create), async (req, res) =>
  res.status(201).json({ data: await service.create(req.auth.parlourId, req.valid.body) }));

router.patch('/:id', authorize('admin'), requireFeature('page.services'), validate(schemas.update), async (req, res) =>
  res.json({ data: await service.update(req.auth.parlourId, req.valid.params.id, req.valid.body) }));

module.exports = router;
