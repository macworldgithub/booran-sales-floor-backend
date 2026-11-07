const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { normalisePhone } = require('./phone');
const { phonePattern } = require('./message-history');
const { canAccessSite, isManager } = require('./roles');
const { createLead, serializeLead, string } = require('./records');
const { reference } = require('./lead-allocation');
const { route, fail } = require('./workflow-route');

const identity = (site, value) => createHash('sha256').update(JSON.stringify([site.toLowerCase(), value])).digest('hex').slice(0, 24);
function businessId(site, name) {
  return name ? identity(site, name.toLowerCase().replace(/\s+/g, ' ')) : null;
}

function installProspects(router, database) {
  router.post('/prospects', route(async (req, res) => {
    if (!isManager(req.user) && req.user.role !== 'sales_consultant') fail(403, 'Prospect creation requires a sales account.');
    const lead = createLead({ ...req.body, owner_name: req.user.name, status: 'new_lead' }, req.user);
    if (!canAccessSite(req.user, lead.dealership_name)) fail(403, 'This dealership is unavailable.');
    lead.customer_phone = normalisePhone(string(req.body.phone ?? req.body.customer_phone, 'Mobile', { required: true }));
    string(lead.customer_email, 'Email', { required: true });
    lead.owner_id = req.user.id;
    lead.business_id = businessId(lead.dealership_name, lead.business_name);
    lead._id = new ObjectId(identity(lead.dealership_name, lead.customer_phone));
    const db = await database();
    const leads = db.collection('leads');
    const existing = await leads.findOne({
      dealership_name: lead.dealership_name, customer_phone: { $regex: phonePattern(lead.customer_phone) },
      merged_into: { $exists: false },
    });
    if (existing) fail(409, 'A prospect with this mobile already exists at this dealership. Search Leads or ask your manager to open it.');
    try {
      await leads.insertOne(lead);
    } catch (error) {
      if (error.code === 11000) fail(409, 'A prospect with this mobile already exists at this dealership.');
      throw error;
    }
    res.status(201).json({ success: true, data: serializeLead(lead) });
  }));

  router.get('/leads/:id/related', route(async (req, res) => {
    const db = await database(req);
    const leads = db.collection('leads');
    const lead = await leads.findOne(reference(req.params.id));
    if (!lead) fail(404, 'Customer not found.');
    const scope = { _id: { $ne: lead._id }, dealership_name: lead.dealership_name, merged_into: { $exists: false } };
    const [contacts, duplicates, merged] = await Promise.all([
      lead.business_id ? leads.find({ ...scope, business_id: lead.business_id }).limit(30).toArray() : [],
      isManager(req.user) && lead.customer_phone ? leads.find({ ...scope, customer_phone: { $regex: phonePattern(lead.customer_phone) } }).limit(30).toArray() : [],
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
    await raw.client.withSession(session => session.withTransaction(async () => {
      const primary = await leads.findOne(reference(req.params.id), { session });
      if (!primary || primary.merged_into) fail(404, 'Primary prospect not found.');
      const duplicate = await leads.findOne({ _id: new ObjectId(req.body.duplicateId), dealership_name: primary.dealership_name }, { session });
      if (!duplicate || duplicate.merged_into || duplicate._id.equals(primary._id)) fail(404, 'Duplicate prospect not found.');
      if (!primary.customer_phone || !new RegExp(phonePattern(primary.customer_phone)).test(duplicate.customer_phone || '')) {
        fail(409, 'The two prospects must have the same mobile number.');
      }
      const now = new Date();
      await leads.findOneAndUpdate({ _id: primary._id }, {
        $set: { updatedAt: now },
        $push: { diary_entries: { author: req.user.name, date: now.toISOString(), note: `Merged duplicate enquiry ${duplicate.deal_id || duplicate._id}.` } },
      }, { session });
      // Keep the source row addressable for its bookings, messages and provider
      // IDs. Point its aliases to the new primary before moving it.
      await leads.updateMany({ dealership_name: primary.dealership_name, merged_into: String(duplicate._id) }, {
        $set: { merged_into: String(primary._id) },
      }, { session });
      await leads.findOneAndUpdate({ _id: duplicate._id }, {
        $set: { merged_into: String(primary._id), merged_at: now, merged_by: req.user.id },
      }, { session });
    }));
    res.json({ success: true });
  }));
}

module.exports = { installProspects, businessId };
