const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { phoneKey, phonePattern } = require('./phone');
const { escapeRegex } = require('./query');
const { soldLeadCleanupFields } = require('./followup-policy');

const keyFor = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const siteMatch = site => ({ $regex: `^${escapeRegex(site.trim())}$`, $options: 'i' });

// A separate key collection allows old, conflicting records to stay available for
// manager review while serialising every new mobile claim across all entry points.
async function withMobileLock(db, site, phone, operation, email = '') {
  const key = phoneKey(phone);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.client.withSession(session => session.withTransaction(async () => {
        const keys = [key, email?.trim() ? `email:${email.trim().toLowerCase()}` : null].filter(Boolean).sort();
        for (const claim of keys) await db.collection('lead_mobile_keys').findOneAndUpdate(
          { _id: keyFor(site.trim().toLowerCase(), claim) },
          { $set: { touched_at: new Date() }, $inc: { version: 1 } }, { upsert: true, session },
        );
        return operation(session);
      }));
    } catch (error) {
      if (error.code !== 11000 || attempt >= 2) throw error;
    }
  }
}

async function mobileMatches(db, site, phone, session, exceptId) {
  if (!phoneKey(phone)) return [];
  return db.collection('leads').find({ dealership_name: siteMatch(site), merged_into: { $exists: false },
    $or: [{ customer_phone: { $regex: phonePattern(phone) } }, { alternate_phones: { $regex: phonePattern(phone) } }], ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }, { session }).sort({ created_at: 1, _id: 1 }).limit(50).toArray();
}
async function identityMatches(db, lead, session) {
  const byPhone = await mobileMatches(db, lead.dealership_name, lead.customer_phone, session);
  if (byPhone.length || !lead.customer_email?.trim()) return byPhone;
  const emailRx = { $regex: `^${escapeRegex(lead.customer_email.trim())}$`, $options: 'i' };
  return db.collection('leads').find({ dealership_name: siteMatch(lead.dealership_name), merged_into: { $exists: false },
    $or: [{ customer_email: emailRx }, { alternate_emails: emailRx }] }, { session }).sort({ created_at: 1, _id: 1 }).limit(50).toArray();
}
function sameIdentity(primary, incoming) {
  const normal = value => String(value || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const a = normal(primary.customer_name), b = normal(incoming.customer_name);
  const primaryEmails = new Set([primary.customer_email, ...(primary.alternate_emails || [])].map(e => String(e || '').trim().toLowerCase()).filter(Boolean));
  const incomingEmail = String(incoming.customer_email || '').trim().toLowerCase();
  const emailConflict = primaryEmails.size > 0 && incomingEmail && !primaryEmails.has(incomingEmail);
  const primaryPhones = new Set([primary.customer_phone, ...(primary.alternate_phones || [])].map(phoneKey).filter(Boolean));
  const incomingPhone = phoneKey(incoming.customer_phone);
  const phoneConflict = primaryPhones.size > 0 && incomingPhone && !primaryPhones.has(incomingPhone);
  return !emailConflict && !phoneConflict && (!a || !b || a === b);
}

async function flagDuplicate(db, lead, matches, actor, session) {
  const id = keyFor(lead.dealership_name, phoneKey(lead.customer_phone), String(lead._id || lead.deal_id || actor?.id || 'intake'));
  await db.collection('lead_merge_requests').findOneAndUpdate({ _id: id }, {
    $set: { dealership: lead.dealership_name, phone: lead.customer_phone, email: lead.customer_email, incoming: lead,
      candidate_ids: matches.map(row => String(row._id)), status: 'open', updatedAt: new Date(),
      requested_by: actor?.id || null, requested_name: actor?.name || 'Lead integration' },
    $setOnInsert: { createdAt: new Date() },
  }, { upsert: true, session });
  return { duplicate: true, requestId: id, matches };
}

function duplicateError(result, user) {
  const visible = result.matches.find(row => user?.canAllocate ||
    ['super_admin', 'manager', 'sales_manager', 'dealer_principal', 'general_manager'].includes(user?.role) || row.owner_id === user?.id);
  return Object.assign(new Error('This mobile already belongs to an existing prospect. A manager merge review has been requested.'), {
    status: 409, details: { mergeRequested: true, mergeRequestId: result.requestId,
      ...(visible ? { existingLeadId: String(visible._id) } : {}) },
  });
}

async function createUniqueLead(db, lead, actor, idempotent = false) {
  lead._id ||= new ObjectId();
  return withMobileLock(db, lead.dealership_name, lead.customer_phone, async session => {
    if (idempotent) {
      const existing = await db.collection('leads').findOne({ _id: lead._id }, { session });
      if (existing) {
        const primary=existing.merged_into?await canonicalLead(db.collection('leads'),{_id:existing._id},{session}):existing;
        if(!primary||primary.dealership_name.toLowerCase()!==lead.dealership_name.toLowerCase())throw Object.assign(new Error('A source identity cannot change dealership.'),{status:409});
        return { lead: primary, inserted: false };
      }
      const link = await db.collection('lead_source_links').findOne({ _id: String(lead._id) }, { session });
      if (link) { const primary = await canonicalLead(db.collection('leads'), { _id: new ObjectId(link.lead_id) }, { session }); if (primary) {
        if(primary.dealership_name.toLowerCase()!==lead.dealership_name.toLowerCase())throw Object.assign(new Error('A source identity cannot change dealership.'),{status:409});
        return { lead: primary, inserted: false, attached: true };
      } }
    }
    const matches = await identityMatches(db, lead, session);
    if (idempotent && matches.length === 1 && sameIdentity(matches[0], lead)) {
      const primary = await mergeIntoPrimary(db, matches[0], lead, { id: actor?.id || 'integration', name: actor?.name || 'Lead integration' }, session, { retire: false });
      return { lead: primary, inserted: false, attached: true };
    }
    if (matches.length) return flagDuplicate(db, lead, matches, actor, session);
    await db.collection('leads').insertOne(lead, { session });
    return { lead, inserted: true };
  }, lead.customer_email);
}

async function updateUniqueMobile(db, lead, phone, actor, operation) {
  return withMobileLock(db, lead.dealership_name, phone, async session => {
    const matches = await mobileMatches(db, lead.dealership_name, phone, session, lead._id);
    if (matches.length) return flagDuplicate(db, { ...lead, customer_phone: phone }, matches, actor, session);
    return { lead: await operation(session) };
  });
}

const empty = value => value === undefined || value === null || value === '';
function sourceReference(lead) {
  return { source: lead.source, deal_id: lead.deal_id, provider_id: String(lead._id),
    ...(lead.sms_campaign ? { sms_campaign: Object.fromEntries(Object.entries(lead.sms_campaign).filter(([key]) => key !== 'synced_at')) } : {}),
    ...(lead.nexgate ? { nexgate: Object.fromEntries(Object.entries(lead.nexgate).filter(([key]) => key !== 'synced_at')) } : {}),
    ...(lead.external ? { external: lead.external } : {}), ...(lead.inbound_email ? { inbound_email: lead.inbound_email } : {}) };
}
function missingDetails(primary, secondary) {
  const fields = {};
  for (const key of ['customer_phone', 'customer_email', 'customer_name', 'vehicle_make', 'vehicle_model', 'vehicle_year',
    'business_name', 'business_id', 'notes', 'test_drive', 'trade_in', 'latest_ppsr', 'post_sales_followup']) {
    if (empty(primary[key]) && !empty(secondary[key])) fields[key] = secondary[key];
  }
  return fields;
}

async function refreshSourceAlias(db, primaryId, incoming) {
  await withMobileLock(db, incoming.dealership_name, incoming.customer_phone, async session => {
    const primary = await db.collection('leads').findOne({ _id: new ObjectId(primaryId), merged_into: { $exists: false } }, { session });
    if (!primary) return;
    if (primary.dealership_name.toLowerCase() !== incoming.dealership_name.toLowerCase()) throw Object.assign(new Error('A source link cannot change dealership.'), { status: 409 });
    const ref = sourceReference(incoming);
    const refs = [...(primary.source_refs || []).filter(item => item.provider_id !== ref.provider_id), ref];
    const missing = missingDetails(primary, incoming);
    for (const field of primary.booran_edited_fields || []) delete missing[field];
    if (missing.customer_phone) {
      const matches = await mobileMatches(db, primary.dealership_name, missing.customer_phone, session, primary._id);
      if (matches.length) { await flagDuplicate(db, incoming, matches, undefined, session); delete missing.customer_phone; }
    }
    if (JSON.stringify(refs) === JSON.stringify(primary.source_refs) && !Object.keys(missing).length) return;
    await db.collection('leads').findOneAndUpdate({ _id: primary._id, process_revision: primary.process_revision ?? null }, {
      $set: { ...missing, source_refs: refs }, $inc: { process_revision: 1 },
    }, { session });
  });
}

function operationDocument(operation) {
  const { filter, update } = operation.updateOne;
  const lead = { ...update.$setOnInsert, _id: filter._id };
  for (const [key, value] of Object.entries(update.$set || {})) {
    const parts = key.split('.');
    let parent = lead;
    for (const field of parts.slice(0, -1)) parent = parent[field] ||= {};
    parent[parts.at(-1)] = value;
  }
  return lead;
}

async function upsertImportedLeads(db, operations) {
  if (!operations.length) return { upsertedCount: 0 };
  const ids = operations.map(op => op.updateOne.filter._id);
  const [existing, aliases] = await Promise.all([
    db.collection('leads').find({ _id: { $in: ids } }, { projection: { _id: 1, merged_into: 1 } }).toArray(),
    db.collection('lead_source_links').find({ _id: { $in: ids.map(String) } }).toArray(),
  ]);
  const found = new Map(existing.map(row => [String(row._id), row]));
  const linked = new Map(aliases.map(row => [String(row._id), row.lead_id]));
  const updates = [];
  let inserted = 0;
  for (const operation of operations) {
    const id = String(operation.updateOne.filter._id);
    const old = found.get(id);
    const primaryId = old?.merged_into || linked.get(id);
    if (primaryId) {
      await refreshSourceAlias(db, primaryId, operationDocument(operation));
      if (old) updates.push(operation);
    } else if (old) updates.push(operation);
    else {
      const result = await createUniqueLead(db, operationDocument(operation), undefined, true);
      if (result.inserted) inserted++;
    }
  }
  for (let offset = 0; offset < updates.length; offset += 250) await db.collection('leads').bulkWrite(updates.slice(offset, offset + 250), { ordered: false });
  return { upsertedCount: inserted };
}

const dealerSocketReference = lead => lead.source === 'DealerSocket' ? lead :
  (lead.source_refs || []).find(ref => ref.source === 'DealerSocket' && ref.sms_campaign?.active !== false);

async function canonicalLead(collection, query, options) {
  let lead = await collection.findOne(query, options);
  const visited = new Set();
  while (lead?.merged_into) {
    if (visited.has(String(lead._id)) || visited.size >= 10 || !ObjectId.isValid(lead.merged_into)) return null;
    visited.add(String(lead._id));
    lead = await collection.findOne({ _id: new ObjectId(lead.merged_into) }, options);
  }
  return lead;
}

async function mergeIntoPrimary(db, primary, secondary, actor, session, { retire = true, preserveExistingSources = false } = {}) {
  const now = new Date();
  const primaryId = String(primary._id), secondaryId = String(secondary._id);
  const sites = [...new Set([primary.dealership_name, secondary.dealership_name])];
  const aliases = retire ? await db.collection('leads').find({ dealership_name: primary.dealership_name,
    merged_into: secondaryId }, { session }).toArray() : [];
  const movedIds = [...new Set([secondaryId, ...(secondary.merged_lead_ids || []), ...aliases.map(row => String(row._id))])].filter(id => id !== primaryId);
  const incomingReferences = [...(secondaryId === primaryId ? [] : [sourceReference(secondary)]), ...(secondary.source_refs || [])];
  const references = preserveExistingSources ? [...incomingReferences, ...(primary.source_refs || [])] : [...(primary.source_refs || []), ...incomingReferences];
  const refs = [...new Map(references.map(ref => [ref.provider_id, ref])).values()];
  const notes = [...(primary.diary_entries || []), ...(secondary.diary_entries || [])];
  for (const note of [secondary.notes, secondary.nexgate?.comments]) {
    if (note && note !== primary.notes && !notes.some(entry => entry.note === note)) notes.push({ author: 'Merged enquiry', date: now.toISOString(), note });
  }
  const normEmail = value => typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
  const normPhone = value => { const key = phoneKey(value); return key ? `+${key}` : (typeof value === 'string' && value.trim() ? value.trim() : ''); };
  const isAssigned = doc => Boolean(doc?.owner_id || (typeof doc?.owner_name === 'string' && doc.owner_name.trim() && doc.owner_name.trim().toLowerCase() !== 'unassigned'));
  const carryAssignment = !isAssigned(primary) && isAssigned(secondary);
  const missing = missingDetails(primary, secondary);
  const survivingPhone = missing.customer_phone || primary.customer_phone || '';
  const survivingPhoneKey = phoneKey(survivingPhone);
  const survivingEmail = normEmail(missing.customer_email || primary.customer_email || '');

  const diary = [...new Map(notes.map(note => [JSON.stringify([note.author, note.note, note.date instanceof Date ? note.date.toISOString() : note.date]), note])).values()];
  diary.push({ author: actor.name, date: now.toISOString(), note: carryAssignment
    ? `Merged secondary ${secondary.deal_id || secondaryId} into primary ${primary.deal_id || primaryId}. Secondary assignee and status carried across to unassigned primary; customer details and linked history retained.`
    : `Merged secondary ${secondary.deal_id || secondaryId} into primary ${primary.deal_id || primaryId}. Missing customer details, additional contacts and linked history transferred; primary assignment and status retained.` });

  const fields = { ...missing, diary_entries: diary, source_refs: refs,
    activity_events: [...new Map([...(primary.activity_events || []), ...(secondary.activity_events || [])]
      .map(event => [JSON.stringify([event.author_id, event.author, event.date, event.kind]), event])).values()],
    merged_lead_ids: [...new Set([...(primary.merged_lead_ids || []), ...movedIds])], updatedAt: now,
    followup_days: [...new Set([...(primary.followup_days || []), ...(secondary.followup_days || [])])].sort(),
    alternate_phones: [...new Set([...(primary.alternate_phones || []), ...(secondary.alternate_phones || []), secondary.customer_phone]
      .map(normPhone).filter(val => val && (survivingPhoneKey ? phoneKey(val) !== survivingPhoneKey : val !== survivingPhone)))],
    alternate_emails: [...new Set([...(primary.alternate_emails || []), ...(secondary.alternate_emails || []), ...(typeof secondary.customer_email === 'string' ? secondary.customer_email.split(';') : [])]
      .map(normEmail).filter(val => val && val !== survivingEmail))],
  };
  if (carryAssignment) {
    if (secondary.owner_id !== undefined) fields.owner_id = secondary.owner_id;
    fields.owner_name = secondary.owner_name || 'Unassigned';
    if (secondary.assigned_at && !primary.assigned_at) fields.assigned_at = secondary.assigned_at;
    if (secondary.status) {
      fields.status = secondary.status;
      if (secondary.status === 'sold') {
        if (secondary.sold_at && !primary.sold_at) fields.sold_at = secondary.sold_at;
        if (secondary.delivery_date && !primary.delivery_date) fields.delivery_date = secondary.delivery_date;
        if (secondary.deal_number && !primary.deal_number) fields.deal_number = secondary.deal_number;
      }
      if (secondary.status === 'lost' && secondary.lost_at && !primary.lost_at) fields.lost_at = secondary.lost_at;
    }
  }
  if ((fields.status || primary.status) === 'sold' && primary.loss_review?.status === 'pending') {
    Object.assign(fields, soldLeadCleanupFields(primary, actor, now, 'Cleared automatically — merged with Sold deal'));
  }
  if (secondary.booran_opted_out === true || secondary.communication_consent?.opted_out === true) Object.assign(fields, { booran_opted_out: true, communication_consent: secondary.communication_consent || { opted_out: true, reason: 'Opt-out preserved from merged customer', changed_at: now.toISOString() } });
  if (Date.parse(secondary.trade_in_last_contact_at) > (Date.parse(primary.trade_in_last_contact_at) || 0)) {
    fields.trade_in_last_contact_at = secondary.trade_in_last_contact_at;
    fields.trade_in_contact_opportunity = secondary.trade_in_contact_opportunity;
  }
  if (secondary.trade_in_call_history?.length) fields.trade_in_call_history = [...new Map([...(primary.trade_in_call_history || []), ...secondary.trade_in_call_history].map(call => [call.request_id, call])).values()];
  for (const name of ['crm_contacts','crm_actions','stage_history']) if(secondary[name]?.length) fields[name]=[...new Map([...(primary[name]||[]),...secondary[name]].map(event=>[event.id || JSON.stringify(event),event])).values()];
  if (secondary.loss_review?.status === 'pending') {
    if (primary.loss_review || ['sold', 'lost'].includes(primary.status)) throw Object.assign(new Error('Resolve the secondary pending loss review before merging these records.'), { status: 409 });
    fields.loss_review = secondary.loss_review;
  }
  for (const name of ['next_action_review', 'consent_review']) if (secondary[name]?.status === 'pending') {
    if (primary[name] || name === 'next_action_review' && primary.next_action) throw Object.assign(new Error('Resolve the pending secondary approval before merging these records.'), {status:409});
    fields[name] = secondary[name];
  }
  if (!primary.next_action && secondary.next_action) fields.next_action = secondary.next_action;
  const changed = await db.collection('leads').findOneAndUpdate({ _id: primary._id, merged_into: { $exists: false },
    process_revision: primary.process_revision ?? null }, { $set: fields, $inc: { process_revision: 1 },
    $addToSet: { booran_edited_fields: { $each: Object.keys(missingDetails(primary, secondary)) } } }, { session, returnDocument: 'after' });
  if (!changed) throw Object.assign(new Error('The primary changed. Refresh before merging.'), { status: 409 });
  if (retire) {
    const retired = await db.collection('leads').findOneAndUpdate({ _id: secondary._id, merged_into: { $exists: false },
      process_revision: secondary.process_revision ?? null }, {
      $set: { merged_into: primaryId, merged_at: now, merged_by: actor.id }, $inc: { process_revision: 1 },
    }, { session, returnDocument: 'after' });
    if (!retired) throw Object.assign(new Error('The secondary changed. Refresh before merging.'), { status: 409 });
    await db.collection('leads').updateMany({ dealership_name: primary.dealership_name, merged_into: secondaryId },
      { $set: { merged_into: primaryId } }, { session });
  }
  for (const id of movedIds) await db.collection('lead_source_links').findOneAndUpdate({ _id: id },
    { $set: { lead_id: primaryId, dealership: primary.dealership_name, linked_at: now, linked_by: actor.id } }, { upsert: true, session });
  await db.collection('lead_source_links').updateMany({ lead_id: { $in: movedIds } }, { $set: { lead_id: primaryId } }, { session });
  for (const name of ['sales_tasks', 'deals', 'deliveries', 'appraisals', 'sales_alerts', 'trade_in_opportunities', 'service_bookings']) await db.collection(name).updateMany({
    dealership: { $in: sites }, lead_id: { $in: movedIds },
  }, { $set: { lead_id: primaryId, dealership: primary.dealership_name } }, { session });
  for (const name of ['customer_messages', 'message_media']) await db.collection(name).updateMany({
    dealership_name: { $in: sites }, lead_id: { $in: movedIds },
  }, { $set: { lead_id: primaryId, dealership_name: primary.dealership_name } }, { session });
  const existingLinks = await db.collection('customer_businesses').find({ dealership: primary.dealership_name, lead_id: primaryId }, { session }).toArray();
  const existingBizIds = new Set(existingLinks.map(row => String(row.business_id)));
  const movedLinks = await db.collection('customer_businesses').find({ dealership: { $in: sites }, lead_id: { $in: movedIds } }, { session }).toArray();
  for (const link of movedLinks) {
    const bizId = String(link.business_id);
    if (existingBizIds.has(bizId)) {
      await db.collection('customer_businesses').deleteOne({ _id: link._id }, { session });
    } else {
      existingBizIds.add(bizId);
      await db.collection('customer_businesses').findOneAndUpdate({ _id: link._id }, { $set: { lead_id: primaryId, dealership: primary.dealership_name } }, { session });
    }
  }
  await db.collection('appointments').updateMany({ dealership: { $in: sites },
    leadId: { $in: [...movedIds, secondary.deal_id, ...aliases.map(row => row.deal_id)].filter(Boolean) },
  }, { $set: { leadId: primaryId, dealership: primary.dealership_name } }, { session });
  const { transferAssignedWork } = require('./lead-allocation');
  await transferAssignedWork(db, changed, changed.owner_id || null, changed.owner_name || 'Unassigned', session);
  if(retire){
    const reviews=await db.collection('lead_merge_requests').find({dealership:primary.dealership_name,status:'open','incoming._id':{$in:[secondary._id,...aliases.map(row=>row._id)]}},{session}).toArray();
    if(reviews.length){
      await db.collection('lead_merge_requests').updateMany({_id:{$in:reviews.map(row=>row._id)},status:'open'},{$set:{status:'merged',primary_id:primaryId,reviewed_by:actor.id,reviewed_at:now}},{session});
      await db.collection('lead_email_receipts').updateMany({merge_request_id:{$in:reviews.map(row=>row._id)}},{$set:{status:'imported',lead_id:primaryId}},{session});
    }
  }
  return changed;
}

module.exports = { withMobileLock, mobileMatches, identityMatches, sameIdentity, flagDuplicate, duplicateError, createUniqueLead, updateUniqueMobile,
  missingDetails, sourceReference, refreshSourceAlias, upsertImportedLeads, dealerSocketReference, canonicalLead, mergeIntoPrimary, siteMatch };
