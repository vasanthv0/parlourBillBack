const { z } = require('zod');
const { pageQuery } = require('../../utils/pagination');

const num = (label) => z.number({ required_error: `${label} is required`, invalid_type_error: `${label} must be a number` }).finite(`${label} must be a number`);

// One GPS reading, exactly as the browser's Geolocation API reports it.
const reading = {
  latitude: num('Latitude').min(-90, 'Latitude must be between -90 and 90').max(90, 'Latitude must be between -90 and 90'),
  longitude: num('Longitude').min(-180, 'Longitude must be between -180 and 180').max(180, 'Longitude must be between -180 and 180'),
  // metres; 0 or negative is not something a real receiver reports
  accuracy: num('Accuracy').gt(0, 'Accuracy must be greater than 0').max(100_000, 'Accuracy is not plausible'),
  // epoch milliseconds from position.timestamp
  capturedAt: z.number({ required_error: 'capturedAt is required', invalid_type_error: 'capturedAt must be a number' }).int().positive(),
};

const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isRealDate, 'That date does not exist');

// Strict: unknown keys (userId, parlourId, status …) are rejected, not silently dropped.
// Who is acting and for which parlour comes from the signed token, never from the body.
exports.locationCheck = { body: z.object(reading).strict() };

exports.action = {
  body: z
    .object({
      ...reading,
      deviceType: z.enum(['personal', 'shared'], { errorMap: () => ({ message: 'Device type must be personal or shared' }) }),
      password: z.string().min(1).max(72).optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      // On a shared salon tablet the signed-in person must prove it is them, every time.
      if (v.deviceType === 'shared' && !v.password) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'Enter your password to confirm it is you' });
      }
    }),
};

exports.settings = {
  body: z
    .object({
      latitude: reading.latitude,
      longitude: reading.longitude,
      radiusM: z.number().int('Use a whole number of metres').min(20, 'At least 20 m').max(500, 'At most 500 m').optional(),
      maxAccuracyM: z.number().int('Use a whole number of metres').min(10, 'At least 10 m').max(100, 'At most 100 m').optional(),
    })
    .strict()
    .refine((v) => !(v.latitude === 0 && v.longitude === 0), { path: ['latitude'], message: '0, 0 is not a real salon location' }),
};

exports.records = {
  query: z
    .object({
      ...pageQuery,
      from: date.optional(),
      to: date.optional(),
      userId: z.string().uuid().optional(),
    })
    .refine((q) => !q.from || !q.to || q.from <= q.to, { path: ['to'], message: 'The end date is before the start date' }),
};
