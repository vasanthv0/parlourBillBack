// No database and no running API: node --test tests/logging.unit.test.js   (or: npm run test:unit)
// The point of these tests: passwords, tokens and cookies must never reach a log line, whatever the shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { redact, scrub, serializeError, REDACTED } = require('../src/utils/redact');
const logger = require('../src/utils/logger');
const requestLogger = require('../src/middleware/requestLogger');
const { errorHandler, notFound } = require('../src/middleware/errorHandler');
const AppError = require('../src/utils/AppError');

// Things that must never appear in any log output below.
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicGlkIjoiYWJjIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const BCRYPT = `$2b$12$${'a'.repeat(53)}`;
const SHA256 = 'a1b2c3d4'.repeat(8);
const SECRETS = ['hunter2', 'Secret123', 'refresh-cookie-value-123', 'bearer-token-value-456', JWT, 'dozjgNryP4J3jVmNHl0w5N', BCRYPT, SHA256];
const assertClean = (text, label = 'output') => {
  for (const secret of SECRETS) assert.equal(String(text).includes(secret), false, `${label} contains the secret ${secret.slice(0, 18)}…`);
};

// Capture what the logger would write instead of printing it.
const written = [];
logger.configure({ level: 'debug', format: 'json', sink: (level, line) => written.push({ level, line, entry: JSON.parse(line) }) });
const reset = () => { written.length = 0; };

// ───────────── redact ─────────────

test('redact: values under sensitive keys are replaced, at any depth and in any letter case', () => {
  const out = redact({
    name: 'Riya',
    password: 'hunter2', Password: 'hunter2', newPassword: 'hunter2', confirmPassword: 'hunter2', currentPassword: 'hunter2',
    passwordHash: BCRYPT, password_hash: BCRYPT,
    accessToken: JWT, refresh_token: 'refresh-cookie-value-123', token_hash: SHA256,
    Authorization: 'Bearer bearer-token-value-456', cookie: 'refresh_token=refresh-cookie-value-123', 'set-cookie': ['refresh_token=refresh-cookie-value-123'],
    'x-api-key': 'k', client_secret: 's', jwt: JWT,
    nested: { deeper: [{ cookie: 'a=b', ok: 'visible' }] },
  });
  assert.equal(out.name, 'Riya');
  assert.equal(out.nested.deeper[0].ok, 'visible');
  assert.equal(out.nested.deeper[0].cookie, REDACTED);
  for (const key of ['password', 'Password', 'newPassword', 'confirmPassword', 'currentPassword', 'passwordHash', 'password_hash', 'accessToken',
    'refresh_token', 'token_hash', 'Authorization', 'cookie', 'set-cookie', 'x-api-key', 'client_secret', 'jwt']) {
    assert.equal(out[key], REDACTED, `${key} should be redacted`);
  }
  assertClean(JSON.stringify(out));
});

test('redact: ordinary fields that merely look similar are left alone', () => {
  const out = redact({ idempotencyKey: 'abc12345', passed: true, key: 'k', userId: 'u1', parlourId: 'p1', path: '/api/v1/invoices' });
  assert.deepEqual(out, { idempotencyKey: 'abc12345', passed: true, key: 'k', userId: 'u1', parlourId: 'p1', path: '/api/v1/invoices' });
});

