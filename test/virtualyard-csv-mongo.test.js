const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { createConnection, createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { withLeadState } = require('../lib/lead-state');
const { installVirtualyardCsvImport, UPLOAD_PATH, documentId } = require('../lib/virtualyard-csv-import');
const { installVirtualyardSource, SITE, KIND, archiveKey } = require('../lib/virtualyard-source');
const { scopedDatabase } = require('../lib/access');

const mongod = process.env.VIRTUALYARD_TEST_MONGOD;
const address = '127.0.0.1';
const driveHeader = 'Id,Details,Lead,Tags,Status\r\n';
const leadHeader = 'Prospect,Vehicle,Forms,Tags,Status\n';
const csvRow = fields => fields.map(field => '"' + String(field).replaceAll('"', '""') + '"').join(',');

async function freePort() {
  const server = createServer().listen(0, address);
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(200);
  }
  throw lastError || new Error('Local MongoDB did not become ready');
}

test('Virtual Yard CSV import with real MongoDB transactions and co-located archive', { skip: !mongod, timeout: 90000 }, async t => {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'booran-vy-mongo-'));
  const port = await freePort();
  const process = spawn(mongod, ['--dbpath', directory, '--port', String(port), '--bind_ip', address, '--replSet', 'csv-tests',
    '--logpath', join(directory, 'mongod.log')], { stdio: 'ignore', windowsHide: true });
  const client = new MongoClient(`mongodb://${address}:${port}/virtualyard_test?directConnection=true`, { serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    await client.close();
    if (process.exitCode === null && !process.signalCode && process.pid) {
      const stopped = once(process, 'exit');
      process.kill();
      await stopped;
    }
    assert.equal(dirname(resolve(directory)), tempRoot);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await until(async () => {
    if (process.exitCode !== null) {
      const lines = (await readFile(join(directory, 'mongod.log'), 'utf8').catch(() => '')).trim().split('\n');
      throw new Error(`Local mongod exited ${process.exitCode}. ${lines.slice(-4).join('\n')}`);
    }
    const socket = createConnection({ host: address, port });
    try { await once(socket, 'connect'); return true; }
    finally { socket.destroy(); }
  });
  await client.connect();
  await client.db('admin').command({ replSetInitiate: { _id: 'csv-tests', members: [{ _id: 0, host: `${address}:${port}` }] } });
  await until(async () => (await client.db('admin').command({ hello: 1 })).isWritablePrimary);
  const db = withLeadState(client.db(), 'combined_state');
  const app = express();
  const user = { id: 'test-manager', role: 'manager', site: SITE };
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  installVirtualyardCsvImport(app, async () => db);
  installVirtualyardSource(app, async req => req ? scopedDatabase(db, req.user, req.query.rooftop) : db);
  const server = app.listen(0, address);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://${address}:${server.address().port}`;
  async function request(path, options) {
    const response = await fetch(base + path, options);
    const json = await response.json();
    assert.equal(response.status, 200, json.error);
    return json.data;
  }
  const preview = (file, csv) => request(`${UPLOAD_PATH}?file=${encodeURIComponent(file)}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv });
  const apply = id => request(`${UPLOAD_PATH}/${encodeURIComponent(id)}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const drive = (id, status = 'Confirmed') => csvRow([id,
    `Test buyer ${id} Email  Phone  Type Test Drive Location BYD South Morang 2026 BYD SEAL Stock# 24`,
    'A "quoted", multi-line\r\nlead reference', 'fixture', `${status} 2026/11/28 09:00 AM`]);
  const lead = (id, stage, price) => leadHeader + csvRow([
    `Fixture Buyer Enquiry Type: Test Drive Location: BYD South Morang... ${id} Source Website Page Assigned To Rep Date 2026-11-28 08:00:00 Stage ${stage} Last Contact Today`,
    `2026 BYD SEAL Yard: BYD South Morang Stock# 24 Price ${price}`, '', 'fixture', 'BOOKING',
  ]);
  const manualId = new ObjectId();
  await db.collection('appointments').insertOne({
    _id: manualId, dealership: SITE, type: 'Test Drive', prospectName: 'Test buyer 501001',
    when: '2026-11-27T22:00:00.000Z', virtualyard: null, status: 'Booked',
  });
  const drives = Array.from({ length: 101 }, (_, i) => drive(501001 + i)).join('\r\n');
  const job = await preview('test-drives-2026-11-28-150000.csv', driveHeader + drives);
  assert.equal(job.ready, 101);
  assert.equal(await db.collection('appointments').countDocuments(), 1);
  assert.deepEqual(await apply(job.id), { done: false, processed: 100, total: 101, result: { inserted: 99, updated: 1, unchanged: 0, skipped: 0 } });
  const completed = { done: true, processed: 101, total: 101, result: { inserted: 100, updated: 1, unchanged: 0, skipped: 0 } };
  assert.deepEqual(await Promise.all([apply(job.id), apply(job.id)]), [completed, completed]);
  assert.equal(await db.collection('appointments').countDocuments(), 101);
  assert.equal((await db.collection('appointments').findOne({ _id: manualId })).virtualyard.id, '501001');

  let revision = await preview('test-drives-2026-11-28-150100.csv', driveHeader + drive(501002, 'Finished'));
  assert.equal((await apply(revision.id)).result.updated, 1);
  const driveId = documentId('test_drive', '501002');
  assert.equal((await db.collection('appointments').findOne({ _id: driveId })).status, 'Completed');
  const [captured] = await request(`/appointments/${driveId}/virtualyard-source`);
  assert.equal(captured.fields.Lead, 'A "quoted", multi-line\r\nlead reference');
  assert.match(captured.fields.Status, /^Finished/);
  revision = await preview('test-drives-2026-11-28-150000.csv', driveHeader + drive(501002));
  assert.equal((await apply(revision.id)).result.unchanged, 1);
  const olderJob = await preview('test-drives-2026-11-28-150000.csv', driveHeader + drive(501102));
  const newerJob = await preview('test-drives-2026-11-28-150100.csv', driveHeader + drive(501102, 'Finished'));
  const overlapping = await Promise.all([apply(olderJob.id), apply(newerJob.id)]);
  assert.equal(overlapping.reduce((total, job) => total + job.result.inserted, 0), 1);
  assert.equal(await db.collection('appointments').countDocuments({ 'virtualyard.id': '501102' }), 1);
  assert.equal((await db.collection('appointments').findOne({ 'virtualyard.id': '501102' })).status, 'Completed');

  revision = await preview('leads-2026-11-28-150000.csv', lead(601001, 'New', '$40,000'));
  assert.equal((await apply(revision.id)).result.inserted, 1);
  const leadKey = documentId('lead', '601001');
  await db.collection('leads').updateOne({ _id: leadKey }, { $set: {
    customer_name: 'Staff Name', owner_name: 'Manual Owner', booran_edited_fields: ['customer_name'],
  } });
  revision = await preview('leads-2026-11-28-150100.csv', lead(601001, 'Complete', '$41,000'));
  assert.equal((await apply(revision.id)).result.updated, 1);
  const row = await db.collection('leads').findOne({ _id: leadKey });
  assert.equal(row.status, 'completed');
  assert.equal(row.customer_name, 'Staff Name');
  assert.equal(row.owner_name, 'Manual Owner');
  assert.equal(row.external.virtualyard.price, '$41,000');
  assert.equal(await db.collection('leads').countDocuments(), 1);
  const bucket = await db.collection('integration_sync').findOne({ _id: archiveKey('lead', '601001'), kind: KIND });
  assert.match(bucket.records['601001'].fields.Vehicle, /41,000/);
  const attached = new ObjectId();
  await db.collection('leads').insertOne({ _id: attached, dealership_name: SITE, customer_name: 'Fixture Buyer',
    created_at: '2026-11-27T21:00:00.000Z', source: 'Manual', status: 'following_up', external: null });
  revision = await preview('leads-2026-11-28-150200.csv', lead(601002, 'New', '$50,000'));
  assert.equal((await apply(revision.id)).result.updated, 1);
  const [linked] = await request(`/leads/${attached}/virtualyard-source`);
  assert.equal(linked.id, '601002');
  assert.equal((await db.collection('leads').findOne({ _id: attached })).status, 'following_up');
  assert.equal(await db.collection('leads').countDocuments(), 2);
});
