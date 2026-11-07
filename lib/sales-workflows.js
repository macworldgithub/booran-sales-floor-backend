const { ObjectId } = require('mongodb');
const { string, dateBoundary } = require('./records');
const { isManager, canAccessSite, canViewCost } = require('./roles');
const { locationCondition } = require('./query');
const { reference } = require('./lead-allocation');
const { fail, route, list } = require('./workflow-route');
const { serializeVehicle } = require('./vehicle-holds');
const { calendarDay } = require('./pulse');

const vehicleFields = {
  rego: value => string(value, 'Registration', { max: 12 }).toUpperCase(),
  vin: value => string(value, 'VIN', { max: 17 }).toUpperCase(),
  make: value => string(value, 'Make', { max: 80 }),
  model: value => string(value, 'Model', { max: 100 }),
};
const vehicleInfo = input => {
  const data = Object.fromEntries(Object.entries(vehicleFields).map(([key, clean]) => [key, clean(input[key])]));
  if (data.vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(data.vin)) fail(400, 'Enter a valid 17-character VIN.');
  if (input.year !== undefined && (!Number.isInteger(input.year) || input.year < 1900 || input.year > new Date().getFullYear() + 2)) fail(400, 'Enter a valid vehicle year.');
  return { ...data, year: input.year ?? null };
};
const cleanId = (value, label) => {
  if (typeof value !== 'string' || !ObjectId.isValid(value)) fail(400, `Invalid ${label}.`);
  return new ObjectId(value);
};
const now = () => new Date().toISOString();
const statuses = ['registered', 'completed', 'cancelled'];
const availableStock = ['In Stock', 'IN-STOCK'];
const cents = (value, label) => {
  if (!Number.isFinite(value) || value < 0 || value > 10000000) fail(400, `Enter a valid ${label}.`);
  return Math.round(value * 100);
};
function visibleDeal(deal, user) {
  if (canViewCost(user)) return deal;
  const { cost_cents, gross_cents, ...visible } = deal;
  return visible;
}
const unavailableStock = (vehicle) => {
  if (!vehicle) return true;
  const current = serializeVehicle(vehicle);
  return !availableStock.includes(current.status) || current.dealPending || current.softHold?.held;
};

async function linked(db, collection, id, lead) {
  const record = await db.collection(collection).findOne({ _id: cleanId(id, collection), lead_id: String(lead._id), dealership: lead.dealership_name });
  if (!record) fail(404, 'Linked record is unavailable for this customer.');
  return record;
}

async function leadContext(req, database) {
  const db = await database(req);
  const lead = await db.collection('leads').findOne(reference(req.params.id));
  if (!lead) fail(404, 'Customer not found.');
  return { db, lead, common: { lead_id: String(lead._id), dealership: lead.dealership_name, owner_id: lead.owner_id ?? null } };
}

async function add(collection, value, res) {
  const result = await collection.insertOne(value);
  res.status(201).json({ success: true, data: { ...value, _id: result.insertedId } });
}

async function provider(config, payload) {
  const endpoint = process.env[`${config}_URL`];
  const token = process.env[`${config}_TOKEN`];
  if (!endpoint || !token) fail(503, `${config} provider is not configured.`);
  try {
    if (new URL(endpoint).protocol !== 'https:') throw new Error('HTTPS required');
    const response = await fetch(endpoint, {
      method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        ...(payload.requestId ? { 'Idempotency-Key': payload.requestId } : {}),
      },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Provider request failed');
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider response');
    return data;
  } catch {
    fail(503, `${config} provider is temporarily unavailable.`);
  }
}

async function getPhotos(db, lead, value, max = 12, requirePrivate = true) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(400, `Choose up to ${max} photos.`);
  const ids = [...new Set(value)].map(id => cleanId(id, 'photo'));
  const photos = await db.collection('message_media').find({
    _id: { $in: ids }, lead_id: String(lead._id), dealership_name: lead.dealership_name, status: 'ready',
    content_type: { $regex: '^image/' }, ...(requirePrivate ? { visibility: 'private' } : {}),
  }).toArray();
  if (photos.length !== ids.length) fail(404, 'A photo is unavailable for this customer.');
  return photos.map(row => ({ id: String(row._id), name: row.name }));
}

