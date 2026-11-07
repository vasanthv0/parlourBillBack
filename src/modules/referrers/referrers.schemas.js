const { z } = require('zod');
const { pageQuery } = require('../../utils/pagination');

const id = z.object({ id: z.string().uuid() });
const contact = z.string().trim().regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number');
const percent = z.number({ invalid_type_error: 'Enter a percentage' }).gt(0, 'Enter a percentage above 0').max(100, 'Cannot be more than 100')
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most 2 decimal places');
const name = z.string().trim().min(2, 'Enter the referrer’s name').max(80);

exports.list = { query: z.object({ ...pageQuery, search: z.string().trim().max(60).optional() }) };
exports.lookup = { query: z.object({ q: z.string().trim().min(1).max(60) }) };
exports.byId = { params: id };
exports.create = { body: z.object({ name, contact, percent }) };
exports.update = {
  params: id,
  body: z.object({ name, contact, percent, isActive: z.boolean() }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
};

// "Mark as paid": the amount the admin saw on screen. The server pays it out only if that is still exactly what is owed.
exports.pay = {
  params: id,
  body: z.object({
    expectedAmount: z.number({ invalid_type_error: 'Enter an amount' }).gt(0, 'Enter an amount above 0').max(10_000_000, 'That is too large')
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most 2 decimal places'),
  }),
};
