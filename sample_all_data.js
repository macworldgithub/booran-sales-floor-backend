const { MongoClient } = require('mongodb');
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();

async function inspect() {
  const flwupClient = new MongoClient(process.env.MONGODB_URI_FLWUP);
  await flwupClient.connect();
  const fDb = flwupClient.db();

  console.log('=== FLWUP CRM DATA SUMMARY ===');
  const leadStatuses = await fDb.collection('leads').distinct('status');
  console.log('Lead Statuses:', leadStatuses);

  const dealerships = await fDb.collection('leads').distinct('dealership_name');
  console.log('Lead Dealerships:', dealerships);

  const owners = await fDb.collection('leads').distinct('owner_name');
  console.log('Lead Owners (Top 10):', owners.slice(0, 10));

  const sources = await fDb.collection('leads').distinct('source');
  console.log('Lead Sources:', sources);

  const vehiclesMakes = await fDb.collection('leads').distinct('vehicle_make');
  console.log('Lead Vehicle Makes:', vehiclesMakes);

  const crmRooftops = await fDb.collection('rooftops').find().toArray();
  console.log('CRM Rooftops:', crmRooftops.map(r => ({ id: r.id, name: r.name, dealer_code: r.dealer_code })));

  const booranClient = new MongoClient(process.env.MONGODB_URI_BOORAN);
  await booranClient.connect();
  const bDb = booranClient.db();

  console.log('\n=== BOORAN INVENTORY DATA SUMMARY ===');
  const invRooftops = await bDb.collection('rooftops').find().toArray();
  console.log('Inventory Rooftops:', invRooftops.map(r => ({ rooftopId: r.rooftopId, name: r.name, location: r.location, gm: r.generalManager })));

  const actionTypes = await bDb.collection('actionitems').distinct('actionType');
  console.log('Action Types:', actionTypes);

  const actionPriorities = await bDb.collection('actionitems').distinct('priority');
  console.log('Action Priorities:', actionPriorities);

  const actionStatuses = await bDb.collection('actionitems').distinct('status');
  console.log('Action Statuses:', actionStatuses);

  const vehicleMakes = await bDb.collection('vehicles').distinct('make');
  console.log('Inventory Vehicle Makes (Top 10):', vehicleMakes.slice(0, 10));

  const vehicleCategories = await bDb.collection('vehicles').distinct('category');
  console.log('Inventory Categories:', vehicleCategories);

  const agingBuckets = await bDb.collection('vehicles').distinct('agingBucket');
  console.log('Inventory Aging Buckets:', agingBuckets);

  await flwupClient.close();
  await booranClient.close();
}

inspect().catch(console.error);
