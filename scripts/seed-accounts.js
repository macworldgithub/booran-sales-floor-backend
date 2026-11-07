require('dotenv').config();
const { MongoClient } = require('mongodb');
const { readFile } = require('node:fs/promises');
const { hashPassword } = require('../lib/password');
const { initialiseAppState } = require('../lib/app-state');
const { migrateAppState } = require('../lib/migrate-app-state');
const { ROLES, accountSites } = require('../lib/roles');

async function main() {
  const password = process.env.INITIAL_ACCOUNT_PASSWORD;
  if (!password) throw new Error('Set INITIAL_ACCOUNT_PASSWORD to provision the requested accounts.');
  const file = process.argv[2];
  const input = file && JSON.parse(await readFile(file, 'utf8'));
  if (file && (!Array.isArray(input) || !input.length || input.length > 500 || password.length < 12)) {
    throw new Error('Provide a non-empty account array with up to 500 rows and an initial password of at least 12 characters.');
  }
  const accounts = file ? input.map(account => {
    const email = typeof account?.email === 'string' && account.email.trim().toLowerCase();
    const name = typeof account?.name === 'string' && account.name.trim();
    const site = typeof account?.site === 'string' && account.site.trim();
    const role = account?.role;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || !site || !ROLES.includes(role) || role === 'super_admin') throw new Error('Invalid staff account row.');
    const allowedSites = accountSites({ ...account, site });
    if (!allowedSites.includes(site)) throw new Error('Home site must be part of allowedSites.');
    return { email, name, role, site, allowedSites, viewCost: account.viewCost === true };
  }) : [
    { email: 'devs@omnisuiteai.com', name: 'Omnisuite Super Admin', role: 'super_admin', site: 'All Locations' },
    { email: 'southmorang@booran.com', name: 'South Morang', role: 'manager', site: 'South Morang' },
  ];
  const client = new MongoClient(process.env.MONGODB_URI_FLWUP, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db();
    await migrateAppState(db, { apply: true, legacyCollection: process.env.LEGACY_APP_STATE_COLLECTION || process.env.APP_STATE_COLLECTION || 'dashboards' });
    await initialiseAppState(db);
    for (const account of accounts) {
      const result = await db.collection('users').updateOne({ email: account.email }, { $setOnInsert: { ...account, passwordHash: await hashPassword(password), active: true, createdAt: new Date() } }, { upsert: true });
      console.log(`${account.email}: ${result.upsertedCount ? 'created' : 'already exists (unchanged)'}`);
    }
  } finally { await client.close(); }
}
main().catch((error) => { console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]')); process.exitCode = 1; });
