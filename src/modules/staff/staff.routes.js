const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./staff.schemas');
const service = require('./staff.service');

// Admin only, and only if the Team page is switched on for this parlour.
router.use(authorize('admin'), requireFeature('page.team'));

router.get('/', async (req, res) => res.json({ data: await service.list(req.auth.parlourId) }));

router.post('/', requireFeature('action.team.add'), validate(schemas.create), async (req, res) =>
  res.status(201).json({ data: await service.create(req.auth.parlourId, req.valid.body) }));

// Editing details and deactivating are two different buttons, so each is switched on its own.
// A request that does both needs both switches on.
const gateUpdate = (req, res, next) => {
  const body = req.valid.body;
  const needed = [];
  if ('name' in body || 'role' in body || 'mobile' in body) needed.push('action.team.edit');
  if ('isActive' in body) needed.push('action.team.deactivate');
  return needed.length ? requireFeature(...needed)(req, res, next) : next();
};

router.patch('/:id', validate(schemas.update), gateUpdate, async (req, res) =>
  res.json({ data: await service.update(req.auth, req.valid.params.id, req.valid.body) }));

router.post('/:id/reset-password', requireFeature('action.team.reset'), validate(schemas.resetPassword), async (req, res) => {
  await service.resetPassword(req.auth.parlourId, req.valid.params.id, req.valid.body.password);
  res.status(204).end();
});

module.exports = router;
