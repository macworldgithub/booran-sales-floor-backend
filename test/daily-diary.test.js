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
test('past appointments do not carry forward into today when the prospect has next steps', () => {
  const pastAppt = { _id: 'appt-1', leadId: 'lead', consultant_id: 'rep', type: 'Test Drive', status: 'Booked', when: '2026-11-13T04:30:00Z' };
  // Without next steps, the past appointment carries forward as outstanding
  const withoutNextSteps = input({ tasks: [], appointments: [pastAppt] });
  const rowsCarried = buildDailyDiary(withoutNextSteps, '2026-11-23', new Date('2026-11-23T02:00:00Z'));
  assert.equal(rowsCarried.length, 1);
  assert.equal(rowsCarried[0].carriedForward, true);
  assert.equal(rowsCarried[0].title, 'Test Drive');

  // When the prospect has next steps scheduled, the past appointment does not carry forward
  const withNextSteps = input({
    leads: [{ ...lead, next_action: { title: 'Call to review test drive', status: 'open', due_at: '2026-11-25T01:00:00Z', recorded_at: '2026-11-14T01:00:00Z' } }],
    tasks: [],
    appointments: [pastAppt]
  });
  const rowsCleared = buildDailyDiary(withNextSteps, '2026-11-23', new Date('2026-11-23T02:00:00Z'));
  assert.equal(rowsCleared.length, 0, 'Past appointment should not carry forward when prospect has next steps');
});
