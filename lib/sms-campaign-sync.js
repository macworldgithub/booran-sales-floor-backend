const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { text } = require('./query');
const { formatToPlus61 } = require('./phone');
const { ROLES, canAccessSite } = require('./roles');
const { transferAssignedWork } = require('./lead-allocation');

const SITE = 'South Morang Hyundai';
const INTERVAL = 60_000;
const validId = (value) => typeof value === 'string' && /^[\w:-]{1,120}$/.test(value);
const normaliseName = value => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Confirmed DealerSocket spelling for the existing Booran account.
const OWNER_ALIASES = new Map([['libreri', 'kris liberi']]);

function leadOperation({ key, source, channel, name, phone, email, date, stage = '', status, sourceOwner, snapshotAt }, now) {
  if (!validId(key)) return null;
  const createdAt = new Date(date ?? '');
  if (!Number.isFinite(createdAt.getTime())) return null;
  const dealId = `${source === 'SMS Campaign' ? 'SMS-CAMPAIGN' : 'DEALERSOCKET-10876'}-${key}`;
  const id = new ObjectId(createHash('sha256').update(dealId).digest('hex').slice(0, 24));
  return { updateOne: {
    filter: { _id: id },
    update: {
      $set: { sms_campaign: { channel, stage, ...(source === 'DealerSocket' ? {
        assigned_salesperson: sourceOwner, snapshot_at: snapshotAt, synced_at: now.toISOString(),
        active: !['lost', 'sold', 'delivered', 'closed', 'cancelled', 'canceled'].includes(stage.toLowerCase()),
      } : {}) } },
      // Campaign metadata can change while Sales Floor staff own the lead's follow-up and assignment.
      $setOnInsert: {
        deal_id: dealId, dealership_name: SITE, dealer_code: 'BOORAN', source,
        customer_name: name, customer_phone: formatToPlus61(text(phone)), customer_email: text(email, 254),
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
  const saved = await source.collection('settings').findOne({ key: 'chrome-snapshot' }, { projection: { value: 1 } });
  if (!saved) return 0;
  const snapshot = JSON.parse(saved.value);
  if (snapshot?.scope !== 'south_morang_hyundai' || snapshot.readOnly !== true || !Array.isArray(snapshot.records)) {
    throw new Error('Invalid South Morang Hyundai snapshot');
  }
  const operations = snapshot.records.filter(row => row?.dealership_id === '10876' && row.rooftop === SITE).map(row => {
    const stage = text(row.opportunity_status);
    const status = stage === 'Lost' ? 'lost' : !stage || stage === 'Unqualified' ? 'new_lead' : 'following_up';
    return leadOperation({
      key: row.opportunity_id, source: 'DealerSocket', channel: 'SMS Campaign snapshot',
      name: text(row.customer_name), phone: row.customer_phone, email: row.customer_email,
      date: row.list_observed_at || snapshot.fetchedAt, stage, status,
      sourceOwner: text(row.assigned_salesperson), snapshotAt: snapshot.fetchedAt,
    }, now);
  });
  const imported = await upsertLeads(target, operations);
  const staff = (await target.collection('users').find({ active: true }).toArray())
    .filter(user => ROLES.includes(user.role) && !['super_admin', 'contractor'].includes(user.role) && canAccessSite(user, SITE));
  for (const operation of operations.filter(Boolean)) {
    const sourceOwner = normaliseName(operation.updateOne.update.$set.sms_campaign.assigned_salesperson);
    const wanted = OWNER_ALIASES.get(sourceOwner) || sourceOwner;
    const candidates = staff.filter(user => {
      const name = normaliseName(user.name);
      return wanted && (name === wanted || (!wanted.includes(' ') && name.split(' ').at(-1) === wanted));
    });
    const assignee = candidates.length === 1 ? candidates[0] : null;
    await importAssignment(target, operation.updateOne.filter._id, assignee, now);
  }
  return imported;
}

async function importAssignment(db, id, assignee, now) {
  const lead = await db.collection('leads').findOne({ _id: id });
  if (!lead || lead.merged_into || lead.sms_campaign?.active === false || lead.loss_review?.status === 'pending' || lead.assigned_by ||
    (lead.owner_id && lead.owner_source !== 'dealersocket')) return;
  const ownerId = assignee ? String(assignee._id) : null;
  if ((lead.owner_id || null) === ownerId) return;
  const ownerName = assignee?.name || 'Unassigned';
  await db.client.withSession(session => session.withTransaction(async () => {
    const changed = await db.collection('leads').findOneAndUpdate({
      _id: id, owner_id: lead.owner_id ?? null, assigned_by: { $exists: false },
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
    await target.collection('leads').bulkWrite(batch.slice(offset, offset + 250), { ordered: false });
  }
  return batch.length;
}

async function syncSmsCampaign(target, source, now = new Date()) {
  const [registrations, opportunities] = await Promise.allSettled([
    syncRegistrations(source, target, now), syncOpportunities(source, target, now),
  ]);
  return { registrations, opportunities };
}

module.exports = { INTERVAL, syncSmsCampaign };
