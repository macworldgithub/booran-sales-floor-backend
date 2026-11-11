const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDailyOversight } = require('../lib/daily-oversight');

test('active prospects stay visible and every partial completion indicator is red', () => {
  const now = new Date('2026-11-11T03:00:00Z');
  const earlier = '2026-11-06T01:00:00Z';
  const leads = [
    { _id: 'first', owner_id: 'staff', status: 'following_up', created_at: earlier, last_activity_at: now.toISOString(),
      next_action: { title: 'Call', recorded_at: earlier, due_at: '2026-11-12T03:00:00Z' } },
    { _id: 'second', owner_id: 'staff', status: 'following_up' },
  ];
  const tasks = [
    { lead_id: 'first', assignee_id: 'staff', status: 'completed', completed_at: now.toISOString() },
    { lead_id: 'second', assignee_id: 'staff', status: 'open', due_at: earlier },
  ];
  const media = [
    { _id: 'ready-video', lead_id: 'first', content_type: 'video/mp4', status: 'ready', created_at: earlier },
    { _id: 'unfinished-video', lead_id: 'second', content_type: 'video/mp4', status: 'processing', created_at: earlier },
  ];
  const input = { leads, tasks, media, staff: [{ _id: 'staff', name: 'Salesperson' }], deals: [], messages: [] };
  const overview = buildDailyOversight(input, now);
  const [person] = overview.members;
  assert.equal(person.activeProspects, 2, 'an active legacy prospect without a creation date is visible');
  assert.equal(person.logged, 1);
  assert.equal(person.expected, 2);
  assert.equal(person.videosDone, 1, 'a previously completed video counts and an unfinished render does not');
  assert.equal(person.nextActions, 1);
  assert.equal(overview.summary.activityRemaining, 1);
  assert.equal(overview.summary.nextActionsRemaining, 1);
  assert.deepEqual(person.signals, { activity: 'red', videos: 'red', nextActions: 'red', tasks: 'red' });
  assert.equal(person.allGreen, false);

  leads[1].last_activity_at = now.toISOString();
  leads[1].next_action = leads[0].next_action;
  media[1].status = 'ready';
  tasks[1].status = 'completed';
  tasks[1].completed_at = now.toISOString();
  const [finished] = buildDailyOversight(input, now).members;
  assert.deepEqual(finished.signals, { activity: 'green', videos: 'green', nextActions: 'green', tasks: 'green' });
  assert.equal(finished.allGreen, true);
});
