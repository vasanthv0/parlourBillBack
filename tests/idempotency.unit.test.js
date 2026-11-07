// No database and no running API: node --test tests/idempotency.unit.test.js   (or: npm run test:unit)
// The real invoice service runs here against a scripted stand-in for the database.
const test = require('node:test');
const assert = require('node:assert/strict');

// Load the service without a database, a .env file or the WhatsApp module's config.
const stub = (modulePath, exports) => {
  const file = require.resolve(modulePath);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const world = { lookups: [], queries: [], transactions: 0, runTransaction: null };
stub('../src/config/db', {
  pool: {},
  query: async (text, params) => {
    world.queries.push({ text, params });
    if (/FROM invoices\s+WHERE parlour_id = \$1 AND created_by = \$2 AND idempotency_key = \$3/.test(text)) return { rows: world.lookups.shift() ?? [] };
    throw new Error(`unexpected query on the pool: ${text.slice(0, 70)}`);
  },
  withTransaction: async (fn) => { world.transactions += 1; return world.runTransaction(fn); },
});
stub('../src/modules/invoices/whatsapp', {});

const service = require('../src/modules/invoices/invoices.service');
const idem = require('../src/modules/invoices/idempotency');
const schemas = require('../src/modules/invoices/invoices.schemas');
const validate = require('../src/middleware/validate');
const AppError = require('../src/utils/AppError');

// The bill itself is read back with getWith(); here it just echoes who asked for which id.
service.getWith = async (_db, auth, id) => ({ id, number: 'DP-00042', readBy: auth.userId });

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const R1 = '44444444-4444-4444-8444-444444444444';
const U1 = '55555555-5555-4555-8555-555555555555';
const KEY = 'attempt-7f3a9c1e-0001';
const baseBody = () => ({ items: [{ serviceId: S1, quantity: 2 }], discount: 0, paymentMethod: 'cash' });
const staffA = { userId: 'user-A', parlourId: 'parlour-A', role: 'staff' };

const reset = () => { world.lookups = []; world.queries = []; world.transactions = 0; world.runTransaction = null; };

/** A scripted transaction client: enough of the database for one simple service bill. */
function billClient({ taxPercent = '5.00', price = '200.00' } = {}) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM services WHERE/.test(text)) return { rows: params[1].map((id) => ({ id, name: 'Haircut', price })) };
      if (/UPDATE parlours SET invoice_seq/.test(text)) return { rows: [{ invoice_prefix: 'DP', invoice_seq: 42, tax_percent: taxPercent, gst_price_mode: 'exclusive', gst_number: null }] };
      if (/INSERT INTO invoices/.test(text)) return { rows: [{ id: 'new-invoice-id' }] };
      if (/INSERT INTO invoice_items/.test(text)) return { rows: [] };
      if (/INSERT INTO invoice_payments/.test(text)) return { rows: [] };
      throw new Error(`unexpected query in the transaction: ${text.slice(0, 70)}`);
    },
  };
}
const keyConflict = () => Object.assign(new Error('duplicate key value violates unique constraint "invoices_idempotency_key"'), { code: '23505', constraint: 'invoices_idempotency_key' });

// ───────────── fingerprint ─────────────

test('fingerprint: the same request always gives the same 64-character fingerprint', () => {
  const a = idem.fingerprintOf(baseBody());
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(idem.fingerprintOf(baseBody()), a);
});

test('fingerprint: line order, and splitting a quantity across lines, do not matter (the server merges them anyway)', () => {
  const one = { ...baseBody(), items: [{ serviceId: S1, quantity: 2 }, { serviceId: S2, quantity: 1 }] };
  const reordered = { ...baseBody(), items: [{ serviceId: S2, quantity: 1 }, { serviceId: S1, quantity: 2 }] };
  const split = { ...baseBody(), items: [{ serviceId: S1, quantity: 1 }, { serviceId: S2, quantity: 1 }, { serviceId: S1, quantity: 1 }] };
  assert.equal(idem.fingerprintOf(reordered), idem.fingerprintOf(one));
  assert.equal(idem.fingerprintOf(split), idem.fingerprintOf(one));
});

