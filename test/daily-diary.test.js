const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDailyDiary } = require('../lib/daily-diary');
const lead = { _id: 'lead', deal_id: 'legacy-ref', customer_name: 'Fixture customer', status: 'following_up', owner_id: 'rep' };
const task = { _id: 'task', lead_id: 'lead', assignee_id: 'rep', title: 'Call', due_at: '2026-11-18T23:00:00Z', createdAt: '2026-11-18T00:00:00Z', status: 'open' };
const input = overrides => ({ leads: [lead], tasks: [task], appointments: [], ...overrides });
test('unactioned diary work carries forward across multiple Melbourne days without changing its deadline', () => {
  for (const date of ['2026-11-20', '2026-11-21', '2026-11-23']) {
    const [row] = buildDailyDiary(input(), date, new Date(`${date}T02:00:00Z`));
    assert.equal(row.diaryDate, date); assert.equal(row.carriedForward, true); assert.equal(row.overdue, true);
    assert.equal(row.originalDueAt, task.due_at); assert.equal(task.due_at, '2026-11-18T23:00:00Z');
  }
});
test('completed, approval-pending, closed and merged work does not carry into active diaries', () => {
  for (const overrides of [{ tasks: [{ ...task, status: 'completed', completed_at: '2026-11-19T01:00:00Z' }] }, { tasks: [{ ...task, status: 'awaiting_approval' }] }, { leads: [{ ...lead, status: 'lost', loss_review: { status: 'approved' } }] }, { leads: [{ ...lead, merged_into: 'other' }] }, { leads: [{ ...lead, loss_review: { status: 'pending' } }] }]) {
    assert.equal(buildDailyDiary(input(overrides), '2026-11-20').length, 0);
  }
});
test('scheduled appointments use lead aliases and an existing task represents the next action only once', () => {
  const data = input({ leads: [{ ...lead, next_action: { title: 'Call', status: 'open', due_at: task.due_at } }], tasks: [{ ...task, kind: 'next_action' }],
    appointments: [{ _id: 'appointment', leadId: 'legacy-ref', consultant_id: 'rep', type: 'Test Drive', status: 'Confirmed', when: '2026-11-20T02:00:00Z' }] });
  const rows = buildDailyDiary(data, '2026-11-20', new Date('2026-11-20T01:00:00Z'));
  assert.equal(rows.length, 2); assert.equal(rows[0].carriedForward, true); assert.equal(rows[1].leadId, 'lead');
});
test('future work and tasks created after the selected day do not enter the diary', () => {
  assert.equal(buildDailyDiary(input({ tasks: [{ ...task, due_at: '2026-11-21T00:00:00Z' }] }), '2026-11-20').length, 0);
  assert.equal(buildDailyDiary(input({ tasks: [{ ...task, createdAt: '2026-11-21T00:00:00Z' }] }), '2026-11-20').length, 0);
});
