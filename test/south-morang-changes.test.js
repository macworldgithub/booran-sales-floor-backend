const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { createHash } = require('node:crypto');
const { sendLostFinalSms, DEFAULT_TEMPLATE, renderLostFinalSms } = require('../lib/lost-lead-sms');
const {
  syncSmsCampaign,
  stageStatus,
  isClosedStage,
  isPostDeliveryProspect,
  isWebsiteLeadSource,
  isNextgateLeadSource,
} = require('../lib/sms-campaign-sync');
const { emailLead } = require('../lib/inbound-lead-email');
const { leadQuery } = require('../lib/query');
const { dailyTraffic } = require('../lib/daily-traffic');
const { salesEvents } = require('../lib/dp/sales');

function memoryDb(seed = {}) {
  const collections = new Map();
  const matchesFilter = (doc, query = {}) => {
    for (const [key, cond] of Object.entries(query)) {
      if (key === '$or') {
        if (!cond.some(part => matchesFilter(doc, part))) return false;
        continue;
      }
      if (key === '$and') {
        if (!cond.every(part => matchesFilter(doc, part))) return false;
        continue;
      }
      if (key === '$nor') {
        if (cond.some(part => matchesFilter(doc, part))) return false;
        continue;
      }
      const val = key.split('.').reduce((acc, part) => acc?.[part], doc);
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof ObjectId) && !(cond instanceof Date) && !(cond instanceof RegExp)) {
        if ('$exists' in cond) { if (Boolean(val !== undefined) !== cond.$exists) return false; }
        if ('$in' in cond) {
          const ok = cond.$in.some(item => String(item) === String(val) || (item === null && (val === null || val === undefined)));
          if (!ok) return false;
        }
        if ('$nin' in cond) {
          if (cond.$nin.some(item => String(item) === String(val))) return false;
        }
        if ('$ne' in cond) {
          if (val === cond.$ne || (cond.$ne instanceof ObjectId && String(val) === String(cond.$ne))) return false;
        }
        if ('$lte' in cond) { if (!(val <= cond.$lte)) return false; }
        if ('$regex' in cond) {
          const rx = new RegExp(cond.$regex, cond.$options || '');
          if (!rx.test(String(val || ''))) return false;
        }
      } else if (cond instanceof ObjectId) {
        if (String(val) !== String(cond)) return false;
      } else if (cond === null) {
        if (val !== null && val !== undefined) return false;
      } else {
        if (val !== cond) return false;
      }
    }
    return true;
  };
  const applyUpdate = (doc, update) => {
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) {
        const parts = k.split('.');
        let cur = doc;
        for (const p of parts.slice(0, -1)) cur = cur[p] ||= {};
        cur[parts.at(-1)] = v;
      }
    }
    if (update.$setOnInsert && !doc.__existing) {
      for (const [k, v] of Object.entries(update.$setOnInsert)) {
        if (doc[k] === undefined) doc[k] = v;
      }
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
    }
    if (update.$addToSet) {
      for (const [k, v] of Object.entries(update.$addToSet)) {
        doc[k] ||= [];
        const items = v && v.$each ? v.$each : [v];
        for (const item of items) {
          if (!doc[k].some(x => JSON.stringify(x) === JSON.stringify(item))) doc[k].push(item);
        }
      }
    }
    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        doc[k] ||= [];
        doc[k].push(v);
      }
    }
    delete doc.__existing;
  };
  const getCol = name => {
    if (!collections.has(name)) collections.set(name, []);
    const rows = collections.get(name);
    return {
      rows,
      find(query = {}) {
        let filtered = rows.filter(r => matchesFilter(r, query));
        return {
          sort() { return this; },
          limit(n) { filtered = filtered.slice(0, n); return this; },
          async toArray() { return filtered; },
        };
      },
      async findOne(query = {}) {
        return rows.find(r => matchesFilter(r, query)) || null;
      },
      async insertOne(doc) {
        if (doc._id && rows.some(r => String(r._id) === String(doc._id))) {
          throw Object.assign(new Error('dup'), { code: 11000 });
        }
        const saved = { ...doc, _id: doc._id || new ObjectId() };
        rows.push(saved);
        return { insertedId: saved._id };
      },
      async updateOne(filter, update) {
        const doc = rows.find(r => matchesFilter(r, filter));
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        doc.__existing = true;
        applyUpdate(doc, update);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async updateMany(filter, update) {
        let count = 0;
        for (const doc of rows) {
          if (matchesFilter(doc, filter)) {
            doc.__existing = true;
            applyUpdate(doc, update);
            count++;
          }
        }
        return { matchedCount: count, modifiedCount: count };
      },
      async findOneAndUpdate(filter, update, opts = {}) {
        let doc = rows.find(r => matchesFilter(r, filter));
        if (!doc && opts.upsert) {
          doc = { _id: filter._id || new ObjectId() };
          rows.push(doc);
        } else if (!doc) {
          return null;
        } else {
          doc.__existing = true;
        }
        applyUpdate(doc, update);
        return doc;
      },
      async bulkWrite(ops = []) {
        let upsertedCount = 0;
        let modifiedCount = 0;
        for (const op of ops) {
          const { filter, update, upsert } = op.updateOne;
          let doc = rows.find(r => matchesFilter(r, filter));
          if (!doc && upsert) {
            doc = { _id: filter._id || new ObjectId() };
            rows.push(doc);
            applyUpdate(doc, update);
            upsertedCount++;
          } else if (doc) {
            doc.__existing = true;
            applyUpdate(doc, update);
            modifiedCount++;
          }
        }
        return { upsertedCount, modifiedCount };
      },
      aggregate() {
        return { async toArray() { return []; } };
      },
    };
  };
  for (const [k, v] of Object.entries(seed)) getCol(k).rows.push(...v);
  return {
    collection: getCol,
    client: {
      withSession: async fn => fn({ withTransaction: async op => op() }),
    },
  };
}

