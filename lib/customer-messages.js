const { ObjectId } = require('mongodb');
const { randomBytes, createHash } = require('node:crypto');
const { invalid } = require('./records');
const { validateSmsLength } = require('./mobilemessage');
const express = require('express');
const { collectHistory, refreshReceipts } = require('./message-history');
const { mediaViewer } = require('./media-viewer');
const { syncInbound } = require('./inbound-messages');

const leadQuery = (id) => ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { deal_id: id };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const wrap = (handler) => async (req, res) => {
  try { await handler(req, res); }
  catch (error) {
    if (res.headersSent) return res.destroy();
    const status = [400, 403, 404, 409, 415, 416, 503].includes(error.status) ? error.status : 503;
    res.status(status).json({ success: false, error: status === 503 && error.status !== 503 ? 'The messaging service is temporarily unavailable. Please retry.' : error.message });
  }
};
function shareUrl(media) {
  const fallback = process.env.VERCEL ? 'https://booran-sales-floor-backend.vercel.app' : `http://localhost:${process.env.PORT || 5001}`;
  let base = (process.env.BACKEND_PUBLIC_URL || fallback).replace(/\/$/, '').replace(/\/api$/, '');
  if (process.env.VERCEL && ['localhost', '127.0.0.1', '::1'].includes(new URL(base).hostname)) base = fallback;
  return `${base}/api/media/${media.share_token}`;
}
const publicMedia = (row) => ({ id: String(row._id), name: row.name, content_type: row.content_type, size: row.size, url: shareUrl(row), created_at: row.created_at });
const publicMessage = (row) => ({ id: row.id || String(row._id), body: row.body, phone: row.phone, author: row.author, created_at: row.created_at, status: row.status, error: row.error, direction: row.direction || 'outbound', source: row.source || 'Sales Floor', dealership: row.dealership_name, attachments: row.attachments || [] });

