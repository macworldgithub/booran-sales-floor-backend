require('dotenv').config();
const { readFile } = require('node:fs/promises');
const { MongoClient } = require('mongodb');
const { parseArgs } = require('node:util');
const { DEALERSHIPS, customerLeads, loadLocalNexgateEnvironment } = require('../lib/nexgate-client');
const { importCustomers, leadOperation, nexgateService } = require('../lib/nexgate-sync');

async function main() {
  const { values, positionals } = parseArgs({ options: { apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, allowPositionals: true });
  if (positionals.length > 1 || (values.apply && values['dry-run'])) throw new Error('Pass one export file and either --dry-run or --apply.');
  const [file] = positionals;
  const snapshot = file && JSON.parse(await readFile(file, 'utf8'));
  if (snapshot && (!Array.isArray(snapshot.dealerships) || snapshot.dealerships.some(dealer =>
    !DEALERSHIPS.some(([, id]) => id === dealer.sellerIdentifier) || !Array.isArray(dealer.customers)))) {
    throw new Error('Invalid Nexgate export');
  }
  if (values['dry-run'] || (snapshot && !values.apply)) {
    if (!snapshot) throw new Error('Provide a Nexgate export file for a dry run.');
    for (const dealer of snapshot.dealerships) {
      const ids = new Set();
      let skipped = 0;
      for (const customer of dealer.customers) {
        for (const lead of customerLeads(customer)) {
          const operation = leadOperation(dealer.sellerIdentifier, customer, lead);
          if (!operation) skipped++;
          else ids.add(String(operation.updateOne.filter._id));
        }
      }
      console.log(dealer.name, { importable: ids.size, skipped });
    }
    return;
  }
  if (!snapshot) loadLocalNexgateEnvironment();
  const client = new MongoClient(process.env.MONGODB_URI_FLWUP, { serverSelectionTimeoutMS: 10000 });
  try {
    const db = require('../lib/lead-state').withLeadState((await client.connect()).db());
    if (snapshot) {
      for (const dealer of snapshot.dealerships) {
        console.log(dealer.sellerIdentifier, await importCustomers(db, dealer.sellerIdentifier, dealer.customers));
      }
    } else {
      const result = await nexgateService(async () => db).sync();
      console.log(result);
      if (!result.success) process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]'));
  process.exitCode = 1;
});
