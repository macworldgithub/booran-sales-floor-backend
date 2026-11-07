const express = require('express');
const { ObjectId } = require('mongodb');
const { canAccessSite, isManager } = require('./roles');
const { dealership } = require('./records');
const { list, route, fail } = require('./workflow-route');

const radians = degrees => degrees * Math.PI / 180;
function distanceMetres(first, second) {
  const dlat = radians(second.latitude - first.latitude);
  const dlng = radians(second.longitude - first.longitude);
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(dlng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function coordinates(input) {
  const { latitude, longitude } = input;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) fail(400, 'Provide valid location coordinates.');
  return { latitude, longitude };
}

async function locate(database, site, input) {
  const point = coordinates(input);
  if (!Number.isFinite(input.accuracy) || input.accuracy < 0 || input.accuracy > 100) fail(400, 'A location fix accurate to within 100 metres is required.');
  const fence = await (await database()).collection('site_geofences').findOne({ _id: site.toLowerCase() });
  if (!fence) fail(409, 'A geofence has not been configured for this dealership.');
  const distance = distanceMetres(point, fence);
  return { on_site: distance + input.accuracy <= fence.radius, checkedAt: new Date().toISOString() };
}

function installSitePresence(router, database, storage) {
  router.patch('/site-geofences', route(async (req, res) => {
    const site = dealership(req.body.dealership);
    if (!isManager(req.user) || !canAccessSite(req.user, site)) fail(403, 'You cannot configure this dealership.');
    const point = coordinates(req.body);
    const radius = req.body.radius;
    if (!Number.isInteger(radius) || radius < 25 || radius > 2000) fail(400, 'Choose a radius from 25 to 2000 metres.');
    await (await database()).collection('site_geofences').updateOne({ _id: site.toLowerCase() }, { $set: { ...point, radius } }, { upsert: true });
    res.json({ success: true, data: { ...point, radius } });
  }));
  router.post('/attendance', route(async (req, res) => {
    const site = dealership(req.body.dealership);
    if (!canAccessSite(req.user, site)) fail(403, 'You cannot check in at this dealership.');
    const presence = await locate(database, site, req.body);
    const row = { dealership: site, user_id: req.user.id, name: req.user.name, ...presence };
    await (await database()).collection('attendance').updateOne({ _id: `${req.user.id}:${site.toLowerCase()}` }, { $set: row }, { upsert: true });
    res.json({ success: true, data: row });
  }));
  router.get('/attendance', route(async (req, res) => {
    const query = isManager(req.user) ? {} : { user_id: req.user.id };
    const db = await database(req);
    res.json(await list(db.collection('attendance'), req, { ...query, checkedAt: { $gte: new Date(Date.now() - 15 * 60000).toISOString() } }, 'checkedAt'));
  }));

  router.put('/deliveries/:id/accessories/:accessory/proof', express.raw({ type: ['image/jpeg', 'image/png'], limit: '2mb' }), route(async (req, res) => {
    if (!isManager(req.user) && req.user.role !== 'contractor') fail(403, 'Only coordinators and assigned contractors can complete accessory work.');
    if (!ObjectId.isValid(req.params.id) || !ObjectId.isValid(req.params.accessory)) fail(400, 'Invalid delivery or accessory.');
    const db = await database(req);
    const deliveries = db.collection('deliveries');
    const delivery = await deliveries.findOne({ _id: new ObjectId(req.params.id) });
    const accessory = delivery?.accessories.find(item => item.id === req.params.accessory);
    if (!accessory || (req.user.role === 'contractor' && accessory.contractor_id !== req.user.id)) fail(404, 'Accessory assignment not found.');
    if (accessory.completedAt) return res.json({ success: true, data: { completedAt: accessory.completedAt } });
    if (delivery.status !== 'scheduled') fail(409, 'The delivery is closed.');
    const input = {};
    for (const key of ['latitude', 'longitude', 'accuracy']) input[key] = req.query[key] ? Number(req.query[key]) : NaN;
    const presence = await locate(database, delivery.dealership, input);
    if (!presence.on_site) fail(409, 'Move inside the dealership geofence to complete this work.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'Attach a JPEG or PNG completion photo.');
    const isJpeg = req.is('image/jpeg') && req.body[0] === 0xff && req.body[1] === 0xd8;
    const isPng = req.is('image/png') && req.body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    if (!isJpeg && !isPng) fail(400, 'Attach a valid JPEG or PNG.');
    const id = new ObjectId();
    const proof = {
      _id: id, storage_key: `files/${id}`, staging_key: `staging/${id}`,
      content_type: isJpeg ? 'image/jpeg' : 'image/png', size: req.body.length,
    };
    await storage.prepare(proof);
    await storage.uploadChunk(proof, 0, req.body);
    await storage.complete(proof);
    const match = { id: accessory.id, completedAt: null, contractor_id: accessory.contractor_id };
    const updated = await deliveries.findOneAndUpdate({
      _id: delivery._id, status: 'scheduled', accessories: { $elemMatch: match },
    }, { $set: {
      'accessories.$.completedAt': presence.checkedAt, 'accessories.$.completedBy': req.user.id, 'accessories.$.proof': proof,
    } }, { returnDocument: 'after' });
    if (!updated) fail(409, 'This assignment changed. Reload the delivery.');
    res.json({ success: true, data: { completedAt: presence.checkedAt } });
  }));

  router.get('/deliveries/:id/accessories/:accessory/proof', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Completion photos are available to delivery coordinators.');
    if (!ObjectId.isValid(req.params.id)) fail(404, 'Delivery not found.');
    const db = await database(req);
    const delivery = await db.collection('deliveries').findOne({ _id: new ObjectId(req.params.id) });
    const proof = delivery?.accessories.find(item => item.id === req.params.accessory)?.proof;
    if (!proof) fail(404, 'Completion photo not found.');
    res.type(proof.content_type);
    if (proof.storage_backend === 'mongodb') return res.end(await storage.readRange(proof, 0, proof.size - 1));
    const filename = await storage.download(proof);
    res.sendFile(filename, { cacheControl: false, dotfiles: 'deny' });
  }));
}

module.exports = { installSitePresence, distanceMetres };
