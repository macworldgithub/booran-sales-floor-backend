const { ObjectId } = require('mongodb');
const { randomUUID } = require('node:crypto');
const { string, dealership } = require('./records');
const { escapeRegex } = require('./query');
const { isManager } = require('./roles');
const { route, list, fail } = require('./workflow-route');

const STAGES = ['draft', 'ready', 'awaiting_offers', 'valued', 'traded', 'lost', 'archived'];
function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) fail(400, 'Invalid record ID.');
  return new ObjectId(value);
}
function manager(user) { if (!isManager(user)) fail(403, 'A manager account is required.'); }
function sales(user) { if (user.role === 'contractor') fail(403, 'A sales account is required.'); }
function partnerInput(body) {
  if (!['dealer', 'wholesaler'].includes(body.kind)) fail(400, 'Choose dealer or wholesaler.');
  const email = string(body.email, 'Email', { max: 254 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email.');
  const phone = string(body.phone, 'Phone', { max: 30 });
  if (phone && !/^[+\d() .-]{6,30}$/.test(phone)) fail(400, 'Enter a valid phone number.');
  if (body.active !== undefined && typeof body.active !== 'boolean') fail(400, 'Active must be true or false.');
  return {
    dealership: dealership(body.dealership), kind: body.kind,
    name: string(body.name, 'Name', { required: true, max: 200 }),
    company: string(body.company, 'Company', { max: 200 }), email, phone,
    licence: string(body.licence, 'Dealer licence', { max: 100 }),
    notes: string(body.notes, 'Notes', { max: 4000 }), active: body.active !== false,
  };
}
function changeInput(body) {
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, 'Refresh the record before saving.');
  const changes = {};
  if (body.stage !== undefined) {
    if (!STAGES.includes(body.stage)) fail(400, 'Choose a valid appraisal stage.');
    changes.workflow_status = body.stage;
  }
  if (body.notes !== undefined) changes.notes = string(body.notes, 'Notes', { max: 5000 });
  if (body.odometer !== undefined) {
    if (!Number.isSafeInteger(body.odometer) || body.odometer < 0 || body.odometer > 10000000) fail(400, 'Enter a valid odometer reading.');
    changes.odometer = body.odometer;
  }
  if (!Object.keys(changes).length) fail(400, 'No appraisal changes supplied.');
  return changes;
}
function publicAppraisal(row, user) {
  const { source_snapshot, ...visible } = row;
  const valuation = row.valuation || (row.final_offer ? { amount_cents: row.final_offer.amount_cents,
    valued_by: row.final_offer.selected_by, valued_by_name: row.final_offer.selected_by_name || 'Legacy valuation', valued_at: row.final_offer.selected_at } : null);
  if (valuation) visible.valuation = isManager(user) ? valuation : { amount_cents: valuation.amount_cents, valued_by: valuation.valued_by,
    valued_by_name: valuation.valued_by_name, valued_at: valuation.valued_at };
  if (!isManager(user)) {
    delete visible.offers; delete visible.offer_requests; delete visible.final_offer;
  }
  return visible;
}
async function load(db, id) {
  const row = await db.collection('appraisals').findOne({ _id: objectId(id) });
  if (!row) fail(404, 'Appraisal not found.');
  return row;
}
async function mutate(db, row, update) {
  const revision = row.revision ?? 0;
  const query = { _id: row._id, ...(row.revision === undefined ? { revision: { $exists: false } } : { revision }) };
  const changed = await db.collection('appraisals').findOneAndUpdate(query,
    { ...update, $set: { ...update.$set, updatedAt: new Date().toISOString() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
  if (!changed) fail(409, 'This appraisal changed. Refresh before saving.');
  return changed;
}

function installAppraisalCentre(router, database) {
  router.get('/appraisal-partners', route(async (req, res) => {
    sales(req.user);
    const query = {};
    if (req.query.kind) {
      if (!['dealer', 'wholesaler'].includes(req.query.kind)) fail(400, 'Invalid partner type.');
      query.kind = req.query.kind;
    }
    if (req.query.search) query.$or = ['name', 'company', 'email', 'phone'].map(key => ({ [key]: { $regex: escapeRegex(req.query.search), $options: 'i' } }));
    res.json(await list((await database(req)).collection('appraisal_partners'), req, query));
  }));
  router.post('/appraisal-partners', route(async (req, res) => {
    manager(req.user);
    const row = { ...partnerInput(req.body), revision: 0, createdAt: new Date().toISOString(), created_by: req.user.id };
    const result = await (await database(req)).collection('appraisal_partners').insertOne(row);
    res.status(201).json({ success: true, data: { ...row, _id: result.insertedId } });
  }));
  router.patch('/appraisal-partners/:id', route(async (req, res) => {
    manager(req.user);
    const db = await database(req), collection = db.collection('appraisal_partners');
    const existing = await collection.findOne({ _id: objectId(req.params.id) });
    if (!existing) fail(404, 'Partner not found.');
    if (req.body.revision !== (existing.revision ?? 0)) fail(409, 'Partner changed. Refresh before saving.');
    const fields = partnerInput(req.body);
    if (fields.dealership !== existing.dealership || fields.kind !== existing.kind) fail(400, 'Partner dealership and type cannot be changed.');
    const row = await collection.findOneAndUpdate({ _id: existing._id, revision: existing.revision }, {
      $set: { ...fields, updatedAt: new Date().toISOString(), updated_by: req.user.id }, $inc: { revision: 1 },
    }, { returnDocument: 'after' });
    if (!row) fail(409, 'Partner changed. Refresh before saving.');
    res.json({ success: true, data: row });
  }));
  router.get('/appraisals', route(async (req, res) => {
    sales(req.user);
    const query = {};
    if (req.query.stage) {
      if (!STAGES.includes(req.query.stage)) fail(400, 'Invalid appraisal stage.');
      query.workflow_status = req.query.stage;
    }
    if (req.query.search) query.$or = ['rego', 'vin', 'make', 'model'].map(key => ({ [key]: { $regex: escapeRegex(req.query.search), $options: 'i' } }));
    const result = await list((await database(req)).collection('appraisals'), req, query);
    result.data = result.data.map(row => publicAppraisal(row, req.user));
    res.json(result);
  }));
  router.get('/appraisals/:id', route(async (req, res) => {
    sales(req.user);
    res.json({ success: true, data: publicAppraisal(await load(await database(req), req.params.id), req.user) });
  }));
  router.patch('/appraisals/:id', route(async (req, res) => {
    sales(req.user);
    const changes = changeInput(req.body);
    if (changes.workflow_status && !isManager(req.user)) fail(403, 'Only managers can change appraisal outcomes.');
    const db = await database(req), row = await load(db, req.params.id);
    if (req.body.revision !== (row.revision ?? 0)) fail(409, 'Appraisal changed. Refresh before saving.');
    const event = { id: randomUUID(), at: new Date().toISOString(), actor: req.user.name, action: 'updated', fields: Object.keys(changes) };
    res.json({ success: true, data: publicAppraisal(await mutate(db, row, { $set: changes, $push: { audit: event } }), req.user) });
  }));
  router.post('/appraisals/:id/offer-requests', route(async (req, res) => {
    manager(req.user);
    const db = await database(req), row = await load(db, req.params.id);
    if (['archived', 'traded', 'lost'].includes(row.workflow_status)) fail(409, 'This appraisal is closed.');
    const partner = await db.collection('appraisal_partners').findOne({ _id: objectId(req.body.partnerId), dealership: row.dealership, kind: 'wholesaler', active: true });
    if (!partner) fail(404, 'Active wholesaler not found at this dealership.');
    if ((row.offer_requests || []).some(item => item.partner_id === String(partner._id))) return res.json({ success: true, data: row });
    const request = { id: randomUUID(), partner_id: String(partner._id), name: partner.name, company: partner.company, status: 'recorded', createdAt: new Date().toISOString(), created_by: req.user.id };
    res.status(201).json({ success: true, data: await mutate(db, row, { $set: { workflow_status: 'awaiting_offers' }, $push: { offer_requests: request } }) });
  }));
  router.post('/appraisals/:id/offers', route(async (req, res) => {
    manager(req.user);
    if (typeof req.body.requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(req.body.requestId)) fail(400, 'An offer request ID is required.');
    if (!Number.isSafeInteger(req.body.amountCents) || req.body.amountCents < 0 || req.body.amountCents > 1000000000) fail(400, 'Enter a valid offer amount.');
    const notes = string(req.body.notes, 'Offer notes', { max: 2000 });
    const db = await database(req), row = await load(db, req.params.id);
    const old = (row.offers || []).find(offer => offer.id === req.body.requestId);
    if (old) {
      if (old.partner_id !== req.body.partnerId || old.amount_cents !== req.body.amountCents || old.notes !== notes) fail(409, 'Offer request ID was already used.');
      return res.json({ success: true, data: row });
    }
    if (['archived', 'traded', 'lost'].includes(row.workflow_status)) fail(409, 'This appraisal is closed.');
    const partner = await db.collection('appraisal_partners').findOne({ _id: objectId(req.body.partnerId), dealership: row.dealership, kind: 'wholesaler', active: true });
    if (!partner) fail(404, 'Active wholesaler not found at this dealership.');
    const offer = { id: req.body.requestId, partner_id: String(partner._id), name: partner.name, company: partner.company, amount_cents: req.body.amountCents, notes, createdAt: new Date().toISOString(), created_by: req.user.id, recorded_by: req.user.name };
    res.status(201).json({ success: true, data: await mutate(db, row, { $push: { offers: offer } }) });
  }));
  router.post('/appraisals/:id/final-offer', route(async (req, res) => {
    manager(req.user);
    const db = await database(req), row = await load(db, req.params.id);
    if (req.body.revision !== (row.revision ?? 0)) fail(409, 'Appraisal changed. Refresh before saving.');
    if (['archived', 'traded', 'lost'].includes(row.workflow_status)) fail(409, 'This appraisal is closed.');
    const offer = (row.offers || []).find(item => item.id === req.body.offerId);
    if (!offer) fail(404, 'Offer not found.');
    const buffer = req.body.bufferCents ?? 0;
    const valuation = valuationInput({ amountCents: offer.amount_cents, bufferCents: buffer }, req.user);
    res.json({ success: true, data: publicAppraisal(await mutate(db, row, {
      $set: { workflow_status: 'valued', final_offer: { ...offer, selected_at: valuation.valued_at, selected_by: req.user.id, selected_by_name: req.user.name }, valuation },
      $push: { audit: { id: randomUUID(), at: valuation.valued_at, actor: req.user.name, actor_id: req.user.id, action: 'valued', amount_cents: valuation.amount_cents } },
    }), req.user) });
  }));
  router.post('/appraisals/:id/valuation', route(async (req, res) => {
    manager(req.user);
    const db = await database(req), row = await load(db, req.params.id);
    if (req.body.revision !== (row.revision ?? 0)) fail(409, 'Appraisal changed. Refresh before saving.');
    if (['archived', 'traded', 'lost'].includes(row.workflow_status)) fail(409, 'This appraisal is closed.');
    const valuation = valuationInput(req.body, req.user);
    res.json({ success: true, data: publicAppraisal(await mutate(db, row, {
      $set: { workflow_status: 'valued', valuation },
      $push: { audit: { id: randomUUID(), at: valuation.valued_at, actor: req.user.name, actor_id: req.user.id, action: 'valued', amount_cents: valuation.amount_cents } },
    }), req.user) });
  }));
  router.get('/iappraise/archive', route(async (req, res) => {
    manager(req.user);
    const query = {};
    if (req.query.search) query.$or = ['summary.rego', 'summary.vin', 'summary.customer', 'summary.name', 'source_id'].map(field => ({ [field]: { $regex: escapeRegex(req.query.search), $options: 'i' } }));
    if (req.query.kind) {
      if (!['appraisal', 'dealer', 'wholesaler'].includes(req.query.kind)) fail(400, 'Invalid legacy record type.');
      query.kind = req.query.kind;
    }
    const result = await list((await database(req)).collection('iappraise_archive'), req, query);
    result.data = result.data.map(({ raw, ...row }) => row);
    res.json(result);
  }));
  router.get('/iappraise/archive/:id', route(async (req, res) => {
    manager(req.user);
    const row = await (await database(req)).collection('iappraise_archive').findOne({ _id: objectId(req.params.id) });
    if (!row) fail(404, 'Legacy record not found.');
    res.json({ success: true, data: row });
  }));
  router.get('/iappraise/archive/:id/media/:mediaId', route(async (req, res) => {
    manager(req.user);
    const row = await (await database(req)).collection('iappraise_archive').findOne({ _id: objectId(req.params.id) });
    const file = row?.media?.find(item => item.id === req.params.mediaId);
    if (!file || !/^[a-f\d]{64}$/.test(file.sha256)) fail(404, 'Legacy media not found.');
    const path = require('node:path');
    const directory = process.env.IAPPRAISE_ARCHIVE_DIR;
    if (!directory) fail(503, 'Legacy media storage is not configured.');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.sendFile(path.resolve(directory, 'media', file.sha256), { cacheControl: false, dotfiles: 'deny' }, error => {
      if (error && !res.headersSent) res.status(404).json({ success: false, error: 'Archived file unavailable. Reconcile the migration bundle.' });
    });
  }));
}
function valuationInput(body, user) {
  const amount = body.amountCents, buffer = body.bufferCents ?? 0;
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1000000000 || !Number.isSafeInteger(buffer) || buffer < 0 || buffer > amount) fail(400, 'Enter a valid valuation and a buffer no greater than that valuation.');
  return { amount_cents: amount - buffer, gross_amount_cents: amount, buffer_cents: buffer,
    valued_by: user.id, valued_by_name: user.name, valued_at: new Date().toISOString(), notes: string(body.notes, 'Valuation notes', { max: 2000 }) };
}
module.exports = { installAppraisalCentre, partnerInput, changeInput, STAGES, publicAppraisal, valuationInput };