function signature(value) {
  if (!Array.isArray(value) || !value.length || value.length > 40) fail(400, 'Draw a signature to sign the loan-car form.');
  let points = 0;
  for (const line of value) {
    if (!Array.isArray(line) || line.length < 2 || line.length > 500 ||
      line.some(point => !Array.isArray(point) || point.length !== 2 || point.some(n => typeof n !== 'number' || n < 0 || n > 1))) fail(400, 'Invalid signature.');
    points += line.length;
  }
  if (points > 4000) fail(400, 'The signature is too large.');
  return value;
}

function installSalesWorkflows(router, database, inventoryDatabase, storage) {
  router.get('/vehicle-lookup', route(async (req, res) => {
    if (req.user.role === 'contractor') fail(403, 'Vehicle lookup requires a sales account.');
    const rego = vehicleFields.rego(req.query.rego);
    if (!/^[A-Z0-9]{1,12}$/.test(rego)) fail(400, 'Enter a registration number.');
    const inventory = await inventoryDatabase(req);
    const records = await inventory.collection('vehicles').find({ rego: { $regex: `^${rego}$`, $options: 'i' }, vin: { $type: 'string', $ne: '' } }).limit(2).toArray();
    if (records.length === 1) return res.json({ success: true, data: { ...vehicleInfo(records[0]), source: 'Booran inventory' } });
    const state = string(req.query.state, 'State', { required: true, max: 3 }).toUpperCase();
    if (!['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'].includes(state)) fail(400, 'Choose an Australian state or territory.');
    const result = vehicleInfo(await provider('REGO_LOOKUP', { rego, state }));
    if (!result.vin) fail(404, 'No VIN was found for that registration.');
    res.json({ success: true, data: { ...result, rego, source: 'Rego lookup' } });
  }));

  router.get('/leads/:id/workflows', route(async (req, res) => {
    const { db, common } = await leadContext(req, database);
    const filter = { lead_id: common.lead_id, dealership: common.dealership };
    const rows = await Promise.all(['deals', 'appraisals', 'deliveries'].map(name => db.collection(name).find(filter).sort({ createdAt: -1, _id: 1 }).limit(20).toArray()));
    res.json({ success: true, data: { deals: rows[0].map(deal => visibleDeal(deal, req.user)), appraisals: rows[1], deliveries: rows[2] } });
  }));

  router.post('/leads/:id/appraisals', route(async (req, res) => {
    const { db, lead, common } = await leadContext(req, database);
    const vehicle = vehicleInfo(req.body);
    if (!vehicle.rego && !vehicle.vin) fail(400, 'Enter a registration or VIN.');
    const sections = ['front', 'right', 'rear', 'left', 'interior'];
    const walkaround = req.body.walkaround ?? [];
    if (!Array.isArray(walkaround) || walkaround.length > sections.length ||
      new Set(walkaround.map(row => row?.section)).size !== walkaround.length ||
      walkaround.some(row => !sections.includes(row?.section))) fail(400, 'Select valid walk-around sections.');
    const inspection = await Promise.all(walkaround.map(async row => ({
      section: row.section,
      notes: string(row.notes, 'Condition notes', { max: 2000 }),
      condition: ['clear', 'damage', 'unchecked'].includes(row.condition) ? row.condition : 'unchecked',
      photos: await getPhotos(db, lead, row.photoIds, 2),
    })));
    const licence = await getPhotos(db, lead, req.body.licencePhotoId ? [req.body.licencePhotoId] : [], 1);
    const internalDrive = req.body.internalDrive ? {
      when: dateBoundary(req.body.internalDrive.when), notes: string(req.body.internalDrive.notes, 'Internal test drive notes', { max: 2000 }),
      driver: req.user.name,
    } : null;
    const loanCar = req.body.loanCar ? {
      signer: string(req.body.loanCar.signer, 'Signer', { required: true }),
      terms: string(req.body.loanCar.terms, 'Loan-car terms', { required: true, max: 4000 }),
      signature: signature(req.body.loanCar.signature), signedAt: now(),
    } : null;
    await add(db.collection('appraisals'), {
      ...common, ...vehicle, inspection, licence, internalDrive, loanCar,
      notes: string(req.body.notes, 'Inspection notes', { max: 5000 }),
      status: 'completed', createdAt: now(), created_by: req.user.id,
    }, res);
  }));

  router.post('/leads/:id/appraisals/damage-suggestion', route(async (req, res) => {
    const { db, lead } = await leadContext(req, database);
    const [picture] = await getPhotos(db, lead, [req.body.photoId], 1);
    const photo = await db.collection('message_media').findOne({ _id: new ObjectId(picture.id), lead_id: String(lead._id), visibility: 'private', purpose: 'inspection' });
    if (!photo) fail(404, 'Inspection photo not found.');
    const { readFile } = require('node:fs/promises');
    const bytes = photo.storage_backend === 'mongodb'
      ? await storage.readRange(photo, 0, photo.size - 1)
      : await readFile(await storage.download(photo));
    const result = await provider('INSPECTION_AI', {
      photo: Buffer.from(bytes).toString('base64'), contentType: photo.content_type,
      instruction: 'Inspect visible vehicle panels for dents, cracks or scratches. Return condition clear, damage or unchecked and brief notes. Staff will review the suggestion.',
    });
    const condition = ['clear', 'damage', 'unchecked'].includes(result.condition) ? result.condition : 'unchecked';
    res.json({ success: true, data: { condition, notes: string(result.notes, 'Damage suggestion', { max: 2000 }) } });
  }));

  router.post('/leads/:id/deals', route(async (req, res) => {
    const { db, lead, common } = await leadContext(req, database);
    const appraisal = req.body.appraisalId ? await linked(db, 'appraisals', req.body.appraisalId, lead) : null;
    const stockNumber = string(req.body.stockNumber, 'Stock number');
    const stock = stockNumber && await (await inventoryDatabase(req)).collection('vehicles').findOne({
      stockNumber, rooftopName: locationCondition(lead.dealership_name),
    });
    if (stockNumber && !stock) fail(404, 'Stock number is unavailable at this dealership.');
    if (stock && unavailableStock(stock)) fail(409, 'This vehicle is unavailable for sale.');
    const details = stock || req.body;
    const row = {
      ...common, ...vehicleInfo(details), stockNumber, appraisal_id: appraisal?._id || null,
      business_name: lead.business_name, business_id: lead.business_id,
      notes: string(req.body.notes, 'Deal notes', { max: 5000 }),
      ...(appraisal?.ppsr ? { appraisal_ppsr: appraisal.ppsr } : {}),
      status: 'registered', createdAt: now(), created_by: req.user.id,
    };
    if (req.body.salePrice !== undefined) row.sale_price_cents = cents(req.body.salePrice, 'sale price');
    if (req.body.cost !== undefined) {
      if (!canViewCost(req.user)) fail(403, 'This account cannot set deal cost.');
      row.cost_cents = cents(req.body.cost, 'cost');
      if (row.sale_price_cents !== undefined) row.gross_cents = row.sale_price_cents - row.cost_cents;
    }
    if (stock) row.stock_key = String(stock._id);
    try {
      await add(db.collection('deals'), row, res);
    } catch (error) {
      if (error.code === 11000) fail(409, 'There is already an active or completed deal for this vehicle.');
      throw error;
    }
  }));

  router.patch('/deals/:id/status', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can close a deal.');
    if (!statuses.slice(1).includes(req.body.status)) fail(400, 'Select a valid deal outcome.');
    const db = await database(req);
    const id = cleanId(req.params.id, 'deal');
    const row = await db.collection('deals').findOne({ _id: id });
    if (!row) fail(404, 'Deal not found.');
    if (row.status !== 'registered' && row.status !== req.body.status) fail(409, 'This deal already has a final outcome.');
    if (req.body.status === 'completed' && row.stockNumber && row.status === 'registered') {
      const stock = await (await inventoryDatabase(req)).collection('vehicles').findOne({
        stockNumber: row.stockNumber, rooftopName: locationCondition(row.dealership),
      });
      if (unavailableStock(stock)) fail(409, 'This vehicle is unavailable for sale.');
    }
    const collection = db.collection('deals');
    const updated = row.status === req.body.status ? row : await collection.findOneAndUpdate(
      { _id: id, status: 'registered' },
      { $set: { status: req.body.status, completed_at: req.body.status === 'completed' ? now() : null, closed_by: req.user.id } },
      { returnDocument: 'after' },
    );
    if (!updated) fail(409, 'The deal changed. Refresh and try again.');
    if (updated.status === 'completed') await db.collection('leads').findOneAndUpdate(
      { _id: new ObjectId(updated.lead_id), dealership_name: updated.dealership, status: { $ne: 'sold' } },
      { $set: { status: 'sold', updatedAt: new Date() }, $addToSet: { booran_edited_fields: 'status' } },
    );
    res.json({ success: true, data: updated });
  }));

  router.post('/leads/:id/ppsr', route(async (req, res) => {
    const { db, lead } = await leadContext(req, database);
    const target = req.body.appraisalId ? 'appraisals' : 'deals';
    const record = await linked(db, target, req.body.appraisalId || req.body.dealId, lead);
    const vin = vehicleInfo(record).vin;
    if (!vin) fail(400, 'Save a VIN before requesting PPSR.');
    const key = `booran-ppsr-${record._id}-${vin}`;
    let result;
    try {
      const verified = await provider('PPSR', { vin, requestId: key });
      if (!['clear', 'encumbered'].includes(verified.status)) fail(422, 'PPSR returned an unrecognised result.');
      result = { vin, status: verified.status, reference: string(verified.reference, 'PPSR reference'), checkedAt: now() };
    } catch (error) {
      result = { vin, status: 'error', error: error.message, checkedAt: now() };
    }
    const update = { $set: { ppsr: result } };
    await db.collection(target).findOneAndUpdate({ _id: record._id, vin }, update);
    await db.collection('leads').findOneAndUpdate({ _id: lead._id }, { $set: { latest_ppsr: result } });
    if (target === 'appraisals') {
      await db.collection('deals').updateMany({ appraisal_id: record._id, lead_id: String(lead._id) }, { $set: { appraisal_ppsr: result } });
    }
    res.json({ success: true, data: result });
  }));

  router.post('/deals/:id/export', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can submit deals to the DMS.');
    const db = await database(req);
    const id = cleanId(req.params.id, 'deal');
    const deals = db.collection('deals');
    const deal = await deals.findOne({ _id: id });
    if (!deal) fail(404, 'Deal not found.');
    if (deal.status === 'cancelled') fail(409, 'A cancelled deal cannot be submitted.');
    if (deal.exported_at) return res.json({ success: true, data: { exportedAt: deal.exported_at, reference: deal.export_reference } });
    const lead = await db.collection('leads').findOne({ _id: new ObjectId(deal.lead_id), dealership_name: deal.dealership });
    if (!lead) fail(404, 'Deal customer not found.');
    const result = await provider('BOORAN_DMS', {
      requestId: `booran-deal-${id}`, dealership: deal.dealership,
      customer: { name: lead.customer_name, phone: lead.customer_phone, email: lead.customer_email, businessName: lead.business_name },
      deal: {
        id: String(id), status: deal.status, stockNumber: deal.stockNumber, ...vehicleInfo(deal),
        salePriceCents: deal.sale_price_cents, ppsr: deal.ppsr, appraisalPpsr: deal.appraisal_ppsr,
      },
    });
    const exportReference = string(result.reference, 'DMS reference', { required: true });
    const exportedAt = now();
    await deals.findOneAndUpdate({ _id: id }, { $set: { exported_at: exportedAt, export_reference: exportReference } });
    res.json({ success: true, data: { exportedAt, reference: exportReference } });
  }));

  router.get('/deliveries', route(async (req, res) => {
    const db = await database(req);
    const query = req.query.status ? { status: req.query.status } : {};
    if (req.query.date) query.when = calendarDay(req.query.date);
    const response = await list(db.collection('deliveries'), req, query, 'when');
    if (req.user.role === 'contractor') response.data = response.data.map(row => ({
      _id: row._id, dealership: row.dealership, when: row.when, status: row.status,
      accessories: row.accessories.filter(item => item.contractor_id === req.user.id).map(item => ({
        id: item.id, title: item.title, completedAt: item.completedAt,
      })),
    }));
    res.json(response);
  }));

  router.patch('/delivery-journeys', route(async (req, res) => {
    const site = string(req.body.dealership, 'Dealership', { required: true });
    if (!isManager(req.user) || !canAccessSite(req.user, site)) fail(403, 'You cannot configure this dealership.');
    const { days } = req.body;
    if (!Number.isInteger(days) || days < 0 || days > 90) fail(400, 'Choose a delay of 0 to 90 days.');
    const message = string(req.body.message, 'Follow-up draft', { required: true, max: 600 });
    await (await database()).collection('delivery_journeys').updateOne({ _id: site.toLowerCase() }, { $set: { days, message } }, { upsert: true });
    res.json({ success: true, data: { days, message } });
  }));

  router.post('/leads/:id/deliveries', route(async (req, res) => {
    const { db, lead, common } = await leadContext(req, database);
    const deal = await linked(db, 'deals', req.body.dealId, lead);
    if (deal.status !== 'completed') fail(409, 'Complete the deal before booking a delivery.');
    const when = dateBoundary(req.body.when);
    try {
      await add(db.collection('deliveries'), {
        ...common, deal_id: deal._id, appraisal_id: deal.appraisal_id, when,
        customer_name: lead.customer_name, vehicle: [deal.make, deal.model].filter(Boolean).join(' '), vin: deal.vin,
        notes: string(req.body.notes, 'Delivery notes', { max: 3000 }), accessories: [], status: 'scheduled', createdAt: now(),
      }, res);
    } catch (error) {
      if (error.code === 11000) fail(409, 'This deal already has a delivery booking.');
      throw error;
    }
  }));

  router.get('/deliveries/:id/contractors', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can coordinate deliveries.');
    const db = await database(req);
    const delivery = await db.collection('deliveries').findOne({ _id: cleanId(req.params.id, 'delivery') });
    if (!delivery) fail(404, 'Delivery not found.');
    const users = await (await database()).collection('users').find({ role: 'contractor', active: true }).sort({ name: 1 }).toArray();
    res.json({ success: true, data: users.filter(user => canAccessSite(user, delivery.dealership))
      .map(user => ({ id: String(user._id), name: user.name })) });
  }));

  router.patch('/deliveries/:id', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can coordinate deliveries.');
    const db = await database(req);
    const id = cleanId(req.params.id, 'delivery');
    const delivery = await db.collection('deliveries').findOne({ _id: id });
    if (!delivery) fail(404, 'Delivery not found.');
    const update = { $set: { updatedAt: now() } };
    const query = { _id: id, status: 'scheduled' };
    if (req.body.status === 'completed') {
      query.accessories = { $not: { $elemMatch: { completedAt: null } } };
      update.$set.status = 'completed';
      update.$set.completedAt = now();
      const journey = await (await database()).collection('delivery_journeys').findOne({ _id: delivery.dealership.toLowerCase() });
      if (journey) {
        update.$set.follow_up = { dueAt: new Date(Date.now() + journey.days * 86400000).toISOString(), draft: journey.message };
      }
    } else if (req.body.accessory) {
      const title = string(req.body.accessory.title, 'Accessory', { required: true });
      const contractorId = req.body.accessory.contractorId;
      const contractor = await (await database()).collection('users').findOne({ _id: cleanId(contractorId, 'contractor'), active: true, role: 'contractor' });
      if (!contractor || !canAccessSite(contractor, delivery.dealership)) fail(403, 'Contractor is unavailable at this dealership.');
      update.$push = { accessories: { id: new ObjectId().toString(), title, contractor_id: contractorId, contractor_name: contractor.name, completedAt: null } };
    } else if (req.body.when) update.$set.when = dateBoundary(req.body.when);
    else fail(400, 'Select a delivery change.');
    const updated = await db.collection('deliveries').findOneAndUpdate(query, update, { returnDocument: 'after' });
    if (!updated) fail(409, 'This delivery is closed or has unfinished accessories.');
    res.json({ success: true, data: updated });
  }));
}

module.exports = { installSalesWorkflows, vehicleInfo };
