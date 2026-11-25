const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createApp } = require('../server');
const { hashPassword } = require('../lib/password');
const { businessId } = require('../lib/prospects');

function readField(row, path) {
  return path.split('.').reduce((acc, part) => acc?.[part], row);
}

function equalVal(a, b) {
  return a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b;
}

function matchesQuery(row, query = {}) {
  for (const [key, expected] of Object.entries(query)) {
    if (key === '$and') { if (!expected.every(part => matchesQuery(row, part))) return false; continue; }
    if (key === '$or') { if (!expected.some(part => matchesQuery(row, part))) return false; continue; }
    if (key === '$nor') { if (expected.some(part => matchesQuery(row, part))) return false; continue; }
    const actual = readField(row, key);
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      if ('$exists' in expected && Boolean(actual !== undefined) !== expected.$exists) return false;
      if ('$in' in expected && !expected.$in.some(item => equalVal(actual, item))) return false;
      if ('$nin' in expected && expected.$nin.some(item => equalVal(actual, item))) return false;
      if ('$ne' in expected && equalVal(actual, expected.$ne)) return false;
      if ('$regex' in expected && !(new RegExp(expected.$regex, expected.$options || '')).test(String(actual ?? ''))) return false;
      if ('$type' in expected && expected.$type === 'string' && typeof actual !== 'string') return false;
    } else if (!equalVal(actual, expected)) return false;
  }
  return true;
}

function fixtureDb(records) {
  return {
    client: { withSession: async fn => fn({ withTransaction: async op => op() }) },
    collection(name) {
      const rows = (records[name] ||= []);
      return {
        find(query = {}) {
          let result = rows.filter(row => matchesQuery(row, query));
          const cursor = {
            sort(fields) {
              result.sort((a, b) => {
                for (const [field, dir] of Object.entries(fields)) {
                  const av = readField(a, field) ?? '';
                  const bv = readField(b, field) ?? '';
                  if (av < bv) return -dir;
                  if (av > bv) return dir;
                }
                return 0;
              });
              return cursor;
            },
            skip(n) { result = result.slice(n); return cursor; },
            limit(n) { result = result.slice(0, n); return cursor; },
            async toArray() { return result; },
          };
          return cursor;
        },
        async findOne(query = {}) { return rows.find(row => matchesQuery(row, query)) || null; },
        aggregate(pipeline = []) {
          return {
            async toArray() {
              if (name === 'sessions') {
                const match = pipeline.find(s => s.$match?._id)?.$match || {};
                const active = rows.filter(r => (!match._id || r._id === match._id) && new Date(r.expiresAt) > new Date());
                return active.flatMap(s => {
                  const u = (records.users || []).find(u => equalVal(u._id, s.userId) && u.active !== false);
                  return u ? [u] : [];
                });
              }
              return rows;
            },
          };
        },
        async countDocuments(query = {}) { return rows.filter(row => matchesQuery(row, query)).length; },
        async insertOne(doc) {
          doc._id ||= new ObjectId();
          if (rows.some(r => equalVal(r._id, doc._id))) throw Object.assign(new Error('Duplicate'), { code: 11000 });
          rows.push(doc);
          return { insertedId: doc._id };
        },
        async deleteOne(query) {
          const i = rows.findIndex(r => matchesQuery(r, query));
          if (i >= 0) rows.splice(i, 1);
          return { deletedCount: i >= 0 ? 1 : 0 };
        },
        async updateMany(query, update) {
          const list = rows.filter(r => matchesQuery(r, query));
          for (const row of list) {
            for (const [k, v] of Object.entries(update.$set || {})) row[k] = v;
            for (const [k, v] of Object.entries(update.$addToSet || {})) row[k] = [...new Set([...(row[k] || []), ...(v.$each || [v])])];
            for (const [k, v] of Object.entries(update.$push || {})) (row[k] ||= []).push(v);
          }
          return { modifiedCount: list.length };
        },
        async findOneAndUpdate(query, update, options = {}) {
          let row = rows.find(r => matchesQuery(r, query));
          if (!row && options.upsert) {
            const eq = {};
            for (const [k, v] of Object.entries(query)) {
              if (!k.startsWith('$') && (v === null || typeof v !== 'object' || v instanceof ObjectId)) eq[k] = v;
            }
            row = { ...eq, ...update.$setOnInsert };
            rows.push(row);
          }
          if (!row) return null;
          for (const [k, v] of Object.entries(update.$set || {})) {
            const [head, child] = k.split('.');
            if (child) (row[head] ||= {})[child] = v;
            else row[head] = v;
          }
          for (const [k, v] of Object.entries(update.$addToSet || {})) row[k] = [...new Set([...(row[k] || []), ...(v.$each || [v])])];
          for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
          for (const [k, v] of Object.entries(update.$push || {})) (row[k] ||= []).push(v);
          return { ...row };
        },
      };
    },
  };
}

