const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { text } = require('./query');
const { formatToPlus61 } = require('./phone');
const { ROLES, canAccessSite } = require('./roles');
const { transferAssignedWork } = require('./lead-allocation');
const { upsertImportedLeads, updateUniqueMobile } = require('./lead-identity');
const { phoneKey } = require('./phone');

const SITE = 'South Morang Hyundai';
const INTERVAL = 60_000;
const PROSPECT_CHANNEL = 'SMS Campaign South Morang prospects';
const validId = (value) => typeof value === 'string' && /^[\w:-]{1,120}$/.test(value);
const normaliseName = value => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Hyundai's feed contains both display surnames and DealerSocket login IDs.
const OWNER_ALIASES = new Map([
  ['libreri', 'kris liberi'], ['s7xisaacb', 'isaac bugeja'],
  ['s7xgsimo', 'george simogiannis'], ['s7xkhanc', 'khan cetin'],
]);
const referenceId = value => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
const normaliseStage = value => text(value).replace(/^\d+\s*[-:]\s*/, '').toLowerCase();
const stageStatus = value => ['lost', 'closed', 'cancelled', 'canceled'].includes(normaliseStage(value)) ? 'lost' :
  ['sold', 'delivered'].includes(normaliseStage(value)) ? 'sold' : !normaliseStage(value) || normaliseStage(value) === 'unqualified' ? 'new_lead' : 'following_up';
const franchiseKey = row => `${referenceId(row.site)}:${text(row.franchise).toLowerCase().replace(/\s+/g, ' ')}`;
const DEALERSHIPS = new Map([
  ['10755:south morang kia', 'South Morang Kia'],
  ['10755:south morang kia used cars', 'South Morang Kia'],
  ['10755:chery south morang', 'Chery South Morang'],
  ['10876:south morang hyundai', SITE],
  ['10876:south morang hyundai used cars', SITE],
  ['10876:south morang hyundai new cars', SITE],
]);

async function resolveSmsCampaignDatabase(target, connect, env = process.env) {
  const dedicated = env.MONGODB_URI_SMS_CAMPAIGN?.trim();
  const setting = dedicated || env.SMS_CAMPAIGN_DB_NAME?.trim();
  if (!setting) throw new Error('Configure the SMS Campaign database connection.');
  const isUri = /^mongodb(?:\+srv)?:\/\//.test(setting);
  if (dedicated && !isUri) throw new Error('MONGODB_URI_SMS_CAMPAIGN must be a MongoDB connection URI.');
  if (isUri && setting === env.MONGODB_URI_FLWUP?.trim()) throw new Error('Expected a separate SMS Campaign database.');
  const source = isUri
    ? await connect(dedicated ? 'MONGODB_URI_SMS_CAMPAIGN' : 'SMS_CAMPAIGN_DB_NAME')
    : target.client.db(setting);
  if (source.client === target.client && source.databaseName === target.databaseName) {
    throw new Error('Expected a separate SMS Campaign database.');
  }
  return source;
}

function leadOperation({ key, source, channel, name, phone, email, date, stage = '', status, sourceOwner, snapshotAt,
  siteId = '10876', dealership = SITE, contactId, franchise, vehicle }, now) {
  if (!validId(key)) return null;
  const createdAt = new Date(date ?? '');
  if (!Number.isFinite(createdAt.getTime())) return null;
  const dealId = `${source === 'SMS Campaign' ? 'SMS-CAMPAIGN' : `DEALERSOCKET-${siteId}`}-${key}`;
  const id = new ObjectId(createHash('sha256').update(dealId).digest('hex').slice(0, 24));
  return { updateOne: {
    filter: { _id: id },
    update: {
      $set: { sms_campaign: { channel, stage, ...(source === 'DealerSocket' ? {
        assigned_salesperson: sourceOwner, snapshot_at: snapshotAt, synced_at: now.toISOString(),
        active: !['lost', 'sold', 'delivered', 'closed', 'cancelled', 'canceled'].includes(normaliseStage(stage)),
        site_id: siteId, contact_id: contactId, franchise,
      } : {}) } },
      // Campaign metadata can change while Sales Floor staff own the lead's follow-up and assignment.
      $setOnInsert: {
        deal_id: dealId, dealership_name: dealership, dealer_code: 'BOORAN', source,
        customer_name: name, customer_phone: formatToPlus61(text(phone)), customer_email: text(email, 254),
        ...(vehicle ? { vehicle_model: vehicle } : {}),
        status, owner_name: 'Unassigned', follow_ups_sent: 0, diary_entries: [],
        created_at: createdAt.toISOString(), createdAt, updatedAt: now,
      },
    },
    upsert: true,
  } };
}

