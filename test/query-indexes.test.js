const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialiseInventoryIndexes } = require('../lib/app-state');

test('query index setup reuses equivalent indexes and remains safe to retry', async () => {
  const indexes = new Map([['vehicles', [{ key: { daysInStock: -1, _id: 1 }, name: 'existing_custom_name' }]]]);
  const created = [];
  const db = { collection: name => ({
    indexes: async () => indexes.get(name) || [],
    createIndexes: async definitions => {
      created.push({ name, definitions });
      indexes.set(name, [...(indexes.get(name) || []), ...definitions]);
    },
  }) };
  await initialiseInventoryIndexes(db);
  assert.equal(created.length, 3);
  assert.equal(created.find(row => row.name === 'vehicles').definitions.length, 3);
  await initialiseInventoryIndexes(db);
  assert.equal(created.length, 3, 'a repeated deployment does not recreate equivalent indexes');
});
