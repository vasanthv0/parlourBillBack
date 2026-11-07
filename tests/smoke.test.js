// End-to-end tests. Needs the API running and the demo seed loaded:
//   npm run db:init && npm run db:seed
//   AUTH_RATE_LIMIT=1000 npm start     (the suite signs in from one IP, so lift the per-IP limit)
//   API_URL=http://localhost:3000 npm test
// (Other suites: npm run test:unit needs no database; npm run test:attendance and npm run test:db are separate. See README.)
const test = require('node:test');
const assert = require('node:assert/strict');

// A mobile number belongs to one account across the whole platform, so every test member gets a number of their own.
let mobileSeed = 6000000000 + Math.floor(Math.random() * 900000000);
const nextMobile = () => String(mobileSeed++);

const BASE = (process.env.API_URL || 'http://localhost:3000') + '/api/v1';
const PASSWORD = process.env.SEED_PASSWORD || 'Demo@12345';
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

/** Tiny client that keeps the refresh cookie like a browser would. */
function client() {
  let cookie = '';
  let token = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(cookie && { Cookie: cookie }),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.().find((c) => c.startsWith('refresh_token='));
    if (set) cookie = set.split(';')[0];
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, json, setCookie: set, headers: res.headers };
  };
  return {
    call,
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async login(email, password = PASSWORD) {
      const r = await call('POST', '/auth/login', { email, password });
      if (r.status === 200) token = r.json.data.accessToken;
      return r;
    },
    /** Signs in with the current "identifier" field: an email or a mobile number. */
    async loginAs(identifier, password = PASSWORD) {
      const r = await call('POST', '/auth/login', { identifier, password });
      if (r.status === 200) token = r.json.data.accessToken;
      return r;
    },
  };
}

const signedIn = async (email, password) => { const c = client(); const r = await c.login(email, password); assert.equal(r.status, 200, `login ${email}`); return c; };

// Parlours created by a test are removed afterwards so reruns stay tidy.
const created = [];
async function makeParlour(sa, extra = {}) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const body = { parlourName: `Test Salon ${stamp}`, adminName: 'Olive Owner', email: `owner${stamp}@test.parlour`, password: 'Secret123', ...extra };
  const r = await sa.call('POST', '/platform/parlours', body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  created.push({ id: r.json.data.id, name: body.parlourName });
  return { id: r.json.data.id, name: body.parlourName, email: body.email, password: body.password, data: r.json.data };
}
test.after(async () => {
  const sa = await signedIn('super@demo.parlour');
  for (const p of created) await sa.call('DELETE', `/platform/parlours/${p.id}`, { confirmName: p.name });
});

// ───────────────────────── sign-in ─────────────────────────

test('login: wrong password and unknown email give the same generic error', async () => {
  const a = await client().login('admin@demo.parlour', 'Wrong-pass-1');
  const b = await client().login('nobody@nowhere.test', 'Wrong-pass-1');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.json.error.message, b.json.error.message);
});

test('login: httpOnly refresh cookie, no refresh token in the body, parlour name and features included', async () => {
  const r = await client().login('admin@demo.parlour');
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/i);
  assert.match(r.setCookie, /Path=\/api\/v1\/auth/);
  const { user, refreshToken } = r.json.data;
  assert.equal(refreshToken, undefined);
  assert.equal(user.role, 'admin');
  assert.equal(user.parlourName, 'Demo Parlour');
  assert.equal(user.features['page.team'], true);
  assert.equal(user.passwordHash, undefined);
});

test('there is no public sign-up: the old register endpoint creates nothing', async () => {
  const email = `eve${Date.now()}@test.parlour`;
  const r = await client().call('POST', '/auth/register', { parlourName: 'Sneaky', name: 'Eve', email, password: 'Secret123' });
  assert.ok(r.status === 401 || r.status === 404, `expected refusal, got ${r.status}`);
  assert.equal((await client().login(email, 'Secret123')).status, 401, 'no account was created');
});

test('refresh: requires the XHR header, rotates the token, and detects reuse', async () => {
  const c = client();
  await c.login('staff@demo.parlour');
  const original = c.cookie;

  assert.equal((await c.call('POST', '/auth/refresh')).status, 403, 'no header → blocked');
  const ok = await c.call('POST', '/auth/refresh', null, XHR);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.user.parlourName, 'Demo Parlour', 'refresh also carries the parlour name');
  assert.notEqual(c.cookie, original, 'token rotated');

  await new Promise((r) => setTimeout(r, 10_500)); // past the two-tab grace window
  const replay = client();
  replay.cookie = original;
  assert.equal((await replay.call('POST', '/auth/refresh', null, XHR)).status, 401);
  assert.equal((await c.call('POST', '/auth/refresh', null, XHR)).status, 401, 'legit holder is also logged out');
});

test('logout revokes the session', async () => {
  const c = client();
  await c.login('staff@demo.parlour');
  assert.equal((await c.call('POST', '/auth/logout', null, XHR)).status, 204);
  assert.equal((await c.call('POST', '/auth/refresh', null, XHR)).status, 401);
});

test('validation: bad input returns field-level errors', async () => {
  const r = await client().call('POST', '/auth/login', { email: 'nope', password: '' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  assert.ok(r.json.error.details.email && r.json.error.details.password);
});

test('account lockout after repeated failures', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  let last;
  for (let i = 0; i < 5; i++) last = await client().login(p.email, 'Wrong-pass-9');
  assert.equal(last.status, 401);
  const locked = await client().login(p.email, p.password); // even the right password is refused while locked
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'ACCOUNT_LOCKED');
});

// ───────────────────── admin vs staff (inside a parlour) ─────────────────────

test('roles: staff cannot reach admin features, admin can', async () => {
  const staff = await signedIn('staff@demo.parlour');
  const admin = await signedIn('admin@demo.parlour');
  for (const [method, path, body] of [['GET', '/staff'], ['GET', '/reports/summary'], ['POST', '/services', { name: 'Hack', price: 1 }], ['PATCH', '/parlour', { name: 'Mine now' }], ['GET', '/invoices/makers']]) {
    assert.equal((await staff.call(method, path, body)).status, 403, `staff ${method} ${path}`);
  }
  assert.equal((await admin.call('GET', '/staff')).status, 200);
  assert.equal((await admin.call('GET', '/reports/summary')).status, 200);
  assert.equal((await staff.call('GET', '/services')).status, 200, 'staff can read the menu');
});

test('billing: server prices the bill, applies discount and tax, numbers invoices', async () => {
  const staff = await signedIn('staff@demo.parlour');
  const menu = (await staff.call('GET', '/services')).json.data;
  const cut = menu.find((s) => s.name === 'Haircut – Men'); // 200
  const mani = menu.find((s) => s.name === 'Manicure');     // 500
  const r = await staff.call('POST', '/invoices', {
    items: [{ serviceId: cut.id, quantity: 2 }, { serviceId: mani.id, quantity: 1 }],
    discount: 100, paymentMethod: 'upi', unitPrice: 1, total: 1, // client-supplied prices must be ignored
  });
  assert.equal(r.status, 201);
  const inv = r.json.data;
  assert.deepEqual([inv.subtotal, inv.discount, inv.tax, inv.total], [900, 100, 40, 840]);
  assert.match(inv.number, /^DP-\d{5}$/);
  const tooMuch = await staff.call('POST', '/invoices', { items: [{ serviceId: cut.id, quantity: 1 }], discount: 9999, paymentMethod: 'cash' });
  assert.equal(tooMuch.status, 400);
});

test('staff only see their own bills; admin sees all and can void', async () => {
  const riya = await signedIn('staff@demo.parlour');
  const farah = await signedIn('farah@demo.parlour');
  const admin = await signedIn('admin@demo.parlour');
  const mine = (await riya.call('GET', '/invoices?limit=100')).json;
  const hers = (await farah.call('GET', '/invoices?limit=100')).json;
  const all = (await admin.call('GET', '/invoices?limit=100')).json;
  assert.ok(mine.data.every((i) => i.createdByName === 'Riya'));
  assert.ok(hers.data.every((i) => i.createdByName === 'Farah'));
  assert.ok(all.meta.total >= mine.meta.total + hers.meta.total);

  const menu = (await farah.call('GET', '/services')).json.data;
  const someoneElses = (await farah.call('POST', '/invoices', { items: [{ serviceId: menu[0].id, quantity: 1 }], paymentMethod: 'cash' })).json.data;
  assert.equal((await riya.call('GET', `/invoices/${someoneElses.id}`)).status, 404, "can't open a colleague's bill");
  assert.equal((await riya.call('POST', `/invoices/${mine.data[0].id}/void`, { reason: 'test' })).status, 403, 'staff cannot void');
  const voided = await admin.call('POST', `/invoices/${someoneElses.id}/void`, { reason: 'Entered twice' });
  assert.equal(voided.status, 200);
  assert.equal(voided.json.data.status, 'void');
  assert.equal((await admin.call('POST', `/invoices/${someoneElses.id}/void`, { reason: 'again' })).status, 409);
});

test('"made by" filter: admin can filter by person; staff cannot widen their view', async () => {
  const admin = await signedIn('admin@demo.parlour');
  const riya = await signedIn('staff@demo.parlour');
  const makers = (await admin.call('GET', '/invoices/makers')).json.data;
  const names = makers.map((m) => m.name);
  assert.ok(names.includes('Riya') && names.includes('Farah'), `makers: ${names}`);

  const riyaId = makers.find((m) => m.name === 'Riya').id;
  const farahId = makers.find((m) => m.name === 'Farah').id;
  const onlyRiya = (await admin.call('GET', `/invoices?createdBy=${riyaId}&limit=100`)).json;
  assert.ok(onlyRiya.data.length > 0 && onlyRiya.data.every((i) => i.createdBy === riyaId));
  const everyone = (await admin.call('GET', '/invoices?limit=100')).json;
  assert.ok(everyone.meta.total > onlyRiya.meta.total, 'filter narrows the list');

  // A staff member asking for someone else's bills still only gets their own.
  const sneaky = (await riya.call('GET', `/invoices?createdBy=${farahId}&limit=100`)).json;
  assert.ok(sneaky.data.every((i) => i.createdBy === riyaId));
  assert.equal((await admin.call('GET', '/invoices?createdBy=not-a-uuid')).status, 400);
});

test('admin safety rails: cannot lock yourself out or remove the last admin; deactivation ends sessions', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);
  const me = (await admin.call('GET', '/auth/me')).json.data.id;
  assert.equal((await admin.call('PATCH', `/staff/${me}`, { isActive: false })).status, 400);
  assert.equal((await admin.call('PATCH', `/staff/${me}`, { role: 'staff' })).status, 400);

  const tempEmail = `temp${Date.now()}@test.parlour`;
  const made = await admin.call('POST', '/staff', { mobile: nextMobile(), name: 'Temp', email: tempEmail, password: 'Temp12345' });
  assert.equal(made.status, 201);
  const temp = await signedIn(tempEmail, 'Temp12345');
  assert.equal((await admin.call('PATCH', `/staff/${made.json.data.id}`, { isActive: false })).status, 200);
  assert.equal((await temp.call('POST', '/auth/refresh', null, XHR)).status, 401, 'deactivated user cannot refresh');
  assert.equal((await client().login(tempEmail, 'Temp12345')).status, 403, 'deactivated user cannot sign in');
});

// ───────────────────────── platform (super admin) ─────────────────────────

test('super admin: signs in with no parlour; nobody else can use /platform', async () => {
  const r = await client().login('super@demo.parlour');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.user.role, 'super_admin');
  assert.equal(r.json.data.user.parlourId, null);
  assert.equal(r.json.data.user.features, null);

  const admin = await signedIn('admin@demo.parlour');
  const staff = await signedIn('staff@demo.parlour');
  for (const who of [admin, staff]) {
    assert.equal((await who.call('GET', '/platform/parlours')).status, 403);
    assert.equal((await who.call('POST', '/platform/parlours', {})).status, 403);
    assert.equal((await who.call('GET', '/platform/features')).status, 403);
  }
  assert.equal((await client().call('GET', '/platform/parlours')).status, 401, 'signed-out');
});

test('super admin has no parlour, so every parlour-level route refuses them', async () => {
  const sa = await signedIn('super@demo.parlour');
  for (const [method, path] of [['GET', '/services'], ['GET', '/customers'], ['GET', '/invoices'], ['GET', '/staff'], ['GET', '/parlour'], ['GET', '/reports/summary'], ['GET', '/reports/my-day']]) {
    assert.equal((await sa.call(method, path)).status, 403, `super admin ${method} ${path}`);
  }
  assert.equal((await sa.call('POST', '/invoices', { items: [], paymentMethod: 'cash' })).status, 403);
});

test('super admin: create a parlour + its admin; list, view, validate, no duplicate emails', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa, { features: { 'page.team': false } });

  assert.equal(p.data.status, 'active');
  assert.equal(p.data.owner.email, p.email);
  assert.equal(p.data.features['page.team'], false);
  assert.equal(p.data.features['page.services'], true, 'unspecified features default to on');

  const owner = await client().login(p.email, p.password);
  assert.equal(owner.status, 200);
  assert.equal(owner.json.data.user.role, 'admin');
  assert.equal(owner.json.data.user.parlourName, p.name);
  assert.equal(owner.json.data.user.features['page.team'], false);

  const list = (await sa.call('GET', `/platform/parlours?search=${encodeURIComponent(p.name)}`)).json;
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].owner.email, p.email);
  assert.equal((await sa.call('GET', `/platform/parlours/${p.id}`)).json.data.name, p.name);

  const dup = await sa.call('POST', '/platform/parlours', { parlourName: 'Another', adminName: 'Dup', email: p.email.toUpperCase(), password: 'Secret123' });
  assert.equal(dup.status, 409);
  const bad = await sa.call('POST', '/platform/parlours', { parlourName: 'X', adminName: '', email: 'nope', password: 'short', features: { 'page.bogus': false } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error.details.email && bad.json.error.details.password);
});

test('feature switches are enforced by the API, take effect immediately, and can be switched back on', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);
  const set = (features) => sa.call('PATCH', `/platform/parlours/${p.id}`, { features });
  const refused = (r) => { assert.equal(r.status, 403); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };

  // Everything on: set the parlour up.
  const svc = await admin.call('POST', '/services', { name: 'Cut', category: 'Hair', price: 300, durationMin: 30 });
  assert.equal(svc.status, 201);
  const staffMade = await admin.call('POST', '/staff', { mobile: nextMobile(), name: 'Sam', email: `sam${Date.now()}@test.parlour`, password: 'Secret123' });
  assert.equal(staffMade.status, 201);
  const cust = await admin.call('POST', '/customers', { name: 'Cara Customer', phone: '9000000001' });
  assert.equal(cust.status, 201);

  // "Add service" button off: creating is refused, but editing/archiving and the menu itself still work.
  await set({ 'action.services.add': false });
  refused(await admin.call('POST', '/services', { name: 'New one', price: 100 }));
  assert.equal((await admin.call('PATCH', `/services/${svc.json.data.id}`, { price: 350 })).status, 200);
  assert.equal((await admin.call('GET', '/services')).status, 200);

  // Services page off: no changes at all, but billing can still read the menu.
  await set({ 'page.services': false, 'action.services.add': true });
  refused(await admin.call('PATCH', `/services/${svc.json.data.id}`, { price: 400 }));
  refused(await admin.call('POST', '/services', { name: 'Another', price: 100 })); // its button depends on the page
  assert.equal((await admin.call('GET', '/services')).status, 200);
  assert.equal((await admin.call('POST', '/invoices', { items: [{ serviceId: svc.json.data.id, quantity: 1 }], paymentMethod: 'cash' })).status, 201, 'billing still works');
  const me = (await admin.call('GET', '/auth/me')).json.data;
  assert.equal(me.features['page.services'], false);
  assert.equal(me.features['action.services.add'], false, 'a button is off whenever its page is off');

  // Team: button off keeps the page; page off blocks everything.
  await set({ 'action.team.add': false });
  refused(await admin.call('POST', '/staff', { mobile: nextMobile(), name: 'Nope', email: `nope${Date.now()}@test.parlour`, password: 'Secret123' }));
  assert.equal((await admin.call('GET', '/staff')).status, 200);
  assert.equal((await admin.call('PATCH', `/staff/${staffMade.json.data.id}`, { name: 'Sam S' })).status, 200);
  await set({ 'page.team': false });
  refused(await admin.call('GET', '/staff'));
  refused(await admin.call('PATCH', `/staff/${staffMade.json.data.id}`, { name: 'Sam T' }));

  // Customers off: walk-in bills only.
  await set({ 'page.customers': false });
  refused(await admin.call('GET', '/customers'));
  refused(await admin.call('POST', '/customers', { name: 'X Y', phone: '9000000002' }));
  refused(await admin.call('POST', '/invoices', { customerId: cust.json.data.id, items: [{ serviceId: svc.json.data.id, quantity: 1 }], paymentMethod: 'cash' }));
  assert.equal((await admin.call('POST', '/invoices', { walkInName: 'Passer-by', items: [{ serviceId: svc.json.data.id, quantity: 1 }], paymentMethod: 'cash' })).status, 201);

  // Dashboard and Settings.
  await set({ 'page.dashboard': false, 'page.settings': false });
  refused(await admin.call('GET', '/reports/summary'));
  assert.equal((await admin.call('GET', '/reports/my-day')).status, 200);
  refused(await admin.call('PATCH', '/parlour', { name: 'Renamed' }));
  assert.equal((await admin.call('GET', '/parlour')).status, 200, 'bills still need the parlour details');

  // Back on: immediately usable again.
  await set({ 'page.services': true, 'action.team.add': true, 'page.team': true, 'page.customers': true, 'page.dashboard': true, 'page.settings': true });
  assert.equal((await admin.call('POST', '/services', { name: 'Back again', price: 100 })).status, 201);
  assert.equal((await admin.call('GET', '/staff')).status, 200);
  assert.equal((await admin.call('GET', '/customers')).status, 200);
  assert.equal((await admin.call('GET', '/reports/summary')).status, 200);
  const stored = (await sa.call('GET', `/platform/parlours/${p.id}`)).json.data.features;
  assert.ok(Object.values(stored).every(Boolean));

  // Switches belong to one parlour only: the demo parlour was never affected.
  const demo = await signedIn('admin@demo.parlour');
  assert.equal((await demo.call('GET', '/staff')).status, 200);
});

test('suspend blocks sign-in and ends sessions; reactivate restores access', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const owner = await signedIn(p.email, p.password);

  const s = await sa.call('PATCH', `/platform/parlours/${p.id}`, { status: 'suspended' });
  assert.equal(s.json.data.status, 'suspended');
  assert.equal((await owner.call('POST', '/auth/refresh', null, XHR)).status, 401, 'existing session cannot renew');
  const blocked = await client().login(p.email, p.password);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'PARLOUR_SUSPENDED');

  await sa.call('PATCH', `/platform/parlours/${p.id}`, { status: 'active' });
  assert.equal((await client().login(p.email, p.password)).status, 200);
});