test('redact: copes with circular references, huge values, odd types and never mutates its input', () => {
  const loop = { a: 1 };
  loop.self = loop;
  const input = { loop, big: 'x'.repeat(5000), many: Array.from({ length: 200 }, (_, i) => i), n: NaN, inf: Infinity, big2: 10n, fn: () => 1, sym: Symbol('s'), d: new Date('2026-10-31T00:00:00Z'), buf: Buffer.from('secret-bytes'), pwd: 'hunter2' };
  const before = JSON.stringify({ ...input, loop: undefined, buf: undefined, big2: undefined, fn: undefined, sym: undefined });
  const out = redact(input);
  assert.equal(out.loop.self, '[Circular]');
  assert.ok(out.big.length < 2100 && out.big.endsWith('[truncated]'));
  assert.equal(out.many.length, 51);
  assert.equal(out.many[50], '[150 more]');
  assert.equal(out.n, 'NaN');
  assert.equal(out.big2, '10');
  assert.equal('fn' in out && out.fn !== undefined, false);
  assert.equal(out.d, '2026-10-31T00:00:00.000Z');
  assert.equal(out.buf, '[Buffer 12 bytes]');
  assert.equal(JSON.stringify({ ...input, loop: undefined, buf: undefined, big2: undefined, fn: undefined, sym: undefined }), before, 'input was not changed');
  assert.equal(input.pwd, 'hunter2');
});

test('redact: a very deep structure is cut off instead of overflowing the stack', () => {
  let deep = { v: 'bottom' };
  for (let i = 0; i < 50; i++) deep = { next: deep };
  assert.doesNotThrow(() => JSON.stringify(redact(deep)));
});

test('redact: a property whose getter throws does not break logging', () => {
  const nasty = { ok: 1 };
  Object.defineProperty(nasty, 'boom', { enumerable: true, get() { throw new Error('getter exploded'); } });
  assert.deepEqual(redact(nasty), { ok: 1, boom: '[unreadable]' });
});

// ───────────── scrub (free text) ─────────────

test('scrub: secrets inside a message are replaced, whatever they sit next to', () => {
  const cases = [
    `jwt malformed: ${JWT}`,
    'Authorization: Bearer bearer-token-value-456',
    'bearer bearer-token-value-456',
    'Cookie: refresh_token=refresh-cookie-value-123; theme=dark',
    'refresh_token=refresh-cookie-value-123; Path=/api/v1/auth; HttpOnly; SameSite=Lax',
    '{"email":"a@b.c","password":"hunter2","x":1}',
    "{'password': 'hunter2'}",
    'login failed password=hunter2 for user',
    `stored hash ${BCRYPT} for user`,
    `token_hash ${SHA256}`,
  ];
  for (const text of cases) assertClean(scrub(text), `scrub(${text.slice(0, 40)}…)`);
});

test('scrub: Postgres "Failing row contains" lines (which include the password hash) are cut', () => {
  const pgDetail = `Failing row contains (b1, p1, Riya, riya@x.test, 9840011111, ${BCRYPT}, staff, t, 0, null, null, 2026-10-31).`;
  const out = scrub(`null value in column "email" violates not-null constraint\n${pgDetail}`);
  assertClean(out);
  assert.match(out, /Failing row contains \(\[row omitted\]\)/);
  assert.equal(out.includes('9840011111'), false);
});

test('scrub: ordinary text, ids and numbers pass through untouched', () => {
  const text = 'Invoice DP-00042 created for customer 9d3c2a10-1111-4222-8333-944455556666 total 1050.00';
  assert.equal(scrub(text), text);
});

// ───────────── serializeError ─────────────

test('serializeError: keeps what helps debugging and drops what a library hung on the error', () => {
  const err = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
    code: '23505', severity: 'ERROR', constraint: 'users_email_key', table: 'users', schema: 'public',
    detail: 'Key (lower(email))=(riya@x.test) already exists.',
    // things a database or HTTP library may attach: none of this may be logged
    query: 'INSERT INTO users (password_hash) VALUES ($1)', parameters: [BCRYPT], values: [BCRYPT],
    config: { headers: { Authorization: 'Bearer bearer-token-value-456', Cookie: 'refresh_token=refresh-cookie-value-123' }, data: '{"password":"hunter2"}' },
  });
  const out = serializeError(err);
  assert.equal(out.code, '23505');
  assert.equal(out.constraint, 'users_email_key');
  assert.equal(out.table, 'users');
  assert.match(out.stack, /serializeError|logging\.unit\.test/);
  assert.equal('query' in out, false);
  assert.equal('parameters' in out, false);
  assert.equal('config' in out, false);
  assertClean(JSON.stringify(out));
});

