const { z } = require('zod');

const money = z.number({ invalid_type_error: 'Enter a price' }).min(0, 'Price cannot be negative').max(1_000_000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most 2 decimal places');

// Optional. A SAC (services accounting code) is 6 digits, e.g. 999721 for hair services. Blank clears it.
const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
const sacCode = z.preprocess(blankToNull, z.string().trim().regex(/^\d{6}$/, 'A SAC code is 6 digits, like 999721').nullable());

const fields = {
  name: z.string().trim().min(2, 'Enter a service name').max(80),
  category: z.string().trim().min(1).max(40),
  price: money,
  durationMin: z.number().int().min(5, 'At least 5 minutes').max(600),
  sacCode,
  isActive: z.boolean(),
};

exports.list = { query: z.object({ includeInactive: z.enum(['true', 'false']).default('false') }) };

exports.create = {
  body: z.object({
    name: fields.name,
    category: fields.category.default('General'),
    price: fields.price,
    durationMin: fields.durationMin.default(30),
    sacCode: fields.sacCode.optional(),
  }),
};

exports.update = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object(fields).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
};
