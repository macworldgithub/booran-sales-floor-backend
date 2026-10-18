const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeRegex, pageQuery, text } = require('../lib/query');

test('search treats user regex metacharacters as literal text', () => {
  const search = 'Ford (EV) [2026] +.*?^$|\\';
  const regex = new RegExp(escapeRegex(search));
  assert.ok(regex.test(search));
  assert.equal(regex.test('Ford EV'), false);
  assert.equal(text({ $ne: null }), '');
});

test('pagination bounds malformed and extreme inputs', () => {
  for (const input of ['Infinity', 'NaN', '-1', '1.5', '20junk', ['2'], undefined]) {
    assert.equal(pageQuery({ page: input }, 'leads', 'created_at').page, 1);
  }
  const result = pageQuery({ page: '3', limit: '99999' }, 'vehicles', 'daysInStock');
  assert.equal(result.limit, 100);
  assert.equal(result.skip, 200);
});

test('sort fields are allowlisted and ties have a stable order', () => {
  assert.deepEqual(pageQuery({ sortBy: '$where' }, 'leads', 'created_at').sort, { created_at: -1, _id: 1 });
  assert.deepEqual(pageQuery({ sortBy: 'totalStockCost', sortOrder: 'asc' }, 'vehicles', 'daysInStock').sort, { totalStockCost: 1, _id: 1 });
});
