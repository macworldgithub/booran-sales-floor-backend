const { STATUSES, portalDate, attention, closed } = require('./connex-policy');
const { fail } = require('./workflow-route');
const VIEWS = ['all', 'not_accepted', 'accepted', 'open', 'won', 'lost', 'masked', 'overdue', 'three_days', 'six_weeks', 'aged', 'not_updated', 'merge_review'];
const SORTS = ['newest', 'oldest', 'name', 'salesperson', 'status'];
function filters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Include a valid Connex filter object.');
  const result = {};
  for (const key of ['view', 'search', 'stage', 'type', 'salesperson', 'from', 'to', 'sort']) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > (key === 'search' ? 200 : 100)) fail(400, 'Invalid Connex filter.');
    result[key] = value.trim();
  }
  result.view ||= 'all'; result.sort ||= 'newest';
  if (!VIEWS.includes(result.view) || !SORTS.includes(result.sort) || result.stage && !STATUSES.includes(result.stage)) fail(400, 'Choose a valid Connex view, status and sort order.');
  for (const key of ['from', 'to']) if (result[key] && (!/^\d{4}-\d\d-\d\d$/.test(result[key]) || !portalDate(`${result[key].slice(8)}/${result[key].slice(5, 7)}/${result[key].slice(0, 4)}`))) fail(400, 'Choose a valid source date.');
  if (result.from && result.to && result.from > result.to) fail(400, 'The start date must not be after the end date.');
  return result;
}
function recordView(record, now = new Date(), holidays) {
  const snapshot = record.snapshot;
  const modified = snapshot.lastModifiedAt;
  return { recordId: record.recordId, leadId: record.lead_id, mergeRequestId: record.merge_request_id,
    snapshot, lastPullAt: record.last_pull_at, detailsPending: record.detailsPending, outcome: record.outcome, milestoneError: record.milestone_error || null,
    ...attention(snapshot, now, holidays), agedSixtyDays: !closed(snapshot.stage) && Boolean(snapshot.createdAt) && +now - Date.parse(snapshot.createdAt) >= 60 * 86400000,
    notUpdatedFourDays: !closed(snapshot.stage) && Boolean(modified) && +now - Date.parse(modified) >= 4 * 86400000 };
}
function matchesView(record, filter) {
  const s = record.snapshot, query = filter.search.toLowerCase();
  const accepted = ['Accepted', 'Sales Qualified', 'Closed Won', 'Closed Lost'].includes(s.stage);
  const views = { all: true, not_accepted: !accepted, accepted: s.stage === 'Accepted', open: !closed(s.stage), won: s.stage === 'Closed Won',
    lost: s.stage === 'Closed Lost', masked: record.detailsPending, overdue: record.acceptanceOverdue,
    three_days: record.notAcceptedThreeDays, six_weeks: record.openSixWeeks, aged: record.agedSixtyDays, not_updated: record.notUpdatedFourDays, merge_review: record.outcome === 'merge_review' };
  const date = s.createdAt && new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(s.createdAt));
  return views[filter.view] && (!filter.stage || s.stage === filter.stage) && (!filter.type || s.type === filter.type) &&
    (!filter.salesperson || (s.salesperson || 'Unassigned') === filter.salesperson) && (!filter.from || date && date >= filter.from) &&
    (!filter.to || date && date <= filter.to) && (!query || [s.name, s.opportunityName, s.phone, s.email, s.vehicle, s.recordId].some(value => String(value || '').toLowerCase().includes(query)) ||
      /^\+?[\d ()-]+$/.test(query) && String(s.phone || '').replace(/\D/g, '').endsWith(query.replace(/\D/g, '').replace(/^0/, '')));
}
function sortRecords(rows, by) {
  return rows.sort((a, b) => {
    const field = by === 'name' ? 'name' : by === 'salesperson' ? 'salesperson' : by === 'status' ? 'stage' : 'createdAt';
    const comparison = String(a.snapshot[field] || '').localeCompare(String(b.snapshot[field] || ''));
    return comparison * (by === 'newest' ? -1 : 1) || a.recordId.localeCompare(b.recordId);
  });
}
module.exports = { VIEWS, SORTS, filters, recordView, matchesView, sortRecords };