test('edit the parlour admin: rename, change email, reset password', async () => {
  const sa = await signedIn('super@demo.parlour');
  const other = await makeParlour(sa);
  const p = await makeParlour(sa);
  const newEmail = `renamed${Date.now()}@test.parlour`;

  const r = await sa.call('PATCH', `/platform/parlours/${p.id}/owner`, { name: 'New Owner Name', email: newEmail });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.owner.name, 'New Owner Name');
  assert.equal((await client().login(p.email, p.password)).status, 401, 'old email no longer works');
  assert.equal((await client().login(newEmail, p.password)).status, 200);
  assert.equal((await sa.call('PATCH', `/platform/parlours/${p.id}/owner`, { email: other.email })).status, 409, "can't take another account's email");

  const session = await signedIn(newEmail, p.password);
  assert.equal((await sa.call('POST', `/platform/parlours/${p.id}/owner/reset-password`, { password: 'Brand-new-1' })).status, 204);
  assert.equal((await session.call('POST', '/auth/refresh', null, XHR)).status, 401, 'reset signs the owner out');
  assert.equal((await client().login(newEmail, p.password)).status, 401);
  assert.equal((await client().login(newEmail, 'Brand-new-1')).status, 200);
  assert.equal((await sa.call('POST', `/platform/parlours/${p.id}/owner/reset-password`, { password: 'weak' })).status, 400);

  const nobody = '00000000-0000-4000-8000-000000000000';
  assert.equal((await sa.call('PATCH', `/platform/parlours/${nobody}`, { name: 'Ghost' })).status, 404);
  assert.equal((await sa.call('PATCH', `/platform/parlours/${nobody}/owner`, { name: 'Ghost' })).status, 404);
});

test('delete a parlour: needs the typed name, then removes the parlour and its people', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const owner = await signedIn(p.email, p.password);
  await owner.call('POST', '/services', { name: 'Cut', category: 'Hair', price: 300 });

  const wrong = await sa.call('DELETE', `/platform/parlours/${p.id}`, { confirmName: 'something else' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.code, 'CONFIRM_MISMATCH');
  assert.equal((await sa.call('GET', `/platform/parlours/${p.id}`)).status, 200, 'still there');
  assert.equal((await sa.call('DELETE', `/platform/parlours/${p.id}`, {})).status, 400, 'confirmation is mandatory');
  assert.equal((await owner.call('DELETE', `/platform/parlours/${p.id}`, { confirmName: p.name })).status, 403, 'only the super admin can delete');

  assert.equal((await sa.call('DELETE', `/platform/parlours/${p.id}`, { confirmName: p.name.toUpperCase() })).status, 204);
  assert.equal((await sa.call('GET', `/platform/parlours/${p.id}`)).status, 404);
  assert.equal((await client().login(p.email, p.password)).status, 401, 'their accounts are gone');
  assert.equal((await sa.call('DELETE', `/platform/parlours/${p.id}`, { confirmName: p.name })).status, 404);
});

test('tenant isolation: one parlour cannot see or touch another’s data', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const other = await signedIn(p.email, p.password);

  const admin = await signedIn('admin@demo.parlour');
  const demoInvoice = (await admin.call('GET', '/invoices?limit=1')).json.data[0];
  const demoCustomer = (await admin.call('GET', '/customers?limit=1')).json.data[0];
  const demoService = (await admin.call('GET', '/services')).json.data[0];
  const demoStaff = (await admin.call('GET', '/staff')).json.data[0];

  assert.equal((await other.call('GET', `/invoices/${demoInvoice.id}`)).status, 404);
  assert.equal((await other.call('GET', `/customers/${demoCustomer.id}`)).status, 404);
  assert.equal((await other.call('PATCH', `/services/${demoService.id}`, { price: 1 })).status, 404);
  assert.equal((await other.call('PATCH', `/staff/${demoStaff.id}`, { isActive: false })).status, 404);
  assert.equal((await other.call('GET', '/invoices')).json.meta.total, 0);
  assert.deepEqual((await other.call('GET', '/services')).json.data, []);
  assert.equal((await other.call('GET', `/invoices?createdBy=${demoStaff.id}`)).json.meta.total, 0);
  assert.equal((await other.call('POST', '/invoices', { items: [{ serviceId: demoService.id, quantity: 1 }], paymentMethod: 'cash' })).status, 400, "cannot bill another parlour's service");
});

// ───────────────────── combos, referrals, WhatsApp ─────────────────────

/** A fresh parlour with 5% GST, a small menu, an admin and one staff member. */
async function parlourWithMenu(sa) {
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);
  assert.equal((await admin.call('PATCH', '/parlour', { taxPercent: 5 })).status, 200);
  const svc = {};
  for (const [name, price] of [['Cut', 200], ['Facial', 500], ['Wax', 300], ['Massage', 1000]]) {
    const r = await admin.call('POST', '/services', { name, category: 'General', price, durationMin: 30 });
    assert.equal(r.status, 201);
    svc[name] = r.json.data;
  }
  const staffEmail = `crew${Date.now()}${Math.floor(Math.random() * 1000)}@test.parlour`;
  assert.equal((await admin.call('POST', '/staff', { mobile: nextMobile(), name: 'Crew', email: staffEmail, password: 'Secret123' })).status, 201);
  const staff = await signedIn(staffEmail, 'Secret123');
  return { p, admin, staff, svc };
}
const line = (id, quantity = 1, kind = 'serviceId') => ({ [kind]: id, quantity });

test('combos: admin creates, edits and deletes; staff can only read; input is validated', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa);

  const made = await admin.call('POST', '/combos', { name: 'Glow Pack', price: 600, items: [{ serviceId: svc.Cut.id, quantity: 1 }, { serviceId: svc.Facial.id, quantity: 1 }] });
  assert.equal(made.status, 201);
  const combo = made.json.data;
  assert.equal(combo.regularPrice, 700);
  assert.equal(combo.savings, 100);
  assert.equal(combo.available, true);
  assert.deepEqual(combo.items.map((i) => i.name).sort(), ['Cut', 'Facial']);

  // Staff can read combos (to bill them) but not change them.
  assert.equal((await staff.call('GET', '/combos')).json.data.length, 1);
  assert.equal((await staff.call('POST', '/combos', { name: 'Nope', price: 1, items: [{ serviceId: svc.Cut.id, quantity: 1 }] })).status, 403);
  assert.equal((await staff.call('PATCH', `/combos/${combo.id}`, { price: 1 })).status, 403);
  assert.equal((await staff.call('DELETE', `/combos/${combo.id}`)).status, 403);

  // Edit price, rename, replace contents.
  const edited = await admin.call('PATCH', `/combos/${combo.id}`, { name: 'Glow Pack Plus', price: 650, items: [{ serviceId: svc.Cut.id, quantity: 2 }, { serviceId: svc.Wax.id, quantity: 1 }] });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.data.regularPrice, 700); // 2×200 + 300
  assert.equal(edited.json.data.savings, 50);

  // Pausing a combo hides it from staff.
  await admin.call('PATCH', `/combos/${combo.id}`, { isActive: false });
  assert.equal((await staff.call('GET', '/combos')).json.data.length, 0);
  assert.equal((await admin.call('GET', '/combos?includeInactive=true')).json.data.length, 1);
  assert.equal((await staff.call('GET', '/combos?includeInactive=true')).json.data.length, 0, 'staff never see paused combos');

  // Validation.
  const dup = await admin.call('POST', '/combos', { name: 'glow pack plus', price: 100, items: [{ serviceId: svc.Cut.id, quantity: 1 }] });
  assert.equal((await admin.call('POST', '/combos', { name: 'Glow Pack Plus', price: 100, items: [{ serviceId: svc.Cut.id, quantity: 1 }] })).status, 409);
  assert.equal(dup.status, 201, 'names are only unique when spelled identically');
  assert.equal((await admin.call('POST', '/combos', { name: 'Empty', price: 100, items: [] })).status, 400);
  assert.equal((await admin.call('POST', '/combos', { name: 'Twice', price: 100, items: [{ serviceId: svc.Cut.id, quantity: 1 }, { serviceId: svc.Cut.id, quantity: 1 }] })).status, 400);
  assert.equal((await admin.call('POST', '/combos', { name: 'Neg', price: -5, items: [{ serviceId: svc.Cut.id, quantity: 1 }] })).status, 400);
  assert.equal((await admin.call('POST', '/combos', { name: 'Ghost', price: 5, items: [{ serviceId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] })).status, 400);

  assert.equal((await admin.call('DELETE', `/combos/${combo.id}`)).status, 204);
  assert.equal((await admin.call('DELETE', `/combos/${combo.id}`)).status, 404);

  // Another parlour cannot use this parlour's services in a combo, or see its combos.
  const other = await parlourWithMenu(sa);
  assert.equal((await other.admin.call('POST', '/combos', { name: 'Steal', price: 5, items: [{ serviceId: svc.Cut.id, quantity: 1 }] })).status, 400);
  assert.equal((await other.admin.call('GET', '/combos')).json.data.length, 0);
});

test('billing a combo: priced from the database, contents written on the bill, survives edits, deletes and archived services', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa);
  const combo = (await admin.call('POST', '/combos', { name: 'Glow Pack', price: 600, items: [{ serviceId: svc.Cut.id, quantity: 1 }, { serviceId: svc.Facial.id, quantity: 2 }] })).json.data;

  // 2 combos (600 each) + 1 cut (200) = 1400; GST 5% = 70; total 1470. Duplicate lines merge.
  const r = await staff.call('POST', '/invoices', {
    items: [line(combo.id, 1, 'comboId'), line(combo.id, 1, 'comboId'), line(svc.Cut.id)],
    paymentMethod: 'cash',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const inv = r.json.data;
  assert.deepEqual([inv.subtotal, inv.tax, inv.total], [1400, 70, 1470]);
  const comboLine = inv.items.find((i) => i.name === 'Glow Pack');
  assert.equal(comboLine.quantity, 2);
  assert.equal(comboLine.lineTotal, 1200);
  assert.equal(comboLine.description, 'Cut + Facial × 2');
  assert.equal(comboLine.comboId, combo.id);

  // Client-supplied prices are ignored for combos too.
  const sneaky = await staff.call('POST', '/invoices', { items: [{ comboId: combo.id, quantity: 1, price: 1, unitPrice: 1 }], total: 1, paymentMethod: 'cash' });
  assert.equal(sneaky.json.data.subtotal, 600);

  // A line must be a service or a combo, not both and not neither.
  assert.equal((await staff.call('POST', '/invoices', { items: [{ serviceId: svc.Cut.id, comboId: combo.id, quantity: 1 }], paymentMethod: 'cash' })).status, 400);
  assert.equal((await staff.call('POST', '/invoices', { items: [{ quantity: 1 }], paymentMethod: 'cash' })).status, 400);

  // Editing and then deleting the combo does not change the old bill.
  await admin.call('PATCH', `/combos/${combo.id}`, { name: 'Renamed', price: 999 });
  const same = (await admin.call('GET', `/invoices/${inv.id}`)).json.data;
  assert.equal(same.items.find((i) => i.comboId).name, 'Glow Pack');
  assert.equal(same.total, 1470);
  await admin.call('DELETE', `/combos/${combo.id}`);
  const after = (await admin.call('GET', `/invoices/${inv.id}`)).json.data;
  assert.equal(after.items.find((i) => i.description).name, 'Glow Pack');
  assert.equal(after.items.find((i) => i.description).comboId, null, 'link is gone, the snapshot stays');
  assert.equal(after.total, 1470);
  assert.equal((await staff.call('POST', '/invoices', { items: [line(combo.id, 1, 'comboId')], paymentMethod: 'cash' })).json.error.code, 'COMBO_UNAVAILABLE');

  // Archiving a service inside a combo makes that combo unavailable, until it is fixed.
  const c2 = (await admin.call('POST', '/combos', { name: 'Wax Pack', price: 400, items: [{ serviceId: svc.Wax.id, quantity: 1 }, { serviceId: svc.Cut.id, quantity: 1 }] })).json.data;
  await admin.call('PATCH', `/services/${svc.Wax.id}`, { isActive: false });
  const listed = (await staff.call('GET', '/combos')).json.data.find((c) => c.id === c2.id);
  assert.equal(listed.available, false);
  const blocked = await staff.call('POST', '/invoices', { items: [line(c2.id, 1, 'comboId')], paymentMethod: 'cash' });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.error.code, 'COMBO_UNAVAILABLE');
  await admin.call('PATCH', `/combos/${c2.id}`, { items: [{ serviceId: svc.Cut.id, quantity: 1 }, { serviceId: svc.Facial.id, quantity: 1 }] });
  assert.equal((await staff.call('POST', '/invoices', { items: [line(c2.id, 1, 'comboId')], paymentMethod: 'cash' })).status, 201);
});

test('referrals: generated IDs, no duplicate phone numbers, staff can only look them up', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff } = await parlourWithMenu(sa);

  const a = await admin.call('POST', '/referrers', { name: 'Anita Rao', contact: '9841100001', percent: 10 });
  assert.equal(a.status, 201);
  assert.equal(a.json.data.code, 'REF-0001');
  assert.deepEqual([a.json.data.percent, a.json.data.bills, a.json.data.totalDiscount, a.json.data.canDelete], [10, 0, 0, true]);

  // The same person, typed differently, is refused, and the failed attempt does not use up an ID.
  const dup = await admin.call('POST', '/referrers', { name: 'Anita again', contact: '+91 98411 00001', percent: 5 });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'CONTACT_EXISTS');
  const b = await admin.call('POST', '/referrers', { name: 'Kumar S', contact: '9841100002', percent: 5.5 });
  assert.equal(b.json.data.code, 'REF-0002');
  assert.equal(b.json.data.percent, 5.5);

  for (const bad of [{ percent: 0 }, { percent: 101 }, { percent: -3 }, { name: 'K' }, { contact: 'abc' }]) {
    assert.equal((await admin.call('POST', '/referrers', { name: 'Valid Name', contact: '9841100009', percent: 10, ...bad })).status, 400, JSON.stringify(bad));
  }

  // Lookup by name, part of a name, or ID. Staff get id, code, name and percent only.
  for (const q of ['anita', 'ani', 'REF-0001', 'ref-0001']) {
    const hit = (await staff.call('GET', `/referrers/lookup?q=${encodeURIComponent(q)}`)).json.data;
    assert.equal(hit.length, 1, q);
    assert.deepEqual(Object.keys(hit[0]).sort(), ['code', 'id', 'name', 'percent']);
  }
  assert.equal((await staff.call('GET', '/referrers/lookup?q=zzz')).json.data.length, 0);
  assert.equal((await staff.call('GET', '/referrers/lookup?q=REF')).json.data.length, 2);

  // Everything else is admin only.
  for (const [method, path, body] of [['GET', '/referrers'], ['GET', `/referrers/${a.json.data.id}`], ['POST', '/referrers', { name: 'Sneaky', contact: '9000000099', percent: 50 }], ['PATCH', `/referrers/${a.json.data.id}`, { percent: 99 }], ['DELETE', `/referrers/${a.json.data.id}`]]) {
    assert.equal((await staff.call(method, path, body)).status, 403, `staff ${method} ${path}`);
  }
  const list = (await admin.call('GET', '/referrers?search=kumar')).json;
  assert.equal(list.data.length, 1);
  assert.equal((await admin.call('GET', '/referrers?search=9841100001')).json.data.length, 1, 'searchable by phone');
});

test('referral discount: percentage of the subtotal, GST on the rest, recorded against the referrer, reversed by a void', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa); // GST 5%
  const ref = (await admin.call('POST', '/referrers', { name: 'Anita Rao', contact: '9841100001', percent: 10 })).json.data;

  // ₹1,000 − 10% referral (₹100) − ₹50 discount = ₹850; GST 5% = ₹42.50; total ₹892.50
  const first = await staff.call('POST', '/invoices', { items: [line(svc.Massage.id)], referrerId: ref.id, discount: 50, paymentMethod: 'upi' });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const f = first.json.data;
  assert.deepEqual([f.subtotal, f.referralPercent, f.referralDiscount, f.discount, f.tax, f.total], [1000, 10, 100, 50, 42.5, 892.5]);
  assert.equal(f.referrer.code, 'REF-0001');
  assert.equal(f.referrer.name, 'Anita Rao');

  let detail = (await admin.call('GET', `/referrers/${ref.id}`)).json.data;
  assert.deepEqual([detail.bills, detail.totalDiscount, detail.canDelete], [1, 100, false]);
  assert.equal(detail.history.length, 1);
  assert.equal(detail.history[0].discount, 100);
  assert.equal(detail.history[0].number, f.number);

  // Second bill (₹400 at 10% = ₹40): the referrer's data is updated again.
  const second = await staff.call('POST', '/invoices', { items: [line(svc.Cut.id, 2)], referrerId: ref.id, paymentMethod: 'cash' });
  assert.deepEqual([second.json.data.referralDiscount, second.json.data.tax, second.json.data.total], [40, 18, 378]);
  detail = (await admin.call('GET', `/referrers/${ref.id}`)).json.data;
  assert.deepEqual([detail.bills, detail.totalDiscount], [2, 140]);

  // Voiding the first bill takes its amount back off.
  assert.equal((await admin.call('POST', `/invoices/${f.id}/void`, { reason: 'Entered twice' })).status, 200);
  detail = (await admin.call('GET', `/referrers/${ref.id}`)).json.data;
  assert.deepEqual([detail.bills, detail.totalDiscount], [1, 40]);
  assert.equal(detail.history.length, 2, 'the history still shows the voided bill');
  assert.equal(detail.history.find((h) => h.number === f.number).status, 'void');

  // A new percentage applies to future bills only.
  assert.equal((await admin.call('PATCH', `/referrers/${ref.id}`, { percent: 20 })).json.data.percent, 20);
  const third = (await staff.call('POST', '/invoices', { items: [line(svc.Massage.id)], referrerId: ref.id, paymentMethod: 'cash' })).json.data;
  assert.deepEqual([third.referralPercent, third.referralDiscount, third.tax, third.total], [20, 200, 40, 840]);
  assert.equal((await admin.call('GET', `/invoices/${second.json.data.id}`)).json.data.referralPercent, 10, 'older bills keep their percentage');
  detail = (await admin.call('GET', `/referrers/${ref.id}`)).json.data;
  assert.deepEqual([detail.bills, detail.totalDiscount], [2, 240]);

  // The dashboard counts referral discounts as discounts given, and shows them separately.
  const totals = (await admin.call('GET', '/reports/summary')).json.data.totals;
  assert.equal(totals.referralDiscounts, 240);
  assert.equal(totals.discounts, 240, 'the voided bill and its ₹50 are excluded');

  // Staff can still apply a referrer, and only see their own bills.
  assert.equal((await staff.call('GET', `/invoices/${third.id}`)).json.data.referrer.name, 'Anita Rao');
});

