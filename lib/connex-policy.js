const SITE = 'South Morang Hyundai';
const DEALER_CODE = 'H3752V';
const PORTAL = 'https://connex-hmca.my.site.com/HMCADealerCommunity';
const STATUSES = ['Qualified', 'Distributed', 'Accepted', 'Sales Qualified', 'Closed Won', 'Closed Lost'];
// Read from the dealership's Close dialog, not inferred from CRM loss-note text.
const LOST_REASONS = ['Purchase other Brand', 'Purchase Used car', 'No Final Contact', 'Lost on Trade',
  'Lost on Finance', 'Lost on Price', 'Poor Dealer Service', 'Stock Availability',
  'Bought from other Hyundai Dealer', 'Data Migration', 'Lost on Features', 'Not Proceeding',
  'Duplicate Lead', 'Inactive auto-close', 'LMS Lost'];
const ACTIONS = ['accept', 'assign', 'qualify', 'note', 'close_won', 'close_lost', 'refresh'];
const recordId = value => typeof value === 'string' && /^006[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(value);
function canonicalId(value) {
  if (!recordId(value)) return null;
  const short = value.slice(0, 15), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let suffix = '';
  for (let group = 0; group < 3; group++) {
    let bits = 0;
    for (let index = 0; index < 5; index++) if (/[A-Z]/.test(short[group * 5 + index])) bits |= 1 << index;
    suffix += alphabet[bits];
  }
  const full = short + suffix;
  return value.length === 15 || value === full ? full : null;
}
function opportunityId(value) {
  if (recordId(value)) return canonicalId(value);
  try {
    const url = new URL(value);
    if (url.origin !== new URL(PORTAL).origin || url.username || url.password || url.port) return null;
    return canonicalId(/^\/HMCADealerCommunity\/s\/opportunity\/(006[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)(?:\/|$)/.exec(url.pathname)?.[1]);
  } catch { return null; }
}
function opportunityUrl(value) {
  const id = opportunityId(value);
  if (!id) throw Object.assign(new Error('Choose a valid Hyundai Connex opportunity reference.'), { status: 400 });
  return `${PORTAL}/s/opportunity/${id}`;
}
function localParts(value) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(value).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function melbourneInstant(year, month, day, hour = 0, minute = 0, second = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = wall;
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(instant));
    instant += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(instant);
}
function portalDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(+value) ? value.toISOString() : null;
  const text = String(value).trim();
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(text);
  if (!match) return /^\d{4}-\d\d-\d\dT/.test(text) && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
  const [, d, m, y, h = '0', min = '0', sec = '0', half] = match;
  let hour = Number(h);
  if (+min > 59 || +sec > 59 || hour > (half ? 12 : 23) || half && hour < 1) return null;
  if (half) hour = hour % 12 + (half.toLowerCase() === 'pm' ? 12 : 0);
  const date = melbourneInstant(+y, +m, +d, hour, +min, +sec), p = localParts(date);
  return p.year === +y && p.month === +m && p.day === +d && p.hour === hour && p.minute === +min ? date.toISOString() : null;
}
function nextBusinessDeadline(value, excludedDates = require('./connex-calendar').holidays()) {
  const parsed = portalDate(value);
  if (!parsed) return null;
  const p = localParts(new Date(parsed)), day = new Date(Date.UTC(p.year, p.month - 1, p.day));
  do { day.setUTCDate(day.getUTCDate() + 1); }
  while ([0, 6].includes(day.getUTCDay()) || excludedDates.includes(day.toISOString().slice(0, 10)));
  return melbourneInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 23, 59, 59).toISOString();
}
const closed = stage => ['Closed Won', 'Closed Lost'].includes(stage);
const crmStatus = stage => stage === 'Closed Won' ? 'sold' : stage === 'Closed Lost' ? 'lost' :
  ['Accepted', 'Sales Qualified'].includes(stage) ? 'following_up' : 'new_lead';
function attention(record, now = new Date(), excludedDates) {
  const since = portalDate(record.distributedAt || record.createdAt), age = since ? +now - Date.parse(since) : 0;
  const accepted = Boolean(record.acceptedAt) || ['Accepted', 'Sales Qualified', 'Closed Won', 'Closed Lost'].includes(record.stage);
  const acceptanceDueAt = nextBusinessDeadline(since, excludedDates);
  return { acceptanceDueAt, acceptanceOverdue: !accepted && Boolean(acceptanceDueAt) && Date.parse(acceptanceDueAt) < +now,
    notAcceptedThreeDays: !accepted && age >= 3 * 86400000, openSixWeeks: !closed(record.stage) && age >= 42 * 86400000 };
}
function emailReference(message) {
  const body = [message.text, message.html, message.subject].filter(value => typeof value === 'string').join('\n');
  const urls = body.match(/https:\/\/connex-hmca\.my\.site\.com\/[^\s<>"']+/gi) || [];
  for (const raw of urls) {
    const decoded = raw.replace(/&amp;/g, '&').replace(/[).,;]+$/, '');
    const id = opportunityId(decoded);
    if (id) return { recordId: id, url: opportunityUrl(id) };
  }
  return null;
}
const cleanError = error => {
  if (error?.code === 'CONNEX_LOGIN') return 'Connex sign-in failed. Check the integration account credentials.';
  if (error?.code === 'CONNEX_MFA') return 'Connex requires a one-time code or interactive sign-in.';
  if (error?.code === 'CONNEX_SCOPE') return 'The Connex opportunity does not belong to South Morang Hyundai.';
  if (error?.code === 'CONNEX_MAPPING') return 'The Connex salesperson could not be matched uniquely. Check the exact contact name in salesperson mappings.';
  if (error?.code === 'CONNEX_READONLY') return 'Connex source updates are paused.';
  if (error?.code === 'CONNEX_UNCERTAIN') return 'The Connex update could not be confirmed. Check the opportunity before retrying.';
  if (error?.code === 'CONNEX_TIMEOUT' || error?.name === 'TimeoutError') return 'Connex took too long to respond. Synchronization will retry automatically.';
  if (error?.code === 'CONNEX_STORAGE') return 'The database storage limit has been reached. Synchronization cannot save updates until capacity is available.';
  if (error?.code === 'CONNEX_TEMPORARY') return 'The Connex connection was interrupted. Synchronization will retry automatically.';
  if (error?.status === 409) return String(error.message).slice(0, 300);
  return 'Connex could not complete this operation. Retry or open the opportunity in Connex.';
};
module.exports = { SITE, DEALER_CODE, PORTAL, STATUSES, LOST_REASONS, ACTIONS, recordId, opportunityId,
  opportunityUrl, portalDate, nextBusinessDeadline, attention, closed, crmStatus, emailReference, cleanError };
