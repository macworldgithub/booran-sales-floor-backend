const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { text, escapeRegex, pageQuery } = require('./lib/query');
const { scopedDatabase } = require('./lib/access');
const { installAuth } = require('./lib/auth');


require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

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
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim());
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && !allowed.includes(origin) && !(!process.env.VERCEL && /^http:\/\/localhost:\d+$/.test(origin))) return res.status(403).json({ success: false, error: 'Request origin is not allowed.' });
  next();
});
app.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

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
const getFlwupDb = async (req) => { const db = await database('MONGODB_URI_FLWUP'); return req ? scopedDatabase(db, req.user, req.query.rooftop) : db; };
const getBooranDb = async (req) => { const db = await database('MONGODB_URI_BOORAN'); return req ? scopedDatabase(db, req.user, req.query.rooftop) : db; };

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
  let flwupConnected = false;
  let booranConnected = false;
  try {
    const fDb = await getFlwupDb();
    await fDb.command({ ping: 1 });
    flwupConnected = true;
  } catch (e) {
    flwupConnected = false;
  }
  try {
    const bDb = await getBooranDb();
    await bDb.command({ ping: 1 });
    booranConnected = true;
  } catch (e) {
    booranConnected = false;
  }
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

installAuth(router, () => database('MONGODB_URI_FLWUP'));

