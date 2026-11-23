const { dayKey, isActiveLead } = require('./followup-policy');
const { calendarDay } = require('./pulse');

// Carry work into each subsequent diary without moving its original deadline.
// This preserves overdue flags and never awards a newly scheduled-date credit.
function diaryItem(row, date, now = new Date()) {
  const due = row.dueAt || row.due_at || row.when, originalDate = dayKey(due);
  const complete = ['completed', 'Completed', 'No Show'].includes(row.status);
  return { ...row, dueAt: due, originalDueAt: due, diaryDate: !complete && originalDate < date ? date : originalDate,
    carriedForward: !complete && Boolean(originalDate && originalDate < date),
    overdue: !complete && Number.isFinite(Date.parse(due)) && Date.parse(due) < +now, complete };
}

function buildDailyDiary({ leads, tasks, appointments = [], newCustomers = [] }, date, now = new Date()) {
  const end = Date.parse(calendarDay(date).$lt), start = Date.parse(calendarDay(date).$gte);
  const byId = new Map(leads.flatMap(lead => [String(lead._id), lead.deal_id].filter(Boolean).map(id => [String(id), lead])));
  const available = lead => lead && !lead.merged_into && isActiveLead(lead) && (lead.source_active ?? lead.sms_campaign?.active) !== false;
  const eligible = (row, due) => Number.isFinite(Date.parse(due)) && Date.parse(due) < end &&
    (!row.createdAt || Date.parse(row.createdAt) < end) && !['cancelled', 'Cancelled', 'awaiting_approval'].includes(row.status) &&
    (['open', 'Booked', 'Confirmed'].includes(row.status) || Date.parse(row.completed_at || row.when) >= start);
  const rows = [], linked = new Set();
  for (const task of tasks) {
    const lead = byId.get(String(task.lead_id));
    if (!available(lead) || task.resolution === 'Loss approved by manager' || !eligible(task, task.due_at)) continue;
    if (lead.loss_review?.status === 'pending' || lead.next_action_review?.status === 'pending' && task.kind === 'next_action') continue;
    if (task.kind === 'next_action') linked.add(String(lead._id));
    rows.push(diaryItem({ id: String(task._id), kind: 'task', leadId: String(lead._id), memberId: task.assignee_id || lead.owner_id,
      customer: lead.customer_name || 'Customer', title: task.title, notes: task.notes || '', dueAt: task.due_at, status: task.status }, date, now));
  }
  for (const lead of leads) {
    const action = lead.next_action;
    if (!available(lead) || !action || linked.has(String(lead._id)) || lead.loss_review?.status === 'pending' || lead.next_action_review?.status === 'pending' ||
      !eligible({ ...action, status: action.status || 'open', createdAt: action.recorded_at }, action.due_at)) continue;
    rows.push(diaryItem({ id: 'action:' + lead._id, kind: 'followup', leadId: String(lead._id), memberId: lead.owner_id,
      customer: lead.customer_name || 'Customer', title: action.title, dueAt: action.due_at, status: action.status || 'open' }, date, now));
  }
  for (const appointment of appointments) {
    const lead = byId.get(String(appointment.leadId));
    if (!available(lead) || lead.loss_review?.status === 'pending' || !eligible(appointment, appointment.when)) continue;
    const originalDate = dayKey(appointment.when);
    const isPast = Boolean(originalDate && originalDate < date);
    const hasNextSteps = Boolean(lead.next_action?.title && (
      lead.next_action.status === 'open' ||
      lead.next_action.status === 'awaiting_approval' ||
      dayKey(lead.next_action.due_at) >= originalDate ||
      dayKey(lead.next_action.recorded_at) >= originalDate
    ));
    if (isPast && hasNextSteps) continue;
    rows.push(diaryItem({ id: String(appointment._id), kind: 'appointment', leadId: String(lead._id), memberId: appointment.consultant_id || lead.owner_id,
      customer: lead.customer_name || 'Customer', title: appointment.type || 'Appointment', notes: appointment.notes || '', dueAt: appointment.when, status: appointment.status }, date, now));
  }
  const represented = new Set(rows.map(row => row.leadId));
  for (const customer of newCustomers) {
    const lead = byId.get(String(customer.id));
    if (!available(lead) || represented.has(String(lead._id))) continue;
    const due = [lead.created_at, lead.source_created_at, lead.createdAt, lead.assigned_at,
      ...(lead.diary_entries || []).filter(entry => entry.kind === 'assignment').map(entry => entry.date)]
      .filter(value => dayKey(value) === date && Date.parse(value) <= +now).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || calendarDay(date).$gte;
    const complete = Boolean(customer.coverage?.nextActionsSet);
    rows.push({ id: 'new:' + lead._id, kind: 'new_lead', leadId: String(lead._id), memberId: customer.ownerId,
      customer: lead.customer_name || 'Customer', title: customer.createdToday ? 'New lead' : 'Newly allocated lead',
      dueAt: due, originalDueAt: due, diaryDate: date, status: complete ? 'completed' : 'open', complete, carriedForward: false, overdue: false });
    represented.add(String(lead._id));
  }
  return rows.sort((a, b) => Number(b.carriedForward) - Number(a.carriedForward) || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
}
module.exports = { diaryItem, buildDailyDiary };
