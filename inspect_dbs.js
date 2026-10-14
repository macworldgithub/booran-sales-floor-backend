const { MongoClient } = require('mongodb');
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

async function inspectDb(name, uri) {
  console.log(`\n========================================`);
  console.log(`INSPECTING DATABASE: ${name}`);
  console.log(`URI: ${uri ? uri.replace(/:([^@]+)@/, ':****@') : 'UNDEFINED'}`);
  console.log(`========================================`);
  if (!uri) {
    console.log('No URI provided!');
    return;
  }
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(`Connected to DB name in client: "${db.databaseName}"`);
    
    const collections = await db.listCollections().toArray();
    console.log(`Collections (${collections.length}):`);
    for (const col of collections) {
      const c = db.collection(col.name);
      const count = await c.countDocuments();
      console.log(`\n--- Collection: ${col.name} (Count: ${count}) ---`);
      if (count > 0) {
        const sample = await c.find().limit(2).toArray();
        console.log(`Sample document keys:`, Object.keys(sample[0]));
        console.log(`Sample doc 1:`, JSON.stringify(sample[0], null, 2).slice(0, 500) + '...');
      }
    }
  } catch (err) {
    console.error(`Error connecting to ${name}:`, err.message);
  } finally {
    await client.close();
  }
}

async function run() {
  await inspectDb('FLWUP CRM (MONGODB_URI_FLWUP)', process.env.MONGODB_URI_FLWUP);
  await inspectDb('BOORAN INVENTORY TRACKER (MONGODB_URI_BOORAN)', process.env.MONGODB_URI_BOORAN);
}

run();
