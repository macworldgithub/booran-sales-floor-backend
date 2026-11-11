const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createApp } = require('../server');
const { hashPassword } = require('../lib/password');
const { syncSmsCampaign } = require('../lib/sms-campaign-sync');

const read = (record, field) => field.split('.').reduce((value, key) => Array.isArray(value) ? value.flatMap(item => item?.[key] === undefined ? [] : item[key]) : value?.[key], record);

test('co-located integration state keeps logical ID namespaces, scoped manager reads and Nextgate checkpoints separate', async () => {
  const { withLeadState } = require('../lib/lead-state');
  const { scopedDatabase } = require('../lib/access');
  const records = { nexgate_sync: [{ _id: 'seller-checkpoint', last_success: new Date() }] };
  const db = withLeadState(fixtureDb(records), 'nexgate_sync');
  const site = 'South Morang Hyundai';
  for (const kind of ['lead_mobile_keys', 'lead_merge_requests', 'lead_source_links', 'lead_email_receipts', 'integration_sync']) {
    await db.collection(kind).findOneAndUpdate({ _id: 'shared-key' }, { $set: { dealership: site, status: 'open' } }, { upsert: true });
    assert.equal((await db.collection(kind).findOne({ _id: 'shared-key' }))._id, 'shared-key');
    assert.equal(await db.collection(kind).countDocuments({}), 1);
  }
  assert.equal(records.nexgate_sync.length, 6);
  const scoped = scopedDatabase(db, { id: 'manager', role: 'manager', site });
  assert.equal((await scoped.collection('lead_merge_requests').find({}).sort({ _id: 1 }).limit(5).toArray()).length, 1);
  const denied = scopedDatabase(db, { id: 'manager', role: 'manager', site: 'South Morang Kia' });
  assert.equal(await denied.collection('lead_merge_requests').countDocuments({}), 0);
  await db.collection('lead_source_links').updateMany({ _id: { $in: ['shared-key'] } }, { $set: { lead_id: 'primary' } });
  assert.equal((await db.collection('lead_source_links').findOne({ _id: 'shared-key' })).lead_id, 'primary');
  assert.equal(records.nexgate_sync[0]._id, 'seller-checkpoint');
  assert.equal(records.nexgate_sync[0].lead_id, undefined);
});

test('name and local/international mobile searches find the same scoped customer in both search entry points', async t => {
  const { request, records } = await api(t);
  records.leads[0].customer_name = 'Angela   Pokora';
  records.leads[0].customer_phone = '+61409002310';
  for (const search of ['angela pokora', '0409002310', '0409 002 310', '+61 409 002 310', '61409002310']) {
    assert.deepEqual((await request('/leads?search=' + encodeURIComponent(search))).body.data.map(row => row.id), [String(records.leads[0]._id)]);
    assert.deepEqual((await request('/unified/search?q=' + encodeURIComponent(search))).body.data.leads.map(row => row.id), [String(records.leads[0]._id)]);
  }
  records.leads[2].customer_phone = records.leads[0].customer_phone;
  assert.equal((await request('/leads?search=0409002310')).body.data.length, 1);
  records.leads[0].customer_name = 'Angel Pokora';
  records.leads[0].customer_name_aliases = ['Angela Pokora'];
  for (const search of ['Angel Pokora', 'Angela Pokora']) {
    assert.deepEqual((await request('/unified/search?q=' + encodeURIComponent(search))).body.data.leads.map(row => row.id), [String(records.leads[0]._id)]);
    assert.deepEqual((await request('/leads?search=' + encodeURIComponent(search))).body.data.map(row => row.id), [String(records.leads[0]._id)]);
  }
});

test('duplicate mobiles block create and edit, escalate to managers and do not expose another salesperson customer', async t => {
  const { request, records, user } = await api(t);
  const lead = records.leads[0]; lead.customer_phone = '+61409002310'; lead.owner_id = 'other';
  const input = { name: 'Existing customer', phone: '0409002310', dealership: lead.dealership_name };
  let response = await request('/prospects', { method: 'POST', body: JSON.stringify(input) });
  assert.equal(response.status, 409); assert.equal(response.body.mergeRequested, true);
  assert.equal(response.body.existingLeadId, String(lead._id)); assert.equal(records.leads.length, 3);
  assert.equal((await request('/merge-requests')).body.pagination.total, 1);
  user.role = 'sales_consultant';
  response = await request('/prospects', { method: 'POST', body: JSON.stringify(input) });
  assert.equal(response.status, 409); assert.equal(response.body.existingLeadId, undefined);
  assert.equal((await request('/merge-requests')).status, 403);
  user.role = 'manager';
  records.leads[1].dealership_name = lead.dealership_name;
  response = await request(`/leads/${records.leads[1]._id}`, { method: 'PATCH', body: JSON.stringify({ customer_phone: '0409002310' }) });
  assert.equal(response.status, 409); assert.equal(records.leads[1].customer_phone, undefined);
  assert.equal((await request('/prospects', { method: 'POST', body: JSON.stringify({ ...input, phone: '0412345678' }) })).status, 201, 'walk-ins can be saved before their email is known');
});

