const { ObjectId } = require('mongodb');
const { isManager, canAccessSite, accountSites } = require('./roles');
const { isAllLocations, locationCondition, LOCATION_GROUPS, pageQuery } = require('./query');
const { route, fail } = require('./workflow-route');
const { serializeLead, LEAD_PROJECTION } = require('./records');
const { periodWindow, calendarDay } = require('./pulse');
const { getWorkdayMetrics } = require('./workday-metrics');
const { dayKey, prospectOverdue, isActiveLead } = require('./followup-policy');
const { shareUrl } = require('./customer-messages');
const { dealerSocketReference } = require('./lead-identity');
const successful = row => ['queued', 'sent', 'delivered'].includes(row.status);
const activeProspect = lead => isActiveLead(lead) && (lead.source_active ?? lead.sms_campaign?.active) !== false;
const reportTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const mediaProjection = { _id: 1, lead_id: 1, content_type: 1, created_at: 1, share_token: 1,
  status: 1, visibility: 1, name: 1, views: 1, reviews: 1 };
function pastedMediaTokens(body) {
  const prefix = shareUrl({ share_token: '' });
  return (String(body || '').match(/https?:\/\/[^\s<>"']+/g) || []).flatMap(url => {
    if (!url.startsWith(prefix)) return [];
    const token = /^([a-f0-9]{64})(?=$|[.,!?;:)\]?#])/.exec(url.slice(prefix.length))?.[1];
    return token ? [token] : [];
  });
}

function groupBy(rows, field) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}
function buildDailyOversight({ leads, tasks, deals, media, messages, staff, queue }, now = new Date()) {
  const today = dayKey(now);
  const inDay = value => Boolean(value && dayKey(value) === today);
  const hasNextAction = ({ next_action: action }) => Boolean(action?.title && action.recorded_at &&
    (inDay(action.recorded_at) || +new Date(action.due_at) > +now));
  const isDue = task => task.status === 'open' && task.due_at && dayKey(task.due_at) <= today;
  const relevantTasks = tasks.filter(task => isDue(task) || (task.status === 'completed' && inDay(task.completed_at)));
  const leadTasks = groupBy(relevantTasks, 'lead_id');
  const overdue = new Set(leads.filter(lead => activeProspect(lead) && prospectOverdue(lead, now)).map(lead => String(lead._id)));
  const dayLeads = leads.filter(lead => activeProspect(lead) || lead.loss_review?.status === 'pending' || leadTasks.has(String(lead._id)) ||
    (lead.sms_campaign?.active !== false && (inDay(lead.created_at || lead.createdAt) || inDay(lead.assigned_at) || inDay(lead.last_activity_at))));
  const ownedLeads = groupBy(dayLeads, 'owner_id');
  const assignedTasks = groupBy(relevantTasks, 'assignee_id');
  const sales = groupBy(deals, 'owner_id');
  const videos = groupBy(media.filter(item => item.content_type?.startsWith('video/')), 'lead_id');
  const mediaById = new Map(media.map(item => [String(item._id), item]));
  const shareableVideos = new Map(media.filter(item => item.share_token && item.status === 'ready' &&
    item.visibility !== 'private' && item.content_type?.startsWith('video/')).map(item => [item.share_token, item]));
  const videoSends = groupBy(messages.filter(item => successful(item) && item.direction !== 'inbound' && inDay(item.created_at))
    .flatMap(item => {
      const attachments = (item.attachments || []).filter(file => file.content_type?.startsWith('video/'));
      for (const token of pastedMediaTokens(item.body)) {
        const video = shareableVideos.get(token);
        if (video && video.lead_id === item.lead_id) attachments.push({ id: String(video._id) });
      }
      return attachments.map(file => ({ ...file, lead_id: item.lead_id }));
    }), 'lead_id');
  const members = new Map(staff.map(person => [String(person._id), { id: String(person._id), name: person.name, site: person.site }]));
  for (const lead of dayLeads) if (lead.owner_id && !members.has(lead.owner_id)) members.set(lead.owner_id, { id: lead.owner_id, name: lead.owner_name || 'Salesperson', site: lead.dealership_name });
  for (const task of relevantTasks) if (task.assignee_id && !members.has(task.assignee_id)) members.set(task.assignee_id, { id: task.assignee_id, name: task.assignee_name || 'Salesperson', site: task.dealership });
  for (const deal of deals) if (deal.owner_id && !members.has(deal.owner_id)) members.set(deal.owner_id, { id: deal.owner_id, name: deal.owner_name || 'Salesperson', site: deal.dealership });
  const rows = [...members.values()].map(member => {
    const owned = ownedLeads.get(member.id) || [];
    const memberTasks = assignedTasks.get(member.id) || [];
    const open = memberTasks.filter(task => task.status === 'open');
    const completed = memberTasks.filter(task => task.status === 'completed');
    const overdueTasks = open.filter(task => +new Date(task.due_at) < +now);
    const overdueProspects = owned.filter(lead => overdue.has(String(lead._id)));
    const details = owned.map(lead => {
      const id = String(lead._id);
      const recordings = videos.get(id) || [];
      const sent = videoSends.get(id) || [];
      const videoSent = sent.length > 0;
      const linked = new Map(recordings.map(item => [String(item._id), item]));
      for (const file of sent) if (file.id && !linked.has(file.id)) linked.set(file.id, mediaById.get(file.id) || file);
      return { ...serializeLead(lead), kind: /walk[ -]?in/i.test(lead.source || '') ? 'walk_in' : 'internet',
        overdue: overdue.has(id), actioned: hasNextAction(lead) || videoSent, videoRecorded: recordings.some(item => item.status === 'ready'), videoSent,
        videos: [...linked].map(([videoId, item]) => ({ id: videoId, name: item.name, views: item.views || 0, reviews: item.reviews || 0, status: item.status })),
      };
    });
    const activeLeads = details.filter(activeProspect);
    const expected = activeLeads;
    const videosDone = expected.filter(lead => lead.videoRecorded || lead.videoSent).length;
    const videoSentCount = details.filter(lead => lead.videoSent).length;
    const nextActions = activeLeads.filter(hasNextAction).length;
    const unactioned = activeLeads.filter(lead => !lead.actioned).length;
    const logged = activeLeads.filter(lead => inDay(lead.created_at || lead.createdAt) || inDay(lead.last_activity_at)).length;
    const mtdSales = sales.get(member.id)?.length || 0;
    const signals = { activity: logged === activeLeads.length ? 'green' : 'red', videos: videosDone === expected.length ? 'green' : 'red',
      nextActions: nextActions === activeLeads.length ? 'green' : 'red', tasks: open.length === 0 && overdueProspects.length === 0 ? 'green' : 'red' };
    return { ...member, activeProspects: activeLeads.length, logged, expected: expected.length, videosDone, videoSent: videoSentCount, nextActions,
      tasksCompleted: completed.length, tasksTotal: memberTasks.length, tasksRemaining: open.length, overdueTasks: overdueTasks.length,
      overdueProspects: overdueProspects.length, carryOvers: open.filter(task => dayKey(task.due_at) < today).length,
      unactioned, mtdSales, monthlyNorthStar: 20, signals, allGreen: Object.values(signals).every(signal => signal === 'green'),
      leads: details, tasks: memberTasks.map(task => ({ ...task, _id: String(task._id), overdue: task.status === 'open' && +new Date(task.due_at) < +now })) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const unassigned = queue ? queue.rows.map(serializeLead) : leads.filter(lead => activeProspect(lead) && !lead.owner_id)
    .sort((a, b) => new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0)).map(serializeLead);
  const losses = [...leads.filter(lead => lead.loss_review?.status === 'pending'), ...(queue?.losses || [])].map(serializeLead);
  const openTasks = relevantTasks.filter(task => task.status === 'open');
  const active = leads.filter(activeProspect);
  const dealerSocket = active.filter(lead => dealerSocketReference(lead));
  const snapshotAt = dealerSocket.map(lead => dealerSocketReference(lead)?.sms_campaign?.snapshot_at).filter(value => Number.isFinite(Date.parse(value))).sort().at(-1);
  const summary = { tasksCompleted: relevantTasks.length - openTasks.length, tasksTotal: relevantTasks.length,
    tasksRemaining: openTasks.length, overdueTasks: openTasks.filter(task => +new Date(task.due_at) < +now).length,
    overdueProspects: overdue.size + (queue?.stats.overdue || 0), carryOvers: openTasks.filter(task => dayKey(task.due_at) < today).length,
    unactioned: rows.reduce((total, row) => total + row.unactioned, 0),
    activityRemaining: rows.reduce((total, row) => total + row.activeProspects - row.logged, 0),
    nextActionsRemaining: rows.reduce((total, row) => total + row.activeProspects - row.nextActions, 0),
    videosRemaining: rows.reduce((total, row) => total + row.expected - row.videosDone, 0),
    lossesApprovedToday: leads.filter(lead => lead.loss_review?.status === 'approved' && inDay(lead.loss_review.reviewed_at)).length + (queue?.stats.approvedToday || 0),
  };
  return { date: today, timezone: 'Australia/Melbourne', refreshedAt: now.toISOString(), members: rows, unassigned, losses,
    ...(queue ? { unassignedPagination: queue.pagination } : {}),
    summary: { ...summary, activeProspects: active.length + (queue?.stats.total || 0), unassigned: queue ? queue.stats.total : unassigned.length, pendingLosses: losses.length, mtdSales: deals.length,
      allGreen: rows.every(row => row.allGreen) && !openTasks.length && !(queue ? queue.stats.total : unassigned.length) && !losses.length },
    dealerSocket: dealerSocket.length || queue?.stats.dealerSocket ? { active: dealerSocket.length + (queue?.stats.dealerSocket || 0), assigned: dealerSocket.filter(lead => lead.owner_id).length,
      snapshotAt: [snapshotAt, queue?.stats.snapshotAt].filter(Boolean).sort().at(-1) } : null,
    report: { available: reportTime.format(now) >= '18:30',
      scheduledTime: '18:30', description: 'Daily in-app summary · Melbourne time', generatedAt: now.toISOString() } };
}
async function getDailyOversight(req, database, now = new Date()) {
  if (!isManager(req.user) && req.user.role !== 'sales_consultant') fail(403, 'A sales account is required.');
  const db = await database(req);
  const raw = await database();
  const workday = req.query.date || dayKey(now);
  calendarDay(workday);
  const month = periodWindow('month', now);
  const { from, to } = periodWindow('today', now);
  // Older clients retain the complete response. Current clients request a bounded allocation queue.
  const paginated = req.query.queuePage !== undefined;
  const queueMatch = { merged_into: { $exists: false }, status: { $in: ['new_lead', 'following_up', 'returned', null, ''] },
    'sms_campaign.active': { $ne: false }, $or: [{ owner_id: null }, { owner_id: '' }] };
  const query = { merged_into: { $exists: false }, $or: [
      { status: { $in: ['new_lead', 'following_up', 'returned', null, ''] } }, { 'loss_review.status': 'pending' },
      { last_activity_at: { $gte: from } }, { created_at: { $gte: from } }, { createdAt: { $gte: new Date(from) } },
    ], ...(paginated ? { $nor: [queueMatch] } : {}) };
  const [leads, tasks, deals, staffRows, queue] = await Promise.all([
    db.collection('leads').find(query, { projection: LEAD_PROJECTION, batchSize: 2000 }).toArray(),
    db.collection('sales_tasks').find({ $or: [{ status: 'open' }, { status: 'completed', completed_at: { $gte: from } }] }).toArray(),
    db.collection('deals').find({ status: 'completed', completed_at: { $gte: month.from, $lt: month.to } },
      { projection: { owner_id: 1, owner_name: 1, dealership: 1 } }).toArray(),
    raw.collection('users').find({ active: true, ...(isManager(req.user) ? { role: 'sales_consultant' } : { _id: new ObjectId(req.user.id) }) }, { projection: { name: 1, role: 1, site: 1, allowedSites: 1 } }).toArray(),
    paginated ? readAllocationQueue(db, queueMatch, req.query.queuePage, from, to) : null,
  ]);
  const requested = !isAllLocations(req.query.rooftop) && locationCondition(req.query.rooftop);
  const filter = requested && new RegExp(requested.$regex, requested.$options);
  const staff = staffRows.filter(person => accountSites(person).flatMap(site => LOCATION_GROUPS[site.toLowerCase()] || [site])
    .some(site => canAccessSite(req.user, site) && (!filter || filter.test(site))));
  const ids = leads.map(lead => String(lead._id));
  const [media, messages] = ids.length ? await Promise.all([
    db.collection('message_media').find({ lead_id: { $in: ids }, status: { $in: ['ready', 'processing', 'rendering'] }, visibility: { $ne: 'private' }, content_type: { $regex: '^video/' } },
      { projection: mediaProjection }).toArray(),
    db.collection('customer_messages').find({ lead_id: { $in: ids }, created_at: { $gte: from }, status: { $in: ['queued', 'sent', 'delivered'] } },
      { projection: { lead_id: 1, created_at: 1, status: 1, direction: 1, body: 1, attachments: 1 } }).toArray(),
  ]) : [[], []];
  const present = new Set(media.map(item => String(item._id)));
  const presentTokens = new Set(media.map(item => item.share_token));
  const olderVideoIds = new Set(messages.flatMap(message => (message.attachments || [])
    .filter(file => file.content_type?.startsWith('video/') && typeof file.id === 'string' && ObjectId.isValid(file.id) && !present.has(file.id)).map(file => file.id)));
  const pastedTokens = new Set(messages.flatMap(message => pastedMediaTokens(message.body)).filter(token => !presentTokens.has(token)));
  if (olderVideoIds.size || pastedTokens.size) media.push(...await db.collection('message_media').find({
    $or: [{ _id: { $in: [...olderVideoIds].map(id => new ObjectId(id)) } }, { share_token: { $in: [...pastedTokens] } }],
    lead_id: { $in: ids }, status: 'ready', visibility: { $ne: 'private' }, content_type: { $regex: '^video/' },
  }, { projection: mediaProjection }).toArray());
  const result = buildDailyOversight({ leads, tasks, deals, staff, media, messages, queue }, now);
  const people = [...new Map([...staff, ...result.members.map(row => ({ ...row, _id: row.id }))].map(row => [String(row._id), row])).values()];
  result.workday = await getWorkdayMetrics(db, people, workday);
  result.today = dayKey(now);
  return result;
}
async function readAllocationQueue(db, match, requestedPage, from, to) {
  const { page, limit, skip } = pageQuery({ page: requestedPage, limit: '5' }, 'leads', 'created_at');
  const date = input => ({ $convert: { input, to: 'date', onError: null, onNull: null } });
  const dealerSocket = { $or: [{ $eq: ['$source', 'DealerSocket'] }, { $anyElementTrue: [{ $map: {
    input: { $ifNull: ['$source_refs', []] }, as: 'ref', in: { $and: [{ $eq: ['$$ref.source', 'DealerSocket'] }, { $ne: ['$$ref.sms_campaign.active', false] }] },
  } }] }] };
  const snapshotDate = { $ifNull: ['$sms_campaign.snapshot_at', { $max: { $map: {
    input: { $ifNull: ['$source_refs', []] }, as: 'ref', in: '$$ref.sms_campaign.snapshot_at',
  } } }] };
  const [result] = await db.collection('leads').aggregate([
    { $match: match },
    { $facet: {
      stats: [{ $group: { _id: null, total: { $sum: 1 },
        overdue: { $sum: { $cond: [{ $and: [
          { $ne: [{ $max: [date('$last_activity_at'), date('$assigned_at'), date({ $ifNull: ['$created_at', '$createdAt'] })] }, null] },
          { $lt: [{ $max: [date('$last_activity_at'), date('$assigned_at'), date({ $ifNull: ['$created_at', '$createdAt'] })] }, new Date(from)] },
        ] }, 1, 0] } },
        dealerSocket: { $sum: { $cond: [dealerSocket, 1, 0] } },
        snapshotAt: { $max: { $cond: [{ $and: [dealerSocket, { $ne: [date(snapshotDate), null] }] }, snapshotDate, null] } },
        approvedToday: { $sum: { $cond: [{ $and: [{ $eq: ['$loss_review.status', 'approved'] },
          { $gte: [date('$loss_review.reviewed_at'), new Date(from)] }, { $lt: [date('$loss_review.reviewed_at'), new Date(to)] }] }, 1, 0] } },
      } }],
      rows: [{ $set: { queueCreatedAt: date({ $ifNull: ['$created_at', '$createdAt'] }) } },
        { $sort: { queueCreatedAt: -1, _id: 1 } }, { $skip: skip }, { $limit: limit }, { $project: LEAD_PROJECTION }],
      losses: [{ $match: { 'loss_review.status': 'pending' } }, { $project: LEAD_PROJECTION }],
    } },
  ]).toArray();
  const stats = result?.stats[0] || { total: 0, overdue: 0, dealerSocket: 0, approvedToday: 0 };
  return { stats, rows: result?.rows || [], losses: result?.losses || [],
    pagination: { page, limit, total: stats.total, totalPages: Math.max(1, Math.ceil(stats.total / limit)) } };
}
function installDailyOversight(router, database) {
  router.get('/daily-oversight', route(async (req, res) => res.json({ success: true, data: await getDailyOversight(req, database) })));
}
module.exports = { installDailyOversight, getDailyOversight, buildDailyOversight };
