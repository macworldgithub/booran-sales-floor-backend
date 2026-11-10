const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dayKey, followupPolicy, prospectOverdue, validateFollowup } = require('../lib/followup-policy');

test('follow-up limits use Melbourne calendar days through a DST change', () => {
  const now = new Date('2026-10-04T02:00:00Z');
  const lead = { followup_days: ['2026-10-02', '2026-10-03'] };
  assert.equal(dayKey(now), '2026-10-04');
  assert.equal(followupPolicy({}, now, true).maxDate, '2026-10-05');
  assert.equal(followupPolicy(lead, now, true).maxDate, '2026-10-09');
  assert.throws(() => validateFollowup(lead, '2026-10-09T13:00:00Z', now, true), /no later than 2026-10-09/);
  lead.followup_days.push('2026-10-04');
  assert.equal(followupPolicy(lead, now, true).maxDays, 5);
  assert.equal(followupPolicy(lead, new Date('2026-10-08T00:00:00Z'), true).stage, 'unrestricted');
  assert.equal(followupPolicy(lead, new Date('2026-10-11T00:00:00Z'), true).maxDays, 1);
});

test('untouched prospects become overdue at Melbourne midnight and new assignments reset the day', () => {
  const now = new Date('2026-11-10T13:00:00Z');
  const lead = { status: 'new_lead', created_at: '2026-11-10T12:59:59Z' };
  assert.equal(prospectOverdue(lead, now), true);
  assert.equal(prospectOverdue({ ...lead, status: 'sold' }, now), false);
  assert.equal(prospectOverdue({ ...lead, assigned_at: now }, now), false);
});