test('manager merge transfers missing details, all linked work and notes while retaining primary decisions and SMS idempotency', async t => {
  let sends = 0;
  const { request, records, user } = await api(t, { sms: { sendSms: async () => { sends++; return { status: 'queued' }; } } });
  const primary = records.leads[0]; primary.customer_phone = '+61412345678'; primary.customer_email = ''; primary.owner_id = String(user._id);
  primary.owner_name = user.name; primary.status = 'following_up'; primary.diary_entries = [{ author: 'Primary', date: '2026-11-01', note: 'Primary note' }];
  const secondary = { _id: new ObjectId(), deal_id: 'DEALERSOCKET-10876-fixture', dealership_name: primary.dealership_name,
    customer_name: 'Alice', customer_phone: '0412 345 678', customer_email: 'alice@example.com', status: 'lost', owner_id: 'old-owner',
    source: 'DealerSocket', sms_campaign: { active: true, snapshot_at: '2026-11-11T09:00:00Z' }, notes: 'Secondary description',
    diary_entries: [{ author: 'Secondary', date: '2026-11-02', note: 'Secondary note' }] };
  records.leads.push(secondary);
  const oldId = String(secondary._id), mainId = String(primary._id), site = primary.dealership_name;
  for (const name of ['deals', 'deliveries', 'appraisals', 'sales_alerts']) records[name] = [{ _id: new ObjectId(), lead_id: oldId, dealership: site, owner_id: 'old-owner' }];
  records.sales_tasks = [{ _id: new ObjectId(), lead_id: oldId, dealership: site, status: 'open', assignee_id: 'old-owner' },
    { _id: new ObjectId(), lead_id: oldId, dealership: site, status: 'completed', assignee_id: 'old-owner' }];
  records.appointments = [{ _id: new ObjectId(), leadId: secondary.deal_id, dealership: site }];
  records.message_media = [{ _id: new ObjectId(), lead_id: oldId, dealership_name: site, status: 'ready' }];
  const requestId = '11111111-1111-4111-8111-111111111111';
  records.customer_messages = [{ _id: createHash('sha256').update(`${oldId}:${requestId}`).digest('hex'), lead_id: oldId, dealership_name: site,
    status: 'queued', body: 'Hello', phone: '+61412345678', fingerprint: createHash('sha256').update(JSON.stringify(['Hello', []])).digest('hex') }];
  const result = await request(`/leads/${mainId}/merge`, { method: 'POST', body: JSON.stringify({ duplicateId: oldId }) });
  assert.equal(result.status, 200, result.body.error); assert.equal(result.body.data.email, 'alice@example.com');
  assert.equal(primary.status, 'following_up'); assert.equal(primary.owner_id, String(user._id)); assert.equal(secondary.merged_into, mainId);
  assert.ok(primary.diary_entries.some(row => row.note === 'Primary note'));
  assert.ok(primary.diary_entries.some(row => row.note === 'Secondary note'));
  assert.ok(primary.diary_entries.some(row => row.note === 'Secondary description'));
  for (const name of ['deals', 'deliveries', 'appraisals', 'sales_alerts', 'sales_tasks', 'customer_messages', 'message_media']) assert.ok(records[name].every(row => row.lead_id === mainId));
  assert.equal(records.sales_tasks[0].assignee_id, String(user._id)); assert.equal(records.sales_tasks[1].assignee_id, 'old-owner');
  assert.equal(records.appointments[0].leadId, mainId);
  assert.equal((await request(`/leads/${oldId}`)).body.data.id, mainId);
  assert.equal((await request('/leads?source=DealerSocket')).body.data.length, 1);
  const retried = await request(`/leads/${mainId}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Hello', media_ids: [], request_id: requestId }) });
  assert.equal(retried.status, 200); assert.equal(sends, 0, 'a merge cannot resend an already recorded SMS attempt');
  user.role = 'sales_consultant';
  assert.equal((await request(`/leads/${mainId}/merge`, { method: 'POST', body: JSON.stringify({ duplicateId: oldId }) })).status, 403);
});

test('inbound New and Used email is authenticated, idempotent, unassigned and queues duplicate phones for manager resolution', async t => {
  const saved = process.env.HYUNDAI_INBOUND_EMAIL_SECRET;
  process.env.HYUNDAI_INBOUND_EMAIL_SECRET = 'mail-fixture-secret-'.repeat(3);
  t.after(() => { if (saved === undefined) delete process.env.HYUNDAI_INBOUND_EMAIL_SECRET; else process.env.HYUNDAI_INBOUND_EMAIL_SECRET = saved; });
  const { request, records } = await api(t);
  const input = { messageId: '<fixture-1@example.test>', to: 'SMHYNew@goodshowroom.com', subject: 'Vehicle enquiry',
    text: 'Customer Name: Email Customer\nMobile: 0412 345 678\nEmail: customer@example.com\nVehicle: Tucson' };
  const post = (category, body, authenticated = true) => request('/integrations/inbound-email/' + category, { method: 'POST',
    headers: authenticated ? { authorization: 'Bearer ' + process.env.HYUNDAI_INBOUND_EMAIL_SECRET } : {}, body: JSON.stringify(body) });
  assert.equal((await post('new', input, false)).status, 403);
  assert.equal((await post('new', input)).status, 200);
  assert.equal((await post('new', input)).body.data.replay, true);
  const lead = records.leads.find(row => row.source === 'Inbound Email');
  assert.equal(lead.owner_id, null); assert.equal(lead.status, 'new_lead'); assert.equal(lead.inbound_email.category, 'new');
  assert.equal(lead.customer_email, 'customer@example.com');
  const before = records.leads.length;
  const duplicate = await post('used', { ...input, to: 'SMHYUsed@goodshowroom.com', messageId: '<fixture-2@example.test>' });
  assert.equal(duplicate.body.data.status, 'merge_review'); assert.equal(records.leads.length, before);
  const review = (await request('/merge-requests')).body.data[0];
  const resolved = await request(`/merge-requests/${review.id}/resolve`, { method: 'POST', body: JSON.stringify({ primaryId: String(lead._id), expectedUpdatedAt: review.updatedAt }) });
  assert.equal(resolved.status, 200, resolved.body.error); assert.equal(records.leads.length, before);
  assert.equal((await request('/merge-requests')).body.pagination.total, 0);
  assert.equal((await post('new', { ...input, to: 'outside@example.com' })).status, 400);
});

test('ADF intake is unassigned, uses stable website identity across resends and scopes mailbox receipt counts', async t => {
  const { ingestLeadEmail } = require('../lib/inbound-lead-email');
  const xml = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/hyundai-website-lead.xml'), 'utf8');
  const { request, records } = await api(t);
  const db = fixtureDb(records);
  const first = await ingestLeadEmail(db, 'new', { messageId: '<adf-first@example.test>', text: xml });
  assert.equal(first.status, 'imported');
  const count = records.leads.length;
  const replay = await ingestLeadEmail(db, 'new', { messageId: '<adf-resend@example.test>', text: xml.replace('status="new"', 'status="resend"') });
  assert.equal(replay.replay, true); assert.equal(replay.leadId, first.leadId); assert.equal(records.leads.length, count);
  const review = await ingestLeadEmail(db, 'used', { messageId: '<bad-adf@example.test>', text: xml.replace('</adf>', '') });
  assert.equal(review.status, 'needs_review'); assert.equal(records.leads.length, count);
  const lead = records.leads.find(row => String(row._id) === first.leadId);
  assert.equal(lead.owner_id, null); assert.equal(lead.inbound_email.format, 'adf');
  const listed = await request('/leads?dealership=South%20Morang%20Hyundai&source=Inbound%20Email&assignment=unassigned&status=new_lead');
  assert.equal(listed.body.pagination.total, 1);
  const status = await request('/integrations/lead-status');
  assert.equal(status.body.data.email.find(inbox => inbox.category === 'new').imported, 2);
  assert.equal(status.body.data.email.find(inbox => inbox.category === 'used').needsReview, 1);
});

test('IMAP polling keeps messages unread and continues past malformed XML to an attached valid lead', async () => {
  const { pollLeadEmail } = require('../lib/inbound-lead-email');
  const xml = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/hyundai-website-lead.xml'), 'utf8');
  const mime = [
    'Message-ID: <invalid-adf@example.test>\r\nContent-Type: text/plain\r\n\r\n<adf><prospect>',
    ['Message-ID: <attached-adf@example.test>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="fixture"', '',
      '--fixture', 'Content-Type: text/plain', '', 'Please see the lead attachment.', '--fixture',
      'Content-Type: application/xml; name="lead.xml"', 'Content-Disposition: attachment; filename="lead.xml"', '', xml, '--fixture--', ''].join('\r\n'),
  ];
  const records = {}, client = { mailbox: { uidValidity: 42 }, on() {}, async connect() {}, async logout() {},
    async getMailboxLock(name, options) { assert.equal(name, 'INBOX'); assert.deepEqual(options, { readOnly: true }); return { release() {} }; }, async search() { return [1, 2]; },
    async fetchOne(uid, fields, options) { assert.deepEqual(options, { uid: true }); assert.equal(fields.markSeen, undefined);
      return fields.size ? { size: mime[uid - 1].length } : { source: Buffer.from(mime[uid - 1]) }; },
  };
  await pollLeadEmail(fixtureDb(records), { HYUNDAI_INBOUND_NEW_PASSWORD: 'fixture-only' }, () => client);
  assert.equal(records.leads.length, 1); assert.equal(records.leads[0].customer_name, 'Test User');
  assert.equal(records.lead_email_receipts.length, 2);
  assert.equal(records.lead_email_receipts.find(row => row.status === 'needs_review').address, 'SMHYNew@goodshowroom.com');
  assert.equal(records.integration_sync[0].last_uid, 2); assert.equal(records.integration_sync[0].error, null);
});

test('merging different mobiles retains both search identities and prevents either mobile being recreated', async t => {
  const { request, records } = await api(t);
  const primary = records.leads[0]; primary.customer_phone = '+61412345678';
  const secondary = { _id: new ObjectId(), dealership_name: primary.dealership_name, customer_name: 'Same customer', customer_phone: '+61499999999' };
  records.leads.push(secondary);
  const path = `/leads/${primary._id}/merge`;
  assert.equal((await request(path, { method: 'POST', body: JSON.stringify({ duplicateId: String(secondary._id) }) })).status, 409);
  assert.equal((await request(path, { method: 'POST', body: JSON.stringify({ duplicateId: String(secondary._id), confirmSameCustomer: true }) })).status, 200);
  assert.deepEqual(primary.alternate_phones, ['+61499999999']);
  assert.deepEqual((await request('/leads?search=0499999999')).body.data.map(row => row.id), [String(primary._id)]);
  assert.equal((await request('/prospects', { method: 'POST', body: JSON.stringify({ name: 'Attempted duplicate', phone: '0499999999', dealership: primary.dealership_name }) })).status, 409);
  const review = (await request('/merge-requests')).body.data[0];
  const resolved = await request(`/merge-requests/${review.id}/resolve`, { method: 'POST', body: JSON.stringify({ primaryId: String(primary._id), expectedUpdatedAt: review.updatedAt }) });
  assert.equal(resolved.status, 200, 'manager reviews must also accept an alternate mobile previously confirmed on the primary: ' + resolved.body.error);
  assert.equal(resolved.body.data.id, String(primary._id));
});

test('resolving a mobile-edit collision retires the existing secondary instead of leaving two live customers', async t => {
  const { request, records } = await api(t);
  const primary = records.leads[0]; primary.customer_phone = '+61412345678';
  const secondary = { _id: new ObjectId(), dealership_name: primary.dealership_name, customer_name: 'Same customer', customer_phone: '+61499999999', notes: 'Keep this history' };
  records.leads.push(secondary);
  assert.equal((await request(`/leads/${secondary._id}`, { method: 'PATCH', body: JSON.stringify({ customer_phone: '0412345678' }) })).status, 409);
  const review = (await request('/merge-requests')).body.data[0];
  const result = await request(`/merge-requests/${review.id}/resolve`, { method: 'POST', body: JSON.stringify({ primaryId: String(primary._id), expectedUpdatedAt: review.updatedAt }) });
  assert.equal(result.status, 200, result.body.error);
  assert.equal(secondary.merged_into, String(primary._id));
  assert.ok(primary.diary_entries.some(row => row.note === 'Keep this history'));
  assert.deepEqual(primary.alternate_phones, ['+61499999999']);
});

test('MongoDB videos uploaded before per-file chunk sizes remain readable across their legacy boundary', async () => {
  const { createMongoMediaStorage } = require('../lib/mongo-media-storage');
  const records = {}, storage = createMongoMediaStorage(async () => fixtureDb(records));
  const media = { _id: new ObjectId(), size: 2 * 1024 * 1024 + 4 };
  const bytes = Buffer.alloc(media.size, 8); bytes[media.size - 1] = 9;
  await storage.uploadChunk(media, 0, bytes.subarray(0, 2 * 1024 * 1024));
  await storage.uploadChunk(media, 2 * 1024 * 1024, bytes.subarray(2 * 1024 * 1024));
  await storage.complete(media);
  assert.deepEqual(await storage.readRange(media, 2 * 1024 * 1024 - 2, media.size - 1), bytes.subarray(2 * 1024 * 1024 - 2));
});

test('numeric DealerSocket IDs and numbered stages import verified email and protect it on empty source replays', async () => {
  const records = {}, sourceRecords = { south_morang_prospects: [{ id: 801, contactId: 902, site: 10876, franchise: 'South Morang Hyundai New Cars',
    name: 'Fixture Customer', status: '0 - Unqualified', capturedAt: '2026-11-12T00:00:00Z' }],
    contacts: [{ dealerSocketContactId: 902, firstName: 'Fixture', lastName: 'Customer', mobile: '0412345678', email: 'fixture@example.test' }] };
  const target = fixtureDb(records), source = fixtureDb(sourceRecords);
  let result = await syncSmsCampaign(target, source);
  assert.equal(result.opportunities.status, 'fulfilled', result.opportunities.reason?.message);
  const lead = records.leads[0];
  assert.equal(lead.status, 'new_lead'); assert.equal(lead.customer_email, 'fixture@example.test');
  assert.equal(lead.customer_phone, '+61412345678');
  sourceRecords.contacts[0].email = '';
  sourceRecords.south_morang_prospects[0].status = '6 - Sold';
  result = await syncSmsCampaign(target, source);
  assert.equal(result.opportunities.status, 'fulfilled', result.opportunities.reason?.message);
  assert.equal(lead.customer_email, 'fixture@example.test'); assert.equal(lead.status, 'sold'); assert.equal(lead.sms_campaign.active, false);
});

test('dashboard queue pages preserve complete totals, pending losses and dealership scope', async t => {
  const { request, records } = await api(t);
  const old = '2026-01-01T01:00:00Z';
  const now = new Date().toISOString();
  records.leads = Array.from({ length: 13 }, (_, index) => ({
    _id: new ObjectId(), customer_name: `Prospect ${index}`, dealership_name: 'South Morang Hyundai',
    status: index === 12 ? 'lost' : 'following_up', created_at: old,
    ...(index === 1 ? { owner_id: String(records.users[0]._id), owner_name: records.users[0].name } : {}),
    ...(index === 2 ? { loss_review: { status: 'pending', reason: 'Review' } } : {}),
    ...(index === 3 ? { last_activity_at: now } : {}),
    ...(index === 5 ? { loss_review: { status: 'approved', reviewed_at: '2099-01-01T00:00:00Z' } } : {}),
    source: 'DealerSocket', sms_campaign: { active: index !== 4, snapshot_at: now },
  }));
  records.leads.push({ _id: new ObjectId(), dealership_name: 'Other', status: 'following_up' });
  const full = (await request('/daily-oversight?rooftop=South%20Morang')).body.data;
  const first = (await request('/daily-oversight?rooftop=South%20Morang&queuePage=1')).body.data;
  assert.deepEqual(first.summary, full.summary);
  assert.deepEqual(first.members, full.members);
  assert.deepEqual(first.losses, full.losses);
  assert.deepEqual(first.dealerSocket, full.dealerSocket);
  assert.equal(first.unassigned.length, 5);
  assert.equal(first.unassignedPagination.total, full.unassigned.length);
  const second = (await request('/daily-oversight?rooftop=South%20Morang&queuePage=2')).body.data;
  assert.equal(second.unassigned.length, 5);
  assert.equal(new Set([...first.unassigned, ...second.unassigned].map(lead => lead.id)).size, 10);
  assert.deepEqual(second.summary, full.summary);
  const beyond = (await request('/daily-oversight?rooftop=South%20Morang&queuePage=999')).body.data;
  assert.equal(beyond.unassigned.length, 0);
  assert.deepEqual(beyond.summary, full.summary);
  records.users[0].role = 'sales_consultant';
  const scoped = (await request('/daily-oversight?queuePage=1')).body.data;
  assert.equal(scoped.unassignedPagination.total, 0);
  assert.equal(scoped.summary.activeProspects, 1);
});

test('incoming replies sync with pagination, exact app correlation, old phone and deduplication', async (t) => {
  let events = [], calls = [];
  const { request, records } = await api(t, { sms: { configured: () => true, listInbound: async options => { calls.push(options); return { results: events.slice(options.offset, options.offset + 1), total: events.length }; } } });
  const lead = records.leads[0];
  lead.customer_phone = '+61400000000';
  const outgoing = { _id: 'app-attempt', lead_id: String(lead._id), dealership_name: lead.dealership_name, phone: '+61412345678', provider_message_id: 'out-1', created_at: '2026-10-01T00:00:00Z', status: 'delivered', body: 'Hello' };
  records.customer_messages = [outgoing];
  const reply = { message_id: 'reply-1', from: '0412 345 678', to: '61499990000', message: 'Yes please', type: 'inbound', received_at: '2026-10-02 01:00:00', original_message_id: 'out-1', original_custom_ref: 'app-attempt' };
  events = [reply, { ...reply, message_id: 'foreign', original_message_id: 'delivery-centre', original_custom_ref: 'foreign' }, { ...reply, message_id: 'wrong-phone', from: '61400000000' }, { ...reply, message_id: 'conflict', original_message_id: 'foreign' }];
  let response = await request(`/leads/${lead._id}/messages`);
  assert.equal(response.status, 200);
  assert.equal(response.body.pagination.total, 2);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].from, '2026-10-01');
  const incoming = response.body.data.messages.find(row => row.direction === 'inbound');
  assert.equal(incoming.body, 'Yes please');
  assert.equal(incoming.status, 'received');
  assert.equal(incoming.source, 'Sales Floor');
  assert.equal(incoming.phone, '+61412345678');
  assert.equal(incoming.created_at, '2026-10-02T01:00:00.000Z');
  assert.equal(lead.diary_entries.length, 1);
  await request(`/leads/${lead._id}/messages`);
  assert.equal(calls.length, 4, 'successful sync is cached');
  lead.sms_inbound_synced_at = '2026-10-01T00:00:00Z';
  await request(`/leads/${lead._id}/messages`);
  assert.equal(records.customer_messages.length, 2);
  assert.equal(lead.diary_entries.length, 1, 'repeated inbox reads do not duplicate diary entries');
  assert.equal((await request(`/leads/${records.leads[2]._id}/messages`)).status, 404);
});

test('inbox outage preserves saved history, reports warning, and retries without advancing sync', async (t) => {
  let fail = true;
  const { request, records } = await api(t, { sms: { configured: () => true, listInbound: async () => { if (fail) throw new Error('provider outage'); return { results: [], total: 0 }; } } });
  const lead = records.leads[0];
  records.customer_messages = [{ _id: 'attempt', lead_id: String(lead._id), dealership_name: lead.dealership_name, phone: '+61412345678', body: 'Saved', status: 'delivered', created_at: '2026-10-01T00:00:00Z' }];
  const result = await request(`/leads/${lead._id}/messages`);
  assert.equal(result.body.data.messages[0].body, 'Saved');
  assert.match(result.body.data.history_warning, /Incoming messages/);
  assert.equal(lead.sms_inbound_synced_at, undefined);
  fail = false;
  assert.equal((await request(`/leads/${lead._id}/messages`)).body.data.history_warning, undefined);
  assert.ok(lead.sms_inbound_synced_at);
});
const equal = (a, b) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a instanceof Date || b instanceof Date ? +new Date(a) === +new Date(b) : a === b;
function evaluate(row, value, variables = {}) {
  if (typeof value === 'string' && value.startsWith('$$')) return read(variables, value.slice(2));
  if (typeof value === 'string' && value.startsWith('$')) return read(row, value.slice(1));
  if (Array.isArray(value)) return value.map(item => evaluate(row, item, variables));
  if (!value || typeof value !== 'object' || value instanceof Date || value instanceof ObjectId) return value;
  const [operator, args] = Object.entries(value)[0] || [];
  const values = () => evaluate(row, args, variables);
  switch (operator) {
    case '$convert': {
      const input = evaluate(row, args.input, variables);
      if (args.to === 'date') return input == null ? args.onNull : Number.isFinite(+new Date(input)) ? new Date(input) : args.onError;
      return ObjectId.isValid(input) ? new ObjectId(input) : args.onError;
    }
    case '$literal': return args;
    case '$eq': { const [a, b] = values(); return equal(a, b); }
    case '$ne': { const [a, b] = values(); return !equal(a, b); }
    case '$gte': { const [a, b] = values(); return a >= b; }
    case '$lt': { const [a, b] = values(); return a < b; }
    case '$in': { const [item, choices] = values(); return choices.some(choice => equal(item, choice)); }
    case '$map': return evaluate(row, args.input, variables).map(item => evaluate(row, args.in, { ...variables, [args.as || 'this']: item }));
    case '$anyElementTrue': return values()[0].some(Boolean);
    case '$and': return values().every(Boolean);
    case '$or': return values().some(Boolean);
    case '$max': return values().filter(item => item != null).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).at(-1) ?? null;
    case '$cond': return evaluate(row, args[evaluate(row, args[0], variables) ? 1 : 2], variables);
    case '$ifNull': { const [item, fallback] = values(); return item ?? fallback; }
    default: return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(row, item, variables)]));
  }
}
function aggregateRows(rows, pipeline, records) {
  let result = rows;
  for (const stage of pipeline) {
    const [operator, specification] = Object.entries(stage)[0];
    switch (operator) {
      case '$match': result = result.filter(row => matches(row, specification)); break;
      case '$set': result = result.map(row => ({ ...row, ...evaluate(row, specification) })); break;
      case '$lookup': result = result.map(row => ({ ...row, [specification.as]:
        (records[specification.from] || []).filter(other => equal(read(row, specification.localField), read(other, specification.foreignField))) })); break;
      case '$unwind': {
        const field = specification.slice(1);
        result = result.flatMap(row => (read(row, field) || []).map(item => ({ ...row, [field]: item })));
        break;
      }
      case '$replaceRoot': result = result.map(row => evaluate(row, specification.newRoot)); break;
      case '$project': result = result.map(row => Object.fromEntries(Object.entries(specification)
        .filter(([key, include]) => include && read(row, key) !== undefined).map(([key]) => [key, read(row, key)]))); break;
      case '$facet': result = [Object.fromEntries(Object.entries(specification)
        .map(([key, stages]) => [key, aggregateRows(result, stages, records)]))]; break;
      case '$count': result = result.length ? [{ [specification]: result.length }] : []; break;
      case '$limit': result = result.slice(0, specification); break;
      case '$skip': result = result.slice(specification); break;
      case '$sort': result = [...result].sort((a, b) => {
        for (const [field, direction] of Object.entries(specification)) {
          if (read(a, field) < read(b, field)) return -direction;
          if (read(a, field) > read(b, field)) return direction;
        }
        return 0;
      }); break;
      case '$group': {
        const groups = new Map();
        for (const row of result) {
          const id = evaluate(row, specification._id) ?? null;
          const key = JSON.stringify(id);
          if (!groups.has(key)) groups.set(key, { row: { _id: id }, averages: {} });
          const group = groups.get(key);
          for (const [field, accumulator] of Object.entries(specification)) {
            if (field === '_id') continue;
            const [operation, input] = Object.entries(accumulator)[0];
            const value = evaluate(row, input);
            if (operation === '$first' && !Object.hasOwn(group.row, field)) group.row[field] = value;
            else if (operation === '$sum') group.row[field] = (group.row[field] || 0) + (typeof value === 'number' ? value : 0);
            else if (operation === '$max' && (group.row[field] == null || value > group.row[field])) group.row[field] = value;
            else if (operation === '$avg' && typeof value === 'number') {
              const average = group.averages[field] ||= { sum: 0, count: 0 };
              average.sum += value; average.count++;
            }
          }
        }
        result = [...groups.values()].map(group => ({ ...group.row, ...Object.fromEntries(
          Object.entries(group.averages).map(([field, average]) => [field, average.sum / average.count])) }));
        break;
      }
      default: throw new Error(`Unimplemented fixture aggregation ${operator}`);
    }
  }
  return result;
}

function matches(record, query) {
  return Object.entries(query).every(([field, value]) => {
    if (field === '$and') return value.every((part) => matches(record, part));
    if (field === '$or') return value.some((part) => matches(record, part));
    if (field === '$nor') return !value.some((part) => matches(record, part));
    const actual = read(record, field);
    if (value instanceof RegExp) return typeof actual === 'string' && value.test(actual);
    if (value && typeof value === 'object' && !(value instanceof ObjectId) && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, expected]) => {
        switch (operator) {
          case '$regex': return (Array.isArray(actual) ? actual : [actual]).some(item => typeof item === 'string' && new RegExp(expected, value.$options).test(item));
          case '$options': return true;
          case '$exists': return (actual !== undefined) === expected;
          case '$type': return typeof actual === expected;
          case '$gt': return actual > expected;
          case '$gte': return actual >= expected;
          case '$lt': return actual < expected;
          case '$lte': return actual <= expected;
          case '$ne': return !equal(actual, expected) && !(Array.isArray(actual) && actual.some(item => equal(item, expected)));
          case '$in': return expected.some((item) => item === null ? actual == null : equal(actual, item));
          case '$nin': return expected.every((item) => !equal(actual, item));
          default: throw new Error(`Unimplemented fixture operator ${operator}`);
        }
      });
    }
    return value === null ? actual == null : equal(actual, value);
  });
}
// In-memory storage exercises the real Express/auth/scoping/query/validation layers.
// It deliberately implements only the Mongo operations used by these HTTP scenarios.
function fixtureDb(records) {
  return { client: { withSession: async fn => fn({ withTransaction: async fn => fn() }) }, collection(name) {
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
      aggregate: pipeline => ({ toArray: async () => aggregateRows(rows, pipeline, records) }),
      async countDocuments(query) { return rows.filter((row) => matches(row, query)).length; },
      async insertOne(document) {
        document._id ||= new ObjectId();
        if (rows.some(row => equal(row._id, document._id) || (name === 'users' && row.email === document.email))) {
          throw Object.assign(new Error('Duplicate key'), { code: 11000 });
        }
        rows.push(document);
        return { insertedId: document._id };
      },
      async deleteOne(query) { const i = rows.findIndex((row) => matches(row, query)); if (i >= 0) rows.splice(i, 1); },
      async updateMany(query, update) {
        const matchesQuery = rows.filter(row => matches(row, query));
        for (const row of matchesQuery) {
          for (const [key, value] of Object.entries(update.$set)) {
            const [field, child] = key.split('.');
            if (child) (row[field] ||= {})[child] = value;
            else row[field] = value;
          }
        }
        return { modifiedCount: matchesQuery.length };
      },
      async bulkWrite(operations) {
        let upsertedCount = 0;
        for (const { updateOne: { filter, update, upsert } } of operations) {
          let row = rows.find(candidate => matches(candidate, filter));
          if (!row) {
            if (!upsert) continue;
            row = { ...filter, ...update.$setOnInsert }; rows.push(row); upsertedCount++;
          }
          if (Array.isArray(update)) { Object.assign(row, aggregateRows([row], update, records)[0]); continue; }
          for (const [key, value] of Object.entries(update.$set || {})) {
            const [field, child] = key.split('.');
            if (child) (row[field] ||= {})[child] = value;
            else row[field] = value;
          }
        }
        return { upsertedCount };
      },
      async findOneAndUpdate(query, update, options = {}) {
        let row = rows.find((item) => matches(item, query));
        if (!row && options.upsert) { row = { ...query, ...update.$setOnInsert }; rows.push(row); }
        if (!row) return null;
        for (const [key, value] of Object.entries(update.$set || {})) {
          const [field, child] = key.split('.');
          if (child) (row[field] ||= {})[child] = value;
          else row[field] = value;
        }
        for (const [key, value] of Object.entries(update.$addToSet || {})) row[key] = [...new Set([...(row[key] || []), ...(value.$each || [value])])];
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
  const app = createApp({ historySources: {}, ...services, sms: { ...require('../lib/mobilemessage'), ...services.sms, lookupMessage: services.sms?.lookupMessage || (async () => null), listInbound: services.sms?.listInbound || (async () => ({ results: [], total: 0 })) }, database: async (key) => {
    const db = fixtureDb(records);
    return { client: { withSession: async callback => callback({ withTransaction: async operation => operation() }) }, command: async () => hooks.ping ? hooks.ping(key) : { ok: 1 }, collection(name) {
      const collection = db.collection(name);
      return { ...collection, async findOne(query) {
        if (hooks.beforeRead) await hooks.beforeRead(name, query);
        return collection.findOne(query);
      }, aggregate(pipeline) {
        return { toArray: async () => {
          if (hooks.beforeRead) await hooks.beforeRead(name, pipeline[0]?.$match);
          return collection.aggregate(pipeline).toArray();
        } };
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

test('daily oversight carries work forward and requires managers to resolve a loss request', async t => {
  const { request, records } = await api(t);
  const site = 'BYD South Morang';
  const consultant = { _id: new ObjectId(), name: 'Consultant', email: 'consultant@example.com', role: 'sales_consultant', active: true, site };
  const consultantToken = 'b'.repeat(64);
  const headers = { authorization: `Bearer ${consultantToken}` };
  records.users.push(consultant);
  records.sessions.push({ _id: createHash('sha256').update(consultantToken).digest('hex'), userId: consultant._id, expiresAt: new Date(Date.now() + 60000) });
  const post = (path, body, options = {}) => request(path, { method: 'POST', body: JSON.stringify(body), ...options });
  const created = await post('/prospects', { dealership: site, quick_walk_in: true, notes: 'Red hat' });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  assert.equal(created.body.data.owner_id, null);
  assert.equal(created.body.data.diary_entries[0].note, 'Red hat');
  const dashboard = '/daily-oversight?rooftop=BYD%20South%20Morang';
  assert.ok((await request(dashboard)).body.data.unassigned.some(lead => lead._id === id));
  assert.equal((await request(`/leads/${id}/assignment`, { method: 'PATCH', body: JSON.stringify({ assigneeId: String(consultant._id), expectedOwnerId: null }) })).status, 200);
  const record = records.leads.find(lead => String(lead._id) === id);
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  Object.assign(record, { created_at: yesterday, assigned_at: new Date(yesterday), last_activity_at: yesterday });
  records.sales_tasks = [{ _id: new ObjectId(), dealership: site, lead_id: id, assignee_id: String(consultant._id), status: 'open', due_at: yesterday }];
  const myDay = (await request(dashboard, { headers })).body.data;
  assert.equal(myDay.members.length, 1);
  assert.equal(myDay.summary.overdueProspects, 1);
  assert.equal(myDay.summary.carryOvers, 1);
  assert.equal(myDay.members[0].expected, 1, 'active carry-over prospects remain in the video denominator');
  assert.deepEqual(myDay.unassigned, []);
  const leadPath = `/leads/${id}`;
  assert.equal((await post(`${leadPath}/next-action`, { title: 'Call', note: 'Called', dueAt: new Date(Date.now() + 3 * 86400000).toISOString() }, { headers })).status, 400);
  assert.equal((await post(`${leadPath}/next-action`, { title: 'Call', note: 'Called', dueAt: new Date(Date.now() + 3600000).toISOString() }, { headers })).status, 200);
  assert.equal((await request(dashboard)).body.data.members[0].leads[0].actioned, true);
  assert.equal((await post(`${leadPath}/loss-request`, { reason: ' ' }, { headers })).status, 400);
  const loss = (await post(`${leadPath}/loss-request`, { reason: 'Customer declined' }, { headers })).body.data;
  assert.equal(loss.status, 'following_up');
  assert.equal((await request(dashboard)).body.data.losses[0]._id, id);
  const decision = { action: 'approve', reviewId: loss.loss_review.id };
  assert.equal((await post(`${leadPath}/loss-review`, decision, { headers })).status, 403);
  assert.equal((await post(`${leadPath}/loss-review`, decision)).body.data.status, 'lost');
  assert.equal((await post(`${leadPath}/loss-review`, decision)).status, 409);
  assert.equal((await request(dashboard)).body.data.losses.length, 0);
  assert.ok(records.sales_tasks.every(task => task.status === 'completed'));
});

test('daily oversight credits pasted Booran video links and still-scheduled next actions', async t => {
  const { request, records, user } = await api(t);
  const { shareUrl } = require('../lib/customer-messages');
  const [linked, scheduled, expired] = records.leads;
  const now = new Date();
  const previousDay = new Date(+now - 36 * 3600000).toISOString();
  for (const lead of [linked, scheduled, expired]) Object.assign(lead, {
    owner_id: String(user._id), owner_name: user.name, dealership_name: linked.dealership_name,
    status: 'following_up', created_at: previousDay, last_activity_at: previousDay,
  });
  scheduled.next_action = { title: 'Call', recorded_at: previousDay, due_at: new Date(+now + 3600000).toISOString() };
  expired.next_action = { ...scheduled.next_action, due_at: previousDay };
  const video = {
    _id: new ObjectId(), lead_id: String(linked._id), dealership_name: linked.dealership_name,
    share_token: 'b'.repeat(64), status: 'ready', content_type: 'video/mp4',
    created_at: previousDay, name: 'walkaround.mp4', views: 3,
  };
  records.message_media = [video];
  records.customer_messages = [linked, expired].map(lead => ({
    _id: new ObjectId(), lead_id: String(lead._id), dealership_name: lead.dealership_name,
    status: 'sent', body: `Watch the video: (${shareUrl(video)}).`, created_at: now.toISOString(),
  }));
  const response = await request('/daily-oversight?rooftop=BYD%20South%20Morang');
  assert.equal(response.status, 200);
  const [person] = response.body.data.members;
  const rows = new Map(person.leads.map(lead => [lead._id, lead]));
  assert.equal(rows.get(String(linked._id)).videoSent, true);
  assert.equal(rows.get(String(linked._id)).actioned, true);
  assert.equal(rows.get(String(linked._id)).videos[0].views, 3);
  assert.equal(rows.get(String(scheduled._id)).actioned, true);
  assert.equal(rows.get(String(scheduled._id)).overdue, true, 'untouched prospects remain visible separately');
  assert.equal(rows.get(String(expired._id)).actioned, false, 'another lead’s link and an expired action do not count');
  assert.equal(person.nextActions, 1);
});

test('external intake keeps the same lead after the phone is revealed and preserves staff edits', async t => {
  const { request } = await api(t);
  const source = '/lead-ingestion/connex';
  const send = data => request(source, { method: 'POST', body: JSON.stringify(data) });
  const payload = { externalId: 'connex-123', dealership: 'BYD South Morang', name: 'Provider name', vehicle: 'Tucson' };
  const first = await send(payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.owner_id, null);
  const id = first.body.data._id;
  assert.equal((await request(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ customer_name: 'Verified name' }) })).status, 200);
  const revealed = await send({ ...payload, phone: '0412 345 678', opportunityStatus: 'Sales Qualified' });
  assert.equal(revealed.body.data._id, id);
  assert.equal(revealed.body.data.name, 'Verified name');
  assert.equal(revealed.body.data.phone, '+61412345678');
  const replay = await send(payload);
  assert.equal(replay.body.data.external.details_revealed, true);
  assert.equal(replay.body.data.external.opportunity_status, 'Sales Qualified');
  assert.equal((await send({ ...payload, dealership: 'Booran Cheltenham' })).status, 403);
});

test('recorded videos remain private during branding and count each viewer event once per session', async t => {
  const settings = { VIDEO_BRANDING_JSON: JSON.stringify({ 'South Morang Hyundai': { name: 'South Morang Hyundai', phone: '03 5550 0100', email: 'sales@example.test' } }) };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const storage = { ...require('../lib/media-storage'), prepare: async () => ({ chunk_size: 100 }), complete: async () => {} };
  const { request, records, baseUrl } = await api(t, { storage });
  const lead = records.leads[0];
  lead.dealership_name = 'South Morang Hyundai';
  const path = `/leads/${lead._id}/media`;
  const prepared = await request(path, { method: 'POST', body: JSON.stringify({ recorded: true, name: 'walkaround.mp4', content_type: 'video/mp4', size: 100 }) });
  assert.equal(prepared.status, 201);
  const media = records.message_media[0];
  const url = `${baseUrl}/media/${media.share_token}`;
  const completed = await request(`${path}/${media._id}/complete`, { method: 'POST', body: '{}' });
  assert.equal(completed.body.data.status, 'processing');
  assert.equal(completed.body.data.url, '');
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await request(path)).body.data.length, 0);
  assert.equal((await request(`${path}?includeProcessing=true`)).body.data.length, 1);
  // Exercise the recipient endpoints after the worker publishes the recording.
  media.status = 'ready';
  assert.equal((await fetch(url)).status, 200);
  const event = (type) => fetch(`${url}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: type, session: '5bc002f4-382e-4a72-9368-713b6f88455b' }) });
  for (const type of ['view', 'view', 'review']) assert.equal((await event(type)).status, 200);
  const item = (await request(path)).body.data[0];
  assert.equal(item.views, 1);
  assert.equal(item.reviews, 1);
});
test('staff administration requires a super admin and applies saved site access to existing sessions', async (t) => {
  const { request, records, user } = await api(t);
  records.rooftops = [{ name: 'South Morang Kia' }, { name: 'Booran Cheltenham' }];
  const endpoint = '/admin/staff';
  const create = data => request(endpoint, { method: 'POST', body: JSON.stringify(data) });
  const input = {
    name: 'Staff fixture', email: 'Staff@Example.com', password: 'staff-fixture-password',
    role: 'sales_manager', site: 'south morang kia', allowedSites: ['South Morang Kia'],
  };

  assert.equal((await request(endpoint, { headers: { cookie: '' } })).status, 401);
  assert.equal((await request(endpoint)).status, 403);
  assert.equal((await create(input)).status, 403);
  user.role = 'super_admin';
  assert.equal((await create({ ...input, role: 'super_admin' })).status, 400);
  assert.equal((await create({ ...input, allowedSites: ['*'] })).status, 400);
  assert.equal((await create({ ...input, allowedSites: ['Booran Cheltenham'] })).status, 400);
  assert.equal((await create({ ...input, password: 'short' })).status, 400);
  const created = await create(input);
  assert.equal(created.status, 201);
  const account = created.body.data;
  assert.equal(account.email, 'staff@example.com');
  assert.deepEqual(account.allowedSites, ['South Morang Kia']);
  assert.equal(account.passwordHash, undefined);
  assert.equal((await create(input)).status, 409);
  const directory = (await request(endpoint)).body.data;
  assert.deepEqual(directory.accounts, [account]);
  assert.ok(directory.sites.includes('Booran Cheltenham'));

  const login = await request('/auth/login', {
    method: 'POST', headers: { cookie: '' },
    body: JSON.stringify({ email: account.email, password: input.password }),
  });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.deepEqual((await request('/leads', { headers })).body.data.map(lead => lead.name), ['Bob']);
  const update = id => request(`${endpoint}/${id}`, {
    method: 'PATCH', body: JSON.stringify({ role: 'manager', site: 'Booran Cheltenham', allowedSites: ['Booran Cheltenham'] }),
  });
  assert.equal((await update(user._id)).status, 404);
  assert.equal((await update(account.id)).status, 200);
  assert.deepEqual((await request('/leads', { headers })).body.data.map(lead => lead.name), ['Carol']);
});

