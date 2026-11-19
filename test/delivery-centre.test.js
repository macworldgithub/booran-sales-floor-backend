const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createApp } = require('../server');
const { hashPassword } = require('../lib/password');
const {
  validateItemsAgainstContract,
  itemMatchesContract,
  normalizeText,
} = require('../lib/delivery-centre');

test('itemMatchesContract matches exact and semantic accessory terms', () => {
  const contract = [
    'Front & Rear Dash Cam',
    'Darkest Legal Tint',
    'Tailored Carpet Floor Mats',
    'Full Tank Diesel',
    'Ceramic Paint Protection',
    'Mechanical PD',
  ];

  assert.equal(itemMatchesContract('Front & Rear Dash Cam', contract), true);
  assert.equal(itemMatchesContract('Dash Cam (Front & Rear)', contract), true);
  assert.equal(itemMatchesContract('Window Tint', contract), true);
  assert.equal(itemMatchesContract('Carpet Floor Mats', contract), true);
  assert.equal(itemMatchesContract('Diesel Fuel', contract), true);
  assert.equal(itemMatchesContract('Paint Protection', contract), true);
  assert.equal(itemMatchesContract('Mechanical PD', contract), true);

  // Uncontracted items MUST NOT match
  assert.equal(itemMatchesContract('Towbar and Harness', contract), false);
  assert.equal(itemMatchesContract('Roof Racks', contract), false);
  assert.equal(itemMatchesContract('Bullbar', contract), false);
  assert.equal(itemMatchesContract('Snorkel', contract), false);
});

test('validateItemsAgainstContract separates contracted from uncontracted items', () => {
  const contract = ['Front & Rear Dash Cam', 'Darkest Legal Tint', 'Carpet Mats'];
  const requested = ['Dash Cam', 'Darkest Legal Tint', 'Heavy Duty Towbar', 'Carpet Mats'];

  const result = validateItemsAgainstContract(contract, requested);
  assert.equal(result.isValid, false);
  assert.deepEqual(result.matchedItems, ['Dash Cam', 'Darkest Legal Tint', 'Carpet Mats']);
  assert.deepEqual(result.rejectedItems, ['Heavy Duty Towbar']);
  assert.deepEqual(result.eligibleRoItems, ['Dash Cam', 'Darkest Legal Tint', 'Carpet Mats']);
});

