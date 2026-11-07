const router = require('express').Router();
const validate = require('../../middleware/validate');
const { FEATURES } = require('../../config/features');
const schemas = require('./platform.schemas');
const service = require('./platform.service');

// Mounted behind authorize('super_admin'): nobody else gets here.

router.get('/features', (_req, res) => res.json({ data: FEATURES }));
router.get('/summary', async (_req, res) => res.json({ data: await service.summary() }));

router.get('/parlours', validate(schemas.list), async (req, res) => {
  const { items, meta } = await service.list(req.valid.query);
  res.json({ data: items, meta });
});
router.post('/parlours', validate(schemas.create), async (req, res) =>
  res.status(201).json({ data: await service.create(req.valid.body) }));
router.get('/parlours/:id', validate(schemas.byId), async (req, res) =>
  res.json({ data: await service.get(req.valid.params.id) }));
router.patch('/parlours/:id', validate(schemas.update), async (req, res) =>
  res.json({ data: await service.update(req.valid.params.id, req.valid.body) }));
router.patch('/parlours/:id/owner', validate(schemas.updateOwner), async (req, res) =>
  res.json({ data: await service.updateOwner(req.valid.params.id, req.valid.body) }));
router.post('/parlours/:id/owner/reset-password', validate(schemas.resetOwnerPassword), async (req, res) => {
  await service.resetOwnerPassword(req.valid.params.id, req.valid.body.password);
  res.status(204).end();
});
router.delete('/parlours/:id', validate(schemas.remove), async (req, res) => {
  await service.remove(req.valid.params.id, req.valid.body);
  res.status(204).end();
});

module.exports = router;