test('hidden vehicles remain stored and sales consultants see only their own work', async (t) => {
  const { request, records, user } = await api(t);
  const hidden = records.vehicles[1];
  hidden.salesFloorHidden = true;
  const list = await request('/inventory/vehicles?status=all');
  assert.equal(list.status, 200);
  assert.equal(list.body.pagination.total, 1);
  assert.equal((await request(`/inventory/vehicles/${hidden._id}`)).status, 404);
  assert.equal((await request('/unified/search?q=S2')).body.data.vehicles.length, 0);
  user.role = 'super_admin';
  assert.equal((await request(`/inventory/vehicles/${hidden._id}`)).status, 404);
  assert.equal(records.vehicles.length, 3);

  user.role = 'sales_consultant';
  const own = String(user._id);
  records.leads[0].owner_id = own;
  records.appointments = [
    { _id: new ObjectId(), dealership: 'BYD South Morang', consultant_id: own, prospectName: 'My booking' },
    { _id: new ObjectId(), dealership: 'BYD South Morang', consultant_id: 'other', prospectName: 'Team booking' },
  ];
  records.sales_tasks = [
    { _id: new ObjectId(), dealership: 'BYD South Morang', assignee_id: own, status: 'open', title: 'My follow-up' },
    { _id: new ObjectId(), dealership: 'BYD South Morang', assignee_id: 'other', status: 'open', title: 'Team follow-up' },
  ];
  assert.deepEqual((await request('/leads')).body.data.map(row => row.name), ['Alice']);
  assert.deepEqual((await request('/appointments?consultantId=other')).body.data.map(row => row.prospectName), ['My booking']);
  assert.deepEqual((await request('/sales-tasks?status=open')).body.data.map(row => row.title), ['My follow-up']);
  assert.equal((await request('/team-activity')).status, 403);
  assert.equal((await request('/inventory/action-items')).body.data.length, 0);
  assert.equal((await request('/unified/search?q=S1')).body.data.vehicles.length, 0);
});

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

