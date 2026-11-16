#!/usr/bin/env node
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
const { inspectBundle, applyBundle } = require('../lib/iappraise-migration');
const { withLeadState } = require('../lib/lead-state');

async function main() {
  const args = process.argv.slice(2), apply = args.includes('--apply');
  const files = args.filter(arg => arg !== '--apply');
  if (files.length !== 1 || files[0].startsWith('-')) throw new Error('Usage: node scripts/import-iappraise.js [--apply] /private/export/manifest.json');
  const bundle = await inspectBundle(files[0]);
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, valid: true, counts: bundle.counts,
      records: bundle.rows.length, media: bundle.rows.reduce((sum, row) => sum + row.media.length, 0),
      manifestSha256: bundle.manifestHash, completeSourceVerified: false }, null, 2));
    return;
  }
  if (!process.env.MONGODB_URI_FLWUP) throw new Error('MONGODB_URI_FLWUP is required.');
  const client = new MongoClient(process.env.MONGODB_URI_FLWUP, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    console.log(JSON.stringify(await applyBundle(withLeadState(client.db()), bundle, process.env.IAPPRAISE_ARCHIVE_DIR), null, 2));
  } finally { await client.close(); }
}
main().catch(error => {
  console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]'));
  process.exitCode = 1;
});