test('serializeError: secrets in the message, the stack, the cause and the details are all scrubbed', () => {
  const cause = new Error(`inner failure token=bearer-token-value-456 ${JWT}`);
  const err = Object.assign(new Error(`outer failure password=hunter2 ${BCRYPT}`, { cause }), { details: { password: 'Secret123', phone: 'Enter a valid phone number' } });
  const out = serializeError(err);
  assertClean(JSON.stringify(out));
  assert.equal(out.details.password, REDACTED);
  assert.equal(out.details.phone, 'Enter a valid phone number');
});

test('serializeError: an error that refers to itself does not loop', () => {
  const err = new Error('self');
  err.cause = err;
  assert.doesNotThrow(() => JSON.stringify(serializeError(err)));
});

// ───────────── logger ─────────────

test('logger: one JSON object per line with time, level and msg first; fields are redacted', () => {
  reset();
  logger.info('hello', { reqId: 'r-1', password: 'hunter2', nested: { token: 'bearer-token-value-456', fine: 1 } });
  assert.equal(written.length, 1);
  const { entry, line } = written[0];
  assert.deepEqual(Object.keys(entry).slice(0, 3), ['time', 'level', 'msg']);
  assert.match(entry.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(entry.level, 'info');
  assert.equal(entry.password, REDACTED);
  assert.equal(entry.nested.token, REDACTED);
  assert.equal(entry.nested.fine, 1);
  assert.equal(line.includes('\n'), false, 'one physical line');
  assertClean(line);
});

test('logger: fields cannot overwrite time, level or msg', () => {
  reset();
  logger.warn('real message', { time: 'forged', level: 'debug', msg: 'forged' });
  assert.equal(written[0].entry.msg, 'real message');
  assert.equal(written[0].entry.level, 'warn');
  assert.notEqual(written[0].entry.time, 'forged');
});

test('logger: an Error passed as a field is serialised and scrubbed', () => {
  reset();
  logger.error('boom', { err: Object.assign(new Error(`bad password=hunter2 ${JWT}`), { code: 'XX000' }) });
  const { entry, line, level } = written[0];
  assert.equal(level, 'error');
  assert.equal(entry.err.name, 'Error');
  assert.equal(entry.err.code, 'XX000');
  assertClean(line);
});

test('logger: log injection through newlines in a message or value stays on one line', () => {
  reset();
  logger.info('first line\n{"level":"error","msg":"forged entry"}', { note: 'a\nb\r\nc' });
  assert.equal(written[0].line.split('\n').length, 1);
  assert.equal(JSON.parse(written[0].line).level, 'info');
});

test('logger: level filtering, and a logging failure never throws', () => {
  reset();
  logger.configure({ level: 'warn' });
  logger.debug('d'); logger.info('i'); logger.warn('w'); logger.error('e');
  assert.deepEqual(written.map((w) => w.entry.msg), ['w', 'e']);
  logger.configure({ level: 'silent' });
  logger.error('nothing');
  assert.equal(written.length, 2);
  logger.configure({ level: 'debug', sink: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => logger.info('still fine'));
  logger.configure({ sink: (level, line) => written.push({ level, line, entry: JSON.parse(line) }) });
});

test('logger: pretty format is readable, one line per request, and still redacts', () => {
  const lines = [];
  logger.configure({ format: 'pretty', sink: (_l, line) => lines.push(line) });
  logger.info('request', { reqId: 'abcdef123456', method: 'POST', path: '/api/v1/invoices', status: 201, durationMs: 12.5, userId: 'u-1', password: 'hunter2' });
  logger.error('failed', { err: new Error('db down password=hunter2') });
  logger.configure({ format: 'json', sink: (level, line) => written.push({ level, line, entry: JSON.parse(line) }) });
  assert.match(lines[0], /INFO\s+POST \/api\/v1\/invoices 201 12.5ms \[abcdef12\]/);
  assert.equal(lines.join('\n').includes('hunter2'), false);
  assert.match(lines[1], /ERROR\s+failed/);
});

// ───────────── request logger ─────────────

const fakeReq = (over = {}) => ({ method: 'GET', originalUrl: '/api/v1/customers', headers: {}, ip: '203.0.113.9', ...over });
function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 200, headers: {}, locals: {}, headersSent: false, writableFinished: false, destroyed: false });
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[k.toLowerCase()];
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.writableFinished = true; res.emit('finish'); res.emit('close'); return res; };
  res.destroy = () => { res.destroyed = true; };
  return res;
}
const run = (req, res) => { let called = false; requestLogger(req, res, () => { called = true; }); assert.equal(called, true, 'next() was called'); };

