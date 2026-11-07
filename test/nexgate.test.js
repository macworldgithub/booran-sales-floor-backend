const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEALERSHIPS, fetchDealership } = require('../lib/nexgate-client');
const { nexgateService, HOUR } = require('../lib/nexgate-sync');

test('hourly reconciliation only advances successful seller checkpoints and saves completed pages', async () => {
  const checkpoints = new Map();
  let batches = 0;
  const db = { collection(name) {
    if (name === 'leads') return { bulkWrite: async ops => { batches++; return { upsertedCount: ops.length }; } };
    return {
      async findOneAndUpdate({ _id }, { $set }) {
        const state = { ...checkpoints.get(_id), ...$set };
        checkpoints.set(_id, state);
        return state;
      },
      async updateOne({ _id, lease }, { $set, $unset }) {
        const state = checkpoints.get(_id);
        assert.equal(state.lease, lease);
        Object.assign(state, $set);
        for (const key of Object.keys($unset || {})) delete state[key];
      },
    };
  } };
  const failedSeller = DEALERSHIPS[0][1];
  const service = nexgateService(async () => db, {
    token: 'fixture-token',
    makeClient: () => () => {},
    async fetchDealer(_request, _name, seller, _size, _comments, { since, onPage }) {
      assert.ok(Math.abs(since + 24 * HOUR - Date.now()) < HOUR);
      await onPage([{ id: 'customer', lead: { id: 'lead', leadCreatedDate: '2026-11-07T00:00:00Z' } }]);
      if (seller === failedSeller) throw new Error('Fixture page outage');
    },
  });
  const result = await service.sync();
  assert.equal(result.success, false);
  assert.equal(batches, 5);
  assert.equal(result.sellers.filter(row => row.failed).length, 1);
  assert.equal(checkpoints.get(failedSeller).last_success, undefined);
  assert.equal([...checkpoints.values()].filter(row => row.last_success instanceof Date).length, 4);
  assert.ok([...checkpoints.values()].every(row => row.lease === undefined));
});

test('the live poll only reads the first page, even when the search reports more customers', async () => {
  const requests = [];
  const request = async (_url, _action, options) => {
    requests.push(options.from);
    return { customers: [{ id: 'latest', lead: { id: 'lead', leadCreatedDate: '2026-11-07T00:00:00Z' } }] };
  };
  const result = await fetchDealership(request, ...DEALERSHIPS[0], 20, false, { pageLimit: 1 });
  assert.deepEqual(requests, [0]);
  assert.equal(result.leadCount, 1);
});
