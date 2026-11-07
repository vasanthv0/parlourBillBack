const router = require('express').Router();
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./customers.schemas');
const service = require('./customers.service');

// Everything here needs the Customers feature.
router.use(requireFeature('page.customers'));

// Admin and staff both manage customers at the counter. Tenant scoping comes from the token, never the URL.
router.get('/', validate(schemas.list), async (req, res) => {
  const { items, meta } = await service.list(req.auth.parlourId, req.valid.query);
  res.json({ data: items, meta });
});
router.post('/', validate(schemas.create), async (req, res) =>
  res.status(201).json({ data: await service.create(req.auth.parlourId, req.valid.body) }));
router.get('/:id', validate(schemas.byId), async (req, res) =>
  res.json({ data: await service.get(req.auth.parlourId, req.valid.params.id) }));
router.patch('/:id', validate(schemas.update), async (req, res) =>
  res.json({ data: await service.update(req.auth.parlourId, req.valid.params.id, req.valid.body) }));

module.exports = router;