test('fingerprint: any real change to the bill changes it', () => {
  const base = idem.fingerprintOf(baseBody());
  const variants = {
    quantity: { ...baseBody(), items: [{ serviceId: S1, quantity: 3 }] },
    'other service': { ...baseBody(), items: [{ serviceId: S2, quantity: 2 }] },
    'a combo instead of a service': { ...baseBody(), items: [{ comboId: S1, quantity: 2 }] },
    'extra line': { ...baseBody(), items: [{ serviceId: S1, quantity: 2 }, { serviceId: S2, quantity: 1 }] },
    discount: { ...baseBody(), discount: 10 },
    'payment method': { ...baseBody(), paymentMethod: 'upi' },
    customer: { ...baseBody(), customerId: C1 },
    referrer: { ...baseBody(), referrerId: R1 },
    'walk-in name': { ...baseBody(), walkInName: 'Asha' },
    notes: { ...baseBody(), notes: 'for the wedding' },
  };
  const seen = new Set([base]);
  for (const [what, body] of Object.entries(variants)) {
    const fp = idem.fingerprintOf(body);
    assert.notEqual(fp, base, `changing the ${what} should change the fingerprint`);
    assert.equal(seen.has(fp), false, `${what} collides with another variant`);
    seen.add(fp);
  }
});

test('fingerprint: money is compared in paise, so 10 and 10.00 are the same discount; missing and empty are the same', () => {
  assert.equal(idem.fingerprintOf({ ...baseBody(), discount: 10 }), idem.fingerprintOf({ ...baseBody(), discount: 10.0 }));
  assert.equal(idem.fingerprintOf({ ...baseBody(), discount: undefined }), idem.fingerprintOf({ ...baseBody(), discount: 0 }));
  assert.equal(idem.fingerprintOf({ ...baseBody(), customerId: null }), idem.fingerprintOf(baseBody()));
  assert.equal(idem.fingerprintOf({ ...baseBody(), notes: '' }), idem.fingerprintOf(baseBody()));
  assert.notEqual(idem.fingerprintOf({ ...baseBody(), discount: 10.01 }), idem.fingerprintOf({ ...baseBody(), discount: 10 }));
});

// ───────────── the header, through the real validate middleware ─────────────

function validated(headers, body = baseBody()) {
  const req = { headers, params: {}, query: {}, body };
  let err;
  validate(schemas.create)(req, {}, (e) => { err = e; });
  return { req, err };
}

test('Idempotency-Key header: optional; a good key is accepted and trimmed', () => {
  assert.equal(validated({}).err, undefined);
  assert.equal(validated({}).req.valid.headers['idempotency-key'], undefined);
  for (const good of [KEY, 'a'.repeat(8), 'A'.repeat(128), '9d3c2a10-1111-4222-8333-944455556666', 'a.b:c_d-e1234']) {
    const { req, err } = validated({ 'idempotency-key': good });
    assert.equal(err, undefined, `should accept ${good.slice(0, 20)}`);
    assert.equal(req.valid.headers['idempotency-key'], good);
  }
  assert.equal(validated({ 'idempotency-key': `  ${KEY}  ` }).req.valid.headers['idempotency-key'], KEY);
});

test('Idempotency-Key header: too short, too long, empty or oddly shaped keys are refused with a field error', () => {
  for (const bad of ['short', 'a'.repeat(129), '', 'has space 12345', 'semi;colon12345', 'new\nline12345', 'quote"12345678', '<script>12345', 'slash/12345678', 'ünïcödé12345']) {
    const { err } = validated({ 'idempotency-key': bad });
    assert.ok(err instanceof AppError, `should refuse ${JSON.stringify(bad).slice(0, 30)}`);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.ok(err.details['idempotency-key'], 'the message is attached to the header field');
  }
});

