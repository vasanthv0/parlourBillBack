const { z } = require('zod');
const { KINDS } = require('./commission');

// A real calendar day written YYYY-MM-DD: "2026-02-30" and "2026-13-45" are refused here, not left for the database to choke on.
const isRealDay = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isRealDay, 'That is not a real date');
const id = z.object({ id: z.string().uuid() });
const twoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

// Rupees, above 0, at most 2 decimals.
const rupees = z.number({ invalid_type_error: 'Enter an amount' }).gt(0, 'Enter an amount above 0').max(10_000_000, 'That is too large').refine(twoDecimals, 'Use at most 2 decimal places');

// Both ends optional on a report: the default is the last 30 days, like the dashboard.
const range = z.object({ from: date.optional(), to: date.optional() });

exports.report = { query: range };
exports.lines = { params: id, query: range };
exports.payouts = { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }) };
exports.byId = { params: id };

// A rule is for ONE person or ONE service. A percentage is 0.01 to 100. A flat amount is rupees for each unit performed.
exports.putRule = {
  body: z.object({
    performerId: z.string().uuid().optional(),
    serviceId: z.string().uuid().optional(),
    kind: z.enum(KINDS, { errorMap: () => ({ message: 'Choose a percentage or a flat amount' }) }),
    value: z.number({ invalid_type_error: 'Enter a number' }),
  }).superRefine((b, ctx) => {
    if (!!b.performerId === !!b.serviceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['performerId'], message: 'Choose one person or one service' });
    }
    if (!(b.value > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Enter a number above 0' });
    else if (!twoDecimals(b.value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Use at most 2 decimal places' });
    else if (b.kind === 'percent' && b.value > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'A percentage cannot be more than 100' });
    else if (b.kind === 'flat' && b.value > 100_000) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'That is too large for one service' });
  }),
};

// "Mark as paid": the person, the days the admin was looking at, and the amount they saw. The server pays out what is owed in
// those days only if it is still exactly that amount.
exports.pay = {
  body: z.object({ performerId: z.string().uuid(), from: date, to: date, expectedAmount: rupees })
    .refine((b) => b.from <= b.to, { path: ['to'], message: 'The end date cannot be before the start date' }),
};