test('referrals: deactivation, deletion rules, and guard rails on the bill', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa);
  const ref = (await admin.call('POST', '/referrers', { name: 'Anita Rao', contact: '9841100001', percent: 10 })).json.data;
  const bill = (extra) => staff.call('POST', '/invoices', { items: [line(svc.Massage.id)], paymentMethod: 'cash', ...extra });

  // Deactivated referrers disappear from lookup and cannot be applied; reactivating brings them back.
  await admin.call('PATCH', `/referrers/${ref.id}`, { isActive: false });
  assert.equal((await staff.call('GET', '/referrers/lookup?q=anita')).json.data.length, 0);
  const refused = await bill({ referrerId: ref.id });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, 'REFERRER_UNAVAILABLE');
  await admin.call('PATCH', `/referrers/${ref.id}`, { isActive: true });
  assert.equal((await bill({ referrerId: ref.id })).status, 201);

  // Delete: refused once used on a bill (even a void one); allowed when never used.
  assert.equal((await admin.call('DELETE', `/referrers/${ref.id}`)).json.error.code, 'REFERRER_IN_USE');
  const unused = (await admin.call('POST', '/referrers', { name: 'Never Used', contact: '9841100002', percent: 5 })).json.data;
  assert.equal(unused.code, 'REF-0002');
  assert.equal((await admin.call('DELETE', `/referrers/${unused.id}`)).status, 204);
  assert.equal((await admin.call('GET', `/referrers/${unused.id}`)).status, 404);

  // A customer cannot refer themselves (same phone, however it is written).
  const cust = (await admin.call('POST', '/customers', { name: 'Cara', phone: '9000000001' })).json.data;
  const selfRef = (await admin.call('POST', '/referrers', { name: 'Cara Again', contact: '+91 90000-00001', percent: 10 })).json.data;
  const self = await bill({ customerId: cust.id, referrerId: selfRef.id });
  assert.equal(self.status, 400);
  assert.equal(self.json.error.code, 'SELF_REFERRAL');
  assert.equal((await bill({ customerId: cust.id, referrerId: ref.id })).status, 201, 'a different referrer is fine');

  // Referral plus manual discount cannot exceed the bill.
  const full = (await admin.call('POST', '/referrers', { name: 'Everything Off', contact: '9841100003', percent: 100 })).json.data;
  const tooMuch = await bill({ referrerId: full.id, discount: 1 });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.json.error.code, 'DISCOUNT_TOO_HIGH');
  assert.equal((await bill({ referrerId: full.id })).json.data.total, 0, 'a 100% referral is allowed on its own');

  // A referrer from another parlour cannot be used here.
  const other = await parlourWithMenu(sa);
  const foreign = (await other.admin.call('POST', '/referrers', { name: 'Elsewhere', contact: '9841100004', percent: 10 })).json.data;
  assert.equal((await bill({ referrerId: foreign.id })).json.error.code, 'REFERRER_UNAVAILABLE');
  assert.equal((await other.admin.call('GET', `/referrers/${ref.id}`)).status, 404);
});

test('WhatsApp: builds the link and message on the server, with number rules and role scope', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { p, admin, staff, svc } = await parlourWithMenu(sa);
  const combo = (await admin.call('POST', '/combos', { name: 'Glow Pack', price: 600, items: [{ serviceId: svc.Cut.id, quantity: 1 }, { serviceId: svc.Facial.id, quantity: 1 }] })).json.data;
  const ref = (await admin.call('POST', '/referrers', { name: 'Anita Rao', contact: '9841100001', percent: 10 })).json.data;
  const cust = (await admin.call('POST', '/customers', { name: 'Cara Customer', phone: '90000 00005' })).json.data;

  const inv = (await staff.call('POST', '/invoices', { customerId: cust.id, referrerId: ref.id, items: [line(combo.id, 1, 'comboId'), line(svc.Wax.id)], discount: 0, paymentMethod: 'upi' })).json.data;
  // subtotal 900, referral 90, taxable 810, GST 40.50 (CGST 20.25 + SGST 20.25), total 850.50

  const r = await staff.call('GET', `/invoices/${inv.id}/whatsapp`);
  assert.equal(r.status, 200);
  assert.equal(r.json.data.phone, '919000000005', "uses the customer's saved number");
  assert.ok(r.json.data.url.startsWith('https://wa.me/919000000005?text='));
  const text = decodeURIComponent(r.json.data.url.split('?text=')[1]);
  assert.equal(text, r.json.data.message);
  for (const part of [p.name, `Bill ${inv.number}`, 'Customer: Cara Customer', 'Glow Pack: ₹600', '(Cut + Facial)', 'Wax: ₹300', 'Subtotal: ₹900',
                      'Referral discount (Anita Rao, 10%): − ₹90', 'Taxable value: ₹810', 'CGST 2.5%: ₹20.25', 'SGST 2.5%: ₹20.25', '*Total: ₹850.50*', 'Paid by UPI', 'Thank you for visiting!']) {
    assert.ok(text.includes(part), `message should contain "${part}"\n${text}`);
  }

  // A typed number overrides the saved one; numbers are cleaned up; bad ones are refused.
  assert.equal((await staff.call('GET', `/invoices/${inv.id}/whatsapp?phone=${encodeURIComponent('+91 98400-12345')}`)).json.data.phone, '919840012345');
  assert.equal((await staff.call('GET', `/invoices/${inv.id}/whatsapp?phone=12345`)).json.error.code, 'INVALID_PHONE');

  // A walk-in has no saved number, so one must be supplied.
  const walkIn = (await staff.call('POST', '/invoices', { walkInName: 'Passer-by', items: [line(svc.Cut.id)], paymentMethod: 'cash' })).json.data;
  const need = await staff.call('GET', `/invoices/${walkIn.id}/whatsapp`);
  assert.equal(need.status, 400);
  assert.equal(need.json.error.code, 'PHONE_REQUIRED');
  assert.equal((await staff.call('GET', `/invoices/${walkIn.id}/whatsapp?phone=9840012345`)).status, 200);

  // Voided bills are not sent; staff cannot reach a colleague's bill; admin can reach any bill in the parlour.
  await admin.call('POST', `/invoices/${walkIn.id}/void`, { reason: 'Mistake' });
  assert.equal((await staff.call('GET', `/invoices/${walkIn.id}/whatsapp?phone=9840012345`)).json.error.code, 'BILL_VOID');
  const adminsBill = (await admin.call('POST', '/invoices', { walkInName: 'X', items: [line(svc.Cut.id)], paymentMethod: 'cash' })).json.data;
  assert.equal((await staff.call('GET', `/invoices/${adminsBill.id}/whatsapp?phone=9840012345`)).status, 404);
  assert.equal((await admin.call('GET', `/invoices/${inv.id}/whatsapp`)).status, 200);
  assert.equal((await client().call('GET', `/invoices/${inv.id}/whatsapp`)).status, 401);
});

test('switches: combos, referrals and WhatsApp are enforced by the API per parlour', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { p, admin, staff, svc } = await parlourWithMenu(sa);
  const set = (features) => sa.call('PATCH', `/platform/parlours/${p.id}`, { features });
  const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };

  const combo = (await admin.call('POST', '/combos', { name: 'Glow Pack', price: 600, items: [{ serviceId: svc.Cut.id, quantity: 1 }, { serviceId: svc.Facial.id, quantity: 1 }] })).json.data;
  const ref = (await admin.call('POST', '/referrers', { name: 'Anita Rao', contact: '9841100001', percent: 10 })).json.data;
  const bill = (await staff.call('POST', '/invoices', { walkInName: 'W', items: [line(svc.Cut.id)], paymentMethod: 'cash' })).json.data;
  const comboBill = () => staff.call('POST', '/invoices', { items: [line(combo.id, 1, 'comboId')], paymentMethod: 'cash' });
  const refBill = () => staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], referrerId: ref.id, paymentMethod: 'cash' });

  // New switches exist and default to on.
  const features = (await sa.call('GET', '/platform/features')).json.data.map((f) => f.key);
  for (const k of ['page.combos', 'action.combos.add', 'page.referrals', 'action.referrals.add', 'action.whatsapp.send', 'action.team.edit', 'action.team.reset', 'action.team.deactivate']) assert.ok(features.includes(k), k);
  const me0 = (await admin.call('GET', '/auth/me')).json.data.features;
  assert.ok(['page.combos', 'page.referrals', 'action.whatsapp.send', 'action.combos.add', 'action.referrals.add'].every((k) => me0[k] === true));

  // Add combo / Add referrer buttons: only creating is refused.
  await set({ 'action.combos.add': false, 'action.referrals.add': false });
  refused(await admin.call('POST', '/combos', { name: 'Another', price: 100, items: [{ serviceId: svc.Cut.id, quantity: 1 }] }));
  refused(await admin.call('POST', '/referrers', { name: 'Another Person', contact: '9841100002', percent: 5 }));
  assert.equal((await admin.call('PATCH', `/combos/${combo.id}`, { price: 650 })).status, 200);
  assert.equal((await admin.call('PATCH', `/referrers/${ref.id}`, { percent: 12 })).status, 200);
  assert.equal((await admin.call('GET', '/combos')).status, 200);
  assert.equal((await admin.call('GET', '/referrers')).status, 200);

  // Combos page off: no reading, no editing, no billing combos; services still bill.
  await set({ 'page.combos': false, 'action.combos.add': true });
  refused(await admin.call('GET', '/combos'));
  refused(await staff.call('GET', '/combos'));
  refused(await admin.call('DELETE', `/combos/${combo.id}`));
  refused(await comboBill());
  assert.equal((await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], paymentMethod: 'cash' })).status, 201);
  const me1 = (await admin.call('GET', '/auth/me')).json.data.features;
  assert.equal(me1['page.combos'], false);
  assert.equal(me1['action.combos.add'], false, 'its button is off whenever its page is off');
  await set({ 'page.combos': true });
  assert.equal((await comboBill()).status, 201, 'back on, immediately');

  // Referrals page off: no lookup, no admin pages, no referral on a bill.
  await set({ 'page.referrals': false });
  refused(await staff.call('GET', '/referrers/lookup?q=anita'));
  refused(await admin.call('GET', '/referrers'));
  refused(await refBill());
  assert.equal((await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], paymentMethod: 'cash' })).status, 201);
  await set({ 'page.referrals': true });
  assert.equal((await refBill()).status, 201);

  // WhatsApp button off.
  await set({ 'action.whatsapp.send': false });
  refused(await staff.call('GET', `/invoices/${bill.id}/whatsapp?phone=9840012345`));
  refused(await admin.call('GET', `/invoices/${bill.id}/whatsapp?phone=9840012345`));
  assert.equal((await staff.call('GET', `/invoices/${bill.id}`)).status, 200, 'the bill itself is unaffected');
  await set({ 'action.whatsapp.send': true });
  assert.equal((await staff.call('GET', `/invoices/${bill.id}/whatsapp?phone=9840012345`)).status, 200);

  // The demo parlour was never touched.
  const demo = await signedIn('admin@demo.parlour');
  assert.equal((await demo.call('GET', '/combos')).status, 200);
  assert.equal((await demo.call('GET', '/referrers')).status, 200);
});

// ───────────────────── team: mobile numbers and the Team buttons ─────────────────────

test('team: a mobile number is required when adding, checked, shown in the list, and editable', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin } = await parlourWithMenu(sa);
  const base = { name: 'Priya', email: `priya${Date.now()}@test.parlour`, password: 'Secret123' };

  const missing = await admin.call('POST', '/staff', base);
  assert.equal(missing.status, 400);
  assert.ok(missing.json.error.details.mobile, 'a field-level message for the mobile number');
  for (const bad of ['abc', '12345', '']) {
    assert.equal((await admin.call('POST', '/staff', { ...base, mobile: bad })).status, 400, `mobile "${bad}"`);
  }

  const typed = (() => { const n = nextMobile(); return `+91 ${n.slice(0, 5)}-${n.slice(5)}`; })();
  const ok = await admin.call('POST', '/staff', { ...base, mobile: ` ${typed} ` });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.mobile, typed, 'stored without the stray spaces');
  const list = (await admin.call('GET', '/staff')).json.data;
  assert.equal(list.find((m) => m.email === base.email).mobile, typed);
  assert.equal(list.find((m) => m.role === 'admin').mobile, null, 'accounts made before mobile numbers existed show none');

  const newMobile = nextMobile();
  const edited = await admin.call('PATCH', `/staff/${ok.json.data.id}`, { mobile: newMobile });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.data.mobile, newMobile);
  assert.equal(edited.json.data.name, 'Priya', 'other details are left as they were');
  assert.equal((await admin.call('PATCH', `/staff/${ok.json.data.id}`, { mobile: 'nope' })).status, 400);
});

test('team buttons: edit, reset password and deactivate are switched separately, and enforced', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { p, admin } = await parlourWithMenu(sa);
  const member = (await admin.call('POST', '/staff', { mobile: nextMobile(), name: 'Sam', email: `sam${Date.now()}@test.parlour`, password: 'Secret123' })).json.data;
  const set = (features) => sa.call('PATCH', `/platform/parlours/${p.id}`, { features });
  const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };
  const patch = (body) => admin.call('PATCH', `/staff/${member.id}`, body);
  const reset = () => admin.call('POST', `/staff/${member.id}/reset-password`, { password: 'Brand-new-1' });

  // The three switches exist, belong to the Team page, and start on.
  const defs = (await sa.call('GET', '/platform/features')).json.data;
  for (const k of ['action.team.edit', 'action.team.reset', 'action.team.deactivate']) assert.equal(defs.find((d) => d.key === k)?.requires, 'page.team', k);
  const f0 = (await admin.call('GET', '/auth/me')).json.data.features;
  assert.ok(['action.team.edit', 'action.team.reset', 'action.team.deactivate'].every((k) => f0[k] === true));

  // Edit off: name, mobile and role cannot change. Deactivating and resetting still work.
  await set({ 'action.team.edit': false });
  refused(await patch({ name: 'Sam S' }));
  refused(await patch({ mobile: nextMobile() }));
  refused(await patch({ role: 'admin' }));
  assert.equal((await patch({ isActive: false })).status, 200);
  assert.equal((await patch({ isActive: true })).status, 200);
  assert.equal((await reset()).status, 204);
  refused(await patch({ name: 'Sam T', isActive: false })); // one request doing both needs both switches

  // Deactivate off: edit works; deactivating and reactivating are both refused.
  await set({ 'action.team.edit': true, 'action.team.deactivate': false });
  assert.equal((await patch({ name: 'Sam S', mobile: nextMobile() })).status, 200);
  refused(await patch({ isActive: false }));
  refused(await patch({ isActive: true }));
  refused(await patch({ name: 'Sam U', isActive: true }));
  assert.equal((await reset()).status, 204);

  // Reset off: only the password reset is refused.
  await set({ 'action.team.deactivate': true, 'action.team.reset': false });
  refused(await reset());
  assert.equal((await patch({ name: 'Sam V' })).status, 200);
  assert.equal((await patch({ isActive: false })).status, 200);
  assert.equal((await patch({ isActive: true })).status, 200);

  // Team page off: the whole page, and its buttons, are off.
  await set({ 'action.team.reset': true, 'page.team': false });
  const f1 = (await admin.call('GET', '/auth/me')).json.data.features;
  assert.ok(['page.team', 'action.team.add', 'action.team.edit', 'action.team.reset', 'action.team.deactivate'].every((k) => f1[k] === false), 'a button is off whenever its page is off');
  refused(await admin.call('GET', '/staff'));
  refused(await patch({ name: 'Nobody' }));
  refused(await reset());

  // Back on, immediately.
  await set({ 'page.team': true });
  assert.equal((await patch({ name: 'Sam W' })).status, 200);
  assert.equal((await reset()).status, 204);

  // Another parlour was never affected.
  const demo = await signedIn('admin@demo.parlour');
  assert.equal((await demo.call('GET', '/staff')).status, 200);
});

// ───────────────────── request ids, idempotency, customer phone rule ─────────────────────

test('request ids: every answer carries one; a sensible one from the caller is kept; a bad one is replaced; errors repeat it', async () => {
  const c = client();
  const fresh = await c.call('GET', '/health');
  assert.equal(fresh.status, 200);
  assert.match(fresh.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);

  const mine = `smoke-${Date.now()}`;
  const kept = await c.call('GET', '/health', null, { 'X-Request-Id': mine });
  assert.equal(kept.headers.get('x-request-id'), mine);

  const forged = 'not ok: spaces & <tags>';
  const replaced = await c.call('GET', '/health', null, { 'X-Request-Id': forged });
  assert.notEqual(replaced.headers.get('x-request-id'), forged);
  assert.match(replaced.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);

  // Errors carry it in the body too, so a person can quote it when reporting a problem.
  const refused = await c.call('GET', '/invoices', null, { 'X-Request-Id': `${mine}-401` });
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error.requestId, `${mine}-401`);
  assert.equal(refused.headers.get('x-request-id'), `${mine}-401`);
  // (An unknown path is a 401 for someone not signed in, because sign-in is checked first; signed in, it is a 404.)
  const { who: staff } = await billingSetup();
  const missing = await staff.call('GET', '/no-such-route');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'ROUTE_NOT_FOUND');
  assert.equal(missing.json.error.requestId, missing.headers.get('x-request-id'));

  // The browser app may read the request id and the replay marker (only checked when this origin is allowed by CLIENT_URL).
  const cors = await c.call('GET', '/health', null, { Origin: process.env.TEST_ORIGIN || 'http://localhost:4200' });
  if (cors.headers.get('access-control-allow-origin')) {
    const exposed = (cors.headers.get('access-control-expose-headers') || '').toLowerCase();
    assert.ok(exposed.includes('x-request-id') && exposed.includes('idempotent-replay'), `exposed headers: ${exposed}`);
  }
});

/**
 * A signed-in person, a bill to send, and a way to count how many bills they have so far.
 * Remembered per person, so the tests below share one sign-in each instead of repeating it: the suite sends
 * every request from one IP, and the API limits how many it accepts per 15 minutes.
 */
