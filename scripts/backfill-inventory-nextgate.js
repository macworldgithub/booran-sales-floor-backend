// Enrich existing matched paid-enquiry references only. No customer creation,
// allocation, contact details or workflow statuses are changed.
const { vehicleIndex, resolveVehicle, paidSource } = require('../lib/inventory-insights');
const { leadOperation } = require('../lib/nexgate-sync');

async function backfillInventoryNextgate({ crm, inventory, request, onProgress = () => {} }) {
  const units = await inventory.collection('vehicles').find({ salesFloorHidden: { $ne: true } }, { projection: { _id: 1, stockNumber: 1, rooftopName: 1, vin: 1 } }).toArray();
  const index = vehicleIndex(units), fields = ['seller_id', 'customer_id', 'lead_id', 'stock_number', 'channel', 'lead_type', 'created_at', 'vin'];
  const projection = { dealership_name: 1, ...Object.fromEntries(fields.flatMap(field => [[`nexgate.${field}`, 1], [`source_refs.nexgate.${field}`, 1]])) };
  const leads = await crm.collection('leads').find({ $or: [{ nexgate: { $exists: true } }, { 'source_refs.nexgate': { $exists: true } }] }, { projection }).toArray();
  const plans = new Map();
  for (const lead of leads) {
    const references = [{ path: 'nexgate', value: lead.nexgate }, ...(lead.source_refs || []).map((ref, i) => ({ path: `source_refs.${i}.nexgate`, value: ref.nexgate }))];
    for (const { path, value: ref } of references) {
      if (!ref || ref.lead_type && ref.created_at || !paidSource(ref.channel) || !ref.customer_id || !resolveVehicle(index, lead.dealership_name, ref)) continue;
      const id = `${ref.seller_id}:${ref.lead_id}`;
      const plan = plans.get(id) || { reference: ref, locations: [] }; plan.locations.push({ id: lead._id, path }); plans.set(id, plan);
    }
  }
  const jobs = [...plans.values()], report = { candidates: jobs.length, fetched: 0, updatedReferences: 0, staleReferences: 0, failed: 0 };
  let at = 0;
  await Promise.all([0, 1].map(async () => {
    while (at < jobs.length) {
      const { reference, locations } = jobs[at++];
      let operation;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await request(`https://customer-api-public.prod.trade.au.csnglobal.net/api/v1/customer/${encodeURIComponent(reference.customer_id)}/leads/${encodeURIComponent(reference.lead_id)}`, 'Inventory lead metadata');
          if (result?.latestLead?.id !== reference.lead_id) throw new Error('Nextgate lead identity did not match.');
          operation = leadOperation(reference.seller_id, { id: reference.customer_id, sellerIdentifier: reference.seller_id }, result.latestLead);
          if (!operation) throw new Error('Nextgate lead metadata was incomplete.');
          break;
        } catch { if (attempt < 2) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000)); }
      }
      if (!operation) { report.failed++; continue; }
      report.fetched++;
      const metadata = Object.entries(operation.updateOne.update.$set).filter(([name]) => ['created_at', 'lead_type', 'vin', 'engagement_events'].includes(name.slice('nexgate.'.length)));
      for (const location of locations) {
        const changed = await crm.collection('leads').findOneAndUpdate({ _id: location.id,
          [`${location.path}.lead_id`]: reference.lead_id, [`${location.path}.seller_id`]: reference.seller_id },
        { $set: Object.fromEntries(metadata.map(([name, value]) => [`${location.path}.${name.slice('nexgate.'.length)}`, value])) }, { returnDocument: 'after' });
        if (changed) report.updatedReferences++; else report.staleReferences++;
      }
      if (report.fetched % 25 === 0) onProgress({ ...report });
    }
  }));
  return report;
}
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const { MongoClient } = require('mongodb');
  const { createClient, loadLocalNexgateEnvironment } = require('../lib/nexgate-client');
  const { withLeadState } = require('../lib/lead-state');
  (async () => {
    loadLocalNexgateEnvironment(); if (!process.env.NEXGATE_TOKEN) throw new Error('Nextgate access is not configured.');
    const clients = [new MongoClient(process.env.MONGODB_URI_FLWUP, { maxPoolSize: 2 }), new MongoClient(process.env.MONGODB_URI_BOORAN, { maxPoolSize: 2 })];
    try {
      await Promise.all(clients.map(client => client.connect()));
      const crm = withLeadState(clients[0].db()), inventory = clients[1].db();
      const result = await backfillInventoryNextgate({ crm, inventory, request: createClient(process.env.NEXGATE_TOKEN, { timeout: 10000 }), onProgress: report => console.log(JSON.stringify(report)) });
      await crm.collection('integration_sync').findOneAndUpdate({ _id: 'inventory-nextgate-backfill' }, { $set: { kind: 'inventory_nextgate_backfill', completedAt: new Date().toISOString(), ...result } }, { upsert: true });
      console.log(JSON.stringify(result));
      if (process.argv.includes('--refresh')) console.log(JSON.stringify(await require('../lib/inventory-insights').refreshInventoryInsights(crm, inventory)));
      if (result.failed || result.staleReferences) process.exitCode = 1;
    } finally { await Promise.all(clients.map(client => client.close())); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { backfillInventoryNextgate };
