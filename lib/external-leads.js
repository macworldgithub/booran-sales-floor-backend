const { createHash, timingSafeEqual } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { createLead, serializeLead, string } = require('./records');
const { normalisePhone } = require('./phone');
const { route, fail } = require('./workflow-route');
const { isManager, canAccessSite } = require('./roles');
const SOURCES = { connex: 'Connex', drive: 'Drive', socket: 'Socket', website: 'Website', sms: 'SMS Campaign' };
const secretName = source => `LEAD_INGEST_${source.toUpperCase()}_SECRET`;
function authenticate(req) {
  const secret = Buffer.from(process.env[secretName(req.params.source)] || '');
  const token = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '');
  if (secret.length < 24 || token.length !== secret.length || !timingSafeEqual(token, secret)) fail(403, 'Lead ingestion is not authorised.');
}
async function ingestExternalLead(db, source, input, user = { name: 'Lead integration' }) {
  if (!Object.hasOwn(SOURCES, source)) fail(400, 'Choose a supported lead source.');
  const externalId = string(input.externalId, 'External lead reference', { required: true });
  const site = string(input.dealership_name || input.dealership, 'Dealership', { required: true });
  const lead = createLead({ ...input, name: input.name || input.customer_name || `${SOURCES[source]} enquiry — details pending`, dealership: site,
    source: SOURCES[source], owner_name: 'Unassigned', status: 'new_lead' }, user);
  if (input.phone || input.customer_phone) lead.customer_phone = normalisePhone(input.phone || input.customer_phone);
  const id = new ObjectId(createHash('sha256').update(JSON.stringify([source, site.toLowerCase(), externalId])).digest('hex').slice(0, 24));
  const collection = db.collection('leads');
  const existing = await collection.findOne({ _id: id });
  const external = { source, id: externalId, opportunity_status: string(input.opportunityStatus, 'Opportunity status'),
    details_revealed: Boolean(lead.customer_phone), received_at: new Date().toISOString() };
  if (!existing) {
    try { await collection.insertOne({ ...lead, _id: id, owner_id: null, external }); }
    catch (error) { if (error.code !== 11000) throw error; return ingestExternalLead(db, source, input, user); }
  } else {
    const metadata = { 'external.received_at': external.received_at };
    if (external.opportunity_status) metadata['external.opportunity_status'] = external.opportunity_status;
    if (external.details_revealed) metadata['external.details_revealed'] = true;
    await collection.findOneAndUpdate({ _id: id }, { $set: metadata });
    // Provider replays never change allocation, follow-up, loss review or the CRM stage.
    for (const field of ['customer_name', 'customer_phone', 'customer_email', 'vehicle_make', 'vehicle_model']) {
      if (lead[field] && !(field === 'customer_name' && !input.name && !input.customer_name)) {
        await collection.findOneAndUpdate({ _id: id, booran_edited_fields: { $ne: field } }, { $set: { [field]: lead[field] } });
      }
    }
  }
  return serializeLead(await collection.findOne({ _id: id }));
}
function installExternalWebhook(router, database) {
  router.post('/integrations/external/:source/leads', route(async (req, res) => {
    if (!Object.hasOwn(SOURCES, req.params.source)) fail(404, 'Lead source not found.');
    authenticate(req);
    res.json({ success: true, data: await ingestExternalLead(await database(), req.params.source, req.body) });
  }));
}
function installExternalLeads(router, database) {
  router.get('/lead-ingestion', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Lead ingestion requires a manager account.');
    res.json({ success: true, data: Object.entries(SOURCES).map(([id, name]) => ({ id, name,
      webhookConfigured: (process.env[secretName(id)] || '').length >= 24 })) });
  }));
  router.post('/lead-ingestion/:source', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Lead ingestion requires a manager account.');
    if (!canAccessSite(req.user, req.body.dealership_name || req.body.dealership)) fail(403, 'Dealership is unavailable.');
    res.json({ success: true, data: await ingestExternalLead(await database(), req.params.source, req.body, req.user) });
  }));
}
module.exports = { SOURCES, installExternalWebhook, installExternalLeads, ingestExternalLead };