router.get('/leads', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const { page, limit, skip, sort: sortOptions } = pageQuery(req.query, 'leads', 'created_at');

    const { status, dealership, owner, search, sortBy = 'created_at', sortOrder = 'desc' } = req.query;

    const query = {};

    if (status && status !== 'all' && status !== 'All') {
      query.status = status;
    }

    if (dealership && dealership !== 'all' && dealership !== 'All Locations' && dealership !== 'All') {
      query.dealership_name = new RegExp(escapeRegex(dealership), 'i');
    }

    if (owner && owner !== 'all' && owner !== 'All') {
      query.owner_name = new RegExp(escapeRegex(owner), 'i');
    }

    if (search && search.trim()) {
      const s = escapeRegex(search);
      query.$or = [
        { customer_name: { $regex: s, $options: 'i' } },
        { customer_phone: { $regex: s, $options: 'i' } },
        { customer_email: { $regex: s, $options: 'i' } },
        { vehicle_model: { $regex: s, $options: 'i' } },
        { vehicle_make: { $regex: s, $options: 'i' } },
        { deal_id: { $regex: s, $options: 'i' } },
      ];
    }


    const [leads, total] = await Promise.all([
      db.collection('leads').find(query).sort(sortOptions).skip(skip).limit(limit).toArray(),
      db.collection('leads').countDocuments(query),
    ]);

    const formattedLeads = leads.map((l) => ({
      _id: l._id.toString(),
      id: l._id.toString(),
      deal_id: l.deal_id,
      name: l.customer_name || 'Anonymous Prospect',
      initials: (l.customer_name || 'PR')
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
      phone: l.customer_phone || '',
      email: l.customer_email || '',
      vehicle: l.vehicle_make ? `${l.vehicle_make} ${l.vehicle_model || ''}`.trim() : (l.vehicle_model || 'Unspecified Vehicle'),
      make: l.vehicle_make || 'BYD',
      model: l.vehicle_model || '',
      status: l.status || 'new_lead',
      dealership: l.dealership_name || 'Booran Motors',
      dealership_name: l.dealership_name || 'Booran Motors',
      dealer_code: l.dealer_code || 'BOORAN',
      owner_name: l.owner_name || 'Unassigned',
      assignedTo: l.owner_name || 'Unassigned',
      source: l.source || 'Manual',
      created_at: l.created_at || l.createdAt || new Date().toISOString(),
      first_contact_at: l.first_contact_at,
      minutes_to_first_contact: l.minutes_to_first_contact,
      first_followup_due_at: l.first_followup_due_at,
      had_contact_opportunity: l.had_contact_opportunity,
      follow_ups_sent: l.follow_ups_sent || 0,
      priority: l.status === 'new_lead' || (l.minutes_to_first_contact && l.minutes_to_first_contact > 60),
      testDrive: l.test_drive,
      tradeIn: l.trade_in,
      diary_entries: l.diary_entries || [],
      post_sales_followup: l.post_sales_followup,
    }));

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
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
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

    res.json({ success: true, data: lead });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

router.post('/leads', async (req, res) => {
  if (!text(req.body.name || req.body.customer_name)) return res.status(400).json({ success: false, error: 'A customer name is required.' });
  try {
    const db = await getFlwupDb(req);
    const newLead = {
      deal_id: 'BOORAN-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
      dealership_name: req.body.dealership_name || 'BYD South Morang',
      dealer_code: 'BOORAN',
      owner_name: req.body.owner_name || 'Lewis Dannock',
      source: req.body.source || 'Walk-in Showroom',
      customer_name: req.body.name || req.body.customer_name,
      customer_phone: req.body.phone || req.body.customer_phone || '',
      customer_email: req.body.email || req.body.customer_email || '',
      vehicle_make: req.body.vehicle_make || 'BYD',
      vehicle_model: req.body.vehicle_model || req.body.vehicle || 'Sealion 7',
      created_at: new Date().toISOString(),
      status: req.body.status || 'new_lead',
      had_contact_opportunity: true,
      follow_ups_sent: 0,
      diary_entries: req.body.notes
        ? [{ author: 'Sales Floor', date: new Date().toISOString(), note: req.body.notes }]
        : [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('leads').insertOne(newLead);
    res.status(201).json({ success: true, data: { ...newLead, _id: result.insertedId } });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
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

    const allowedFields = ['status', 'owner_name', 'assignedTo', 'dealership_name', 'customer_name', 'customer_phone', 'customer_email', 'vehicle_make', 'vehicle_model', 'notes', 'testDrive', 'tradeIn', 'newNote', 'author'];
    const updateFields = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowedFields.includes(key)));
    updateFields.updatedAt = new Date();
    delete updateFields._id;

    let updateDoc = { $set: updateFields };
    if (req.body.newNote) {
      delete updateFields.newNote;
      updateDoc = {
        $set: updateFields,
        $push: {
          diary_entries: {
            author: req.body.author || 'Megan Taylor',
            date: new Date().toISOString(),
            note: req.body.newNote,
          },
        },
      };
    }

    const result = await db.collection('leads').findOneAndUpdate(query, updateDoc, { returnDocument: 'after' });
    if (!result) return res.status(404).json({ success: false, error: 'Lead not found.' });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
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

    const statusCounts = {};
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
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

router.get('/crm/rooftops', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const rooftops = await db.collection('rooftops').find().toArray();
    res.json({ success: true, data: rooftops });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

router.get('/crm/organization', async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ success: false, error: 'Super admin access is required.' });
  try {
    const db = await getFlwupDb(req);
    const org = await db.collection('organizations').findOne();
    res.json({ success: true, data: org });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

router.get('/staff', async (req, res) => {
  try {
    const db = await getFlwupDb(req);
    const ownersAgg = await db.collection('leads').aggregate([
      { $match: { owner_name: { $nin: [null, ''] } } },
      {
        $group: {
          _id: '$owner_name',
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
      _id: 'staff-' + idx,
      name: s._id,
      role: 'Sales Consultant',
      position: 'Senior Automotive Consultant',
      site: s.dealership || 'Booran Motors',
      active: true,
      totalLeads: s.totalLeads,
      soldCount: s.soldCount,
      followingUpCount: s.followingUpCount,
      conversionRate: s.totalLeads > 0 ? ((s.soldCount / s.totalLeads) * 100).toFixed(1) + '%' : '0%',
      loadCapacity: Math.min(100, Math.round((s.followingUpCount / 25) * 100)),
      initials: s._id
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
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

// ─── INVENTORY & CAPITAL TRACKER ENDPOINTS (BOORAN_INVENTORY_TRACKER) ────────

router.get('/inventory/vehicles', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { page, limit, skip, sort: sortOptions } = pageQuery(req.query, 'vehicles', 'daysInStock');

    const { category, agingBucket, rooftop, make, search, status, sortBy = 'daysInStock', sortOrder = 'desc' } = req.query;

    const query = {};

    if (category && category !== 'all' && category !== 'All') {
      query.category = category;
    }

    if (agingBucket && agingBucket !== 'all' && agingBucket !== 'All') {
      query.agingBucket = agingBucket;
    }

    if (rooftop && rooftop !== 'all' && rooftop !== 'All Locations' && rooftop !== 'All') {
      query.rooftopName = new RegExp(escapeRegex(rooftop), 'i');
    }

    if (make && make !== 'all' && make !== 'All') {
      query.make = new RegExp(`^${escapeRegex(make)}$`, 'i');
    }

    if (status && status !== 'all' && status !== 'All') {
      query.status = status;
    }

    if (search && search.trim()) {
      const s = escapeRegex(search);
      query.$or = [
        { stockNumber: { $regex: s, $options: 'i' } },
        { vin: { $regex: s, $options: 'i' } },
        { make: { $regex: s, $options: 'i' } },
        { model: { $regex: s, $options: 'i' } },
        { variant: { $regex: s, $options: 'i' } },
        { colour: { $regex: s, $options: 'i' } },
        { rego: { $regex: s, $options: 'i' } },
      ];
    }


    const [vehicles, total] = await Promise.all([
      db.collection('vehicles').find(query).sort(sortOptions).skip(skip).limit(limit).toArray(),
      db.collection('vehicles').countDocuments(query),
    ]);

    res.json({
      success: true,
      data: vehicles,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('Error fetching inventory vehicles:', err);
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
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

    res.json({ success: true, data: vehicle });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

router.post('/inventory/vehicles/:id/soft-hold', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { id } = req.params;
    const { prospectName, notes, consultant } = req.body;

    let query;
    try {
      query = { _id: new ObjectId(id) };
    } catch {
      query = { stockNumber: id };
    }

    const updateDoc = {
      $set: {
        softHold: {
          held: true,
          prospectName: prospectName || 'Valued Customer',
          notes: notes || 'Showroom Soft Hold for test drive',
          consultant: consultant || 'Megan Taylor',
          heldAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        },
        status: 'Soft Hold',
        updatedAt: new Date(),
      },
    };

    const result = await db.collection('vehicles').findOneAndUpdate(query, updateDoc, { returnDocument: 'after' });
    if (!result) return res.status(404).json({ success: false, error: 'Record not found.' });
    res.json({ success: true, message: 'Vehicle placed on soft hold', data: result });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
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

    const updateDoc = {
      $unset: { softHold: '' },
      $set: { status: 'In Stock', updatedAt: new Date() },
    };

    const result = await db.collection('vehicles').findOneAndUpdate(query, updateDoc, { returnDocument: 'after' });
    if (!result) return res.status(404).json({ success: false, error: 'Record not found.' });
    res.json({ success: true, message: 'Vehicle hold released', data: result });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

// ACTION ITEMS (Capital Trap / Price Reviews / Wholesale)
router.get('/inventory/action-items', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { page, limit, skip, sort: sortOptions } = pageQuery(req.query, 'actions', 'createdAt');

    const { actionType, priority, status = 'open', rooftop, search } = req.query;

    const query = {};

    if (actionType && actionType !== 'all' && actionType !== 'All') {
      query.actionType = actionType;
    }

    if (priority && priority !== 'all' && priority !== 'All') {
      query.priority = priority;
    }

    if (status && status !== 'all' && status !== 'All') {
      query.status = status;
    }

    if (rooftop && rooftop !== 'all' && rooftop !== 'All Locations' && rooftop !== 'All') {
      query.rooftopName = new RegExp(escapeRegex(rooftop), 'i');
    }

    if (search && search.trim()) {
      const s = escapeRegex(search);
      query.$or = [
        { vehicleTitle: { $regex: s, $options: 'i' } },
        { stockNumber: { $regex: s, $options: 'i' } },
        { vin: { $regex: s, $options: 'i' } },
        { reason: { $regex: s, $options: 'i' } },
      ];
    }

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
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

router.patch('/inventory/action-items/:id', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const { id } = req.params;
    const { status, resolvedNotes } = req.body;

    const query = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: {
        status: status || 'resolved',
        resolvedAt: new Date().toISOString(),
        resolvedNotes: resolvedNotes || 'Actioned by Sales Manager',
        updatedAt: new Date(),
      },
    };

    const result = await db.collection('actionitems').findOneAndUpdate(query, updateDoc, { returnDocument: 'after' });
    if (!result) return res.status(404).json({ success: false, error: 'Record not found.' });
    res.json({ success: true, message: 'Action item updated', data: result });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

router.get('/inventory/rooftops', async (req, res) => {
  try {
    const db = await getBooranDb(req);
    const rooftops = await db.collection('rooftops').find().toArray();
    res.json({ success: true, data: rooftops });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
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

    const agingBuckets = {};
    agingBucketsAgg.forEach((b) => {
      agingBuckets[b._id || 'unknown'] = b.count;
    });

    const categories = {};
    categoriesAgg.forEach((c) => {
      categories[c._id || 'unknown'] = c.count;
    });

    const actionTypes = {};
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
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
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
        const date = new Date(req.query[key]);
        if (!Number.isFinite(date.getTime())) return res.status(400).json({ success: false, error: 'Invalid appointment date range.' });
        query.when[operator] = date.toISOString();
      }
    }
    if (req.query.type && req.query.type !== 'all') query.type = req.query.type;
    const [data, total] = await Promise.all([
      db.collection('appointments').find(query).sort({ when: 1, _id: 1 }).skip(skip).limit(limit).toArray(),
      db.collection('appointments').countDocuments(query),
    ]);
    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Unable to load appointments.' });
  }
});
router.post('/appointments', async (req, res) => {
  const when = new Date(req.body.when);
  const duration = Number(req.body.duration || 45);
  if (!text(req.body.prospectName) || !Number.isFinite(when.getTime()) || !Number.isInteger(duration) || duration < 5 || duration > 480) {
    return res.status(400).json({ success: false, error: 'Provide a customer, valid appointment time and duration (5?480 minutes).' });
  }
  try {
    const db = await getFlwupDb(req);
    const appointment = {
      dealership: req.user.role === 'super_admin' ? text(req.body.dealership) || 'South Morang' : req.user.site,
      leadId: text(req.body.leadId), prospectName: text(req.body.prospectName),
      consultantName: text(req.body.consultantName), vehicle: text(req.body.vehicle),
      type: text(req.body.type) || 'Test Drive', when: when.toISOString(), duration,
      notes: text(req.body.notes, 2000), status: 'Booked', createdAt: new Date().toISOString(),
    };
    const result = await db.collection('appointments').insertOne(appointment);
    res.status(201).json({ success: true, data: { ...appointment, _id: result.insertedId.toString() } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Unable to save appointment. Please retry.' });
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
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
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
        leads,
        vehicles,
        actionItems,
      },
    });
  } catch (err) {
    res.status(err.status === 403 ? 403 : 500).json({ success: false, error: err.status === 403 ? 'You do not have access to this location.' : 'The request could not be completed. Please retry.' });
  }
});

// Mount router at both /api and / for seamless Vercel / serverless compatibility
app.use('/api', router);
app.use('/', router);
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found.' }));
app.use((error, req, res, next) => {
  console.error('API request failed:', error.message);
  const status = error.status === 413 ? 413 : error instanceof SyntaxError ? 400 : 500;
  res.status(status).json({ success: false, error: status === 400 ? 'Invalid JSON request.' : status === 413 ? 'Request is too large.' : 'The request could not be completed.' });
});

// Start server if run directly (local development)
if (!process.env.VERCEL) {
  if (require.main === module) {
    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`Booran Motors Sales Floor API running on port ${PORT}`);
      console.log(`Health endpoint: http://localhost:${PORT}/api/health`);
      console.log(`=======================================================`);
    });
  }
}

// Export for Vercel Serverless Function
module.exports = app;
