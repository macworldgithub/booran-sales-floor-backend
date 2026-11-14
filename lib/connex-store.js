const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createLead, serializeLead } = require('./records');
const { normalisePhone, formatToPlus61, phoneKey } = require('./phone');
const { createUniqueLead, updateUniqueMobile, refreshSourceAlias } = require('./lead-identity');
const { canAccessSite } = require('./roles');
const { transferAssignedWork } = require('./lead-allocation');
const { SITE, DEALER_CODE, STATUSES, opportunityId, opportunityUrl, portalDate, crmStatus } = require('./connex-policy');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceId = id => new ObjectId(hash(['connex', SITE.toLowerCase(), id]).slice(0, 24));
const recordKey = id => `connex:record:${id}`;
const normal = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function phone(value) {
  if (!value) return '';
  try { return normalisePhone(value); } catch { const landline = formatToPlus61(value); return /^\+61[2378]\d{8}$/.test(landline) ? landline : ''; }
}
function normaliseSnapshot(input, { emailStub = false, now = new Date() } = {}) {
  const id = opportunityId(input.recordId || input.url);
  if (!id) throw Object.assign(new Error('Invalid Connex opportunity reference.'), { status: 400 });
  if ((!emailStub && (input.dealership !== SITE || input.dealerCode !== DEALER_CODE)) || input.dealership && input.dealership !== SITE) {
    throw Object.assign(new Error('Connex opportunity belongs to another dealership.'), { code: 'CONNEX_SCOPE', status: 403 });
  }
  const stage = input.stage || (emailStub ? 'Distributed' : '');
  if (!STATUSES.includes(stage)) throw Object.assign(new Error('Invalid Connex opportunity status.'), { status: 400 });
  const text = (key, max = 200) => typeof input[key] === 'string' ? input[key].trim().slice(0, max) : '';
  const email = text('email', 254);
  return { recordId: id, url: opportunityUrl(id), dealership: SITE, dealerCode: DEALER_CODE, stage,
    opportunityName: text('opportunityName') || id, name: text('name'), phone: phone(input.phone),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : '', vehicle: text('vehicle'),
    type: text('type'), subStatus: text('subStatus'), salesperson: text('salesperson'), lostReason: text('lostReason'),
    summary: text('summary', 5000), comments: text('comments', 5000), latestNote: text('latestNote', 5000),
    distributedAt: portalDate(input.distributedAt), createdAt: portalDate(input.createdAt), acceptedAt: portalDate(input.acceptedAt),
    qualifiedAt: portalDate(input.qualifiedAt), observedAt: now.toISOString(), emailStub };
}
async function resolveLead(db, record) {
  const id = sourceId(record.recordId), leads = db.collection('leads');
  let lead = await leads.findOne({ dealership_name: SITE, $or: [{ _id: id }, { 'external.record_id': record.recordId },
    { source: 'Connex', 'external.id': { $in: [record.recordId, record.opportunityName].filter(Boolean) } }] });
  if (!lead) {
    const alias = await db.collection('lead_source_links').findOne({ _id: String(id) });
    if (alias && ObjectId.isValid(alias.lead_id)) lead = await leads.findOne({ _id: new ObjectId(alias.lead_id), dealership_name: SITE });
  }
  const visited = new Set();
  while (lead?.merged_into) {
    if (!ObjectId.isValid(lead.merged_into) || visited.has(String(lead._id))) return null;
    visited.add(String(lead._id));
    lead = await leads.findOne({ _id: new ObjectId(lead.merged_into), dealership_name: SITE });
  }
  return lead;
}
async function mappedStaff(db, sourceName) {
  if (!sourceName) return null;
  const settings = await db.collection('integration_sync').findOne({ _id: 'connex:settings', dealership: SITE });
  const users = await db.collection('users').find({ active: true }).toArray();
  const candidates = users.filter(user => !['super_admin', 'contractor'].includes(user.role) && canAccessSite(user, SITE) &&
    normal(settings?.staffMap?.[String(user._id)] || user.name) === normal(sourceName));
  return candidates.length === 1 ? candidates[0] : null;
}
async function ingestSnapshot(db, input, options = {}) {
  const now = options.now || new Date(), snapshot = normaliseSnapshot(input, { ...options, now });
  const state = db.collection('integration_sync'), key = recordKey(snapshot.recordId);
  const previous = await state.findOne({ _id: key });
  // A repeated notification must not put a previously revealed opportunity back behind the mask.
  if (snapshot.emailStub && previous?.snapshot && !previous.snapshot.emailStub) {
    return { recordId: snapshot.recordId, leadId: previous.lead_id || null, outcome: previous.outcome, replay: true };
  }
  const id = sourceId(snapshot.recordId), date = snapshot.createdAt || snapshot.distributedAt || previous?.first_seen_at?.toISOString?.() || now.toISOString();
  const staff = await mappedStaff(db, snapshot.salesperson);
  const external = { source: 'connex', id: snapshot.recordId, record_id: snapshot.recordId, url: snapshot.url,
    opportunity_status: snapshot.stage, details_revealed: Boolean(snapshot.phone || snapshot.email), received_at: now.toISOString() };
  const incoming = { ...createLead({ name: snapshot.name || `Connex enquiry ${snapshot.opportunityName}`, phone: snapshot.phone,
    email: snapshot.email, dealership: SITE, source: 'Connex', owner_name: staff?.name || 'Unassigned',
    vehicle_make: 'Hyundai', vehicle_model: snapshot.vehicle, status: crmStatus(snapshot.stage),
    notes: [snapshot.summary, snapshot.comments].filter(Boolean).join('\n').slice(0, 5000) }, { name: 'Connex integration' }),
    _id: id, deal_id: `CONNEX-${snapshot.recordId}`, external, owner_id: staff ? String(staff._id) : null,
    ...(staff ? { owner_source: 'connex', assigned_at: now } : {}), created_at: date, createdAt: new Date(date) };
  let existing = await resolveLead(db, snapshot), lead = existing, outcome = 'updated', reviewId = null;
  if (!existing) {
    const result = await createUniqueLead(db, incoming, { name: 'Connex integration' }, true);
    if (result.duplicate) { outcome = 'merge_review'; reviewId = result.requestId; }
    else { lead = result.lead; outcome = result.inserted ? 'inserted' : 'updated'; }
  } else {
    const collection = db.collection('leads'), ownSource = String(existing._id) === String(id) || existing.source === 'Connex' &&
      [snapshot.recordId, snapshot.opportunityName].includes(existing.external?.id);
    if (!ownSource) await refreshSourceAlias(db, String(existing._id), incoming);
    else {
      const metadata = { ...external, id: existing.external?.id || snapshot.recordId,
        details_revealed: external.details_revealed || existing.external?.details_revealed === true };
      await collection.findOneAndUpdate({ _id: existing._id, dealership_name: SITE, merged_into: { $exists: false } }, { $set: { external: metadata } });
      const details = { customer_name: snapshot.name, customer_email: snapshot.email, vehicle_model: snapshot.vehicle };
      if (!existing.booran_edited_fields?.includes('status') && existing.loss_review?.status !== 'pending' &&
        (!previous?.snapshot || existing.status === crmStatus(previous.snapshot.stage))) details.status = crmStatus(snapshot.stage);
      for (const [field, value] of Object.entries(details)) if (value && !existing.booran_edited_fields?.includes(field)) {
        await collection.findOneAndUpdate({ _id: existing._id, dealership_name: SITE, merged_into: { $exists: false },
          booran_edited_fields: { $ne: field }, ...(field === 'status' ? { 'loss_review.status': { $ne: 'pending' } } : {}) }, { $set: { [field]: value } });
      }
      if (snapshot.phone && !existing.booran_edited_fields?.includes('customer_phone') && snapshot.phone !== existing.customer_phone &&
        (!phoneKey(snapshot.phone) || phoneKey(snapshot.phone) !== phoneKey(existing.customer_phone))) {
        const result = await updateUniqueMobile(db, existing, snapshot.phone, { name: 'Connex integration' }, session =>
          collection.findOneAndUpdate({ _id: existing._id, dealership_name: SITE, merged_into: { $exists: false },
            customer_phone: existing.customer_phone ?? null, booran_edited_fields: { $ne: 'customer_phone' } },
          { $set: { customer_phone: snapshot.phone } }, { session, returnDocument: 'after' }));
        if (result.duplicate) { outcome = 'merge_review'; reviewId = result.requestId; }
      }
      if (staff && !existing.assigned_by && !existing.booran_edited_fields?.includes('owner_name') && (!existing.owner_id || existing.owner_source === 'connex') && String(existing.owner_id || '') !== String(staff._id)) {
        await db.client.withSession(session => session.withTransaction(async () => {
          const changed = await collection.findOneAndUpdate({ _id: existing._id, owner_id: existing.owner_id ?? null,
            assigned_by: { $exists: false }, dealership_name: SITE, merged_into: { $exists: false } },
          { $set: { owner_id: String(staff._id), owner_name: staff.name, owner_source: 'connex', assigned_at: now } }, { session, returnDocument: 'after' });
          if (changed) await transferAssignedWork(db, existing, String(staff._id), staff.name, session);
        }));
      }
    }
    lead = await collection.findOne({ _id: existing._id });
  }
  await state.findOneAndUpdate({ _id: key }, { $set: { kind: 'connex_record', dealership: SITE, recordId: snapshot.recordId,
    snapshot, lead_id: lead ? String(lead._id) : null, outcome, merge_request_id: reviewId,
    last_pull_at: now, detailsPending: !Boolean(snapshot.phone || snapshot.email) }, $setOnInsert: { first_seen_at: now } }, { upsert: true });
  return { recordId: snapshot.recordId, leadId: lead ? String(lead._id) : null, outcome, mergeRequestId: reviewId,
    lead: lead ? serializeLead(lead) : null };
}
async function recordsForLead(db, lead) {
  const references = [lead.external, ...(lead.source_refs || []).filter(ref => ref.source === 'Connex').map(ref => ref.external)].filter(Boolean);
  const ids = references.filter(ref => ref.source === 'connex').map(ref => opportunityId(ref.record_id || ref.id)).filter(Boolean);
  const rows = await db.collection('integration_sync').find({ kind: 'connex_record', dealership: SITE,
    $or: [{ lead_id: String(lead._id) }, { recordId: { $in: ids } }] }).toArray();
  return rows;
}
module.exports = { sourceId, recordKey, normaliseSnapshot, ingestSnapshot, resolveLead, recordsForLead, mappedStaff, hash };