function fixtureDb(records) {
  const getCollection = name => {
    records[name] ||= [];
    const rows = records[name];
    return {
      find(query = {}) {
        let filtered = rows.filter(r => {
          for (const [k, v] of Object.entries(query)) {
            if (k === '_id' && v instanceof ObjectId && !v.equals(r._id)) return false;
            if (k === 'dealership' && typeof v === 'object' && v.$regex && !new RegExp(v.$regex, v.$options).test(r.dealership)) return false;
            if (k === 'status' && typeof v === 'object' && v.$in && !v.$in.includes(r.status)) return false;
            if (k === 'stockNumber' && r.stockNumber !== v) return false;
            if (k === 'stock_number' && r.stock_number !== v) return false;
            if (typeof v !== 'object' && r[k] !== undefined && r[k] !== v) return false;
          }
          return true;
        });
        return {
          sort() { return this; },
          skip(n) { filtered = filtered.slice(n); return this; },
          limit(n) { filtered = filtered.slice(0, n); return this; },
          toArray: async () => filtered.map(item => ({ ...item })),
        };
      },
      countDocuments: async (query = {}) => {
        return rows.filter(r => {
          for (const [k, v] of Object.entries(query)) {
            if (k === 'dealership' && typeof v === 'object' && v.$regex && !new RegExp(v.$regex, v.$options).test(r.dealership)) return false;
            if (typeof v !== 'object' && r[k] !== undefined && r[k] !== v) return false;
          }
          return true;
        }).length;
      },
      aggregate(pipeline = []) {
        return {
          toArray: async () => {
            if (name === 'sessions') {
              const u = records.users?.[0];
              return u ? [{ ...u }] : [];
            }
            return rows.map(r => ({ ...r }));
          },
        };
      },
      findOne: async (query = {}) => {
        return rows.find(r => {
          for (const [k, v] of Object.entries(query)) {
            if (k === '_id' && v instanceof ObjectId && !v.equals(r._id)) return false;
            if (k === 'deal_id' && v instanceof ObjectId && !v.equals(new ObjectId(r.deal_id))) return false;
            if (k === 'stockNumber' && r.stockNumber !== v) return false;
            if (k === 'stock_number' && r.stock_number !== v) return false;
            if (typeof v !== 'object' && r[k] !== undefined && r[k] !== v) return false;
          }
          return true;
        }) || null;
      },
      insertOne: async doc => {
        const _id = doc._id || new ObjectId();
        const stored = { ...doc, _id };
        rows.push(stored);
        return { insertedId: _id };
      },
      insertMany: async docs => {
        for (const doc of docs) {
          rows.push({ ...doc, _id: doc._id || new ObjectId() });
        }
        return { insertedCount: docs.length };
      },
      updateOne: async (query, update, options = {}) => {
        let doc = rows.find(r => {
          for (const [k, v] of Object.entries(query)) {
            if (k === '_id' && v instanceof ObjectId && !v.equals(r._id)) return false;
            if (k === 'stock_number' && r.stock_number !== v) return false;
            if (typeof v !== 'object' && r[k] !== undefined && r[k] !== v) return false;
          }
          return true;
        });
        if (!doc && options.upsert) {
          doc = { _id: new ObjectId(), ...query };
          rows.push(doc);
        }
        if (doc) {
          if (update.$set) Object.assign(doc, update.$set);
          if (update.$push) {
            for (const [pk, pv] of Object.entries(update.$push)) {
              doc[pk] ||= [];
              if (pv.$each) doc[pk].push(...pv.$each);
              else doc[pk].push(pv);
            }
          }
        }
        return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
      },
      findOneAndUpdate: async (query, update, options = {}) => {
        const doc = rows.find(r => {
          for (const [k, v] of Object.entries(query)) {
            if (k === '_id' && v instanceof ObjectId && !v.equals(r._id)) return false;
            if (typeof v !== 'object' && r[k] !== undefined && r[k] !== v) return false;
          }
          return true;
        });
        if (doc) {
          if (update.$set) Object.assign(doc, update.$set);
          if (update.$push) {
            for (const [pk, pv] of Object.entries(update.$push)) {
              doc[pk] ||= [];
              if (pv.$each) doc[pk].push(...pv.$each);
              else doc[pk].push(pv);
            }
          }
        }
        return doc ? { ...doc } : null;
      },
      updateMany: async (query, update) => {
        let count = 0;
        for (const r of rows) {
          let matches = true;
          for (const [k, v] of Object.entries(query)) {
            if (k === 'stockNumber' && r.stockNumber !== v) { matches = false; break; }
          }
          if (matches) {
            if (update.$set) Object.assign(r, update.$set);
            count++;
          }
        }
        return { modifiedCount: count };
      },
    };
  };

  return {
    collection: getCollection,
    command: async () => ({ ok: 1 }),
    client: {
      withSession: async cb => cb({ withTransaction: async op => op() }),
    },
  };
}

