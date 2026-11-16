#!/usr/bin/env node
// Additive server-local database backup. Does not print credentials or records.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createGzip } = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MongoClient, BSON } = require('mongodb');

async function main() {
  const destination = process.argv[2];
  if (!destination || !path.isAbsolute(destination)) throw new Error('Usage: node scripts/snapshot-data.js /private/backup/new-directory');
  await fsp.mkdir(destination, { mode: 0o700 });
  const manifest = { createdAt: new Date().toISOString(), consistentPointInTime: false, databases: [] };
  for (const [key, label] of [['MONGODB_URI_FLWUP', 'crm'], ['MONGODB_URI_BOORAN', 'inventory']]) {
    if (!process.env[key]) throw new Error(`${key} is not configured.`);
    const client = new MongoClient(process.env[key], { serverSelectionTimeoutMS: 10000 });
    try {
      await client.connect();
      const db = client.db(), directory = path.join(destination, label);
      await fsp.mkdir(directory, { mode: 0o700 });
      const tables = [];
      for (const collection of await db.listCollections({}, { nameOnly: false }).toArray()) {
        if (collection.type !== 'collection' || collection.name.startsWith('system.')) continue;
        const name = collection.name;
        const filename = Buffer.from(name).toString('hex') + '.ejson.ndjson.gz';
        let count = 0;
        const cursor = db.collection(name).find({}).batchSize(100);
        async function* documents() {
          try { for await (const row of cursor) { count++; yield BSON.EJSON.stringify(row, { relaxed: false }) + '\n'; } }
          finally { await cursor.close(); }
        }
        await pipeline(Readable.from(documents()), createGzip(), fs.createWriteStream(path.join(directory, filename), { flags: 'wx', mode: 0o600 }));
        tables.push({ name, filename, count, indexes: await db.collection(name).indexes() });
      }
      manifest.databases.push({ label, collections: tables });
    } finally { await client.close(); }
  }
  await fsp.writeFile(path.join(destination, 'manifest.json'), BSON.EJSON.stringify(manifest, null, 2, { relaxed: false }), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ snapshotComplete: true, collections: manifest.databases.reduce((sum, db) => sum + db.collections.length, 0), destination }));
}
main().catch(error => { console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]')); process.exitCode = 1; });
