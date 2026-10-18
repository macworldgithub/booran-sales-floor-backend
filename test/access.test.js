const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scopeQuery, assertSiteWrite, scopedDatabase } = require('../lib/access');
const { hashPassword, verifyPassword } = require('../lib/password');
const { normaliseDocument, assertCompatible, migrateAppState } = require('../lib/migrate-app-state');

const manager = { role: 'manager', site: 'South Morang' };
test('site scope cannot be replaced by a user supplied location or OR condition', () => {
  const query = { rooftopName: 'Booran Cheltenham', $or: [{ stockNumber: '123' }] };
  const result = scopeQuery(manager, 'vehicles', query);
  assert.equal(result.$and[0], query);
  assert.equal(result.$and[1].rooftopName.$regex, '\\bSouth Morang\\b');
  assert.deepEqual(scopeQuery({ role: 'super_admin' }, 'vehicles', query), query);
  assert.deepEqual(scopeQuery(manager, 'feedlogs').$and[1], { _id: { $exists: false } });
});
test('inserts and updates reject moving records outside the authorised site', () => {
  assert.throws(() => assertSiteWrite(manager, 'leads', { dealership_name: 'Booran Cheltenham' }), { status: 403 });
  assert.throws(() => assertSiteWrite(manager, 'leads', { dealership_name: { $ne: 'South Morang' } }, true), { status: 403 });
  assert.doesNotThrow(() => assertSiteWrite(manager, 'leads', { dealership_name: 'BYD South Morang' }));
  assert.doesNotThrow(() => assertSiteWrite(manager, 'leads', { status: 'sold' }, true));
});
test('direct record updates and aggregates enforce the same site boundary', () => {
  const calls = [];
  const collection = {
    findOneAndUpdate: (...args) => calls.push(args),
    aggregate: (...args) => calls.push(args),
  };
  const db = scopedDatabase({ collection: () => collection }, manager);
  db.collection('vehicles').findOneAndUpdate({ _id: 'outside' }, { $set: { status: 'Soft Hold' } });
  assert.ok(calls[0][0].$and[1].rooftopName);
  db.collection('leads').aggregate([{ $group: { _id: '$status' } }]);
  assert.ok(calls[1][0][0].$match.$and[1].dealership_name);
});
test('passwords use independent salts and reject incorrect credentials', async () => {
  const first = await hashPassword('test-password');
  const second = await hashPassword('test-password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('test-password', first), true);
  assert.equal(await verifyPassword('incorrect', first), false);
  assert.equal(await verifyPassword('test-password', 'invalid'), false);
});
test('legacy account migration corrects the email and preserves its identity and credentials', () => {
  const legacy = { _id: 'user-id', email: 'southmoorang@booran.com', passwordHash: 'existing-hash', role: 'manager', site: 'South Morang', appNamespace: 'booran-salesfloor', appKind: 'users', key: 'legacy-key' };
  const migrated = normaliseDocument('users', legacy);
  assert.deepEqual(migrated, { _id: 'user-id', email: 'southmorang@booran.com', passwordHash: 'existing-hash', role: 'manager', site: 'South Morang' });
  assert.doesNotThrow(() => assertCompatible('users', legacy, migrated));
  assert.equal(legacy.email, 'southmoorang@booran.com');
});

test('migration refuses to overwrite an existing account with different credentials', () => {
  assert.throws(() => assertCompatible('users', { _id: 'id', passwordHash: 'original' }, { _id: 'id', passwordHash: 'different' }), /Migration conflict/);
});

test('booking migration removes legacy routing fields while preserving customer details', () => {
  const booking = { _id: 'booking-id', prospectName: 'Test Customer', dealership: 'South Morang', when: '2026-10-18T10:00:00.000Z', appNamespace: 'booran-salesfloor', appKind: 'appointments', key: 'legacy-key' };
  const record = normaliseDocument('appointments', booking);
  assert.equal(record.prospectName, booking.prospectName);
  assert.equal(record.when, booking.when);
  assert.equal(record.dealership, booking.dealership);
  assert.equal(record.appNamespace, undefined);
});

test('a completed migration never replays legacy sessions or throttles', async () => {
  const db = { collection(name) {
    assert.equal(name, 'app_migrations');
    return { findOne: async () => ({ collections: [{ collection: 'sessions', records: 1, toCopy: 1 }] }) };
  } };
  const result = await migrateAppState(db, { apply: true });
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.collections[0].toCopy, 0);
});
