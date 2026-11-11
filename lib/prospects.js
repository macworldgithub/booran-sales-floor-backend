const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { normalisePhone, phoneKey } = require('./phone');
const { phonePattern } = require('./message-history');
const { canAccessSite, isManager } = require('./roles');
const { createLead, serializeLead, string } = require('./records');
const { reference } = require('./lead-allocation');
const { route, fail } = require('./workflow-route');
const { createUniqueLead, duplicateError, withMobileLock, mergeIntoPrimary, siteMatch } = require('./lead-identity');
const { leadQuery } = require('./query');

const identity = (site, value) => createHash('sha256').update(JSON.stringify([site.toLowerCase(), value])).digest('hex').slice(0, 24);
function businessId(site, name) {
  return name ? identity(site, name.toLowerCase().replace(/\s+/g, ' ')) : null;
}

function installProspects(router, database) {
  router.post('/prospects', route(async (req, res) => {
    if (!isManager(req.user) && req.user.role !== 'sales_consultant') fail(403, 'Prospect creation requires a sales account.');
    const quick = req.body.quick_walk_in === true;
    if (quick && !isManager(req.user)) fail(403, 'Only managers can log an incomplete walk-in.');
    if (quick) string(req.body.notes, 'Walk-in description', { required: true, max: 5000 });
    const lead = createLead({ ...req.body, name: quick ? (req.body.name || 'Walk-in — details pending') : req.body.name,
      source: quick ? 'Walk-in Showroom' : req.body.source,
      owner_name: quick ? 'Unassigned' : req.user.name, status: 'new_lead' }, req.user);
    if (!canAccessSite(req.user, lead.dealership_name)) fail(403, 'This dealership is unavailable.');
    const phone = string(req.body.phone ?? req.body.customer_phone, 'Mobile', { required: !quick });
    lead.customer_phone = phone ? normalisePhone(phone) : '';
    lead.owner_id = quick ? null : req.user.id;
    if (quick) lead.quick_walk_in = true;
    lead.business_id = businessId(lead.dealership_name, lead.business_name);
    lead._id = lead.customer_phone ? new ObjectId(identity(lead.dealership_name, lead.customer_phone)) : new ObjectId();
    const db = await database();
    const result = await createUniqueLead(db, lead, req.user);
    if (result.duplicate) throw duplicateError(result, req.user);
    res.status(201).json({ success: true, data: serializeLead(lead) });
  }));

  router.get('/leads/:id/related', route(async (req, res) => {
    const db = await database(req);
    const leads = db.collection('leads');
    const lead = await leads.findOne(reference(req.params.id));
    if (!lead) fail(404, 'Customer not found.');
    const scope = { _id: { $ne: lead._id }, dealership_name: siteMatch(lead.dealership_name), merged_into: { $exists: false } };
    const [contacts, duplicates, merged] = await Promise.all([
      lead.business_id ? leads.find({ ...scope, business_id: lead.business_id }).limit(30).toArray() : [],
      isManager(req.user) && (req.query.search || lead.customer_phone) ? leads.find(req.query.search
        ? { $and: [scope, leadQuery({ search: req.query.search })] }
        : { ...scope, customer_phone: { $regex: phonePattern(lead.customer_phone) } }).limit(30).toArray() : [],
      leads.find({ dealership_name: lead.dealership_name, merged_into: String(lead._id) }).limit(30).toArray(),
    ]);
    res.json({ success: true, data: { contacts: contacts.map(serializeLead), duplicates: duplicates.map(serializeLead), merged: merged.map(serializeLead) } });
  }));

  router.post('/leads/:id/merge', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can merge prospects.');
    if (typeof req.body.duplicateId !== 'string' || !ObjectId.isValid(req.body.duplicateId)) fail(400, 'Choose a duplicate prospect.');
    const raw = await database();
    const db = await database(req);
    const leads = db.collection('leads');
    const initial = await db.collection('leads').findOne(reference(req.params.id));
    if (!initial || initial.merged_into) fail(404, 'Primary prospect not found.');
    const updated = await withMobileLock(raw, initial.dealership_name, initial.customer_phone, async session => {
      const primary = await leads.findOne(reference(req.params.id), { session });
      if (!primary || primary.merged_into) fail(404, 'Primary prospect not found.');
      const duplicate = await leads.findOne({ _id: new ObjectId(req.body.duplicateId), dealership_name: siteMatch(primary.dealership_name) }, { session });
      if (!duplicate || duplicate.merged_into || duplicate._id.equals(primary._id)) fail(404, 'Duplicate prospect not found.');
      if ((!primary.customer_phone || !new RegExp(phonePattern(primary.customer_phone)).test(duplicate.customer_phone || '')) && req.body.confirmSameCustomer !== true) {
        fail(409, 'Review the different contact details and confirm both records are the same customer.');
      }
      return mergeIntoPrimary(raw, primary, duplicate, req.user, session);
    });
    res.json({ success: true, data: serializeLead(updated) });
  }));

  router.get('/merge-requests', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Merge requests require a manager account.');
    const db = await database(req);
    const { list } = require('./workflow-route');
    const result = await list(db.collection('lead_merge_requests'), req, { status: 'open' });
    const ids = [...new Set(result.data.flatMap(row => row.candidate_ids || []))].filter(ObjectId.isValid).map(id => new ObjectId(id));
    const leads = ids.length ? await db.collection('leads').find({ _id: { $in: ids }, merged_into: { $exists: false } }).toArray() : [];
    const byId = new Map(leads.map(lead => [String(lead._id), lead]));
    result.data = result.data.map(row => ({ id: row._id, dealership: row.dealership, requestedName: row.requested_name,
      updatedAt: row.updatedAt, incoming: serializeLead(row.incoming),
      candidates: (row.candidate_ids || []).flatMap(id => byId.has(id) ? [serializeLead(byId.get(id))] : []) }));
    res.json(result);
  }));

  router.post('/merge-requests/:id/resolve', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can merge prospects.');
    if (!ObjectId.isValid(req.body.primaryId) || !Number.isFinite(Date.parse(req.body.expectedUpdatedAt))) fail(400, 'Choose the primary prospect and current review.');
    const scoped = await database(req), raw = await database();
    const request = await scoped.collection('lead_merge_requests').findOne({ _id: req.params.id, status: 'open' });
    if (!request) fail(404, 'Merge request not found.');
    const updated = await withMobileLock(raw, request.dealership, request.phone, async session => {
      const primary = await scoped.collection('leads').findOne({ _id: new ObjectId(req.body.primaryId),
        dealership_name: siteMatch(request.dealership), merged_into: { $exists: false } }, { session });
      if (!primary || !phoneKey(request.phone) || ![primary.customer_phone, ...(primary.alternate_phones || [])]
        .some(phone => phoneKey(phone) === phoneKey(request.phone))) fail(409, 'Choose a primary with the same dealership and mobile.');
      const claimed = await raw.collection('lead_merge_requests').findOneAndUpdate({ _id: request._id, status: 'open',
        updatedAt: new Date(req.body.expectedUpdatedAt) }, { $set: { status: 'merged', primary_id: String(primary._id),
        reviewed_by: req.user.id, reviewed_at: new Date() } }, { session, returnDocument: 'after' });
      if (!claimed) fail(409, 'The merge request changed. Refresh and review it again.');
      const existingSecondary = await raw.collection('leads').findOne({ _id: request.incoming._id }, { session });
      if (existingSecondary?.merged_into) fail(409, 'This customer was already merged. Review its current primary customer instead.');
      const retire = existingSecondary && !existingSecondary._id.equals(primary._id);
      const result = await mergeIntoPrimary(raw, primary, retire ? existingSecondary : request.incoming, req.user, session, { retire: Boolean(retire) });
      await raw.collection('lead_email_receipts').updateMany({ merge_request_id: request._id }, { $set: { status: 'imported', lead_id: String(primary._id) } }, { session });
      return result;
    });
    res.json({ success: true, data: serializeLead(updated) });
  }));
}

module.exports = { installProspects, businessId };
