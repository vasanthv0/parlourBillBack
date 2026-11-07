// Nothing that reaches a log may contain a password, a token or a cookie. Two layers:
//   1. KEYS: any value stored under a sensitive key name (at any depth, any case) is replaced outright.
//   2. TEXT: free text is scrubbed by pattern, for secrets that end up inside a message or stack trace
//      (a JWT in an error message, a "Bearer ..." header, a bcrypt hash inside a Postgres
//      "Failing row contains (...)" line).
// This file has no dependencies, so it can be tested without a database or a .env file.

const REDACTED = '[REDACTED]';
const MAX_TEXT = 2000;      // longest string we will log
const SCAN_LIMIT = 20000;   // how much of a very long string we look at before truncating
const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ITEMS = 50;
const MAX_STACK_LINES = 15;

// Key names whose values are never logged.
const SENSITIVE_KEY = /pass(word|wd|phrase|code)|secret|token|authorization|cookie|api[-_]?key|credential|jwt|signature|hash|session|^pin$/i;

// Applied in order. Specific shapes first, then generic name=value pairs.
const TEXT_PATTERNS = [
  // JSON Web Tokens: three base64url parts.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]'],
  // Authorization header values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [REDACTED]'],
  // bcrypt hashes (how passwords are stored).
  [/\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}/g, '[REDACTED_HASH]'],
  // 64-character hex digests (how refresh tokens are stored).
  [/\b[a-f0-9]{64}\b/gi, '[REDACTED_HEX]'],
  // name=value, name: value and "name":"value" where the name is sensitive (covers cookie and set-cookie text).
  [
    /(["']?[\w.-]*(?:pass(?:word|wd|phrase|code)|secret|token|authorization|cookie|api[-_]?key|credential)[\w.-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
    '$1[REDACTED]',
  ],
  // Postgres puts the whole failing row (password hash included) into the detail line of NOT NULL / CHECK errors.
  [/Failing row contains \([\s\S]*$/, 'Failing row contains ([row omitted])'],
];

/** Scrub secrets out of a string and cap its length. */
function scrub(text) {
  let s = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  for (const [pattern, replacement] of TEXT_PATTERNS) s = s.replace(pattern, replacement);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…[truncated]` : s;
}

const isSensitiveKey = (key) => SENSITIVE_KEY.test(key);

const read = (obj, key) => {
  try { return obj[key]; } catch { return '[unreadable]'; }
};

/**
 * An Error as plain, scrubbed data. Keeps what helps debugging (type, message, SQLSTATE code,
 * constraint and table names, stack) and leaves out everything else a database or HTTP library
 * may have hung on the error: queries, parameters, request config, headers.
 */
function serializeError(err, depth = 0, seen = new WeakSet()) {
  if (seen.has(err)) return '[Circular]';
  seen.add(err);
  try {
    const out = { name: String(read(err, 'name') ?? 'Error'), message: scrub(String(read(err, 'message') ?? '')) };
    for (const key of ['code', 'status', 'statusCode']) {
      const v = read(err, key);
      if (typeof v === 'string') out[key] = scrub(v);
      else if (typeof v === 'number') out[key] = v;
    }
    // PostgreSQL error fields. `detail` can quote row values, so it goes through the scrubber.
    for (const key of ['severity', 'constraint', 'table', 'column', 'schema', 'routine']) {
      const v = read(err, key);
      if (typeof v === 'string') out[key] = scrub(v);
    }
    const detail = read(err, 'detail');
    if (typeof detail === 'string') out.detail = scrub(detail);
    if (err.details !== undefined) out.details = redact(err.details, depth + 1, seen); // AppError field messages
    const stack = read(err, 'stack');
    if (typeof stack === 'string') out.stack = scrub(stack.split('\n').slice(0, MAX_STACK_LINES).join('\n'));
    const cause = read(err, 'cause');
    if (cause !== undefined && depth < MAX_DEPTH) out.cause = redact(cause, depth + 1, seen);
    return out;
  } finally {
    seen.delete(err);
  }
}

/** Copy of any value that is safe to log. Never throws, never mutates its input. */
function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string': return scrub(value);
    case 'number': return Number.isFinite(value) ? value : String(value);
    case 'boolean': return value;
    case 'bigint': return value.toString();
    case 'function':
    case 'symbol': return undefined;
    default: break;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return serializeError(value, depth, seen);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Object]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1, seen));
      if (value.length > MAX_ITEMS) out.push(`[${value.length - MAX_ITEMS} more]`);
      return out;
    }
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, MAX_KEYS)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(read(value, key), depth + 1, seen);
    }
    if (keys.length > MAX_KEYS) out['[truncated]'] = `${keys.length - MAX_KEYS} more keys`;
    return out;
  } finally {
    seen.delete(value);
  }
}

module.exports = { redact, scrub, serializeError, isSensitiveKey, REDACTED };
