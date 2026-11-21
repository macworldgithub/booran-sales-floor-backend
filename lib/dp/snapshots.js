const { dayKey, shiftDay, key, hash, round, sum, number } = require('./common');
const { fail } = require('../workflow-route');

// A daily observed balance is required for average-inventory turnover. Do not
// backfill earlier dates from today's stock or mistake missing observations for 0.
function inventoryTurn(snapshots, sites, today, sold30) {
  const balances = new Map(snapshots.map(row => [key(row.dealership) + ':' + row.date, number(row.units)]));
  const days = Array.from({ length: 30 }, (_, index) => shiftDay(today, -index));
  const observed = days.filter(date => sites.length && sites.every(site => balances.get(key(site) + ':' + date) != null));
  const average = observed.length === 30 ? sum(observed.map(date => sum(sites.map(site => balances.get(key(site) + ':' + date))))) / 30 : null;
  return { snapshotDays: observed.length, averageInventory: average === null ? null : round(average),
    annualizedTurn: average > 0 ? round(sold30 / average * 365 / 30) : null };
}

async function captureInventorySnapshot(crm, inventory, now = new Date()) {
  const read = async (db, name, query, projection) => {
    const rows = await db.collection(name).find(query, { projection }).limit(50001).toArray();
    if (rows.length > 50000) fail(413, 'Inventory snapshot exceeds the supported stock limit.');
    return rows;
  };
  const [vehicles, completed, rooftops] = await Promise.all([
    read(inventory, 'vehicles', { salesFloorHidden: { $ne: true } }, { _id: 1, rooftopName: 1, status: 1 }),
    read(crm, 'deals', { status: 'completed' }, { stock_key: 1 }),
    read(inventory, 'rooftops', {}, { name: 1 }),
  ]);
  const sold = new Set(completed.filter(row => row.stock_key != null).map(row => String(row.stock_key)));
  const counts = new Map(rooftops.filter(row => row.name && !require('../query').isAllLocations(row.name) && !Object.hasOwn(require('../query').LOCATION_GROUPS, key(row.name))).map(row => [key(row.name), { name: row.name, units: 0 }]));
  for (const vehicle of vehicles) {
    if (!vehicle.rooftopName) continue;
    const id = key(vehicle.rooftopName), site = counts.get(id) || { name: vehicle.rooftopName, units: 0 };
    if (!['sold', 'wholesale'].includes(key(vehicle.status)) && !sold.has(String(vehicle._id))) site.units++;
    counts.set(id, site);
  }
  const date = dayKey(now);
  if (counts.size) await crm.collection('dp_inventory_snapshots').bulkWrite([...counts].map(([id, site]) => ({ updateOne: {
    filter: { _id: hash(id + ':' + date) }, update: { $set: { dealership: site.name, date, units: site.units, observedAt: now.toISOString() } }, upsert: true,
  } })), { ordered: true });
  return { date, sites: counts.size };
}
module.exports = { inventoryTurn, captureInventorySnapshot };
