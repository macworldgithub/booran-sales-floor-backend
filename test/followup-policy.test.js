const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dayKey, followupPolicy, prospectOverdue, validateFollowup, needsActionToday } = require('../lib/followup-policy');

test('follow-up limits use Melbourne calendar days through a DST change', () => {
  const now = new Date('2026-10-04T02:00:00Z');
  const lead = { created_at:'2026-10-01T00:00:00Z', followup_days: ['2026-10-02', '2026-10-03'] };
  assert.equal(dayKey(now), '2026-10-04');
  assert.equal(followupPolicy({}, now, true).maxDate, '2026-10-07');
  assert.equal(followupPolicy(lead, now, true).maxDate, '2026-10-09');
  assert.throws(() => validateFollowup(lead, '2026-10-09T13:00:00Z', now, true), /no later than 2026-10-09/);
  lead.followup_days.push('2026-10-04');
  assert.equal(followupPolicy(lead, now, true).maxDays, 5);
  assert.equal(followupPolicy(lead, new Date('2026-10-09T00:00:00Z'), true).stage, 'unrestricted');
  assert.equal(followupPolicy(lead, new Date('2026-10-11T00:00:00Z'), true).maxDays, null);
});

test('historical source dates and reassignment never restart the initial clock; later dates request approval',()=>{
  const now=new Date('2026-11-17T00:00:00Z');
  assert.equal(followupPolicy({created_at:'2026-01-01T00:00:00Z',createdAt:now,assigned_at:now},now).maxDays,null);
  const fresh={created_at:now.toISOString()};
  assert.equal(followupPolicy(fresh,now).maxDays,3);
  assert.equal(followupPolicy(fresh,new Date('2026-11-20T00:00:00Z')).maxDays,5);
  assert.equal(followupPolicy(fresh,new Date('2026-11-25T00:00:00Z')).maxDays,null);
  assert.equal(validateFollowup(fresh,'2026-12-01T00:00:00Z',now,true,true).needsApproval,true);
  assert.throws(()=>validateFollowup(fresh,'2026-11-16T00:00:00Z',now,true,true),/future/);
});

test('Today excludes tomorrow, completed actions and pending approvals without hiding due work',()=>{
  const now=new Date('2026-11-17T02:00:00Z'),lead={status:'following_up'};
  assert.equal(needsActionToday(lead,now),true);
  assert.equal(needsActionToday({...lead,next_action:{due_at:'2026-11-18T02:00:00Z'}},now),false);
  assert.equal(needsActionToday({...lead,next_action:{due_at:'2026-11-17T04:00:00Z'}},now),true);
  assert.equal(needsActionToday({...lead,next_action:{status:'completed'}},now),false);
  assert.equal(needsActionToday({...lead,loss_review:{status:'pending'}},now),false);
  assert.equal(needsActionToday({...lead,next_action_review:{status:'pending'}},now),false);
});

test('untouched prospects become overdue at Melbourne midnight and new assignments reset the day', () => {
  const now = new Date('2026-11-10T13:00:00Z');
  const lead = { status: 'new_lead', created_at: '2026-11-10T12:59:59Z' };
  assert.equal(prospectOverdue(lead, now), true);
  assert.equal(prospectOverdue({ ...lead, status: 'sold' }, now), false);
  assert.equal(prospectOverdue({ ...lead, assigned_at: now }, now), false);
});