async function setupApi(t) {
  const manager = { _id: new ObjectId(), email: 'mgr@booran.com', name: 'Kris Liberi', role: 'manager', site: 'South Morang', active: true, passwordHash: await hashPassword('123456') };
  const token = 'b'.repeat(64);
  const leadId = new ObjectId();
  const site = 'South Morang Hyundai';
  const records = {
    users: [manager],
    sessions: [{ _id: createHash('sha256').update(token).digest('hex'), userId: manager._id, expiresAt: new Date(Date.now() + 3600000) }],
    leads: [
      { _id: leadId, customer_name: 'Colin Beruld', customer_phone: '+61412345678', customer_email: 'colin@beruld.test', dealership_name: site, status: 'following_up', vehicle_make: 'Hyundai', vehicle_model: 'Tucson', owner_name: 'James Carter', owner_id: String(manager._id), created_at: '2023-06-12T00:00:00Z' },
      { _id: new ObjectId(), customer_name: 'Foreign Lead', customer_phone: '+61499888777', dealership_name: 'Booran Cheltenham', status: 'new_lead' },
    ],
    vehicles: [],
    deals: [],
    deliveries: [],
    dp_sales_events: [],
    appraisals: [],
    service_bookings: [],
    businesses: [],
    customer_businesses: [],
  };

  const app = createApp({
    historySources: {},
    sms: { ...require('../lib/mobilemessage'), lookupMessage: async () => null, listInbound: async () => ({ results: [], total: 0 }) },
    database: async () => fixtureDb(records),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  async function req(path, options = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      ...options,
      headers: { cookie: `booran_session=${token}`, 'content-type': 'application/json', ...options.headers },
    });
    return { status: res.status, body: await res.json() };
  }

  return { req, records, manager, leadId: String(leadId), site };
}

test('GET /leads/:id/history aggregates lifetime spend, deduplicates DMS/deals, masks costs and reflects new sales', async t => {
  const { req, records, leadId, site } = await setupApi(t);
  const stockId = new ObjectId();
  records.vehicles.push({ _id: stockId, make: 'Hyundai', model: 'Tucson', variant: 'Elite AWD', year: 2023, vin: 'KMHJ3812MPU123456', stockNumber: 'ST100' });

  const deal1Id = new ObjectId();
  const deal2Id = new ObjectId();
  records.deals.push(
    { _id: deal1Id, lead_id: leadId, dealership: site, status: 'completed', stock_key: String(stockId), vin: 'KMHJ3812MPU123456', make: 'Hyundai', model: 'Tucson', sale_price_cents: 4899000, cost_cents: 4100000, gross_cents: 799000, completed_at: '2024-06-12T04:00:00Z', owner_name: 'James Carter' },
    { _id: deal2Id, lead_id: leadId, dealership: site, status: 'completed', vin: 'KMHLC81FGMU654321', make: 'Hyundai', model: 'i30', year: 2021, sale_price_cents: 2675000, completed_at: '2022-11-18T02:00:00Z', owner_name: 'Sarah Nguyen' },
  );
  // Duplicate DMS feed event matching deal1Id should enrich/merge rather than double-count
  records.dp_sales_events.push({ _id: 'dms1', dealership: site, leadId, status: 'completed', vin: 'KMHJ3812MPU123456', revenueCents: 4899000, date: '2024-06-12T04:00:00Z' });
  // Completed delivery marks deal2 as Delivered
  records.deliveries.push({ _id: new ObjectId(), deal_id: deal2Id, lead_id: leadId, dealership: site, status: 'completed', completedAt: '2022-11-20T03:00:00Z' });
  // Service booking
  records.service_bookings.push({ _id: 'sb1', dealership: site, lead_id: leadId, starts_at: '2025-02-01T01:00:00Z', vehicle: '2023 Hyundai Tucson', status: 'booked', reference: 'RO-9001' });

  let res = await req(`/leads/${leadId}/history`);
  assert.equal(res.status, 200, res.body.error);
  const { summary, items, serviceBookings } = res.body.data;
  assert.equal(summary.totalVehiclesPurchased, 2);
  assert.equal(summary.lifetimeSpendCents, 4899000 + 2675000);
  assert.equal(summary.lastPurchaseDate, '2024-06-12T04:00:00Z');
  assert.equal(items.length, 2);
  assert.equal(items[0].vin, 'KMHJ3812MPU123456');
  assert.equal(items[0].status, 'Completed');
  assert.equal(items[1].status, 'Delivered');
  assert.equal('cost_cents' in items[0], false);
  assert.equal('gross_cents' in items[0], false);
  assert.equal(serviceBookings.length, 1);

  // Add a third purchase directly as a completed deal -> lifetime summary updates immediately
  records.deals.push({ _id: new ObjectId(), lead_id: leadId, dealership: site, status: 'completed', make: 'Hyundai', model: 'Santa Fe', year: 2025, sale_price_cents: 6676000, completed_at: '2025-08-01T00:00:00Z' });
  res = await req(`/leads/${leadId}/history`);
  assert.equal(res.body.data.summary.totalVehiclesPurchased, 3);
  assert.equal(res.body.data.summary.lifetimeSpendCents, 4899000 + 2675000 + 6676000);
  assert.equal(res.body.data.summary.lastPurchaseDate, '2025-08-01T00:00:00Z');
});

