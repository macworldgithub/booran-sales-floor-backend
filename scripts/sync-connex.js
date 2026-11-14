require('dotenv').config();
const { ConnexClient } = require('../lib/connex-client');
// Read-only deployment check. No CRM import or source mutation, and no customer
// contact values are printed to the terminal or deployment logs.
async function main() {
  if (!process.argv.includes('--dry-run')) throw new Error('Use --dry-run. Production synchronization runs through the durable application worker.');
  const client = new ConnexClient();
  try {
    const id = process.argv.find(value => /^006[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(value));
    if (id) {
      const record = await client.read(id);
      console.log(JSON.stringify({ recordId: record.recordId, dealership: record.dealership, stage: record.stage,
        hasName: Boolean(record.name), hasPhone: Boolean(record.phone), hasEmail: Boolean(record.email), hasVehicle: Boolean(record.vehicle), hasSalesperson: Boolean(record.salesperson) }));
    } else {
      const list = await client.list(); console.log(JSON.stringify({ opportunities: list.records.length, complete: list.complete }));
    }
  } finally { await client.close(); }
}
main().catch(error => { console.error(require('../lib/connex-policy').cleanError(error)); process.exitCode = 1; });
