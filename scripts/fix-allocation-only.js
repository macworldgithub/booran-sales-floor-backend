require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
const fs = require('node:fs'), path = require('node:path');
const { planAllocationOnlyRouting, applyAllocationOnlyRouting } = require('../lib/allocation-only');
async function main() {
  const value = flag => { const at = process.argv.indexOf(flag); return at < 0 ? '' : process.argv[at + 1]; };
  const name = value('--manager'), site = value('--site'), apply = process.argv.includes('--apply'), backup = value('--backup');
  if (!name || !site || apply && (!backup || !path.isAbsolute(backup))) throw new Error('Use --manager NAME --site SITE. Applying also requires --apply --backup ABSOLUTE_PATH. Default is read-only.');
  const client = await MongoClient.connect(process.env.MONGODB_URI_FLWUP);
  try {
    const db = require('../lib/lead-state').withLeadState(client.db()), plan = await planAllocationOnlyRouting(db, name, site);
    const ids = plan.leads.map(row => String(row._id)), related = {};
    for (const collection of ['deals', 'appraisals', 'deliveries', 'sales_alerts', 'sales_tasks']) related[collection] = await db.collection(collection).find({
      dealership: site, lead_id: { $in: ids }, ...(collection === 'sales_tasks' ? { status: 'open' } : {}) },
      { projection: { _id: 1, owner_id: 1, assignee_id: 1, assignee_name: 1 } }).toArray();
    related.appointments = await db.collection('appointments').find({ dealership: site, leadId: { $in: [...ids, ...plan.leads.map(lead => lead.deal_id).filter(Boolean)] } },
      { projection: { _id: 1, consultant_id: 1, consultantName: 1 } }).toArray();
    const summary = { manager: name, site, planned: plan.leads.length, related: Object.fromEntries(Object.entries(related).map(([key, rows]) => [key, rows.length])) };
    if (!apply) { console.log(JSON.stringify({ ...summary, dryRun: true })); return; }
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.writeFileSync(backup, JSON.stringify({ createdAt: new Date(), managerId: String(plan.allocator._id),
      previousAllocationOnly: plan.allocator.allocation_only ?? null, leads: plan.leads, related }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ ...summary, ...await applyAllocationOnlyRouting(db, plan), backupWritten: true }));
  } finally { await client.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