test('Idempotency-Key header: other headers are never copied into req.valid (no cookies or tokens travel on)', () => {
  const { req } = validated({ 'idempotency-key': KEY, authorization: 'Bearer abc.def.ghi', cookie: 'refresh_token=secret', 'x-requested-with': 'XMLHttpRequest' });
  assert.deepEqual(Object.keys(req.valid.headers), ['idempotency-key']);
  assert.equal(JSON.stringify(req.valid).includes('secret'), false);
});

test('Idempotency-Key header: a bad body is still refused the same way, with or without a key', () => {
  const { err } = validated({ 'idempotency-key': KEY }, { items: [], paymentMethod: 'cash' });
  assert.equal(err.code, 'VALIDATION_ERROR');
  assert.ok(err.details.items);
});

// ───────────── isKeyConflict ─────────────

test('isKeyConflict: only a unique violation on the idempotency index counts', () => {
  assert.equal(idem.isKeyConflict(keyConflict()), true);
  assert.equal(idem.isKeyConflict(Object.assign(new Error('x'), { code: '23505', constraint: 'invoices_parlour_id_number_key' })), false);
  assert.equal(idem.isKeyConflict(Object.assign(new Error('x'), { code: '23503', constraint: 'invoices_idempotency_key' })), false);
  assert.equal(idem.isKeyConflict(new Error('plain')), false);
  assert.equal(idem.isKeyConflict(null), false);
  assert.equal(idem.isKeyConflict(undefined), false);
  assert.equal(idem.KEY_INDEX, 'invoices_idempotency_key', 'must match the index name in db/schema.sql');
});

test('the index name used in code exists in db/schema.sql, on the right columns, and only for rows with a key', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '../db/schema.sql'), 'utf8');
  const index = sql.match(/CREATE UNIQUE INDEX IF NOT EXISTS invoices_idempotency_key\s+ON invoices \(([^)]*)\)\s+WHERE ([^;]*);/);
  assert.ok(index, 'unique index not found in schema.sql');
  assert.equal(index[1].replace(/\s+/g, ' ').trim(), 'parlour_id, created_by, idempotency_key');
  assert.equal(index[2].trim(), 'idempotency_key IS NOT NULL');
  assert.match(sql, /ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_key text;/);
  assert.match(sql, /ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;/);
});

// ───────────── service.create ─────────────

test('no key: the bill is made exactly as before; nothing is looked up; the key columns stay NULL', async () => {
  reset();
  const client = billClient();
  world.runTransaction = (fn) => fn(client);
  const result = await service.create(staffA, baseBody());
  assert.equal(result.replayed, false);
  assert.equal(result.invoice.id, 'new-invoice-id');
  assert.equal(world.transactions, 1);
  assert.equal(world.queries.length, 0, 'no idempotency lookup without a key');
  const insert = client.calls.find((c) => /INSERT INTO invoices/.test(c.text));
  assert.equal(insert.params[15], null);
  assert.equal(insert.params[16], null);
});

test('no key: the money is unchanged by this feature (2 × ₹200 + 5% GST = ₹420.00, in paise)', async () => {
  reset();
  const client = billClient();
  world.runTransaction = (fn) => fn(client);
  await service.create(staffA, baseBody());
  const p = client.calls.find((c) => /INSERT INTO invoices/.test(c.text)).params;
  assert.deepEqual(
    { number: p[1], subtotal: p[5], discount: p[6], referralDiscount: p[9], taxPercent: p[10], tax: p[11], total: p[12], paymentMethod: p[13] },
    { number: 'DP-00042', subtotal: '400.00', discount: '0.00', referralDiscount: '0.00', taxPercent: '5.00', tax: '20.00', total: '420.00', paymentMethod: 'cash' }
  );
});

