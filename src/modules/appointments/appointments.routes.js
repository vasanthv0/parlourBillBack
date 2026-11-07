const router = require('express').Router();
const validate = require('../../middleware/validate');
const requireFeature = require('../../middleware/requireFeature');
const schemas = require('./appointments.schemas');
const service = require('./appointments.service');

// Everything here needs the Appointments page switched on for the parlour. Admin and staff share the parlour's calendar.
router.use(requireFeature('page.appointments'));

// Choosing a saved customer needs the Customers page; naming a person needs the Performers page.
// A booking that uses neither (a typed name, nobody chosen yet) needs only Appointments.
const needsCustomers = (req, res, next) => (req.valid.body.customerId ? requireFeature('page.customers')(req, res, next) : next());
const needsPerformers = (req, res, next) => (req.valid.body.performerId ? requireFeature('page.performers')(req, res, next) : next());

router.get('/', validate(schemas.day), async (req, res) => res.json({ data: await service.day(req.auth, req.valid.query) }));

// Must come before '/:id'.
router.get('/queue', async (req, res) => res.json({ data: await service.queue(req.auth) }));

router.post('/', validate(schemas.create), needsCustomers, needsPerformers, async (req, res) =>
  res.status(201).json({ data: await service.create(req.auth, req.valid.body) }));

router.get('/:id', validate(schemas.byId), async (req, res) => res.json({ data: await service.get(req.auth, req.valid.params.id) }));

router.patch('/:id', validate(schemas.update), needsCustomers, needsPerformers, async (req, res) =>
  res.json({ data: await service.update(req.auth, req.valid.params.id, req.valid.body) }));

router.post('/:id/start', validate(schemas.start), needsPerformers, async (req, res) =>
  res.json({ data: await service.start(req.auth, req.valid.params.id, req.valid.body) }));

router.post('/:id/cancel', validate(schemas.cancel), async (req, res) =>
  res.json({ data: await service.cancel(req.auth, req.valid.params.id, req.valid.body) }));

router.post('/:id/no-show', validate(schemas.byId), async (req, res) =>
  res.json({ data: await service.noShow(req.auth, req.valid.params.id) }));

// The reminder: a WhatsApp link a person taps. Needs the reminder button switched on. There is no automatic sending.
router.get('/:id/reminder', requireFeature('action.appointments.remind'), validate(schemas.reminder), async (req, res) =>
  res.json({ data: await service.reminder(req.auth, req.valid.params.id, req.valid.query) }));
router.post('/:id/reminded', requireFeature('action.appointments.remind'), validate(schemas.byId), async (req, res) =>
  res.json({ data: await service.markReminded(req.auth, req.valid.params.id) }));

// There is deliberately no DELETE: a visit that does not happen is cancelled, so there is still a record of it.
// "Completed" is never set here: only billing sets it (POST /invoices with appointmentId).

module.exports = router;