test('request id: a fresh id is made, set on the response and on the request', () => {
  const req = fakeReq(); const res = fakeRes();
  run(req, res);
  assert.match(req.id, /^[0-9a-f-]{36}$/);
  assert.equal(res.getHeader('X-Request-Id'), req.id);
});

test('request id: a reasonable id from the caller or a proxy is kept', () => {
  for (const good of ['abc12345', 'req_2026-10-31.xyz:42', 'A'.repeat(64), '9d3c2a10-1111-4222-8333-944455556666']) {
    const req = fakeReq({ headers: { 'x-request-id': good } }); const res = fakeRes();
    run(req, res);
    assert.equal(req.id, good);
    assert.equal(res.getHeader('x-request-id'), good);
  }
});

test('request id: anything that could forge or break a log line is replaced', () => {
  const bad = ['short', 'has space in it', 'new\nline-injection', '{"level":"error"}', '<script>alert(1)</script>', 'A'.repeat(65), '-leading-dash-12345', '', 'tab\tseparated12', 'héllo-wörld-12345'];
  for (const value of bad) {
    const req = fakeReq({ headers: { 'x-request-id': value } }); const res = fakeRes();
    run(req, res);
    assert.notEqual(req.id, value, `kept ${JSON.stringify(value)}`);
    assert.match(req.id, /^[0-9a-f-]{36}$/);
  }
  const req = fakeReq({ headers: { 'x-request-id': ['one-12345678', 'two-12345678'] } }); const res = fakeRes();
  run(req, res);
  assert.match(req.id, /^[0-9a-f-]{36}$/, 'a repeated header is not trusted');
});

test('request log: one line per request with who, what, status and timing', () => {
  reset();
  const req = fakeReq({ method: 'POST', originalUrl: '/api/v1/invoices', headers: { 'user-agent': 'Mozilla/5.0 test', 'x-request-id': 'req-abcdef12' }, auth: { userId: 'u-1', parlourId: 'p-1', role: 'staff' } });
  const res = fakeRes();
  run(req, res);
  res.setHeader('Content-Length', '812');
  res.status(201).json({ data: 1 });
  assert.equal(written.length, 1, 'finish and close together make one line, not two');
  const e = written[0].entry;
  assert.equal(written[0].level, 'info');
  assert.deepEqual(
    { msg: e.msg, reqId: e.reqId, method: e.method, path: e.path, status: e.status, userId: e.userId, parlourId: e.parlourId, role: e.role, ip: e.ip, bytes: e.bytes, ua: e.ua },
    { msg: 'request', reqId: 'req-abcdef12', method: 'POST', path: '/api/v1/invoices', status: 201, userId: 'u-1', parlourId: 'p-1', role: 'staff', ip: '203.0.113.9', bytes: 812, ua: 'Mozilla/5.0 test' }
  );
  assert.equal(typeof e.durationMs, 'number');
  assert.ok(e.durationMs >= 0);
});

