require('dotenv').config();
const { MongoClient } = require('mongodb');
const { hashPassword } = require('../lib/password');
const { initialiseAppState } = require('../lib/app-state');
const { migrateAppState } = require('../lib/migrate-app-state');

async function main() {
  const password = process.env.INITIAL_ACCOUNT_PASSWORD;
  if (!password) throw new Error('Set INITIAL_ACCOUNT_PASSWORD to provision the requested accounts.');
  const client = new MongoClient(process.env.MONGODB_URI_FLWUP, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db();
    await migrateAppState(db, { apply: true, legacyCollection: process.env.LEGACY_APP_STATE_COLLECTION || process.env.APP_STATE_COLLECTION || 'dashboards' });
    await initialiseAppState(db);
    const accounts = [
      { email: 'devs@omnisuiteai.com', name: 'Omnisuite Super Admin', role: 'super_admin', site: 'All Locations' },
      { email: 'southmorang@booran.com', name: 'South Morang', role: 'manager', site: 'South Morang' },
    ];
    for (const account of accounts) {
      const result = await db.collection('users').updateOne({ email: account.email }, { $setOnInsert: { ...account, passwordHash: await hashPassword(password), active: true, createdAt: new Date() } }, { upsert: true });
      console.log(`${account.email}: ${result.upsertedCount ? 'created' : 'already exists (unchanged)'}`);
    }
  } finally { await client.close(); }
}
main().catch((error) => { console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]')); process.exitCode = 1; });