test('sendLostFinalSms sends automated SMS once, logs diary, and respects opt-out and skip switches', async () => {
  const sent = [];
  const mockSms = {
    configured: () => true,
    normalisePhone: p => p,
    sendSms: async payload => {
      sent.push(payload);
      return { status: 'queued', provider_message_id: `mm-${sent.length}` };
    },
  };
  const db = memoryDb({
    leads: [
      { _id: new ObjectId(), customer_name: 'Alice Buyer', customer_phone: '+61412345678', dealership_name: 'South Morang Hyundai', diary_entries: [] },
      { _id: new ObjectId(), customer_name: 'Opted Out', customer_phone: '+61412345679', dealership_name: 'South Morang Hyundai', booran_opted_out: true, diary_entries: [] },
      { _id: new ObjectId(), customer_name: 'No Mobile', customer_phone: '', dealership_name: 'South Morang Hyundai', diary_entries: [] },
    ],
  });
  const manager = { id: 'mgr-1', name: 'Quoc Truong', role: 'sales_manager' };
  const [alice, optedOut, noPhone] = db.collection('leads').rows;

  const outcome = await sendLostFinalSms(db, alice, manager, mockSms, { reviewId: 'rev-1' });
  assert.equal(outcome.status, 'queued');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.includes('South Morang Hyundai'));
  assert.equal(db.collection('customer_messages').rows.length, 1);
  assert.equal(alice.lost_final_sms.status, 'queued');
  assert.ok(alice.diary_entries.some(d => d.note.includes('Final Lost SMS queued')));

  // Idempotent replay with same reviewId
  const replay = await sendLostFinalSms(db, alice, manager, mockSms, { reviewId: 'rev-1' });
  assert.equal(replay.duplicate, true);
  assert.equal(sent.length, 1);

  // Respects opt-out, missing phone, and explicit disable switch
  assert.equal((await sendLostFinalSms(db, optedOut, manager, mockSms, { reviewId: 'rev-2' })).reason, 'opted_out');
  assert.equal((await sendLostFinalSms(db, noPhone, manager, mockSms, { reviewId: 'rev-3' })).reason, 'no_mobile');
  assert.equal((await sendLostFinalSms(db, alice, manager, mockSms, { reviewId: 'rev-4', sendFinalSms: false })).reason, 'disabled_by_manager');
  assert.equal(sent.length, 1);

  assert.ok(renderLostFinalSms(DEFAULT_TEMPLATE, alice, manager.name).includes('South Morang Hyundai'));
});

