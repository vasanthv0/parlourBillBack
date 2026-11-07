const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./commissions.schemas');
const service = require('./commissions.service');

// Commissions are for the parlour admin, and need the Commissions page switched on (which itself needs Performers).
// Staff never see what anyone earns.
router.use(authorize('admin'), requireFeature('page.commissions'));

router.get('/', validate(schemas.report), async (req, res) => res.json({ data: await service.report(req.auth.parlourId, req.valid.query) }));
router.get('/payouts', validate(schemas.payouts), async (req, res) => res.json({ data: await service.payouts(req.auth.parlourId, req.valid.query) }));
router.get('/rules', async (req, res) => res.json({ data: await service.rules(req.auth.parlourId) }));
router.put('/rules', validate(schemas.putRule), async (req, res) => res.json({ data: await service.putRule(req.auth.parlourId, req.valid.body) }));
router.delete('/rules/:id', validate(schemas.byId), async (req, res) => {
  await service.removeRule(req.auth.parlourId, req.valid.params.id);
  res.status(204).end();
});
router.get('/performers/:id/lines', validate(schemas.lines), async (req, res) =>
  res.json({ data: await service.lines(req.auth.parlourId, req.valid.params.id, req.valid.query) }));

// Recording that someone has been paid is its own button, so it has its own switch.
router.post('/pay', requireFeature('action.commissions.pay'), validate(schemas.pay), async (req, res) =>
  res.status(201).json({ data: await service.pay(req.auth, req.valid.body) }));

module.exports = router;
