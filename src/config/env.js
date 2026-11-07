require('dotenv').config();
const { z } = require('zod');

// An empty KEY= line in .env means "not set", not "invalid".
const blankToUndefined = (v) => (v === '' ? undefined : v);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  CLIENT_URL: z.string().default('http://localhost:4200'),

  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_USER: z.string().default('postgres'),
  DB_PASS: z.string().default(''),
  DB_NAME: z.string().default('parlourbill'),
  DB_SSL: z.enum(['true', 'false']).default('false'),

  ACCESS_TOKEN_SECRET: z
    .string({ required_error: 'ACCESS_TOKEN_SECRET is required' })
    .min(32, 'ACCESS_TOKEN_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  // Max sign-in / sign-up requests per IP per 15 minutes.
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(20),
  // Requests per IP per 15 minutes across the whole API. Only raise it for the end-to-end tests, which all come from one IP.
  API_RATE_LIMIT: z.coerce.number().int().min(1).default(600),
  // Added to 10-digit phone numbers when building WhatsApp links (91 = India).
  WHATSAPP_DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/, 'digits only, e.g. 91').default('91'),

  // Logging. "info" is right for production; "debug" also shows health checks and CORS pre-flights.
  // "json" = one JSON object per line (what log search tools want); "pretty" = short readable lines.
  // LOG_FORMAT unset (or empty) means json in production and pretty everywhere else.
  LOG_LEVEL: z.preprocess(blankToUndefined, z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info')),
  LOG_FORMAT: z.preprocess(blankToUndefined, z.enum(['json', 'pretty']).optional()),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const e = parsed.data;
const isProd = e.NODE_ENV === 'production';

module.exports = {
  isProd,
  nodeEnv: e.NODE_ENV,
  port: e.PORT,
  clientOrigins: e.CLIENT_URL.split(',').map((s) => s.trim()).filter(Boolean),
  db: {
    url: e.DATABASE_URL,
    host: e.DB_HOST,
    port: e.DB_PORT,
    user: e.DB_USER,
    password: e.DB_PASS,
    database: e.DB_NAME,
    ssl: e.DB_SSL === 'true',
  },
  auth: {
    accessSecret: e.ACCESS_TOKEN_SECRET,
    accessTtl: e.ACCESS_TOKEN_TTL,
    refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    issuer: 'parlourbill-api',
    audience: 'parlourbill-web',
    rateLimit: e.AUTH_RATE_LIMIT,
  },
  api: { rateLimit: e.API_RATE_LIMIT },
  whatsappCountryCode: e.WHATSAPP_DEFAULT_COUNTRY_CODE,
  log: {
    level: e.LOG_LEVEL,
    format: e.LOG_FORMAT ?? (isProd ? 'json' : 'pretty'),
  },
  cookie: {
    name: 'refresh_token',
    path: '/api/v1/auth',
    sameSite: e.COOKIE_SAMESITE,
    // Browsers require Secure when SameSite=None.
    secure: isProd || e.COOKIE_SAMESITE === 'none',
  },
};