const billingSetups = new Map();
function billingSetup(email = 'staff@demo.parlour') {
  if (!billingSetups.has(email)) {
    billingSetups.set(email, (async () => {
      const who = await signedIn(email);
      const menu = (await who.call('GET', '/services')).json.data;
      const cut = menu.find((s) => s.name === 'Haircut – Men'); // 200
      const body = { items: [{ serviceId: cut.id, quantity: 2 }], discount: 0, paymentMethod: 'cash' };
      const count = async () => (await who.call('GET', '/invoices?limit=1')).json.meta.total;
      return { who, menu, cut, body, count };
    })());
  }
  return billingSetups.get(email);
}
const uniqueKey = (label) => `smoke-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const numberOf = (invoice) => Number(invoice.number.split('-')[1]);

test('idempotency: the same key and request returns the original bill; a second bill is never made', async () => {
  const { who, body, count } = await billingSetup();
  const key = uniqueKey('replay');
  const before = await count();

  const first = await who.call('POST', '/invoices', body, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('idempotent-replay'), null, 'a new bill is not a replay');

  const again = await who.call('POST', '/invoices', body, { 'Idempotency-Key': key });
  assert.equal(again.status, 200, 'a replay answers 200, not 201');
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  assert.equal(again.json.data.id, first.json.data.id);
  assert.equal(again.json.data.number, first.json.data.number);
  for (const field of ['subtotal', 'discount', 'tax', 'total', 'paymentMethod', 'status']) {
    assert.deepEqual(again.json.data[field], first.json.data[field], field);
  }

  assert.equal(await count(), before + 1, 'one bill, not two');

  // The replay did not use up an invoice number: the next bill (no key) is the very next one.
  const next = await who.call('POST', '/invoices', body);
  assert.equal(next.status, 201);
  assert.equal(numberOf(next.json.data), numberOf(first.json.data) + 1);
});

test('idempotency: a bill made without a key behaves exactly as before (two identical requests are two bills)', async () => {
  const { who, body, count } = await billingSetup();
  const before = await count();
  const a = await who.call('POST', '/invoices', body);
  const b = await who.call('POST', '/invoices', body);
  assert.deepEqual([a.status, b.status], [201, 201]);
  assert.notEqual(a.json.data.id, b.json.data.id);
  assert.equal(await count(), before + 2);
});

test('idempotency: a key reused for a different bill is refused with 409 and nothing is created', async () => {
  const { who, cut, body, count } = await billingSetup();
  const key = uniqueKey('reuse');
  const first = await who.call('POST', '/invoices', body, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);
  const before = await count();

  const different = { ...body, items: [{ serviceId: cut.id, quantity: 3 }] };
  const clash = await who.call('POST', '/invoices', different, { 'Idempotency-Key': key });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await count(), before, 'nothing was created');

  // The original request still replays fine afterwards.
  assert.equal((await who.call('POST', '/invoices', body, { 'Idempotency-Key': key })).status, 200);
});

test('idempotency: five copies of one request sent at the same moment make exactly one bill', async () => {
  const { who, body, count } = await billingSetup();
  const key = uniqueKey('race');
  const before = await count();

  const results = await Promise.all(Array.from({ length: 5 }, () => who.call('POST', '/invoices', body, { 'Idempotency-Key': key })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 200, 201], JSON.stringify(results.map((r) => r.json?.error ?? r.status)));
  assert.equal(new Set(results.map((r) => r.json.data.id)).size, 1, 'all five answers are the same bill');
  assert.equal(await count(), before + 1, 'one bill');

  // The four that lost the race rolled back whole, so no invoice number was burnt.
  const winner = results.find((r) => r.status === 201).json.data;
  const next = await who.call('POST', '/invoices', body);
  assert.equal(numberOf(next.json.data), numberOf(winner) + 1);
});

test('idempotency: a malformed key is refused with a field error and nothing is created', async () => {
  const { who, body, count } = await billingSetup();
  const before = await count();
  for (const bad of ['short', 'has spaces in the key', 'a'.repeat(129), 'quote"in-the-key-1234', 'semi;colon-in-key-1234']) {
    const r = await who.call('POST', '/invoices', body, { 'Idempotency-Key': bad });
    assert.equal(r.status, 400, `key ${JSON.stringify(bad).slice(0, 30)}`);
    assert.equal(r.json.error.code, 'VALIDATION_ERROR');
    assert.ok(r.json.error.details['idempotency-key'], 'the message is on the key field');
  }
  assert.equal(await count(), before);
});

test('idempotency: a key is private to one person in one parlour, so it can never reach someone else\'s bill', async () => {
  const sa = await signedIn('super@demo.parlour');
  const other = await makeParlour(sa);
  const otherOwner = await signedIn(other.email, other.password);
  const svc = (await otherOwner.call('POST', '/services', { name: 'Cut', category: 'Hair', price: 100, durationMin: 20 })).json.data;

  const riya = await billingSetup('staff@demo.parlour');
  const farah = await billingSetup('farah@demo.parlour');
  const admin = await billingSetup('admin@demo.parlour');
  const key = uniqueKey('private');

  const riyas = await riya.who.call('POST', '/invoices', riya.body, { 'Idempotency-Key': key });
  assert.equal(riyas.status, 201);

  // A colleague, the admin, and another parlour all use the SAME key: each gets their own, new bill.
  const farahs = await farah.who.call('POST', '/invoices', farah.body, { 'Idempotency-Key': key });
  const admins = await admin.who.call('POST', '/invoices', admin.body, { 'Idempotency-Key': key });
  const theirs = await otherOwner.call('POST', '/invoices', { items: [{ serviceId: svc.id, quantity: 1 }], paymentMethod: 'cash' }, { 'Idempotency-Key': key });
  for (const r of [farahs, admins, theirs]) assert.equal(r.status, 201, 'a new bill, not a replay of Riya\'s');
  assert.equal(farahs.json.data.createdByName, 'Farah');
  assert.equal(new Set([riyas, farahs, admins, theirs].map((r) => r.json.data.id)).size, 4);
  assert.equal(theirs.json.data.total, 100, 'priced from their own menu (₹100, and a new parlour starts at 0% GST)');

  // Riya's own replay still returns Riya's bill.
  const replay = await riya.who.call('POST', '/invoices', riya.body, { 'Idempotency-Key': key });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.id, riyas.json.data.id);

  // Even sending Riya's exact request with Farah's login does not return Riya's bill.
  const sneaky = await farah.who.call('POST', '/invoices', riya.body, { 'Idempotency-Key': key });
  assert.notEqual(sneaky.json.data?.id, riyas.json.data.id);
  assert.ok([200, 201].includes(sneaky.status));
});

test('customers: a phone number needs at least 10 digits; it is kept as typed; the same rule applies on edit', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);

  for (const bad of ['-------', '((((((((', '12345678', '123456789']) {
    const r = await admin.call('POST', '/customers', { name: 'Bad Phone', phone: bad });
    assert.equal(r.status, 400, `phone ${bad}`);
    assert.match(r.json.error.details.phone, /at least 10 digits/);
  }
  assert.equal((await admin.call('POST', '/customers', { name: 'Bad Phone', phone: 'abcdefghij' })).json.error.details.phone, 'Enter a valid phone number');

  const stamp = String(Date.now()).slice(-8);
  const ok = await admin.call('POST', '/customers', { name: 'Phone Rule', phone: `+91 98${stamp}` });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.phone, `+91 98${stamp}`, 'stored exactly as typed');

  const id = ok.json.data.id;
  assert.equal((await admin.call('PATCH', `/customers/${id}`, { phone: '12345' })).status, 400);
  assert.equal((await admin.call('PATCH', `/customers/${id}`, { name: 'Renamed Person' })).status, 200, 'changing only the name needs no phone');
  assert.equal((await admin.call('PATCH', `/customers/${id}`, { phone: `98${stamp}` })).status, 200);
});

// ───────────────────── GST: CGST/SGST split, GSTIN, SAC, and prices with or without GST inside ─────────────────────

test('GST: a bill carries the CGST/SGST split, the GSTIN and each service\'s SAC, and later changes never touch it', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa); // 5% GST, added on top of the prices
  assert.equal((await admin.call('PATCH', '/parlour', { gstNumber: '33ABCDE1234F1Z5' })).status, 200);
  assert.equal((await admin.call('GET', '/parlour')).json.data.gstPriceMode, 'exclusive', 'GST is added on top until the owner says otherwise');
  assert.equal(svc.Cut.sacCode, null, 'a service has no SAC until one is given');

  // A SAC is optional and 6 digits. Saving something else leaves it alone; null or blank clears it.
  const bad = await admin.call('PATCH', `/services/${svc.Cut.id}`, { sacCode: '9997' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.details.sacCode, /6 digits/);
  assert.equal((await admin.call('POST', '/services', { name: 'Bad SAC', price: 10, sacCode: '99972X' })).status, 400);
  assert.equal((await admin.call('PATCH', `/services/${svc.Cut.id}`, { sacCode: ' 999721 ' })).json.data.sacCode, '999721');
  assert.equal((await admin.call('PATCH', `/services/${svc.Cut.id}`, { price: 200 })).json.data.sacCode, '999721');
  assert.equal((await admin.call('PATCH', `/services/${svc.Cut.id}`, { isActive: true })).json.data.sacCode, '999721');
  const spa = await admin.call('POST', '/services', { name: 'Spa', price: 100, sacCode: '999722' });
  assert.equal(spa.status, 201);
  assert.equal(spa.json.data.sacCode, '999722');
  assert.equal((await admin.call('PATCH', `/services/${spa.json.data.id}`, { sacCode: '' })).json.data.sacCode, null);
  assert.equal((await admin.call('PATCH', `/services/${spa.json.data.id}`, { sacCode: '999722' })).json.data.sacCode, '999722');
  assert.equal((await admin.call('PATCH', `/services/${spa.json.data.id}`, { sacCode: null })).json.data.sacCode, null);

  // 2 × ₹200 + ₹500 = ₹900; 5% on top is ₹45, written as CGST ₹22.50 + SGST ₹22.50.
  const first = (await staff.call('POST', '/invoices', { items: [line(svc.Cut.id, 2), line(svc.Facial.id)], paymentMethod: 'cash' })).json.data;
  assert.deepEqual([first.subtotal, first.taxPercent, first.tax, first.cgst, first.sgst, first.taxable, first.total, first.priceMode], [900, 5, 45, 22.5, 22.5, 900, 945, 'exclusive']);
  assert.equal(first.gstin, '33ABCDE1234F1Z5');
  const sacOf = (inv, name) => inv.items.find((i) => i.name === name).sacCode;
  assert.deepEqual([sacOf(first, 'Cut'), sacOf(first, 'Facial')], ['999721', null]);
  const before = (await staff.call('GET', `/invoices/${first.id}`)).json.data;

  // The owner now says prices include GST, raises the rate, changes the GSTIN and the service's SAC and price.
  assert.equal((await admin.call('PATCH', '/parlour', { gstPriceMode: 'inclusive', taxPercent: 18, gstNumber: '33ZZZZZ9999Z1Z9' })).status, 200);
  assert.equal((await admin.call('PATCH', `/services/${svc.Cut.id}`, { sacCode: '999722', price: 999 })).status, 200);

  // The bill made before is exactly as it was: same prices, tax, split, GSTIN and SAC.
  assert.deepEqual((await staff.call('GET', `/invoices/${first.id}`)).json.data, before);

  // A new bill uses the new settings. ₹999 with 18% inside: GST ₹152.39 (CGST ₹76.20 + SGST ₹76.19), taxable ₹846.61, customer pays ₹999.
  const second = (await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], paymentMethod: 'upi' })).json.data;
  assert.deepEqual([second.subtotal, second.taxPercent, second.tax, second.cgst, second.sgst, second.taxable, second.total, second.priceMode], [999, 18, 152.39, 76.2, 76.19, 846.61, 999, 'inclusive']);
  assert.equal(second.gstin, '33ZZZZZ9999Z1Z9');
  assert.equal(sacOf(second, 'Cut'), '999722');

  // The dashboard still adds the bills up: takings are what customers paid, GST is the tax on them.
  const totals = (await admin.call('GET', '/reports/summary')).json.data.totals;
  assert.deepEqual([totals.invoices, totals.revenue, totals.tax], [2, 1944, 197.39]);

  // Back to GST on top, at 2.5%: ₹10.10 → 25.25 paise → 25 paise, the odd paisa on CGST.
  assert.equal((await admin.call('PATCH', '/parlour', { gstPriceMode: 'exclusive', taxPercent: 2.5 })).status, 200);
  const odd = (await admin.call('POST', '/services', { name: 'Odd job', price: 10.1, durationMin: 30 })).json.data;
  const third = (await staff.call('POST', '/invoices', { items: [line(odd.id)], paymentMethod: 'cash' })).json.data;
  assert.deepEqual([third.tax, third.cgst, third.sgst, third.total], [0.25, 0.13, 0.12, 10.35]);

  // WhatsApp carries the same details, and each bill keeps the GSTIN it was made under.
  const wa = async (inv) => decodeURIComponent((await staff.call('GET', `/invoices/${inv.id}/whatsapp?phone=9840012345`)).json.data.url.split('?text=')[1]);
  const t1 = await wa(first);
  for (const part of ['GSTIN: 33ABCDE1234F1Z5', 'SAC 999721', 'Subtotal: ₹900', 'Taxable value: ₹900', 'CGST 2.5%: ₹22.50', 'SGST 2.5%: ₹22.50', '*Total: ₹945*']) assert.ok(t1.includes(part), `${part}\n${t1}`);
  const t2 = await wa(second);
  for (const part of ['GSTIN: 33ZZZZZ9999Z1Z9', 'SAC 999722', 'Subtotal (incl. GST): ₹999', '*Total: ₹999*', 'Total includes GST of ₹152.39:', 'Taxable value: ₹846.61', 'CGST 9%: ₹76.20', 'SGST 9%: ₹76.19']) assert.ok(t2.includes(part), `${part}\n${t2}`);

  // Bad settings are refused.
  assert.equal((await admin.call('PATCH', '/parlour', { gstPriceMode: 'both' })).status, 400);
  assert.equal((await admin.call('PATCH', '/parlour', { gstPriceMode: null })).status, 400);
});

test('GST settings and SAC codes: only the owner changes them, only for their own parlour, and the switches still apply', async () => {
  const sa = await signedIn('super@demo.parlour');
  const a = await parlourWithMenu(sa); // GST 5% on top
  const b = await parlourWithMenu(sa);
  const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };

  // Staff can read the setting (the billing screen needs it) but cannot change it, or any SAC.
  assert.equal((await a.staff.call('GET', '/parlour')).json.data.gstPriceMode, 'exclusive');
  assert.equal((await a.staff.call('PATCH', '/parlour', { gstPriceMode: 'inclusive' })).status, 403);
  assert.equal((await a.staff.call('PATCH', `/services/${a.svc.Cut.id}`, { sacCode: '999721' })).status, 403);
  assert.equal((await a.staff.call('POST', '/services', { name: 'Staff service', price: 1, sacCode: '999721' })).status, 403);
  assert.equal((await a.admin.call('GET', '/parlour')).json.data.gstPriceMode, 'exclusive', 'nothing changed');

  // One parlour's setting is its own: the same ₹1,000 massage makes a different bill in each.
  assert.equal((await a.admin.call('PATCH', '/parlour', { gstPriceMode: 'inclusive' })).status, 200);
  assert.equal((await b.admin.call('GET', '/parlour')).json.data.gstPriceMode, 'exclusive');
  const billA = (await a.staff.call('POST', '/invoices', { items: [line(a.svc.Massage.id)], paymentMethod: 'cash' })).json.data;
  const billB = (await b.staff.call('POST', '/invoices', { items: [line(b.svc.Massage.id)], paymentMethod: 'cash' })).json.data;
  assert.deepEqual([billA.priceMode, billA.total, billA.tax, billA.cgst, billA.sgst], ['inclusive', 1000, 47.62, 23.81, 23.81]);
  assert.deepEqual([billB.priceMode, billB.total, billB.tax, billB.cgst, billB.sgst], ['exclusive', 1050, 50, 25, 25]);

  // One parlour cannot reach another's services or bills.
  const cross = await b.admin.call('PATCH', `/services/${a.svc.Cut.id}`, { sacCode: '999721' });
  assert.equal(cross.status, 404);
  assert.equal((await a.admin.call('GET', '/services?includeInactive=true')).json.data.find((s) => s.id === a.svc.Cut.id).sacCode, null);
  assert.equal((await b.admin.call('GET', `/invoices/${billA.id}`)).status, 404);
  assert.equal((await b.staff.call('POST', '/invoices', { items: [line(a.svc.Cut.id)], paymentMethod: 'cash' })).status, 400, 'another parlour\'s service cannot be billed');

  // The Settings and Services switches are enforced on the API, not just hidden in the app.
  const set = (features) => sa.call('PATCH', `/platform/parlours/${a.p.id}`, { features });
  await set({ 'page.settings': false });
  refused(await a.admin.call('PATCH', '/parlour', { gstPriceMode: 'exclusive' }));
  assert.equal((await a.staff.call('GET', '/parlour')).status, 200, 'the billing screen can still read the setting');
  assert.equal((await a.staff.call('POST', '/invoices', { items: [line(a.svc.Cut.id)], paymentMethod: 'cash' })).status, 201, 'billing is not switchable');
  await set({ 'page.settings': true, 'page.services': false });
  refused(await a.admin.call('PATCH', `/services/${a.svc.Cut.id}`, { sacCode: '999721' }));
  refused(await a.admin.call('POST', '/services', { name: 'Blocked', price: 5, sacCode: '999721' }));
  await set({ 'page.services': true });
  assert.equal((await a.admin.call('PATCH', `/services/${a.svc.Cut.id}`, { sacCode: '999721' })).status, 200, 'back on, immediately');
});


// ───────────────────── Payments: split across cash / UPI / card, tips, and the reports ─────────────────────

test('payments: a bill can be split across methods that add up to the total to the paisa; anything else is refused and nothing is saved', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa); // 5% GST on top
  const items = [line(svc.Cut.id, 2), line(svc.Facial.id)]; // 2 × ₹200 + ₹500 = ₹900; 5% GST = ₹45; total ₹945
  const billCount = async () => (await admin.call('GET', '/invoices')).json.meta.total;
  assert.equal(await billCount(), 0);

  const made = await staff.call('POST', '/invoices', { items, payments: [{ method: 'upi', amount: 445 }, { method: 'cash', amount: 500 }] });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const bill = made.json.data;
  assert.deepEqual([bill.total, bill.paymentMethod, bill.tip], [945, 'split', 0]);
  assert.deepEqual(bill.payments, [{ method: 'cash', amount: 500 }, { method: 'upi', amount: 445 }], 'in the fixed order, whatever order was sent');
  assert.deepEqual((await staff.call('GET', `/invoices/${bill.id}`)).json.data.payments, bill.payments, 'reads back the same');
  assert.equal((await admin.call('GET', '/invoices')).json.data[0].paymentMethod, 'split');

  // One paisa short, one paisa over, wrong total, and the old and new way together: all refused, and no bill is made.
  const mismatch = async (payments, pattern) => {
    const r = await staff.call('POST', '/invoices', { items, payments });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'PAYMENTS_MISMATCH');
    assert.match(r.json.error.message, pattern);
    assert.equal(r.json.error.details.payments, r.json.error.message);
  };
  await mismatch([{ method: 'cash', amount: 500 }, { method: 'upi', amount: 444.99 }], /₹0\.01 short of the bill total of ₹945\.00/);
  await mismatch([{ method: 'cash', amount: 500 }, { method: 'upi', amount: 445.01 }], /₹0\.01 more than the bill total of ₹945\.00/);
  await mismatch([{ method: 'cash', amount: 900 }], /₹45\.00 short/); // the total WITH the GST is what has to be paid
  const both = await staff.call('POST', '/invoices', { items, paymentMethod: 'cash', payments: [{ method: 'cash', amount: 945 }] });
  assert.equal(both.status, 400);
  assert.equal(both.json.error.code, 'VALIDATION_ERROR');
  const neither = await staff.call('POST', '/invoices', { items });
  assert.equal(neither.status, 400);
  assert.ok(neither.json.error.details.paymentMethod);
  for (const payments of [
    [{ method: 'cash', amount: 400 }, { method: 'cash', amount: 545 }],                  // a method twice
    [{ method: 'cash', amount: 945 }, { method: 'upi', amount: 0 }],                     // a method left at 0
    [{ method: 'cash', amount: 944.995 }, { method: 'upi', amount: 0.005 }],             // part of a paisa
    [{ method: 'cheque', amount: 945 }],                                                  // unknown method
    [{ method: 'cash', amount: -5 }, { method: 'upi', amount: 950 }],                    // negative
    [],
  ]) {
    const r = await staff.call('POST', '/invoices', { items, payments });
    assert.equal(r.status, 400, JSON.stringify(payments));
    assert.equal(r.json.error.code, 'VALIDATION_ERROR', JSON.stringify(payments));
  }
  assert.equal(await billCount(), 1, 'only the one good bill exists');

  // The old way still works exactly as before: one method for the whole bill.
  const single = (await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], paymentMethod: 'upi' })).json.data;
  assert.deepEqual([single.paymentMethod, single.total, single.payments], ['upi', 210, [{ method: 'upi', amount: 210 }]]);
  // A list of one method is the same thing.
  const listOfOne = (await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], payments: [{ method: 'card', amount: 210 }] })).json.data;
  assert.deepEqual([listOfOne.paymentMethod, listOfOne.payments], ['card', [{ method: 'card', amount: 210 }]]);
});

test('payments: a tip is kept on the bill and is never part of the total, the tax, or what has to be paid', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { staff, svc } = await parlourWithMenu(sa);
  const plain = (await staff.call('POST', '/invoices', { items: [line(svc.Massage.id)], paymentMethod: 'cash' })).json.data;
  const tipped = await staff.call('POST', '/invoices', { items: [line(svc.Massage.id)], paymentMethod: 'cash', tip: 50 });
  assert.equal(tipped.status, 201, JSON.stringify(tipped.json));
  for (const k of ['subtotal', 'tax', 'cgst', 'sgst', 'total']) assert.equal(tipped.json.data[k], plain[k], k);
  assert.deepEqual([plain.tip, tipped.json.data.tip], [0, 50]);
  assert.deepEqual(tipped.json.data.payments, [{ method: 'cash', amount: 1050 }], 'the payment is the bill total, without the tip');
  assert.equal((await staff.call('GET', `/invoices/${tipped.json.data.id}`)).json.data.tip, 50);

  // Payments that include the tip are too much, and are refused.
  const tipIncluded = await staff.call('POST', '/invoices', { items: [line(svc.Massage.id)], tip: 50, payments: [{ method: 'cash', amount: 1100 }] });
  assert.equal(tipIncluded.status, 400);
  assert.equal(tipIncluded.json.error.code, 'PAYMENTS_MISMATCH');
  for (const tip of [-1, 1.005, 'lots']) assert.equal((await staff.call('POST', '/invoices', { items: [line(svc.Massage.id)], paymentMethod: 'cash', tip })).status, 400, `tip ${tip}`);
});

test('payments: the same key and the same split bill returns the original; a different split with that key is refused', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa);
  const key = `split-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const items = [line(svc.Cut.id)];
  const body = { items, payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 110 }], tip: 10 };
  const first = await staff.call('POST', '/invoices', body, { 'Idempotency-Key': key });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const again = await staff.call('POST', '/invoices', { ...body, payments: [...body.payments].reverse() }, { 'Idempotency-Key': key });
  assert.equal(again.status, 200, 'the order the payments were listed in does not make it a different bill');
  assert.equal(again.headers.get('idempotent-replay'), 'true');
  assert.equal(again.json.data.id, first.json.data.id);
  const other = await staff.call('POST', '/invoices', { ...body, payments: [{ method: 'cash', amount: 110 }, { method: 'upi', amount: 100 }] }, { 'Idempotency-Key': key });
  assert.equal(other.status, 409);
  assert.equal(other.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
  const otherTip = await staff.call('POST', '/invoices', { ...body, tip: 20 }, { 'Idempotency-Key': key });
  assert.equal(otherTip.status, 409);
  assert.equal((await admin.call('GET', '/invoices')).json.meta.total, 1, 'one bill, however many times it was sent');
});

