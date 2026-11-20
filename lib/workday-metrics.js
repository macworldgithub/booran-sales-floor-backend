const { dayKey } = require('./followup-policy');
const { calendarDay } = require('./pulse');
const { ObjectId } = require('mongodb');
const { shareUrl } = require('./customer-messages');
const { allocationOnly, isManager } = require('./roles');
const { isActiveLead } = require('./followup-policy');
const measuredFields = ['customersUpdated', 'videosAdded', 'videosSent', 'nextActionsSet', 'tasksCompleted'];
const signal = (covered, target) => !target ? 'neutral' : covered >= target ? 'green' : 'red';

function buildWorkdayMetrics({ leads, tasks, media, messages, deals, staff }, date) {
  const onDay = value => Boolean(value && dayKey(value) === date);
  const beforeDayEnd = new Date(Date.parse(calendarDay(date).$lt) - 1);
  const accounts = new Map(staff.map(person => [String(person._id || person.id), person]));
  const people = new Map([...accounts].filter(([, person]) => !allocationOnly(person)));
  const allocators = new Set(staff.filter(allocationOnly).map(person => person.name?.trim().toLowerCase()).filter(Boolean));
  const names = new Map();
  for (const [id, person] of people) {
    const key = person.name?.trim().toLowerCase();
    if (key) names.set(key, names.has(key) ? null : id);
  }
  const actor = (id, name, fallback) => allocationOnly(accounts.get(String(id))) || isManager(accounts.get(String(id))) && fallback && String(fallback)!==String(id) || !id && allocators.has(name?.trim().toLowerCase())
    ? people.has(String(fallback)) ? String(fallback) : null
    : id ? (people.has(String(id)) ? String(id) : null)
      : name ? names.get(name.trim().toLowerCase()) : people.has(String(fallback)) ? String(fallback) : null;
  const rows = new Map([...people].map(([id, person]) => [id, { id, name: person.name, customersUpdated: 0,
    videosAdded: 0, videosSent: 0, nextActionsSet: 0, tasksCompleted: 0, sales: 0, events: [], touched: new Set(),
    workload: new Set(), covered: Object.fromEntries(['videosAdded', 'videosSent', 'nextActionsSet'].map(field => [field, new Set()])),
    dueTasks: new Set(), completedDueTasks: new Set() }]));
  const byLead = new Map(leads.map(lead => [String(lead._id), lead]));
  const assignmentCache = new Map();
  const assignments = lead => {
    if (!lead) return [];
    const key = String(lead._id); if (assignmentCache.has(key)) return assignmentCache.get(key);
    const values = (lead.diary_entries || []).flatMap(note => {
      const legacy = /^Assigned to (.+)\.$/.exec(note.note || '');
      if (note.kind !== 'assignment' && !legacy && note.note !== 'Returned to the unassigned queue.') return [];
      return [{ at: note.date, id: note.assignee_id ? String(note.assignee_id) : legacy ? names.get(legacy[1].trim().toLowerCase()) || null : null,
        author: note.author, note }];
    }).filter(value => Number.isFinite(+new Date(value.at))).sort((a, b) => +new Date(a.at) - +new Date(b.at));
    assignmentCache.set(key, values); return values;
  };
  const ownerAt = (lead, at) => {
    const history = assignments(lead).filter(value => +new Date(value.at) <= +new Date(at));
    if (history.length) return history.at(-1).id;
    if (lead?.assigned_at && +new Date(lead.assigned_at) > +new Date(at)) return null;
    return lead?.owner_id;
  };
  const workload = (id, leadId) => { if (leadId != null && rows.has(id) && (!byLead.has(String(leadId)) || isActiveLead(byLead.get(String(leadId))))) rows.get(id).workload.add(String(leadId)); };
  const add = (id, kind, at, leadId, detail = '') => {
    const row = rows.get(id); if (!row || !onDay(at)) return;
    row.events.push({ kind, at, leadId: leadId ? String(leadId) : null,
      customer: byLead.get(String(leadId))?.customer_name || 'Customer', detail: String(detail).slice(0, 240) });
    if (kind !== 'allocation') workload(id, leadId);
    if (kind === 'crm') row.touched.add(String(leadId));
    else if (kind !== 'allocation') row[kind]++;
    if (row.covered[kind] && leadId != null) row.covered[kind].add(String(leadId));
  };
  for (const lead of leads) {
    const history = assignments(lead);
    for (const event of history.filter(event => onDay(event.at))) add(event.id, 'allocation', event.at, lead._id, `Allocated by ${event.author || 'manager'}`);
    const finalAssignment = history.filter(event => dayKey(event.at) <= date).at(-1);
    if (finalAssignment && onDay(finalAssignment.at)) workload(finalAssignment.id, lead._id);
    if (lead.assigned_by && onDay(lead.assigned_at)) workload(ownerAt(lead, lead.assigned_at), lead._id);
    if (onDay(lead.created_at || lead.createdAt)) workload(ownerAt(lead, beforeDayEnd), lead._id);
    const notes = (lead.diary_entries || []).filter(note => onDay(note.date));
    for (const note of notes) if (!history.some(event => event.note === note)) add(actor(note.author_id, note.author, ownerAt(lead, note.date)), 'crm', note.date, lead._id, note.note);
    const edits = (lead.activity_events || []).filter(event => onDay(event.date));
    for (const event of edits) {
      const who = actor(event.author_id, event.author, ownerAt(lead, event.date));
      if (!notes.some(note => actor(note.author_id, note.author) === who && Math.abs(+new Date(note.date) - +new Date(event.date)) < 1000)) {
        add(who, 'crm', event.date, lead._id, 'Customer details updated');
      }
    }
    // Older records sometimes only have a latest activity timestamp. A dated
    // integration diary entry is not staff activity and cannot earn an owner credit.
    if (!edits.length && (!notes.length || lead.last_activity_by) && onDay(lead.last_activity_at) &&
      !history.some(event => Math.abs(+new Date(event.at) - +new Date(lead.last_activity_at)) < 1000)) add(actor(lead.last_activity_by, null, ownerAt(lead, lead.last_activity_at)), 'crm', lead.last_activity_at, lead._id, 'Customer updated');
  }
  const actionKeys = new Set();
  for (const task of tasks) {
    const lead = byLead.get(String(task.lead_id));
    const assigned = people.has(String(task.assignee_id)) ? String(task.assignee_id) : null;
    const completions = (task.completion_events || []).map(event => event.date).concat(task.completed_at || []).filter(value => Number.isFinite(+new Date(value)));
    const completedToday = completions.some(onDay) && task.resolution !== 'Loss approved by manager';
    const completedBefore = task.status === 'completed' && completions.some(value => dayKey(value) < date);
    const due = task.due_at && dayKey(task.due_at) <= date && !completedBefore;
    if (assigned && (!lead || isActiveLead(lead)) && task.resolution !== 'Loss approved by manager' && (due || completedToday)) {
      const key = String(task._id || `${task.lead_id}:${task.createdAt}:${task.title}`);
      rows.get(assigned).dueTasks.add(key); workload(assigned, task.lead_id);
      if (task.status === 'completed' && completions.some(value => dayKey(value) <= date)) rows.get(assigned).completedDueTasks.add(key);
    }
    if (task.kind === 'next_action' && onDay(task.createdAt)) {
      actionKeys.add(`${task.lead_id}:${new Date(task.createdAt).toISOString()}`);
      add(actor(task.created_by, null, assigned || ownerAt(lead, task.createdAt)), 'nextActionsSet', task.createdAt, task.lead_id, task.title);
    }
    if (task.completion_events?.length) {
      const closers = new Set();
      for (const event of task.completion_events.filter(event => onDay(event.date))) {
        const who = actor(event.user_id, null, task.assignee_id);
        if (!closers.has(who)) { add(who, 'tasksCompleted', event.date, task.lead_id, task.title); closers.add(who); }
      }
    } else if (task.status === 'completed' && task.resolution !== 'Loss approved by manager') add(actor(task.closed_by, null, task.assignee_id), 'tasksCompleted', task.completed_at, task.lead_id, task.title);
  }
  for (const lead of leads) {
    const action = lead.next_action;
    if (action?.recorded_at && onDay(action.recorded_at) && !actionKeys.has(`${lead._id}:${new Date(action.recorded_at).toISOString()}`)) {
      add(actor(action.author_id, action.author, ownerAt(lead, action.recorded_at)), 'nextActionsSet', action.recorded_at, lead._id, action.title);
    }
  }
  for (const file of media) if (file.status === 'ready' && file.visibility !== 'private' && file.content_type?.startsWith('video/')) {
    add(actor(file.user_id, file.author, ownerAt(byLead.get(String(file.lead_id)), file.created_at)), 'videosAdded', file.created_at, file.lead_id, file.name);
  }
  const videoByToken = new Map(media.filter(file => file.status === 'ready' && file.visibility !== 'private' && file.content_type?.startsWith('video/'))
    .map(file => [file.share_token, file]));
  const prefix = shareUrl({ share_token: '' });
  for (const message of messages) {
    if (message.direction === 'inbound' || !['queued', 'accepted', 'sent', 'delivered', 'success'].includes(message.status)) continue;
    const linked = (String(message.body || '').match(/https?:\/\/[^\s<>"']+/g) || []).some(url => {
      if (!url.startsWith(prefix)) return false;
      const token = /^[a-f0-9]{64}/.exec(url.slice(prefix.length))?.[0];
      return token && videoByToken.get(token)?.lead_id === message.lead_id;
    });
    const id = actor(message.user_id, message.author, ownerAt(byLead.get(String(message.lead_id)), message.created_at));
    add(id, 'crm', message.created_at, message.lead_id, 'SMS sent');
    if (linked || message.attachments?.some(file => file.content_type?.startsWith('video/'))) {
      add(id, 'videosSent', message.created_at, message.lead_id, 'Video message sent');
    }
  }
  for (const deal of deals) if (deal.status === 'completed') add(actor(deal.owner_id, deal.owner_name), 'sales', deal.completed_at, deal.lead_id, 'Sale completed');
  const members = [...rows.values()].map(({ touched, workload, covered, dueTasks, completedDueTasks, ...row }) => {
    const targets = Object.fromEntries(measuredFields.map(field => [field, field === 'tasksCompleted' ? dueTasks.size : workload.size]));
    const coverage = { customersUpdated: touched.size, ...Object.fromEntries(Object.entries(covered).map(([field, values]) => [field, values.size])), tasksCompleted: completedDueTasks.size };
    const signals = Object.fromEntries(measuredFields.map(field => [field, signal(coverage[field], targets[field])]));
    return { ...row, customersUpdated: touched.size, targets, coverage, signals,
      customerIds: { customersUpdated: [...touched], ...Object.fromEntries(Object.entries(covered).map(([field,values])=>[field,[...values]])) },
      allGreen: (workload.size > 0 || dueTasks.size > 0) && !Object.values(signals).includes('red'),
      events: [...new Map(row.events.map(event => [JSON.stringify([event.kind, event.at, event.leadId]), event])).values()]
        .sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 50) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const fields = ['customersUpdated', 'videosAdded', 'videosSent', 'nextActionsSet', 'tasksCompleted', 'sales'];
  const targets = Object.fromEntries(measuredFields.map(field => [field, members.reduce((sum, row) => sum + row.targets[field], 0)]));
  const coverage = Object.fromEntries(measuredFields.map(field => [field, members.reduce((sum, row) => sum + row.coverage[field], 0)]));
  return { date, timezone: 'Australia/Melbourne', members,
    targets, coverage, signals: Object.fromEntries(measuredFields.map(field => [field, signal(coverage[field], targets[field])])),
    totals: Object.fromEntries(fields.map(field => [field, members.reduce((sum, row) => sum + row[field], 0)])) };
}

async function fetchWorkdayData(db, date, options = {}) {
  const range = calendarDay(date), dates = { $gte: new Date(range.$gte), $lt: new Date(range.$lt) };
  const workdayLeadProj = {
    _id: 1, deal_id: 1, customer_name: 1, customer_phone: 1, dealership_name: 1, owner_name: 1, owner_id: 1, source: 1, status: 1, source_active: 1, sms_campaign: 1, assigned_at: 1, assigned_by: 1, created_at: 1, source_created_at: 1, createdAt: 1,
    last_activity_at: 1, last_activity_by: 1, next_action: 1, next_action_review: 1, loss_review: 1, lost_at: 1, sold_at: 1, stage_history: 1,
    activity_events: {
      $filter: {
        input: { $ifNull: ['$activity_events', []] },
        as: 'e',
        cond: { $and: [{ $gte: ['$$e.date', range.$gte] }, { $lt: ['$$e.date', range.$lt] }] }
      }
    },
    diary_entries: {
      $filter: {
        input: { $ifNull: ['$diary_entries', []] },
        as: 'd',
        cond: {
          $or: [
            { $eq: ['$$d.kind', 'assignment'] },
            { $and: [{ $gte: ['$$d.date', range.$gte] }, { $lt: ['$$d.date', range.$lt] }] },
            { $regexMatch: { input: { $ifNull: ['$$d.note', ''] }, regex: '^Assigned to ' } },
            { $eq: ['$$d.note', 'Returned to the unassigned queue.'] }
          ]
        }
      }
    }
  };
  const [leads, tasks, media, messages, deals] = await Promise.all([
    options.leads ? [...options.leads] : db.collection('leads').find({ merged_into: { $exists: false }, $or: [
      { 'diary_entries.date': range }, { 'diary_entries.date': dates }, { 'activity_events.date': range }, { last_activity_at: range }, { 'next_action.recorded_at': range },
      { assigned_at: range }, { assigned_at: dates }, { created_at: range }, { created_at: dates }, { createdAt: dates }, { createdAt: range }, { source_created_at: range },
      { 'loss_review.reviewed_at': range }, { lost_at: range },
      { sold_at: range }, { 'stage_history.at': range },
      { status: { $in: ['new_lead', 'following_up', 'returned'] }, 'next_action.status': 'open', 'next_action.due_at': { $lt: range.$lt } },
    ] }, { projection: workdayLeadProj, batchSize: 2000 }).toArray(),
    options.tasks || db.collection('sales_tasks').find({ $or: [{ kind: 'next_action', createdAt: range }, { status: 'completed', completed_at: range }, { 'completion_events.date': range },
      { due_at: { $lt: range.$lt }, $or: [{ status: 'open' }, { completed_at: { $gte: range.$gte } }] }] }).toArray(),
    options.media || db.collection('message_media').find({ created_at: range, status: 'ready', visibility: { $ne: 'private' }, content_type: { $regex: '^video/' } }).toArray(),
    options.messages || db.collection('customer_messages').find({ created_at: range, status: { $in: ['queued', 'accepted', 'sent', 'delivered', 'success'] }, direction: { $ne: 'inbound' } }).toArray(),
    options.deals || db.collection('deals').find({ status: 'completed', completed_at: range }).toArray(),
  ]);
  const seenLeads = new Set(leads.flatMap(row => [String(row._id), row.deal_id].filter(Boolean)));
  const missing = [...new Set([...tasks, ...media, ...messages, ...deals].map(row => row.lead_id)
    .filter(id => id && !seenLeads.has(String(id))))].map(String);
  if (missing.length) leads.push(...await db.collection('leads').find({ $or: [{ _id: { $in: missing.filter(ObjectId.isValid).map(id => new ObjectId(id)) } }, { deal_id: { $in: missing } }], merged_into: { $exists: false } },
    { projection: workdayLeadProj }).toArray());
  const prefix = shareUrl({ share_token: '' });
  const tokens = messages.flatMap(row => (String(row.body || '').match(/https?:\/\/[^\s<>"']+/g) || []).flatMap(url =>
    url.startsWith(prefix) ? /^[a-f0-9]{64}/.exec(url.slice(prefix.length))?.[0] || [] : []));
  if (tokens.length) {
    const presentTokens = new Set(media.map(row => row.share_token));
    const neededTokens = tokens.filter(token => !presentTokens.has(token));
    if (neededTokens.length) {
      const linked = await db.collection('message_media').find({ share_token: { $in: neededTokens }, status: 'ready', visibility: { $ne: 'private' }, content_type: { $regex: '^video/' } }).toArray();
      const seen = new Set(media.map(row => String(row._id)));
      media.push(...linked.filter(row => !seen.has(String(row._id))));
    }
  }
  return { leads, tasks, media, messages, deals };
}

async function getWorkdayMetrics(db, staff, date, options = {}) {
  const data = await fetchWorkdayData(db, date, options);
  return buildWorkdayMetrics({ ...data, staff }, date);
}
module.exports = { buildWorkdayMetrics, getWorkdayMetrics, fetchWorkdayData };