test('Delivery Centre: Full Get Ready, Contract Validation, RO Raise, and Sales Log workflow', async t => {
  const dealership = 'South Morang Hyundai';
  const dealId = new ObjectId();
  const stockNumber = '320476904';
  const dealNumber = 'SM29161';
  const token = 'b'.repeat(64);

  const user = {
    _id: new ObjectId(),
    id: 'user-manager-1',
    name: 'Sarah Connor',
    email: 'sarah@booran.test',
    role: 'manager',
    dealership_name: dealership,
    primarySite: dealership,
    site: 'South Morang',
    allowedSites: [dealership],
    sites: [dealership],
    active: true,
    passwordHash: await hashPassword('password123'),
  };

  const records = {
    users: [user],
    sessions: [{ _id: createHash('sha256').update(token).digest('hex'), userId: user._id, expiresAt: new Date(Date.now() + 3600000) }],
    deals: [
      {
        _id: dealId,
        stockNumber,
        dealNumber,
        dealership,
        customer_name: 'Rapid Freight Pty Ltd',
        make: 'Hyundai',
        model: 'Tucson HEV',
        rego: '1XY2AB',
        vin: 'KMHJ381GSPU123456',
        status: 'registered',
        contract: {
          id: 'contract-req-1',
          reference: 'CONTRACT-SM29161',
          signed_at: '2026-11-15T00:00:00Z',
          items: [
            'Front & Rear Dash Cam',
            'Darkest Legal Tint',
            'Tailored Carpet Floor Mats',
            'Full Tank Diesel',
            'Ceramic Paint Protection',
          ],
        },
      },
    ],
    vehicles: [
      {
        _id: new ObjectId(),
        stockNumber,
        rooftopName: dealership,
        status: 'In Stock',
        location: 'YARD',
        vehicleLocation: 'YARD',
      },
    ],
    get_ready_forms: [],
    deliveries: [],
    sublet_vendors: [],
    sales_logs: [],
  };

  const db = fixtureDb(records);
  const app = createApp({
    historySources: {},
    services: {},
    database: async () => db,
    inventoryDatabase: async () => db,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        cookie: `booran_session=${token}`,
        'content-type': 'application/json',
        ...options.headers,
      },
    });
    const body = await response.json();
    return { status: response.status, body };
  };

  // 1. Submit Get Ready Form with valid + 1 uncontracted item (Towbar)
  const submitRes = await request('/deliveries/get-ready', {
    method: 'POST',
    body: JSON.stringify({
      deal_id: String(dealId),
      deal_number: dealNumber,
      stock_number: stockNumber,
      customer_name: 'Rapid Freight Pty Ltd',
      vehicle: {
        make: 'Hyundai',
        model: 'Tucson HEV',
        variant: 'Highlander',
        colour: 'Amazon Grey',
        rego: '1XY2AB',
        vin: 'KMHJ381GSPU123456',
      },
      delivery_date: '2026-11-25',
      delivery_time: '10:00 AM',
      delivery_day: 'Wednesday',
      salesman: 'John Smith',
      finance_approval: 'Yes',
      vehicle_locate: 'HOLDING YARD',
      plastics_stripped: true,
      mechanical_pd: true,
      detail_vehicle: true,
      rwc_required: false,
      diesel_required: true,
      floor_mats: 'Carpet',
      is_fleet: true,
      fleet_company: 'SG Fleet',
      requested_items: [
        'Front & Rear Dash Cam',
        'Darkest Legal Tint',
        'Heavy Duty Towbar', // NOT on contract!
      ],
      dealership,
    }),
  });

  assert.equal(submitRes.status, 201);
  const getReadyId = submitRes.body.data._id;
  assert.ok(getReadyId);
  assert.equal(submitRes.body.data.status, 'submitted');
  assert.equal(submitRes.body.data.is_fleet, true);
  assert.equal(submitRes.body.data.fleet_company, 'SG Fleet');

  // 2. Validate Contract vs Get Ready - Towbar MUST be rejected and flagged
  const valRes = await request(`/deliveries/get-ready/${getReadyId}/validate`, {
    method: 'POST',
  });
  assert.equal(valRes.status, 200);
  assert.equal(valRes.body.data.status, 'mismatch_blocked');
  assert.equal(valRes.body.data.validation.isValid, false);
  assert.deepEqual(valRes.body.data.validation.matchedItems, [
    'Front & Rear Dash Cam',
    'Darkest Legal Tint',
  ]);
  assert.deepEqual(valRes.body.data.validation.rejectedItems, ['Heavy Duty Towbar']);

  // 3. Attempting to Raise RO with uncontracted item (Towbar) MUST fail with 409
  const badRoRes = await request(`/deliveries/get-ready/${getReadyId}/raise-ro`, {
    method: 'POST',
    body: JSON.stringify({
      ro_number: 'RO-99881',
      delivery_date: '2026-11-25',
      delivery_time: '10:00 AM',
      delivery_day: 'Wednesday',
      items: ['Front & Rear Dash Cam', 'Heavy Duty Towbar'],
    }),
  });
  assert.equal(badRoRes.status, 409);
  assert.match(badRoRes.body.error, /Heavy Duty Towbar.*not on the signed contract/i);

  // 4. Raise RO with ONLY validated contract items MUST succeed
  const goodRoRes = await request(`/deliveries/get-ready/${getReadyId}/raise-ro`, {
    method: 'POST',
    body: JSON.stringify({
      ro_number: 'RO-99881',
      delivery_date: '2026-11-25',
      delivery_time: '10:00 AM',
      delivery_day: 'Wednesday',
      items: ['Front & Rear Dash Cam', 'Darkest Legal Tint'],
    }),
  });
  assert.equal(goodRoRes.status, 200);
  assert.equal(goodRoRes.body.data.status, 'ro_raised');
  assert.equal(goodRoRes.body.data.ro_number, 'RO-99881');

  // Verify Sales Log update (Section 8)
  const salesLog = goodRoRes.body.sales_log;
  assert.equal(salesLog.vehicle_location, 'BOOKED');
  assert.equal(salesLog.ro_number, 'RO-99881');
  assert.equal(salesLog.delivery_date, '2026-11-25');
  assert.equal(salesLog.delivery_time, '10:00 AM');
  assert.equal(salesLog.diesel, 'Required');
  assert.equal(salesLog.tint, 'Required');
  assert.equal(salesLog.is_fleet, true);

  // Verify inventory vehicle location updated to BOOKED
  const updatedVehicle = records.vehicles.find(v => v.stockNumber === stockNumber);
  assert.equal(updatedVehicle.vehicleLocation, 'BOOKED');
  assert.equal(updatedVehicle.location, 'BOOKED');
  assert.equal(updatedVehicle.roNumber, 'RO-99881');

  // 5. Sublet Vendors list & default seeding
  const vendorsRes = await request('/deliveries/sublets/vendors');
  assert.equal(vendorsRes.status, 200);
  assert.ok(vendorsRes.body.data.some(v => v.name === 'Auto You'));
  assert.ok(vendorsRes.body.data.some(v => v.name === 'AutoXtreme (Motor One)'));

  // Add custom vendor (e.g. for BYD Shark)
  const newVendorRes = await request('/deliveries/sublets/vendors', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Opposite Lock (BYD Suspension)',
      category: 'Suspension & Bullbars',
      contact_method: 'email',
      email: 'fleet@oppositelock.com.au',
      phone: '03 9888 1111',
      instructions: 'Contact for BYD Shark canopy and suspension booking',
      supported_brands: ['BYD'],
      dealership,
    }),
  });
  assert.equal(newVendorRes.status, 201);

  // 6. Assign Sublet Job (Auto You Dash Cam)
  const subletRes = await request(`/deliveries/get-ready/${getReadyId}/sublets`, {
    method: 'POST',
    body: JSON.stringify({
      item: 'Front & Rear Dash Cam',
      vendor_name: 'Auto You',
      sublet_number: 'SUB-44101',
      booking_method: 'email',
      notes: 'Customer requires hardwired parking mode enabled',
    }),
  });
  assert.equal(subletRes.status, 201);
  const subletId = subletRes.body.data.id;

  // 7. Auto You Email Draft generation
  const emailRes = await request(`/deliveries/get-ready/${getReadyId}/sublets/${subletId}/email-draft`);
  assert.equal(emailRes.status, 200);
  assert.equal(emailRes.body.data.to, 'bookings@autoyou.com.au');
  assert.match(emailRes.body.data.subject, /Sublet Booking.*SUB-44101/);
  assert.match(emailRes.body.data.body, /KMHJ381GSPU123456/);
  assert.match(emailRes.body.data.body, /Front & Rear Dash Cam/);

  // 8. Parts Dispatch / Printable RO Sheet
  const sheetRes = await request(`/deliveries/get-ready/${getReadyId}/ro-sheet`);
  assert.equal(sheetRes.status, 200);
  assert.equal(sheetRes.body.data.ro_number, 'RO-99881');
  assert.equal(sheetRes.body.data.deal.is_fleet, true);

  const dispatchRes = await request(`/deliveries/get-ready/${getReadyId}/parts-dispatch`, { method: 'POST' });
  assert.equal(dispatchRes.status, 200);
  assert.ok(dispatchRes.body.data.parts_dispatched_at);

  // 9. Detailer Completion Sign-Off
  const detailRes = await request(`/deliveries/get-ready/${getReadyId}/detail-complete`, {
    method: 'POST',
    body: JSON.stringify({
      detailer_name: 'Dave Miller',
      completion_date: '2026-11-24',
    }),
  });
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.body.data.status, 'ready');
  assert.equal(detailRes.body.data.completed_by.name, 'Dave Miller');

  // 10. Query Sales Log API
  const salesLogListRes = await request('/deliveries/sales-log');
  assert.equal(salesLogListRes.status, 200);
  assert.equal(salesLogListRes.body.data.length, 1);
  assert.equal(salesLogListRes.body.data[0].vehicle_location, 'BOOKED');
  assert.equal(salesLogListRes.body.data[0].ro_number, 'RO-99881');
});