test('payments: the Split payment button and the Tip box are switched separately, enforced on the API, and one method is never switchable', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { p, admin, staff, svc } = await parlourWithMenu(sa);
  const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };
  const set = (features) => sa.call('PATCH', `/platform/parlours/${p.id}`, { features });
  const items = [line(svc.Cut.id)]; // ₹210 with GST
  const split = (extra = {}) => staff.call('POST', '/invoices', { items, payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 110 }], ...extra });
  const tipped = () => staff.call('POST', '/invoices', { items, paymentMethod: 'cash', tip: 20 });
  const plain = () => staff.call('POST', '/invoices', { items, paymentMethod: 'cash' });

  // Both exist, listed for the platform admin, and are on by default.
  const keys = (await sa.call('GET', '/platform/features')).json.data.map((f) => f.key);
  assert.ok(keys.includes('action.payments.split') && keys.includes('action.payments.tip'));
  const me = (await admin.call('GET', '/auth/me')).json.data.features;
  assert.equal(me['action.payments.split'], true);
  assert.equal(me['action.payments.tip'], true);
  assert.equal((await split()).status, 201);
  assert.equal((await tipped()).status, 201);

  await set({ 'action.payments.split': false });
  refused(await split());
  assert.equal((await tipped()).status, 201, 'the tip is its own switch');
  assert.equal((await plain()).status, 201, 'one method always works');
  assert.equal((await staff.call('POST', '/invoices', { items, payments: [{ method: 'cash', amount: 210 }] })).status, 201, 'a list of one method is just one method');

  await set({ 'action.payments.split': true, 'action.payments.tip': false });
  refused(await tipped());
  assert.equal((await split()).status, 201);
  assert.equal((await staff.call('POST', '/invoices', { items, paymentMethod: 'cash', tip: 0 })).status, 201, 'no tip is not a tip');
  assert.equal((await plain()).status, 201);

  await set({ 'action.payments.split': false, 'action.payments.tip': false });
  assert.equal((await plain()).status, 201, 'with both off, billing carries on with one method');
  await set({ 'action.payments.split': true, 'action.payments.tip': true });
  assert.equal((await tipped()).status, 201, 'back on, immediately');
});

test('payments: reports read the payments table, count old bills by their one method, leave out void bills, and the methods add up to the revenue', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa);
  const summary = async () => (await admin.call('GET', '/reports/summary')).json.data;

  const a = (await staff.call('POST', '/invoices', { items: [line(svc.Cut.id, 2), line(svc.Facial.id)], payments: [{ method: 'upi', amount: 445 }, { method: 'cash', amount: 500 }] })).json.data; // ₹945
  const b = (await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], paymentMethod: 'card' })).json.data;                                                                              // ₹210
  await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], tip: 50, payments: [{ method: 'cash', amount: 210 }] });                                                                      // ₹210 + ₹50 tip

  let s = await summary();
  assert.deepEqual(s.byPayment, [{ method: 'cash', invoices: 2, revenue: 710 }, { method: 'upi', invoices: 1, revenue: 445 }, { method: 'card', invoices: 1, revenue: 210 }]);
  assert.deepEqual([s.totals.invoices, s.totals.revenue, s.totals.tips], [3, 1365, 50], 'revenue is the bills; the tip is not in it');
  assert.equal(Math.round(s.byPayment.reduce((t, m) => t + m.revenue * 100, 0)), Math.round(s.totals.revenue * 100));

  // A void bill drops out of every method it was paid with.
  assert.equal((await admin.call('POST', `/invoices/${a.id}/void`, { reason: 'Entered twice' })).status, 200);
  s = await summary();
  assert.deepEqual(s.byPayment, [{ method: 'card', invoices: 1, revenue: 210 }, { method: 'cash', invoices: 1, revenue: 210 }], 'equal takings are listed by method name');
  assert.deepEqual([s.totals.revenue, s.totals.tips], [420, 50]);
  assert.equal((await admin.call('POST', `/invoices/${b.id}/void`, { reason: 'Wrong bill' })).status, 200);
  assert.deepEqual((await summary()).byPayment, [{ method: 'cash', invoices: 1, revenue: 210 }]);
});

test('payments: on the demo parlour, where old bills (no payment rows) and new ones are mixed, the methods still add up to the revenue', async () => {
  const admin = await signedIn('admin@demo.parlour');
  const s = (await admin.call('GET', '/reports/summary')).json.data;
  assert.ok(s.totals.invoices > 0, 'the demo seed has bills');
  assert.equal(Math.round(s.byPayment.reduce((t, m) => t + m.revenue * 100, 0)), Math.round(s.totals.revenue * 100), 'nothing counted twice, nothing missed');
  assert.ok(s.byPayment.every((m) => ['cash', 'upi', 'card'].includes(m.method)), '"split" is never a method in the report: a split bill is counted under each method it used');
  assert.ok(s.byPayment.reduce((n, m) => n + m.invoices, 0) >= s.totals.invoices, 'a split bill is in each of its methods, so the bill counts add up to at least the number of bills');
});

test('payments: one parlour cannot see, use or change another\'s payments', async () => {
  const sa = await signedIn('super@demo.parlour');
  const a = await parlourWithMenu(sa);
  const b = await parlourWithMenu(sa);
  const bill = (await a.staff.call('POST', '/invoices', { items: [line(a.svc.Cut.id)], tip: 15, payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 110 }] })).json.data;

  // Another parlour's admin and staff get "not found" for the bill, so its payments and tip are out of reach.
  assert.equal((await b.admin.call('GET', `/invoices/${bill.id}`)).status, 404);
  assert.equal((await b.staff.call('GET', `/invoices/${bill.id}`)).status, 404);
  assert.equal((await b.admin.call('GET', `/invoices/${bill.id}/whatsapp?phone=9840012345`)).status, 404);
  assert.equal((await b.admin.call('POST', `/invoices/${bill.id}/void`, { reason: 'Not yours to void' })).status, 404);
  assert.equal((await a.admin.call('GET', `/invoices/${bill.id}`)).json.data.status, 'paid', 'and nothing happened to it');
  assert.equal((await b.admin.call('GET', '/invoices')).json.meta.total, 0);

  // Its reports show none of it, and the other parlour's own numbers are untouched.
  const theirs = (await b.admin.call('GET', '/reports/summary')).json.data;
  assert.deepEqual([theirs.byPayment, theirs.totals.revenue, theirs.totals.tips], [[], 0, 0]);
  const mine = (await a.admin.call('GET', '/reports/summary')).json.data;
  assert.deepEqual(mine.byPayment, [{ method: 'upi', invoices: 1, revenue: 110 }, { method: 'cash', invoices: 1, revenue: 100 }]);
  assert.equal(mine.totals.tips, 15);

  // One parlour cannot pay a bill using the other's menu, whatever the payments say.
  const cross = await b.staff.call('POST', '/invoices', { items: [line(a.svc.Cut.id)], payments: [{ method: 'cash', amount: 210 }] });
  assert.equal(cross.status, 400);
  assert.notEqual(cross.json.error.code, 'PAYMENTS_MISMATCH');
});

test('payments: the WhatsApp message lists each method of a split bill and the tip', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { staff, svc } = await parlourWithMenu(sa);
  const bill = (await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], tip: 15, payments: [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 110 }] })).json.data;
  const wa = await staff.call('GET', `/invoices/${bill.id}/whatsapp?phone=9840012345`);
  assert.equal(wa.status, 200, JSON.stringify(wa.json));
  const lines = wa.json.data.message.split('\n');
  assert.ok(lines.includes('Paid by cash ₹100 + UPI ₹110'), lines.join(' | '));
  assert.ok(lines.includes('Tip: ₹15 (not included in the total)'));
  const one = (await staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], paymentMethod: 'upi' })).json.data;
  const oneLines = (await staff.call('GET', `/invoices/${one.id}/whatsapp?phone=9840012345`)).json.data.message.split('\n');
  assert.ok(oneLines.includes('Paid by UPI'));
  assert.equal(oneLines.some((l) => l.startsWith('Tip')), false);
});

// ───────────────────────── performers and commission (Phase 4) ─────────────────────────

// Today in the parlours these tests make (they use the default time zone, Asia/Kolkata, which has no daylight saving).
const localDay = (offset = 0) => new Date(Date.now() + 19_800_000 + offset * 86_400_000).toISOString().slice(0, 10);
const thisWeek = () => ({ from: localDay(-1), to: localDay(1) });
const commissionsOf = async (admin, range = thisWeek()) => (await admin.call('GET', `/commissions?from=${range.from}&to=${range.to}`)).json.data;
const addPerson = async (admin, name) => { const r = await admin.call('POST', '/performers', { name }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.data; };
const setRule = (admin, target, kind, value) => admin.call('PUT', '/commissions/rules', { ...target, kind, value });
const notFound = (r) => { assert.equal(r.status, 404, JSON.stringify(r.json)); };

test('performers: the admin keeps the list of names, staff can only read the active ones, and a name is used once', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa);

  const meena = await addPerson(admin, 'Meena');
  assert.deepEqual([meena.name, meena.isActive, meena.lines, meena.canDelete], ['Meena', true, 0, true]);
  const dup = await admin.call('POST', '/performers', { name: '  MEENA ' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'PERFORMER_EXISTS');
  const bad = await admin.call('POST', '/performers', { name: 'a' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error.details.name, 'the field is named in the error');
  assert.equal((await admin.call('POST', '/performers', {})).status, 400);

  // They are names, not people who sign in: no login, no password, no role come with them.
  assert.deepEqual(Object.keys(meena).sort(), ['canDelete', 'id', 'isActive', 'lines', 'name']);

  const asha = await addPerson(admin, 'Asha');
  assert.equal((await admin.call('PATCH', `/performers/${asha.id}`, { name: 'Asha K' })).json.data.name, 'Asha K');
  assert.equal((await admin.call('PATCH', `/performers/${asha.id}`, {})).status, 400, 'nothing to update');
  assert.equal((await admin.call('PATCH', `/performers/${asha.id}`, { name: 'meena' })).status, 409, 'renaming onto another name is refused too');
  assert.equal((await admin.call('PATCH', `/performers/${asha.id}`, { isActive: false })).json.data.isActive, false);

  // Staff read the list for the billing counter: active names only, nothing else, and asking for more changes nothing.
  const seen = await staff.call('GET', '/performers?includeInactive=true');
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.json.data, [{ id: meena.id, name: 'Meena', isActive: true }]);
  assert.deepEqual((await admin.call('GET', '/performers')).json.data.map((p) => p.name), ['Meena'], 'the admin\'s default list is the active people too');
  assert.deepEqual((await admin.call('GET', '/performers?includeInactive=true')).json.data.map((p) => p.name), ['Meena', 'Asha K']);

  // Staff cannot manage the list.
  assert.equal((await staff.call('POST', '/performers', { name: 'Sneaky' })).status, 403);
  assert.equal((await staff.call('PATCH', `/performers/${meena.id}`, { name: 'Sneaky' })).status, 403);
  assert.equal((await staff.call('DELETE', `/performers/${meena.id}`)).status, 403);
  assert.equal((await client().call('GET', '/performers')).status, 401, 'and you must be signed in');

  // Someone who has been on a bill is deactivated, never deleted; someone who has not can be deleted.
  assert.equal((await staff.call('POST', '/invoices', { items: [{ ...line(svc.Cut.id), performedBy: meena.id }], paymentMethod: 'cash' })).status, 201);
  const used = await admin.call('DELETE', `/performers/${meena.id}`);
  assert.equal(used.status, 409);
  assert.equal(used.json.error.code, 'PERFORMER_IN_USE');
  assert.deepEqual((await admin.call('GET', '/performers')).json.data.map((p) => [p.name, p.lines, p.canDelete]), [['Meena', 1, false]]);
  assert.equal((await admin.call('DELETE', `/performers/${asha.id}`)).status, 204);
  notFound(await admin.call('DELETE', `/performers/${asha.id}`));
  assert.equal((await admin.call('GET', '/performers/not-a-uuid')).status, 404, 'there is no such route');
  assert.equal((await admin.call('PATCH', '/performers/not-a-uuid', { name: 'Zed' })).status, 400);
});

