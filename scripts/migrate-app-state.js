require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
const { migrateAppState } = require('../lib/migrate-app-state');

async function main() {
  if (!process.env.MONGODB_URI_FLWUP) throw new Error('MONGODB_URI_FLWUP is required.');
  const client = new MongoClient(process.env.MONGODB_URI_FLWUP, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const result = await migrateAppState(client.db(), {
      apply: process.argv.includes('--apply'),
      legacyCollection: process.env.LEGACY_APP_STATE_COLLECTION || process.env.APP_STATE_COLLECTION || 'dashboards',
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await client.close(); }
}
main().catch((error) => {
  console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]'));
  process.exitCode = 1;
});
