const { ObjectId } = require('mongodb');
const { string, dateBoundary } = require('./records');
const { isManager, canAccessSite } = require('./roles');
const { locationCondition } = require('./query');
const { fail, route } = require('./workflow-route');
const { revise } = require('./inspection-lifecycle');

const now = () => new Date().toISOString();

const cleanId = (value, label = 'id') => {
  if (!value || typeof value !== 'string' || !ObjectId.isValid(value)) fail(400, `Invalid ${label}.`);
  return new ObjectId(value);
};

const DEFAULT_VENDORS = [
  {
    name: 'Auto You',
    category: 'Dash Cams',
    contact_method: 'email',
    email: 'bookings@autoyou.com.au',
    phone: '03 9000 1100',
    portal_url: '',
    instructions: 'Email bookings with date, time, sublet number and vehicle details',
    supported_brands: ['Hyundai', 'Kia', 'Chery'],
    notes: 'Default dash cam contractor for Hyundai, Kia, and Chery',
  },
  {
    name: 'AutoXtreme (Motor One)',
    category: 'Sensors / Protection / Dash Cams',
    contact_method: 'portal',
    email: 'support@motorone.com.au',
    phone: '1300 655 022',
    portal_url: 'https://portal.motorone.com.au',
    instructions: 'Raise RO and book via booking portal',
    supported_brands: ['Hyundai', 'Kia', 'Chery', 'BYD'],
    notes: 'Sensors, paint/interior protection, and BYD dash cams',
  },
  {
    name: 'Motor One (BYD)',
    category: 'BYD Dash Cams & Accessories',
    contact_method: 'portal',
    email: 'byd@motorone.com.au',
    phone: '1300 655 022',
    portal_url: 'https://portal.motorone.com.au',
    instructions: 'Raise RO and book via Motor One booking portal',
    supported_brands: ['BYD'],
    notes: 'BYD dash cams and electronic accessories',
  },
  {
    name: 'ARB / Ironman 4x4',
    category: 'Suspension, Towbars & Accessories',
    contact_method: 'email',
    email: 'commercial@arb.com.au',
    phone: '03 9761 1144',
    portal_url: '',
    instructions: 'Contact for BYD Shark suspension, bullbar and towbar bookings',
    supported_brands: ['BYD'],
    notes: 'BYD Shark suspension upgrades, towbars and heavy accessories',
  },
];

function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Checks if a requested line item matches any item in the contracted items list.
 * Recognises variations, keyword overlap (e.g. "Front Dash Cam" <-> "Front & Rear Dash Cam"),
 * standard accessory categories, and exact matches.
 */
function itemMatchesContract(requested, contractedItems) {
  if (!requested || !contractedItems || !contractedItems.length) return false;
  const reqNorm = normalizeText(requested);
  if (!reqNorm) return false;

  const KEYWORD_GROUPS = [
    ['dash cam', 'dashcam', 'camera'],
    ['tint', 'window tint', 'darkest legal'],
    ['towbar', 'tow bar', 'harness', 'towing'],
    ['mat', 'mats', 'floor mats', 'carpet mats', 'rubber mats'],
    ['diesel', 'full tank diesel', 'fuel'],
    ['petrol', 'full tank petrol'],
    ['rwc', 'roadworthy'],
    ['pd', 'mechanical pd', 'pre delivery'],
    ['protection', 'chemical', 'ceramic', 'paint protection', 'interior protection'],
    ['sensor', 'sensors', 'parking sensors', 'front sensors', 'rear sensors'],
    ['suspension', 'lift kit', 'shocks'],
    ['bullbar', 'bull bar', 'nudge bar'],
    ['canopy', 'roller shutter', 'tonneau'],
  ];

  for (const contracted of contractedItems) {
    const conNorm = normalizeText(contracted);
    if (!conNorm) continue;
    if (reqNorm === conNorm) return true;
    if (reqNorm.includes(conNorm) || conNorm.includes(reqNorm)) return true;

    // Check keyword groups
    for (const group of KEYWORD_GROUPS) {
      const reqHas = group.some(kw => reqNorm.includes(kw));
      const conHas = group.some(kw => conNorm.includes(kw));
      if (reqHas && conHas) return true;
    }
  }

  return false;
}

/**
 * Validates Get Ready items against signed contract line items.
 * Strictly enforces that the contract is the source of truth.
 */
function validateItemsAgainstContract(contractItems = [], requestedItems = []) {
  const matched = [];
  const rejected = [];

  for (const item of requestedItems) {
    const str = String(item).trim();
    if (!str) continue;
    if (itemMatchesContract(str, contractItems)) {
      matched.push(str);
    } else {
      rejected.push(str);
    }
  }

  return {
    isValid: rejected.length === 0,
    matchedItems: matched,
    rejectedItems: rejected,
    eligibleRoItems: matched,
  };
}

