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
  // Four contacts unlock unrestricted scheduling: the first three on consecutive
  // days, then another contact within the five-day window. A gap resets early cadence.
  let streak = 0, unlocked = false;
  for (let i = 0; i < days.length; i++) {
    const gap = i ? dayDistance(days[i - 1], days[i]) : 0;
    if (streak >= 3 && gap >= 1 && gap <= 5) unlocked = true;
    streak = !i || gap !== 1 ? 1 : streak + 1;
  }
  if (!unlocked && days.length && dayDistance(days.at(-1), today) > (streak >= 3 ? 5 : 1)) streak = 0;
  const maxDays = unlocked ? null : streak >= 3 ? 5 : 1;
  return { stage: unlocked ? 'unrestricted' : maxDays === 5 ? 'five_day' : 'daily', consecutiveDays: streak, maxDays,
    maxDate: maxDays === null ? null : shiftDay(today, maxDays), today, days };
}
function validateFollowup(lead, dueAt, now = new Date(), recordContact = false) {
  const policy = followupPolicy(lead, now, recordContact);
  const due = new Date(dueAt);
  if (!Number.isFinite(+due) || +due < +now || (policy.maxDate && dayKey(due) > policy.maxDate)) {
    throw Object.assign(new Error(policy.maxDate ? `Next follow-up must be in the future and no later than ${policy.maxDate} (Melbourne time).` : 'Choose a future follow-up time.'), { status: 400 });
  }
  return policy;
}
function prospectOverdue(lead, now = new Date()) {
  if (!isActiveLead(lead)) return false;
  const touched = [lead.last_activity_at, lead.assigned_at, lead.created_at || lead.createdAt].filter(Boolean).map(dayKey).sort().at(-1);
  return Boolean(touched && touched < dayKey(now));
}
module.exports = { dayKey, shiftDay, dayDistance, followupPolicy, validateFollowup, prospectOverdue, isActiveLead };