test('SMS Campaign enquiries and Hyundai opportunities share the paginated, site-scoped queue', async (t) => {
  const { request, records, user } = await api(t);
  const date = '2026-11-06T00:00:00.000Z';
  const registration = { id: 'registration-1', firstName: 'Campaign', lastName: 'Enquiry', mobile: '0412345678', createdAt: date };
  const opportunity = { opportunity_id: '102', dealership_id: '10876', rooftop: 'South Morang Hyundai', customer_name: 'Hyundai Customer', opportunity_status: 'Up/Contacted' };
  const snapshot = { scope: 'south_morang_hyundai', readOnly: true, fetchedAt: date, records: [
    opportunity, { ...opportunity }, { ...opportunity, opportunity_id: '103', dealership_id: '999' },
  ] };
  const target = fixtureDb(records);
  const source = { collection(name) {
    if (name === 'leads') return fixtureDb({ leads: [registration] }).collection(name);
    if (name === 'south_morang_prospects') return fixtureDb({}).collection(name);
    assert.equal(name, 'settings');
    return { async findOne(query) { assert.deepEqual(query, { key: 'chrome-snapshot' }); return { value: JSON.stringify(snapshot) }; } };
  } };
  const synced = await syncSmsCampaign(target, source);
  assert.deepEqual(synced, { registrations: { status: 'fulfilled', value: 1 }, opportunities: { status: 'fulfilled', value: 1 } });
  const site = 'rooftop=South%20Morang%20Hyundai';
  const page = await request(`/leads?${site}&limit=1&page=2`);
  assert.equal(page.body.pagination.total, 2);
  assert.equal(page.body.data.length, 1);
  const enquiry = (await request(`/leads?${site}&source=SMS%20Campaign&search=Enquiry`)).body.data[0];
  assert.equal(enquiry.phone, '+61412345678');
  assert.equal(enquiry.source_channel, 'Campaign landing page');
  const dealerLead = (await request(`/leads?${site}&source=DealerSocket&status=following_up`)).body.data[0];
  assert.equal(dealerLead.source_stage, 'Up/Contacted');
  assert.equal(dealerLead.created_at, date);
  const assigned = await request(`/leads/${dealerLead.id}/assignment`, { method: 'PATCH', body: JSON.stringify({ assigneeId: String(user._id), expectedOwnerId: null }) });
  assert.equal(assigned.status, 200);
  opportunity.opportunity_status = 'Lost';
  snapshot.records = [opportunity];
  await syncSmsCampaign(target, source);
  const after = await request(`/leads?${site}&source=DealerSocket&assignment=assigned`);
  assert.equal(after.body.pagination.total, 1);
  assert.equal(after.body.data[0].id, dealerLead.id);
  assert.equal(after.body.data[0].source_stage, 'Lost');
  assert.equal(after.body.data[0].status, 'following_up');
  assert.equal((await request(`/daily-oversight?${site}`)).body.data.dealerSocket, null,
    'an opportunity closed in the source no longer counts as an active DealerSocket prospect');
  user.site = 'South Morang Kia';
  assert.equal((await request(`/leads?${site}&source=DealerSocket`)).body.pagination.total, 0);
  assert.equal((await request(`/leads/${enquiry.id}`)).status, 404);
});

