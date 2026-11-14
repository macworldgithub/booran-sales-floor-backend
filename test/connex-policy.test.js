const { test } = require('node:test');
const assert = require('node:assert/strict');
const { opportunityId, opportunityUrl, portalDate, nextBusinessDeadline, attention, emailReference } = require('../lib/connex-policy');
const id = '006TJ000013YBI9YAO';
test('Connex references reject lookalike hosts, credentials, other routes and malformed identifiers', () => {
  assert.equal(opportunityId(opportunityUrl(id)), id);
  for (const value of ['006bad', `http://connex-hmca.my.site.com/HMCADealerCommunity/s/opportunity/${id}`,
    `https://connex-hmca.my.site.com.evil.test/HMCADealerCommunity/s/opportunity/${id}`,
    `https://attacker@connex-hmca.my.site.com/HMCADealerCommunity/s/opportunity/${id}`,
    `https://connex-hmca.my.site.com/other/s/opportunity/${id}`]) assert.equal(opportunityId(value), null);
  assert.equal(emailReference({ html: `<a href="${opportunityUrl(id)}">View lead</a>` }).recordId, id);
  assert.equal(emailReference({ text: 'https://evil.test/lead' }), null);
});
test('Melbourne lead dates, DST and Friday to Monday acceptance deadlines are consistent', () => {
  assert.equal(portalDate('10/11/2026, 8:26 pm'), '2026-11-10T09:26:00.000Z');
  assert.equal(portalDate('10/07/2026, 8:26 pm'), '2026-07-10T10:26:00.000Z');
  assert.equal(portalDate('31/02/2026'), null); assert.equal(portalDate('10/11/2026 13:20 pm'), null);
  assert.equal(nextBusinessDeadline('13/11/2026 11:00 am'), '2026-11-16T12:59:59.000Z');
  assert.equal(nextBusinessDeadline('13/11/2026 11:00 am', ['2026-11-16']), '2026-11-17T12:59:59.000Z');
  assert.equal(nextBusinessDeadline('2/10/2026 11:00 am'), '2026-10-05T12:59:59.000Z');
  const flags = attention({ stage: 'Distributed', createdAt: '2026-09-01T00:00:00Z' }, new Date('2026-11-14'));
  assert.equal(flags.acceptanceOverdue, true); assert.equal(flags.notAcceptedThreeDays, true); assert.equal(flags.openSixWeeks, true);
  assert.equal(attention({ stage: 'Closed Lost', createdAt: '2026-09-01T00:00:00Z' }).openSixWeeks, false);
});
