const { ObjectId } = require('mongodb');
const { isManager, canAccessSite } = require('./roles');
const { reference } = require('./lead-allocation');
const { recordsForLead } = require('./connex-store');
const { SITE, attention, opportunityId } = require('./connex-policy');
const { publicJob, LIVE } = require('./connex-service');
const { route, fail } = require('./workflow-route');

function installConnex(router, database, service) {
  const manager = handler => route(async (req, res) => {
    if (!isManager(req.user) || !canAccessSite(req.user, SITE) || req.query.rooftop && !['All Locations', SITE].includes(req.query.rooftop)) fail(403, 'South Morang Hyundai manager access is required.');
    await handler(req, res, await database());
  });
  const customer = handler => route(async (req, res) => {
    if (!canAccessSite(req.user, SITE) || req.user.role === 'contractor') fail(403, 'South Morang Hyundai access is required.');
    const scoped = await database(req), db = await database();
    const lead = await scoped.collection('leads').findOne({ ...reference(req.params.id), dealership_name: SITE, merged_into: { $exists: false } });
    if (!lead) fail(404, 'Lead not found.');
    await handler(req, res, db, lead, await recordsForLead(db, lead));
  });
  router.get('/connex/status', manager(async (req, res, db) => res.json({ success: true, data: await service.status(db) })));
  router.post('/connex/sync', manager(async (req, res) => {
    if (!service.configured) fail(503, 'The Connex connection needs setup.');
    await service.requestSync();
    res.status(202).json({ success: true, data: { queued: true } });
  }));
  router.post('/connex/opportunities', manager(async (req, res, db) => {
    const id = opportunityId(req.body.reference);
    if (!id) fail(400, 'Paste a Hyundai Connex opportunity link or reference.');
    if (!service.configured) fail(503, 'The Connex connection needs setup.');
    await db.collection('integration_sync').findOneAndUpdate({ _id: `connex:candidate:${id}` }, { $set: {
      kind: 'connex_candidate', dealership: SITE, recordId: id, last_read_at: new Date(0), requested_by: req.user.id } }, { upsert: true });
    res.status(202).json({ success: true, data: { queued: true } });
  }));
  router.get('/connex/records', manager(async (req, res, db) => {
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1)), limit = 20;
    const views = ['all', 'masked', 'overdue', 'three_days', 'six_weeks', 'merge_review'];
    if (req.query.view && !views.includes(req.query.view)) fail(400, 'Choose a Connex view.');
    const records = await db.collection('integration_sync').find({ kind: 'connex_record', dealership: SITE }).sort({ 'snapshot.createdAt': -1, _id: -1 }).toArray();
    const rows = records.map(record => ({ recordId: record.recordId, leadId: record.lead_id, mergeRequestId: record.merge_request_id,
      snapshot: record.snapshot, lastPullAt: record.last_pull_at, detailsPending: record.detailsPending, outcome: record.outcome, ...attention(record.snapshot) }))
      .filter(record => !req.query.view || req.query.view === 'all' || req.query.view === 'masked' && record.detailsPending ||
        req.query.view === 'overdue' && record.acceptanceOverdue || req.query.view === 'three_days' && record.notAcceptedThreeDays ||
        req.query.view === 'six_weeks' && record.openSixWeeks || req.query.view === 'merge_review' && record.outcome === 'merge_review');
    res.json({ success: true, data: rows.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) } });
  }));
  router.put('/connex/staff-map', manager(async (req, res, db) => {
    const map = req.body.staffMap;
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 300) fail(400, 'Include valid salesperson mappings.');
    const users = await db.collection('users').find({ active: true }).toArray(), valid = {};
    for (const [id, value] of Object.entries(map)) {
      const user = users.find(user => String(user._id) === id);
      if (!ObjectId.isValid(id) || !user || ['super_admin', 'contractor'].includes(user.role) || !canAccessSite(user, SITE) ||
        typeof value !== 'string' || value.length > 200) fail(400, 'Choose an active South Morang Hyundai salesperson and a Connex contact name.');
      if (value.trim()) valid[id] = value.trim();
    }
    const names = Object.values(valid).map(value => value.toLowerCase());
    if (new Set(names).size !== names.length) fail(400, 'Each Connex contact must map to one salesperson.');
    await db.collection('integration_sync').findOneAndUpdate({ _id: 'connex:settings' }, { $set: { kind: 'connex_settings', dealership: SITE,
      staffMap: valid, updated_at: new Date(), updated_by: req.user.id } }, { upsert: true });
    res.json({ success: true });
  }));
  router.get('/leads/:id/connex', customer(async (req, res, db, lead, records) => {
    const jobs = await db.collection('integration_sync').find({ kind: 'connex_job', dealership: SITE,
      recordId: { $in: records.map(record => record.recordId) } }).sort({ created_at: -1 }).limit(20).toArray();
    res.json({ success: true, data: { configured: service.configured, writesEnabled: service.writes,
      records: records.map(record => ({ recordId: record.recordId, snapshot: record.snapshot, detailsPending: record.detailsPending,
        lastPullAt: record.last_pull_at, ...attention(record.snapshot) })), jobs: jobs.map(publicJob) } });
  }));
  router.post('/leads/:id/connex/actions', customer(async (req, res, db, lead, records) => {
    const id = opportunityId(req.body.recordId), record = records.find(record => record.recordId === id);
    if (!record) fail(404, 'Connex opportunity is not linked to this customer.');
    const job = await service.queue(db, lead, record, req.body, req.user);
    res.status(202).json({ success: true, data: job });
  }));
  router.post('/connex/jobs/:id/retry', manager(async (req, res, db) => {
    const state = db.collection('integration_sync'), job = await state.findOne({ _id: req.params.id, kind: 'connex_job', dealership: SITE });
    if (!job) fail(404, 'Connex action not found.');
    if (job.status === 'done' || LIVE.includes(job.status)) fail(409, 'This Connex action is complete or already pending.');
    if (job.payload.action === 'note') fail(409, 'Check the note in Connex before sharing it again. Uncertain notes are not automatically reposted.');
    await state.findOneAndUpdate({ _id: job._id, status: job.status }, { $set: { status: 'queued', attempts: 0, available_at: new Date(), error: null } });
    res.json({ success: true });
  }));
}
module.exports = { installConnex };
