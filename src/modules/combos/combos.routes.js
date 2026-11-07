const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./combos.schemas');
const service = require('./combos.service');

// Everything here needs the Combos page switched on for the parlour.
router.use(requireFeature('page.combos'));

// Staff read combos to bill them; only admins change them. Archived combos are for admins only.
router.get('/', validate(schemas.list), async (req, res) => {
  const includeInactive = req.valid.query.includeInactive === 'true' && req.auth.role === 'admin';
  res.json({ data: await service.list(req.auth.parlourId, { includeInactive }) });
});

router.post('/', authorize('admin'), requireFeature('action.combos.add'), validate(schemas.create), async (req, res) =>
  res.status(201).json({ data: await service.create(req.auth.parlourId, req.valid.body) }));
router.patch('/:id', authorize('admin'), validate(schemas.update), async (req, res) =>
  res.json({ data: await service.update(req.auth.parlourId, req.valid.params.id, req.valid.body) }));
router.delete('/:id', authorize('admin'), validate(schemas.byId), async (req, res) => {
  await service.remove(req.auth.parlourId, req.valid.params.id);
  res.status(204).end();
});

module.exports = router;