test('DealerSocket owners populate scoped staff rows and preserve manager allocations on replay', async t => {
  const { request, records } = await api(t);
  const site = 'South Morang Hyundai';
  const staff = [
    { name: 'Isaac Bugeja', role: 'sales_consultant', site },
    { name: 'Kris Liberi', role: 'sales_consultant', site },
    { name: 'Quoc Truong', role: 'sales_manager', site },
    { name: 'George Simogiannis', role: 'sales_consultant', site: 'South Morang Kia' },
    { name: 'First Smith', role: 'sales_consultant', site },
    { name: 'Second Smith', role: 'sales_consultant', site },
  ].map(person => ({ ...person, _id: new ObjectId(), active: true }));
  records.users.push(...staff);
  const owners = ['Bugeja', 'Libreri', 'Truong', 'Simogiannis', 'Smith', 'Carsales Webleads', 'Bugeja'];
  const snapshot = { scope: 'south_morang_hyundai', readOnly: true, fetchedAt: '2026-11-06T01:00:00Z',
    records: owners.map((owner, index) => ({ opportunity_id: String(index + 1), dealership_id: '10876',
      rooftop: site, customer_name: `Imported ${index}`, assigned_salesperson: owner,
      opportunity_status: index === 6 ? 'Lost' : 'Up/Contacted' })) };
  const source = { collection(name) {
    return ['leads', 'south_morang_prospects'].includes(name) ? fixtureDb({}).collection(name) : { findOne: async () => ({ value: JSON.stringify(snapshot) }) };
  } };
  const target = { ...fixtureDb(records), client: { withSession: async callback => callback({ withTransaction: async operation => operation() }) } };
  const outcome = await syncSmsCampaign(target, source);
  assert.equal(outcome.opportunities.status, 'fulfilled', outcome.opportunities.reason?.message);
  const imported = records.leads.filter(lead => lead.source === 'DealerSocket');
  const byName = new Map(imported.map(lead => [lead.customer_name, lead]));
  assert.equal(byName.get('Imported 0').owner_id, String(staff[0]._id));
  assert.equal(byName.get('Imported 1').owner_id, String(staff[1]._id));
  assert.equal(byName.get('Imported 2').owner_id, String(staff[2]._id));
  for (const index of [3, 4, 5, 6]) assert.equal(byName.get(`Imported ${index}`).owner_id, undefined);
  const dashboard = (await request('/daily-oversight?rooftop=South%20Morang%20Hyundai')).body.data;
  assert.equal(dashboard.summary.activeProspects, 6);
  assert.equal(dashboard.dealerSocket.active, 6);
  assert.equal(dashboard.dealerSocket.assigned, 3);
  assert.equal(dashboard.dealerSocket.snapshotAt, snapshot.fetchedAt);
  assert.ok(dashboard.members.some(person => person.name === 'Quoc Truong' && person.activeProspects === 1));
  assert.equal(dashboard.unassigned.length, 3, 'ambiguous, other-site and source bucket owners stay in the allocation queue');

  const first = byName.get('Imported 0');
  const second = byName.get('Imported 1');
  const assigned = await request(`/leads/${first._id}/assignment`, { method: 'PATCH',
    body: JSON.stringify({ assigneeId: String(staff[1]._id), expectedOwnerId: first.owner_id }) });
  assert.equal(assigned.status, 200);
  second.diary_entries.push({ author: 'Salesperson', note: 'Keep this note', date: new Date().toISOString() });
  records.sales_tasks = [{ _id: new ObjectId(), dealership: site, lead_id: String(second._id),
    status: 'open', assignee_id: String(staff[1]._id) }];
  snapshot.records[0].assigned_salesperson = 'Truong';
  snapshot.records[1].assigned_salesperson = 'Bugeja';
  await syncSmsCampaign(target, source);
  assert.equal(first.owner_id, String(staff[1]._id), 'a manager allocation survives subsequent DealerSocket changes');
  assert.equal(second.owner_id, String(staff[0]._id), 'source-owned assignments follow the current source owner');
  assert.equal(records.sales_tasks[0].assignee_id, String(staff[0]._id));
  const entries = second.diary_entries.length;
  await syncSmsCampaign(target, source);
  assert.equal(second.diary_entries.length, entries, 'replays do not duplicate assignment notes');
  assert.ok(second.diary_entries.some(entry => entry.note === 'Keep this note'));
});

