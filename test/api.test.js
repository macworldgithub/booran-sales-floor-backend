const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createApp } = require('../server');
const { hashPassword } = require('../lib/password');

const read = (record, field) => field.split('.').reduce((value, key) => value?.[key], record);
const equal = (a, b) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a instanceof Date || b instanceof Date ? +new Date(a) === +new Date(b) : a === b;
function matches(record, query) {
  return Object.entries(query).every(([field, value]) => {
    if (field === '$and') return value.every((part) => matches(record, part));
    if (field === '$or') return value.some((part) => matches(record, part));
    const actual = read(record, field);
    if (value instanceof RegExp) return typeof actual === 'string' && value.test(actual);
    if (value && typeof value === 'object' && !(value instanceof ObjectId) && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]) => {
        switch (operator) {
          case '$regex': return typeof actual === 'string' && new RegExp(expected, value.$options).test(actual);
          case '$options': return true;
          case '$exists': return (actual !== undefined) === expected;
          case '$gt': return actual > expected;
          case '$gte': return actual >= expected;
          case '$lt': return actual < expected;
          case '$lte': return actual <= expected;
          case '$ne': return !equal(actual, expected);
          case '$in': return expected.some((item) => equal(actual, item));
          default: throw new Error(`Unimplemented fixture operator ${operator}`);
        }
      });
    }
    return equal(actual, value);
  });
}
// In-memory storage exercises the real Express/auth/scoping/query/validation layers.
// It deliberately implements only the Mongo operations used by these HTTP scenarios.
function fixtureDb(records) {
  return { collection(name) {
    const rows = records[name] ||= [];
    return {
      find(query) {
        let result = rows.filter((row) => matches(row, query));
        const cursor = {
          sort(fields) { result.sort((a, b) => { for (const [field, direction] of Object.entries(fields)) { const av = read(a, field), bv = read(b, field); if (av < bv) return -direction; if (av > bv) return direction; } return 0; }); return cursor; },
          skip(n) { result = result.slice(n); return cursor; }, limit(n) { result = result.slice(0, n); return cursor; }, async toArray() { return result; },
        };
        return cursor;
      },
      async findOne(query) { return rows.find((row) => matches(row, query)) || null; },
      async countDocuments(query) { return rows.filter((row) => matches(row, query)).length; },
      async insertOne(document) { document._id ||= new ObjectId(); if (rows.some((row) => equal(row._id, document._id))) throw Object.assign(new Error('Duplicate ID'), { code: 11000 }); rows.push(document); return { insertedId: document._id }; },
      async deleteOne(query) { const i = rows.findIndex((row) => matches(row, query)); if (i >= 0) rows.splice(i, 1); },
      async findOneAndUpdate(query, update, options = {}) {
        let row = rows.find((item) => matches(item, query));
        if (!row && options.upsert) { row = { ...query, ...update.$setOnInsert }; rows.push(row); }
        if (!row) return null;
        Object.assign(row, update.$set);
        for (const key of Object.keys(update.$unset || {})) delete row[key];
        for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
        for (const [key, value] of Object.entries(update.$push || {})) (row[key] ||= []).push(value);
        return { ...row };
      },
    };
  } };
}
async function api(t, services = {}) {
  const user = { _id: new ObjectId(), email: 'southmorang@booran.com', name: 'South Morang Manager', role: 'manager', site: 'South Morang', active: true, passwordHash: await hashPassword('123456') };
  const token = 'a'.repeat(64);
  const records = {
    users: [user], sessions: [{ _id: createHash('sha256').update(token).digest('hex'), userId: user._id, expiresAt: new Date(Date.now() + 3600000) }],
    leads: [
      { _id: new ObjectId(), customer_name: 'Alice', dealership_name: 'BYD South Morang', status: 'new_lead', vehicle_make: 'BYD', vehicle_model: 'Seal', owner_name: 'Alex' },
      { _id: new ObjectId(), customer_name: 'Bob', dealership_name: 'South Morang Kia', status: 'sold', owner_name: 'Sam' },
      { _id: new ObjectId(), customer_name: 'Carol', dealership_name: 'Booran Cheltenham', status: 'new_lead' },
    ],
    vehicles: [
      { _id: new ObjectId(), stockNumber: 'S1', rooftopName: 'BYD South Morang', status: 'In Stock', category: 'Used', agingBucket: '90+', daysInStock: 100 },
      { _id: new ObjectId(), stockNumber: 'S2', rooftopName: 'South Morang Kia', status: 'Sold', category: 'New', agingBucket: '0-30', daysInStock: 2 },
      { _id: new ObjectId(), stockNumber: 'C1', rooftopName: 'Booran Cheltenham', status: 'In Stock', category: 'Used', daysInStock: 120 },
    ],
    actionitems: [{ _id: new ObjectId(), rooftopName: 'South Morang Kia', status: 'open' }],
  };
  const hooks = {};
  const app = createApp({ ...services, database: async (key) => {
    const db = fixtureDb(records);
    return { command: async () => hooks.ping ? hooks.ping(key) : { ok: 1 }, collection(name) {
      const collection = db.collection(name);
      return { ...collection, async findOne(query) {
        if (hooks.beforeFindOne) await hooks.beforeFindOne(name, query);
        return collection.findOne(query);
      } };
    } };
  } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  async function request(path, options = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { ...options, headers: { cookie: `booran_session=${token}`, 'content-type': 'application/json', ...options.headers } });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { request, records, user, token, hooks, baseUrl: `http://127.0.0.1:${server.address().port}/api` };
}
test('HTTP login, session expiry and logout enforce authentication', async (t) => {
  const { request, records } = await api(t);
  assert.equal((await request('/leads', { headers: { cookie: '' } })).status, 401);
  assert.equal((await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'southmorang@booran.com', password: 'incorrect' }) })).status, 401);
  const login = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'SOUTHMORANG@booran.com', password: '123456' }) });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.email, 'southmorang@booran.com');
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/auth/me', { headers: { cookie } })).status, 200);
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { cookie } })).status, 200);
  assert.equal((await request('/leads', { headers: { cookie } })).status, 401);
  records.sessions.forEach((session) => { session.expiresAt = new Date(0); });
  assert.equal((await request('/auth/me')).status, 401);
});
test('HTTP filters and pagination scope results and totals to authorised dealerships', async (t) => {
  const { request } = await api(t);
  let result = await request('/leads?limit=1&page=2&sortBy=customer_name&sortOrder=asc');
  assert.equal(result.body.pagination.total, 2);
  assert.equal(result.body.data[0].name, 'Bob');
  result = await request('/leads?status=new_lead&dealership=BYD%20South%20Morang&search=Alice&owner=Alex');
  assert.equal(result.body.pagination.total, 1);
  assert.equal(result.body.data[0].vehicle, 'BYD Seal');
  assert.equal((await request('/leads?rooftop=Booran%20Cheltenham')).body.pagination.total, 0);
  result = await request('/inventory/vehicles?category=Used&agingBucket=90%2B&status=In%20Stock');
  assert.equal(result.body.pagination.total, 1);
  assert.equal(result.body.data[0].stockNumber, 'S1');
  assert.equal((await request('/inventory/vehicles/C1')).status, 404);
  assert.equal((await request('/leads?status=new_lead&status=sold')).status, 400);
  assert.deepEqual((await request('/leads?attention=true')).body.data.map((lead) => lead.name), ['Alice']);
});
test('HTTP super admin can read all dealerships while global data stays restricted for managers', async (t) => {
  const { request, user } = await api(t);
  assert.equal((await request('/inventory/feed-logs')).status, 403);
  assert.equal((await request('/crm/organization')).status, 403);
  user.role = 'super_admin';
  assert.equal((await request('/leads')).body.pagination.total, 3);
  assert.equal((await request('/inventory/vehicles/C1')).status, 200);
});
test('HTTP lead mutations preserve the same view model and server-authored notes', async (t) => {
  const { request, records } = await api(t);
  const id = records.leads[0]._id;
  let result = await request(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'following_up', assignedTo: 'Sam', newNote: 'Called Alice', author: 'Spoofed' }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.name, 'Alice');
  assert.equal(result.body.data.vehicle, 'BYD Seal');
  assert.equal(result.body.data.owner_name, 'Sam');
  assert.equal(result.body.data.diary_entries[0].author, 'South Morang Manager');
  assert.equal((await request(`/leads/${id}`)).body.data.name, 'Alice');
  result = await request('/leads', { method: 'POST', body: JSON.stringify({ name: 'Dora', dealership_name: 'South Morang Kia', vehicle_make: 'Kia', vehicle_model: 'EV3' }) });
  assert.equal(result.status, 201);
  assert.equal(result.body.data.vehicle, 'Kia EV3');
  assert.equal((await request('/unified/search?q=Dora')).body.data.leads[0].name, 'Dora');
  assert.equal((await request(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ dealership_name: 'Booran Cheltenham' }) })).status, 403);
});
test('HTTP invalid request bodies and field types return 400 without corrupting records', async (t) => {
  const { request, records } = await api(t);
  for (const body of ['null', '[]', '{', JSON.stringify({ name: { invalid: true } })]) {
    assert.equal((await request('/leads', { method: 'POST', body })).status, 400);
  }
  for (const change of [{ customer_name: {} }, { status: 'anything' }, { newNote: {} }, { tradeIn: { $set: 'x' } }]) {
    assert.equal((await request(`/leads/${records.leads[0]._id}`, { method: 'PATCH', body: JSON.stringify(change) })).status, 400);
  }
  assert.equal(records.leads[0].customer_name, 'Alice');
  assert.equal((await request('/inventory/action-items/invalid', { method: 'PATCH', body: '{}' })).status, 400);
});
test('HTTP hold transitions reject sold vehicles, duplicate holds and inaccessible locations', async (t) => {
  const { request, records } = await api(t);
  const hold = (stock) => request(`/inventory/vehicles/${stock}/soft-hold`, { method: 'POST', body: JSON.stringify({ prospectName: 'Alice', consultant: 'Spoofed' }) });
  const release = (stock, expected = records.vehicles.find((vehicle) => vehicle.stockNumber === stock)?.softHold || { holdId: 'not-current' }) => request(`/inventory/vehicles/${stock}/release-hold`, { method: 'POST', body: JSON.stringify({ holdId: expected.holdId, heldAt: expected.heldAt }) });
  const concurrent = await Promise.all([hold('S1'), hold('S1')]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
  assert.equal(records.vehicles[0].softHold.consultant, 'South Morang Manager');
  assert.equal((await hold('S2')).status, 409);
  assert.equal((await release('S2')).status, 409);
  assert.equal(records.vehicles[1].status, 'Sold');
  assert.equal((await hold('C1')).status, 404);
  const previousHold = { ...records.vehicles[0].softHold };
  records.vehicles[0].softHold.expiresAt = new Date(0).toISOString();
  const expired = await request('/inventory/vehicles/S1');
  assert.equal(expired.body.data.status, 'In Stock');
  assert.equal(expired.body.data.softHold.held, false);
  const available = await request('/inventory/vehicles?status=In%20Stock');
  assert.deepEqual(available.body.data.map((vehicle) => vehicle.stockNumber), ['S1']);
  assert.equal((await request('/inventory/vehicles?status=Soft%20Hold')).body.pagination.total, 0);
  assert.equal((await hold('S1')).status, 200);
  assert.equal((await release('S1', previousHold)).status, 409);
  assert.equal(records.vehicles[0].status, 'Soft Hold');
  assert.equal((await release('S1')).status, 200);
  assert.equal((await release('S1')).status, 409);
});
test('HTTP appointments validate dates, types, durations and linked dealership', async (t) => {
  const { request, records } = await api(t);
  const booking = { leadId: String(records.leads[0]._id), dealership: 'BYD South Morang', prospectName: 'Alice', when: '2026-10-20T01:30:00.000Z', duration: 45, type: 'Test Drive' };
  assert.equal((await request('/appointments', { method: 'POST', body: JSON.stringify(booking) })).status, 201);
  for (const change of [{ when: '2026-02-30T01:30:00.000Z' }, { duration: '45' }, { prospectName: {} }, { type: 'Anything' }, { dealership: 'South Morang Kia' }]) {
    assert.equal((await request('/appointments', { method: 'POST', body: JSON.stringify({ ...booking, ...change }) })).status, 400);
  }
  assert.equal((await request('/appointments?from=2026-10-21&to=2026-10-20')).status, 400);
  assert.equal((await request('/appointments?from=2026-02-30')).status, 400);
  assert.equal((await request('/appointments?from=October%2020')).status, 400);
  const result = await request('/appointments?from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z&type=Test%20Drive');
  assert.equal(result.body.pagination.total, 1);
  const id = records.actionitems[0]._id;
  assert.equal((await request(`/inventory/action-items/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }) })).status, 200);
  assert.equal(records.actionitems[0].resolvedAt, undefined);
});

test('HTTP cleared lead details stay cleared and empty action changes cannot resolve a record', async (t) => {
  const { request, records } = await api(t);
  const lead = records.leads[0];
  lead.testDrive = { confirmed: true };
  lead.tradeIn = { make: 'Legacy car' };
  let result = await request(`/leads/${lead._id}`, { method: 'PATCH', body: JSON.stringify({ testDrive: null, tradeIn: null }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.testDrive, null);
  assert.equal(result.body.data.tradeIn, null);
  result = await request(`/leads/${lead._id}`);
  assert.equal(result.body.data.testDrive, null);
  assert.equal((await request(`/inventory/action-items/${records.actionitems[0]._id}`, { method: 'PATCH', body: '{}' })).status, 400);
  assert.equal(records.actionitems[0].status, 'open');
});

test('HTTP malformed stored sessions are rejected as expired rather than causing a service outage', async (t) => {
  const { request, records } = await api(t);
  records.sessions[0].userId = 'broken-id';
  const result = await request('/auth/me');
  assert.equal(result.status, 401);
  assert.equal(result.headers.get('set-cookie'), null);
});

test('HTTP late expired-session responses cannot erase a newer login cookie', async (t) => {
  const { request, records, hooks } = await api(t);
  records.sessions[0].expiresAt = new Date(0);
  let release, started;
  const reached = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  hooks.beforeFindOne = async (name) => { if (name === 'sessions') { started(); await blocked; } };
  const previous = request('/auth/me');
  await reached;
  const login = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'southmorang@booran.com', password: '123456' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  release();
  const expired = await previous;
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get('set-cookie'), null);
  assert.equal((await request('/auth/me', { headers: { cookie } })).status, 200);
  const logout = await request('/auth/logout', { method: 'POST', headers: { cookie } });
  assert.match(logout.headers.get('set-cookie'), /Expires=/);
});

test('HTTP parser errors retain client status codes and no-store response headers', async (t) => {
  const { request } = await api(t);
  for (const [path, options, status] of [
    ['/leads/%E0%A4%A', {}, 400],
    ['/leads', { method: 'POST', headers: { 'content-type': 'application/json; charset=invalid' }, body: '{}' }, 415],
    ['/leads', { method: 'POST', body: '{' }, 400],
  ]) {
    const result = await request(path, options);
    assert.equal(result.status, status);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.body.success, false);
  }
});

test('HTTP health reports each database accurately when only one is available', async (t) => {
  const { request, hooks } = await api(t);
  hooks.ping = async (key) => { if (key === 'MONGODB_URI_FLWUP') throw new Error('Database unavailable'); return { ok: 1 }; };
  const result = await request('/health', { headers: { cookie: '' } });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body.databases, { flwup_crm: 'error', booran_inventory_tracker: 'connected' });
});

test('Mongo date values in lead diary entries are preserved in API responses', () => {
  const { serializeLead } = require('../lib/records');
  const date = new Date('2026-10-20T01:30:00Z');
  const result = serializeLead({ _id: new ObjectId(), diary_entries: [{ author: 'Manager', note: 'Called', date }] });
  assert.equal(result.diary_entries[0].date, date.toISOString());
});

test('HTTP CSV sync endpoint enforces super admin role', async (t) => {
  const { request, user } = await api(t);
  // Default user is manager -> 403
  const managerRes = await request('/inventory/sync-csv', { method: 'POST' });
  assert.equal(managerRes.status, 403);
  assert.equal(managerRes.body.success, false);
});

test('resolveRooftop correctly normalizes branch codes and filenames', () => {
  const { resolveRooftop } = require('../scripts/ingest-csv');
  assert.deepEqual(resolveRooftop('40', 'SouthMorangHyundai'), {
    rooftopId: 'southmoranghyundai',
    rooftopName: 'South Morang Hyundai',
    branchCode: '40',
    clusterId: 'cluster-hyundai-metro',
  });
  assert.deepEqual(resolveRooftop('70', 'SouthMorangKIA'), {
    rooftopId: 'southmorangkia',
    rooftopName: 'South Morang Kia',
    branchCode: '70',
    clusterId: 'cluster-hyundai-metro',
  });
});

test('customer SMS saves links, server identity and diary, and cannot duplicate a send', async (t) => {
  const providerCalls = [];
  const sms = { ...require('../lib/mobilemessage'), configured: () => true, sendSms: async (payload) => { providerCalls.push(payload); return { status: 'queued', provider_message_id: 'provider-1' }; } };
  const { request, records } = await api(t, { sms });
  const lead = records.leads[0]; lead.customer_phone = '0412 345 678';
  const media = { _id: new ObjectId(), lead_id: String(lead._id), dealership_name: lead.dealership_name, share_token: 'b'.repeat(64), status: 'ready', name: 'walkaround.mp4', content_type: 'video/mp4', size: 1000, created_at: new Date().toISOString() };
  records.message_media = [media];
  const path = `/leads/${lead._id}/messages`;
  const payload = { body: 'Your vehicle walkaround', media_ids: [String(media._id)], request_id: '12345678-1234-1234-1234-123456789abc', author: 'Forged' };
  const options = { method: 'POST', body: JSON.stringify(payload) };
  const result = await request(path, options);
  assert.equal(result.status, 201);
  assert.equal(result.body.data.status, 'queued');
  assert.equal(result.body.data.author, 'South Morang Manager');
  assert.equal(records.customer_messages[0].user_id, String(records.users[0]._id));
  assert.equal(result.body.data.phone, '+61412345678');
  assert.match(result.body.data.body, /Your vehicle walkaround\nhttps?:.*\/api\/media\/b{64}/);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].body, result.body.data.body);
  assert.equal(lead.diary_entries.length, 1);
  const repeated = await request(path, options);
  assert.equal(repeated.body.data.id, result.body.data.id);
  assert.equal(providerCalls.length, 1);
  assert.equal((await request(path, { method: 'POST', body: JSON.stringify({ ...payload, body: 'Changed' }) })).status, 409);
  const history = await request(path);
  assert.equal(history.body.data.messages.length, 1);
  assert.equal(history.body.pagination.total, 1);
  assert.equal(history.body.data.messages[0].fingerprint, undefined);
  assert.equal(history.body.data.messages[0].provider_message_id, undefined);
});

test('messages and media enforce customer/location access and cannot attach another customer’s media', async (t) => {
  let calls = 0;
  const sms = { ...require('../lib/mobilemessage'), configured: () => true, sendSms: async () => { ++calls; return { status: 'queued' }; } };
  const { request, records } = await api(t, { sms });
  const [lead, other, forbidden] = records.leads;
  lead.customer_phone = '0412345678';
  const media = { _id: new ObjectId(), lead_id: String(other._id), dealership_name: other.dealership_name, status: 'ready' };
  records.message_media = [media];
  const payload = { body: 'Hello', request_id: '12345678-1234-1234-1234-123456789abc', media_ids: [String(media._id)] };
  assert.equal((await request(`/leads/${lead._id}/messages`, { headers: { cookie: '' } })).status, 401);
  for (const endpoint of ['messages', 'media']) {
    assert.equal((await request(`/leads/${forbidden._id}/${endpoint}`)).status, 404);
    assert.equal((await request(`/leads/${forbidden._id}/${endpoint}`, { method: 'POST', body: JSON.stringify(payload) })).status, 404);
  }
  assert.equal((await request(`/leads/${lead._id}/messages`, { method: 'POST', body: JSON.stringify(payload) })).status, 400);
  assert.equal((await request(`/leads/${lead._id}/media/${media._id}/complete`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await request(`/leads/${lead._id}/media`)).body.data.length, 0);
  assert.equal(calls, 0);
});

test('failed and indeterminate provider responses remain in customer history without a false success', async (t) => {
  let calls = 0;
  const sms = { ...require('../lib/mobilemessage'), configured: () => true, sendSms: async () => ({ status: ++calls === 1 ? 'failed' : 'unknown', error: 'Fixture provider failure' }) };
  const { request, records } = await api(t, { sms });
  const lead = records.leads[0]; lead.customer_phone = '0412345678';
  const path = `/leads/${lead._id}/messages`;
  for (const [n, status] of [[1, 'failed'], [2, 'unknown']]) {
    const payload = { body: 'Hello', request_id: `12345678-1234-1234-1234-123456789ab${n}` };
    assert.equal((await request(path, { method: 'POST', body: JSON.stringify(payload) })).body.data.status, status);
    assert.equal((await request(path, { method: 'POST', body: JSON.stringify(payload) })).body.data.status, status);
  }
  assert.equal(calls, 2);
  assert.equal((await request(path)).body.pagination.total, 2);
  assert.equal(lead.diary_entries.length, 2);
});

test('pending send reservations prevent simultaneous customer requests from sending twice', async (t) => {
  let resolveSend, started;
  const start = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const sms = { ...require('../lib/mobilemessage'), configured: () => true, sendSms: async () => { ++calls; started(); return new Promise((resolve) => { resolveSend = resolve; }); } };
  const { request, records } = await api(t, { sms });
  const lead = records.leads[0]; lead.customer_phone = '0412345678';
  const path = `/leads/${lead._id}/messages`;
  const options = { method: 'POST', body: JSON.stringify({ body: 'Hello', request_id: '12345678-1234-1234-1234-123456789abc' }) };
  const first = request(path, options);
  await start;
  const duplicate = await request(path, options);
  assert.equal(duplicate.body.data.status, 'pending');
  resolveSend({ status: 'queued', provider_message_id: 'provider-1' });
  assert.equal((await first).body.data.status, 'queued');
  assert.equal(calls, 1);
});

test('media shares become public only after completion and do not expose storage metadata', async (t) => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const root = require('node:os').tmpdir();
  const directory = await fs.mkdtemp(path.join(root, 'salesfloor-media-http-'));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(root) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  const storage = require('../lib/media-storage').createLocalStorage({ directory, serverless: false });
  const { request, records, baseUrl } = await api(t, { storage });
  const lead = records.leads[0];
  const created = await request(`/leads/${lead._id}/media`, { method: 'POST', body: JSON.stringify({ name: 'photo.jpg', content_type: 'image/jpeg', size: 100 }) });
  assert.equal(created.status, 201);
  const media = records.message_media[0];
  assert.equal(media.dealership_name, lead.dealership_name);
  assert.equal((await request(`/leads/${lead._id}/media`)).body.data.length, 0);
  const url = `${baseUrl}/media/${media.share_token}`;
  assert.equal((await fetch(url)).status, 404);
  const contentPath = `/leads/${lead._id}/media/${created.body.data.id}/content?offset=0`;
  const bytes = Buffer.alloc(100, 255);
  assert.equal((await request(contentPath, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream', cookie: '' } })).status, 401);
  assert.equal((await request(contentPath.replace(String(lead._id), String(records.leads[2]._id)), { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } })).status, 404);
  assert.equal((await request(contentPath, { method: 'PUT', body: bytes, headers: { 'content-type': 'text/plain' } })).status, 415);
  const saved = await request(contentPath, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.next_offset, 100);
  const finished = await request(`/leads/${lead._id}/media/${created.body.data.id}/complete`, { method: 'POST', body: '{}' });
  assert.equal(finished.status, 200);
  assert.match(finished.body.data.url, /\/api\/media\/[a-f0-9]{64}$/);
  assert.equal(finished.body.data.storage_key, undefined);
  assert.equal(finished.body.data.staging_key, undefined);
  assert.equal((await request(`/leads/${lead._id}/media`)).body.data.length, 1);
  assert.equal((await request(`/leads/${lead._id}/media/${created.body.data.id}/complete`, { method: 'POST', body: '{}' })).status, 200);
  const publicRead = await fetch(url);
  assert.equal(publicRead.status, 200);
  assert.equal(publicRead.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await publicRead.arrayBuffer()), bytes);
  assert.equal(publicRead.headers.get('x-content-type-options'), 'nosniff');
  const range = await fetch(url, { headers: { Range: 'bytes=10-19' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 10-19/100');
  assert.equal((await range.arrayBuffer()).byteLength, 10);
  assert.equal((await request(contentPath, { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } })).status, 404);
  media.status = 'uploading';
  assert.equal((await fetch(url)).status, 404);
});