function installPublicMedia(router, database, storage) {
  router.get('/media/:token/content', wrap(async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) return res.status(404).send('Media not found.');
    const media = await (await database()).collection('message_media').findOne({ share_token: req.params.token, status: 'ready', storage_backend: 'mongodb' });
    if (!media) return res.status(404).send('Media not found.');
    const ranges = req.range(media.size);
    if (ranges === -1 || ranges === -2 || (Array.isArray(ranges) && ranges.length !== 1)) { res.set('Content-Range', `bytes */${media.size}`); return res.status(416).end(); }
    const start = Array.isArray(ranges) ? ranges[0].start : 0;
    const end = Math.min(Array.isArray(ranges) ? ranges[0].end : media.size - 1, start + 2 * 1024 * 1024 - 1);
    res.set({ 'Content-Type': media.content_type, 'Accept-Ranges': 'bytes', 'Referrer-Policy': 'no-referrer', 'Content-Length': String(end - start + 1) });
    if (req.headers.range || start > 0 || end < media.size - 1) { res.status(206); res.set('Content-Range', `bytes ${start}-${end}/${media.size}`); }
    if (req.method === 'HEAD') return res.end();
    res.end(await storage.readRange(media, start, end));
  }));
  router.get('/media/:token', wrap(async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.token)) return res.status(404).send('Media not found.');
    const db = await database();
    const media = await db.collection('message_media').findOne({ share_token: req.params.token, status: 'ready' });
    if (!media) return res.status(404).send('Media not found.');
    res.set('Referrer-Policy', 'no-referrer');
    if (media.storage_backend === 'mongodb') {
      const viewer = mediaViewer(media);
      res.set('Content-Security-Policy', viewer.policy);
      return res.type('html').send(viewer.html);
    }
    const filename = await storage.download(media);
    res.set('Content-Type', media.content_type);
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`);
    await new Promise((resolve, reject) => res.sendFile(filename, { cacheControl: false, dotfiles: 'deny' }, (error) => error ? reject(error) : resolve()));
  }));
}

function installCustomerMessages(router, database, sms, storage) {
  const customer = async (req) => {
    const db = await database(req);
    const lead = await db.collection('leads').findOne(leadQuery(req.params.id));
    if (!lead) fail(404, 'Customer not found.');
    return { db, lead, lead_id: String(lead._id) };
  };
  router.get('/leads/:id/messages', wrap(async (req, res) => {
    const { db, lead } = await customer(req);
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
    const inboundUnavailable = await syncInbound({ db, lead, sms });
    const history = await collectHistory({ db, lead });
    if (inboundUnavailable) history.warnings.push('Incoming messages could not be fully refreshed. Showing saved history; retry refresh shortly.');
    const total = history.rows.length;
    const totalPages = Math.ceil(total / 20);
    const actualPage = Math.min(page, Math.max(1, totalPages));
    const rows = history.rows.slice((actualPage - 1) * 20, actualPage * 20);
    if (await refreshReceipts(rows, sms)) history.warnings.push('Delivery status could not be refreshed. Showing the last known status.');
    res.json({ success: true, data: { messages: rows.map(publicMessage), history_warning: history.warnings.join(' ') || undefined, sms_available: sms.configured(), media_available: storage.configured(), media_unavailable_reason: storage.configured() ? undefined : storage.unavailable }, pagination: { page: actualPage, limit: 20, total, totalPages } });
  }));
  router.get('/leads/:id/media', wrap(async (req, res) => {
    const { db, lead_id } = await customer(req);
    const rows = await db.collection('message_media').find({ lead_id, status: 'ready' }).sort({ created_at: -1, _id: -1 }).limit(50).toArray();
    res.json({ success: true, data: rows.map(publicMedia) });
  }));
  router.post('/leads/:id/media', wrap(async (req, res) => {
    const { db, lead, lead_id } = await customer(req);
    const fields = storage.validateMedia(req.body);
    const id = new ObjectId();
    const row = { _id: id, ...fields, lead_id, dealership_name: lead.dealership_name, author: req.user.name, status: 'uploading', share_token: randomBytes(32).toString('hex'), staging_key: `staging/${id}`, storage_key: `files/${id}`, created_at: new Date().toISOString() };
    const upload = await storage.prepare(row);
    await db.collection('message_media').insertOne(row);
    res.status(201).json({ success: true, data: { id: String(id), upload } });
  }));
  router.put('/leads/:id/media/:mediaId/content', express.raw({ type: 'application/octet-stream', limit: '2mb' }), wrap(async (req, res) => {
    const { db, lead_id } = await customer(req);
    if (!req.is('application/octet-stream')) fail(415, 'Upload file bytes as application/octet-stream.');
    if (!ObjectId.isValid(req.params.mediaId)) invalid('Invalid media ID.');
    if (!/^\d+$/.test(req.query.offset || '')) invalid('A valid upload offset is required.');
    const media = await db.collection('message_media').findOne({ _id: new ObjectId(req.params.mediaId), lead_id, status: 'uploading' });
    if (!media) fail(404, 'Photo/video upload not found.');
    const next_offset = await storage.uploadChunk(media, Number(req.query.offset), req.body);
    res.json({ success: true, data: { next_offset } });
  }));
  router.post('/leads/:id/media/:mediaId/complete', wrap(async (req, res) => {
    const { db, lead_id } = await customer(req);
    if (!ObjectId.isValid(req.params.mediaId)) invalid('Invalid media ID.');
    const media = await db.collection('message_media').findOne({ _id: new ObjectId(req.params.mediaId), lead_id });
    if (!media) fail(404, 'Photo/video not found.');
    if (media.status !== 'ready') {
      await storage.complete(media);
      await db.collection('message_media').findOneAndUpdate({ _id: media._id, lead_id }, { $set: { status: 'ready' } });
    }
    res.json({ success: true, data: publicMedia(media) });
  }));
  router.post('/leads/:id/messages', wrap(async (req, res) => {
    const { db, lead, lead_id } = await customer(req);
    if (typeof req.body.body !== 'string' || req.body.body.length > 1530) invalid('Enter a message up to 1530 characters.');
    const body = req.body.body.trim();
    const requestId = req.body.request_id;
    if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) invalid('A message request ID is required.');
    const ids = req.body.media_ids ?? [];
    if (!Array.isArray(ids) || ids.length > 5 || ids.some((id) => typeof id !== 'string' || !ObjectId.isValid(id)) || new Set(ids).size !== ids.length) invalid('Attach up to five uploaded photos or videos.');
    if (!body && !ids.length) invalid('Enter a message or attach a photo/video.');
    const _id = createHash('sha256').update(`${lead_id}:${requestId}`).digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify([body, ids])).digest('hex');
    const existing = await db.collection('customer_messages').findOne({ _id, lead_id });
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different message.');
      return res.json({ success: true, data: publicMessage(existing) });
    }
    const attachments = [];
    for (const id of ids) {
      const media = await db.collection('message_media').findOne({ _id: new ObjectId(id), lead_id, status: 'ready' });
      if (!media) invalid('An attachment is unavailable or belongs to another customer.');
      attachments.push(publicMedia(media));
    }
    const fullBody = [body, ...attachments.map((media) => media.url)].filter(Boolean).join('\n');
    if (fullBody.length > 1530) invalid('The message including photo/video links must be no more than 1530 characters.');
    validateSmsLength(fullBody);
    const phone = sms.normalisePhone(lead.customer_phone);
    const row = { _id, lead_id, dealership_name: lead.dealership_name, body: fullBody, attachments, phone, author: req.user.name, user_id: req.user.id, created_at: new Date().toISOString(), status: 'pending', fingerprint, provider: 'mobilemessage' };
    try { await db.collection('customer_messages').insertOne(row); }
    catch (error) {
      if (error.code !== 11000) throw error;
      const duplicate = await db.collection('customer_messages').findOne({ _id, lead_id });
      if (duplicate.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different message.');
      return res.json({ success: true, data: publicMessage(duplicate) });
    }
    const result = await sms.sendSms({ phone, body: fullBody, requestId: _id });
    const updated = await db.collection('customer_messages').findOneAndUpdate({ _id, lead_id }, { $set: result }, { returnDocument: 'after' });
    // The durable message is the audit record even if a later diary update fails.
    await db.collection('leads').findOneAndUpdate({ _id: lead._id }, { $push: { diary_entries: { author: req.user.name, date: row.created_at, note: `SMS ${result.status} to ${phone}: ${fullBody}` } }, $set: { updatedAt: new Date() } }).catch(() => {});
    res.status(201).json({ success: true, data: publicMessage(updated) });
  }));
}
module.exports = { installPublicMedia, installCustomerMessages };