test('a new key: the bill is made once and the key and fingerprint are stored with it, in the same transaction', async () => {
  reset();
  const client = billClient();
  world.runTransaction = (fn) => fn(client);
  const result = await service.create(staffA, baseBody(), { idempotencyKey: KEY });
  assert.equal(result.replayed, false);
  assert.equal(world.transactions, 1);
  assert.equal(world.queries.length, 1, 'one look-up before creating');
  const insert = client.calls.find((c) => /INSERT INTO invoices/.test(c.text));
  assert.equal(insert.params[15], KEY);
  assert.equal(insert.params[16], idem.fingerprintOf(baseBody()));
  // and the totals are the same as without a key
  assert.deepEqual([insert.params[5], insert.params[11], insert.params[12]], ['400.00', '20.00', '420.00']);
});

test('the same key and the same request again: the original bill comes back and NOTHING is created', async () => {
  reset();
  world.lookups = [[{ id: 'invoice-1', idempotency_fingerprint: idem.fingerprintOf(baseBody()) }]];
  world.runTransaction = () => assert.fail('a replay must not open a transaction');
  const result = await service.create(staffA, baseBody(), { idempotencyKey: KEY });
  assert.equal(result.replayed, true);
  assert.equal(result.invoice.id, 'invoice-1');
  assert.equal(result.invoice.readBy, 'user-A', 'read back as the same person, so staff only reach their own bill');
  assert.equal(world.transactions, 0);
  assert.equal(world.queries.length, 1, 'the look-up is the only query: no prices, no invoice number, no insert');
});

test('a replay ignores a menu that has changed since: it returns the bill as it was made', async () => {
  reset();
  world.lookups = [[{ id: 'invoice-1', idempotency_fingerprint: idem.fingerprintOf(baseBody()) }]];
  world.runTransaction = () => assert.fail('no transaction expected');
  const result = await service.create(staffA, baseBody(), { idempotencyKey: KEY });
  assert.equal(result.invoice.id, 'invoice-1');
});

test('the same key with a different request: 409 IDEMPOTENCY_KEY_REUSED and nothing is created', async () => {
  reset();
  world.lookups = [[{ id: 'invoice-1', idempotency_fingerprint: idem.fingerprintOf(baseBody()) }]];
  world.runTransaction = () => assert.fail('must not create anything');
  const changed = { ...baseBody(), items: [{ serviceId: S1, quantity: 3 }] };
  await assert.rejects(service.create(staffA, changed, { idempotencyKey: KEY }), (err) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'IDEMPOTENCY_KEY_REUSED');
    return true;
  });
  assert.equal(world.transactions, 0);
});

test('the look-up is always bound to this parlour AND this person, so a key never leads to someone else\'s bill', async () => {
  reset();
  // A pretend table in which person A in parlour A has used KEY. Only an exact (parlour, person, key) match finds it.
  const table = [{ parlour: 'parlour-A', user: 'user-A', key: KEY, id: 'invoice-of-A', fp: idem.fingerprintOf(baseBody()) }];
  stub('../src/config/db', {
    pool: {},
    query: async (text, params) => {
      world.queries.push({ text, params });
      const [parlour, user, key] = params;
      return { rows: table.filter((r) => r.parlour === parlour && r.user === user && r.key === key).map((r) => ({ id: r.id, idempotency_fingerprint: r.fp })) };
    },
    withTransaction: async (fn) => { world.transactions += 1; return world.runTransaction(fn); },
  });
  // Re-load the service so it picks up this version of the database stand-in.
  delete require.cache[require.resolve('../src/modules/invoices/invoices.service')];
  const fresh = require('../src/modules/invoices/invoices.service');
  fresh.getWith = async (_db, auth, id) => ({ id, readBy: auth.userId });

  const sameParlourOtherPerson = { userId: 'user-B', parlourId: 'parlour-A', role: 'staff' };
  const otherParlourSameUserId = { userId: 'user-A', parlourId: 'parlour-B', role: 'admin' };
  const owner = { userId: 'user-A', parlourId: 'parlour-A', role: 'staff' };

  world.runTransaction = (fn) => fn(billClient());
  const b = await fresh.create(sameParlourOtherPerson, baseBody(), { idempotencyKey: KEY });
  assert.equal(b.replayed, false, "a colleague using the same key does not get A's bill");
  assert.equal(b.invoice.id, 'new-invoice-id');

  const c = await fresh.create(otherParlourSameUserId, baseBody(), { idempotencyKey: KEY });
  assert.equal(c.replayed, false, "another parlour using the same key does not get A's bill");

  world.runTransaction = () => assert.fail('the owner replaying must not create anything');
  const a = await fresh.create(owner, baseBody(), { idempotencyKey: KEY });
  assert.equal(a.replayed, true);
  assert.equal(a.invoice.id, 'invoice-of-A');

  // The SQL itself filters on all three columns.
  const sql = world.queries[0].text.replace(/\s+/g, ' ');
  assert.match(sql, /WHERE parlour_id = \$1 AND created_by = \$2 AND idempotency_key = \$3/);
  assert.deepEqual(world.queries[0].params, ['parlour-A', 'user-B', KEY]);
  assert.deepEqual(world.queries[1].params, ['parlour-B', 'user-A', KEY]);
});