test('request log: query strings, bodies, cookies and Authorization headers are never written', () => {
  reset();
  const req = fakeReq({
    method: 'POST',
    originalUrl: '/api/v1/auth/login?phone=9840012345&search=Meera&token=bearer-token-value-456',
    headers: { authorization: 'Bearer bearer-token-value-456', cookie: 'refresh_token=refresh-cookie-value-123', 'user-agent': 'UA' },
    body: { email: 'a@b.c', password: 'hunter2' },
    cookies: { refresh_token: 'refresh-cookie-value-123' },
    auth: { userId: 'u-1', parlourId: 'p-1', role: 'admin', accessToken: JWT },
  });
  const res = fakeRes();
  run(req, res);
  res.status(401).json({ error: { code: 'INVALID_CREDENTIALS' } });
  const line = written[0].line;
  assert.equal(written[0].entry.path, '/api/v1/auth/login');
  for (const leaked of ['9840012345', 'Meera', 'a@b.c', 'authorization', 'cookie']) assert.equal(line.toLowerCase().includes(leaked.toLowerCase()), false, `request line contains ${leaked}`);
  assertClean(line);
});

test('request log: level follows the status; health checks and pre-flights stay quiet', () => {
  const levelFor = (status, over = {}) => {
    reset();
    const res = fakeRes();
    run(fakeReq(over), res);
    res.status(status).json({});
    return written[0].level;
  };
  assert.equal(levelFor(200), 'info');
  assert.equal(levelFor(304), 'info');
  assert.equal(levelFor(404), 'warn');
  assert.equal(levelFor(429), 'warn');
  assert.equal(levelFor(500), 'error');
  assert.equal(levelFor(200, { originalUrl: '/api/v1/health' }), 'debug');
  assert.equal(levelFor(204, { method: 'OPTIONS' }), 'debug');
  assert.equal(levelFor(500, { originalUrl: '/api/v1/health' }), 'error', 'a failing health check is not hidden');
});

test('request log: a connection that closes before the answer is logged as aborted, once', () => {
  reset();
  const res = fakeRes();
  run(fakeReq(), res);
  res.emit('close'); // writableFinished is false
  res.emit('close');
  assert.equal(written.length, 1);
  assert.equal(written[0].level, 'warn');
  assert.equal(written[0].entry.aborted, true);
});

test('request log: the error code set by the error handler is included', () => {
  reset();
  const req = fakeReq({ originalUrl: '/api/v1/customers' }); const res = fakeRes();
  run(req, res);
  errorHandler(AppError.conflict('That number exists', 'PHONE_EXISTS'), req, res, () => {});
  assert.equal(written.at(-1).entry.errorCode, 'PHONE_EXISTS');
  assert.equal(written.at(-1).entry.status, 409);
});

// ───────────── error handler ─────────────

function handle(err, reqOver = {}) {
  const req = fakeReq({ id: 'req-handler-1', ...reqOver }); const res = fakeRes();
  reset();
  errorHandler(err, req, res, () => assert.fail('next must not be called'));
  return { res, req, logs: written.filter((w) => w.entry.msg !== 'request') };
}

test('error handler: expected errors answer with their code, message, details and the request id, and are not logged as errors', () => {
  const { res, logs } = handle(new AppError(400, 'Please check the highlighted fields', 'VALIDATION_ERROR', { phone: 'Enter a valid phone number' }));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: { code: 'VALIDATION_ERROR', message: 'Please check the highlighted fields', details: { phone: 'Enter a valid phone number' }, requestId: 'req-handler-1' } });
  assert.equal(logs.length, 0);
});

test('error handler: the existing special cases answer exactly as before', () => {
  assert.equal(handle(Object.assign(new Error('x'), { type: 'entity.parse.failed' })).res.body.error.code, 'INVALID_JSON');
  const tooLarge = handle(Object.assign(new Error('x'), { type: 'entity.too.large' })).res;
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.body.error.code, 'PAYLOAD_TOO_LARGE');
  const badId = handle(Object.assign(new Error('invalid input syntax for type uuid: "nope"'), { code: '22P02' })).res;
  assert.equal(badId.statusCode, 400);
  assert.equal(badId.body.error.code, 'INVALID_ID');
});

