const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { buildDailyOversight } = require('../lib/daily-oversight');

test('daily oversight only marks video light green when a video has actually been sent', () => {
  const now = new Date('2026-11-19T10:00:00Z');
  const today = '2026-11-19';
  const lead1 = { _id: 'lead-1', customer_name: 'Alice', owner_id: 'user-1', owner_name: 'Bob', status: 'following_up', created_at: '2026-11-19T08:00:00Z' };
  const lead2 = { _id: 'lead-2', customer_name: 'Charlie', owner_id: 'user-1', owner_name: 'Bob', status: 'following_up', assigned_at: '2026-11-19T09:00:00Z' };
  const media = [
    { _id: 'vid-1', lead_id: 'lead-1', content_type: 'video/mp4', status: 'ready', share_token: 'token1'.repeat(12).slice(0, 64) },
    { _id: 'vid-2', lead_id: 'lead-2', content_type: 'video/mp4', status: 'ready', share_token: 'token2'.repeat(12).slice(0, 64) },
  ];
  const staff = [{ _id: 'user-1', name: 'Bob', site: 'South Morang Hyundai' }];

  // 1. Merely adding/recording a video does NOT count as video sent
  let input = { leads: [lead1, lead2], tasks: [], media, staff, deals: [], messages: [] };
  let oversight = buildDailyOversight(input, now);
  assert.equal(oversight.members[0].videoSent, 0, 'no videos sent yet');
  assert.equal(oversight.members[0].signals.videos, 'red', 'light is red when video is not sent');
  assert.equal(oversight.dailyNew.total, 2, 'two daily new leads');
  assert.equal(oversight.dailyNew.videoSentCount, 0, 'zero daily new videos sent');

  // 2. Sending a video to lead-1 increments videoSent and dailyNew.videoSentCount
  const messages = [
    { lead_id: 'lead-1', status: 'delivered', direction: 'outbound', created_at: now.toISOString(), attachments: [{ id: 'vid-1', content_type: 'video/mp4' }] },
  ];
  input = { leads: [lead1, lead2], tasks: [], media, staff, deals: [], messages };
  oversight = buildDailyOversight(input, now);
  assert.equal(oversight.members[0].videoSent, 1, 'one video sent');
  assert.equal(oversight.dailyNew.videoSentCount, 1, 'one daily new video sent');
  assert.equal(oversight.members[0].signals.videos, 'red', 'light stays red because lead-2 video is unsent');

  // 3. Sending video to lead-2 turns signal green
  messages.push({ lead_id: 'lead-2', status: 'sent', direction: 'outbound', created_at: now.toISOString(), attachments: [{ id: 'vid-2', content_type: 'video/mp4' }] });
  lead1.last_activity_at = now.toISOString();
  lead2.last_activity_at = now.toISOString();
  lead1.next_action = { title: 'Call back', recorded_at: now.toISOString(), due_at: '2026-11-20T10:00:00Z' };
  lead2.next_action = { title: 'Follow up', recorded_at: now.toISOString(), due_at: '2026-11-20T10:00:00Z' };
  input = { leads: [lead1, lead2], tasks: [], media, staff, deals: [], messages };
  oversight = buildDailyOversight(input, now);
  assert.equal(oversight.members[0].videoSent, 2, 'both videos sent');
  assert.equal(oversight.members[0].signals.videos, 'green', 'light turns green when all videos are actually sent');
  assert.equal(oversight.dailyNew.videoSentCount, 2);
  assert.equal(oversight.dailyNew.followUpSetCount, 2);
  assert.equal(oversight.dailyNew.fullyCoveredCount, 2);
  assert.equal(oversight.dailyNew.signal, 'green');
});
