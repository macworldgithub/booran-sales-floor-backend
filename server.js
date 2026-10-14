const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const dns = require('dns');

// Configure reliable DNS servers for MongoDB Atlas SRV resolution
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch (e) {
  console.warn('DNS server override warning:', e.message);
}

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

// CORS setup for production (Vercel & Custom Domains)
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow any origin or null (for mobile/curl)
      callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.use(express.json());

// In-memory appointments store with default upcoming showroom visits
let appointmentsStore = [
  {
    _id: 'appt-1',
    leadId: 'sample-1',
    prospectName: 'Cameron Bale',
    consultantName: 'Lewis Dannock',
    vehicle: 'BYD Atto 2 Dmi',
    type: 'Test Drive',
    when: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    duration: 45,
    notes: 'South Morang test track · Customer looking to finance via novated lease',
    status: 'Booked',
    createdAt: new Date().toISOString(),
  },
  {
    _id: 'appt-2',
    leadId: 'sample-2',
    prospectName: 'Sarah Jenkins',
    consultantName: 'Denis Dzemailoski',
    vehicle: 'BYD Sealion 7',
    type: 'Showroom Visit',
    when: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    duration: 30,
    notes: 'Colour selection and trade-in valuation review',
    status: 'Booked',
    createdAt: new Date().toISOString(),
  },
  {
    _id: 'appt-3',
    leadId: 'sample-3',
    prospectName: 'Michael Chang',
    consultantName: 'Dylan K',
    vehicle: 'Hyundai Kona Electric',
    type: 'Test Drive',
    when: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    duration: 60,
    notes: 'Highway loop comparison vs Kia EV5',
    status: 'Booked',
    createdAt: new Date().toISOString(),
  },
];

// Serverless-ready MongoDB connection caching
let cachedFlwupClient = null;
let cachedBooranClient = null;
let cachedFlwupDb = null;
let cachedBooranDb = null;

async function getFlwupDb() {
  if (cachedFlwupDb) return cachedFlwupDb;
  const uri = process.env.MONGODB_URI_FLWUP;
  if (!uri) throw new Error('MONGODB_URI_FLWUP is not defined in environment');
  if (!cachedFlwupClient) {
    cachedFlwupClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });
    await cachedFlwupClient.connect();
  }
  cachedFlwupDb = cachedFlwupClient.db();
  return cachedFlwupDb;
}

async function getBooranDb() {
  if (cachedBooranDb) return cachedBooranDb;
  const uri = process.env.MONGODB_URI_BOORAN;
  if (!uri) throw new Error('MONGODB_URI_BOORAN is not defined in environment');
  if (!cachedBooranClient) {
    cachedBooranClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });
    await cachedBooranClient.connect();
  }
  cachedBooranDb = cachedBooranClient.db();
  return cachedBooranDb;
}

// Router for all API routes (mounted at both /api and / for seamless Vercel compatibility)
const router = express.Router();

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
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    databases: {
      flwup_crm: flwupConnected ? 'connected' : 'error',
      booran_inventory_tracker: booranConnected ? 'connected' : 'error',
    },
  });
});

// ─── AUTH ENDPOINTS ──────────────────────────────────────────────────────────

router.post('/auth/login', async (req, res) => {
  const { email } = req.body;
  const user = {
    id: 'user-megan-1',
    name: email?.toLowerCase().includes('paul') ? 'Paul Booran' : 'Megan Taylor',
    email: email || 'megant@booranmotors.com.au',
    role: email?.toLowerCase().includes('paul') ? 'principal' : 'manager',
    title: email?.toLowerCase().includes('paul') ? 'Dealer Principal' : 'Group Marketing & Operations',
    site: 'Booran Motors Group - All Locations',
    avatar: email?.toLowerCase().includes('paul') ? 'PB' : 'MT',
  };

  res.json({
    success: true,
    data: {
      access_token: 'booran_jwt_token_' + Date.now(),
      user,
      must_change_password: false,
    },
  });
});

router.get('/auth/me', async (req, res) => {
  res.json({
    success: true,
    data: {
      id: 'user-megan-1',
      name: 'Megan Taylor',
      email: 'megant@booranmotors.com.au',
      role: 'manager',
      title: 'Group Marketing & Operations',
      site: 'Booran Motors Group - All Locations',
      avatar: 'MT',
    },
  });
});

// ─── CRM & LEADS ENDPOINTS (FLWUP_CRM) ────────────────────────────────────────