test('Hyundai DealerSocket login IDs resolve to existing staff without changing manager allocations', async t => {
  const { records } = await api(t);
  const site = 'South Morang Hyundai';
  const people = ['Isaac Bugeja', 'George Simogiannis', 'Khan Cetin'].map(name => ({
    _id: new ObjectId(), name, active: true, role: 'sales_consultant', site,
  }));
  records.users.push(...people);
  const rows = ['s7xisaacb', 's7xgsimo', 's7xkhanc'].map((assignee, index) => ({
    id: String(900 + index), site: '10876', franchise: site, name: `Customer ${index}`, assignee,
    status: 'Up/Contacted', capturedAt: '2026-11-11T09:00:00Z',
  }));
  const source = fixtureDb({ south_morang_prospects: rows });
  const target = { ...fixtureDb(records), client: { withSession: async fn => fn({ withTransaction: async fn => fn() }) } };
  let result = await syncSmsCampaign(target, source);
  assert.equal(result.opportunities.status, 'fulfilled', result.opportunities.reason?.message);
  for (const [index, person] of people.entries()) {
    const lead = records.leads.find(row => row.deal_id === `DEALERSOCKET-10876-${900 + index}`);
    assert.equal(lead.owner_id, String(person._id));
    assert.equal(lead.owner_name, person.name);
    assert.equal(lead.owner_source, 'dealersocket');
  }
  const lead = records.leads.find(row => row.deal_id === 'DEALERSOCKET-10876-900');
  lead.owner_id = String(people[1]._id);
  lead.assigned_by = 'manager';
  const noteCount = lead.diary_entries.length;
  result = await syncSmsCampaign(target, source);
  assert.equal(result.opportunities.status, 'fulfilled');
  assert.equal(lead.owner_id, String(people[1]._id));
  assert.equal(lead.diary_entries.length, noteCount);
  people[2].site = 'South Morang Kia';
  const third = records.leads.find(row => row.deal_id === 'DEALERSOCKET-10876-902');
  third.owner_id = null;
  await syncSmsCampaign(target, source);
  assert.equal(third.owner_id, null, 'a login alias cannot grant dealership access');
});

test('cross-site manager surnames with franchise labels resolve uniquely and respect existing allocations', async () => {
  const luca = { _id: new ObjectId(), name: 'Luca Molinaro', role: 'manager', site: 'South Morang', allowedSites: ['South Morang'], active: true };
  const les = { _id: new ObjectId(), name: 'Les Vogdanis', role: 'manager', site: 'South Morang', allowedSites: ['South Morang'], active: true };
  const records = { users: [luca, les], leads: [] }, now = new Date().toISOString();
  const rows = [
    { id: 'manager-kia', site: '10755', franchise: 'South Morang Kia Used Cars', name: 'Fixture one', assignee: 'Molinaro (Kia)', status: 'Up/Contacted', capturedAt: now },
    { id: 'manager-chery', site: '10755', franchise: 'Chery South Morang', name: 'Fixture two', assignee: 'Molinaro (Kia)', status: 'Up/Contacted', capturedAt: now },
    { id: 'manager-les', site: '10755', franchise: 'South Morang Kia', name: 'Fixture three', assignee: 'Vogdanis', status: 'Up/Contacted', capturedAt: now },
  ];
  const db = fixtureDb(records), source = fixtureDb({ south_morang_prospects: rows });
  let result = await syncSmsCampaign(db, source);
  assert.equal(result.opportunities.status, 'fulfilled', result.opportunities.reason?.message);
  for (const row of records.leads) assert.equal(row.owner_id, String(row.deal_id.endsWith('manager-les') ? les._id : luca._id));
  const first = records.leads[0]; first.assigned_by = 'manager'; first.owner_id = String(les._id);
  await syncSmsCampaign(db, source); assert.equal(first.owner_id, String(les._id));
  records.users.push({ ...luca, _id: new ObjectId(), name: 'Another Molinaro' });
  const second = records.leads.find(row => row.dealership_name === 'Chery South Morang'); second.owner_id = null;
  await syncSmsCampaign(db, source); assert.equal(second.owner_id, null, 'an ambiguous surname cannot select a manager');
  records.users.pop(); luca.allowedSites = ['South Morang Hyundai']; luca.site = 'South Morang Hyundai';
  await syncSmsCampaign(db, source); assert.equal(second.owner_id, null, 'the franchise label cannot grant site access');
});

test('the current South Morang collection replaces stale snapshot counts across the correct dealerships', async t => {
  const { request, records } = await api(t);
  records.users.push({ _id: new ObjectId(), name: 'Isaac Bugeja', role: 'sales_consultant', site: 'South Morang Hyundai', active: true });
  const snapshot = { scope: 'south_morang_hyundai', readOnly: true, fetchedAt: '2026-11-06T01:00:00Z',
    records: ['101', '201', '103'].map(id => ({ opportunity_id: id, dealership_id: '10876', rooftop: 'South Morang Hyundai',
      customer_name: 'Previous name', opportunity_status: id === '103' ? 'Lost' : 'Up/Contacted', assigned_salesperson: 'Bugeja' })) };
  const sourceRows = { settings: [{ key: 'chrome-snapshot', value: JSON.stringify(snapshot) }] };
  const source = fixtureDb(sourceRows);
  let writtenOperations = 0;
  const storage = fixtureDb(records);
  const target = { collection: name => {
    const collection = storage.collection(name);
    return { ...collection, bulkWrite: async operations => {
      writtenOperations += operations.length;
      return collection.bulkWrite(operations);
    } };
  }, client: { withSession: async callback => callback({ withTransaction: async operation => operation() }) } };
  assert.equal((await syncSmsCampaign(target, source)).opportunities.status, 'fulfilled');
  const existing = records.leads.find(lead => lead.deal_id === 'DEALERSOCKET-10876-101');
  const previous = records.leads.find(lead => lead.deal_id === 'DEALERSOCKET-10876-201');
  previous.diary_entries.push({ author: 'Manager', note: 'Keep historical notes' });
  const capturedAt = '2026-11-11T09:08:00.063Z';
  sourceRows.south_morang_prospects = [
    { id: '101', contactId: 'c1', site: '10876', franchise: 'South Morang Hyundai', name: 'Alice Updated',
      status: 'Up/Contacted', assignee: 'Bugeja', vehicle: 'Hyundai Tucson', capturedAt },
    { id: '103', site: '10876', franchise: 'South Morang Hyundai Used Cars', name: 'Used customer', status: 'Up/Contacted', capturedAt },
    { id: '101', contactId: 'c1', site: '10755', franchise: 'South Morang Kia Used Cars', name: 'Different customer', status: 'Up/Contacted', assignee: 'Bugeja', capturedAt },
    { id: '104', site: '10755', franchise: 'Chery South Morang', name: 'Chery customer', status: 'Worksheet', capturedAt },
    { id: '999', site: '999', franchise: 'South Morang Hyundai', name: 'Other dealership', status: 'Unqualified', capturedAt },
  ];
  sourceRows.contacts = [{ dealerSocketContactId: 'c1', firstName: 'Alice', lastName: 'Updated', mobile: '0412345678' }];
  const imported = await syncSmsCampaign(target, source);
  assert.equal(imported.opportunities.status, 'fulfilled', imported.opportunities.reason?.message);
  assert.equal(imported.opportunities.value, 4);
  assert.equal(existing.customer_name, 'Alice Updated');
  assert.equal(existing.customer_phone, '+61412345678');
  assert.equal(existing.vehicle_model, 'Hyundai Tucson');
  assert.equal(records.leads.find(lead => lead.deal_id === 'DEALERSOCKET-10876-103').status, 'following_up',
    'an unedited source status follows the current feed when a prospect becomes active again');
  assert.equal(previous.sms_campaign.active, false);
  assert.equal(previous.diary_entries.at(-1).note, 'Keep historical notes');
  const kia = records.leads.find(lead => lead.deal_id === 'DEALERSOCKET-10755-101');
  assert.equal(kia.dealership_name, 'South Morang Kia');
  assert.equal(kia.customer_phone, '', 'a contact ID with a different customer name cannot supply a phone number');
  assert.equal(kia.owner_id, undefined, 'a Hyundai-only account cannot receive a Kia prospect');
  assert.equal(records.leads.filter(lead => lead.deal_id === 'DEALERSOCKET-10876-101').length, 1, 'the prior opportunity keeps its identity');
  const dashboard = (await request('/daily-oversight?rooftop=South%20Morang')).body.data;
  assert.equal(dashboard.dealerSocket.active, 4);
  assert.equal(dashboard.dealerSocket.snapshotAt, capturedAt);
  assert.ok(dashboard.members.every(person => person.leads.every(lead => lead._id !== String(previous._id))),
    'retired source records do not appear as current prospects just because they were assigned today');
  assert.equal((await request('/daily-oversight?rooftop=South%20Morang%20Hyundai')).body.data.dealerSocket.active, 2);
  assert.equal((await request('/leads?dealership=South%20Morang%20Hyundai&status=following_up')).body.pagination.total, 2);
  assert.equal((await request('/unified/summary?rooftop=South%20Morang%20Hyundai')).body.data.crm.totalLeads, 2);
  existing.customer_phone = '+61400000000';
  existing.booran_edited_fields = ['customer_phone'];
  kia.status = 'lost';
  kia.booran_edited_fields = ['status'];
  sourceRows.contacts[0].mobile = '0433333333';
  writtenOperations = 0;
  await syncSmsCampaign(target, source);
  assert.equal(writtenOperations, 0, 'an unchanged source skips redundant per-record updates');
  assert.equal(existing.customer_phone, '+61400000000', 'local contact edits survive source refresh');
  assert.equal(kia.status, 'lost', 'a locally reviewed outcome survives source refresh');
  sourceRows.south_morang_prospects = [];
  assert.equal((await syncSmsCampaign(target, source)).opportunities.status, 'rejected', 'an empty new feed cannot resurrect the older snapshot');
  assert.equal(previous.sms_campaign.active, false);
});

