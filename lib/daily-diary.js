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

function buildDailyDiary({ leads, tasks, appointments = [] }, date, now = new Date()) {
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
    rows.push(diaryItem({ id: String(appointment._id), kind: 'appointment', leadId: String(lead._id), memberId: appointment.consultant_id || lead.owner_id,
      customer: lead.customer_name || 'Customer', title: appointment.type || 'Appointment', notes: appointment.notes || '', dueAt: appointment.when, status: appointment.status }, date, now));
  }
  return rows.sort((a, b) => Number(b.carriedForward) - Number(a.carriedForward) || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
}
module.exports = { diaryItem, buildDailyDiary };
