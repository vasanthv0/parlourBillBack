const { z } = require('zod');
const { pageQuery } = require('../../utils/pagination');
const { METHODS } = require('./payments');

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const money = z.number().min(0, 'Cannot be negative').max(10_000_000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most 2 decimal places');

// One payment of a split bill is a real amount: a method that was not used is left out, not sent as 0.
const positiveMoney = money.refine((n) => n > 0, 'Enter an amount above 0');

// Optional. Made once per bill attempt by the client, so that sending the same request twice cannot make two bills.
const idempotencyKey = z.string().trim()
  .min(8, 'Use 8 to 128 characters')
  .max(128, 'Use 8 to 128 characters')
  .regex(/^[A-Za-z0-9_.:-]+$/, 'Use only letters, numbers and - _ . :');

exports.create = {
  headers: z.object({ 'idempotency-key': idempotencyKey.optional() }),
  body: z.object({
    customerId: z.string().uuid().nullish(),
    walkInName: z.string().trim().max(80).optional(),
    // Each line is either one service or one combo, and may name the person who performed it (a name from the Performers list).
    items: z
      .array(
        z.object({ serviceId: z.string().uuid().optional(), comboId: z.string().uuid().optional(), performedBy: z.string().uuid().nullish(), quantity: z.number().int().min(1).max(50) })
          .refine((i) => !!i.serviceId !== !!i.comboId, 'Each line must be a service or a combo')
      )
      .min(1, 'Add at least one service')
      .max(30),
    referrerId: z.string().uuid().nullish(),
    discount: money.default(0),
    // How it was paid: EITHER paymentMethod (the whole bill by one method, as before) OR payments (one or more
    // { method, amount }, which must add up to the bill total exactly: the server checks that, in whole paise).
    paymentMethod: z.enum(METHODS).optional(),
    payments: z.array(z.object({ method: z.enum(METHODS), amount: positiveMoney })).min(1, 'Add at least one payment').max(METHODS.length).optional(),
    // Extra money for the staff. Not part of the bill total, not taxed, not revenue.
    tip: money.default(0),
    notes: z.string().trim().max(300).optional(),
    // Billing a visit from the Appointments page: the visit is closed by this bill, in the same transaction.
    appointmentId: z.string().uuid().nullish(),
  }).superRefine((body, ctx) => {
    if (body.paymentMethod && body.payments) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payments'], message: 'Send either paymentMethod or payments, not both' });
    } else if (!body.paymentMethod && !body.payments) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentMethod'], message: 'Choose how the bill was paid' });
    }
    const seen = new Set();
    (body.payments ?? []).forEach((p, i) => {
      if (seen.has(p.method)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payments', i, 'method'], message: 'Each method can be used once. Combine its amounts.' });
      seen.add(p.method);
    });
  }),
};

exports.list = {
  query: z.object({
    ...pageQuery,
    from: date.optional(),
    to: date.optional(),
    status: z.enum(['paid', 'void']).optional(),
    createdBy: z.string().uuid().optional(),
    search: z.string().trim().max(60).optional(),
  }),
};

exports.byId = { params: z.object({ id: z.string().uuid() }) };

exports.whatsapp = {
  params: z.object({ id: z.string().uuid() }),
  query: z.object({ phone: z.string().trim().max(25).optional() }),
};

exports.void = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ reason: z.string().trim().min(3, 'Give a short reason').max(200) }),
};