test('error handler: an unexpected error is a generic 500 to the client and a redacted entry in the log', () => {
  const evil = Object.assign(new Error(`insert failed for password=hunter2 token ${JWT}\nFailing row contains (b1, p1, Riya, riya@x.test, 9840011111, ${BCRYPT}, staff)`), {
    code: '23502', severity: 'ERROR', table: 'users', column: 'email', detail: `Failing row contains (b1, p1, Riya, ${BCRYPT}, staff).`,
    query: 'INSERT INTO users ...', parameters: [BCRYPT, 'hunter2'],
    config: { headers: { Authorization: 'Bearer bearer-token-value-456', Cookie: 'refresh_token=refresh-cookie-value-123' }, data: '{"password":"Secret123"}' },
  });
  const body = { email: 'owner@x.test', note: 'BODY-MARKER-123', password: 'hunter2' }; // the note has no sensitive key: it must stay out of the log anyway
  const { res, logs } = handle(evil, { originalUrl: '/api/v1/staff?x=1&q=QUERY-MARKER-456', auth: { userId: 'u-9', parlourId: 'p-9' }, body, headers: { cookie: 'refresh_token=refresh-cookie-value-123', 'user-agent': 'UA-MARKER-789' } });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body.error, { code: 'INTERNAL', message: 'Something went wrong on our side', details: undefined, requestId: 'req-handler-1' });
  assertClean(JSON.stringify(res.body), 'response');
  assert.equal(logs.length, 1);
  const { entry, line, level } = logs[0];
  assert.equal(level, 'error');
  assert.equal(entry.reqId, 'req-handler-1');
  assert.equal(entry.path, '/api/v1/staff');
  assert.equal(entry.userId, 'u-9');
  assert.equal(entry.err.code, '23502');
  assert.equal(entry.err.table, 'users');
  assertClean(line, 'error log line');
  assert.equal(line.includes('riya@x.test'), false, 'the failing row (with personal data) is cut');
  assert.equal(line.includes('9840011111'), false);
  // Only the fields the handler names are logged: never the body, the query string or the headers.
  for (const marker of ['BODY-MARKER-123', 'owner@x.test', 'QUERY-MARKER-456', 'UA-MARKER-789']) assert.equal(line.includes(marker), false, `the error log line contains ${marker}`);
  for (const key of ['body', 'query', 'headers', 'cookies']) assert.equal(key in entry, false, `the error log entry has a "${key}" field`);
});

test('error handler: a server error raised on purpose (5xx AppError) is logged too; client errors are not', () => {
  const five = handle(new AppError(503, 'Database unavailable', 'DB_DOWN'));
  assert.equal(five.logs.length, 1);
  assert.equal(five.logs[0].level, 'error');
  assert.equal(five.res.statusCode, 503);
  assert.equal(handle(AppError.forbidden()).logs.length, 0);
  assert.equal(handle(AppError.notFound()).logs.length, 0);
});

test('error handler: if the response has already started, the error is logged and the connection is dropped', () => {
  const req = fakeReq({ id: 'req-late-1' }); const res = fakeRes();
  res.headersSent = true;
  reset();
  errorHandler(new Error('late failure password=hunter2'), req, res, () => {});
  assert.equal(res.destroyed, true);
  assert.equal(res.body, undefined, 'nothing more is written to the half-sent response');
  assert.equal(written.at(-1).level, 'error');
  assertClean(written.at(-1).line);
});

test('error handler: unknown routes still answer 404 ROUTE_NOT_FOUND with a request id', () => {
  const req = fakeReq({ id: 'req-404-1', method: 'GET', path: '/nope' });
  let passed;
  notFound(req, fakeRes(), (err) => { passed = err; });
  const res = fakeRes();
  reset();
  errorHandler(passed, req, res, () => {});
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
  assert.equal(res.body.error.requestId, 'req-404-1');
});