test('billing with performers: each line records who did it; a person cannot be put on a bill unless they are this parlour\'s and active; commission is never shown to staff', async () => {
  const sa = await signedIn('super@demo.parlour');
  const A = await parlourWithMenu(sa);
  const B = await parlourWithMenu(sa);
  const meena = await addPerson(A.admin, 'Meena');
  const asha = await addPerson(A.admin, 'Asha');
  const theirs = await addPerson(B.admin, 'Meena');
  assert.equal((await setRule(A.admin, { performerId: meena.id }, 'percent', 10)).status, 200);

  // The same service done by two people is two lines, each credited to its own person. ₹200 each, 5% GST on top.
  const made = await A.staff.call('POST', '/invoices', { items: [{ ...line(A.svc.Cut.id), performedBy: meena.id }, { ...line(A.svc.Cut.id), performedBy: asha.id }, line(A.svc.Facial.id)], paymentMethod: 'cash' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const inv = made.json.data;
  assert.deepEqual(inv.items.map((i) => [i.name, i.performerName]).sort(), [['Cut', 'Asha'], ['Cut', 'Meena'], ['Facial', null]]);
  assert.equal(inv.total, 945, '₹900 + 5% GST: naming people changes no price');
  assert.equal(JSON.stringify(inv).includes('commission'), false, 'the bill staff can open does not show what anyone earns');
  assert.equal((await A.staff.call('GET', `/invoices/${inv.id}`)).status, 200);
  assert.equal(JSON.stringify((await A.staff.call('GET', `/invoices/${inv.id}`)).json).includes('commission'), false);

  // The admin sees it: Meena 10% of ₹200 = ₹20; Asha has no rule; the line nobody did is not in anyone's commission.
  const rows = (await commissionsOf(A.admin)).people;
  assert.deepEqual(rows.map((p) => [p.name, p.lines, p.sales, p.earned, p.due]).sort(), [['Asha', 1, 200, 0, 0], ['Meena', 1, 200, 20, 20]]);

  // Refused: another parlour's person, an inactive person, a made-up person, a malformed id. Nothing is saved.
  const countBills = async () => (await A.admin.call('GET', '/invoices?limit=1')).json.meta.total;
  const before = await countBills();
  const refused = async (performedBy, status, code) => {
    const r = await A.staff.call('POST', '/invoices', { items: [{ ...line(A.svc.Cut.id), performedBy }], paymentMethod: 'cash' });
    assert.equal(r.status, status, JSON.stringify(r.json));
    if (code) assert.equal(r.json.error.code, code);
  };
  await refused(theirs.id, 400, 'PERFORMER_UNAVAILABLE');
  await refused('99999999-9999-4999-8999-999999999999', 400, 'PERFORMER_UNAVAILABLE');
  await refused('not-a-uuid', 400, 'VALIDATION_ERROR');
  await A.admin.call('PATCH', `/performers/${asha.id}`, { isActive: false });
  await refused(asha.id, 400, 'PERFORMER_UNAVAILABLE');
  assert.equal(await countBills(), before, 'a refused bill is not saved');

  // Naming nobody (or null) is exactly as it was before.
  assert.equal((await A.staff.call('POST', '/invoices', { items: [line(A.svc.Cut.id)], paymentMethod: 'cash' })).status, 201);
  assert.equal((await A.staff.call('POST', '/invoices', { items: [{ ...line(A.svc.Cut.id), performedBy: null }], paymentMethod: 'cash' })).status, 201);

  // Idempotency: the same key and the same people is one bill; the same key with a different person is refused.
  const body = { items: [{ ...line(A.svc.Cut.id), performedBy: meena.id }], paymentMethod: 'cash' };
  const key = uniqueKey('performer');
  const first = await A.staff.call('POST', '/invoices', body, { 'Idempotency-Key': key });
  const again = await A.staff.call('POST', '/invoices', body, { 'Idempotency-Key': key });
  assert.deepEqual([first.status, again.status, again.json.data.id === first.json.data.id], [201, 200, true]);
  const other = await A.staff.call('POST', '/invoices', { items: [{ ...line(A.svc.Cut.id), performedBy: asha.id }], paymentMethod: 'cash' }, { 'Idempotency-Key': key });
  assert.equal(other.status, 409);
  assert.equal(other.json.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await commissionsOf(A.admin)).people.find((p) => p.name === 'Meena').earned, 40, 'two bills by Meena, not three');
});

test('commission rules: admin only; one per person or service; a percentage or a flat amount, validated; the person\'s rule wins; a flat amount is per unit and capped', async () => {
  const sa = await signedIn('super@demo.parlour');
  const A = await parlourWithMenu(sa);
  const B = await parlourWithMenu(sa);
  const meena = await addPerson(A.admin, 'Meena');
  const asha = await addPerson(A.admin, 'Asha');
  const bPerson = await addPerson(B.admin, 'Bela');

  // validation
  const rejected = async (body, field) => {
    const r = await A.admin.call('PUT', '/commissions/rules', body);
    assert.equal(r.status, 400, JSON.stringify(body) + ' ' + JSON.stringify(r.json));
    assert.ok(r.json.error.details[field], `${field} is named in ${JSON.stringify(r.json.error.details)}`);
  };
  await rejected({ performerId: meena.id, serviceId: A.svc.Cut.id, kind: 'percent', value: 10 }, 'performerId');   // both
  await rejected({ kind: 'percent', value: 10 }, 'performerId');                                                   // neither
  await rejected({ performerId: meena.id, kind: 'percent', value: 100.5 }, 'value');
  await rejected({ performerId: meena.id, kind: 'percent', value: 0 }, 'value');
  await rejected({ performerId: meena.id, kind: 'percent', value: -3 }, 'value');
  await rejected({ performerId: meena.id, kind: 'percent', value: 12.345 }, 'value');
  await rejected({ performerId: meena.id, kind: 'flat', value: 100_001 }, 'value');
  await rejected({ performerId: meena.id, kind: 'bonus', value: 5 }, 'kind');
  await rejected({ performerId: meena.id, kind: 'percent', value: '10' }, 'value');
  await rejected({ performerId: 'nope', kind: 'percent', value: 10 }, 'performerId');
  assert.equal((await A.admin.call('GET', '/commissions/rules')).json.data.length, 0, 'nothing refused was saved');

  // admin only, and only inside this parlour
  assert.equal((await A.staff.call('PUT', '/commissions/rules', { performerId: meena.id, kind: 'percent', value: 10 })).status, 403);
  assert.equal((await A.staff.call('GET', '/commissions/rules')).status, 403);
  notFound(await A.admin.call('PUT', '/commissions/rules', { performerId: bPerson.id, kind: 'percent', value: 10 }));
  notFound(await A.admin.call('PUT', '/commissions/rules', { serviceId: B.svc.Cut.id, kind: 'percent', value: 10 }));

  // set, replace (still one rule), list, remove
  const first = (await setRule(A.admin, { performerId: meena.id }, 'percent', 10)).json.data;
  assert.deepEqual([first.kind, first.value, first.performerName, first.serviceId], ['percent', 10, 'Meena', null]);
  const replaced = (await setRule(A.admin, { performerId: meena.id }, 'percent', 12.5)).json.data;
  assert.equal(replaced.id, first.id, 'the same rule, changed');
  assert.deepEqual([replaced.kind, replaced.value], ['percent', 12.5]);
  const svcRule = (await setRule(A.admin, { serviceId: A.svc.Wax.id }, 'flat', 50)).json.data;
  assert.deepEqual([svcRule.kind, svcRule.value, svcRule.serviceName, svcRule.performerId], ['flat', 50, 'Wax', null]);
  assert.deepEqual((await A.admin.call('GET', '/commissions/rules')).json.data.map((r) => [r.performerName ?? r.serviceName, r.kind, r.value]), [['Meena', 'percent', 12.5], ['Wax', 'flat', 50]]);
  await setRule(A.admin, { performerId: meena.id }, 'percent', 10);

  // Which rule applies. Wax ₹300: the person's rule wins for Meena (10% = ₹30); Asha has none, so the Wax rule applies (₹50 flat).
  const bill = async (items) => { const r = await A.staff.call('POST', '/invoices', { items, paymentMethod: 'cash' }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.data; };
  await bill([{ ...line(A.svc.Wax.id), performedBy: meena.id }]);
  await bill([{ ...line(A.svc.Wax.id), performedBy: asha.id }]);
  // A flat amount is per unit: 2 waxes by Asha = ₹100. And never more than the line took in: ₹300 less ₹290 off = ₹10 → ₹10.
  await bill([{ ...line(A.svc.Wax.id, 2), performedBy: asha.id }]);
  const discounted = await A.staff.call('POST', '/invoices', { items: [{ ...line(A.svc.Wax.id), performedBy: asha.id }], discount: 290, paymentMethod: 'cash' });
  assert.equal(discounted.status, 201);
  const people = (await commissionsOf(A.admin)).people;
  assert.equal(people.find((p) => p.name === 'Meena').earned, 30);
  assert.equal(people.find((p) => p.name === 'Asha').earned, 50 + 100 + 10);

  // A rule changed later changes no bill already made.
  await setRule(A.admin, { performerId: meena.id }, 'percent', 50);
  assert.equal((await commissionsOf(A.admin)).people.find((p) => p.name === 'Meena').earned, 30);
  await bill([{ ...line(A.svc.Wax.id), performedBy: meena.id }]);
  assert.equal((await commissionsOf(A.admin)).people.find((p) => p.name === 'Meena').earned, 30 + 150);

  // remove
  assert.equal((await A.admin.call('DELETE', `/commissions/rules/${first.id}`)).status, 204);
  notFound(await A.admin.call('DELETE', `/commissions/rules/${first.id}`));
  notFound(await B.admin.call('DELETE', `/commissions/rules/${svcRule.id}`));   // another parlour's rule is not found, not removed
  assert.equal((await A.admin.call('GET', '/commissions/rules')).json.data.length, 1);
  assert.equal((await B.admin.call('GET', '/commissions/rules')).json.data.length, 0);
});

test('mark commission as paid: only what is owed, only what the admin saw, never twice; voided bills are left out and a later void is shown', async () => {
  const sa = await signedIn('super@demo.parlour');
  const A = await parlourWithMenu(sa);
  const B = await parlourWithMenu(sa);
  const meena = await addPerson(A.admin, 'Meena');
  const bPerson = await addPerson(B.admin, 'Bela');
  await setRule(A.admin, { performerId: meena.id }, 'percent', 10);
  const bill = async (name, qty = 1) => (await A.staff.call('POST', '/invoices', { items: [{ ...line(A.svc[name].id, qty), performedBy: meena.id }], paymentMethod: 'cash' })).json.data;
  const b1 = await bill('Cut');            // ₹20
  const b2 = await bill('Massage');        // ₹100
  const b3 = await bill('Cut', 2);         // ₹40, voided below
  assert.equal((await A.admin.call('POST', `/invoices/${b3.id}/void`, { reason: 'Entered twice' })).status, 200);

  const range = thisWeek();
  const row = async () => (await commissionsOf(A.admin, range)).people.find((p) => p.name === 'Meena');
  assert.deepEqual([(await row()).lines, (await row()).sales, (await row()).earned, (await row()).paid, (await row()).due], [2, 1200, 120, 0, 120]);
  const detail = (await A.admin.call('GET', `/commissions/performers/${meena.id}/lines?from=${range.from}&to=${range.to}`)).json.data;
  assert.deepEqual(detail.lines.map((l) => [l.number, l.status, l.commission, l.paid]).sort(), [[b1.number, 'paid', 20, false], [b2.number, 'paid', 100, false], [b3.number, 'void', 40, false]].sort());
  assert.equal(detail.truncated, false);

  const pay = (body, who = A.admin) => who.call('POST', '/commissions/pay', { performerId: meena.id, ...range, expectedAmount: 120, ...body });
  // refused, and nothing is paid
  assert.equal((await pay({}, A.staff)).status, 403, 'staff cannot mark commission as paid');
  const changed = await pay({ expectedAmount: 100 });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.error.code, 'AMOUNT_CHANGED');
  assert.match(changed.json.error.message, /₹120\.00/);
  assert.equal((await pay({ expectedAmount: 119.99 })).status, 409, 'a paisa off is refused');
  for (const bad of [{ expectedAmount: 0 }, { expectedAmount: -5 }, { expectedAmount: '120' }, { expectedAmount: 120.001 }, { from: range.to, to: range.from }, { from: '2026-13-45' }, { to: '2026-02-30' }, { from: '26-1-1' }, { performerId: 'nope' }]) {
    assert.equal((await pay(bad)).status, 400, JSON.stringify(bad));
  }
  notFound(await pay({ performerId: bPerson.id }));     // another parlour's person
  assert.equal((await row()).paid, 0, 'nothing was paid by any of those');
  assert.equal((await A.admin.call('GET', '/commissions/payouts')).json.data.length, 0);
  assert.equal((await pay({ from: '2000-01-01', to: '2000-12-31' })).json.error.code, 'NOTHING_TO_PAY', 'dates with no unpaid commission pay nothing');

  // paid
  const paid = await pay({});
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.deepEqual([paid.json.data.amount, paid.json.data.lines, paid.json.data.performerName], [120, 2, 'Meena']);
  assert.deepEqual([(await row()).earned, (await row()).paid, (await row()).due], [120, 120, 0]);
  const history = (await A.admin.call('GET', '/commissions/payouts')).json.data;
  assert.deepEqual(history.map((p) => [p.performerName, p.amount, p.lines, p.from, p.to]), [['Meena', 120, 2, range.from, range.to]]);
  assert.ok(history[0].paidByName && history[0].paidAt);
  assert.deepEqual((await B.admin.call('GET', '/commissions/payouts')).json.data, [], 'another parlour does not see this payout');

  // not twice: pressing it again, or two presses at the same moment
  assert.equal((await pay({})).json.error.code, 'NOTHING_TO_PAY');
  await bill('Cut');   // a new ₹20 is owed on its own
  const [x, y] = await Promise.all([pay({ expectedAmount: 20 }), pay({ expectedAmount: 20 })]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409], 'two copies at once pay once');
  assert.equal((await A.admin.call('GET', '/commissions/payouts')).json.data.length, 2);
  assert.equal((await row()).due, 0);

  // a bill voided AFTER its commission was paid: nothing is changed for you, but it is shown
  assert.equal((await A.admin.call('POST', `/invoices/${b2.id}/void`, { reason: 'Customer returned' })).status, 200);
  const after = await row();
  assert.deepEqual([after.earned, after.paid, after.due, after.voidedAfterPaid], [40, 40, 0, 100]);
  assert.equal((await commissionsOf(A.admin, range)).totals.voidedAfterPaid, 100);
});

test('commissions and performers are private to each parlour: nobody sees, pays, rules or bills against another\'s', async () => {
  const sa = await signedIn('super@demo.parlour');
  const A = await parlourWithMenu(sa);
  const B = await parlourWithMenu(sa);
  const a = await addPerson(A.admin, 'Alma');
  const b = await addPerson(B.admin, 'Bela');
  await setRule(A.admin, { performerId: a.id }, 'percent', 10);
  await setRule(B.admin, { performerId: b.id }, 'percent', 20);
  await A.staff.call('POST', '/invoices', { items: [{ ...line(A.svc.Massage.id), performedBy: a.id }], paymentMethod: 'cash' });
  await B.staff.call('POST', '/invoices', { items: [{ ...line(B.svc.Massage.id), performedBy: b.id }], paymentMethod: 'cash' });

  assert.deepEqual((await A.admin.call('GET', '/performers')).json.data.map((p) => p.name), ['Alma']);
  assert.deepEqual((await B.staff.call('GET', '/performers')).json.data.map((p) => p.name), ['Bela']);
  assert.deepEqual((await commissionsOf(A.admin)).people.map((p) => [p.name, p.earned]), [['Alma', 100]]);
  assert.deepEqual((await commissionsOf(B.admin)).people.map((p) => [p.name, p.earned]), [['Bela', 200]]);
  assert.deepEqual((await A.admin.call('GET', '/commissions/rules')).json.data.map((r) => r.performerName), ['Alma']);

  // What B's admin tries against A's people.
  notFound(await B.admin.call('PATCH', `/performers/${a.id}`, { name: 'Hijacked' }));
  notFound(await B.admin.call('DELETE', `/performers/${a.id}`));
  notFound(await B.admin.call('GET', `/commissions/performers/${a.id}/lines`));
  notFound(await B.admin.call('POST', '/commissions/pay', { performerId: a.id, ...thisWeek(), expectedAmount: 100 }));
  notFound(await B.admin.call('PUT', '/commissions/rules', { performerId: a.id, kind: 'percent', value: 99 }));
  const hijack = await B.staff.call('POST', '/invoices', { items: [{ ...line(B.svc.Cut.id), performedBy: a.id }], paymentMethod: 'cash' });
  assert.equal(hijack.json.error.code, 'PERFORMER_UNAVAILABLE');
  assert.equal((await A.admin.call('GET', '/performers')).json.data[0].name, 'Alma', 'A\'s person is untouched');
  assert.equal((await commissionsOf(A.admin)).people[0].due, 100, 'and A is still owed what it was');

  // Nobody who is not an admin of a parlour reaches commissions at all.
  assert.equal((await A.staff.call('GET', '/commissions')).status, 403);
  assert.equal((await sa.call('GET', '/commissions')).status, 403, 'the platform admin has no parlour');
  assert.equal((await sa.call('GET', '/performers')).status, 403);
  assert.equal((await client().call('GET', '/commissions')).status, 401);
});

test('dashboard: sales by the person who performed the work, and what nobody was credited for, adds up to the taxable value', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { admin, staff, svc } = await parlourWithMenu(sa);
  const meena = await addPerson(admin, 'Meena');
  const asha = await addPerson(admin, 'Asha');
  const bill = async (items, extra = {}) => { const r = await staff.call('POST', '/invoices', { items, paymentMethod: 'cash', ...extra }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.data; };
  await bill([line(svc.Cut.id)]);                                                                            // ₹200, nobody named
  await bill([{ ...line(svc.Cut.id), performedBy: meena.id }, { ...line(svc.Massage.id), performedBy: asha.id }], { discount: 33.33 });
  const voided = await bill([{ ...line(svc.Facial.id), performedBy: asha.id }]);
  await admin.call('POST', `/invoices/${voided.id}/void`, { reason: 'Test' });

  const s = (await admin.call('GET', `/reports/summary?from=${localDay(-1)}&to=${localDay(1)}`)).json.data;
  const people = s.byPerformer.people;
  assert.deepEqual(people.map((p) => p.name).sort(), ['Asha', 'Meena'], 'the voided bill is not counted');
  const credited = people.reduce((sum, p) => sum + Math.round(p.sales * 100), 0);
  const taxable = Math.round((s.totals.revenue - s.totals.tax) * 100);
  assert.equal(credited + Math.round(s.byPerformer.unassigned * 100), taxable, 'people + unassigned = taxable value of every bill that stands');
  assert.equal(s.byPerformer.unassigned, 200);
  // ₹1,200 less ₹33.33 = ₹1,166.67, shared 1 : 5 → ₹194.45 and ₹972.22 (the odd paisa goes where rounding lost the most)
  assert.deepEqual(people.map((p) => [p.name, p.sales]).sort(), [['Asha', 972.22], ['Meena', 194.45]]);
  assert.equal(Math.round((972.22 + 194.45) * 100), 116_667);
  // the existing "by team member" report (who made the bill) is still there and still counts bills by their maker
  assert.ok(s.byStaff.length >= 1 && s.byStaff.every((m) => 'invoices' in m && 'revenue' in m));
  assert.equal((await staff.call('GET', '/reports/summary')).status, 403, 'staff still cannot read the dashboard');
});