test('Business many-to-many endpoints support attaching, primary toggle, adding people, history roll-up and site isolation', async t => {
  const { req, records, leadId, site } = await setupApi(t);
  const michaelId = new ObjectId();
  records.leads.push({
    _id: michaelId,
    customer_name: 'Michael Beruld',
    customer_phone: '+61412999888',
    dealership_name: site,
    status: 'sold',
    sold_at: '2024-03-10T00:00:00Z',
    vehicle_make: 'Hyundai',
    vehicle_model: 'Staria Load',
    owner_name: 'Kris Liberi',
  });

  // 1. Attach Colin to Beruld Transport Pty Ltd as Primary Contact
  let attach = await req(`/leads/${leadId}/business/attach`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Beruld Transport Pty Ltd',
      abn: '45 672 389 514',
      industry: 'Transport & Logistics',
      role: 'Fleet Coordinator',
      isPrimary: true,
    }),
  });
  assert.equal(attach.status, 201, attach.body.error);
  const transportId = attach.body.data.business.primaryBusinessId;
  assert.ok(transportId);
  assert.equal(attach.body.data.business.businesses.length, 1);
  assert.equal(attach.body.data.business.businesses[0].business.abn, '45 672 389 514');
  assert.equal(attach.body.data.business.businesses[0].link.isPrimary, true);

  // 2. Attach Colin to a second business (many-to-many)
  let attach2 = await req(`/leads/${leadId}/business/attach`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Beruld Holdings Group',
      industry: 'Non-operating holding company',
      role: 'Director',
      isPrimary: false,
    }),
  });
  assert.equal(attach2.status, 201, attach2.body.error);
  assert.equal(attach2.body.data.business.businesses.length, 2);

  // 3. Add existing person Michael Beruld to Beruld Transport and set Michael as Primary Contact (automatically clears Colin's primary on that business)
  let addExisting = await req(`/leads/${leadId}/business/${transportId}/people`, {
    method: 'POST',
    body: JSON.stringify({
      existingLeadId: String(michaelId),
      role: 'Director',
      isPrimary: true,
    }),
  });
  assert.equal(addExisting.status, 201, addExisting.body.error);
  const transportEntry = addExisting.body.data.business.businesses.find(b => b.business._id === transportId);
  assert.equal(transportEntry.people.length, 2);
  assert.equal(transportEntry.link.isPrimary, false, 'Setting Michael primary clears Colin primary on the same business');
  assert.equal(transportEntry.people.find(p => p.leadId === String(michaelId)).isPrimary, true);

  // 4. Add a brand new person Sarah Thompson directly to Beruld Transport
  let addNew = await req(`/leads/${leadId}/business/${transportId}/people`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Sarah Thompson',
      phone: '0438 765 432',
      role: 'Fleet Manager',
    }),
  });
  assert.equal(addNew.status, 201, addNew.body.error);
  const updatedTransport = addNew.body.data.business.businesses.find(b => b.business._id === transportId);
  assert.equal(updatedTransport.people.length, 3);
  assert.ok(updatedTransport.people.some(p => p.name === 'Sarah Thompson' && p.role === 'Fleet Manager'));

  // 5. History tab includes linked business vehicle purchase (Michael's Staria Load) when includeBusiness=true, and excludes it when false
  const histWithBiz = await req(`/leads/${leadId}/history`);
  assert.equal(histWithBiz.status, 200);
  assert.equal(histWithBiz.body.data.summary.totalVehiclesPurchased, 1);
  assert.equal(histWithBiz.body.data.items[0].scope, 'business');
  assert.equal(histWithBiz.body.data.items[0].buyerName, 'Michael Beruld');

  const histOnlyPerson = await req(`/leads/${leadId}/history?includeBusiness=false`);
  assert.equal(histOnlyPerson.body.data.summary.totalVehiclesPurchased, 0);

  // 6. Detach Colin from Beruld Holdings Group
  const holdingsId = addNew.body.data.business.businesses.find(b => b.business.name === 'Beruld Holdings Group').business._id;
  const detached = await req(`/leads/${leadId}/business/${holdingsId}`, { method: 'DELETE' });
  assert.equal(detached.status, 200);
  assert.equal(detached.body.data.business.businesses.length, 1);

  // 7. Site isolation: foreign dealership lead returns 404
  const foreignId = String(records.leads.find(l => l.dealership_name === 'Booran Cheltenham')._id);
  const foreignRes = await req(`/leads/${foreignId}/business`);
  assert.equal(foreignRes.status, 404);
});
