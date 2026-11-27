require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { MongoClient } = require('mongodb');
const { withLeadState } = require('../lib/lead-state');
const { SITE, readPrivate, writePrivate, VirtualyardClient, scrape, planSnapshot, importSnapshot } = require('../lib/virtualyard');

async function main() {
  const { values } = parseArgs({ options: {
    status: { type: 'boolean' }, resume: { type: 'boolean' }, file: { type: 'string' }, apply: { type: 'boolean' },
  } });
  const directory = process.env.VIRTUALYARD_DATA_DIR || path.resolve(__dirname, '../storage/virtualyard');
  const client = new VirtualyardClient({ directory, portal: process.env.VIRTUALYARD_PORTAL_URL,
    delayMs: process.env.VIRTUALYARD_DELAY_MS, dailyLimit: process.env.VIRTUALYARD_DAILY_LIMIT, pageSize: process.env.VIRTUALYARD_PAGE_SIZE });
  if (values.status) { console.log(JSON.stringify(client.state)); return; }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'run.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); console.log(JSON.stringify({ status: 'busy' })); return; }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  let connection;
  let db;
  const sync = async patch => db?.collection('integration_sync').updateOne({ _id: 'virtualyard:south-morang-byd' }, { $set: {
    kind: 'virtualyard', dealership: SITE, ...patch,
  } }, { upsert: true });
  try {
    if (values.resume) {
      if (values.file) throw new Error('Resume applies only to live syncs.');
      client.save({ status: 'ready', error: null }); // Does not override Retry-After or request budgets.
    }
    if (values.file) {
      const snapshot = readPrivate(path.resolve(values.file));
      const plan = planSnapshot(snapshot);
      if (!values.apply) { console.log(JSON.stringify({ status: 'dry_run', dealership: SITE, sourceRecords: plan.length, testDrives: snapshot.testDrives.length })); return; }
    } else {
      try { client.assertReady(); }
      catch (error) {
        if (['provider_blocked', 'authentication_required', 'cooldown'].includes(error.code)) {
          console.log(JSON.stringify({ status: 'paused', reason: error.code })); return;
        }
        throw error;
      }
    }
    if (!process.env.MONGODB_URI_FLWUP) throw new Error('MONGODB_URI_FLWUP is not configured.');
    connection = new MongoClient(process.env.MONGODB_URI_FLWUP, { maxPoolSize: 2, serverSelectionTimeoutMS: 10000 });
    db = withLeadState((await connection.connect()).db());
    const startedAt = new Date().toISOString();
    if (!values.file) client.save({ status: 'running', startedAt, error: null });
    await sync({ status: 'running', error: null });
    const snapshot = values.file ? readPrivate(path.resolve(values.file)) : await scrape(client);
    const result = await importSnapshot(db, snapshot);
    // A failed/incomplete fetch never replaces the last fully imported snapshot.
    writePrivate(path.join(directory, 'last-success.json'), snapshot);
    const lastSuccess = new Date().toISOString();
    if (!values.file) client.save({ status: 'succeeded', lastSuccess, finishedAt: lastSuccess, error: null, retryAt: null, ...result });
    await sync({ status: 'succeeded', last_success: new Date(lastSuccess), snapshotAt: snapshot.scrapedAt, error: null, ...result });
    console.log(JSON.stringify({ status: 'succeeded', ...result }));
  } catch (error) {
    const code = error.code || 'sync_failed';
    // Do not include upstream bodies, credentials, Mongo URLs or customer data.
    const message = ({ provider_blocked: 'Virtual Yard blocked access. Resolve provider access before explicitly resuming.',
      authentication_required: 'Reconnect the verified South Morang BYD session before resuming.',
      configuration_required: 'Configure the verified South Morang BYD portal and private session.',
      scope_unverified: 'No verified South Morang BYD leads found. No records imported.',
      rate_limited: 'Provider rate limit reached. Waiting until the retry time.',
      request_budget: 'Daily request budget reached. No partial snapshot imported.',
    })[code] || 'Virtual Yard sync failed. The last successful snapshot was preserved.';
    if (!values.file) client.save({ status: code, error: message, finishedAt: new Date().toISOString(), ...(error.retryAt ? { retryAt: error.retryAt } : {}) });
    await sync({ status: code, error: message }).catch(() => {});
    console.error(JSON.stringify({ status: code, message }));
    process.exitCode = 1;
  } finally {
    await connection?.close();
    fs.unlinkSync(lock);
  }
}
main().catch(() => { console.error('Virtual Yard configuration or private storage is unavailable.'); process.exitCode = 1; });
