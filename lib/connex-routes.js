const { ObjectId } = require('mongodb');
const { isManager, canAccessSite } = require('./roles');
const { reference } = require('./lead-allocation');
const { recordsForLead } = require('./connex-store');
const { SITE, attention, opportunityId } = require('./connex-policy');
const { publicJob, LIVE } = require('./connex-service');
const { route, fail } = require('./workflow-route');
const { randomUUID } = require('node:crypto');
const viewPolicy = require('./connex-views');
const calendar = require('./connex-calendar');
const { resolveLead } = require('./connex-store');

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
    await service.requestSync({ fullRefresh: req.body.fullRefresh === true });
    res.status(202).json({ success: true, data: { queued: true } });
  }));
  router.post('/connex/import-references', manager(async (req, res, db) => {
    if (typeof req.body.text !== 'string' || req.body.text.length > 90000) fail(400, 'Choose a Connex CSV export up to 90 KB per batch.');
    const ids = [...new Set((req.body.text.match(/\b006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/g) || []).map(opportunityId).filter(Boolean))];
    if (!ids.length || ids.length > 2000) fail(400, 'The file must contain between 1 and 2,000 valid Connex opportunity references.');
    for (let offset = 0; offset < ids.length; offset += 20) await Promise.all(ids.slice(offset, offset + 20).map(id => db.collection('integration_sync').findOneAndUpdate({ _id: `connex:candidate:${id}` },
      { $set: { kind: 'connex_candidate', dealership: SITE, recordId: id, last_read_at: new Date(0), read_attempts: 0, priority_order: -1 }, $unset: { retry_at: '', error: '' } }, { upsert: true })));
    res.status(202).json({ success: true, data: { queued: ids.length } });
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
    const filter = viewPolicy.filters(req.query);
    const records = await db.collection('integration_sync').find({ kind: 'connex_record', dealership: SITE }).sort({ 'snapshot.createdAt': -1, _id: -1 }).toArray();
    const settings = await db.collection('integration_sync').findOne({ _id: 'connex:calendar' });
    const rows = viewPolicy.sortRecords(records.map(record => viewPolicy.recordView(record, new Date(), calendar.holidays(settings))).filter(record => viewPolicy.matchesView(record, filter)), filter.sort);
    res.json({ success: true, data: rows.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) },
      facets: { types: [...new Set(records.map(record => record.snapshot.type).filter(Boolean))].sort(), salespeople: [...new Set(records.map(record => record.snapshot.salesperson || 'Unassigned'))].sort() } });
  }));
  router.get('/connex/options', manager(async (req, res) => res.json({ success: true, data: { statuses: require('./connex-policy').STATUSES,
    lostReasons: require('./connex-policy').LOST_REASONS, views: viewPolicy.VIEWS, calendar: calendar.info } })));
  router.post('/connex/bulk-actions', manager(async (req, res, db) => {
    const ids = req.body.recordIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string' || !opportunityId(id))) fail(400, 'Select between 1 and 50 Connex opportunities.');
    if (!/^[a-zA-Z0-9:_-]{8,60}$/.test(req.body.requestId || '')) fail(400, 'Include a unique bulk action reference.');
    const accepted = [], errors = [];
    for (const id of [...new Set(ids.map(opportunityId))]) {
      try {
        const record = await db.collection('integration_sync').findOne({ _id: `connex:record:${id}`, dealership: SITE, kind: 'connex_record' });
        if (!record) fail(404, 'Opportunity not found.');
        const lead = await resolveLead(db, record.snapshot);
        if (!lead || record.outcome === 'merge_review') fail(409, 'Resolve this enquiry in manager merge review first.');
        const input = { ...req.body, recordId: id, requestId: `${req.body.requestId}:${id}` };
        if (input.action === 'note') fail(400, 'Share notes from the individual customer.');
        await service.queue(db, lead, record, input, req.user, true);
        accepted.push(await service.queue(db, lead, record, input, req.user));
      } catch (error) { errors.push({ recordId: id, error: [400, 403, 404, 409, 503].includes(error.status) ? error.message : 'The action could not be queued. Retry with the same request reference.' }); }
    }
    res.status(202).json({ success: true, data: { jobs: accepted, errors } });
  }));
  router.get('/connex/views', manager(async (req, res, db) => {
    const settings = await db.collection('integration_sync').findOne({ _id: `connex:views:${req.user.id}` });
    res.json({ success: true, data: { views: settings?.views || [], pinnedId: settings?.pinnedId || '' } });
  }));
  router.put('/connex/views', manager(async (req, res, db) => {
    const state = db.collection('integration_sync'), key = `connex:views:${req.user.id}`, previous = await state.findOne({ _id: key });
    let views = previous?.views || [], pinnedId = previous?.pinnedId || '';
    if (req.body.action === 'save') {
      if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.length > 60) fail(400, 'Enter a view name up to 60 characters.');
      const id = req.body.id || randomUUID();
      if (req.body.id && !views.some(view => view.id === id)) fail(404, 'Saved view not found.');
      if (!req.body.id && views.length >= 20) fail(400, 'You can save up to 20 Connex views.');
      views = [...views.filter(view => view.id !== id), { id, name: req.body.name.trim(), filters: viewPolicy.filters(req.body.filters) }];
    } else if (req.body.action === 'delete') { views = views.filter(view => view.id !== req.body.id); if (pinnedId === req.body.id) pinnedId = ''; }
    else if (req.body.action === 'pin') { if (req.body.id && !views.some(view => view.id === req.body.id)) fail(404, 'Saved view not found.'); pinnedId = req.body.id || ''; }
    else fail(400, 'Choose a saved-view action.');
    await state.findOneAndUpdate({ _id: key }, { $set: { kind: 'connex_views', dealership: SITE, user_id: req.user.id, views, pinnedId } }, { upsert: true });
    res.json({ success: true, data: { views, pinnedId } });
  }));
  router.get('/connex/calendar', manager(async (req, res, db) => {
    const settings = await db.collection('integration_sync').findOne({ _id: 'connex:calendar' });
    res.json({ success: true, data: { dates: calendar.holidays(settings), extraDates: settings?.extraDates || [], removedDates: settings?.removedDates || [], ...calendar.info } });
  }));
  router.put('/connex/calendar', manager(async (req, res, db) => {
    const dates = name => {
      if (!Array.isArray(req.body[name]) || req.body[name].length > 200) fail(400, 'Include a valid holiday date list.');
      return [...new Set(req.body[name].map(date => { viewPolicy.filters({ from: date }); if (!date) fail(400, 'Enter a holiday date.'); return date; }))].sort();
    };
    await db.collection('integration_sync').findOneAndUpdate({ _id: 'connex:calendar' }, { $set: { kind: 'connex_calendar', dealership: SITE,
      extraDates: dates('extraDates'), removedDates: dates('removedDates'), updated_by: req.user.id, updated_at: new Date() } }, { upsert: true });
    res.json({ success: true });
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
    const holidays = calendar.holidays(await db.collection('integration_sync').findOne({ _id: 'connex:calendar' }));
    const jobs = await db.collection('integration_sync').find({ kind: 'connex_job', dealership: SITE,
      recordId: { $in: records.map(record => record.recordId) } }).sort({ created_at: -1 }).limit(20).toArray();
    res.json({ success: true, data: { configured: service.configured, writesEnabled: service.writes,
      lostReasons: require('./connex-policy').LOST_REASONS,
      records: records.map(record => viewPolicy.recordView(record, new Date(), holidays)), jobs: jobs.map(job => publicJob(job, holidays)) } });
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
