const { MongoClient } = require('mongodb');
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

async function checkAll() {
  const flwupClient = new MongoClient(process.env.MONGODB_URI_FLWUP);
  await flwupClient.connect();
  const flwupDb = flwupClient.db();
  const flwupCols = await flwupDb.listCollections().toArray();
  console.log('=== FLWUP CRM COLLECTIONS ===');
  for (const c of flwupCols) {
    const count = await flwupDb.collection(c.name).countDocuments();
    console.log(`- ${c.name}: ${count}`);
  }

  const booranClient = new MongoClient(process.env.MONGODB_URI_BOORAN);
  await booranClient.connect();
  const booranDb = booranClient.db();
  const booranCols = await booranDb.listCollections().toArray();
  console.log('\n=== BOORAN INVENTORY TRACKER COLLECTIONS ===');
  for (const c of booranCols) {
    const count = await booranDb.collection(c.name).countDocuments();
    console.log(`- ${c.name}: ${count}`);
  }

  await flwupClient.close();
  await booranClient.close();
}

checkAll().catch(console.error);
