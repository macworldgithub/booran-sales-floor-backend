const { ObjectId } = require('mongodb');
const { route, fail } = require('../workflow-route');
const { pageQuery } = require('../query');
const { isManager, canAccessSite } = require('../roles');
const { string } = require('../records');
const { loadReport, cache } = require('./report');
const { defaultSettings, key, hash } = require('./common');
const { settingsInput, serviceInput } = require('./validation');
const { importSales, pullSales } = require('./connectors');

function installDpDashboard(router, crm, inventory, warranty) {
  const manager = req => { if (!isManager(req.user)) fail(403, 'Dealer Principal reporting requires a management account.'); };
  const siteFor = async req => {
    manager(req); const report = await loadReport(req, crm, inventory, warranty);
    const site = string(req.body?.dealership || req.query.site || (report.sites.length === 1 ? report.sites[0] : ''), 'Dealership', { required: true });
    const canonical = report.sites.find(name => key(name) === key(site));
    if (!canonical || !canAccessSite(req.user, canonical)) fail(403, 'This dealership is unavailable in your current scope.');
    return canonical;
  };
  const revision = req => { if (!Number.isSafeInteger(req.body.revision) || req.body.revision < 0) fail(400, 'Include the current revision before saving.'); return req.body.revision; };
  router.get('/dp/dashboard', route(async (req, res) => {
    const { _rows, ...data } = await loadReport(req, crm, inventory, warranty); res.json({ success: true, data });
  }));
  router.get('/dp/drilldown', route(async (req, res) => {
    const report = await loadReport(req, crm, inventory, warranty), kind = req.query.kind || 'sales', site = req.query.site;
    if (!Object.hasOwn(report._rows, kind)) fail(400, 'Choose sales, inventory, service or warranty details.');
    if (site && !report.sites.includes(site)) fail(403, 'This dealership is outside the selected scope.');
    let rows = report._rows[kind].filter(row => !site || (row.dealership || row.site) === site);
    const search = key(req.query.search);
    if (search) rows = rows.filter(row => key([row.stockNumber, row.make, row.model, row.ownerName, row.department, row.date, row.roNumber, row.caseNumber, row.vin, row.technicianName, row.status].filter(Boolean).join(' ')).includes(search));
    if (kind === 'inventory' && req.query.aging === 'true') rows = rows.filter(row => row.days > report.settings.agingWarningDays);
    const { page, limit, skip } = pageQuery(req.query, 'workflow');
    res.json({ success: true, data: rows.slice(skip, skip + limit), pagination: { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) } });
  }));
  router.patch('/dp/settings', route(async (req, res) => {
    const dealership = await siteFor(req), expected = revision(req), db = await crm(req);
    const previous = await db.collection('dp_settings').findOne({ dealership });
    if ((previous?.revision || 0) !== expected) fail(409, 'Dashboard settings changed. Refresh before saving.');
    const { dealership: ignored, ...input } = req.body, validated = settingsInput(input, previous || defaultSettings());
    const fields = Object.fromEntries(Object.keys(defaultSettings()).map(field => [field, validated[field]]));
    let updated;
    try { updated = await db.collection('dp_settings').findOneAndUpdate({ _id: hash(key(dealership)), ...(previous ? { revision: previous.revision ?? null } : {}) }, {
      $set: { ...fields, dealership, updatedAt: new Date().toISOString(), updated_by: req.user.id }, $inc: { revision: 1 },
    }, { upsert: !previous, returnDocument: 'after' }); } catch (error) { if (error.code === 11000) fail(409, 'Settings changed. Refresh before saving.'); throw error; }
    if (!updated) fail(409, 'Settings changed. Refresh before saving.'); cache.clear(); res.json({ success: true, data: updated });
  }));
  router.get('/dp/service-entry', route(async (req, res) => {
    const dealership = await siteFor(req), fields = serviceInput({ date: req.query.date, department: req.query.department, claimsOpened: 0 });
    const row = await (await crm(req)).collection('dp_service_entries').findOne({ _id: hash([key(dealership), fields.date, key(fields.department)].join(':')), dealership });
    res.json({ success: true, data: row || { ...fields, claimsOpened: null, dealership, revision: 0 } });
  }));
  router.put('/dp/service-entry', route(async (req, res) => {
    const dealership = await siteFor(req), fields = serviceInput(req.body), expected = revision(req), requestId = req.body.requestId;
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) fail(400, 'Include a valid service-entry request ID.');
    const db = await crm(req), _id = hash([key(dealership), fields.date, key(fields.department)].join(':'));
    const previous = await db.collection('dp_service_entries').findOne({ _id }), fingerprint = hash(JSON.stringify(fields));
    if (previous?.requestId === requestId) { if (previous.fingerprint !== fingerprint) fail(409, 'This request ID belongs to another service entry.'); return res.json({ success: true, data: previous }); }
    if ((previous?.revision || 0) !== expected) fail(409, 'This service entry changed. Reload it before saving.');
    let updated;
    try { updated = await db.collection('dp_service_entries').findOneAndUpdate({ _id, ...(previous ? { revision: previous.revision ?? null } : {}) }, {
      $set: { dealership, ...fields, requestId, fingerprint, updatedAt: new Date().toISOString(), updated_by: req.user.id, author: req.user.name }, $inc: { revision: 1 },
      ...(previous ? { $push: { history: { revision: previous.revision, at: previous.updatedAt, author: previous.author, values: Object.fromEntries(Object.keys(fields).map(field => [field, previous[field] ?? null])) } } } : {}),
    }, { upsert: !previous, returnDocument: 'after' }); } catch (error) { if (error.code === 11000) fail(409, 'This entry changed. Reload it before saving.'); throw error; }
    if (!updated) fail(409, 'This entry changed. Reload it before saving.'); cache.clear(); res.json({ success: true, data: updated });
  }));
  router.post('/dp/sales/import', route(async (req, res) => {
    manager(req); const report = await loadReport(req, crm, inventory, warranty);
    const result = await importSales(await crm(), req.body.records, report.sites, req.user.id); cache.clear(); res.json({ success: true, data: result });
  }));
  router.post('/dp/sales/sync', route(async (req, res) => {
    manager(req); const report = await loadReport(req, crm, inventory, warranty);
    const result = await pullSales(await crm(), report.sites, req.user.id); cache.clear(); res.json({ success: true, data: result });
  }));
  router.post('/dp/sites', route(async (req, res) => {
    if (req.user.role !== 'super_admin') fail(403, 'Only a super admin can onboard a new dealership.');
    const name = string(req.body.name, 'New dealership name', { required: true, max: 150 });
    if (['all', 'all locations', '*'].includes(key(name)) || Object.hasOwn(require('../query').LOCATION_GROUPS, key(name))) fail(400, 'Use a specific dealership name.');
    const id = new ObjectId(hash(key(name)).slice(0, 24));
    for (const db of await Promise.all([crm(), inventory()])) {
      if (!await db.collection('rooftops').findOne({ name: { $regex: '^' + require('../query').escapeRegex(name) + '$', $options: 'i' } }))
        try { await db.collection('rooftops').insertOne({ _id: id, name, createdAt: new Date().toISOString() }); } catch (error) { if (error.code !== 11000) throw error; }
    }
    cache.clear(); res.status(201).json({ success: true, data: { name, message: 'Site created. Grant staff access through Staff & Allocation before signing in with a site account.' } });
  }));
}
module.exports = { installDpDashboard };
