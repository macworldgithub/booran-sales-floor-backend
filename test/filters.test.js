const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leadQuery, vehicleQuery, actionQuery, locationCondition } = require('../lib/query');
const { scopeQuery, scopedDatabase } = require('../lib/access');

// Small independent matcher for the MongoDB predicates used by these fixtures.
function matches(record, query) {
  return Object.entries(query).every(([field, predicate]) => {
    if (field === '$and') return predicate.every((clause) => matches(record, clause));
    if (field === '$or') return predicate.some((clause) => matches(record, clause));
    if (predicate && typeof predicate === 'object') {
      if ('$exists' in predicate) return (record[field] !== undefined) === predicate.$exists;
      if ('$regex' in predicate) return typeof record[field] === 'string' && new RegExp(predicate.$regex, predicate.$options).test(record[field]);
    }
    return record[field] === predicate;
  });
}
const ids = (records, query) => records.filter((record) => matches(record, query)).map((record) => record._id);
const manager = { role: 'manager', site: 'South Morang' };
const vehicles = [
  { _id: 'south-used-old', rooftopName: 'South Morang Hyundai', category: 'Used', agingBucket: '90+', status: 'In Stock', make: 'Hyundai', stockNumber: 'EV[123]' },
  { _id: 'south-new-fresh', rooftopName: 'South Morang Hyundai', category: 'New', agingBucket: '0-30', status: 'Soft Hold', make: 'Hyundai', stockNumber: 'NEW456' },
  { _id: 'south-kia-demo', rooftopName: 'South Morang Kia', category: 'Demo', agingBucket: '31-45', status: 'In Stock', make: 'Kia', stockNumber: 'KIA123' },
  { _id: 'cheltenham-used', rooftopName: 'Booran Cheltenham', category: 'Used', agingBucket: '90+', status: 'In Stock', make: 'Hyundai', stockNumber: 'EV[123]' },
  { _id: 'similarly-named', rooftopName: 'South Morang Hyundai Other Location', category: 'Used', agingBucket: '90+', status: 'In Stock', stockNumber: 'EV[123]' },
];

test('inventory filters select different records, and combine with AND', () => {
  assert.deepEqual(ids(vehicles, vehicleQuery({ category: 'New' })), ['south-new-fresh']);
  assert.deepEqual(ids(vehicles, vehicleQuery({ agingBucket: '31-45' })), ['south-kia-demo']);
  assert.deepEqual(ids(vehicles, vehicleQuery({ status: 'Soft Hold' })), ['south-new-fresh']);
  assert.deepEqual(ids(vehicles, vehicleQuery({ make: 'Kia' })), ['south-kia-demo']);
  assert.deepEqual(ids(vehicles, vehicleQuery({ rooftop: 'South Morang Hyundai', category: 'Used', agingBucket: '90+', search: 'EV[123]' })), ['south-used-old']);
  assert.deepEqual(ids(vehicles, vehicleQuery({ rooftop: 'South Morang Hyundai', category: 'Demo' })), []);
  assert.deepEqual(ids(vehicles, vehicleQuery({ category: 'all', agingBucket: 'all', status: 'all', rooftop: 'all', search: '' })), vehicles.map((record) => record._id));
});

test('a specific dealership never includes another dealership with a matching prefix', () => {
  assert.deepEqual(ids(vehicles, vehicleQuery({ rooftop: 'south morang hyundai' })), ['south-used-old', 'south-new-fresh']);
  assert.deepEqual(ids(vehicles, vehicleQuery({ rooftop: 'Hyundai' })), []);
});

test('South Morang account scope stays in force for all, forged and combined filters', () => {
  assert.deepEqual(ids(vehicles, scopeQuery(manager, 'vehicles', vehicleQuery({ rooftop: 'all' }))), ['south-used-old', 'south-new-fresh', 'south-kia-demo']);
  assert.deepEqual(ids(vehicles, scopeQuery(manager, 'vehicles', vehicleQuery({ rooftop: 'Booran Cheltenham' }))), []);
  assert.deepEqual(ids(vehicles, scopeQuery(manager, 'vehicles', vehicleQuery({ category: 'Used', agingBucket: '90+', search: 'EV[123]' }))), ['south-used-old']);
});

