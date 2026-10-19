const dns = require('dns');
if (typeof dns.setServers === 'function') {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch (_) {}
}
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { text, escapeRegex, pageQuery, leadQuery, vehicleQuery, actionQuery } = require('./lib/query');
const { scopedDatabase } = require('./lib/access');
const { installAuth } = require('./lib/auth');
const { invalid, dealership, serializeLead, createLead, leadUpdate, actionUpdate, appointmentInput, dateBoundary } = require('./lib/records');
const { changeHold, serializeVehicle } = require('./lib/vehicle-holds');
const { installPublicMedia, installCustomerMessages } = require('./lib/customer-messages');
const mobileMessage = require('./lib/mobilemessage');
const { createMediaStorage } = require('./lib/mongo-media-storage');


require('dotenv').config();

// Reuse a connected pool and its in-flight promise across serverless requests.
const connections = new Map();
async function database(envKey) {
  if (!connections.has(envKey)) {
    const uri = process.env[envKey];
    if (!uri) throw new Error(`${envKey} is not configured`);
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000 });
    const pending = client.connect().then(() => client.db()).catch(async (error) => {
      connections.delete(envKey);
      await client.close().catch(() => {});
      throw error;
    });
    connections.set(envKey, pending);
  }
  return connections.get(envKey);
}

function createApp({ database: resolveDatabase = database, sms = mobileMessage, storage: providedStorage } = {}) {
const app = express();
const storage = providedStorage || createMediaStorage(() => resolveDatabase('MONGODB_URI_FLWUP'));

// CORS setup for production (Vercel & Custom Domains)
app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
      callback(null, !origin || allowed.includes(origin) || (!process.env.VERCEL && /^http:\/\/localhost:\d+$/.test(origin)));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    if (req.method === 'PUT' && /^\/(api\/)?leads\/[^/]+\/media\/[^/]+\/content$/.test(req.path)) return next();
    if (req.body === undefined && !req.headers['content-length'] && !req.headers['transfer-encoding']) req.body = {};
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ success: false, error: 'The request body must be a JSON object.' });
  }
  next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim());
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && !allowed.includes(origin) && !(!process.env.VERCEL && /^http:\/\/localhost:\d+$/.test(origin))) return res.status(403).json({ success: false, error: 'Request origin is not allowed.' });
  next();
});

const getFlwupDb = async (req) => { const db = await resolveDatabase('MONGODB_URI_FLWUP'); return req ? scopedDatabase(db, req.user, req.query.rooftop) : db; };
const getBooranDb = async (req) => { const db = await resolveDatabase('MONGODB_URI_BOORAN'); return req ? scopedDatabase(db, req.user, req.query.rooftop) : db; };

// Router for all API routes (mounted at both /api and / for seamless Vercel compatibility)
const router = express.Router();
router.use((req, res, next) => {
  for (const key of Object.keys(req.query)) {
    if (typeof req.query[key] !== 'string') return res.status(400).json({ success: false, error: 'Query parameters must be single text values.' });
    req.query[key] = text(req.query[key]);
  }
  next();
});

// Root check
router.get('/', (req, res) => {
  res.json({
    name: 'Booran Motors Sales Floor API',
    status: 'online',
    version: '1.0.0',
    documentation: '/api/health',
  });
});

// Health Check
router.get('/health', async (req, res) => {
  const [flwupConnected, booranConnected] = await Promise.all([
    getFlwupDb().then((db) => db.command({ ping: 1 }, { maxTimeMS: 3000 })).then(() => true, () => false),
    getBooranDb().then((db) => db.command({ ping: 1 }, { maxTimeMS: 3000 })).then(() => true, () => false),
  ]);
  res.status(flwupConnected && booranConnected ? 200 : 503).json({
    status: flwupConnected && booranConnected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    databases: {
      flwup_crm: flwupConnected ? 'connected' : 'error',
      booran_inventory_tracker: booranConnected ? 'connected' : 'error',
    },
  });
});

// ─── AUTH ENDPOINTS ──────────────────────────────────────────────────────────

installPublicMedia(router, () => resolveDatabase('MONGODB_URI_FLWUP'), storage);
installAuth(router, () => resolveDatabase('MONGODB_URI_FLWUP'));
installCustomerMessages(router, getFlwupDb, sms, storage);

