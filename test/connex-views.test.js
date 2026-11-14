const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filters, matchesView, recordView } = require('../lib/connex-views');
const { nextBusinessDeadline } = require('../lib/connex-policy');
test('Connex filters combine exact source status, type, salesperson, date and local mobile searches', () => {
  const record = recordView({ snapshot: { recordId: '006TJ000013YBI9YAO', stage: 'Sales Qualified', type: 'Finance', salesperson: 'Quoc Truong', name: 'Fixture Customer', phone: '+61412345678', createdAt: '2026-11-10T13:30:00Z', lastModifiedAt: '2026-11-10T13:30:00Z' } }, new Date('2026-11-16'));
  assert.equal(matchesView(record, filters({ stage: 'Sales Qualified', type: 'Finance', salesperson: 'Quoc Truong', search: '0412 345 678', from: '2026-11-11', to: '2026-11-11' })), true);
  assert.equal(matchesView(record, filters({ stage: 'Accepted' })), false);
  assert.equal(matchesView(record, filters({ view: 'not_updated' })), true);
  assert.equal(matchesView(record, filters({ view: 'open' })), true);
  assert.equal(matchesView(record, filters({ view: 'won' })), false);
  assert.throws(() => filters({ from: '2026-02-31' }), error => error.status === 400);
  assert.throws(() => filters({ stage: { $ne: '' } }), error => error.status === 400);
});
test('business-day deadlines skip the published Victorian Christmas and Boxing Day holidays', () => {
  assert.equal(nextBusinessDeadline('24/12/2026 9:00 am'), '2026-12-29T12:59:59.000Z');
  assert.equal(nextBusinessDeadline('24/12/2027 9:00 am'), '2027-12-29T12:59:59.000Z');
  const unknown = recordView({ snapshot: { stage: 'Accepted', createdAt: '2020-01-01T00:00:00Z' } });
  assert.equal(unknown.notUpdatedFourDays, false, 'an unknown source update date must not be presented as a confirmed stale update');
});
