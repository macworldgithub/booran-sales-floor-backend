const { string } = require('./records');
const { randomUUID } = require('node:crypto');

function serializeVehicle(vehicle, now = new Date()) {
  if (vehicle.status === 'Soft Hold' && vehicle.softHold?.expiresAt && Date.parse(vehicle.softHold.expiresAt) <= now.getTime()) {
    return { ...vehicle, status: 'In Stock', softHold: { ...vehicle.softHold, held: false } };
  }
  return vehicle;
}

async function changeHold(collection, query, body, user, release = false, now = new Date()) {
  const iso = now.toISOString();
  // Match the transition in the write itself so concurrent requests cannot steal a hold.
  const holdId = release ? string(body.holdId, 'Hold ID') : '';
  const heldAt = release && !holdId ? string(body.heldAt, 'Hold timestamp', { required: true }) : '';
  const condition = release
    ? { status: 'Soft Hold', ...(holdId ? { 'softHold.holdId': holdId } : { 'softHold.heldAt': heldAt, 'softHold.holdId': { $exists: false } }) }
    : { $or: [
      { status: 'In Stock', 'softHold.held': { $ne: true } },
      { status: { $in: ['In Stock', 'Soft Hold'] }, 'softHold.expiresAt': { $lte: iso } },
    ] };
  const update = release ? {
    $unset: { softHold: '' }, $set: { status: 'In Stock', updatedAt: now },
  } : {
    $set: {
      status: 'Soft Hold', updatedAt: now,
      softHold: {
        holdId: randomUUID(), held: true, prospectName: string(body.prospectName, 'Customer name', { required: true }),
        notes: string(body.notes, 'Hold notes', { max: 2000 }), consultant: user.name,
        heldAt: iso, expiresAt: new Date(now.getTime() + 48 * 3600 * 1000).toISOString(),
      },
    },
  };
  const result = await collection.findOneAndUpdate({ $and: [query, condition] }, update, { returnDocument: 'after' });
  if (result) return result;
  const exists = await collection.findOne(query);
  throw Object.assign(new Error(exists ? 'Vehicle status changed or this hold is unavailable. Refresh and retry.' : 'Vehicle not found.'), { status: exists ? 409 : 404 });
}
module.exports = { changeHold, serializeVehicle };
