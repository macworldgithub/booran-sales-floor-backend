const { ObjectId } = require('mongodb');
const { accountSites, canAccessSite, isManager } = require('./roles');
const { string, dealership, dateBoundary } = require('./records');
const { text, isAllLocations, locationCondition, LOCATION_GROUPS } = require('./query');
const { reference } = require('./lead-allocation');
const { fail, route, list } = require('./workflow-route');

const active = ['new_lead', 'following_up'];
const defaults = { followUpHours: 72, conversionTarget: 15, monthlyTarget: 10 };
const timeFormat = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'longOffset',
});

function localDateParts(date) {
  return Object.fromEntries(timeFormat.formatToParts(date).map(({ type, value }) => [type, value]));
}

function periodWindow(period, now = new Date()) {
  const { year, month, day } = localDateParts(now);
  const start = new Date(Date.UTC(+year, +month - 1, +day));
  if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (period === 'month') start.setUTCDate(1);
  const nextDay = new Date(Date.UTC(+year, +month - 1, +day + 1));
  const midnight = date => {
    const offset = localDateParts(new Date(+date - 10 * 3600000)).timeZoneName.slice(3);
    return new Date(`${date.toISOString().slice(0, 10)}T00:00:00${offset}`).toISOString();
  };
  return { from: midnight(start), to: midnight(nextDay) };
}

function calendarDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'Enter a calendar day as YYYY-MM-DD.');
  const day = dateBoundary(value);
  const { from, to } = periodWindow('today', new Date(Date.parse(day) + 12 * 3600000));
  return { $gte: from, $lt: to };
}

async function getPulse(req, database) {
  const db = await database(req);
  const requested = isAllLocations(req.query.rooftop) ? req.user.site : req.query.rooftop;
  const settings = canAccessSite(req.user, requested) && await (await database()).collection('pulse_settings').findOne({ _id: text(requested).toLowerCase() });
  const config = { ...defaults, ...settings };
  const now = new Date();
  const period = ['today', 'week', 'month'].includes(req.query.period) ? req.query.period : 'today';
  const { from, to } = periodWindow(period, now);
  const range = { $gte: from, $lt: to };
  const staff = text(req.query.staff);
  if (staff && (!isManager(req.user) || !ObjectId.isValid(staff))) fail(403, 'This team view requires a manager account.');
  const userId = staff || (isManager(req.user) ? '' : req.user.id);
  const leadOwner = userId ? { owner_id: userId } : {};
  const leadScope = { ...leadOwner, merged_into: { $exists: false } };
  const deals = db.collection('deals');
  const leads = db.collection('leads');
  const followUpBefore = new Date(+now - config.followUpHours * 3600000).toISOString();
  const outstanding = {
    ...leadScope, status: { $in: active },
    $or: [
      { first_followup_due_at: { $gt: '', $lte: now.toISOString() }, status: 'new_lead' },
      { last_activity_at: { $gt: '', $lte: followUpBefore } },
      { last_activity_at: { $in: [null, ''] }, created_at: { $gt: '', $lte: followUpBefore } },
    ],
  };
  const [currentActive, unactioned, appointments, overdue, completed, periodLeads, periodSold, videos, attention, team, walkIns, sites, models] = await Promise.all([
    leads.countDocuments({ ...leadScope, status: { $in: active } }),
    leads.countDocuments({ ...leadScope, status: 'new_lead' }),
    db.collection('appointments').countDocuments({ ...(userId ? { consultant_id: userId } : {}), when: range, status: { $ne: 'Cancelled' } }),
    leads.countDocuments(outstanding),
    deals.countDocuments({ ...leadOwner, status: 'completed', completed_at: range }),
    leads.countDocuments({ ...leadScope, created_at: range }),
    leads.countDocuments({ ...leadScope, created_at: range, status: 'sold' }),
    db.collection('customer_messages').countDocuments({
      ...(userId ? { user_id: userId } : {}), created_at: range, status: { $in: ['queued', 'sent', 'delivered'] },
      'attachments.content_type': { $regex: '^video/' },
    }),
    leads.find(outstanding).sort({ first_followup_due_at: 1, created_at: 1, _id: 1 }).limit(10).toArray(),
    isManager(req.user) && !staff ? leads.aggregate([
      { $match: { owner_id: { $type: 'string' }, merged_into: { $exists: false }, created_at: range } },
      { $group: { _id: '$owner_id', name: { $first: '$owner_name' }, leads: { $sum: 1 }, sales: { $sum: { $cond: [{ $eq: ['$status', 'sold'] }, 1, 0] } } } },
      { $sort: { name: 1, _id: 1 } }, { $limit: 100 },
    ]).toArray() : [],
    leads.countDocuments({ ...leadScope, created_at: range, source: { $regex: 'walk[ -]?in', $options: 'i' } }),
    isManager(req.user) ? leads.aggregate([
      { $match: { ...leadScope, created_at: range } },
      { $group: { _id: '$dealership_name', leads: { $sum: 1 }, sales: { $sum: { $cond: [{ $eq: ['$status', 'sold'] }, 1, 0] } } } },
      { $sort: { _id: 1 } }, { $limit: 100 },
    ]).toArray() : [],
    isManager(req.user) ? leads.aggregate([
      { $match: { ...leadScope, created_at: range, status: 'sold' } },
      { $group: { _id: { make: '$vehicle_make', model: '$vehicle_model' }, count: { $sum: 1 } } },
      { $sort: { count: -1, '_id.make': 1, '_id.model': 1 } }, { $limit: 30 },
    ]).toArray() : [],
  ]);
  const conversion = periodLeads ? Math.round(periodSold / periodLeads * 1000) / 10 : 0;
  return {
    period, currentActive, unactioned, appointments, overdue, completed, conversion, videos, monthlyTarget: config.monthlyTarget,
    periodLeads, periodSold, walkIns,
    signals: { followUp: overdue ? 'red' : unactioned ? 'amber' : 'green', conversion: conversion >= config.conversionTarget ? 'green' : conversion >= config.conversionTarget / 2 ? 'amber' : 'red' },
    attention: attention.map(lead => ({ id: String(lead._id), name: lead.customer_name, dealership: lead.dealership_name, owner: lead.owner_name })),
    team: team.map(member => ({ id: member._id, name: member.name, leads: member.leads, sales: member.sales })),
    sites: sites.map(site => ({ name: site._id || 'Unspecified dealership', leads: site.leads, sales: site.sales })),
    models: models.map(model => ({ name: [model._id.make, model._id.model].filter(Boolean).join(' ') || 'Unspecified vehicle', sales: model.count })),
  };
}

