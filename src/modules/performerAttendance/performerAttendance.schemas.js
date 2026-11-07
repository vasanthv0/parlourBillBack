const { z } = require('zod');
const { pageQuery } = require('../../utils/pagination');

const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isRealDate, 'That date does not exist');
const uuid = (message) => z.string({ required_error: message, invalid_type_error: message }).uuid(message);
const endAfterStart = [(q) => !q.from || !q.to || q.from <= q.to, { path: ['to'], message: 'The end date is before the start date' }];

// Strict: unknown keys (parlourId, userId, markedBy, workDate, checkInAt …) are rejected, not silently dropped.
// Who is acting and for which parlour comes from the signed token, and the date and time are the server's.
exports.mark = { body: z.object({ performerId: uuid('Choose a performer') }).strict() };

// 'missed_checkout' is a past day with a check-in and no check-out. A check-in from today with no check-out yet is just 'checked_in'.
const STATUSES = ['checked_in', 'checked_out', 'missed_checkout'];
exports.STATUSES = STATUSES;

exports.history = {
  query: z
    .object({
      ...pageQuery,
      from: date.optional(),
      to: date.optional(),
      performerId: uuid('Choose a performer').optional(),
      status: z.enum(STATUSES, { errorMap: () => ({ message: 'Status must be checked_in, checked_out or missed_checkout' }) }).optional(),
    })
    .refine(...endAfterStart),
};

exports.report = {
  query: z
    .object({ from: date.optional(), to: date.optional(), performerId: uuid('Choose a performer').optional() })
    .refine(...endAfterStart),
};