test('batched reports preserve scoped counts, hidden inventory and cost permissions', async t => {
  const { request, records, user } = await api(t);
  records.leads[0].owner_id = String(user._id);
  records.leads[1].owner_id = 'other';
  Object.assign(records.vehicles[0], { totalStockCost: 15000, accumulatedHoldingCost: 500 });
  Object.assign(records.vehicles[1], { totalStockCost: 25000, accumulatedHoldingCost: 1000 });
  records.vehicles.push({ _id: new ObjectId(), rooftopName: 'BYD South Morang', salesFloorHidden: true, daysInStock: 999, totalStockCost: 999999 });
  records.rooftops = [{ name: 'BYD South Morang' }, { name: 'South Morang Kia' }, { name: 'Booran Cheltenham' }];
  const crm = (await request('/crm/stats')).body.data;
  assert.equal(crm.totalLeads, 2);
  assert.equal(crm.newLeads, 1);
  assert.equal(crm.sold, 1);
  assert.equal(crm.conversionRate, '50.0%');
  const inventory = (await request('/inventory/stats')).body.data;
  assert.equal(inventory.totalVehicles, 2);
  assert.equal(inventory.totalStockCost, 40000);
  assert.equal(inventory.totalHoldingCost, 1500);
  assert.equal(inventory.avgDaysInStock, 51);
  assert.equal(inventory.openActionItems, 1);
  const summary = (await request('/unified/summary')).body.data;
  assert.deepEqual(summary.crm, { totalLeads: 2, followingUp: 0, newLeads: 1 });
  assert.deepEqual(summary.inventory, { totalVehicles: 2, agingOver90Days: 1, openActionItems: 1 });
  assert.equal(summary.system.activeRooftops, 2);
  user.role = 'sales_consultant';
  assert.equal((await request('/crm/stats')).body.data.totalLeads, 1);
  const ownInventory = (await request('/inventory/stats')).body.data;
  assert.equal(ownInventory.totalVehicles, 2);
  assert.equal(ownInventory.openActionItems, 0);
  assert.equal(Object.hasOwn(ownInventory, 'totalStockCost'), false);
  assert.equal(Object.hasOwn(ownInventory, 'totalHoldingCost'), false);
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
test('HTTP retires new holds and still releases the exact legacy hold', async (t) => {
  const { request, records } = await api(t);
  const hold = (stock) => request(`/inventory/vehicles/${stock}/soft-hold`, { method: 'POST', body: JSON.stringify({ prospectName: 'Alice', consultant: 'Spoofed' }) });
  const release = (stock, expected = records.vehicles.find((vehicle) => vehicle.stockNumber === stock)?.softHold || { holdId: 'not-current' }) => request(`/inventory/vehicles/${stock}/release-hold`, { method: 'POST', body: JSON.stringify({ holdId: expected.holdId, heldAt: expected.heldAt }) });
  assert.equal((await hold('S1')).status, 410);
  assert.equal(records.vehicles[0].status, 'In Stock');
  assert.equal((await hold('S2')).status, 410);
  assert.equal((await release('S2')).status, 409);
  assert.equal(records.vehicles[1].status, 'Sold');
  assert.equal((await release('C1')).status, 404);
  records.vehicles[0].status = 'Soft Hold';
  records.vehicles[0].softHold = { holdId: 'legacy', held: true, expiresAt: new Date(0).toISOString() };
  const expired = await request('/inventory/vehicles/S1');
  assert.equal(expired.body.data.status, 'In Stock');
  assert.equal(expired.body.data.softHold.held, false);
  const available = await request('/inventory/vehicles?status=In%20Stock');
  assert.deepEqual(available.body.data.map((vehicle) => vehicle.stockNumber), ['S1']);
  assert.equal((await request('/inventory/vehicles?status=Soft%20Hold')).body.pagination.total, 0);
  assert.equal((await release('S1', { holdId: 'previous' })).status, 409);
  assert.equal(records.vehicles[0].status, 'Soft Hold');
  assert.equal((await release('S1')).status, 200);
  assert.equal((await release('S1')).status, 409);
});

test('Nextgate events populate the scoped queue immediately, and replay preserves an allocation', async (t) => {
  const secret = 'nextgate-test-secret-00000001';
  const previous = process.env.NEXGATE_WEBHOOK_SECRET;
  process.env.NEXGATE_WEBHOOK_SECRET = secret;
  t.after(() => { if (previous === undefined) delete process.env.NEXGATE_WEBHOOK_SECRET; else process.env.NEXGATE_WEBHOOK_SECRET = previous; });
  const { request, records, user } = await api(t);
  const [, sellerIdentifier] = require('../lib/nexgate-client').DEALERSHIPS[0];
  const event = {
    sellerIdentifier,
    customer: { id: 'test-customer', firstName: 'New', lastName: 'Prospect', email: 'test@example.com' },
    lead: { id: 'test-enquiry', leadCreatedDate: '2026-11-07T08:00:00Z', leadSource: 'carsales', stage: 'New' },
  };
  const put = (data, authorization = '') => request('/integrations/nexgate/leads', { method: 'POST', headers: { authorization, cookie: '' }, body: JSON.stringify(data) });
  assert.equal((await put(event)).status, 401);
  const authorization = `Bearer ${secret}`;
  assert.equal((await put({ ...event, sellerIdentifier: 'unknown' }, authorization)).status, 400);
  assert.equal((await put(event, authorization)).body.data.inserted, 1);
  const filter = '/leads?source=Nextgate&channel=carsales&assignment=unassigned&limit=1';
  const list = await request(filter);
  assert.equal(list.body.pagination.total, 1);
  assert.equal(list.body.data[0].dealership, 'South Morang Kia');
  assert.equal((await request(`${filter}&dealership=Booran%20Cheltenham`)).body.pagination.total, 0);
  const id = list.body.data[0]._id;
  const own = { _id: new ObjectId(), name: 'Eligible salesperson', email: 'sales@example.com', active: true, role: 'sales_consultant', site: 'South Morang Kia' };
  const other = { ...own, _id: new ObjectId(), name: 'Other site', site: 'Booran Cheltenham' };
  records.users.push(own, other);
  records.appraisals = [{ _id: new ObjectId(), dealership: 'South Morang Kia', lead_id: id, owner_id: null }];
  const assign = (person, expectedOwnerId = null) => request(`/leads/${id}/assignment`, { method: 'PATCH', body: JSON.stringify({ assigneeId: person && String(person._id), expectedOwnerId }) });
  for (const role of ['dealer_principal', 'general_manager', 'sales_manager', 'manager']) {
    user.role = role;
    const options = await request(`/leads/${id}/assignees`);
    assert.deepEqual(options.body.data.map(item => item.name).sort(), [own.name, user.name].sort());
  }
  assert.equal((await assign(other)).status, 403);
  assert.equal((await assign(own)).body.data.owner_id, String(own._id));
  assert.equal(records.appraisals[0].owner_id, String(own._id));
  assert.equal((await assign(user)).status, 409);
  assert.equal((await request(filter)).body.pagination.total, 0);
  assert.equal((await put({ ...event, lead: { ...event.lead, stage: 'Contacted' } }, authorization)).body.data.inserted, 0);
  assert.equal((await request(`/leads/${id}`)).body.data.owner_name, own.name);
  assert.equal((await request(`/leads/${id}`)).body.data.source_stage, 'Contacted');
  const consultantToken = 'd'.repeat(64);
  records.sessions.push({ _id: createHash('sha256').update(consultantToken).digest('hex'), userId: own._id, expiresAt: new Date(Date.now() + 60000) });
  const headers = { authorization: `Bearer ${consultantToken}` };
  assert.equal((await request('/leads', { headers })).body.pagination.total, 1);
  assert.equal((await request(`/leads/${id}/assignees`, { headers })).status, 403);
  assert.equal((await request(`/leads/${records.leads[1]._id}`, { headers })).status, 404);
  assert.equal((await assign(null, String(own._id))).body.data.owner_id, null);
  assert.equal((await request('/leads', { headers })).body.pagination.total, 0);
});

test('a registered deal marks a vehicle pending and unavailable inventory blocks new deals', async (t) => {
  const { request, records } = await api(t);
  const leadId = String(records.leads[1]._id);
  const register = (stockNumber) => request(`/leads/${leadId}/deals`, { method: 'POST', body: JSON.stringify({ stockNumber }) });
  assert.equal((await register('S2')).status, 409);
  const vehicle = { _id: new ObjectId(), stockNumber: 'K-PENDING', rooftopName: 'South Morang Kia', status: 'In Stock', vin: 'KM8J33A41GU123456', daysInStock: 20 };
  records.vehicles.push(vehicle);
  assert.equal((await register('K-PENDING')).status, 201);
  const pending = await request('/inventory/vehicles?status=Deal%20Pending');
  assert.deepEqual(pending.body.data.map(row => row.stockNumber), ['K-PENDING']);
  assert.equal(pending.body.data[0].status, 'Deal Pending');
  const stock = await request('/inventory/vehicles');
  assert.deepEqual(stock.body.data.map(row => row.stockNumber), ['S1']);
  assert.equal((await request('/inventory/vehicles/K-PENDING')).body.data.status, 'Deal Pending');
  assert.equal(vehicle.status, 'In Stock');
});

test('a calendar day uses Melbourne midnight, including the DST transition', () => {
  const { periodWindow } = require('../lib/pulse');
  assert.deepEqual(periodWindow('today', new Date('2026-10-04T01:00:00Z')), {
    from: '2026-10-03T14:00:00.000Z', to: '2026-10-04T13:00:00.000Z',
  });
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
  const { request, records, user } = await api(t);
  records.sessions[0].userId = String(user._id);
  assert.equal((await request('/auth/me')).status, 200, 'legacy string user IDs remain valid');
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
  hooks.beforeRead = async (name) => { if (name === 'sessions') { started(); await blocked; } };
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

test('HTTP CSV and FLWUP sync endpoints enforce super admin role', async (t) => {
  const { request, user } = await api(t);
  // Default user is manager -> 403
  const managerRes = await request('/inventory/sync-csv', { method: 'POST' });
  assert.equal(managerRes.status, 403);
  assert.equal(managerRes.body.success, false);

  const managerFlwupRes = await request('/leads/sync-flwup', { method: 'POST' });
  assert.equal(managerFlwupRes.status, 403);
  assert.equal(managerFlwupRes.body.success, false);
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

test('queued Sales Floor messages refresh from Mobile Message and persist delivered status', async (t) => {
  let lookups = 0;
  const sms = { configured: () => true, lookupMessage: async ({ messageId, phone }) => {
    lookups++; assert.equal(messageId, 'provider-existing'); assert.equal(phone, '+61412345678');
    return { status: 'delivered', provider_message_id: messageId, error: null };
  } };
  const { request, records } = await api(t, { sms });
  const lead = records.leads[0]; lead.customer_phone = '0412345678';
  records.customer_messages = [{ _id: 'message-existing', lead_id: String(lead._id), dealership_name: lead.dealership_name, phone: '+61412345678', status: 'queued', body: 'Test', provider_message_id: 'provider-existing', created_at: '2026-10-19T01:00:00Z' }];
  const result = await request(`/leads/${lead._id}/messages`);
  assert.equal(result.body.data.messages[0].status, 'delivered');
  assert.equal(records.customer_messages[0].status, 'delivered');
  await request(`/leads/${lead._id}/messages`);
  assert.equal(lookups, 1);
});

test('customer history includes only Sales Floor messages even when other platform data exists', async (t) => {
  let otherPlatformQueried = false;
  const { request, records, user } = await api(t, { historySources: { delivery: async () => { otherPlatformQueried = true; throw new Error('Must not be read'); }, leadCentre: async () => { otherPlatformQueried = true; throw new Error('Must not be read'); } } });
  const lead = records.leads[0]; lead.customer_phone = '+61412345678';
  records.customer_messages = [{ _id: 'salesfloor-1', lead_id: String(lead._id), dealership_name: lead.dealership_name, phone: '+61412345678', body: 'Booran text', status: 'delivered' }];
  records.messages = [{ _id: 'delivery-1', phone: '+61412345678', body: 'Delivery Centre text', status: 'delivered', site: lead.dealership_name }];
  records.conversations = [{ _id: 'thread-1', phone: '+61412345678', dealer: lead.dealership_name, messages: [{ id: 'legacy-1', text: 'Lead Centre text', sender: 'user' }] }];
  for (const role of ['manager', 'super_admin']) {
    user.role = role;
    const result = await request('/leads/' + lead._id + '/messages');
    assert.deepEqual(result.body.data.messages.map(row => row.body), ['Booran text']);
    assert.equal(result.body.data.messages[0].source, 'Sales Floor');
    assert.equal(result.body.pagination.total, 1);
  }
  assert.equal(otherPlatformQueried, false);
});

test('provider lookup failure preserves saved Sales Floor messages and the last known status', async (t) => {
  const { request, records } = await api(t, { sms: { configured: () => true, lookupMessage: async () => { throw new Error('Provider unavailable'); } } });
  const lead = records.leads[0]; lead.customer_phone = '0412345678';
  records.customer_messages = [{ _id: 'local-1', lead_id: String(lead._id), dealership_name: lead.dealership_name, body: 'Saved locally', phone: '+61412345678', status: 'queued' }];
  const result = await request('/leads/' + lead._id + '/messages');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.messages[0].body, 'Saved locally');
  assert.equal(result.body.data.messages[0].status, 'queued');
  assert.match(result.body.data.history_warning, /Delivery status could not be refreshed/);
});

test('Sales Floor history pagination retains older app messages and same-phone prior lead records', async (t) => {
  const { request, records } = await api(t);
  const lead = records.leads[0]; lead.customer_phone = '0412345678';
  records.customer_messages = Array.from({ length: 25 }, (_, index) => ({ _id: `message-${index}`, lead_id: 'prior-lead-record', dealership_name: lead.dealership_name, phone: index % 2 ? '0412 345 678' : '+61412345678', body: `Text ${index}`, status: 'delivered', created_at: new Date(Date.UTC(2026, 9, 1, index)).toISOString() }));
  const first = await request(`/leads/${lead._id}/messages`);
  const older = await request(`/leads/${lead._id}/messages?page=2`);
  assert.equal(first.body.pagination.total, 25);
  assert.equal(first.body.data.messages.length, 20);
  assert.equal(older.body.data.messages.length, 5);
  assert.equal(older.body.data.messages[4].body, 'Text 0');
});

test('lead numbers can be added, edited and cleared without changing historic SMS recipients', async (t) => {
  const { request, records } = await api(t);
  const lead = records.leads[0];
  let result = await request(`/leads/${lead._id}`, { method: 'PATCH', body: JSON.stringify({ customer_phone: '0412 345 678' }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.phone, '+61412345678');
  records.customer_messages = [{ _id: 'before-phone-edit', lead_id: String(lead._id), dealership_name: lead.dealership_name, phone: '+61412345678', body: 'Historical SMS', status: 'delivered' }];
  result = await request(`/leads/${lead._id}`, { method: 'PATCH', body: JSON.stringify({ customer_phone: '+61 499 918 523' }) });
  assert.equal(result.body.data.phone, '+61499918523');
  const history = await request(`/leads/${lead._id}/messages`);
  assert.equal(history.body.data.messages[0].phone, '+61412345678');
  assert.equal((await request(`/leads/${lead._id}`, { method: 'PATCH', body: JSON.stringify({ customer_phone: 'not-a-number' }) })).status, 400);
  assert.equal(lead.customer_phone, '+61499918523');
  assert.equal((await request(`/leads/${records.leads[2]._id}`, { method: 'PATCH', body: JSON.stringify({ customer_phone: '0412345678' }) })).status, 404);
  result = await request(`/leads/${lead._id}`, { method: 'PATCH', body: JSON.stringify({ customer_phone: '' }) });
  assert.equal(result.body.data.phone, '');
});

test('MongoDB media uploads produce a real viewer and bounded binary photo/video ranges', async (t) => {
  const { createMediaStorage } = require('../lib/mongo-media-storage');
  const chunks = {};
  const storage = createMediaStorage(async () => fixtureDb(chunks), 'mongodb');
  const { request, records, baseUrl } = await api(t, { storage });
  const lead = records.leads[0];
  const length = 2 * 1024 * 1024;
  const bytes = Buffer.alloc(length + 10, 255); bytes[0] = 0; bytes[length + 9] = 128;
  const prepared = await request(`/leads/${lead._id}/media`, { method: 'POST', body: JSON.stringify({ name: 'vehicle.mp4', content_type: 'video/mp4', size: bytes.length }) });
  assert.equal(prepared.status, 201);
  assert.equal(records.message_media[0].storage_backend, 'mongodb');
  const contentPath = `/leads/${lead._id}/media/${prepared.body.data.id}/content`;
  const url = `${baseUrl}/media/${records.message_media[0].share_token}`;
  assert.equal((await fetch(url)).status, 404);
  const chunkSize = prepared.body.data.upload.chunk_size;
  assert.equal(chunkSize, 256 * 1024);
  assert.equal((await request(contentPath + '?offset=0', { method: 'PUT', body: bytes.subarray(0, chunkSize), headers: { 'content-type': 'application/octet-stream' } })).status, 200);
  assert.equal((await request(contentPath + '?offset=0', { method: 'PUT', body: bytes.subarray(0, chunkSize), headers: { 'content-type': 'application/octet-stream' } })).status, 200);
  assert.equal((await request(contentPath + '?offset=0', { method: 'PUT', body: Buffer.alloc(chunkSize, 0), headers: { 'content-type': 'application/octet-stream' } })).status, 409);
  assert.equal((await request(`/leads/${lead._id}/media/${prepared.body.data.id}/complete`, { method: 'POST', body: '{}' })).status, 400);
  for (let offset = chunkSize; offset < bytes.length; offset += chunkSize) assert.equal((await request(contentPath + `?offset=${offset}`, { method: 'PUT', body: bytes.subarray(offset, offset + chunkSize), headers: { 'content-type': 'application/octet-stream' } })).status, 200);
  assert.equal((await request(`/leads/${lead._id}/media/${prepared.body.data.id}/complete`, { method: 'POST', body: '{}' })).status, 200);
  const viewer = await fetch(url);
  assert.equal(viewer.status, 200);
  const html = await viewer.text();
  assert.match(html, /<video controls/);
  assert.match(html, /Booran Sales Floor/);
  assert.ok(viewer.headers.get('content-security-policy').includes('frame-ancestors'));
  const binary = await fetch(url + '/content');
  assert.equal(binary.status, 206);
  assert.equal((await binary.arrayBuffer()).byteLength, length);
  const range = await fetch(url + '/content', { headers: { Range: `bytes=${length - 2}-${length + 9}` } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(length - 2));
  assert.equal((await fetch(url + '/content', { headers: { Range: `bytes=${bytes.length}-` } })).status, 416);
  assert.equal((await request(contentPath + '?offset=0', { method: 'PUT', body: bytes.subarray(0, length), headers: { 'content-type': 'application/octet-stream' } })).status, 404);
});
