require('dotenv').config();
const { MongoClient } = require('mongodb');
const { initialiseAppState } = require('../lib/app-state');

async function main() {
  if (!process.env.MONGODB_URI_FLWUP) throw new Error('Set MONGODB_URI_FLWUP before initialising app state.');
  const client = new MongoClient(process.env.MONGODB_URI_FLWUP, { serverSelectionTimeoutMS: 10000 });
  try {
    await initialiseAppState((await client.connect()).db());
    console.log('Booran Sales Floor indexes are ready.');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]'));
  process.exitCode = 1;
});
