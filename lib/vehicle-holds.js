const { string } = require('./records');
const { canViewCost, isManager } = require('./roles');

function serializeVehicle(vehicle, now = new Date()) {
  if (['Sold', 'SOLD'].includes(vehicle.status)) return { ...vehicle, status: 'Sold' };
  if (vehicle.dealPending || ['DEAL PENDING', 'DEAL-PENDING', 'PENDING'].includes(vehicle.status)) return { ...vehicle, status: 'Deal Pending' };
  if (vehicle.status === 'Soft Hold' && vehicle.softHold?.expiresAt && Date.parse(vehicle.softHold.expiresAt) <= now.getTime()) {
    return { ...vehicle, status: 'In Stock', softHold: { ...vehicle.softHold, held: false } };
  }
  return vehicle;
}

function visibleVehicle(vehicle, user, dealStatus) {
  const row = { ...serializeVehicle(vehicle) };
  if (dealStatus === 'completed') row.status = 'Sold';
  if (dealStatus === 'registered' && ['In Stock', 'IN-STOCK'].includes(row.status)) row.status = 'Deal Pending';
  if (!isManager(user)) delete row.softHold;
  if (canViewCost(user)) return row;
  const {
    vehicleCost, totalStockCost, potentialGross, accumulatedHoldingCost, holdingCostPerDay,
    actionReason, recommendedAction, ...visible
  } = row;
  return visible;
}

function visibleAction(item, user) {
  return canViewCost(user) ? item : { ...item, reason: 'Inventory review', impactMetric: '', resolvedNotes: undefined };
}

async function releaseHold(collection, query, body, now = new Date()) {
  // Match the transition in the write itself so concurrent requests cannot steal a hold.
  const holdId = string(body.holdId, 'Hold ID');
  const heldAt = !holdId ? string(body.heldAt, 'Hold timestamp', { required: true }) : '';
  const condition = { status: 'Soft Hold', ...(holdId ? { 'softHold.holdId': holdId } : { 'softHold.heldAt': heldAt, 'softHold.holdId': { $exists: false } }) };
  const update = {
    $unset: { softHold: '' }, $set: { status: 'In Stock', updatedAt: now },
  };
  const result = await collection.findOneAndUpdate({ $and: [query, condition] }, update, { returnDocument: 'after' });
  if (result) return result;
  const exists = await collection.findOne(query);
  throw Object.assign(new Error(exists ? 'Vehicle status changed or this hold is unavailable. Refresh and retry.' : 'Vehicle not found.'), { status: exists ? 409 : 404 });
}
module.exports = { releaseHold, serializeVehicle, visibleVehicle, visibleAction };