test('switches: Performers, Commissions and their buttons are enforced by the API per parlour, and they chain', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { p, admin, staff, svc } = await parlourWithMenu(sa);
  const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };
  const set = (features) => sa.call('PATCH', `/platform/parlours/${p.id}`, { features });
  const meena = await addPerson(admin, 'Meena');
  await setRule(admin, { performerId: meena.id }, 'percent', 10);
  const range = thisWeek();
  const named = () => staff.call('POST', '/invoices', { items: [{ ...line(svc.Cut.id), performedBy: meena.id }], paymentMethod: 'cash' });
  const plain = () => staff.call('POST', '/invoices', { items: [line(svc.Cut.id)], paymentMethod: 'cash' });
  const pay = (amount) => admin.call('POST', '/commissions/pay', { performerId: meena.id, ...range, expectedAmount: amount });

  // They exist, are listed for the platform admin, and are on by default.
  const keys = (await sa.call('GET', '/platform/features')).json.data;
  for (const k of ['page.performers', 'page.commissions', 'action.performers.add', 'action.commissions.pay', 'action.referrals.pay']) assert.ok(keys.some((f) => f.key === k), k);
  assert.equal(keys.find((f) => f.key === 'page.commissions').requires, 'page.performers');
  assert.equal(keys.find((f) => f.key === 'action.commissions.pay').requires, 'page.commissions');
  assert.equal(keys.find((f) => f.key === 'action.referrals.pay').requires, 'page.referrals');
  const me = (await admin.call('GET', '/auth/me')).json.data.features;
  for (const k of ['page.performers', 'page.commissions', 'action.performers.add', 'action.commissions.pay', 'action.referrals.pay']) assert.equal(me[k], true, k);
  assert.equal((await named()).status, 201);

  // Add person button: only adding is refused.
  await set({ 'action.performers.add': false });
  refused(await admin.call('POST', '/performers', { name: 'Another' }));
  assert.equal((await admin.call('PATCH', `/performers/${meena.id}`, { name: 'Meena R' })).status, 200);
  assert.equal((await admin.call('GET', '/performers')).status, 200);
  assert.equal((await named()).status, 201);
  await set({ 'action.performers.add': true });
  assert.equal((await admin.call('POST', '/performers', { name: 'Another' })).status, 201, 'back on, immediately');

  // Mark as paid button: only paying is refused; the commissions page still works.
  await set({ 'action.commissions.pay': false });
  refused(await pay(40));
  assert.equal((await admin.call('GET', `/commissions?from=${range.from}&to=${range.to}`)).status, 200);
  assert.equal((await admin.call('GET', '/commissions/rules')).status, 200);
  await set({ 'action.commissions.pay': true });
  assert.equal((await pay(40)).status, 201, 'back on, immediately');

  // Commissions page off: no commissions at all, but performers and billing with people carry on.
  await set({ 'page.commissions': false });
  refused(await admin.call('GET', `/commissions?from=${range.from}&to=${range.to}`));
  refused(await admin.call('GET', '/commissions/rules'));
  refused(await admin.call('GET', '/commissions/payouts'));
  refused(await pay(1));
  assert.equal((await admin.call('GET', '/performers')).status, 200);
  assert.equal((await named()).status, 201, 'commission is still worked out and kept while its page is off');
  await set({ 'page.commissions': true });
  assert.equal((await commissionsOf(admin)).people[0].due, 20, 'the bill made while it was off is there when it is back on (the two before it were paid)');

  // Performers page off: no list, no naming people on a bill, no dashboard panel, and (it chains) no commissions or paying either.
  await set({ 'page.performers': false });
  refused(await admin.call('GET', '/performers'));
  refused(await staff.call('GET', '/performers'));
  refused(await admin.call('POST', '/performers', { name: 'Third' }));
  refused(await named());
  assert.equal((await plain()).status, 201, 'a bill that names nobody always works');
  refused(await admin.call('GET', `/commissions?from=${range.from}&to=${range.to}`));
  refused(await pay(40));
  const summary = (await admin.call('GET', '/reports/summary')).json.data;
  assert.equal(summary.byPerformer, null, 'the dashboard panel is not worked out');
  assert.equal(summary.byStaff.length >= 1, true, 'the rest of the dashboard is unchanged');
  const features = (await admin.call('GET', '/auth/me')).json.data.features;
  assert.deepEqual([features['page.performers'], features['page.commissions'], features['action.commissions.pay'], features['action.performers.add']], [false, false, false, false]);
  await set({ 'page.performers': true });
  assert.equal((await named()).status, 201, 'back on, immediately');
  assert.ok((await admin.call('GET', '/reports/summary')).json.data.byPerformer, 'and the panel returns');

  // The switches of one parlour are not another's.
  const other = await parlourWithMenu(sa);
  assert.equal((await other.admin.call('GET', '/performers')).status, 200);
});

test('referral amounts: what a referrer is owed is shown, "mark as paid" pays exactly that and never twice, and a void after payment is shown', async () => {
  const sa = await signedIn('super@demo.parlour');
  const A = await parlourWithMenu(sa);
  const B = await parlourWithMenu(sa);
  const ref = (await A.admin.call('POST', '/referrers', { name: 'Anita Rao', contact: '9841100001', percent: 10 })).json.data;
  const bill = async (name, qty = 1) => (await A.staff.call('POST', '/invoices', { items: [line(A.svc[name].id, qty)], referrerId: ref.id, paymentMethod: 'cash' })).json.data;
  const b1 = await bill('Massage');   // 10% of ₹1,000 = ₹100
  const b2 = await bill('Cut');       // ₹20
  const b3 = await bill('Cut', 2);    // ₹40, voided below
  assert.equal((await A.admin.call('POST', `/invoices/${b3.id}/void`, { reason: 'Entered twice' })).status, 200);

  let d = (await A.admin.call('GET', `/referrers/${ref.id}`)).json.data;
  assert.deepEqual([d.owed, d.paidOut, d.voidedAfterPaid, d.totalDiscount], [120, 0, 0, 120]);
  assert.deepEqual(d.history.map((h) => h.paid), [false, false, false]);
  assert.deepEqual(d.payouts, []);
  assert.equal((await A.admin.call('GET', '/referrers')).json.data[0].owed, 120, 'the list shows it too');

  const pay = (amount, who = A.admin, id = ref.id) => who.call('POST', `/referrers/${id}/pay`, { expectedAmount: amount });
  assert.equal((await pay(120, A.staff)).status, 403, 'staff cannot mark it as paid');
  const changed = await pay(100);
  assert.deepEqual([changed.status, changed.json.error.code], [409, 'AMOUNT_CHANGED']);
  assert.match(changed.json.error.message, /₹120\.00/);
  for (const bad of [0, -1, '120', 120.001, null]) assert.equal((await pay(bad)).status, 400, String(bad));
  assert.equal((await A.admin.call('POST', `/referrers/${ref.id}/pay`, {})).status, 400);
  notFound(await pay(120, B.admin));                                // another parlour's admin
  notFound(await pay(120, A.admin, '99999999-9999-4999-8999-999999999999'));
  d = (await A.admin.call('GET', `/referrers/${ref.id}`)).json.data;
  assert.equal(d.owed, 120, 'none of those paid anything');

  const paid = await pay(120);
  assert.equal(paid.status, 201, JSON.stringify(paid.json));
  assert.deepEqual([paid.json.data.amount, paid.json.data.bills, paid.json.data.referrerName], [120, 2, 'Anita Rao']);
  d = (await A.admin.call('GET', `/referrers/${ref.id}`)).json.data;
  assert.deepEqual([d.owed, d.paidOut], [0, 120]);
  assert.deepEqual(d.history.filter((h) => h.paid).map((h) => h.number).sort(), [b1.number, b2.number].sort(), 'the voided bill is not marked as paid');
  assert.deepEqual(d.payouts.map((x) => [x.amount, x.bills]), [[120, 2]]);
  assert.equal((await pay(120)).json.error.code, 'NOTHING_TO_PAY');

  // a new bill is owed on its own; two presses at once pay once; a void after payment is shown, not silently changed
  await bill('Cut');
  const [x, y] = await Promise.all([pay(20), pay(20)]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  assert.equal((await A.admin.call('POST', `/invoices/${b1.id}/void`, { reason: 'Customer returned' })).status, 200);
  d = (await A.admin.call('GET', `/referrers/${ref.id}`)).json.data;
  assert.deepEqual([d.owed, d.paidOut, d.voidedAfterPaid, d.payouts.length], [0, 40, 100, 2]);
});

test('referral "mark as paid" button: switched on its own, enforced by the API, and it needs the Referrals page', async () => {
  const sa = await signedIn('super@demo.parlour');
  const { p, admin, staff, svc } = await parlourWithMenu(sa);
  const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };
  const set = (features) => sa.call('PATCH', `/platform/parlours/${p.id}`, { features });
  const ref = (await admin.call('POST', '/referrers', { name: 'Anita Rao', contact: '9841100001', percent: 10 })).json.data;
  await staff.call('POST', '/invoices', { items: [line(svc.Massage.id)], referrerId: ref.id, paymentMethod: 'cash' });
  const pay = () => admin.call('POST', `/referrers/${ref.id}/pay`, { expectedAmount: 100 });

  await set({ 'action.referrals.pay': false });
  refused(await pay());
  assert.equal((await admin.call('GET', `/referrers/${ref.id}`)).json.data.owed, 100, 'owed is still shown; only paying is switched off');
  assert.equal((await admin.call('PATCH', `/referrers/${ref.id}`, { percent: 12 })).status, 200);
  await set({ 'action.referrals.pay': true, 'page.referrals': false });
  refused(await pay());
  await set({ 'page.referrals': true });
  assert.equal((await pay()).status, 201, 'back on, immediately');
});

test('the demo parlour has performers and rules, and its dashboard reconciles where old bills and new ones are mixed', async () => {
  const admin = await signedIn('admin@demo.parlour');
  const people = (await admin.call('GET', '/performers')).json.data;
  assert.ok(people.length >= 3, 'the seed adds performers');
  assert.ok((await admin.call('GET', '/commissions/rules')).json.data.length >= 1);
  const s = (await admin.call('GET', `/reports/summary?from=${localDay(-29)}&to=${localDay(1)}`)).json.data;
  const credited = s.byPerformer.people.reduce((sum, p) => sum + Math.round(p.sales * 100), 0);
  assert.equal(credited + Math.round(s.byPerformer.unassigned * 100), Math.round((s.totals.revenue - s.totals.tax) * 100));
  const report = (await admin.call('GET', `/commissions?from=${localDay(-29)}&to=${localDay(1)}`)).json.data;
  assert.equal(Math.round(report.totals.earned * 100), report.people.reduce((sum, p) => sum + Math.round(p.earned * 100), 0), 'the totals are the sum of the people');
  assert.ok(report.people.every((p) => p.paid <= p.earned && Math.round((p.earned - p.paid) * 100) === Math.round(p.due * 100)));
});

// ───────────────────── sign in with mobile or email (Phase 5) ─────────────────────

const login = (identifier, password = 'Secret123', field = 'identifier') => client().call('POST', '/auth/login', { [field]: identifier, password });
const spaced = (mobile) => `+91 ${mobile.slice(0, 5)}-${mobile.slice(5)}`;

test('mobile sign-in: staff made with a mobile number and no email sign in with it, however they type it', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);
  const mobile = nextMobile();

  const made = await admin.call('POST', '/staff', { name: 'Kiosk Kim', mobile: spaced(mobile), password: 'Secret123' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.data.email, null, 'no email was given, so none is stored');
  assert.equal(made.json.data.mobile, spaced(mobile), 'the number is kept as typed');
  assert.equal(made.json.data.role, 'staff');

  // However the number is typed, it is the same person.
  for (const typed of [mobile, spaced(mobile), `0${mobile}`, `${mobile.slice(0, 5)} ${mobile.slice(5)}`, ` ${mobile} `]) {
    const r = await login(typed);
    assert.equal(r.status, 200, `typed as "${typed}": ${JSON.stringify(r.json)}`);
    assert.equal(r.json.data.user.id, made.json.data.id);
    assert.equal(r.json.data.user.email, null);
    assert.equal(r.json.data.user.mobile, spaced(mobile));
    assert.equal(r.json.data.user.parlourId, p.id);
  }

  // The session works like any other: the token opens the app, and the refresh cookie rotates.
  const c = client();
  assert.equal((await c.loginAs(mobile, 'Secret123')).status, 200);
  const old = client();
  assert.equal((await old.login(mobile, 'Secret123')).status, 200, 'the old field name accepts a mobile number as well');
  const meJson = await c.call('GET', '/auth/me');
  assert.equal(meJson.status, 200);
  assert.equal(meJson.json.data.email, null);
  assert.equal(meJson.json.data.mobile, spaced(mobile));
  const before = c.cookie;
  const refreshed = await c.call('POST', '/auth/refresh', null, XHR);
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
  assert.notEqual(c.cookie, before, 'the refresh token rotated');

  // The Team page lists them, and shows there is no email.
  const list = (await admin.call('GET', '/staff')).json.data;
  assert.equal(list.find((m) => m.id === made.json.data.id).email, null);
});

test('mobile sign-in: a person with both an email and a mobile number can use either, and it is the same account', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);
  const mobile = nextMobile();
  const email = `both${Date.now()}@test.parlour`;
  const made = await admin.call('POST', '/staff', { name: 'Both Ways', email: email.toUpperCase(), mobile, password: 'Secret123', role: 'admin' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.data.email, email, 'the email is stored lower-cased');
  const byEmail = await login(email);
  const byMobile = await login(mobile);
  const byOldField = await login(email.toUpperCase(), 'Secret123', 'email');
  for (const r of [byEmail, byMobile, byOldField]) { assert.equal(r.status, 200); assert.equal(r.json.data.user.id, made.json.data.id); assert.equal(r.json.data.user.role, 'admin'); }

  // Accounts that existed before mobile sign-in work exactly as they did.
  assert.equal((await login('ADMIN@demo.parlour', PASSWORD)).status, 200);
  assert.equal((await login(p.email, p.password)).status, 200);
  const owner = (await login(p.email, p.password)).json.data.user;
  assert.equal(owner.mobile, null, 'an owner made before mobile numbers existed has none, and simply keeps signing in by email');
  assert.equal((await login(spaced(mobile), 'Secret123')).json.data.user.id, made.json.data.id);
});

test('mobile sign-in: every failure gives the same answer, whether the email or the number exists or not', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);
  const mobile = nextMobile();
  assert.equal((await admin.call('POST', '/staff', { name: 'Real Person', mobile, password: 'Secret123' })).status, 201);

  const failures = {
    'wrong password, right number': await login(mobile, 'Wrong-pass-1'),
    'wrong password, right email': await login(p.email, 'Wrong-pass-1'),
    'unknown number': await login(nextMobile(), 'Wrong-pass-1'),
    'unknown email': await login('nobody@nowhere.test', 'Wrong-pass-1'),
    'unknown number, old field': await login(nextMobile(), 'Wrong-pass-1', 'email'),
  };
  const reference = failures['unknown email'];
  for (const [what, r] of Object.entries(failures)) {
    assert.equal(r.status, 401, what);
    assert.equal(r.json.error.code, 'INVALID_CREDENTIALS', what);
    assert.equal(r.json.error.message, reference.json.error.message, `${what}: the message does not tell them apart`);
    assert.equal(r.setCookie, undefined, `${what}: no session cookie`);
  }
});

test('mobile sign-in: something that is neither an email nor a usable number is refused with a field message', async () => {
  for (const bad of ['12345', '98400 1234', 'abcdefghij', 'a@b', '']) {
    const r = await login(bad, 'Secret123');
    assert.equal(r.status, 400, `"${bad}"`);
    assert.ok(r.json.error.details.identifier, `a message on the identifier field for "${bad}"`);
  }
  // A caller using the old field name still gets the message on that field.
  const old = await login('nope', '', 'email');
  assert.equal(old.status, 400);
  assert.ok(old.json.error.details.email && old.json.error.details.password);
  // Values that are not text are refused, not guessed at.
  assert.equal((await client().call('POST', '/auth/login', { identifier: { $ne: null }, password: 'Secret123' })).status, 400);
  assert.equal((await client().call('POST', '/auth/login', { identifier: 9840012345, password: 'Secret123' })).status, 400);
});

test('mobile sign-in: lockout, deactivation and password reset work the same by mobile as by email', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);
  const mobile = nextMobile();
  const email = `lock${Date.now()}@test.parlour`;
  const made = (await admin.call('POST', '/staff', { name: 'Lock Me', email, mobile, password: 'Secret123' })).json.data;

  // Five wrong passwords by mobile lock the account: by mobile, and by email too, even with the right password.
  for (let i = 0; i < 5; i++) assert.equal((await login(mobile, 'Wrong-pass-1')).status, 401);
  const lockedByMobile = await login(mobile, 'Secret123');
  const lockedByEmail = await login(email, 'Secret123');
  for (const r of [lockedByMobile, lockedByEmail]) { assert.equal(r.status, 429); assert.equal(r.json.error.code, 'ACCOUNT_LOCKED'); }

  // A mobile-only account: deactivated shows the reason only after the right password, like email accounts.
  const solo = (await admin.call('POST', '/staff', { name: 'Solo', mobile: nextMobile(), password: 'Secret123' })).json.data;
  assert.equal((await admin.call('PATCH', `/staff/${solo.id}`, { isActive: false })).status, 200);
  assert.equal((await login(solo.mobile, 'Wrong-pass-1')).status, 401, 'a wrong password does not reveal that the account is off');
  const off = await login(solo.mobile, 'Secret123');
  assert.equal(off.status, 403);
  assert.equal(off.json.error.code, 'ACCOUNT_DISABLED');
  assert.equal((await admin.call('PATCH', `/staff/${solo.id}`, { isActive: true })).status, 200);
  assert.equal((await login(solo.mobile, 'Secret123')).status, 200);

  // Resetting the password signs them out and the new one works by mobile.
  const c = client();
  assert.equal((await c.loginAs(solo.mobile, 'Secret123')).status, 200);
  assert.equal((await admin.call('POST', `/staff/${solo.id}/reset-password`, { password: 'Brand-new-1' })).status, 204);
  assert.equal((await login(solo.mobile, 'Secret123')).status, 401);
  assert.equal((await login(solo.mobile, 'Brand-new-1')).status, 200);
  assert.equal(made.email, email);
});

test('mobile numbers are unique across the whole platform, however they are typed', async () => {
  const sa = await signedIn('super@demo.parlour');
  const [a, b] = [await makeParlour(sa), await makeParlour(sa)];
  const [adminA, adminB] = [await signedIn(a.email, a.password), await signedIn(b.email, b.password)];
  const mobile = nextMobile();
  const first = await adminA.call('POST', '/staff', { name: 'Original', mobile, password: 'Secret123' });
  assert.equal(first.status, 201);

  // Another parlour, another way of typing it: refused, with the message on the mobile field.
  for (const typed of [mobile, spaced(mobile), `0${mobile}`]) {
    const dup = await adminB.call('POST', '/staff', { name: 'Copycat', mobile: typed, password: 'Secret123' });
    assert.equal(dup.status, 409, `typed as "${typed}"`);
    assert.equal(dup.json.error.code, 'MOBILE_TAKEN');
    assert.ok(dup.json.error.details.mobile, 'a field-level message');
    const text = JSON.stringify(dup.json);
    for (const secret of [a.name, a.id, 'Original', first.json.data.id]) assert.ok(!text.includes(secret), 'nothing about the other parlour or person is revealed');
  }
  // The same parlour too.
  assert.equal((await adminA.call('POST', '/staff', { name: 'Twin', mobile: spaced(mobile), password: 'Secret123' })).status, 409);

  // The email rule is still its own, with its own code.
  const email = `uniq${Date.now()}@test.parlour`;
  assert.equal((await adminB.call('POST', '/staff', { name: 'One', email, mobile: nextMobile(), password: 'Secret123' })).status, 201);
  const sameEmail = await adminA.call('POST', '/staff', { name: 'Two', email: email.toUpperCase(), mobile: nextMobile(), password: 'Secret123' });
  assert.equal(sameEmail.status, 409);
  assert.equal(sameEmail.json.error.code, 'EMAIL_TAKEN');

  // Parlour B never sees parlour A's people.
  assert.ok(!(await adminB.call('GET', '/staff')).json.data.some((m) => m.id === first.json.data.id));

  // Two requests for the same new number at the same moment: exactly one wins.
  const contested = nextMobile();
  const race = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? adminA : adminB).call('POST', '/staff', { name: `Racer ${i}`, mobile: i % 3 ? spaced(contested) : contested, password: 'Secret123' })));
  assert.equal(race.filter((r) => r.status === 201).length, 1, race.map((r) => r.status).join(','));
  assert.ok(race.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.json.error.code === 'MOBILE_TAKEN'));
});

