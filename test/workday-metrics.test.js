const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkdayMetrics } = require('../lib/workday-metrics');
const { calendarDay } = require('../lib/pulse');
const staff = [{ _id: 'a', name: 'Alice' }, { _id: 'b', name: 'Bob' }];
const date = '2026-11-12', at = '2026-11-12T02:00:00Z', old = '2026-11-11T02:00:00Z';

test('workday counts events on their date and credits the actor rather than the current lead owner', () => {
  const lead = { _id: 'lead', owner_id: 'b', customer_name: 'Customer', status: 'lost',
    diary_entries: [{ author: 'Alice', date: at, note: 'Called' }, { author: 'Alice', date: at, note: 'Updated' },
      { author: 'Bob', date: old, note: 'Yesterday' }],
    next_action: { title: 'Future appointment', author: 'Alice', recorded_at: old, due_at: '2026-11-15T02:00:00Z' } };
  const data = { leads: [lead], staff, tasks: [
    { lead_id: 'lead', kind: 'next_action', createdAt: at, created_by: 'a', status: 'completed', completed_at: at, closed_by: 'a', assignee_id: 'b' },
    { lead_id: 'lead', kind: 'next_action', createdAt: old, status: 'completed', completed_at: old, assignee_id: 'a' },
    { lead_id: 'lead', status: 'open', due_at: old, assignee_id: 'a' },
    { lead_id: 'lead', status: 'completed', completed_at: at, assignee_id: 'a', resolution: 'Loss approved by manager' },
  ], media: [
    { _id: 'old', lead_id: 'lead', user_id: 'a', status: 'ready', content_type: 'video/mp4', created_at: old },
    { _id: 'new', lead_id: 'lead', user_id: 'a', status: 'ready', content_type: 'video/mp4', created_at: at },
    { _id: 'processing', lead_id: 'lead', user_id: 'a', status: 'processing', content_type: 'video/mp4', created_at: at },
  ], messages: [
    { lead_id: 'lead', user_id: 'a', status: 'sent', created_at: at, attachments: [{ content_type: 'video/mp4' }] },
    { lead_id: 'lead', user_id: 'a', status: 'sent', created_at: old, attachments: [{ content_type: 'video/mp4' }] },
    { lead_id: 'lead', user_id: 'a', status: 'failed', created_at: at, attachments: [{ content_type: 'video/mp4' }] },
    { lead_id: 'lead', user_id: 'a', status: 'sent', direction: 'inbound', created_at: at, attachments: [{ content_type: 'video/mp4' }] },
  ], deals: [{ lead_id: 'lead', status: 'completed', owner_id: 'a', completed_at: at }, { status: 'completed', owner_id: 'a', completed_at: old }] };
  const result = buildWorkdayMetrics(data, date);
  assert.deepEqual(result.totals, { customersUpdated: 1, videosAdded: 1, videosSent: 1, nextActionsSet: 1, tasksCompleted: 1, sales: 1 });
  assert.ok(result.members[0].events.every(event => event.customer === 'Customer'));
  for (const field of Object.keys(result.totals)) assert.equal(result.members[1][field], 0, field);
  assert.equal(buildWorkdayMetrics(data, '2026-11-13').totals.videosAdded, 0);
});

test('integration diary entries and future actions do not create daily CRM or next-action credits', () => {
  const result = buildWorkdayMetrics({ staff, leads: [{ _id: 'lead', owner_id: 'a', last_activity_at: at,
    diary_entries: [{ author: 'DealerSocket import', date: at, note: 'Sync' }],
    next_action: { title: 'Call', author: 'Alice', recorded_at: old, due_at: '2026-11-15T02:00:00Z' } }],
    media: [], messages: [], tasks: [], deals: [] }, date);
  assert.equal(result.totals.customersUpdated, 0); assert.equal(result.totals.nextActionsSet, 0);
});

test('selected Melbourne workday has exact boundaries across daylight saving', () => {
  const window = calendarDay('2026-10-04');
  assert.equal(Date.parse(window.$lt) - Date.parse(window.$gte), 23 * 3600000);
  const media = [new Date(Date.parse(window.$gte) - 1), window.$gte, new Date(Date.parse(window.$lt) - 1), window.$lt]
    .map((created_at, i) => ({ _id: String(i), lead_id: 'lead', user_id: 'a', status: 'ready', content_type: 'video/mp4', created_at }));
  assert.equal(buildWorkdayMetrics({ staff, leads: [], tasks: [], media, messages: [], deals: [] }, '2026-10-04').totals.videosAdded, 2);
});

test('stored edit history preserves an older workday after subsequent edits and reassignment', () => {
  const input = { staff, leads: [{ _id: 'lead', owner_id: 'b', last_activity_at: at, last_activity_by: 'b', activity_events: [
    { date: old, author_id: 'a', kind: 'customer_update' }, { date: at, author_id: 'b', kind: 'customer_update' },
  ] }], tasks: [], media: [], messages: [], deals: [] };
  const yesterday = buildWorkdayMetrics(input, '2026-11-11');
  assert.equal(yesterday.members[0].customersUpdated, 1); assert.equal(yesterday.members[1].customersUpdated, 0);
  const today = buildWorkdayMetrics(input, date);
  assert.equal(today.members[0].customersUpdated, 0); assert.equal(today.members[1].customersUpdated, 1);
});

test('reopened tasks retain prior completions without crediting duplicate same-day completion events twice', () => {
  const result = buildWorkdayMetrics({ staff, leads: [], tasks: [{ _id: 'task', status: 'open', assignee_id: 'b',
    completion_events: [{ date: old, user_id: 'a' }, { date: old, user_id: 'a' }, { date: at, user_id: 'b' }] }],
    media: [], messages: [], deals: [] }, '2026-11-11');
  assert.equal(result.totals.tasksCompleted, 1); assert.equal(result.members[0].tasksCompleted, 1);
});
