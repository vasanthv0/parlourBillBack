const { z } = require('zod');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

exports.summary = { query: z.object({ from: date.optional(), to: date.optional() }) };
