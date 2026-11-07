const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./referrers.schemas');
const service = require('./referrers.service');

// Everything here needs the Referrals page switched on for the parlour.
router.use(requireFeature('page.referrals'));

// The billing counter (admin or staff) can look a referrer up by name or ID. That is all staff can do here.
// Must come before '/:id'.
router.get('/lookup', validate(schemas.lookup), async (req, res) =>
  res.json({ data: await service.lookup(req.auth.parlourId, req.valid.query.q) }));

// Managing referrers, and seeing what they have earned, is for the parlour admin.
router.get('/', authorize('admin'), validate(schemas.list), async (req, res) => {
  const { items, meta } = await service.list(req.auth.parlourId, req.valid.query);
  res.json({ data: items, meta });
});
router.post('/', authorize('admin'), requireFeature('action.referrals.add'), validate(schemas.create), async (req, res) =>
  res.status(201).json({ data: await service.create(req.auth.parlourId, req.valid.body) }));
router.get('/:id', authorize('admin'), validate(schemas.byId), async (req, res) =>
  res.json({ data: await service.get(req.auth.parlourId, req.valid.params.id) }));
router.patch('/:id', authorize('admin'), validate(schemas.update), async (req, res) =>
  res.json({ data: await service.update(req.auth.parlourId, req.valid.params.id, req.valid.body) }));
// Recording that a referrer has been paid is its own button, so it has its own switch.
router.post('/:id/pay', authorize('admin'), requireFeature('action.referrals.pay'), validate(schemas.pay), async (req, res) =>
  res.status(201).json({ data: await service.pay(req.auth, req.valid.params.id, req.valid.body) }));
router.delete('/:id', authorize('admin'), validate(schemas.byId), async (req, res) => {
  await service.remove(req.auth.parlourId, req.valid.params.id);
  res.status(204).end();
});

module.exports = router;
