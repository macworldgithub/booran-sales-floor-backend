const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSmsCampaignDatabase } = require('../lib/sms-campaign-sync');

test('a database name reuses the CRM connection for SMS Campaign', async () => {
  const client = { db: name => ({ databaseName: name, client }) };
  const target = { databaseName: 'flwup_crm', client };
  const source = await resolveSmsCampaignDatabase(target, () => assert.fail('No dedicated connection needed'),
    { SMS_CAMPAIGN_DB_NAME: 'sms_campaign' });
  assert.equal(source.databaseName, 'sms_campaign');
  assert.equal(source.client, client);
});

test('a connection URI in SMS_CAMPAIGN_DB_NAME opens its own database connection', async () => {
  const target = { databaseName: 'flwup_crm', client: { db: () => assert.fail('A URI must not be used as a database name') } };
  const source = { databaseName: 'sms_campaign', client: {} };
  const resolved = await resolveSmsCampaignDatabase(target, async key => {
    assert.equal(key, 'SMS_CAMPAIGN_DB_NAME');
    return source;
  }, { SMS_CAMPAIGN_DB_NAME: 'mongodb+srv://user:password@example.invalid/sms_campaign' });
  assert.equal(resolved, source);
});

test('a dedicated SMS Campaign URI takes precedence over the shared-cluster database name', async () => {
  const target = { databaseName: 'flwup_crm', client: {} };
  const source = { databaseName: 'sms_campaign', client: {} };
  assert.equal(await resolveSmsCampaignDatabase(target, async key => {
    assert.equal(key, 'MONGODB_URI_SMS_CAMPAIGN');
    return source;
  }, { MONGODB_URI_SMS_CAMPAIGN: 'mongodb://localhost/sms_campaign', SMS_CAMPAIGN_DB_NAME: 'old_database' }), source);
});

test('SMS Campaign cannot use the target CRM database as its source', async () => {
  const client = { db: name => ({ databaseName: name, client }) };
  const target = { databaseName: 'flwup_crm', client };
  await assert.rejects(resolveSmsCampaignDatabase(target, async () => target, { SMS_CAMPAIGN_DB_NAME: 'flwup_crm' }), /separate/);
  await assert.rejects(resolveSmsCampaignDatabase(target, async () => target, {
    MONGODB_URI_SMS_CAMPAIGN: 'mongodb://localhost/flwup_crm', MONGODB_URI_FLWUP: 'mongodb://localhost/flwup_crm',
  }), /separate/);
});

test('syncSmsCampaign skips DealerSocket opportunities when syncDealerSocket is false', async () => {
  const { syncSmsCampaign, isDealerSocketSyncEnabled } = require('../lib/sms-campaign-sync');
  
  // Test helper
  assert.equal(isDealerSocketSyncEnabled({ syncDealerSocket: false }), false);
  assert.equal(isDealerSocketSyncEnabled({ syncDealerSocket: true }), true);
  
  const saved = process.env.DEALERSOCKET_SYNC_ENABLED;
  try {
    process.env.DEALERSOCKET_SYNC_ENABLED = 'false';
    assert.equal(isDealerSocketSyncEnabled(), false);
    process.env.DEALERSOCKET_SYNC_ENABLED = 'true';
    assert.equal(isDealerSocketSyncEnabled(), true);
  } finally {
    if (saved !== undefined) process.env.DEALERSOCKET_SYNC_ENABLED = saved;
    else delete process.env.DEALERSOCKET_SYNC_ENABLED;
  }

  let opportunitiesQueried = false;
  const mockSource = {
    collection: (name) => {
      if (name === 'south_morang_prospects') opportunitiesQueried = true;
      return {
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }), toArray: async () => [] }),
        findOne: async () => null,
      };
    },
  };
  const mockTarget = {
    collection: () => ({
      findOne: async () => null,
      bulkWrite: async () => {},
    }),
  };

  const result = await syncSmsCampaign(mockTarget, mockSource, new Date(), { syncDealerSocket: false });
  assert.equal(opportunitiesQueried, false, 'DealerSocket opportunities should not be queried when syncDealerSocket is false');
  assert.equal(result.opportunities.status, 'fulfilled');
  assert.equal(result.opportunities.value, 0);
});