async function syncRegistrations(source, target, now) {
  const rows = await source.collection('leads').find({}, {
    projection: { id: 1, firstName: 1, lastName: 1, mobile: 1, email: 1, createdAt: 1 },
  }).sort({ createdAt: -1, _id: -1 }).limit(500).toArray();
  return upsertLeads(target, rows.map(row => leadOperation({
    key: row.id, source: 'SMS Campaign', channel: 'Campaign landing page',
    name: [text(row.firstName), text(row.lastName)].filter(Boolean).join(' '),
    phone: row.mobile, email: row.email, date: row.createdAt, status: 'new_lead',
  }, now)));
}

async function syncOpportunities(source, target, now) {
  const prospects = await source.collection('south_morang_prospects').find({}).toArray();
  if (prospects.length) return syncSouthMorangProspects(source, target, prospects, now);
  if (await target.collection('leads').findOne({ source: 'DealerSocket', 'sms_campaign.channel': PROSPECT_CHANNEL })) {
    throw new Error('The South Morang prospect feed is empty. Keeping the last imported records.');
  }
  const saved = await source.collection('settings').findOne({ key: 'chrome-snapshot' }, { projection: { value: 1 } });
  if (!saved) return 0;
  const snapshot = JSON.parse(saved.value);
  if (snapshot?.scope !== 'south_morang_hyundai' || snapshot.readOnly !== true || !Array.isArray(snapshot.records)) {
    throw new Error('Invalid South Morang Hyundai snapshot');
  }
  const operations = snapshot.records.filter(row => row?.dealership_id === '10876' && row.rooftop === SITE).map(row => {
    const stage = text(row.opportunity_status);
    const status = stageStatus(stage);
    return leadOperation({
      key: row.opportunity_id, source: 'DealerSocket', channel: 'SMS Campaign snapshot',
      name: text(row.customer_name), phone: row.customer_phone, email: row.customer_email,
      date: row.list_observed_at || snapshot.fetchedAt, stage, status,
      sourceOwner: text(row.assigned_salesperson), snapshotAt: snapshot.fetchedAt,
    }, now);
  });
  return (await syncDealerSocketOperations(target, operations, now)).imported;
}