test('DealerSocket post-delivery stages, sold customers without phone/email, and website filters work correctly', async () => {
  assert.equal(stageStatus('Deal'), 'sold');
  assert.equal(stageStatus('6 - Deal'), 'sold');
  assert.equal(stageStatus('Delivered'), 'sold');
  assert.equal(stageStatus('Post Delivery'), 'sold');
  assert.equal(isClosedStage('Deal'), true);
  assert.equal(isPostDeliveryProspect({ status: '6 - Deal' }), true);
  assert.equal(isPostDeliveryProspect({ dealerSocketSnapshot: { record: { opportunity_type: 'Service' } } }), true);
  assert.equal(isNextgateLeadSource({ name: 'CARSALESCONNECT PROSPECT No_Last_Name' }), true);
  assert.equal(isWebsiteLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'southmoranghyundai.com.au' } } }), true);
  assert.equal(isWebsiteLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Walk In' } } }), false);

  const site = 'South Morang Hyundai';
  const khanId = new ObjectId();
  const existingSoldId = new ObjectId(createHash('sha256').update('DEALERSOCKET-10876-162998').digest('hex').slice(0, 24));
  const target = memoryDb({
    users: [{ _id: khanId, name: 'Khan Cetin', role: 'sales_consultant', site, active: true }],
    leads: [
      {
        _id: existingSoldId,
        deal_id: 'DEALERSOCKET-10876-162998',
        dealership_name: site,
        source: 'DealerSocket',
        customer_name: 'Robin Trickett',
        status: 'sold',
        sold_at: '2026-11-14T02:00:00.000Z',
        assigned_at: new Date('2026-11-14T02:00:00.000Z'),
        owner_id: String(khanId),
        owner_name: 'Khan Cetin',
        booran_edited_fields: ['status', 'sold_at'],
        diary_entries: [],
      },
      {
        _id: new ObjectId(),
        dealership_name: site,
        source: 'Manual',
        customer_name: 'Existing Delivered Customer',
        status: 'sold',
        sold_at: '2026-11-10T02:00:00.000Z',
        created_at: '2026-11-05T02:00:00.000Z',
        diary_entries: [],
      },
    ],
    integration_sync: [
      {
        _id: 'lead-source-filters:south morang hyundai',
        kind: 'lead_source_filters',
        dealership: site,
        skipDealerSocketNextgateLeads: true,
        skipDealerSocketWebsiteLeads: true,
      },
    ],
  });

  const nowIso = '2026-11-25T06:00:00.000Z';
  const source = memoryDb({
    south_morang_prospects: [
      // Existing sold customer Robin Trickett still in Deal stage -> must NOT re-assign/stamp assigned_at today
      { id: '162998', contactId: '55989', site: '10876', franchise: 'South Morang Hyundai Used Cars', name: 'Robin Trickett', status: 'Deal', assignee: 'Cetin', capturedAt: nowIso },
      // Brand new DealerSocket row already in Deal / Post-Delivery -> must NOT create a new lead
      { id: '999001', contactId: '88001', site: '10876', franchise: 'South Morang Hyundai', name: 'Brand New Post Delivery', status: '6 - Deal', assignee: 'Cetin', capturedAt: nowIso },
      // Post-delivery / new prospect with no phone/email matching existing sold customer by name -> link source_refs, no duplicate
      { id: '999002', contactId: '88002', site: '10876', franchise: 'South Morang Hyundai', name: 'Existing Delivered Customer', status: 'Up/Contacted', assignee: 'Cetin', capturedAt: nowIso },
      // Website lead when skipDealerSocketWebsiteLeads is true -> skipped
      { id: '999003', contactId: '88003', site: '10876', franchise: 'South Morang Hyundai', name: 'Web Lead Customer', status: 'Unqualified', capturedAt: nowIso, dealerSocketSnapshot: { record: { lead_source: 'southmoranghyundai.com.au' } } },
      // Regular Walk In lead -> MUST STILL IMPORT
      { id: '999004', contactId: '88004', site: '10876', franchise: 'South Morang Hyundai', name: 'Real Walk In', status: 'Up/Contacted', assignee: 'Cetin', capturedAt: nowIso, dealerSocketSnapshot: { record: { lead_source: 'Walk In' } } },
    ],
  });

  const res = await syncSmsCampaign(target, source, new Date(nowIso));
  assert.equal(res.opportunities.status, 'fulfilled');

  const leads = target.collection('leads').rows;
  assert.equal(leads.some(l => l.customer_name === 'Brand New Post Delivery'), false);
  assert.equal(leads.some(l => l.customer_name === 'Web Lead Customer'), false);
  assert.equal(leads.filter(l => l.customer_name === 'Existing Delivered Customer').length, 1);
  assert.ok(leads.find(l => l.customer_name === 'Existing Delivered Customer').source_refs.some(r => r.deal_id === 'DEALERSOCKET-10876-999002'));

  const walkIn = leads.find(l => l.customer_name === 'Real Walk In');
  assert.ok(walkIn, 'Walk-In DealerSocket leads must continue to import');
  assert.equal(walkIn.owner_name, 'Khan Cetin');

  const robin = leads.find(l => l.customer_name === 'Robin Trickett');
  assert.equal(robin.assigned_at.toISOString(), '2026-11-14T02:00:00.000Z');
  assert.equal(robin.sms_campaign.active, false);
});

