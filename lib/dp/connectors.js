const { string } = require('../records');
const { fail } = require('../workflow-route');
const { key, hash, number, dayKey } = require('./common');
const { finite } = require('./validation');
function validateSales(records, allowedSites) {
  if (!Array.isArray(records) || records.length > 1000) fail(400, 'Import a batch of at most 1000 sales.');
  const sites = new Map(allowedSites.map(site => [key(site), site]));
  const result = records.map(input => {
    if (!input || Array.isArray(input) || typeof input !== 'object') fail(400, 'Each sale must be an object.');
    const dealership = sites.get(key(input.site || input.dealership)); if (!dealership) fail(403, 'A sale references an unauthorised dealership.');
    const externalId = string(input.externalId, 'DMS sale reference', { required: true, max: 120 });
    if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(input.date) || !Number.isFinite(Date.parse(input.date)) || dayKey(input.date) > dayKey()) fail(400, 'Provide an ISO sale timestamp no later than today.');
    if (input.status && !['completed', 'cancelled'].includes(input.status)) fail(400, 'DMS sale status must be completed or cancelled.');
    const row = { _id: hash(dealership + ':' + externalId), dealership, externalId, date: new Date(input.date).toISOString(), status: input.status || 'completed',
      units: input.units === undefined ? 1 : finite(input.units, 'units', 1, 1000) };
    if (!Number.isSafeInteger(row.units)) fail(400, 'Sale units must be whole numbers.');
    for (const field of ['leadId', 'ownerId', 'ownerName', 'stockNumber', 'vin', 'make', 'model', 'category']) row[field] = string(input[field], field, { max: 150 });
    row.grossCents = input.grossCents == null ? null : finite(input.grossCents, 'gross cents', -1000000000000);
    row.revenueCents = input.revenueCents == null ? null : finite(input.revenueCents, 'revenue cents');
    for (const field of ['grossCents', 'revenueCents']) if (row[field] !== null && !Number.isSafeInteger(row[field])) fail(400, 'Financial amounts must be integer cents.');
    return row;
  });
  if (new Set(result.map(row => row._id)).size !== result.length) fail(400, 'The same sale appears more than once in this batch.');
  return result;
}
async function importSales(db, records, allowedSites, userId) {
  const rows = validateSales(records, allowedSites), now = new Date().toISOString();
  if (rows.length) await db.collection('dp_sales_events').bulkWrite(rows.map(({ _id, ...row }) => ({ updateOne: { filter: { _id }, update: {
    $set: { ...row, updatedAt: now, updated_by: userId }, $setOnInsert: { createdAt: now },
  }, upsert: true } })), { ordered: true });
  return { processed: rows.length, at: now };
}
async function pullSales(db, allowedSites, userId, env = process.env, fetcher = fetch) {
  if (!env.DP_DMS_FEED_URL || !env.DP_DMS_FEED_TOKEN) fail(503, 'The optional DMS feed is not configured. Sales Floor data is already available.');
  let endpoint; try { endpoint = new URL(env.DP_DMS_FEED_URL); } catch { fail(503, 'The DMS endpoint is invalid.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) fail(503, 'The DMS endpoint must use HTTPS without credentials in its URL.');
  const records = [], cursors = new Set(); let cursor = '';
  // Validate the entire bounded export before writing any records. Redirects
  // cannot forward the server-owned token to a different destination.
  for (let page = 0; ; page++) {
    if (page >= 100) fail(413, 'The DMS export exceeds 100 pages.');
    const url = new URL(endpoint); url.searchParams.set('sites', allowedSites.join(',')); url.searchParams.set('limit', '500'); if (cursor) url.searchParams.set('cursor', cursor);
    let payload;
    try {
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${env.DP_DMS_FEED_TOKEN}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error('Source rejected the request');
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw Error('Source page too large'); } chunks.push(Buffer.from(next.value)); }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { fail(503, 'The DMS feed could not be read. Existing sales data has been preserved.'); }
    records.push(...validateSales(payload.records, allowedSites));
    if (records.length > 50000) fail(413, 'The DMS export exceeds 50000 sales.');
    cursor = payload.nextCursor || ''; if (!cursor) break;
    if (typeof cursor !== 'string' || cursor.length > 1000 || cursors.has(cursor)) fail(503, 'The DMS source returned an invalid continuation.'); cursors.add(cursor);
  }
  if (new Set(records.map(row => row._id)).size !== records.length) fail(503, 'The DMS export repeated sale references.');
  const now = new Date().toISOString();
  for (let index = 0; index < records.length; index += 500) await db.collection('dp_sales_events').bulkWrite(records.slice(index, index + 500).map(({ _id, ...row }) => ({ updateOne: {
    filter: { _id }, update: { $set: { ...row, updatedAt: now, updated_by: userId }, $setOnInsert: { createdAt: now } }, upsert: true,
  } })), { ordered: true });
  return { processed: records.length, at: now };
}
module.exports = { validateSales, importSales, pullSales };
