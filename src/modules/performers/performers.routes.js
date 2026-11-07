const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./performers.schemas');
const service = require('./performers.service');

// Everything here needs the Performers page switched on for the parlour.
router.use(requireFeature('page.performers'));

// The billing counter (admin or staff) reads the list to choose "Performed by". Staff get active names and nothing else.
router.get('/', validate(schemas.list), async (req, res) => res.json({ data: await service.list(req.auth, req.valid.query) }));

// Managing the list is for the parlour admin.
router.post('/', authorize('admin'), requireFeature('action.performers.add'), validate(schemas.create), async (req, res) =>
  res.status(201).json({ data: await service.create(req.auth.parlourId, req.valid.body) }));
router.patch('/:id', authorize('admin'), validate(schemas.update), async (req, res) =>
  res.json({ data: await service.update(req.auth.parlourId, req.valid.params.id, req.valid.body) }));
router.delete('/:id', authorize('admin'), validate(schemas.byId), async (req, res) => {
  await service.remove(req.auth.parlourId, req.valid.params.id);
  res.status(204).end();
});

module.exports = router;