test('corrected sold_at moves sale out of today in dailyTraffic and dp sales, and emailLead parses HTML fallback', () => {
  const repId = new ObjectId();
  const lead = {
    _id: new ObjectId(),
    dealership_name: 'South Morang Hyundai',
    customer_name: 'Thomas Roberts',
    status: 'sold',
    owner_id: String(repId),
    owner_name: 'Khan Cetin',
    created_at: '2026-11-12T00:00:00.000Z',
    sold_at: '2026-10-30T02:00:00.000Z',
    booran_edited_fields: ['status', 'sold_at'],
    // Stage history originally recorded today when Megan clicked SOLD before correcting the date
    stage_history: [{ from: 'following_up', to: 'sold', at: '2026-11-25T00:53:44.000Z', by: 'mgr' }],
  };
  const now = new Date('2026-11-25T05:00:00.000Z');
  const trafficToday = dailyTraffic({
    leads: [lead],
    tasks: [],
    deals: [],
    media: [],
    messages: [],
    appointments: [],
    staff: [{ _id: repId, name: 'Khan Cetin', role: 'sales_consultant', site: 'South Morang Hyundai' }],
  }, '2026-11-25', now);
  assert.equal(trafficToday.summary.counts.sales, 0, 'Backdated sale should not count under today');

  const events = salesEvents({ leads: [lead], deals: [], feedSales: [], vehicles: [] }, now);
  assert.equal(events.length, 1);
  assert.equal(events[0].at, '2026-10-30T02:00:00.000Z');

  // HTML-only inbound website email parsing
  const parsed = emailLead('new', {
    messageId: '<html-only-1@example.com>',
    subject: 'New Website Enquiry',
    html: '<div><p>Customer name: Jane Website</p><p>Mobile: 0412 999 888</p><p>Email: jane@example.com</p><p>Vehicle model: 2026 Hyundai Tucson</p></div>',
    date: '2026-11-25T01:00:00Z',
  });
  assert.equal(parsed.customer_name, 'Jane Website');
  assert.equal(parsed.customer_phone, '+61412999888');
  assert.equal(parsed.customer_email, 'jane@example.com');

  // missingContact query check
  const q = leadQuery({ missingContact: 'true' });
  assert.ok(q.$and.some(c => c.customer_phone?.$in?.includes('')));
});