async function syncSouthMorangProspects(source, target, prospects, now) {
  const rows = prospects.filter(row => DEALERSHIPS.has(franchiseKey(row)));
  if (!rows.length || rows.some(row => !validId(referenceId(row.id)) || !Number.isFinite(Date.parse(row.capturedAt)))) {
    throw new Error('The South Morang prospect feed has no valid scope or capture date.');
  }
  const ids = [...new Set(rows.map(row => referenceId(row.contactId)).filter(Boolean))];
  const contacts = ids.length ? await source.collection('contacts').find({ dealerSocketContactId: { $in: [...ids,
    ...ids.filter(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))).map(Number)] } },
    { projection: { dealerSocketContactId: 1, firstName: 1, lastName: 1, mobile: 1, email: 1, emailAddress: 1,
      mobilePhone: 1, site: 1, siteId: 1 } }).toArray() : [];
  const contactsById = new Map();
  for (const contact of contacts) {
    const key = referenceId(contact.dealerSocketContactId);
    if (!contactsById.has(key)) contactsById.set(key, []);
    contactsById.get(key).push(contact);
  }
  const operations = rows.map(row => {
    const dealership = DEALERSHIPS.get(franchiseKey(row));
    const matching = (contactsById.get(referenceId(row.contactId)) || []).filter(contact => {
      const name = normaliseName(row.name), fullName = normaliseName(`${text(contact.firstName)} ${text(contact.lastName)}`);
      if (contact.site || contact.siteId) if (referenceId(contact.site || contact.siteId) !== referenceId(row.site)) return false;
      return fullName === name || (name.includes('no last name') && name.replace(/\s*no last name\s*/g, '').trim() === normaliseName(contact.firstName));
    });
    const stage = text(row.status);
    return leadOperation({
      key: referenceId(row.id), siteId: referenceId(row.site), dealership, source: 'DealerSocket', channel: PROSPECT_CHANNEL,
      name: text(row.name), phone: text(row.customer_phone || row.mobile || row.mobilePhone) || (matching.length === 1 ? matching[0].mobile || matching[0].mobilePhone : undefined),
      email: text(row.customer_email || row.email) || (matching.length === 1 ? matching[0].email || matching[0].emailAddress : undefined),
      vehicle: text(row.vehicle), contactId: referenceId(row.contactId), franchise: text(row.franchise),
      date: row.capturedAt, snapshotAt: new Date(row.capturedAt).toISOString(), stage,
      status: stageStatus(stage),
      sourceOwner: text(row.assignee),
    }, now);
  });
  const { imported, byId } = await syncDealerSocketOperations(target, operations, now);
  const details = operations.flatMap(operation => {
    const row = operation.updateOne.update.$setOnInsert;
    const existing = byId.get(String(operation.updateOne.filter._id));
    return ['customer_name', 'customer_phone', 'customer_email', 'vehicle_model', 'status'].filter(field => row[field] &&
      existing?.[field] !== row[field] && !existing?.booran_edited_fields?.includes(field) &&
      (field !== 'status' || existing?.loss_review?.status !== 'pending')).map(field => ({
      updateOne: { filter: { ...operation.updateOne.filter, merged_into: { $exists: false }, booran_edited_fields: { $ne: field },
        ...(field === 'status' ? { 'loss_review.status': { $ne: 'pending' } } : {}) },
        update: { $set: { [field]: row[field] } } },
    }));
  });
  const phoneUpdates = details.filter(operation => Object.hasOwn(operation.updateOne.update.$set, 'customer_phone'));
  for (const operation of phoneUpdates) {
    const lead = byId.get(String(operation.updateOne.filter._id));
    if (!lead || lead.merged_into) continue;
    const phone = operation.updateOne.update.$set.customer_phone;
    if (phoneKey(phone) === phoneKey(lead.customer_phone)) continue;
    await updateUniqueMobile(target, lead, phone, { name: 'DealerSocket import' }, session =>
      target.collection('leads').findOneAndUpdate(operation.updateOne.filter, operation.updateOne.update, { session, returnDocument: 'after' }));
  }
  const otherDetails = details.filter(operation => !Object.hasOwn(operation.updateOne.update.$set, 'customer_phone'));
  for (let offset = 0; offset < otherDetails.length; offset += 250) {
    await target.collection('leads').bulkWrite(otherDetails.slice(offset, offset + 250), { ordered: false });
  }
  const snapshotAt = operations.map(operation => operation.updateOne.update.$set.sms_campaign.snapshot_at).sort().at(-1);
  await target.collection('leads').updateMany({
    source: 'DealerSocket', dealership_name: { $in: [...new Set(DEALERSHIPS.values())] },
    'sms_campaign.active': { $ne: false },
    _id: { $nin: operations.map(operation => operation.updateOne.filter._id) },
    $or: [{ 'sms_campaign.snapshot_at': { $lte: snapshotAt } }, { 'sms_campaign.snapshot_at': { $exists: false } }],
  }, { $set: { 'sms_campaign.active': false, 'sms_campaign.retired_at': now.toISOString(), 'sms_campaign.synced_at': now.toISOString() } });
  await Promise.all([...new Set(rows.map(row => DEALERSHIPS.get(franchiseKey(row))))].map(async dealership => {
    const siteOps = operations.filter(operation => operation.updateOne.update.$setOnInsert.dealership_name === dealership);
    const [stats] = await target.collection('leads').aggregate([
      { $match: { _id: { $in: siteOps.map(operation => operation.updateOne.filter._id) }, merged_into: { $exists: false } } },
      { $group: { _id: null, customers: { $sum: 1 }, missingPhone: { $sum: { $cond: [{ $in: [{ $ifNull: ['$customer_phone', ''] }, ['']] }, 1, 0] } },
        missingEmail: { $sum: { $cond: [{ $in: [{ $ifNull: ['$customer_email', ''] }, ['']] }, 1, 0] } },
        unassigned: { $sum: { $cond: [{ $in: [{ $ifNull: ['$owner_id', ''] }, ['']] }, 1, 0] } } } },
    ]).toArray();
    await target.collection('integration_sync').findOneAndUpdate({ _id: `sms_campaign:${dealership}` }, { $set: {
      dealership, kind: 'dealersocket', sourceRecords: siteOps.length,
      sourceActive: siteOps.filter(operation => operation.updateOne.update.$set.sms_campaign.active).length,
      sourceMissingOwner: siteOps.filter(operation => !operation.updateOne.update.$set.sms_campaign.assigned_salesperson).length,
      customers: stats?.customers || 0, missingPhone: stats?.missingPhone || 0, missingEmail: stats?.missingEmail || 0,
      unassigned: stats?.unassigned || 0, snapshotAt, last_success: now, error: null,
    } }, { upsert: true });
  }));
  return imported;
}

