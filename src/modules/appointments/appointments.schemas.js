const { z } = require('zod');
const { digitsOf } = require('../../utils/phone');

const id = z.string().uuid();
const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

// A real calendar date: "2026-02-31" has the right shape but is not a day, and would otherwise reach the database.
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'That is not a real date');
// The time on the parlour's own clock, 24-hour. The server turns date + time into an instant using the parlour's time zone,
// so the browser's own time zone never decides when an appointment is.
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

// The same rule the customers page uses: 7-20 characters of digits and + - ( ) spaces, and at least 10 digits. Blank means none.
const phone = z.preprocess(blankToNull, z.string().trim().superRefine((v, ctx) => {
  if (!/^[0-9+\-\s()]{7,20}$/.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid phone number' });
  else if (digitsOf(v).length < 10) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a phone number with at least 10 digits' });
}).nullable());
const notes = z.preprocess(blankToNull, z.string().trim().max(300).nullable());

const items = z.array(z.object({ serviceId: id, quantity: z.number().int().min(1).max(10) })).min(1, 'Choose at least one service').max(10);
const duration = z.number().int().min(5, 'At least 5 minutes').max(600, 'At most 10 hours');

exports.day = { query: z.object({ date: date.optional() }) };
exports.byId = { params: z.object({ id }) };

exports.create = {
  body: z.object({
    kind: z.enum(['booked', 'walk_in']),
    // A booking says when. A walk-in is added at the moment they arrive, so it never carries a time.
    date: date.optional(),
    time: time.optional(),
    customerId: id.nullish(),
    customerName: z.string().trim().min(2, 'Enter the customer name').max(80).optional(),
    customerPhone: phone.optional(),
    performerId: id.nullish(),
    items,
    durationMin: duration.optional(),
    notes: notes.optional(),
    // Set by the screen after the person has seen "already has someone at that time" and chosen to book anyway.
    allowOverlap: z.boolean().default(false),
  }).superRefine((b, ctx) => {
    const add = (path, message) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (b.kind === 'booked') {
      if (!b.date) add('date', 'Choose the date');
      if (!b.time) add('time', 'Choose the time');
      if (!b.customerId && !b.customerName) add('customerName', 'Enter the customer name or choose a saved customer');
    } else {
      if (b.date || b.time) add('time', 'A walk-in is added when they arrive, so it has no time');
    }
  }),
};

exports.update = {
  params: z.object({ id }),
  body: z.object({
    date: date,
    time: time,
    customerId: id.nullable(),
    customerName: z.string().trim().min(2, 'Enter the customer name').max(80),
    customerPhone: phone,
    performerId: id.nullable(),
    items,
    durationMin: duration,
    notes,
    allowOverlap: z.boolean(),
  }).partial().superRefine((b, ctx) => {
    if (Object.keys(b).filter((k) => k !== 'allowOverlap').length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Nothing to update' });
    if (!!b.date !== !!b.time) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [b.date ? 'time' : 'date'], message: 'Send the date and the time together' });
  }),
};

exports.start = {
  params: z.object({ id }),
  body: z.object({ performerId: id.nullish(), allowOverlap: z.boolean().default(false) }),
};
exports.cancel = {
  params: z.object({ id }),
  body: z.object({ reason: z.preprocess(blankToNull, z.string().trim().max(200).nullable()).optional() }),
};
exports.reminder = {
  params: z.object({ id }),
  query: z.object({ phone: z.string().trim().max(25).optional() }),
};