test('DealerSocket sync retires active:false prospects, widens Nextgate name window, and auto-merges stored partials once details arrive', async () => {
  const site = 'South Morang Hyundai';
  const retiredId = new ObjectId(createHash('sha256').update('DEALERSOCKET-10876-700001').digest('hex').slice(0, 24));
  const storedPartialId = new ObjectId(createHash('sha256').update('DEALERSOCKET-10876-700002').digest('hex').slice(0, 24));
  const inboundPrimaryId = new ObjectId();
  const oldNextgateId = new ObjectId();

  const target = memoryDb({
    leads: [
      {
        _id: retiredId,
        deal_id: 'DEALERSOCKET-10876-700001',
        dealership_name: site,
        source: 'DealerSocket',
        customer_name: 'Retired Prospect',
        status: 'new_lead',
        sms_campaign: { active: true, channel: 'SMS Campaign', snapshot_at: '2026-11-20T00:00:00.000Z' },
        diary_entries: [],
      },
      {
        _id: storedPartialId,
        deal_id: 'DEALERSOCKET-10876-700002',
        dealership_name: site,
        source: 'DealerSocket',
        customer_name: 'Jordan Partial',
        customer_phone: '',
        customer_email: '',
        status: 'new_lead',
        sms_campaign: { active: true, channel: 'SMS Campaign', snapshot_at: '2026-11-24T00:00:00.000Z' },
        diary_entries: [],
      },
      {
        _id: inboundPrimaryId,
        dealership_name: site,
        source: 'Inbound Email',
        customer_name: 'Jordan Partial',
        customer_phone: '+61411222333',
        customer_email: 'jordan.partial@example.com',
        status: 'following_up',
        created_at: '2026-11-20T02:00:00.000Z',
        diary_entries: [],
      },
      {
        _id: oldNextgateId,
        dealership_name: site,
        source: 'Nextgate',
        customer_name: 'Older Nextgate Lead',
        customer_phone: '+61499888777',
        status: 'following_up',
        created_at: '2026-09-20T02:00:00.000Z',
        diary_entries: [],
      },
    ],
    integration_sync: [
      {
        _id: 'lead-source-filters:south morang hyundai',
        kind: 'lead_source_filters',
        dealership: site,
        skipDealerSocketNextgateLeads: true,
        skipDealerSocketWebsiteLeads: false,
      },
    ],
  });

  const nowIso = '2026-11-25T06:00:00.000Z';
  const source = memoryDb({
    south_morang_prospects: [
      // Retired in DealerSocket -> must not stay active
      { id: '700001', contactId: '89001', site: '10876', franchise: 'South Morang Hyundai', name: 'Retired Prospect', status: 'Unqualified', active: false, capturedAt: nowIso },
      // Stored partial now has phone in dealerSocketSnapshot.record -> auto-merges into Inbound Email primary
      {
        id: '700002',
        contactId: '89002',
        site: '10876',
        franchise: 'South Morang Hyundai',
        name: 'Jordan Partial',
        status: 'Up/Contacted',
        active: true,
        capturedAt: nowIso,
        dealerSocketSnapshot: { record: { customer_phone_raw: '0411 222 333', customer_email_raw: 'jordan.partial@example.com' } },
      },
      // Partial DealerSocket copy of a 66-day-old Nextgate lead matched by name within 90 days -> suppressed & linked
      { id: '700003', contactId: '89003', site: '10876', franchise: 'South Morang Hyundai', name: 'Older Nextgate Lead', status: 'Up/Contacted', active: true, capturedAt: nowIso },
    ],
  });

  const res = await syncSmsCampaign(target, source, new Date(nowIso));
  assert.equal(res.opportunities.status, 'fulfilled');

  const leads = target.collection('leads').rows;
  const retired = leads.find(l => l.deal_id === 'DEALERSOCKET-10876-700001');
  assert.equal(retired.sms_campaign.active, false);

  const partial = leads.find(l => l.deal_id === 'DEALERSOCKET-10876-700002');
  assert.equal(partial.merged_into, String(inboundPrimaryId));
  assert.equal(partial.sms_campaign.active, false);
  assert.equal(partial.status, 'lost');

  const inboundPrimary = leads.find(l => String(l._id) === String(inboundPrimaryId));
  assert.ok(inboundPrimary.source_refs.some(r => r.deal_id === 'DEALERSOCKET-10876-700002'));

  assert.equal(leads.some(l => l.deal_id === 'DEALERSOCKET-10876-700003'), false);
  const nextgatePrimary = leads.find(l => String(l._id) === String(oldNextgateId));
  assert.ok(nextgatePrimary.source_refs.some(r => r.deal_id === 'DEALERSOCKET-10876-700003'));
});
