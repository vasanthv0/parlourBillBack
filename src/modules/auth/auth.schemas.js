const { z } = require('zod');
const { normaliseMobile } = require('../../utils/phone');

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

// bcrypt only reads the first 72 bytes, so cap there.
const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(72, 'Use 72 characters or fewer')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

exports.password = password;
exports.email = email;

/**
 * What someone typed to sign in: an email or a mobile number.
 *   contains "@"  → an email (trimmed and lower-cased, checked like every other email)
 *   anything else → a mobile number, reduced to its last 10 digits (needs at least 10 digits)
 * An email can never pass as a mobile number or the other way round, so the two cannot be confused.
 * Returns { kind: 'email' | 'mobile', value } or null when it is neither.
 */
const parseLoginIdentifier = (raw) => {
  const text = String(raw ?? '').trim();
  if (text.includes('@')) {
    const parsed = email.safeParse(text);
    return parsed.success ? { kind: 'email', value: parsed.data } : null;
  }
  const mobile = normaliseMobile(text);
  return mobile ? { kind: 'mobile', value: mobile } : null;
};
exports.parseLoginIdentifier = parseLoginIdentifier;

// "identifier" is the field to use now. "email" is the old field name and is still accepted, so a web app that has
// not been updated yet keeps signing in. If both are sent, "identifier" wins. A problem is reported on the field the
// caller actually used, so existing clients still find it where they expect it.
exports.login = {
  body: z
    .object({
      identifier: z.string().max(254).optional(),
      email: z.string().max(254).optional(),
      password: z.string().max(72).optional(),
    })
    .superRefine((v, ctx) => {
      if (!v.password) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'Enter your password' });
      const field = v.identifier === undefined && v.email !== undefined ? 'email' : 'identifier';
      const raw = (v.identifier ?? v.email ?? '').trim();
      if (!raw) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Enter your email or mobile number' });
      else if (!parseLoginIdentifier(raw)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Enter a valid email address or mobile number' });
    })
    .transform((v) => ({ identifier: parseLoginIdentifier(v.identifier ?? v.email), password: v.password })),
};

exports.changePassword = {
  body: z.object({
    currentPassword: z.string().min(1, 'Enter your current password').max(72),
    newPassword: password,
  }),
};
