// Structured logging: one JSON object per line (easy to search on Render and similar hosts), or a short
// readable line in development. Every field passes through redact(), so passwords, tokens and cookies
// cannot be printed even by accident. Needs no packages and does not read the environment itself:
// server.js calls logger.configure() with the values from config/env.js.

const { redact, scrub } = require('./redact');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const RESERVED = new Set(['time', 'level', 'msg']);

// Errors go to stderr, everything else to stdout.
const stdSink = (level, line) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);

const oneLine = (v) => String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ');

function pretty(entry) {
  const { time, level, msg, ...rest } = entry;
  const head = `${time.slice(11, 23)} ${level.toUpperCase().padEnd(5)}`;
  const { err, ...fields } = rest;
  let line;
  if (msg === 'request') {
    const { method, path, status, durationMs, reqId, ...more } = fields;
    const extras = Object.entries(more).map(([k, v]) => `${k}=${oneLine(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' ');
    line = `${head} ${method} ${path} ${status} ${durationMs}ms [${String(reqId).slice(0, 8)}] ${extras}`.trimEnd();
  } else {
    const extras = Object.entries(fields).map(([k, v]) => `${k}=${oneLine(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' ');
    line = `${head} ${oneLine(msg)} ${extras}`.trimEnd();
  }
  if (err && typeof err === 'object') line += `\n  ${oneLine(`${err.name}: ${err.message}`)}${err.stack ? `\n${err.stack}` : ''}`;
  else if (err) line += ` err=${oneLine(err)}`;
  return line;
}

function createLogger(initial = {}) {
  const state = { level: 'info', format: 'json', sink: stdSink, ...initial };

  function write(level, msg, fields) {
    if (LEVELS[level] < (LEVELS[state.level] ?? LEVELS.info)) return;
    try {
      const entry = { time: new Date().toISOString(), level, msg: scrub(String(msg)) };
      const clean = redact(fields ?? {});
      if (clean && typeof clean === 'object') {
        for (const [key, value] of Object.entries(clean)) {
          if (!RESERVED.has(key) && value !== undefined) entry[key] = value;
        }
      }
      state.sink(level, state.format === 'pretty' ? pretty(entry) : JSON.stringify(entry));
    } catch {
      // A logging problem must never break a request.
    }
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    /** { level: 'debug'|'info'|'warn'|'error'|'silent', format: 'json'|'pretty', sink(level, line) } */
    configure(options = {}) {
      for (const key of ['level', 'format', 'sink']) if (options[key] !== undefined) state[key] = options[key];
      return this;
    },
  };
}

// The one logger the app uses. createLogger() is exported for tests.
module.exports = createLogger();
module.exports.createLogger = createLogger;
module.exports.LEVELS = LEVELS;
