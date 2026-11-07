const { z } = require('zod');
const { email, password } = require('../auth/auth.schemas');
const { MOBILE_FORMAT, MOBILE_MIN_DIGITS, normaliseMobile } = require('../../utils/phone');

const id = z.object({ id: z.string().uuid() });
const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

// What may be typed: 7-20 characters of digits and + - ( ) spaces. Used on its own when an existing member is edited.
const mobileFormat = z.string().trim().regex(MOBILE_FORMAT, 'Enter a valid mobile number');

// A number given to a NEW account (or typed into a changed one) must also have at least 10 digits: it is how that
// person may sign in, and it is compared by its last 10 digits. Stored exactly as typed.
const mobile = z.string().trim().superRefine((v, ctx) => {
  if (!MOBILE_FORMAT.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid mobile number' });
  else if (normaliseMobile(v) === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Enter a mobile number with at least ${MOBILE_MIN_DIGITS} digits` });
});

// Email is optional for staff (they can sign in with their mobile number instead). Blank means none.
const optionalEmail = z.preprocess(blankToNull, email.nullable().optional());

exports.mobile = mobile;
exports.mobileFormat = mobileFormat;

exports.create = {
  body: z
    .object({
      name: z.string().trim().min(2, 'Enter a name').max(80),
      email: optionalEmail,
      mobile,
      password,
      role: z.enum(['admin', 'staff']).default('staff'),
    })
    .superRefine((v, ctx) => {
      // A parlour's admin keeps an email; only staff may sign in with a mobile number alone.
      if (v.role === 'admin' && !v.email) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'Enter an email address for an admin' });
    })
    .transform((v) => ({ ...v, email: v.email ?? null })),
};

// Editing keeps the loose format: an older member's number may be shorter than 10 digits, and saving their name
// must not fail because of it. The 10-digit rule is applied by the service only when the number actually changes.
exports.update = {
  params: id,
  body: z
    .object({
      name: z.string().trim().min(2).max(80),
      mobile: mobileFormat,
      role: z.enum(['admin', 'staff']),
      isActive: z.boolean(),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
};

exports.resetPassword = { params: id, body: z.object({ password }) };
