const router = require('express').Router();
const authorize = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const schemas = require('./invoices.schemas');
const service = require('./invoices.service');
const requireFeature = require('../../middleware/requireFeature');

// Admin and staff create bills; staff are limited to their own bills when listing or viewing.
// Billing a saved customer needs the Customers feature; walk-in bills never do.
const needsCustomers = (req, res, next) => (req.valid.body.customerId ? requireFeature('page.customers')(req, res, next) : next());

// Naming a referrer needs the Referrals feature; combos need Combos.
const needsReferrals = (req, res, next) => (req.valid.body.referrerId ? requireFeature('page.referrals')(req, res, next) : next());
const needsCombos = (req, res, next) => (req.valid.body.items.some((i) => i.comboId) ? requireFeature('page.combos')(req, res, next) : next());

// Naming who performed a line needs the Performers page. A bill that names nobody never does.
const needsPerformers = (req, res, next) => (req.valid.body.items.some((i) => i.performedBy) ? requireFeature('page.performers')(req, res, next) : next());

// Billing a visit (appointmentId) needs the "Bill this visit" button. A bill that names no visit never does.
const needsAppointments = (req, res, next) => (req.valid.body.appointmentId ? requireFeature('action.appointments.bill')(req, res, next) : next());

// Paying a bill with ONE method is the product and is never switchable. Splitting it across methods needs the Split payment
// button, and recording a tip needs the Tip box. Both are checked here, on the server: the app only hides them.
const needsSplit = (req, res, next) => (req.valid.body.payments?.length > 1 ? requireFeature('action.payments.split')(req, res, next) : next());
const needsTip = (req, res, next) => (req.valid.body.tip > 0 ? requireFeature('action.payments.tip')(req, res, next) : next());

// Send an Idempotency-Key header (any unique id, made once per bill attempt) to make retries safe: a repeat of the
// same request returns the original bill with 200 and "Idempotent-Replay: true" instead of creating a second one.
router.post('/', validate(schemas.create), needsCustomers, needsReferrals, needsCombos, needsPerformers, needsAppointments, needsSplit, needsTip, async (req, res) => {
  const { invoice, replayed } = await service.create(req.auth, req.valid.body, { idempotencyKey: req.valid.headers['idempotency-key'] });
  if (replayed) res.set('Idempotent-Replay', 'true');
  res.status(replayed ? 200 : 201).json({ data: invoice });
});

router.get('/', validate(schemas.list), async (req, res) => {
  const { items, meta } = await service.list(req.auth, req.valid.query);
  res.json({ data: items, meta });
});

// Must come before '/:id'. Admin only.
router.get('/makers', authorize('admin'), async (req, res) => res.json({ data: await service.makers(req.auth.parlourId) }));

router.get('/:id', validate(schemas.byId), async (req, res) =>
  res.json({ data: await service.get(req.auth, req.valid.params.id) }));

// Opens WhatsApp with the bill ready to send. Needs the "Send on WhatsApp" button switched on.
router.get('/:id/whatsapp', requireFeature('action.whatsapp.send'), validate(schemas.whatsapp), async (req, res) =>
  res.json({ data: await service.whatsapp(req.auth, req.valid.params.id, req.valid.query) }));

// Voiding is an admin decision.
router.post('/:id/void', authorize('admin'), validate(schemas.void), async (req, res) =>
  res.json({ data: await service.void(req.auth, req.valid.params.id, req.valid.body) }));

module.exports = router;
