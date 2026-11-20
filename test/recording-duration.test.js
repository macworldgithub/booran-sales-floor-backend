const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordingDuration, packetDuration } = require('../lib/recording-duration');
const packets = seconds => Array.from({ length: Math.round(seconds * 30) }, (_, index) => ({ pts_time: String(index / 30), duration_time: String(1 / 30) }));

test('normal uploaded video keeps its verified container duration without scanning packets', async () => {
  assert.equal(await recordingDuration({ format: { duration: '31.25' } }, () => { throw Error('Unexpected scan'); }), 31.25);
});
test('browser MP4 wrapped sample duration uses actual presentation timeline', async () => {
  const samples = packets(33.4);
  samples[42].duration_time = '7158278.825';
  const duration = await recordingDuration({ format: { duration: '7158290.113333' } }, async () => ({ packets: samples }));
  assert.ok(Math.abs(duration - 33.4) < 0.001);
});
test('streaming WebM without container duration uses video packet timestamps', async () => {
  assert.ok(Math.abs(await recordingDuration({ format: {} }, async () => ({ packets: packets(2) })) - 2) < 0.001);
});
test('actual videos exceeding three minutes are rejected even with corrupt duration metadata', async () => {
  await assert.rejects(recordingDuration({ format: { duration: '7158290' } }, async () => ({ packets: packets(181) })), error => error.status === 400 && /three minutes/.test(error.message));
});
test('unverifiable, missing and repeated timestamps cannot bypass validation', () => {
  for (const samples of [[], [{}, {}], [{ pts_time: null }, { pts_time: '' }], [{ pts_time: '0', duration_time: '.03' }, { pts_time: '0', duration_time: '.03' }]]) {
    assert.throws(() => packetDuration({ packets: samples }), error => error.status === 400);
  }
});
