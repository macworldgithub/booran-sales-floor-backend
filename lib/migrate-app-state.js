const { isDeepStrictEqual } = require('node:util');
const { STATE_COLLECTIONS, initialiseAppState } = require('./app-state');
const OLD_EMAIL = 'southmoorang@booran.com';
const NEW_EMAIL = 'southmorang@booran.com';
const MIGRATION_ID = 'dedicated-app-state-v1';

function normaliseDocument(kind, document) {
  const { appNamespace, appKind, key, ...record } = document;
  if (kind === 'users' && record.email === OLD_EMAIL) record.email = NEW_EMAIL;
  return record;
}

function assertCompatible(kind, source, destination) {
  if (destination && !isDeepStrictEqual(normaliseDocument(kind, source), normaliseDocument(kind, destination))) {
    throw new Error(`Migration conflict in ${kind}: destination record ${source._id} differs. No existing record will be overwritten.`);
  }
}

async function migrateAppState(db, { apply = false, legacyCollection = 'dashboards', now = new Date() } = {}) {
  if (STATE_COLLECTIONS.includes(legacyCollection)) throw new Error('The legacy collection must be separate from the destination collections.');
  const completed = await db.collection('app_migrations').findOne({ _id: MIGRATION_ID });
  // Never replay backup sessions after logout or restore older login throttles.
  if (completed) return {
    applied: apply, alreadyApplied: true,
    collections: completed.collections.map((entry) => ({ ...entry, toCopy: 0 })),
    locationAccount: NEW_EMAIL,
  };
  const legacy = db.collection(legacyCollection);
  const plans = [];
  // Complete conflict checks for every collection before making any changes.
  for (const kind of STATE_COLLECTIONS) {
    const source = await legacy.find({ appNamespace: 'booran-salesfloor', appKind: kind }).toArray();
    const records = source.filter((record) => !['sessions', 'login_attempts'].includes(kind) || !record.expiresAt || new Date(record.expiresAt) > now).map((record) => normaliseDocument(kind, record));
    const existing = records.length ? await db.collection(kind).find({ _id: { $in: records.map((record) => record._id) } }).toArray() : [];
    const byId = new Map(existing.map((record) => [String(record._id), record]));
    for (const record of records) assertCompatible(kind, record, byId.get(String(record._id)));
    plans.push({ kind, records, missing: records.filter((record) => !byId.has(String(record._id))) });
  }
  const legacyUsers = await legacy.find({ appNamespace: 'booran-salesfloor', appKind: 'users', email: { $in: [OLD_EMAIL, NEW_EMAIL] } }).toArray();
  const targetUsers = await db.collection('users').find({ email: { $in: [OLD_EMAIL, NEW_EMAIL] } }).toArray();
  if (new Set([...legacyUsers, ...targetUsers].map((user) => String(user._id))).size > 1) {
    throw new Error('Both location email addresses belong to different accounts. Resolve the conflict before migrating.');
  }
  // Also protect any other migrated user's unique email from an unrelated destination account.
  for (const user of plans.find((plan) => plan.kind === 'users').records) {
    const existing = await db.collection('users').findOne({ email: user.email });
    if (existing && String(existing._id) !== String(user._id)) throw new Error(`An account already owns ${user.email}; migration stopped without overwriting it.`);
  }
  const summary = plans.map(({ kind, records, missing }) => ({ collection: kind, records: records.length, toCopy: missing.length }));
  if (!apply) return { applied: false, collections: summary };

  await initialiseAppState(db);
  for (const { kind, missing } of plans) {
    for (const record of missing) {
      await db.collection(kind).updateOne({ _id: record._id }, { $setOnInsert: record }, { upsert: true });
    }
  }
  // Keep the same ID and password hash so existing sessions remain valid.
  const account = targetUsers[0] || legacyUsers[0];
  if (account) {
    await db.collection('users').updateOne({ _id: account._id, email: OLD_EMAIL }, { $set: { email: NEW_EMAIL } });
    // Retain a corrected backup for any deployment still using legacy storage.
    await legacy.updateOne({ _id: account._id, appNamespace: 'booran-salesfloor', appKind: 'users', email: OLD_EMAIL }, { $set: { email: NEW_EMAIL } });
  }
  for (const { kind, records } of plans) {
    for (const record of records) {
      if (['sessions', 'login_attempts'].includes(kind) && record.expiresAt && new Date(record.expiresAt) <= new Date()) continue;
      const destination = await db.collection(kind).findOne({ _id: record._id });
      if (!destination) throw new Error(`Migration verification failed: missing ${kind} record.`);
      assertCompatible(kind, record, destination);
    }
  }
  await db.collection('app_migrations').updateOne({ _id: MIGRATION_ID }, {
    $setOnInsert: { completedAt: new Date(), collections: summary, locationAccount: NEW_EMAIL },
  }, { upsert: true });
  return { applied: true, collections: summary, locationAccount: NEW_EMAIL };
}

module.exports = { migrateAppState, normaliseDocument, assertCompatible, OLD_EMAIL, NEW_EMAIL };