async function syncDealerSocketOperations(target, rows, now) {
  const operations = [...new Map(rows.filter(Boolean).map(operation => [String(operation.updateOne.filter._id), operation])).values()];
  const ids = operations.map(operation => operation.updateOne.filter._id);
  const [existing, users] = await Promise.all([
    target.collection('leads').find({ _id: { $in: ids } }, { batchSize: 1000, projection: {
      _id: 1, deal_id: 1, dealership_name: 1, customer_name: 1, customer_phone: 1, customer_email: 1, vehicle_model: 1,
      status: 1, sms_campaign: 1, owner_id: 1, owner_name: 1, owner_source: 1, assigned_by: 1,
      merged_into: 1, process_revision: 1, loss_review: 1, booran_edited_fields: 1,
    } }).toArray(),
    target.collection('users').find({ active: true }, { projection: { name: 1, role: 1, site: 1, allowedSites: 1 } }).toArray(),
  ]);
  const staff = users.filter(user => ROLES.includes(user.role) && !['super_admin', 'contractor'].includes(user.role));
  const byId = new Map(existing.map(lead => [String(lead._id), lead]));
  const changed = operations.filter(operation => {
    const stored = byId.get(String(operation.updateOne.filter._id));
    if (stored?.merged_into) return true;
    const incoming = operation.updateOne.update.$set.sms_campaign;
    return !stored || Object.keys(incoming).some(key => key !== 'synced_at' && (stored.sms_campaign?.[key] ?? null) !== (incoming[key] ?? null));
  });
  await upsertLeads(target, changed);
  for (const operation of operations) {
    const id = String(operation.updateOne.filter._id);
    byId.set(id, { ...(byId.get(id) || { ...operation.updateOne.update.$setOnInsert, _id: operation.updateOne.filter._id }),
      sms_campaign: operation.updateOne.update.$set.sms_campaign });
  }
  for (let offset = 0; offset < operations.length; offset += 8) {
    const outcomes = await Promise.allSettled(operations.slice(offset, offset + 8).map(async operation => {
      const row = operation.updateOne.update.$setOnInsert;
      const sourceOwner = normaliseName(operation.updateOne.update.$set.sms_campaign.assigned_salesperson);
      const wanted = row.dealership_name === SITE ? OWNER_ALIASES.get(sourceOwner) || sourceOwner : sourceOwner;
      const candidates = staff.filter(user => {
        const name = normaliseName(user.name);
        return wanted && canAccessSite(user, row.dealership_name) &&
          (name === wanted || (!wanted.includes(' ') && name.split(' ').at(-1) === wanted));
      });
      await importAssignment(target, byId.get(String(operation.updateOne.filter._id)), candidates.length === 1 ? candidates[0] : null, now);
    }));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
  if (ids.length) await target.collection('leads').updateMany({ _id: { $in: ids } },
    { $set: { 'sms_campaign.synced_at': now.toISOString() } });
  return { imported: operations.length, byId };
}

async function importAssignment(db, lead, assignee, now) {
  if (!lead || lead.merged_into || lead.sms_campaign?.active === false || lead.loss_review?.status === 'pending' || lead.assigned_by ||
    (['sold', 'lost'].includes(lead.status) && lead.booran_edited_fields?.includes('status')) ||
    (lead.owner_id && lead.owner_source !== 'dealersocket')) return;
  const ownerId = assignee ? String(assignee._id) : null;
  if ((lead.owner_id || null) === ownerId) return;
  const ownerName = assignee?.name || 'Unassigned';
  await db.client.withSession(session => session.withTransaction(async () => {
    const changed = await db.collection('leads').findOneAndUpdate({
      _id: lead._id, owner_id: lead.owner_id ?? null, assigned_by: { $exists: false },
      process_revision: lead.process_revision ?? null,
    }, {
      $set: { owner_id: ownerId, owner_name: ownerName, owner_source: 'dealersocket', assigned_at: now,
        followup_days: [], next_action: null, updatedAt: now },
      $inc: { process_revision: 1 },
      $push: { diary_entries: { author: 'DealerSocket import', date: now.toISOString(),
        note: assignee ? `DealerSocket assignment imported for ${ownerName}.` : 'DealerSocket assignment needs manager allocation.' } },
    }, { returnDocument: 'after', session });
    if (changed) await transferAssignedWork(db, lead, ownerId, ownerName, session);
  }));
}

async function upsertLeads(target, operations) {
  const unique = new Map(operations.filter(Boolean).map(op => [String(op.updateOne.filter._id), op]));
  const batch = [...unique.values()];
  for (let offset = 0; offset < batch.length; offset += 250) {
    await upsertImportedLeads(target, batch.slice(offset, offset + 250));
  }
  return batch.length;
}

async function syncSmsCampaign(target, source, now = new Date()) {
  const [registrations, opportunities] = await Promise.allSettled([
    syncRegistrations(source, target, now), syncOpportunities(source, target, now),
  ]);
  return { registrations, opportunities };
}

module.exports = { INTERVAL, syncSmsCampaign, resolveSmsCampaignDatabase };