router.get('/leads', async (req, res) => {
  try {
    const db = await getFlwupDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip = (page - 1) * limit;

    const { status, dealership, owner, search, sortBy = 'created_at', sortOrder = 'desc' } = req.query;

    const query = {};

    if (status && status !== 'all' && status !== 'All') {
      query.status = status;
    }

    if (dealership && dealership !== 'all' && dealership !== 'All Locations' && dealership !== 'All') {
      query.dealership_name = new RegExp(dealership, 'i');
    }

    if (owner && owner !== 'all' && owner !== 'All') {
      query.owner_name = new RegExp(owner, 'i');
    }

    if (search && search.trim()) {
      const s = search.trim();
      query.$or = [
        { customer_name: { $regex: s, $options: 'i' } },
        { customer_phone: { $regex: s, $options: 'i' } },
        { customer_email: { $regex: s, $options: 'i' } },
        { vehicle_model: { $regex: s, $options: 'i' } },
        { vehicle_make: { $regex: s, $options: 'i' } },
        { deal_id: { $regex: s, $options: 'i' } },
      ];
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

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
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/leads/:id', async (req, res) => {
  try {
    const db = await getFlwupDb();
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
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/leads', async (req, res) => {
  try {
    const db = await getFlwupDb();
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
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/leads/:id', async (req, res) => {
  try {
    const db = await getFlwupDb();
    const { id } = req.params;
    let query;
    try {
      query = { _id: new ObjectId(id) };
    } catch {
      query = { deal_id: id };
    }

    const updateFields = { ...req.body, updatedAt: new Date() };
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
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/crm/stats', async (req, res) => {
  try {
    const db = await getFlwupDb();
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
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/crm/rooftops', async (req, res) => {
  try {
    const db = await getFlwupDb();
    const rooftops = await db.collection('rooftops').find().toArray();
    res.json({ success: true, data: rooftops });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/crm/organization', async (req, res) => {
  try {
    const db = await getFlwupDb();
    const org = await db.collection('organizations').findOne();
    res.json({ success: true, data: org });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/staff', async (req, res) => {
  try {
    const db = await getFlwupDb();
    const ownersAgg = await db.collection('leads').aggregate([
      { $match: { owner_name: { $ne: null, $ne: '' } } },
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
      availableSites: [
        'All Locations',
        'BYD South Morang',
        'Chery South Morang',
        'South Morang Hyundai',
        'South Morang Kia',
        'Booran Cheltenham',
      ],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── INVENTORY & CAPITAL TRACKER ENDPOINTS (BOORAN_INVENTORY_TRACKER) ────────

router.get('/inventory/vehicles', async (req, res) => {
  try {
    const db = await getBooranDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 24));
    const skip = (page - 1) * limit;

    const { category, agingBucket, rooftop, make, search, status, sortBy = 'daysInStock', sortOrder = 'desc' } = req.query;

    const query = {};

    if (category && category !== 'all' && category !== 'All') {
      query.category = category;
    }

    if (agingBucket && agingBucket !== 'all' && agingBucket !== 'All') {
      query.agingBucket = agingBucket;
    }

    if (rooftop && rooftop !== 'all' && rooftop !== 'All Locations' && rooftop !== 'All') {
      query.rooftopName = new RegExp(rooftop, 'i');
    }

    if (make && make !== 'all' && make !== 'All') {
      query.make = new RegExp(`^${make}$`, 'i');
    }

    if (status && status !== 'all' && status !== 'All') {
      query.status = status;
    }

    if (search && search.trim()) {
      const s = search.trim();
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

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;

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
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/inventory/vehicles/:id', async (req, res) => {
  try {
    const db = await getBooranDb();
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
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/inventory/vehicles/:id/soft-hold', async (req, res) => {
  try {
    const db = await getBooranDb();
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
    res.json({ success: true, message: 'Vehicle placed on soft hold', data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/inventory/vehicles/:id/release-hold', async (req, res) => {
  try {
    const db = await getBooranDb();
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
    res.json({ success: true, message: 'Vehicle hold released', data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ACTION ITEMS (Capital Trap / Price Reviews / Wholesale)
router.get('/inventory/action-items', async (req, res) => {
  try {
    const db = await getBooranDb();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip = (page - 1) * limit;

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
      query.rooftopName = new RegExp(rooftop, 'i');
    }

    if (search && search.trim()) {
      const s = search.trim();
      query.$or = [
        { vehicleTitle: { $regex: s, $options: 'i' } },
        { stockNumber: { $regex: s, $options: 'i' } },
        { vin: { $regex: s, $options: 'i' } },
        { reason: { $regex: s, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      db.collection('actionitems').find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
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
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/inventory/action-items/:id', async (req, res) => {
  try {
    const db = await getBooranDb();
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
    res.json({ success: true, message: 'Action item updated', data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/inventory/rooftops', async (req, res) => {
  try {
    const db = await getBooranDb();
    const rooftops = await db.collection('rooftops').find().toArray();
    res.json({ success: true, data: rooftops });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/inventory/feed-logs', async (req, res) => {
  try {
    const db = await getBooranDb();
    const logs = await db.collection('feedlogs').find().sort({ createdAt: -1 }).limit(10).toArray();
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/inventory/stats', async (req, res) => {
  try {
    const db = await getBooranDb();
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── APPOINTMENTS & SHOWROOM TIMELINE ────────────────────────────────────────

router.get('/appointments', (req, res) => {
  res.json({ success: true, data: appointmentsStore });
});

router.post('/appointments', (req, res) => {
  const newAppt = {
    _id: 'appt-' + Date.now(),
    leadId: req.body.leadId,
    prospectName: req.body.prospectName || 'Customer',
    consultantName: req.body.consultantName || 'Lewis Dannock',
    vehicle: req.body.vehicle || 'BYD Range',
    type: req.body.type || 'Test Drive',
    when: req.body.when || new Date().toISOString(),
    duration: req.body.duration || 45,
    notes: req.body.notes || 'Melbourne CBD Loop',
    status: 'Booked',
    createdAt: new Date().toISOString(),
  };
  appointmentsStore.unshift(newAppt);
  res.status(201).json({ success: true, data: newAppt });
});

// ─── UNIFIED CROSS-DATABASE DASHBOARD & SEARCH ────────────────────────────────

router.get('/unified/summary', async (req, res) => {
  try {
    const fDb = await getFlwupDb();
    const bDb = await getBooranDb();

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
          rooftopGroup: 'Booran Motors VIC',
          activeRooftops: 4,
          lastSync: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/unified/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || !q.trim()) {
      return res.json({ success: true, data: { leads: [], vehicles: [], actionItems: [] } });
    }

    const regex = new RegExp(q.trim(), 'i');
    const fDb = await getFlwupDb();
    const bDb = await getBooranDb();

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
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mount router at both /api and / for seamless Vercel / serverless compatibility
app.use('/api', router);
app.use('/', router);

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
