require('dotenv').config();
const { MongoClient } = require('mongodb');
const { initialiseAppState, initialiseInventoryIndexes } = require('../lib/app-state');

async function main() {
  if (!process.env.MONGODB_URI_FLWUP) throw new Error('Set MONGODB_URI_FLWUP before initialising app state.');
  const targets = [{ uri: process.env.MONGODB_URI_FLWUP, initialise: initialiseAppState }];
  if (process.env.MONGODB_URI_BOORAN) targets.push({ uri: process.env.MONGODB_URI_BOORAN, initialise: initialiseInventoryIndexes });
  const clients = targets.map(target => new MongoClient(target.uri, {
    serverSelectionTimeoutMS: 10000, compressors: ['zlib'], zlibCompressionLevel: 3,
  }));
  try {
    const outcomes = await Promise.allSettled(targets.map(async (target, index) => {
      const db = (await clients[index].connect()).db();
      await target.initialise(db);
    }));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    console.log('Booran Sales Floor indexes are ready.');
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
  }
}

main().catch(error => {
  console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]'));
  process.exitCode = 1;
});
