const { dayKey } = require('./followup-policy');
const { calendarDay } = require('./pulse');
const { ObjectId } = require('mongodb');
const { shareUrl } = require('./customer-messages');

function buildWorkdayMetrics({ leads, tasks, media, messages, deals, staff }, date) {
  const onDay = value => Boolean(value && dayKey(value) === date);
  const people = new Map(staff.map(person => [String(person._id || person.id), person]));
  const names = new Map();
  for (const [id, person] of people) {
    const key = person.name?.trim().toLowerCase();
    if (key) names.set(key, names.has(key) ? null : id);
  }
  const actor = (id, name, fallback) => id ? (people.has(String(id)) ? String(id) : null)
    : name ? names.get(name.trim().toLowerCase()) : people.has(String(fallback)) ? String(fallback) : null;
  const rows = new Map([...people].map(([id, person]) => [id, { id, name: person.name, customersUpdated: 0,
    videosAdded: 0, videosSent: 0, nextActionsSet: 0, tasksCompleted: 0, sales: 0, events: [], touched: new Set() }]));
  const byLead = new Map(leads.map(lead => [String(lead._id), lead]));
  const add = (id, kind, at, leadId, detail = '') => {
    const row = rows.get(id); if (!row || !onDay(at)) return;
    row.events.push({ kind, at, leadId: leadId ? String(leadId) : null,
      customer: byLead.get(String(leadId))?.customer_name || 'Customer', detail: String(detail).slice(0, 240) });
    if (kind === 'crm') row.touched.add(String(leadId));
    else row[kind]++;
  };
  for (const lead of leads) {
    const notes = (lead.diary_entries || []).filter(note => onDay(note.date));
    for (const note of notes) add(actor(note.author_id, note.author), 'crm', note.date, lead._id, note.note);
    const edits = (lead.activity_events || []).filter(event => onDay(event.date));
    for (const event of edits) {
      const who = actor(event.author_id, event.author);
      if (!notes.some(note => actor(note.author_id, note.author) === who && Math.abs(+new Date(note.date) - +new Date(event.date)) < 1000)) {
        add(who, 'crm', event.date, lead._id, 'Customer details updated');
      }
    }
    // Older records sometimes only have a latest activity timestamp. A dated
    // integration diary entry is not staff activity and cannot earn an owner credit.
    if (!edits.length && (!notes.length || lead.last_activity_by) && onDay(lead.last_activity_at)) add(actor(lead.last_activity_by, null, lead.owner_id), 'crm', lead.last_activity_at, lead._id, 'Customer updated');
  }
  const actionKeys = new Set();
  for (const task of tasks) {
    if (task.kind === 'next_action' && onDay(task.createdAt)) {
      actionKeys.add(`${task.lead_id}:${new Date(task.createdAt).toISOString()}`);
      add(actor(task.created_by, null, task.assignee_id), 'nextActionsSet', task.createdAt, task.lead_id, task.title);
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
      add(actor(action.author_id, action.author, lead.owner_id), 'nextActionsSet', action.recorded_at, lead._id, action.title);
    }
  }
  for (const file of media) if (file.status === 'ready' && file.visibility !== 'private' && file.content_type?.startsWith('video/')) {
    add(actor(file.user_id, file.author, byLead.get(String(file.lead_id))?.owner_id), 'videosAdded', file.created_at, file.lead_id, file.name);
  }
  const videoByToken = new Map(media.filter(file => file.status === 'ready' && file.visibility !== 'private' && file.content_type?.startsWith('video/'))
    .map(file => [file.share_token, file]));
  const prefix = shareUrl({ share_token: '' });
  for (const message of messages) {
    if (message.direction === 'inbound' || !['queued', 'sent', 'delivered'].includes(message.status)) continue;
    const linked = (String(message.body || '').match(/https?:\/\/[^\s<>"']+/g) || []).some(url => {
      if (!url.startsWith(prefix)) return false;
      const token = /^[a-f0-9]{64}/.exec(url.slice(prefix.length))?.[0];
      return token && videoByToken.get(token)?.lead_id === message.lead_id;
    });
    const id = actor(message.user_id, message.author, byLead.get(String(message.lead_id))?.owner_id);
    add(id, 'crm', message.created_at, message.lead_id, 'SMS sent');
    if (linked || message.attachments?.some(file => file.content_type?.startsWith('video/'))) {
      add(id, 'videosSent', message.created_at, message.lead_id, 'Video message sent');
    }
  }
  for (const deal of deals) if (deal.status === 'completed') add(actor(deal.owner_id, deal.owner_name), 'sales', deal.completed_at, deal.lead_id, 'Sale completed');
  const members = [...rows.values()].map(({ touched, ...row }) => ({ ...row, customersUpdated: touched.size,
    events: [...new Map(row.events.map(event => [JSON.stringify([event.kind, event.at, event.leadId]), event])).values()]
      .sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 50) })).sort((a, b) => a.name.localeCompare(b.name));
  const fields = ['customersUpdated', 'videosAdded', 'videosSent', 'nextActionsSet', 'tasksCompleted', 'sales'];
  return { date, timezone: 'Australia/Melbourne', members,
    totals: Object.fromEntries(fields.map(field => [field, members.reduce((sum, row) => sum + row[field], 0)])) };
}

