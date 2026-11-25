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

test('isNextgateLeadSource detects Carsales, Nexgate, Nextgate, and Autogate sources', () => {
  const { isNextgateLeadSource } = require('../lib/sms-campaign-sync');

  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Carsales' } } }), true);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'carsales' } } }), true);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Carsales.com.au' } } }), true);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Nextgate' } } }), true);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'nexgate' } } }), true);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { tracking_code: 'autogate' } } }), true);
  assert.equal(isNextgateLeadSource({ lead_source: 'Carsales' }), true);

  // Non-Nextgate sources should return false
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Walk In' } } }), false);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Phone Up' } } }), false);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'southmoranghyundai.com.au' } } }), false);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'booran.com.au' } } }), false);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Referral' } } }), false);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'DRIVE' } } }), false);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Internet' } } }), false);
  assert.equal(isNextgateLeadSource({ dealerSocketSnapshot: { record: { lead_source: 'Shopping Centre' } } }), false);
});

test('findMatchingNextgateLead matches by customer name, phone, email, or direct source', () => {
  const { findMatchingNextgateLead } = require('../lib/sms-campaign-sync');

  const nextgateLeads = [
    {
      _id: 'ng-1',
      customer_name: 'Thomas Davies',
      customer_phone: '+61433576117',
      customer_email: 'thomas.davies.australia@gmail.com',
      dealership_name: 'South Morang Hyundai',
      created_at: '2026-11-25T01:21:00Z',
    },
    {
      _id: 'ng-2',
      customer_name: 'Jane Smith',
      customer_phone: '+61411222333',
      customer_email: 'jane.smith@example.com',
      dealership_name: 'South Morang Hyundai',
      created_at: '2026-11-20T00:00:00Z',
    },
  ];

  // 1. DealerSocket prospect with Carsales source matching Thomas Davies by name
  const dsRow = {
    name: 'Thomas Davies',
    capturedAt: '2026-11-25T01:22:00Z',
    dealerSocketSnapshot: { record: { lead_source: 'Carsales' } },
  };
  const match1 = findMatchingNextgateLead(dsRow, 'South Morang Hyundai', null, null, nextgateLeads);
  assert.ok(match1);
  assert.equal(match1._id, 'ng-1');

  // 2. DealerSocket prospect matching by phone
  const phoneMatch = findMatchingNextgateLead({ name: 'T Davies' }, 'South Morang Hyundai', '0433576117', null, nextgateLeads);
  assert.ok(phoneMatch);
  assert.equal(phoneMatch._id, 'ng-1');

  // 3. DealerSocket prospect with Carsales source but no existing Nextgate lead in list -> returns true (so it is skipped)
  const carsalesNew = {
    name: 'Unseen Customer',
    dealerSocketSnapshot: { record: { lead_source: 'Carsales' } },
  };
  assert.equal(findMatchingNextgateLead(carsalesNew, 'South Morang Hyundai', null, null, nextgateLeads), true);

  // 4. DealerSocket Walk-In customer -> returns null (so it is processed and imported)
  const walkIn = {
    name: 'New Walkin Person',
    dealerSocketSnapshot: { record: { lead_source: 'Walk In' } },
  };
  assert.equal(findMatchingNextgateLead(walkIn, 'South Morang Hyundai', null, null, nextgateLeads), null);
});
