const { phoneKey, phonePattern } = require('./phone');
const ALLOWED_SORTS = {
  leads: ['created_at', 'customer_name', 'status', 'dealership_name', 'assigned_at'],
  vehicles: ['daysInStock', 'totalStockCost', 'make', 'model', 'stockNumber', 'createdAt'],
  actions: ['createdAt', 'priority', 'actionType', 'stockNumber'],
  logs: ['createdAt'],
  appointments: ['when', 'createdAt'],
  workflow: ['createdAt', 'due_at', 'when', 'updatedAt', 'checkedAt'],
};

function text(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function escapeRegex(value) {
  return text(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LOCATION_GROUPS = {
  'south morang': ['South Morang', 'BYD South Morang', 'Chery South Morang', 'South Morang Hyundai', 'South Morang Kia'],
};

function isAllLocations(value) {
  return !text(value) || ['all', 'all locations'].includes(text(value).toLowerCase());
}

function locationCondition(value) {
  const name = text(value);
  const names = Object.hasOwn(LOCATION_GROUPS, name.toLowerCase()) ? LOCATION_GROUPS[name.toLowerCase()] : [name];
  return { $regex: `^(?:${names.map(escapeRegex).join('|')})$`, $options: 'i' };
}

function searchFields(query, search, fields) {
  if (text(search)) query.$or = fields.map((field) => ({ [field]: {
    $regex: field === 'customer_phone' && phoneKey(search) ? phonePattern(search) :
      field === 'customer_name' ? text(search).split(/\s+/).map(escapeRegex).join('\\s+') : escapeRegex(search), $options: 'i',
  } }));
  if (text(search) && fields.includes('customer_phone') && phoneKey(search)) query.$or.push({ alternate_phones: { $regex: phonePattern(search) } });
  if (text(search) && fields.includes('customer_name')) query.$or.push({ customer_name_aliases: {
    $regex: text(search).split(/\s+/).map(escapeRegex).join('\\s+'), $options: 'i',
  } });
  return query;
}

function leadQuery(params) {
  const query = { merged_into: { $exists: false } };
  if (!isAllLocations(params.status)) query.status = params.status;
  else if (params.attention === 'true') query.status = { $in: ['new_lead', 'following_up'] };
  if (['new_lead', 'following_up', 'returned'].includes(params.status) || params.attention === 'true') {
    query['sms_campaign.active'] = { $ne: false };
  }
  if (!isAllLocations(params.dealership)) query.dealership_name = locationCondition(params.dealership);
  if (!isAllLocations(params.owner)) query.owner_name = { $regex: `^${escapeRegex(params.owner)}$`, $options: 'i' };
  if (!isAllLocations(params.source)) query.$and = [{ $or: [
    { source: { $regex: `^${escapeRegex(params.source)}$`, $options: 'i' } },
    { 'source_refs.source': { $regex: `^${escapeRegex(params.source)}$`, $options: 'i' } },
  ] }];
  if (params.assignment === 'unassigned') query.$and = [...(query.$and || []), { $or: [{ owner_id: { $exists: false } }, { owner_id: null }] }];
  if (params.assignment === 'assigned') query.owner_id = { $type: 'string' };
  if (params.ownerId) query.owner_id = params.ownerId;
  if (!isAllLocations(params.channel)) query['nexgate.channel'] = { $regex: `^${escapeRegex(params.channel)}$`, $options: 'i' };
  return searchFields(query, params.search, ['customer_name', 'customer_phone', 'customer_email', 'business_name', 'vehicle_model', 'vehicle_make', 'deal_id']);
}

function vehicleQuery(params, now = new Date(), deals = new Map()) {
  const query = {};
  for (const field of ['category', 'agingBucket', 'status']) if (!isAllLocations(params[field])) query[field] = params[field];
  if (params.agingBucket === '31-60') query.agingBucket = { $in: ['31-45', '46-60', '31-60'] };
  const stockIds = status => [...deals].filter(([, value]) => value === status).map(([id]) => id);
  const pending = stockIds('registered');
  const sold = stockIds('completed');
  if (params.status === 'Deal Pending') {
    delete query.status;
    query.$and = [{ $or: [
      { status: { $in: ['Deal Pending', 'DEAL PENDING', 'DEAL-PENDING', 'PENDING'] } },
      { dealPending: true },
      ...(pending.length ? [{ _id: { $in: pending }, status: { $in: ['In Stock', 'IN-STOCK'] } }] : []),
    ] }];
  }
  if (params.status === 'Sold') {
    delete query.status;
    query.$and = [{ $or: [{ status: { $in: ['Sold', 'SOLD'] } }, ...(sold.length ? [{ _id: { $in: sold } }] : [])] }];
  }
  // Expired holds are available stock even before the next inventory feed writes back.
  if (['In Stock', 'IN-STOCK'].includes(params.status)) {
    delete query.status;
    query.$and = [{ $or: [{ status: { $in: ['In Stock', 'IN-STOCK'] } }, { status: 'Soft Hold', 'softHold.expiresAt': { $lte: now.toISOString() } }] }];
    query.dealPending = { $ne: true };
    if (deals.size) query._id = { $nin: [...deals.keys()] };
  } else if (params.status === 'Soft Hold') {
    query.$and = [{ $or: [{ 'softHold.expiresAt': { $gt: now.toISOString() } }, { 'softHold.expiresAt': { $exists: false } }] }];
  }
  if (!isAllLocations(params.rooftop)) query.rooftopName = locationCondition(params.rooftop);
  if (!isAllLocations(params.make)) query.make = { $regex: `^${escapeRegex(params.make)}$`, $options: 'i' };
  return searchFields(query, params.search, ['stockNumber', 'vin', 'make', 'model', 'variant', 'colour', 'rego']);
}

function actionQuery(params) {
  const query = {};
  for (const field of ['actionType', 'priority']) if (!isAllLocations(params[field])) query[field] = params[field];
  const status = params.status === undefined ? 'open' : params.status;
  if (!isAllLocations(status)) query.status = status;
  if (!isAllLocations(params.rooftop)) query.rooftopName = locationCondition(params.rooftop);
  return searchFields(query, params.search, ['vehicleTitle', 'stockNumber', 'vin', 'reason']);
}

function integer(value, fallback, maximum) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, maximum) : fallback;
}

function pageQuery(query, collection, defaultSort) {
  const page = integer(query.page, 1, 1000000);
  const limit = integer(query.limit, 20, 100);
  const sortBy = ALLOWED_SORTS[collection].includes(query.sortBy) ? query.sortBy : defaultSort;
  return { page, limit, skip: (page - 1) * limit, sort: { [sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 } };
}

module.exports = { text, escapeRegex, pageQuery, isAllLocations, locationCondition, LOCATION_GROUPS, leadQuery, vehicleQuery, actionQuery };