router.get('/leads', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const { page, limit, skip, sort: sortOptions } = pageQuery(req.query, 'leads', 'created_at');

    const query = leadQuery(req.query);

    const [leads, total] = await Promise.all([
      db.collection('leads').find(query).sort(sortOptions).skip(skip).limit(limit).toArray(),
      db.collection('leads').countDocuments(query),
    ]);

    const formattedLeads = leads.map(serializeLead);

    res.json({
      success: true,
      data: formattedLeads,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('Error fetching leads:', err);
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const { id } = req.params;
    let query;
    try {
      query = { _id: new ObjectId(id) };
    } catch {
      query = { deal_id: id };
    }

    const lead = await db.collection('leads').findOne(query);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    res.json({ success: true, data: serializeLead(lead) });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.post('/leads', async (req, res) => {
  try {
    const newLead = createLead(req.body, req.user);
    const db = await getFlwupDb(req);

    const result = await db.collection('leads').insertOne(newLead);
    res.status(201).json({ success: true, data: serializeLead({ ...newLead, _id: result.insertedId }) });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.patch('/leads/:id', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const { id } = req.params;
    let query;
    try {
      query = { _id: new ObjectId(id) };
    } catch {
      query = { deal_id: id };
    }

    const updateDoc = leadUpdate(req.body, req.user);

    const result = await db.collection('leads').findOneAndUpdate(query, updateDoc, { returnDocument: 'after' });
    if (!result) return res.status(404).json({ success: false, error: 'Lead not found.' });
    res.json({ success: true, data: serializeLead(result) });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/crm/stats', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const [total, statusBreakdown, rooftopBreakdown] = await Promise.all([
      db.collection('leads').countDocuments(),
      db.collection('leads').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
      db.collection('leads').aggregate([{ $group: { _id: '$dealership_name', count: { $sum: 1 } } }]).toArray(),
    ]);

    const statusCounts = Object.create(null);
    statusBreakdown.forEach((s) => {
      statusCounts[s._id || 'unknown'] = s.count;
    });

    res.json({
      success: true,
      data: {
        totalLeads: total,
        statusCounts,
        newLeads: statusCounts.new_lead || 0,
        followingUp: statusCounts.following_up || 0,
        sold: statusCounts.sold || 0,
        lost: statusCounts.lost || 0,
        dealerships: rooftopBreakdown.map((r) => ({ name: r._id || 'Unspecified', count: r.count })),
        conversionRate: total > 0 ? ((statusCounts.sold || 0) / total * 100).toFixed(1) + '%' : '0%',
      },
    });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/crm/rooftops', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const rooftops = await db.collection('rooftops').find().toArray();
    res.json({ success: true, data: rooftops });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/crm/organization', async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ success: false, error: 'Super admin access is required.' });
  try {
    const db = await getFlwupDb(req);
    const org = await db.collection('organizations').findOne();
    res.json({ success: true, data: org });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/staff', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const ownersAgg = await db.collection('leads').aggregate([
      { $match: { owner_name: { $type: 'string', $nin: [null, ''] } } },
      {
        $group: {
          _id: { name: '$owner_name', dealership: '$dealership_name' },
          dealership: { $first: '$dealership_name' },
          totalLeads: { $sum: 1 },
          soldCount: {
            $sum: { $cond: [{ $eq: ['$status', 'sold'] }, 1, 0] },
          },
          followingUpCount: {
            $sum: { $cond: [{ $eq: ['$status', 'following_up'] }, 1, 0] },
          },
        },
      },
      { $sort: { totalLeads: -1 } },
    ]).toArray();

    const staffMembers = ownersAgg.map((s, idx) => ({
      _id: `${s._id.name}:${s._id.dealership || ''}`,
      name: s._id.name,
      role: 'Sales Consultant',
      position: 'Senior Automotive Consultant',
      site: s.dealership || 'Booran Motors',
      active: true,
      totalLeads: s.totalLeads,
      soldCount: s.soldCount,
      followingUpCount: s.followingUpCount,
      conversionRate: s.totalLeads > 0 ? ((s.soldCount / s.totalLeads) * 100).toFixed(1) + '%' : '0%',
      loadCapacity: Math.min(100, Math.round((s.followingUpCount / 25) * 100)),
      initials: String(s._id.name || 'Unassigned')
        .split(' ')
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
    }));

    res.json({
      success: true,
      data: staffMembers,
      total: staffMembers.length,
      availableSites: Array.from(new Set(staffMembers.map((member) => member.site))),
    });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

// ─── INVENTORY & CAPITAL TRACKER ENDPOINTS (BOORAN_INVENTORY_TRACKER) ────────

router.get('/inventory/vehicles', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { page, limit, skip, sort: sortOptions } = pageQuery(req.query, 'vehicles', 'daysInStock');

    const query = vehicleQuery(req.query);

    const [vehicles, total] = await Promise.all([
      db.collection('vehicles').find(query).sort(sortOptions).skip(skip).limit(limit).toArray(),
      db.collection('vehicles').countDocuments(query),
    ]);

    res.json({
      success: true,
      data: vehicles.map((vehicle) => serializeVehicle(vehicle)),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('Error fetching inventory vehicles:', err);
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/inventory/vehicles/:id', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { id } = req.params;
    let query;
    try {
      query = { _id: new ObjectId(id) };
    } catch {
      query = { stockNumber: id };
    }

    const vehicle = await db.collection('vehicles').findOne(query);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    res.json({ success: true, data: serializeVehicle(vehicle) });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.post('/inventory/vehicles/:id/soft-hold', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { id } = req.params;
    let query;
    try {
      query = { _id: new ObjectId(id) };
    } catch {
      query = { stockNumber: id };
    }

    const result = await changeHold(db.collection('vehicles'), query, req.body, req.user);
    res.json({ success: true, message: 'Vehicle placed on soft hold', data: result });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.post('/inventory/vehicles/:id/release-hold', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { id } = req.params;
    let query;
    try {
      query = { _id: new ObjectId(id) };
    } catch {
      query = { stockNumber: id };
    }

    const result = await changeHold(db.collection('vehicles'), query, req.body, req.user, true);
    res.json({ success: true, message: 'Vehicle hold released', data: result });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

// ACTION ITEMS (Capital Trap / Price Reviews / Wholesale)
router.get('/inventory/action-items', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { page, limit, skip, sort: sortOptions } = pageQuery(req.query, 'actions', 'createdAt');

    const query = actionQuery(req.query);

    const [items, total] = await Promise.all([
      db.collection('actionitems').find(query).sort(sortOptions).skip(skip).limit(limit).toArray(),
      db.collection('actionitems').countDocuments(query),
    ]);

    res.json({
      success: true,
      data: items,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.patch('/inventory/action-items/:id', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { id } = req.params;
    if (!ObjectId.isValid(id)) invalid('Invalid action item ID.');
    const query = { _id: new ObjectId(id) };
    const updateDoc = actionUpdate(req.body, req.user);

    const result = await db.collection('actionitems').findOneAndUpdate(query, updateDoc, { returnDocument: 'after' });
    if (!result) return res.status(404).json({ success: false, error: 'Record not found.' });
    res.json({ success: true, message: 'Action item updated', data: result });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/inventory/rooftops', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const rooftops = await db.collection('rooftops').find().toArray();
    res.json({ success: true, data: rooftops });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/inventory/feed-logs', async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ success: false, error: 'Super admin access is required.' });
  try {
    const db = await getBooranDb(req);
    const { page, limit, skip, sort } = pageQuery(req.query, 'logs', 'createdAt');
    const query = {};
    if (req.query.status && req.query.status !== 'all') query.status = req.query.status;
    if (req.query.search) query.$or = ['feedType', 'notes'].map((field) => ({ [field]: { $regex: escapeRegex(req.query.search), $options: 'i' } }));
    const [data, total] = await Promise.all([db.collection('feedlogs').find(query).sort(sort).skip(skip).limit(limit).toArray(), db.collection('feedlogs').countDocuments(query)]);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Unable to load feed logs.' });
  }
});

router.post('/inventory/sync-csv', async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ success: false, error: 'Super admin access is required.' });
  try {
    const { syncCsvData } = require('./scripts/ingest-csv');
    const result = await syncCsvData();
    res.json({ success: true, message: 'CSV data synchronized successfully.', data: result });
  } catch (error) {
    console.error('CSV sync error:', error);
    res.status(500).json({ success: false, error: 'Failed to synchronize CSV data.' });
  }
});

router.get('/inventory/stats', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const [
      totalVehicles,
      agingBucketsAgg,
      categoriesAgg,
      totalActionItems,
      actionTypeAgg,
      costAgg,
    ] = await Promise.all([
      db.collection('vehicles').countDocuments(),
      db.collection('vehicles').aggregate([{ $group: { _id: '$agingBucket', count: { $sum: 1 } } }]).toArray(),
      db.collection('vehicles').aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }]).toArray(),
      db.collection('actionitems').countDocuments({ status: 'open' }),
      db.collection('actionitems').aggregate([
        { $match: { status: 'open' } },
        { $group: { _id: '$actionType', count: { $sum: 1 } } },
      ]).toArray(),
      db.collection('vehicles').aggregate([
        {
          $group: {
            _id: null,
            totalStockCost: { $sum: '$totalStockCost' },
            totalHoldingCost: { $sum: '$accumulatedHoldingCost' },
            avgDaysInStock: { $avg: '$daysInStock' },
          },
        },
      ]).toArray(),
    ]);

    const agingBuckets = Object.create(null);
    agingBucketsAgg.forEach((b) => {
      agingBuckets[b._id || 'unknown'] = b.count;
    });

    const categories = Object.create(null);
    categoriesAgg.forEach((c) => {
      categories[c._id || 'unknown'] = c.count;
    });

    const actionTypes = Object.create(null);
    actionTypeAgg.forEach((a) => {
      actionTypes[a._id || 'unknown'] = a.count;
    });

    const totals = costAgg[0] || { totalStockCost: 0, totalHoldingCost: 0, avgDaysInStock: 0 };

    res.json({
      success: true,
      data: {
        totalVehicles,
        agingBuckets,
        categories,
        over90DaysCount: agingBuckets['90+'] || 0,
        openActionItems: totalActionItems,
        actionTypes,
        totalStockCost: totals.totalStockCost || 0,
        totalHoldingCost: totals.totalHoldingCost || 0,
        avgDaysInStock: Math.round(totals.avgDaysInStock || 0),
      },
    });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

// ─── APPOINTMENTS & SHOWROOM TIMELINE ────────────────────────────────────────

router.get('/appointments', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const { page, limit, skip } = pageQuery(req.query, 'appointments', 'when');
    const query = {};
    if (req.query.from || req.query.to) {
      query.when = {};
      for (const [key, operator] of [['from', '$gte'], ['to', '$lt']]) {
        if (!req.query[key]) continue;
        query.when[operator] = dateBoundary(req.query[key]);
      }
    }
    if (query.when?.$gte && query.when?.$lt && query.when.$gte >= query.when.$lt) invalid('The end date must follow the start date.');
    if (req.query.type && req.query.type !== 'all') query.type = req.query.type;
    const [data, total] = await Promise.all([
      db.collection('appointments').find(query).sort({ when: 1, _id: 1 }).skip(skip).limit(limit).toArray(),
      db.collection('appointments').countDocuments(query),
    ]);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(error.status === 400 ? 400 : 500).json({ success: false, error: error.status === 400 ? error.message : 'Unable to load appointments.' });
  }
});
router.post('/appointments', async (req, res) => {
  try {
    const input = appointmentInput(req.body);
    const db = await getFlwupDb(req);
    let linkedLead = null;
    if (req.body.leadId) {
      const leadId = text(req.body.leadId);
      linkedLead = await db.collection('leads').findOne(ObjectId.isValid(leadId) ? { _id: new ObjectId(leadId) } : { deal_id: leadId });
      if (!linkedLead) return res.status(404).json({ success: false, error: 'Lead not found in your authorised locations.' });
    }
    const site = dealership(req.body.dealership || linkedLead?.dealership_name);
    if (linkedLead && site.toLowerCase() !== linkedLead.dealership_name.toLowerCase()) invalid('The appointment must use the linked lead dealership.');
    const appointment = { ...input, dealership: site };
    const result = await db.collection('appointments').insertOne(appointment);
    res.status(201).json({ success: true, data: { ...appointment, _id: result.insertedId.toString() } });
  } catch (error) {
    res.status([400, 403].includes(error.status) ? error.status : 500).json({ success: false, error: [400, 403].includes(error.status) ? error.message : 'Unable to save appointment. Please retry.' });
  }
});

router.get('/unified/summary', async (req, res) => {
  try {
    const fDb = await getFlwupDb(req);
    const bDb = await getBooranDb(req);

    const [
      leadsCount,
      followingUpCount,
      newLeadsCount,
      inventoryCount,
      aging90Count,
      actionItemsCount,
    ] = await Promise.all([
      fDb.collection('leads').countDocuments(),
      fDb.collection('leads').countDocuments({ status: 'following_up' }),
      fDb.collection('leads').countDocuments({ status: 'new_lead' }),
      bDb.collection('vehicles').countDocuments(),
      bDb.collection('vehicles').countDocuments({ agingBucket: '90+' }),
      bDb.collection('actionitems').countDocuments({ status: 'open' }),
    ]);

    res.json({
      success: true,
      data: {
        crm: {
          totalLeads: leadsCount,
          followingUp: followingUpCount,
          newLeads: newLeadsCount,
        },
        inventory: {
          totalVehicles: inventoryCount,
          agingOver90Days: aging90Count,
          openActionItems: actionItemsCount,
        },
        system: {
          rooftopGroup: req.user.role === 'super_admin' ? 'Booran Motors VIC' : req.user.site,
          activeRooftops: (await bDb.collection('rooftops').countDocuments()),
          lastSync: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

router.get('/unified/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || !q.trim()) {
      return res.json({ success: true, data: { leads: [], vehicles: [], actionItems: [] } });
    }

    const regex = new RegExp(escapeRegex(q), 'i');
    const fDb = await getFlwupDb(req);
    const bDb = await getBooranDb(req);

    const [leads, vehicles, actionItems] = await Promise.all([
      fDb.collection('leads').find({
        $or: [
          { customer_name: regex },
          { customer_phone: regex },
          { customer_email: regex },
          { vehicle_model: regex },
          { vehicle_make: regex },
        ],
      }).limit(10).toArray(),
      bDb.collection('vehicles').find({
        $or: [
          { stockNumber: regex },
          { vin: regex },
          { make: regex },
          { model: regex },
          { variant: regex },
          { rego: regex },
        ],
      }).limit(10).toArray(),
      bDb.collection('actionitems').find({
        $or: [
          { vehicleTitle: regex },
          { stockNumber: regex },
          { vin: regex },
          { reason: regex },
        ],
      }).limit(10).toArray(),
    ]);

    res.json({
      success: true,
      data: {
        leads: leads.map(serializeLead),
        vehicles: vehicles.map((vehicle) => serializeVehicle(vehicle)),
        actionItems,
      },
    });
  } catch (err) {
    res.status([400, 403, 404, 409].includes(err.status) ? err.status : 500).json({ success: false, error: [400, 403, 404, 409].includes(err.status) ? err.message : 'The request could not be completed. Please retry.' });
  }
});

// Mount router at both /api and / for seamless Vercel / serverless compatibility
app.use('/api', router);
app.use('/', router);
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found.' }));
app.use((error, req, res, next) => {
  console.error('API request failed:', error.message);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : error instanceof SyntaxError ? 400 : 500;
  const message = { 400: 'Invalid request.', 413: 'Request is too large.', 415: 'The request content type or encoding is not supported.' };
  res.status(status).json({ success: false, error: message[status] || 'The request could not be completed.' });
});

return app;
}

const app = createApp();
// Start server if run directly (local development)
if (!process.env.VERCEL) {
  if (require.main === module) {
    const port = process.env.PORT || 5001;
    app.listen(port, () => {
      console.log(`=======================================================`);
      console.log(`Booran Motors Sales Floor API running on port ${port}`);
      console.log(`Health endpoint: http://localhost:${port}/api/health`);
      console.log(`=======================================================`);

      if (process.env.AUTO_SYNC_CSV !== 'false') {
        const { syncCsvData, startCsvWatcher } = require('./scripts/ingest-csv');
        syncCsvData()
          .then((res) => console.log(`📦 Auto-sync CSV complete: ${res.inserted || 0} inserted, ${res.updated || 0} updated.`))
          .catch((err) => console.warn('⚠️ Auto-sync CSV skipped/failed:', err.message));

        if (process.env.WATCH_CSV !== 'false') {
          startCsvWatcher();
        }
      }
    });
  }
}

// Export for Vercel Serverless Function
module.exports = app;
module.exports.createApp = createApp;