async function getWorkdayMetrics(db, staff, date) {
  const range = calendarDay(date), dates = { $gte: new Date(range.$gte), $lt: new Date(range.$lt) };
  const [leads, tasks, media, messages, deals] = await Promise.all([
    db.collection('leads').find({ merged_into: { $exists: false }, $or: [
      { 'diary_entries.date': range }, { 'diary_entries.date': dates }, { 'activity_events.date': range }, { last_activity_at: range }, { 'next_action.recorded_at': range },
    ] }, { projection: { _id: 1, customer_name: 1, owner_id: 1, diary_entries: 1, activity_events: 1, last_activity_at: 1, last_activity_by: 1, next_action: 1 } }).toArray(),
    db.collection('sales_tasks').find({ $or: [{ kind: 'next_action', createdAt: range }, { status: 'completed', completed_at: range }, { 'completion_events.date': range }] }).toArray(),
    db.collection('message_media').find({ created_at: range, status: 'ready', visibility: { $ne: 'private' }, content_type: { $regex: '^video/' } }).toArray(),
    db.collection('customer_messages').find({ created_at: range, status: { $in: ['queued', 'sent', 'delivered'] }, direction: { $ne: 'inbound' } }).toArray(),
    db.collection('deals').find({ status: 'completed', completed_at: range }).toArray(),
  ]);
  const seenLeads = new Set(leads.map(row => String(row._id)));
  const missing = [...new Set([...tasks, ...media, ...messages, ...deals].map(row => row.lead_id)
    .filter(id => id && ObjectId.isValid(id) && !seenLeads.has(String(id))))];
  if (missing.length) leads.push(...await db.collection('leads').find({ _id: { $in: missing.map(id => new ObjectId(id)) }, merged_into: { $exists: false } },
    { projection: { _id: 1, customer_name: 1, owner_id: 1 } }).toArray());
  const prefix = shareUrl({ share_token: '' });
  const tokens = messages.flatMap(row => (String(row.body || '').match(/https?:\/\/[^\s<>"']+/g) || []).flatMap(url =>
    url.startsWith(prefix) ? /^[a-f0-9]{64}/.exec(url.slice(prefix.length))?.[0] || [] : []));
  if (tokens.length) {
    const linked = await db.collection('message_media').find({ share_token: { $in: tokens }, status: 'ready', visibility: { $ne: 'private' }, content_type: { $regex: '^video/' } }).toArray();
    const seen = new Set(media.map(row => String(row._id)));
    media.push(...linked.filter(row => !seen.has(String(row._id))));
  }
  return buildWorkdayMetrics({ leads, tasks, media, messages, deals, staff }, date);
}
module.exports = { buildWorkdayMetrics, getWorkdayMetrics };
