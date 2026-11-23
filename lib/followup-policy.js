// Calendar rules always use the dealership timezone, including DST transitions.
const formatter = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' });
function dayKey(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(+date)) return '';
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const shiftDay = (day, days) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const dayDistance = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const isActiveLead = lead => ['new_lead', 'following_up', 'returned'].includes(lead.status || 'new_lead');

function followupPolicy(lead, now = new Date(), recordContact = false) {
  const today = dayKey(now);
  const days = [...new Set(Array.isArray(lead.followup_days) ? lead.followup_days : [])]
    .filter(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today).sort();
  if (recordContact && days.at(-1) !== today) days.push(today);
  // Use the source enquiry date, not the day an old enquiry was imported or
  // reassigned. The first three days allow 3 days, the next five allow 5 days.
  const origin = [lead.created_at, lead.source_created_at, lead.createdAt].map(dayKey).filter(Boolean).sort()[0] || today;
  const age = Math.max(0, dayDistance(origin, today));
  const standard = age >= 8 ? null : age >= 3 ? 5 : 3;
  const maxDays = standard === null ? null : Number.isInteger(lead.followup_limit_days) && lead.followup_limit_days > 0 ? Math.min(standard, lead.followup_limit_days) : standard;
  return { stage: maxDays === null ? 'unrestricted' : standard === 5 ? 'five_day' : 'three_day', consecutiveDays: days.length, maxDays,
    maxDate: maxDays === null ? null : shiftDay(today, maxDays), today, days };
}
function validateFollowup(lead, dueAt, now = new Date(), recordContact = false, allowOverride = false) {
  const policy = followupPolicy(lead, now, recordContact);
  const due = new Date(dueAt);
  if (!Number.isFinite(+due) || +due <= +now || (!allowOverride && policy.maxDate && dayKey(due) > policy.maxDate)) {
    throw Object.assign(new Error(policy.maxDate ? `Next follow-up must be in the future and no later than ${policy.maxDate} (Melbourne time).` : 'Choose a future follow-up time.'), { status: 400 });
  }
  return { ...policy, needsApproval: Boolean(policy.maxDate && dayKey(due) > policy.maxDate) };
}
function leadAgeDays(lead, now = new Date()) {
  const today = dayKey(now);
  const origins = [lead?.created_at, lead?.source_created_at, lead?.createdAt].filter(Boolean);
  const dates = origins.map(dayKey).filter(Boolean).sort();
  if (!dates.length) {
    if (lead?._id && typeof lead._id.getTimestamp === 'function') {
      return Math.max(0, dayDistance(dayKey(lead._id.getTimestamp()), today));
    }
    if (typeof lead?._id === 'string' && /^[a-f0-9]{24}$/i.test(lead._id)) {
      const ts = new Date(parseInt(lead._id.slice(0, 8), 16) * 1000);
      return Math.max(0, dayDistance(dayKey(ts), today));
    }
    return 0;
  }
  return Math.max(0, dayDistance(dates[0], today));
}

function isLeadOver60Days(lead, now = new Date()) {
  if (!lead) return false;
  return leadAgeDays(lead, now) > 60;
}

function prospectOverdue(lead, now = new Date()) {
  if (!isActiveLead(lead)) return false;
  if (lead.loss_review?.status === 'pending' || lead.next_action_review?.status === 'pending' || lead.next_action?.status === 'completed') return false;
  if (lead.next_action?.due_at) return dayKey(lead.next_action.due_at) < dayKey(now);
  const touched = [lead.last_activity_at, lead.assigned_at, lead.created_at || lead.createdAt].filter(Boolean).map(dayKey).sort().at(-1);
  return Boolean(touched && touched < dayKey(now));
}
function needsActionToday(lead, now = new Date()) {
  if (!isActiveLead(lead) || lead.loss_review?.status === 'pending' || lead.next_action_review?.status === 'pending') return false;
  if (['completed', 'awaiting_approval'].includes(lead.next_action?.status)) return false;
  if (lead.next_action?.due_at) return dayKey(lead.next_action.due_at) <= dayKey(now);
  return true;
}
module.exports = { dayKey, shiftDay, dayDistance, followupPolicy, validateFollowup, prospectOverdue, isActiveLead, needsActionToday, leadAgeDays, isLeadOver60Days };
