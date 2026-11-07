const { z } = require('zod');

const price = z.number({ invalid_type_error: 'Enter a price' }).min(0, 'Price cannot be negative').max(1_000_000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'Use at most 2 decimal places');

const items = z
  .array(z.object({ serviceId: z.string().uuid(), quantity: z.number().int().min(1).max(20) }))
  .min(1, 'Add at least one service')
  .max(20)
  .refine((list) => new Set(list.map((i) => i.serviceId)).size === list.length, 'List each service once and use the quantity instead');

const id = z.object({ id: z.string().uuid() });
const name = z.string().trim().min(2, 'Enter a combo name').max(80);

exports.list = { query: z.object({ includeInactive: z.enum(['true', 'false']).default('false') }) };
exports.byId = { params: id };
exports.create = { body: z.object({ name, price, items }) };
exports.update = {
  params: id,
  body: z.object({ name, price, items, isActive: z.boolean() }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
};