test('team: changing a number follows the same rules, and the rest of the member is left alone', async () => {
  const sa = await signedIn('super@demo.parlour');
  const [a, b] = [await makeParlour(sa), await makeParlour(sa)];
  const [adminA, adminB] = [await signedIn(a.email, a.password), await signedIn(b.email, b.password)];
  const taken = nextMobile();
  assert.equal((await adminA.call('POST', '/staff', { name: 'Holder', mobile: taken, password: 'Secret123' })).status, 201);
  const own = nextMobile();
  const mine = (await adminB.call('POST', '/staff', { name: 'Mine', mobile: own, email: `mine${Date.now()}@test.parlour`, password: 'Secret123' })).json.data;
  const patch = (body) => adminB.call('PATCH', `/staff/${mine.id}`, body);

  const clash = await patch({ mobile: spaced(taken) });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, 'MOBILE_TAKEN');
  assert.ok(clash.json.error.details.mobile);

  assert.equal((await patch({ mobile: own, name: 'Mine Renamed' })).status, 200, 'sending a member\'s own number back is not a clash');
  assert.equal((await patch({ mobile: spaced(own) })).status, 200, 'nor is typing it differently');
  assert.equal((await patch({ mobile: '1234567' })).status, 400, 'a changed number needs at least 10 digits');
  assert.ok((await patch({ mobile: '1234567' })).json.error.details.mobile);
  const fresh = nextMobile();
  const moved = await patch({ mobile: fresh });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.data.name, 'Mine Renamed');
  assert.equal((await login(fresh)).status, 200, 'the new number signs them in');
  assert.equal((await login(own)).status, 401, 'the old one no longer does');
  assert.equal((await patch({ mobile: spaced(own) })).status, 200, 'and it is free to be used again');
});

test('team: only staff may have no email; an admin needs one, and a mobile-only member cannot be made an admin', async () => {
  const sa = await signedIn('super@demo.parlour');
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);

  const noEmailAdmin = await admin.call('POST', '/staff', { name: 'Boss', mobile: nextMobile(), password: 'Secret123', role: 'admin' });
  assert.equal(noEmailAdmin.status, 400);
  assert.ok(noEmailAdmin.json.error.details.email);
  assert.equal((await admin.call('POST', '/staff', { name: 'Boss', mobile: nextMobile(), email: '', password: 'Secret123', role: 'admin' })).status, 400, 'a blank email is no email');
  assert.equal((await admin.call('POST', '/staff', { name: 'Bad', mobile: nextMobile(), email: 'nope', password: 'Secret123' })).status, 400);
  assert.equal((await admin.call('POST', '/staff', { name: 'NoNum', email: `nonum${Date.now()}@test.parlour`, password: 'Secret123' })).status, 400, 'a mobile number is still always asked for');

  const solo = (await admin.call('POST', '/staff', { name: 'Solo', mobile: nextMobile(), password: 'Secret123' })).json.data;
  const promote = await admin.call('PATCH', `/staff/${solo.id}`, { role: 'admin' });
  assert.equal(promote.status, 400);
  assert.equal(promote.json.error.code, 'ADMIN_NEEDS_EMAIL');
  assert.equal((await admin.call('PATCH', `/staff/${solo.id}`, { name: 'Solo Renamed' })).status, 200, 'ordinary edits are unaffected');
});

test('mobile sign-in: the rate limit and the response headers are the same as for email sign-in', async () => {
  const r = await login(nextMobile(), 'Wrong-pass-1');
  assert.equal(r.status, 401);
  assert.ok(r.headers.get('ratelimit') || r.headers.get('ratelimit-limit') || r.headers.get('x-ratelimit-limit'), 'sign-in is still rate limited');
  assert.equal(r.headers.get('x-powered-by'), null);
});

// ───────────────────────── appointments (Phase 6) ─────────────────────────

const apptSetup = async (sa) => {
  const p = await makeParlour(sa);
  const admin = await signedIn(p.email, p.password);
  const mobile = nextMobile();
  assert.equal((await admin.call('POST', '/staff', { name: 'Sam Staff', mobile, password: 'Secret123' })).status, 201);
  const staff = client();
  assert.equal((await staff.loginAs(mobile, 'Secret123')).status, 200);
  const cut = (await admin.call('POST', '/services', { name: 'Haircut', price: 300, durationMin: 30 })).json.data;
  const spa = (await admin.call('POST', '/services', { name: 'Spa', price: 1000, durationMin: 60 })).json.data;
  const asha = await addPerson(admin, 'Asha');
  const ravi = await addPerson(admin, 'Ravi');
  const cust = (await admin.call('POST', '/customers', { name: 'Priya Das', phone: '98400 54321' })).json.data;
  return { p, admin, staff, cut, spa, asha, ravi, cust };
};
const apptBody = (s, over = {}) => ({ kind: 'booked', date: localDay(1), time: '10:00', customerName: 'Meena', performerId: s.asha.id, items: [{ serviceId: s.cut.id, quantity: 1 }], ...over });
const makeAppt = async (s, over) => { const r = await s.admin.call('POST', '/appointments', apptBody(s, over)); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.data; };

test('appointments: book, see it on the day calendar, move it, and the staff see the same parlour calendar', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  const a = await makeAppt(s, { items: [{ serviceId: s.cut.id, quantity: 2 }, { serviceId: s.spa.id, quantity: 1 }] });
  assert.deepEqual([a.status, a.kind, a.durationMin, a.performerName], ['booked', 'booked', 120, 'Asha']);
  assert.equal(a.time, '10:00');
  assert.equal(a.price, undefined, 'no price is stored on a visit: the bill prices on the day');

  for (const who of [s.admin, s.staff]) {
    const day = (await who.call('GET', `/appointments?date=${localDay(1)}`)).json.data;
    assert.deepEqual(day.appointments.map((x) => x.id), [a.id]);
  }
  assert.equal((await s.admin.call('GET', `/appointments?date=${localDay(2)}`)).json.data.appointments.length, 0);
  const moved = await s.staff.call('PATCH', `/appointments/${a.id}`, { date: localDay(1), time: '14:30' });
  assert.equal(moved.json.data.time, '14:30');
});

test('appointments: one person cannot be double-booked unless the screen says allowOverlap; someone else can', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  await makeAppt(s);
  const clash = await s.admin.call('POST', '/appointments', apptBody(s, { time: '10:15' }));
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error.code, 'SLOT_TAKEN');
  assert.equal((await s.admin.call('POST', '/appointments', apptBody(s, { time: '10:30' }))).status, 201, 'back-to-back is fine');
  assert.equal((await s.admin.call('POST', '/appointments', apptBody(s, { time: '10:15', performerId: s.ravi.id }))).status, 201);
  assert.equal((await s.admin.call('POST', '/appointments', apptBody(s, { time: '10:15', allowOverlap: true }))).status, 201);
});

test('appointments: the walk-in queue, in arrival order, and starting one', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  const walk = async (name) => (await s.staff.call('POST', '/appointments', { kind: 'walk_in', customerName: name, items: [{ serviceId: s.cut.id, quantity: 1 }] })).json.data;
  const one = await walk('First'); const two = await walk('Second');
  assert.deepEqual([one.status, one.kind], ['waiting', 'walk_in']);
  const q = (await s.admin.call('GET', '/appointments/queue')).json.data.queue;
  assert.deepEqual(q.map((x) => [x.customerName, x.position]), [['First', 1], ['Second', 2]]);
  const started = await s.admin.call('POST', `/appointments/${one.id}/start`, { performerId: s.asha.id });
  assert.equal(started.json.data.status, 'in_service');
  assert.deepEqual((await s.admin.call('GET', '/appointments/queue')).json.data.queue.map((x) => [x.customerName, x.position]), [['Second', 1]]);
  assert.equal((await s.admin.call('POST', `/appointments/${one.id}/start`, {})).status, 409, 'already started');
  assert.equal((await s.admin.call('POST', '/appointments', { kind: 'walk_in', time: '10:00', items: [{ serviceId: s.cut.id, quantity: 1 }] })).status, 400, 'a walk-in has no time');
});

test('appointments: one tap from visit to bill: priced on the server, the visit is completed, and it cannot be billed twice', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  const a = await makeAppt(s, { customerId: s.cust.id, customerName: undefined, items: [{ serviceId: s.spa.id, quantity: 1 }] });
  const bill = { customerId: s.cust.id, appointmentId: a.id, items: [{ serviceId: s.spa.id, performedBy: s.asha.id, quantity: 1 }], discount: 0, paymentMethod: 'upi' };
  const key = `appt-${Date.now()}-aaaa`;
  const made = await s.staff.call('POST', '/invoices', bill, { 'Idempotency-Key': key });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.data.subtotal, 1000);

  const after = (await s.admin.call('GET', `/appointments/${a.id}`)).json.data;
  assert.deepEqual([after.status, after.invoiceId, after.invoiceNumber], ['completed', made.json.data.id, made.json.data.number]);
  assert.equal(after.canOpenInvoice, true);

  const replay = await s.staff.call('POST', '/invoices', bill, { 'Idempotency-Key': key });
  assert.equal([replay.status, replay.headers.get('idempotent-replay')].join(), '200,true', 'a retry of the same tap returns the same bill');
  assert.equal(replay.json.data.id, made.json.data.id);

  const again = await s.admin.call('POST', '/invoices', bill);
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'APPOINTMENT_ALREADY_BILLED');
  assert.equal((await s.admin.call('GET', '/invoices')).json.data.length, 1, 'still one bill');
  assert.equal((await s.admin.call('POST', `/appointments/${a.id}/cancel`, {})).json.error.code, 'APPOINTMENT_ALREADY_BILLED');
  assert.equal((await s.admin.call('PATCH', `/appointments/${a.id}`, { notes: 'x' })).status, 409);
});

test('appointments: a cancelled or no-show visit cannot be billed, and cancelling keeps it on record with the reason', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  const a = await makeAppt(s);
  const c = await s.admin.call('POST', `/appointments/${a.id}/cancel`, { reason: 'Customer called' });
  assert.deepEqual([c.json.data.status, c.json.data.cancelReason], ['cancelled', 'Customer called']);
  const bill = { appointmentId: a.id, items: [{ serviceId: s.cut.id, quantity: 1 }], discount: 0, paymentMethod: 'cash' };
  const r = await s.admin.call('POST', '/invoices', bill);
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'APPOINTMENT_CLOSED');
  assert.equal((await s.admin.call('GET', '/invoices')).json.data.length, 0);
  assert.equal((await s.admin.call('GET', `/appointments?date=${localDay(1)}`)).json.data.appointments.length, 1, 'still on the calendar as a record');
  const future = await makeAppt(s, { time: '16:00' });
  assert.equal((await s.admin.call('POST', `/appointments/${future.id}/no-show`)).json.error.code, 'TOO_EARLY_FOR_NO_SHOW');
  assert.equal((await s.admin.call('DELETE', `/appointments/${future.id}`)).status, 404, 'there is no delete');
});

test('appointments: TENANT ISOLATION: another parlour can never see, change, remind or bill your visits', async () => {
  const sa = await signedIn('super@demo.parlour');
  const a = await apptSetup(sa);
  const b = await apptSetup(sa);
  const mine = await makeAppt(a, { customerName: 'Secret Customer' });
  const walk = (await a.admin.call('POST', '/appointments', { kind: 'walk_in', customerName: 'Secret Walkin', items: [{ serviceId: a.cut.id, quantity: 1 }] })).json.data;

  for (const who of [b.admin, b.staff]) {
    assert.equal((await who.call('GET', `/appointments?date=${localDay(1)}`)).json.data.appointments.length, 0);
    assert.equal((await who.call('GET', '/appointments/queue')).json.data.queue.length, 0);
    for (const [method, path, body] of [
      ['GET', `/appointments/${mine.id}`], ['PATCH', `/appointments/${mine.id}`, { notes: 'hijack' }], ['POST', `/appointments/${walk.id}/start`, {}],
      ['POST', `/appointments/${mine.id}/cancel`, {}], ['POST', `/appointments/${mine.id}/no-show`], ['GET', `/appointments/${mine.id}/reminder`], ['POST', `/appointments/${mine.id}/reminded`],
    ]) notFound(await who.call(method, path, body));
  }
  const stolen = await b.admin.call('POST', '/invoices', { appointmentId: mine.id, items: [{ serviceId: b.cut.id, quantity: 1 }], discount: 0, paymentMethod: 'cash' });
  assert.equal(stolen.status, 400);
  assert.equal(stolen.json.error.code, 'APPOINTMENT_NOT_FOUND');
  assert.equal((await b.admin.call('GET', '/invoices')).json.data.length, 0);

  // B cannot book with A's people, services or customers.
  const cross = (over) => b.admin.call('POST', '/appointments', apptBody(b, over));
  assert.equal((await cross({ performerId: a.asha.id })).json.error.code, 'PERFORMER_UNAVAILABLE');
  assert.equal((await cross({ items: [{ serviceId: a.cut.id, quantity: 1 }] })).json.error.code, 'SERVICE_UNAVAILABLE');
  assert.equal((await cross({ customerId: a.cust.id, customerName: undefined })).json.error.code, 'CUSTOMER_NOT_FOUND');
  assert.deepEqual([(await a.admin.call('GET', `/appointments/${mine.id}`)).json.data.status, (await a.admin.call('GET', `/appointments/${mine.id}`)).json.data.notes], ['booked', null]);
});

test('appointments: the Appointments switch, and each of its buttons, are enforced by the API', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  const a = await makeAppt(s);
  const set = (features) => sa.call('PATCH', `/platform/parlours/${s.p.id}`, { features });
  const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };
  const bill = (over = {}) => ({ items: [{ serviceId: s.cut.id, quantity: 1 }], discount: 0, paymentMethod: 'cash', ...over });

  // Reminder button off: only the reminder goes; the calendar and billing a visit still work.
  assert.equal((await set({ 'action.appointments.remind': false })).status, 200);
  refused(await s.admin.call('GET', `/appointments/${a.id}/reminder`));
  refused(await s.admin.call('POST', `/appointments/${a.id}/reminded`));
  assert.equal((await s.admin.call('GET', `/appointments/${a.id}`)).status, 200);

  // Bill button off: a visit cannot be billed from here, but a plain bill still can.
  assert.equal((await set({ 'action.appointments.bill': false })).status, 200);
  refused(await s.admin.call('POST', '/invoices', bill({ appointmentId: a.id })));
  assert.equal((await s.admin.call('POST', '/invoices', bill())).status, 201, 'a bill with no visit never needs the switch');
  assert.equal((await s.admin.call('GET', `/appointments/${a.id}`)).json.data.status, 'booked', 'the refused bill left the visit alone');

  // Page off: all of it.
  assert.equal((await set({ 'page.appointments': false })).status, 200);
  for (const [method, path, body] of [['GET', '/appointments'], ['GET', '/appointments/queue'], ['POST', '/appointments', apptBody(s)], ['GET', `/appointments/${a.id}`], ['POST', `/appointments/${a.id}/cancel`, {}]]) {
    refused(await s.staff.call(method, path, body));
  }

  // Back on: the same visit is still there.
  assert.equal((await set({ 'page.appointments': true, 'action.appointments.bill': true, 'action.appointments.remind': true })).status, 200);
  assert.equal((await s.staff.call('GET', `/appointments/${a.id}`)).json.data.status, 'booked');
});

test('appointments: naming a person or a saved customer needs those pages; a plain booking needs only Appointments', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  assert.equal((await sa.call('PATCH', `/platform/parlours/${s.p.id}`, { features: { 'page.performers': false, 'page.customers': false } })).status, 200);
  const refused = (r) => { assert.equal(r.status, 403, JSON.stringify(r.json)); assert.equal(r.json.error.code, 'FEATURE_DISABLED'); };
  refused(await s.admin.call('POST', '/appointments', apptBody(s)));                                                       // names Asha
  refused(await s.admin.call('POST', '/appointments', apptBody(s, { performerId: null, customerId: s.cust.id, customerName: undefined })));
  const plain = await s.admin.call('POST', '/appointments', apptBody(s, { performerId: null }));
  assert.equal(plain.status, 201, JSON.stringify(plain.json));
  assert.equal(plain.json.data.performerName, null);
});

test('appointments: input is checked field by field, and the reminder is a ready WhatsApp link that records only when opened', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  const bad = async (over, field) => { const r = await s.admin.call('POST', '/appointments', apptBody(s, over)); assert.equal(r.status, 400, JSON.stringify(over)); if (field) assert.ok(r.json.error.details[field], `${field}: ${JSON.stringify(r.json.error.details)}`); };
  await bad({ date: '2026-02-31' }, 'date');
  await bad({ time: '25:00' }, 'time');
  await bad({ time: undefined }, 'time');
  await bad({ items: [] }, 'items');
  await bad({ items: [{ serviceId: s.cut.id, quantity: 0 }] });
  await bad({ durationMin: 4 }, 'durationMin');
  await bad({ customerPhone: '12345' }, 'customerPhone');
  await bad({ kind: 'online' });
  await bad({ date: localDay(-3) });                      // more than a day in the past
  await bad({ date: localDay(400) });                     // more than a year ahead
  assert.equal((await s.admin.call('GET', '/appointments?date=nope')).status, 400);
  assert.equal((await s.admin.call('GET', '/appointments/not-a-uuid')).status, 400);
  assert.equal((await s.admin.call('PATCH', `/appointments/${(await makeAppt(s)).id}`, {})).status, 400, 'nothing to update');

  const a = await makeAppt(s, { customerId: s.cust.id, customerName: undefined, time: '16:00' });
  const r = (await s.staff.call('GET', `/appointments/${a.id}/reminder`)).json.data;
  assert.match(r.url, /^https:\/\/wa\.me\/919840054321\?text=/);
  assert.match(decodeURIComponent(r.url), /reminder of your appointment/);
  assert.equal((await s.admin.call('GET', `/appointments/${a.id}`)).json.data.reminderSentAt, null, 'building the link records nothing');
  assert.ok((await s.staff.call('POST', `/appointments/${a.id}/reminded`)).json.data.reminderSentAt);
  assert.equal((await s.admin.call('GET', `/appointments/${a.id}/reminder?phone=12`)).status, 400);
});

test('appointments: a person with visits still to come cannot be deleted from the Performers list', async () => {
  const sa = await signedIn('super@demo.parlour');
  const s = await apptSetup(sa);
  const a = await makeAppt(s);
  const blocked = await s.admin.call('DELETE', `/performers/${s.asha.id}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'PERFORMER_HAS_APPOINTMENTS');
  await s.admin.call('POST', `/appointments/${a.id}/cancel`, {});
  assert.equal((await s.admin.call('DELETE', `/performers/${s.asha.id}`)).status, 204);
  assert.equal((await s.admin.call('GET', `/appointments/${a.id}`)).json.data.performerId, null, 'the cancelled visit stays, with nobody named');
});