function installPulse(router, database) {
  router.get('/pulse', route(async (req, res) => {
    if (req.user.role === 'contractor') fail(403, 'Sales reporting requires a sales account.');
    const data = await getPulse(req, database);
    res.json({ success: true, data });
  }));

  router.get('/team-activity', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Team activity requires a manager account.');
    const db = await database(req);
    const raw = await database();
    const requested = isAllLocations(req.query.rooftop) ? null : locationCondition(req.query.rooftop);
    const siteFilter = requested && new RegExp(requested.$regex, requested.$options);
    const staff = (await raw.collection('users').find({ active: true, role: 'sales_consultant' }, {
      projection: { name: 1, site: 1, allowedSites: 1 },
    }).sort({ name: 1, _id: 1 }).toArray()).filter(user =>
      accountSites(user).flatMap(site => Object.hasOwn(LOCATION_GROUPS, site.toLowerCase()) ? LOCATION_GROUPS[site.toLowerCase()] : [site]).some(site =>
        canAccessSite(req.user, site) && (!siteFilter || siteFilter.test(site))));
    const ids = staff.map(user => String(user._id));
    const { from, to } = periodWindow('today');
    const [leads, tasks, bookings] = ids.length ? await Promise.all([
      db.collection('leads').aggregate([
        { $match: { owner_id: { $in: ids }, merged_into: { $exists: false } } },
        { $group: { _id: '$owner_id',
          active: { $sum: { $cond: [{ $in: ['$status', active] }, 1, 0] } },
          updated: { $sum: { $cond: [{ $and: [
            { $gte: ['$updatedAt', new Date(from)] }, { $lt: ['$updatedAt', new Date(to)] },
          ] }, 1, 0] } },
        } },
      ]).toArray(),
      db.collection('sales_tasks').aggregate([
        { $match: { assignee_id: { $in: ids }, $or: [{ status: 'open' }, { status: 'completed', completed_at: { $gte: from, $lt: to } }] } },
        { $group: { _id: '$assignee_id',
          open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        } },
      ]).toArray(),
      db.collection('appointments').aggregate([
        { $match: { consultant_id: { $in: ids }, when: { $gte: from, $lt: to }, status: { $ne: 'Cancelled' } } },
        { $group: { _id: '$consultant_id', count: { $sum: 1 } } },
      ]).toArray(),
    ]) : [[], [], []];
    const leadStats = new Map(leads.map(row => [row._id, row]));
    const taskStats = new Map(tasks.map(row => [row._id, row]));
    const bookingCounts = new Map(bookings.map(row => [row._id, row.count]));
    res.json({ success: true, data: staff.map((user, index) => {
      const id = ids[index];
      return { id, name: user.name, site: user.site,
        activeLeads: leadStats.get(id)?.active ?? 0, leadsUpdated: leadStats.get(id)?.updated ?? 0,
        openTasks: taskStats.get(id)?.open ?? 0, tasksCompleted: taskStats.get(id)?.completed ?? 0,
        appointments: bookingCounts.get(id) ?? 0,
      };
    }) });
  }));

  router.patch('/pulse/settings', route(async (req, res) => {
    const site = dealership(req.body.dealership);
    if (!isManager(req.user) || !canAccessSite(req.user, site)) fail(403, 'You cannot configure this dealership.');
    const config = {};
    for (const [field, max] of [['followUpHours', 720], ['conversionTarget', 100], ['monthlyTarget', 10000]]) {
      const value = req.body[field];
      if (!Number.isInteger(value) || value < 1 || value > max) fail(400, `Invalid ${field}.`);
      config[field] = value;
    }
    await (await database()).collection('pulse_settings').updateOne({ _id: site.toLowerCase() }, { $set: config }, { upsert: true });
    res.json({ success: true, data: config });
  }));

  router.get('/sales-tasks', route(async (req, res) => {
    const db = await database(req);
    const query = {};
    if (req.query.status === 'open' || req.query.status === 'completed') query.status = req.query.status;
    if (req.query.assignee === 'me') query.assignee_id = req.user.id;
    if (req.query.date) query.due_at = calendarDay(req.query.date);
    if (req.query.consultant && isManager(req.user)) query.assignee_name = req.query.consultant;
    res.json(await list(db.collection('sales_tasks'), req, query, 'due_at'));
  }));

  router.post('/leads/:id/tasks', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Only managers can assign tasks.');
    const db = await database(req);
    const lead = await db.collection('leads').findOne(reference(req.params.id));
    if (!lead) fail(404, 'Lead not found.');
    const id = req.body.assigneeId || lead.owner_id;
    if (typeof id !== 'string' || !ObjectId.isValid(id)) fail(400, 'Allocate this lead or choose a task assignee first.');
    const user = await (await database()).collection('users').findOne({ _id: new ObjectId(id), active: true });
    if (!user || user.role === 'contractor' || !canAccessSite(user, lead.dealership_name)) fail(403, 'Assignee is unavailable at this dealership.');
    const task = {
      title: string(req.body.title, 'Task', { required: true }), notes: string(req.body.notes, 'Notes', { max: 2000 }),
      dealership: lead.dealership_name, lead_id: String(lead._id), assignee_id: id, assignee_name: user.name,
      created_by: req.user.id, createdAt: new Date().toISOString(), due_at: dateBoundary(req.body.dueAt), status: 'open',
    };
    const result = await db.collection('sales_tasks').insertOne(task);
    res.status(201).json({ success: true, data: { ...task, _id: result.insertedId } });
  }));

  router.patch('/sales-tasks/:id', route(async (req, res) => {
    if (!ObjectId.isValid(req.params.id) || !['completed', 'open'].includes(req.body.status)) fail(400, 'Choose a valid task and status.');
    const db = await database(req);
    const updated = await db.collection('sales_tasks').findOneAndUpdate({ _id: new ObjectId(req.params.id) }, {
      $set: { status: req.body.status, completed_at: req.body.status === 'completed' ? new Date().toISOString() : null },
    }, { returnDocument: 'after' });
    if (!updated) fail(404, 'Task not found.');
    res.json({ success: true, data: updated });
  }));
}

module.exports = { installPulse, periodWindow, calendarDay };