async function seedVendorsIfEmpty(db, dealership) {
  const collection = db.collection('sublet_vendors');
  const count = await collection.countDocuments({ dealership });
  if (count > 0) return;

  for (const v of DEFAULT_VENDORS) {
    await collection.insertOne({
      ...v,
      _id: new ObjectId(),
      dealership,
      created_at: now(),
      is_default: true,
    });
  }
}

function installDeliveryCentre(router, database, inventoryDatabase) {
  // ─── GET READY FORMS LIST ──────────────────────────────────────────────────
  router.get('/deliveries/get-ready', route(async (req, res) => {
    const db = await database(req);
    const query = {};

    if (req.query.status && req.query.status !== 'all') {
      query.status = req.query.status;
    }
    if (req.query.fleet === 'fleet_only') {
      query.is_fleet = true;
    } else if (req.query.fleet === 'retail_only') {
      query.is_fleet = { $ne: true };
    }
    if (req.query.rooftop && req.query.rooftop !== 'All Locations') {
      query.dealership = locationCondition(req.query.rooftop);
    }

    if (req.query.search) {
      const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = { $regex: escaped, $options: 'i' };
      query.$or = [
        { deal_number: searchRegex },
        { stock_number: searchRegex },
        { customer_name: searchRegex },
        { 'vehicle.rego': searchRegex },
        { 'vehicle.vin': searchRegex },
        { ro_number: searchRegex },
      ];
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const collection = db.collection('get_ready_forms');
    const [total, rows] = await Promise.all([
      collection.countDocuments(query),
      collection.find(query).sort({ delivery_date: 1, createdAt: -1, _id: 1 }).skip(skip).limit(limit).toArray(),
    ]);

    res.json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  }));

  // ─── ELIGIBLE DEALS FOR GET READY ──────────────────────────────────────────
  router.get('/deliveries/deals-for-ready', route(async (req, res) => {
    const db = await database(req);
    const query = { status: { $in: ['registered', 'completed'] } };
    if (req.query.rooftop && req.query.rooftop !== 'All Locations') {
      query.dealership = locationCondition(req.query.rooftop);
    }
    const deals = await db.collection('deals').find(query).sort({ createdAt: -1, _id: 1 }).limit(50).toArray();
    res.json({
      success: true,
      data: deals.map(d => ({
        _id: String(d._id),
        dealNumber: d.dealNumber || d.deal_number || String(d._id).slice(-7).toUpperCase(),
        stockNumber: d.stockNumber || d.stock_number || '',
        lead_id: d.lead_id,
        dealership: d.dealership,
        make: d.make || '',
        model: d.model || '',
        rego: d.rego || '',
        vin: d.vin || '',
        status: d.status,
        contract: d.contract || null,
        contractItems: d.contract?.items || d.contract_items || [],
        customerName: d.customer_name || d.business_name || '',
      })),
    });
  }));

  // ─── SUBMIT GET READY FORM ─────────────────────────────────────────────────
  router.post('/deliveries/get-ready', route(async (req, res) => {
    const db = await database(req);
    const body = req.body || {};

    const dealNumber = string(body.deal_number || body.dealNumber, 'Deal number', { required: true, max: 40 });
    const stockNumber = string(body.stock_number || body.stockNumber, 'Stock number', { required: true, max: 40 });
    const customerName = string(body.customer_name || body.customerName, 'Customer or Company name', { required: true, max: 120 });
    const deliveryDate = string(body.delivery_date || body.deliveryDate, 'Delivery date', { required: true, max: 20 });
    const deliveryTime = string(body.delivery_time || body.deliveryTime, 'Delivery time', { required: true, max: 20 });
    const deliveryDay = string(body.delivery_day || body.deliveryDay, 'Delivery day', { required: true, max: 20 });
    const salesman = string(body.salesman || body.salesConsultant, 'Salesman', { required: true, max: 80 });
    const financeApproval = ['Yes', 'No'].includes(body.finance_approval) ? body.finance_approval : 'Yes';

    const validLocates = ['HYUNDAI', 'KIA', 'HOLDING YARD', 'CHERY', 'BYD'];
    const vehicleLocate = validLocates.includes(String(body.vehicle_locate).toUpperCase())
      ? String(body.vehicle_locate).toUpperCase()
      : 'HOLDING YARD';

    const vehicle = {
      make: string(body.vehicle?.make, 'Make', { max: 80 }) || '',
      model: string(body.vehicle?.model, 'Model', { max: 100 }) || '',
      variant: string(body.vehicle?.variant, 'Variant', { max: 100 }) || '',
      colour: string(body.vehicle?.colour || body.vehicle?.color, 'Colour', { max: 50 }) || '',
      rego: string(body.vehicle?.rego, 'Registration', { max: 12 }).toUpperCase() || '',
      vin: string(body.vehicle?.vin, 'VIN', { max: 17 }).toUpperCase() || '',
    };

    const dealership = body.dealership ? string(body.dealership, 'Dealership') : req.user.primarySite || req.user.dealership_name || 'South Morang Hyundai';
    if (!canAccessSite(req.user, dealership)) fail(403, 'You do not have access to this dealership.');

    // Look for matching deal if deal_id provided or by stock_number
    let linkedDeal = null;
    if (body.deal_id && ObjectId.isValid(body.deal_id)) {
      linkedDeal = await db.collection('deals').findOne({ _id: new ObjectId(body.deal_id) });
    }
    if (!linkedDeal && stockNumber) {
      linkedDeal = await db.collection('deals').findOne({ stockNumber, dealership: locationCondition(dealership) });
    }

    const requestedItems = Array.isArray(body.requested_items)
      ? body.requested_items.map(i => String(i).trim()).filter(Boolean)
      : [];

    const getReadyDoc = {
      deal_id: linkedDeal ? String(linkedDeal._id) : (body.deal_id || null),
      lead_id: linkedDeal ? String(linkedDeal.lead_id) : (body.lead_id || null),
      deal_number: dealNumber,
      stock_number: stockNumber,
      customer_name: customerName,
      vehicle,
      delivery_date: deliveryDate,
      delivery_time: deliveryTime,
      delivery_day: deliveryDay,
      salesman,
      finance_approval: financeApproval,
      rwc_required: Boolean(body.rwc_required),
      diesel_required: Boolean(body.diesel_required),
      vehicle_locate: vehicleLocate,
      plastics_stripped: Boolean(body.plastics_stripped),
      mechanical_pd: Boolean(body.mechanical_pd),
      detail_vehicle: Boolean(body.detail_vehicle),
      floor_mats: string(body.floor_mats, 'Floor mats', { max: 50 }) || 'Carpet',
      is_fleet: Boolean(body.is_fleet),
      fleet_company: body.is_fleet ? (string(body.fleet_company, 'Fleet company', { max: 100 }) || '') : '',
      requested_items: requestedItems,
      notes: string(body.notes, 'Notes', { max: 3000 }) || '',
      status: 'submitted',
      dealership,
      created_by: req.user.id,
      created_by_name: req.user.name,
      createdAt: now(),
      updatedAt: now(),
      sublets: [],
      audit_trail: [
        {
          action: 'get_ready_submitted',
          by: req.user.name,
          at: now(),
          details: `Get Ready form submitted for Deal ${dealNumber} (Stock ${stockNumber}). Delivery booked for ${deliveryDay} ${deliveryDate} at ${deliveryTime}.`,
        },
      ],
    };

    const result = await db.collection('get_ready_forms').insertOne(getReadyDoc);
    const insertedId = result.insertedId;

    // Create or link delivery task in deliveries collection
    try {
      const combinedDateTime = `${deliveryDate}T${deliveryTime.replace(/\s*[AP]M/i, '') || '09:00'}:00Z`;
      let when;
      try { when = dateBoundary(combinedDateTime); } catch { when = new Date().toISOString(); }

      const existingDelivery = linkedDeal
        ? await db.collection('deliveries').findOne({ deal_id: linkedDeal._id })
        : null;

      if (!existingDelivery) {
        await db.collection('deliveries').insertOne({
          deal_id: linkedDeal ? linkedDeal._id : insertedId,
          get_ready_id: String(insertedId),
          dealership,
          customer_name: customerName,
          vehicle: [vehicle.make, vehicle.model].filter(Boolean).join(' ') || stockNumber,
          vin: vehicle.vin,
          when,
          status: 'scheduled',
          notes: getReadyDoc.notes,
          accessories: [],
          is_fleet: getReadyDoc.is_fleet,
          fleet_company: getReadyDoc.fleet_company,
          createdAt: now(),
          created_by: req.user.id,
        });
      }
    } catch {
      // Safe fallback if delivery collection has index collision or already exists
    }

    res.status(201).json({
      success: true,
      data: { ...getReadyDoc, _id: insertedId },
    });
  }));

  // ─── GET SINGLE GET READY FORM ─────────────────────────────────────────────
  router.get('/deliveries/get-ready/:id', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const doc = await db.collection('get_ready_forms').findOne({ _id: id });
    if (!doc) fail(404, 'Get Ready form not found.');

    let deal = null;
    if (doc.deal_id && ObjectId.isValid(doc.deal_id)) {
      deal = await db.collection('deals').findOne({ _id: new ObjectId(doc.deal_id) });
    }
    if (!deal && doc.stock_number) {
      deal = await db.collection('deals').findOne({ stockNumber: doc.stock_number, dealership: locationCondition(doc.dealership) });
    }

    res.json({
      success: true,
      data: {
        ...doc,
        deal: deal ? {
          _id: String(deal._id),
          status: deal.status,
          contract: deal.contract || null,
          contract_items: deal.contract?.items || deal.contract_items || [],
        } : null,
      },
    });
  }));

  // ─── VALIDATE CONTRACT VS GET READY ────────────────────────────────────────
  router.post('/deliveries/get-ready/:id/validate', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const getReady = await db.collection('get_ready_forms').findOne({ _id: id });
    if (!getReady) fail(404, 'Get Ready form not found.');

    let deal = null;
    if (getReady.deal_id && ObjectId.isValid(getReady.deal_id)) {
      deal = await db.collection('deals').findOne({ _id: new ObjectId(getReady.deal_id) });
    }
    if (!deal && getReady.stock_number) {
      deal = await db.collection('deals').findOne({ stockNumber: getReady.stock_number, dealership: locationCondition(getReady.dealership) });
    }

    // Spec Rule: Contract is source of truth. Both Get Ready form + Contract must be submitted.
    if (!deal || !deal.contract) {
      const blockedValidation = {
        isValid: false,
        checkedAt: now(),
        checkedBy: req.user.name,
        reason: 'Signed contract has not been submitted for this deal. Contract is the sole authority for RO creation.',
        contractReference: null,
        matchedItems: [],
        rejectedItems: getReady.requested_items || [],
        eligibleRoItems: [],
      };
      await db.collection('get_ready_forms').updateOne(
        { _id: id },
        {
          $set: {
            status: 'mismatch_blocked',
            validation: blockedValidation,
            updatedAt: now(),
          },
          $push: {
            audit_trail: {
              action: 'contract_validation_failed',
              by: req.user.name,
              at: now(),
              details: 'Validation failed: Signed contract is missing. RO creation blocked.',
            },
          },
        }
      );
      return res.json({
        success: true,
        data: {
          status: 'mismatch_blocked',
          validation: blockedValidation,
        },
      });
    }

    const contractItems = deal.contract?.items || deal.contract_items || [];
    const requested = getReady.requested_items || [];
    const validationResult = validateItemsAgainstContract(contractItems, requested);

    const newStatus = validationResult.isValid ? 'validated' : 'mismatch_blocked';
    const validationRecord = {
      ...validationResult,
      checkedAt: now(),
      checkedBy: req.user.name,
      contractReference: deal.contract?.reference || 'Signed Contract',
      contractSignedAt: deal.contract?.signed_at || null,
      totalRequested: requested.length,
      totalMatched: validationResult.matchedItems.length,
      totalRejected: validationResult.rejectedItems.length,
    };

    const auditDetail = validationResult.isValid
      ? `Contract validation PASSED against reference ${validationRecord.contractReference}. All ${validationResult.matchedItems.length} items validated.`
      : `Contract validation MISMATCH: ${validationResult.rejectedItems.length} item(s) rejected (${validationResult.rejectedItems.join(', ')}) not found on signed contract. Blocked from RO.`;

    const updated = await db.collection('get_ready_forms').findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: newStatus,
          validation: validationRecord,
          updatedAt: now(),
        },
        $push: {
          audit_trail: {
            action: validationResult.isValid ? 'contract_validated' : 'contract_mismatch',
            by: req.user.name,
            at: now(),
            details: auditDetail,
          },
        },
      },
      { returnDocument: 'after' }
    );

    res.json({
      success: true,
      data: {
        status: newStatus,
        validation: validationRecord,
        get_ready: updated,
      },
    });
  }));

  // ─── RAISE REPAIR ORDER (RO) ───────────────────────────────────────────────
  router.post('/deliveries/get-ready/:id/raise-ro', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const getReady = await db.collection('get_ready_forms').findOne({ _id: id });
    if (!getReady) fail(404, 'Get Ready form not found.');

    const roNumber = string(req.body.ro_number || req.body.roNumber, 'RO number', { required: true, max: 40 }).toUpperCase();
    const deliveryDate = string(req.body.delivery_date || req.body.deliveryDate || getReady.delivery_date, 'Delivery date', { required: true });
    const deliveryTime = string(req.body.delivery_time || req.body.deliveryTime || getReady.delivery_time, 'Delivery time', { required: true });
    const deliveryDay = string(req.body.delivery_day || req.body.deliveryDay || getReady.delivery_day, 'Delivery day', { required: true });

    let deal = null;
    if (getReady.deal_id && ObjectId.isValid(getReady.deal_id)) {
      deal = await db.collection('deals').findOne({ _id: new ObjectId(getReady.deal_id) });
    }
    if (!deal && getReady.stock_number) {
      deal = await db.collection('deals').findOne({ stockNumber: getReady.stock_number, dealership: locationCondition(getReady.dealership) });
    }

    // Rule: Contract must be submitted
    if (!deal || !deal.contract) {
      fail(409, 'Cannot raise RO: A signed contract must be recorded on the deal first. Contract is the sole authority for RO items.');
    }

    const contractedItems = deal.contract?.items || deal.contract_items || [];
    const requestedRoItems = Array.isArray(req.body.items) ? req.body.items : (getReady.validation?.matchedItems || []);

    // Strict validation: No item can be on the RO unless it is on the contract!
    for (const item of requestedRoItems) {
      const itemStr = String(item).trim();
      if (!itemStr) continue;
      if (!itemMatchesContract(itemStr, contractedItems)) {
        fail(409, `Item "${itemStr}" is not on the signed contract and cannot be added to an RO. Contract is the source of truth.`);
      }
    }

    const roRaisedAt = now();
    const sublets = Array.isArray(req.body.sublets) ? req.body.sublets : (getReady.sublets || []);

    // 1. Update Get Ready Form
    const updatedGetReady = await db.collection('get_ready_forms').findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: 'ro_raised',
          ro_number: roNumber,
          ro_items: requestedRoItems,
          delivery_date: deliveryDate,
          delivery_time: deliveryTime,
          delivery_day: deliveryDay,
          sublets,
          ro_raised_at: roRaisedAt,
          ro_raised_by: req.user.name,
          updatedAt: roRaisedAt,
        },
        $push: {
          audit_trail: {
            $each: [
              {
                action: 'ro_raised',
                by: req.user.name,
                at: roRaisedAt,
                details: `Repair Order ${roNumber} raised with ${requestedRoItems.length} validated contract items. Delivery booked for ${deliveryDay} ${deliveryDate} at ${deliveryTime}.`,
              },
              {
                action: 'sales_log_updated',
                by: req.user.name,
                at: roRaisedAt,
                details: `Sales Log updated: Vehicle location set to BOOKED. RO #${roNumber} recorded.`,
              },
            ],
          },
        },
      },
      { returnDocument: 'after' }
    );

    // 2. Update / Insert Sales Log Record (Section 8)
    const salesLogEntry = {
      deal_id: deal ? String(deal._id) : getReady.deal_id,
      deal_number: getReady.deal_number,
      stock_number: getReady.stock_number,
      customer_name: getReady.customer_name,
      vehicle: getReady.vehicle,
      vehicle_location: 'BOOKED',
      delivery_date: deliveryDate,
      delivery_time: deliveryTime,
      delivery_day: deliveryDay,
      ro_number: roNumber,
      jobs: requestedRoItems,
      rwc: getReady.rwc_required ? 'Required' : 'N/A',
      diesel: getReady.diesel_required ? 'Required' : 'N/A',
      chemical: requestedRoItems.some(i => /chem|protection|ceramic|motor\s*one/i.test(i)) ? 'AutoXtreme' : 'N/A',
      tint: requestedRoItems.some(i => /tint/i.test(i)) ? 'Required' : 'N/A',
      floor_mats: getReady.floor_mats || 'Carpet',
      mechanical_pd: getReady.mechanical_pd ? 'Booked' : 'Pending',
      plastics_stripped: getReady.plastics_stripped ? 'Done' : 'Pending',
      detail_vehicle: getReady.detail_vehicle ? 'Booked' : 'Pending',
      is_fleet: Boolean(getReady.is_fleet),
      fleet_company: getReady.fleet_company || '',
      dealership: getReady.dealership,
      updated_at: roRaisedAt,
      updated_by: req.user.name,
    };

    await db.collection('sales_logs').updateOne(
      { stock_number: getReady.stock_number, dealership: getReady.dealership },
      { $set: salesLogEntry },
      { upsert: true }
    );

    // 3. Update Vehicle Location in Inventory Database to BOOKED
    try {
      const inventory = await inventoryDatabase(req);
      if (getReady.stock_number) {
        await inventory.collection('vehicles').updateMany(
          { stockNumber: getReady.stock_number, rooftopName: locationCondition(getReady.dealership) },
          {
            $set: {
              location: 'BOOKED',
              vehicleLocation: 'BOOKED',
              roNumber,
              deliveryDate,
              deliveryTime,
              updatedAt: new Date(),
            },
          }
        );
      }
    } catch {
      // Safe fallback if inventory update fails
    }

    // 4. Update Deliveries Collection
    try {
      const combinedDateTime = `${deliveryDate}T${deliveryTime.replace(/\s*[AP]M/i, '') || '09:00'}:00Z`;
      let whenDate;
      try { whenDate = dateBoundary(combinedDateTime); } catch { whenDate = new Date().toISOString(); }

      await db.collection('deliveries').updateOne(
        { $or: [{ get_ready_id: String(id) }, ...(deal ? [{ deal_id: deal._id }] : [])] },
        {
          $set: {
            ro_number: roNumber,
            when: whenDate,
            status: 'scheduled',
            accessories: requestedRoItems.map(item => ({
              id: new ObjectId().toString(),
              title: item,
              completedAt: null,
            })),
            updatedAt: roRaisedAt,
          },
        }
      );
    } catch {
      // Safe fallback
    }

    res.json({
      success: true,
      data: updatedGetReady,
      sales_log: salesLogEntry,
    });
  }));

  // ─── PRINTABLE RO & PARTS DISPATCH SHEET ───────────────────────────────────
  router.get('/deliveries/get-ready/:id/ro-sheet', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const getReady = await db.collection('get_ready_forms').findOne({ _id: id });
    if (!getReady) fail(404, 'Get Ready form not found.');

    let deal = null;
    if (getReady.deal_id && ObjectId.isValid(getReady.deal_id)) {
      deal = await db.collection('deals').findOne({ _id: new ObjectId(getReady.deal_id) });
    }

    const sheet = {
      dealership: getReady.dealership,
      document_title: 'REPAIR ORDER & PARTS DISPATCH SHEET',
      ro_number: getReady.ro_number || 'PENDING RO GENERATION',
      generated_at: now(),
      deal: {
        deal_number: getReady.deal_number,
        stock_number: getReady.stock_number,
        is_fleet: Boolean(getReady.is_fleet),
        fleet_company: getReady.fleet_company || '',
        salesman: getReady.salesman,
        finance_approval: getReady.finance_approval,
      },
      customer: {
        name: getReady.customer_name,
      },
      vehicle: {
        make: getReady.vehicle?.make || '',
        model: getReady.vehicle?.model || '',
        variant: getReady.vehicle?.variant || '',
        colour: getReady.vehicle?.colour || '',
        rego: getReady.vehicle?.rego || 'UNREGISTERED',
        vin: getReady.vehicle?.vin || '',
        locate: getReady.vehicle_locate,
      },
      booking: {
        delivery_date: getReady.delivery_date,
        delivery_time: getReady.delivery_time,
        delivery_day: getReady.delivery_day,
      },
      checkpoints: {
        rwc_required: getReady.rwc_required,
        diesel_required: getReady.diesel_required,
        plastics_stripped: getReady.plastics_stripped,
        mechanical_pd: getReady.mechanical_pd,
        floor_mats: getReady.floor_mats,
        detail_vehicle: getReady.detail_vehicle,
        completed_by: getReady.completed_by || null,
      },
      line_items: (getReady.ro_items || getReady.validation?.matchedItems || getReady.requested_items || []).map(item => ({
        description: item,
        status: 'validated_contract_item',
      })),
      sublets: getReady.sublets || [],
      parts_dispatch: {
        dispatched_at: getReady.parts_dispatched_at || null,
        dispatched_by: getReady.parts_dispatched_by || null,
      },
      notes: getReady.notes,
    };

    res.json({ success: true, data: sheet });
  }));

  // ─── MARK PARTS DISPATCHED / PRINTED ───────────────────────────────────────
  router.post('/deliveries/get-ready/:id/parts-dispatch', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const timestamp = now();

    const updated = await db.collection('get_ready_forms').findOneAndUpdate(
      { _id: id },
      {
        $set: {
          parts_dispatched_at: timestamp,
          parts_dispatched_by: req.user.name,
          updatedAt: timestamp,
        },
        $push: {
          audit_trail: {
            action: 'parts_dispatched',
            by: req.user.name,
            at: timestamp,
            details: 'Repair Order and Parts list printed/sent to Parts Department.',
          },
        },
      },
      { returnDocument: 'after' }
    );
    if (!updated) fail(404, 'Get Ready form not found.');

    res.json({ success: true, data: updated });
  }));

  // ─── DETAILER COMPLETION SIGN-OFF ──────────────────────────────────────────
  router.post('/deliveries/get-ready/:id/detail-complete', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const detailerName = string(req.body.detailer_name || req.body.detailerName, 'Detailer name', { required: true, max: 80 });
    const completionDate = string(req.body.completion_date || req.body.completionDate, 'Completion date') || now().slice(0, 10);
    const timestamp = now();

    const updated = await db.collection('get_ready_forms').findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: 'ready',
          completed_by: {
            name: detailerName,
            date: completionDate,
            signed_at: timestamp,
            user_id: req.user.id,
          },
          updatedAt: timestamp,
        },
        $push: {
          audit_trail: {
            action: 'detail_completed',
            by: req.user.name,
            at: timestamp,
            details: `Vehicle prep & detailing completed by ${detailerName} on ${completionDate}. Vehicle marked Ready for Delivery.`,
          },
        },
      },
      { returnDocument: 'after' }
    );
    if (!updated) fail(404, 'Get Ready form not found.');

    res.json({ success: true, data: updated });
  }));

  // ─── SUBLET VENDORS MASTER ─────────────────────────────────────────────────
  router.get('/deliveries/sublets/vendors', route(async (req, res) => {
    const db = await database(req);
    const dealership = req.query.rooftop && req.query.rooftop !== 'All Locations'
      ? req.query.rooftop
      : (req.user.primarySite || 'South Morang Hyundai');

    await seedVendorsIfEmpty(db, dealership);
    const vendors = await db.collection('sublet_vendors').find({ dealership: locationCondition(dealership) }).sort({ name: 1 }).toArray();
    res.json({ success: true, data: vendors });
  }));

  router.post('/deliveries/sublets/vendors', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can configure sublet vendors.');
    const db = await database(req);
    const name = string(req.body.name, 'Vendor name', { required: true, max: 100 });
    const category = string(req.body.category, 'Category', { required: true, max: 80 });
    const contactMethod = ['email', 'portal', 'phone', 'phone_email'].includes(req.body.contact_method)
      ? req.body.contact_method
      : 'email';
    const email = req.body.email ? string(req.body.email, 'Email', { max: 120 }) : '';
    const phone = req.body.phone ? string(req.body.phone, 'Phone', { max: 30 }) : '';
    const portalUrl = req.body.portal_url ? string(req.body.portal_url, 'Portal URL', { max: 250 }) : '';
    const instructions = string(req.body.instructions, 'Instructions', { max: 500 }) || '';
    const dealership = string(req.body.dealership, 'Dealership') || req.user.primarySite || 'South Morang Hyundai';

    if (!canAccessSite(req.user, dealership)) fail(403, 'You do not have access to this dealership.');

    const doc = {
      _id: new ObjectId(),
      name,
      category,
      contact_method: contactMethod,
      email,
      phone,
      portal_url: portalUrl,
      instructions,
      supported_brands: Array.isArray(req.body.supported_brands) ? req.body.supported_brands : [],
      notes: string(req.body.notes, 'Notes', { max: 1000 }) || '',
      dealership,
      created_by: req.user.id,
      createdAt: now(),
      is_default: false,
    };

    await db.collection('sublet_vendors').insertOne(doc);
    res.status(201).json({ success: true, data: doc });
  }));

  // ─── ADD SUBLET JOB TO GET READY ───────────────────────────────────────────
  router.post('/deliveries/get-ready/:id/sublets', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const getReady = await db.collection('get_ready_forms').findOne({ _id: id });
    if (!getReady) fail(404, 'Get Ready form not found.');

    const item = string(req.body.item, 'Item / job', { required: true, max: 150 });
    const vendorName = string(req.body.vendor_name || req.body.vendorName, 'Vendor name', { required: true, max: 100 });
    const subletNumber = string(req.body.sublet_number || req.body.subletNumber, 'Sublet number', { max: 50 }) || `SUB-${Date.now().toString().slice(-6)}`;
    const bookingMethod = ['email', 'portal', 'phone'].includes(req.body.booking_method) ? req.body.booking_method : 'email';
    const notes = string(req.body.notes, 'Sublet notes', { max: 1000 }) || '';

    const subletJob = {
      id: new ObjectId().toString(),
      item,
      vendor_name: vendorName,
      vendor_id: req.body.vendor_id || null,
      sublet_number: subletNumber,
      booking_method: bookingMethod,
      status: 'booked',
      notes,
      booked_at: now(),
      booked_by: req.user.name,
    };

    const updated = await db.collection('get_ready_forms').findOneAndUpdate(
      { _id: id },
      {
        $push: {
          sublets: subletJob,
          audit_trail: {
            action: 'sublet_booked',
            by: req.user.name,
            at: now(),
            details: `Sublet #${subletNumber} assigned to ${vendorName} for "${item}".`,
          },
        },
        $set: { updatedAt: now() },
      },
      { returnDocument: 'after' }
    );

    res.status(201).json({ success: true, data: subletJob, get_ready: updated });
  }));

  // ─── UPDATE SUBLET JOB STATUS ──────────────────────────────────────────────
  router.patch('/deliveries/get-ready/:id/sublets/:subletId', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const subletId = String(req.params.subletId);
    const getReady = await db.collection('get_ready_forms').findOne({ _id: id });
    if (!getReady) fail(404, 'Get Ready form not found.');

    const sublets = (getReady.sublets || []).map(s => ({ ...s }));
    const target = sublets.find(s => s.id === subletId);
    if (!target) fail(404, 'Sublet job not found.');

    if (req.body.status) target.status = string(req.body.status, 'Status', { max: 30 });
    if (req.body.notes !== undefined) target.notes = string(req.body.notes, 'Notes', { max: 1000 });
    if (req.body.sublet_number) target.sublet_number = string(req.body.sublet_number, 'Sublet number', { max: 50 });
    if (target.status === 'completed' && !target.completed_at) target.completed_at = now();

    const updated = await db.collection('get_ready_forms').findOneAndUpdate(
      { _id: id },
      {
        $set: { sublets, updatedAt: now() },
        $push: {
          audit_trail: {
            action: 'sublet_updated',
            by: req.user.name,
            at: now(),
            details: `Sublet #${target.sublet_number} (${target.vendor_name}) status updated to "${target.status}".`,
          },
        },
      },
      { returnDocument: 'after' }
    );

    res.json({ success: true, data: target, get_ready: updated });
  }));

  // ─── EMAIL DRAFT GENERATION (e.g. for Auto You) ───────────────────────────
  router.get('/deliveries/get-ready/:id/sublets/:subletId/email-draft', route(async (req, res) => {
    const db = await database(req);
    const id = cleanId(req.params.id, 'Get Ready form');
    const subletId = String(req.params.subletId);
    const getReady = await db.collection('get_ready_forms').findOne({ _id: id });
    if (!getReady) fail(404, 'Get Ready form not found.');

    const sublet = (getReady.sublets || []).find(s => s.id === subletId);
    if (!sublet) fail(404, 'Sublet job not found.');

    const vendor = await db.collection('sublet_vendors').findOne({ name: sublet.vendor_name, dealership: locationCondition(getReady.dealership) });
    const recipientEmail = vendor?.email || 'bookings@autoyou.com.au';

    const subject = `Sublet Booking - ${getReady.dealership} - Sublet #${sublet.sublet_number} - ${getReady.vehicle?.make} ${getReady.vehicle?.model} (${getReady.vehicle?.rego || getReady.stock_number})`;

    const bodyLines = [
      `Dear ${sublet.vendor_name} Bookings Team,`,
      '',
      `Please confirm the following sublet booking for ${getReady.dealership}:`,
      '',
      `• Sublet Number: ${sublet.sublet_number}`,
      `• Required Work: ${sublet.item}`,
      `• Target Delivery Booking: ${getReady.delivery_day} ${getReady.delivery_date} at ${getReady.delivery_time}`,
      `• Deal Number: ${getReady.deal_number}`,
      `• Stock Number: ${getReady.stock_number}`,
      `• Customer: ${getReady.customer_name}`,
      `• Vehicle: ${getReady.vehicle?.make} ${getReady.vehicle?.model} ${getReady.vehicle?.variant || ''} (${getReady.vehicle?.colour || ''})`,
      `• Rego: ${getReady.vehicle?.rego || 'TBA'}`,
      `• VIN: ${getReady.vehicle?.vin || 'TBA'}`,
      `• Vehicle Location: ${getReady.vehicle_locate}`,
      '',
      sublet.notes ? `Notes / Instructions:\n${sublet.notes}\n` : '',
      `Kind regards,`,
      `${req.user.name}`,
      `${getReady.dealership} Delivery Centre`,
    ];

    res.json({
      success: true,
      data: {
        to: recipientEmail,
        subject,
        body: bodyLines.filter(line => line !== undefined).join('\n'),
      },
    });
  }));

  // ─── SALES LOG LIST ────────────────────────────────────────────────────────
  router.get('/deliveries/sales-log', route(async (req, res) => {
    const db = await database(req);
    const query = {};
    if (req.query.rooftop && req.query.rooftop !== 'All Locations') {
      query.dealership = locationCondition(req.query.rooftop);
    }
    if (req.query.search) {
      const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = { $regex: escaped, $options: 'i' };
      query.$or = [
        { deal_number: searchRegex },
        { stock_number: searchRegex },
        { customer_name: searchRegex },
        { ro_number: searchRegex },
        { 'vehicle.rego': searchRegex },
        { 'vehicle.vin': searchRegex },
      ];
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const collection = db.collection('sales_logs');
    const [total, rows] = await Promise.all([
      collection.countDocuments(query),
      collection.find(query).sort({ delivery_date: -1, updated_at: -1, _id: 1 }).skip(skip).limit(limit).toArray(),
    ]);

    res.json({
      success: true,
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  }));

  // ─── UPDATE CONTRACT ITEMS ON DEAL ─────────────────────────────────────────
  router.patch('/deals/:id/contract-items', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'A manager must update contract line items.');
    const db = await database(req);
    const id = cleanId(req.params.id, 'deal');
    const deal = await db.collection('deals').findOne({ _id: id });
    if (!deal) fail(404, 'Deal not found.');

    const items = Array.isArray(req.body.items)
      ? req.body.items.map(i => String(i).trim()).filter(Boolean)
      : [];

    const updateFields = {
      contract_items: items,
      updatedAt: now(),
    };
    if (deal.contract) {
      updateFields['contract.items'] = items;
    }

    const updated = await db.collection('deals').findOneAndUpdate(
      { _id: id },
      { $set: updateFields },
      { returnDocument: 'after' }
    );

    res.json({ success: true, data: updated });
  }));
}

module.exports = {
  installDeliveryCentre,
  validateItemsAgainstContract,
  itemMatchesContract,
  normalizeText,
  DEFAULT_VENDORS,
};