test('lead status, rooftop, owner and search filters narrow the same result set', () => {
  const leads = [
    { _id: 'byd-new', dealership_name: 'BYD South Morang', status: 'new_lead', owner_name: 'Alex', customer_name: 'Test Alice' },
    { _id: 'byd-sold', dealership_name: 'BYD South Morang', status: 'sold', owner_name: 'Sam', customer_name: 'Test Bob' },
    { _id: 'chery-new', dealership_name: 'Chery South Morang', status: 'new_lead', owner_name: 'Alex', customer_name: 'Test Alice' },
    { _id: 'outside-new', dealership_name: 'Booran Cheltenham', status: 'new_lead', owner_name: 'Alex', customer_name: 'Test Alice' },
  ];
  assert.deepEqual(ids(leads, leadQuery({ status: 'sold' })), ['byd-sold']);
  assert.deepEqual(ids(leads, leadQuery({ dealership: 'BYD South Morang', status: 'new_lead', owner: 'Alex', search: 'Alice' })), ['byd-new']);
  assert.deepEqual(ids(leads, scopeQuery(manager, 'leads', leadQuery({ status: 'new_lead', search: 'Alice' }))), ['byd-new', 'chery-new']);
  assert.deepEqual(ids(leads, leadQuery({ status: 'lost' })), []);
});

test('action type, status, priority and rooftop filters honour all-status selection', () => {
  const actions = [
    { _id: 'south-open', rooftopName: 'South Morang Hyundai', actionType: 'PRICE', status: 'open', priority: 'high', vehicleTitle: 'Test EV' },
    { _id: 'south-resolved', rooftopName: 'South Morang Hyundai', actionType: 'WHOLESALE', status: 'resolved', priority: 'low', vehicleTitle: 'Test EV' },
    { _id: 'outside-open', rooftopName: 'Booran Cheltenham', actionType: 'PRICE', status: 'open', priority: 'high', vehicleTitle: 'Test EV' },
    { _id: 'south-transfer', rooftopName: 'South Morang Kia', actionType: 'TRANSFER', status: 'in_progress', priority: 'medium', vehicleTitle: 'Test EV' },
  ];
  assert.deepEqual(ids(actions, scopeQuery(manager, 'actionitems', actionQuery({}))), ['south-open']);
  assert.deepEqual(ids(actions, scopeQuery(manager, 'actionitems', actionQuery({ status: 'all' }))), ['south-open', 'south-resolved', 'south-transfer']);
  assert.deepEqual(ids(actions, actionQuery({ rooftop: 'South Morang Hyundai', actionType: 'WHOLESALE', status: 'resolved', priority: 'low', search: 'EV' })), ['south-resolved']);
  assert.deepEqual(ids(actions, scopeQuery(manager, 'actionitems', actionQuery({ actionType: 'TRANSFER', status: 'in_progress' }))), ['south-transfer']);
});

test('selected scope is attached to both result and count queries, including staff and bookings', () => {
  const calls = [];
  const db = scopedDatabase({ collection: (name) => ({
    find: (query) => { calls.push({ name, query }); },
    countDocuments: (query) => { calls.push({ name, query }); },
    aggregate: (pipeline) => { calls.push({ name, pipeline }); },
  }) }, manager, 'South Morang Hyundai');
  const query = vehicleQuery({ category: 'New' });
  db.collection('vehicles').find(query);
  db.collection('vehicles').countDocuments(query);
  assert.deepEqual(calls[0].query, calls[1].query);
  db.collection('leads').aggregate([{ $group: { _id: '$owner_name' } }]);
  const staffScope = calls[2].pipeline[0].$match;
  assert.equal(matches({ dealership_name: 'BYD South Morang' }, staffScope), false);
  assert.equal(matches({ dealership_name: 'South Morang Hyundai' }, staffScope), true);
  db.collection('appointments').find({ type: 'Test Drive' });
  assert.equal(matches({ dealership: 'Booran Cheltenham', type: 'Test Drive' }, calls[3].query), false);
  assert.equal(matches({ dealership: 'South Morang Hyundai', type: 'Test Drive' }, calls[3].query), true);
});

test('the South Morang group includes its dealerships and rejects substring lookalikes', () => {
  const condition = locationCondition('South Morang');
  for (const name of ['BYD South Morang', 'Chery South Morang', 'South Morang Hyundai', 'South Morang Kia']) assert.ok(matches({ name }, { name: condition }));
  for (const name of ['Booran Cheltenham', 'Cranbourne Hyundai', 'Berwick MG', 'Not South Morang', 'South Morang Kia Other Location']) assert.equal(matches({ name }, { name: condition }), false);
});