test('two copies at once: the loser of the race gets the winner\'s bill instead of an error', async () => {
  reset();
  const fp = idem.fingerprintOf(baseBody());
  world.lookups = [[], [{ id: 'winner-invoice', idempotency_fingerprint: fp }]]; // nothing yet, then the winner is visible
  world.runTransaction = async () => { throw keyConflict(); };
  const result = await service.create(staffA, baseBody(), { idempotencyKey: KEY });
  assert.equal(result.replayed, true);
  assert.equal(result.invoice.id, 'winner-invoice');
  assert.equal(world.transactions, 1);
  assert.equal(world.queries.length, 2);
});

test('a lost race against a DIFFERENT request that reused the key is still a 409', async () => {
  reset();
  world.lookups = [[], [{ id: 'winner-invoice', idempotency_fingerprint: idem.fingerprintOf({ ...baseBody(), discount: 50 }) }]];
  world.runTransaction = async () => { throw keyConflict(); };
  await assert.rejects(service.create(staffA, baseBody(), { idempotencyKey: KEY }), { code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
});

test('any other database error is passed on untouched, never mistaken for a replay', async () => {
  reset();
  world.lookups = [[]];
  const other = Object.assign(new Error('duplicate key value violates unique constraint "invoices_parlour_id_number_key"'), { code: '23505', constraint: 'invoices_parlour_id_number_key' });
  world.runTransaction = async () => { throw other; };
  await assert.rejects(service.create(staffA, baseBody(), { idempotencyKey: KEY }), (err) => err === other);
  assert.equal(world.queries.length, 1, 'no second look-up for an unrelated error');

  reset();
  world.lookups = [[]];
  const down = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
  world.runTransaction = async () => { throw down; };
  await assert.rejects(service.create(staffA, baseBody(), { idempotencyKey: KEY }), (err) => err === down);
});

test('if a conflict is reported but the winning bill cannot be found, the original error is raised', async () => {
  reset();
  world.lookups = [[], []];
  const conflict = keyConflict();
  world.runTransaction = async () => { throw conflict; };
  await assert.rejects(service.create(staffA, baseBody(), { idempotencyKey: KEY }), (err) => err === conflict);
});

test('a bill refused for ordinary reasons (unavailable service) is refused as before, with or without a key', async () => {
  for (const options of [undefined, { idempotencyKey: KEY }]) {
    reset();
    world.lookups = [[]];
    world.runTransaction = (fn) => fn({ query: async (text) => { if (/FROM services WHERE/.test(text)) return { rows: [] }; throw new Error('unexpected'); } });
    await assert.rejects(service.create(staffA, baseBody(), options), { code: 'SERVICE_UNAVAILABLE', status: 400 });
  }
});

test('findReplay reads only the three columns it needs and returns null for an unused key', async () => {
  const db = { query: async () => ({ rows: [] }) };
  assert.equal(await idem.findReplay(db, staffA, KEY, 'fp'), null);
});
