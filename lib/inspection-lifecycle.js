const { isManager } = require('./roles');
const { string, dateBoundary } = require('./records');
const { route, fail } = require('./workflow-route');
const { publicAppraisal } = require('./appraisal-centre');

function odometer(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000000) fail(400, 'Enter an odometer reading in whole kilometres.');
  return value;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[a-z\d-]{16,80}$/i.test(value)) fail(400, 'A valid request ID is required.');
  return value;
}
async function revise(collection, row, fields) {
  const revision = row.revision ?? 0;
  const result = await collection.findOneAndUpdate({ _id: row._id,
    ...(row.revision === undefined ? { revision: { $exists: false } } : { revision }) },
  { $set: { ...fields, updatedAt: new Date().toISOString() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
  if (!result) fail(409, 'This record changed. Refresh and retry.');
  return result;
}

function installInspectionLifecycle(router, database, { leadContext, linked, cleanId, visibleDeal }) {
  router.get('/inspection-services', route(async (req, res) => {
    if (req.user.role === 'contractor') fail(403, 'A sales account is required.');
    res.json({ success: true, data: Object.fromEntries(['REGO_LOOKUP', 'PPSR', 'INSPECTION_AI', 'BOORAN_DMS'].map(name =>
      [name, { configured: Boolean(process.env[`${name}_URL`] && process.env[`${name}_TOKEN`]) }])) });
  }));

  router.post('/leads/:id/appraisals/:appraisalId/drives', route(async (req, res) => {
    const { db, lead } = await leadContext(req, database);
    const row = await linked(db, 'appraisals', req.params.appraisalId, lead);
    if (['lost', 'archived'].includes(row.workflow_status)) fail(409, 'Reopen this appraisal before starting a drive.');
    const id = requestId(req.body.requestId), startOdometer = odometer(req.body.odometer);
    const notes = string(req.body.notes, 'Drive notes', { max: 2000 });
    const drives = (row.internal_drives || []).map(drive => ({ ...drive }));
    const existing = drives.find(drive => drive.id === id);
    if (existing) {
      if (existing.driver_id !== req.user.id || existing.start_odometer !== startOdometer || existing.start_notes !== notes) fail(409, 'This drive request was already used with different details.');
      return res.json({ success: true, data: publicAppraisal(row, req.user) });
    }
    if (drives.some(drive => drive.status === 'active')) fail(409, 'Finish the active internal drive first.');
    if (drives.length >= 100) fail(409, 'This appraisal has reached its internal-drive record limit.');
    drives.push({ id, status: 'active', driver_id: req.user.id, driver: req.user.name,
      started_at: new Date().toISOString(), start_odometer: startOdometer, start_notes: notes });
    const changed = await revise(db.collection('appraisals'), row, { internal_drives: drives });
    res.status(201).json({ success: true, data: publicAppraisal(changed, req.user) });
  }));

  router.post('/leads/:id/appraisals/:appraisalId/drives/:driveId/finish', route(async (req, res) => {
    const { db, lead } = await leadContext(req, database);
    const row = await linked(db, 'appraisals', req.params.appraisalId, lead);
    const drives = (row.internal_drives || []).map(drive => ({ ...drive }));
    const drive = drives.find(item => item.id === req.params.driveId);
    if (!drive) fail(404, 'Internal drive not found.');
    if (drive.driver_id !== req.user.id && !isManager(req.user)) fail(403, 'Only the driver or a manager can finish this drive.');
    const end = odometer(req.body.odometer), notes = string(req.body.notes, 'Drive notes', { max: 2000 });
    if (drive.status === 'completed') {
      if (drive.end_odometer !== end || drive.end_notes !== notes) fail(409, 'This drive was completed with different details.');
      return res.json({ success: true, data: publicAppraisal(row, req.user) });
    }
    if (end < drive.start_odometer) fail(400, 'The finish odometer cannot be below the start reading.');
    const ended = new Date();
    Object.assign(drive, { status: 'completed', ended_at: ended.toISOString(), end_odometer: end,
      distance_km: end - drive.start_odometer, duration_seconds: Math.max(0, Math.round((+ended - Date.parse(drive.started_at)) / 1000)),
      end_notes: notes, completed_by: req.user.id });
    const changed = await revise(db.collection('appraisals'), row, { internal_drives: drives });
    res.json({ success: true, data: publicAppraisal(changed, req.user) });
  }));

  router.patch('/leads/:id/deals/:dealId/appraisal', route(async (req, res) => {
    const { db, lead } = await leadContext(req, database);
    const deal = await linked(db, 'deals', req.params.dealId, lead);
    if (deal.status !== 'registered' || deal.contract || deal.exported_at) fail(409, 'Only an unexported, unsigned open deal can change its trade appraisal.');
    if (req.body.revision !== (deal.revision ?? 0)) fail(409, 'Refresh the deal before changing its appraisal.');
    const appraisal = await linked(db, 'appraisals', req.body.appraisalId, lead);
    if (['lost', 'archived'].includes(appraisal.workflow_status)) fail(409, 'Choose an active appraisal.');
    const changed = await revise(db.collection('deals'), deal, { appraisal_id: appraisal._id, appraisal_ppsr: appraisal.ppsr || null,
      appraisal_link: { at: new Date().toISOString(), by: req.user.id } });
    res.json({ success: true, data: visibleDeal(changed, req.user) });
  }));

  router.post('/leads/:id/deals/:dealId/contract', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'A manager must record a signed contract.');
    const { db, lead } = await leadContext(req, database);
    const deal = await linked(db, 'deals', req.params.dealId, lead);
    if (deal.status === 'cancelled') fail(409, 'A cancelled deal cannot receive a contract.');
    const id = requestId(req.body.requestId);
    const signedAt = dateBoundary(req.body.signedAt);
    if (Date.parse(signedAt) > Date.now() + 60000) fail(400, 'The signature date cannot be in the future.');
    const reference = string(req.body.reference, 'Contract reference', { required: true, max: 120 });
    const mediaId = cleanId(req.body.mediaId, 'contract attachment');
    const file = await db.collection('message_media').findOne({ _id: mediaId, lead_id: String(lead._id),
      dealership_name: lead.dealership_name, status: 'ready', visibility: 'private', purpose: 'contract' });
    if (!file) fail(404, 'Upload the signed contract privately for this customer first.');
    if (deal.contract) {
      if (deal.contract.id !== id || deal.contract.reference !== reference || deal.contract.media_id !== String(mediaId) || deal.contract.signed_at !== signedAt) fail(409, 'This deal already has a signed contract.');
      return res.json({ success: true, data: deal });
    }
    const items = Array.isArray(req.body.items) ? req.body.items.map(i => String(i).trim()).filter(Boolean) : (deal.contract?.items || []);
    const changed = await revise(db.collection('deals'), deal, { contract: { id, reference, signed_at: signedAt,
      media_id: String(mediaId), filename: file.name, recorded_at: new Date().toISOString(), recorded_by: req.user.id,
      appraisal_id: deal.appraisal_id || null, items } });
    res.status(201).json({ success: true, data: changed });
  }));
}
module.exports = { installInspectionLifecycle, revise, odometer };
