const { ObjectId } = require('mongodb');
const { canonicalLead } = require('./lead-identity');
const { fail, route } = require('./workflow-route');

const SITE = 'BYD South Morang';
const KIND = 'virtualyard_csv';
const isSourceId = id => typeof id === 'string' && /^\d{1,15}$/.test(id);

function archiveKey(type, id) {
  if (!['lead', 'test_drive'].includes(type) || !isSourceId(id)) throw new Error('Invalid Virtual Yard source key');
  return `virtualyard:csv:south-morang-byd:${type}:${Number(id) % 32}`;
}

async function sources(db, type, ids) {
  const archive = db.collection('integration_sync');
  const results = await Promise.all([...new Set(ids.filter(isSourceId))].map(async id => {
    const bucket = await archive.findOne({ _id: archiveKey(type, id), kind: KIND, dealership: SITE }, {
      projection: { [`records.${id}`]: 1 },
    });
    const record = bucket?.records?.[id];
    return record ? { id, ...record } : null;
  }));
  return results.filter(Boolean);
}

function installVirtualyardSource(router, database) {
  router.get('/leads/:id/virtualyard-source', route(async (req, res) => {
    const { id } = req.params;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { deal_id: id };
    const scoped = await database(req);
    const lead = await canonicalLead(scoped.collection('leads'), query, {
      projection: { dealership_name: 1, merged_into: 1, 'external.virtualyard.lead_id': 1, 'source_refs.external.virtualyard.lead_id': 1 },
    });
    if (!lead || lead.dealership_name !== SITE) fail(404, 'Lead not found.');
    const ids = [lead.external?.virtualyard?.lead_id, ...(lead.source_refs || []).map(ref => ref.external?.virtualyard?.lead_id)];
    res.set('Cache-Control', 'private, no-store').json({ success: true, data: await sources(await database(), 'lead', ids) });
  }));

  router.get('/appointments/:id/virtualyard-source', route(async (req, res) => {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) fail(404, 'Appointment not found.');
    const scoped = await database(req);
    const appointment = await scoped.collection('appointments').findOne({ _id: new ObjectId(id), dealership: SITE, type: 'Test Drive' }, {
      projection: { 'virtualyard.id': 1 },
    });
    if (!appointment) fail(404, 'Appointment not found.');
    res.set('Cache-Control', 'private, no-store').json({ success: true, data: await sources(await database(), 'test_drive', [appointment.virtualyard?.id]) });
  }));
}

module.exports = { SITE, KIND, archiveKey, installVirtualyardSource };
