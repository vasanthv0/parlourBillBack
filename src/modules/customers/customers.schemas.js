const { z } = require('zod');
const { pageQuery } = require('../../utils/pagination');
const { digitsOf } = require('../../utils/phone');

const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

// 7-20 characters of digits and + - ( ) spaces, and at least 10 actual digits. Before, "-------" passed: it has no
// digits at all, so there was nothing to compare when checking whether two customers share a number.
const phone = z.string().trim().superRefine((v, ctx) => {
  if (!/^[0-9+\-\s()]{7,20}$/.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid phone number' });
  else if (digitsOf(v).length < 10) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a phone number with at least 10 digits' });
});
const optionalEmail = z.preprocess(blankToNull, z.string().trim().toLowerCase().email('Enter a valid email').max(254).nullable());
const optionalNotes = z.preprocess(blankToNull, z.string().trim().max(500).nullable());

exports.list = { query: z.object({ ...pageQuery, search: z.string().trim().max(60).optional() }) };
exports.create = {
  body: z.object({
    name: z.string().trim().min(2, 'Enter the customer name').max(80),
    phone,
    email: optionalEmail.optional(),
    notes: optionalNotes.optional(),
  }),
};
exports.update = {
  params: z.object({ id: z.string().uuid() }),
  body: z
    .object({ name: z.string().trim().min(2).max(80), phone, email: optionalEmail, notes: optionalNotes })
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
};
exports.byId = { params: z.object({ id: z.string().uuid() }) };
