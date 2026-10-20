#!/usr/bin/env node
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { MongoClient } = require('mongodb');
const { syncFlwupLeads } = require('../lib/flwup-sync');

async function main() {
  console.log('====================================================');
  console.log('🚀 Booran Sales Floor — Live FLWUP Dashboard Sync');
  console.log('   Syncing leads from https://flwup.com.au/api/dashboard');
  console.log('   All phone numbers normalized to +61 format');
  console.log('====================================================\n');

  const uri = process.env.MONGODB_URI_FLWUP;
  if (!uri) {
    console.error('❌ MONGODB_URI_FLWUP is not set in .env');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('flwup_crm');

  try {
    const result = await syncFlwupLeads(db);
    console.log('\n====================================================');
    console.log('🎉 FLWUP Sync Complete!');
    console.log(`⏱️  Duration: ${result.durationMs}ms`);
    console.log(`🏢 Rooftops: ${result.rooftopsProcessed}`);
    console.log(`📋 Total Deals Processed: ${result.dealsProcessed}`);
    console.log(`📦 New Leads Inserted: ${result.inserted}`);
    console.log(`🔄 Existing Leads Updated: ${result.updated}`);
    console.log(`🎯 Total Leads in DB: ${result.totalInDb}`);
    console.log('====================================================\n');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
