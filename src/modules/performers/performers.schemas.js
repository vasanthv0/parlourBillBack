const { z } = require('zod');

const id = z.object({ id: z.string().uuid() });
const name = z.string().trim().min(2, 'Enter a name').max(80);

exports.list = { query: z.object({ includeInactive: z.enum(['true', 'false']).default('false') }) };
exports.byId = { params: id };
exports.create = { body: z.object({ name }) };
exports.update = {
  params: id,
  body: z.object({ name, isActive: z.boolean() }).partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
};
