const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { ObjectId } = require('mongodb');
const express = require('express');
const { string, dealership, createLead } = require('./records');
const { isManager, canAccessSite } = require('./roles');
const { route, fail, list } = require('./workflow-route');
const { createUniqueLead, duplicateError } = require('./lead-identity');
const { normalisePhone } = require('./phone');

const DAY = 86400000;
const TYPES = ['car', 'caravan', 'trailer', 'boat', 'jet_ski', 'motorcycle', 'other'];
const SECTIONS = ['front', 'right', 'rear', 'left', 'interior'];
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const settingsId = site => `trade-in:settings:${site.toLowerCase()}`;
const defaults = { enabled: false, postSale: true, lostLead: true, service: true, channels: ['sms'] };
const optedOut = lead => lead.booran_opted_out === true || lead.communication_consent?.opted_out === true;
const date = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(400, `${label} must include a valid date, time and timezone.`);
  return new Date(value).toISOString();
};
const id = value => { if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail(400, 'Invalid customer ID.'); return new ObjectId(value); };
function dayKey(now, offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day + offset)).toISOString().slice(0, 10);
}
function configured(env = process.env) {
  if ((env.TRADE_IN_TOKEN_SECRET || '').length < 32) return false;
  try { const url = new URL(env.TRADE_IN_PUBLIC_URL); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
function tokenFor(row, env = process.env) {
  if (!configured(env)) fail(503, 'Configure the trade-in public URL and signing secret before enabling invitations.');
  const payload = `${row._id}.${Date.parse(row.expires_at)}`;
  return `${payload}.${createHmac('sha256', env.TRADE_IN_TOKEN_SECRET).update(payload).digest('base64url')}`;
}
function verifyToken(token, env = process.env, now = new Date()) {
  if (!configured(env) || typeof token !== 'string' || token.length > 200) fail(404, 'This invitation is unavailable.');
  const match = /^([a-f0-9]{64})\.(\d{13})\.([\w-]{43})$/.exec(token);
  if (!match) fail(404, 'This invitation is unavailable.');
  const expected = tokenFor({ _id: match[1], expires_at: new Date(+match[2]).toISOString() }, env).split('.').at(-1);
  if (!timingSafeEqual(Buffer.from(match[3]), Buffer.from(expected))) fail(404, 'This invitation is unavailable.');
  if (+match[2] <= +now) fail(410, 'This invitation has expired. Please contact the dealership.');
  return match[1];
}
function invitationText(lead, kind, url) {
  const first = String(lead.customer_name || '').trim().split(/\s+/)[0] || 'there';
  const opening = kind === 'post_sale' ? `Hi ${first}, congratulations on your new ${[lead.vehicle_make, lead.vehicle_model].filter(Boolean).join(' ') || 'vehicle'}! You didn't trade a vehicle with us.`
    : kind === 'service' ? `Hi ${first}, ahead of your upcoming service booking, we'd be happy to value any vehicle you're thinking of selling.`
      : `Hi ${first}, even though we couldn't help with your purchase this time, we'd still be happy to buy a vehicle you have.`;
    return `${opening} Cars, caravans, trailers, boats and jet skis are all welcome. A few photos are all we need to get started: ${url}\nFrom ${lead.dealership_name}. You can also use this link to opt out.`;
}
function deliveryState(status) {
  return ['queued', 'accepted', 'scheduled', 'sent', 'delivered', 'success'].includes(status) ? 'sent' : status;
}

function eligible(lead, kind, source) {
  if (!lead || lead.merged_into || optedOut(lead)) return false;
  if (kind === 'post_sale') return source?.status === 'completed' && !source.appraisal_id &&
    (source.trade_in_status === 'none' || source.trade_in_status === undefined && !lead.trade_in && !lead.tradeIn);
  if (kind === 'lost_lead') return lead.status === 'lost';
  return source?.status === 'booked';
}
const indexPromises = new WeakMap();
async function ensureIndexes(db) {
  if (!indexPromises.has(db)) indexPromises.set(db, (async () => {
    for (const [name, keys] of [['trade_in_opportunities', { dealership: 1, createdAt: -1 }], ['trade_in_opportunities', { status: 1, createdAt: 1 }], ['service_bookings', { dealership: 1, status: 1, starts_at: 1 }]]) {
      const collection = db.collection(name);
      if (collection.createIndex) await collection.createIndex(keys);
      else if (collection.createIndexes) await collection.createIndexes([{ name: name + '_' + Object.keys(keys).join('_'), key: keys }]);
    }
  })().catch(error => { indexPromises.delete(db); throw error; }));
  return indexPromises.get(db);
}

async function bookService(db, input, actor, now = new Date()) {
  const site = dealership(input.dealership);
  if (!canAccessSite(actor, site)) fail(403, 'You cannot import bookings for this dealership.');
  const reference = string(input.reference, 'Booking reference', { required: true, max: 120 });
  const starts_at = date(input.startsAt, 'Service booking');
  if (input.status !== undefined && !['booked', 'cancelled', 'completed'].includes(input.status)) fail(400, 'Invalid booking status.');
  const _id = hash(`service:${site.toLowerCase()}:${reference}`);
  const previous = await db.collection('service_bookings').findOne({ _id });
  if (previous && input.leadId && input.leadId !== previous.lead_id) fail(409, 'This booking reference belongs to another customer.');
  let lead;
  if (input.leadId || previous) lead = await db.collection('leads').findOne({ _id: id(input.leadId || previous.lead_id), dealership_name: site, merged_into: { $exists: false } });
  else {
    if (!string(input.phone, 'Customer mobile') && !string(input.email, 'Customer email')) fail(400, 'A service customer needs a mobile number or email.');
    const record = createLead({ name: input.customerName, phone: input.phone, email: input.email, dealership: site, source: 'Service booking', make: input.make, model: input.model }, actor);
    record.owner_id = null; record.owner_name = 'Unassigned';
    const result = await createUniqueLead(db, record, actor, true);
    if (!result.lead) duplicateError(result);
    lead = result.lead;
  }
  if (!lead) fail(404, 'Service customer not found at this dealership.');
  const row = { dealership: site, lead_id: String(lead._id), owner_id: lead.owner_id || null, reference,
    starts_at, vehicle: string(input.vehicle, 'Service vehicle', { max: 200 }) || previous?.vehicle || [lead.vehicle_make, lead.vehicle_model].filter(Boolean).join(' '),
    status: input.status || 'booked', observed_at: now.toISOString(), updatedAt: now.toISOString() };
  await ensureIndexes(db);
  await db.collection('service_bookings').findOneAndUpdate({ _id }, { $set: row, $setOnInsert: { createdAt: now.toISOString() } }, { upsert: true });
  return { _id, ...row };
}

function createTradeInService(database, { sms = require('./mobilemessage'), email = sendEmail, env = process.env, clock = () => new Date() } = {}) {
  let running = false;
  async function invite(db, lead, kind, source, settings, eventAt, now) {
    if (!eligible(lead, kind, source)) return;
    const _id = hash(`${kind}:${source._id}:${kind === 'lost_lead' ? source.loss_review?.id || eventAt : kind === 'service' ? source.starts_at : ''}`);
    const row = { _id, kind, source_id: String(source._id), event_at: eventAt, dealership: lead.dealership_name,
      lead_id: String(lead._id), owner_id: lead.owner_id || null, customer: lead.customer_name, phone: lead.customer_phone || '', email: lead.customer_email || '',
      status: 'open', channels: Object.fromEntries(settings.channels.map(channel => [channel, 'queued'])), createdAt: now.toISOString(),
      expires_at: new Date(+now + 14 * DAY).toISOString(), photo_count: 0 };
    const { _id: opportunityId, ...insert } = row;
    await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: opportunityId }, { $setOnInsert: insert }, { upsert: true });
    if (kind === 'service') await db.collection('sales_alerts').findOneAndUpdate({ _id: `trade-in:${_id}` }, { $setOnInsert: {
      dealership: row.dealership, owner_id: null, lead_id: row.lead_id, kind: 'service_trade_opportunity',
      title: `${lead.customer_name || 'Customer'} has a service booking in 3 days on ${source.vehicle || 'their vehicle'}. Potential upgrade / trade opportunity.`,
      createdAt: now.toISOString(), manager_only: true,
    } }, { upsert: true });
  }
  async function sourceFor(db, row) {
    if (row.kind === 'lost_lead') return null;
    return db.collection(row.kind === 'service' ? 'service_bookings' : 'deals').findOne({ _id: row.kind === 'service' ? row.source_id : id(row.source_id) });
  }
  async function finishSubmission(db, row) {
    const data = row.submission_snapshot;
    if (!data) return;
    const appraisalId = new ObjectId(hash(`appraisal:${row._id}`).slice(0, 24));
    await db.collection('appraisals').findOneAndUpdate({ _id: appraisalId }, { $setOnInsert: {
      ...data, lead_id: row.lead_id, dealership: row.dealership, owner_id: row.owner_id,
      source: 'trade_in_follow_up', opportunity_id: row._id, status: 'completed', workflow_status: 'ready',
      revision: 0, offers: [], offer_requests: [], createdAt: data.submitted_at, created_by: 'customer',
    } }, { upsert: true });
    await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, status: 'submitting' }, {
      $set: { status: 'submitted', appraisal_id: String(appraisalId), submitted_at: data.submitted_at },
    });
    return String(appraisalId);
  }
  async function sweep() {
    if (running) return { busy: true };
    running = true;
    try {
      const db = await database(), now = clock();
      await ensureIndexes(db);
      const repairs = await db.collection('trade_in_opportunities').find({ status: 'submitting' }).limit(50).toArray();
      for (const row of repairs) await finishSubmission(db, row);
      // Never automatically replay a provider attempt interrupted by a restart.
      const expired = await db.collection('trade_in_opportunities').find({ status: 'open', sending_started_at: { $lte: new Date(+now - 300000).toISOString() } }).limit(100).toArray();
      for (const row of expired) for (const channel of ['sms', 'email']) if (row.channels?.[channel] === 'sending') {
        await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, [`channels.${channel}`]: 'sending' }, { $set: { [`channels.${channel}`]: 'unknown' } });
        if (channel === 'sms') await db.collection('customer_messages').findOneAndUpdate({ _id: hash('trade-in:' + row._id), status: 'pending' }, { $set: { status: 'unknown', error: 'The provider attempt was interrupted. Check the provider before sending again.' } });
      }
      const settings = await db.collection('integration_sync').find({ kind: 'trade_in_settings', 'settings.enabled': true }).limit(100).toArray();
      for (const config of settings) {
        const settings = config.settings, site = config.dealership, since = config.enabled_at;
        if (!since || !configured(env)) continue;
        if (settings.postSale) {
          const deals = await db.collection('deals').find({ dealership: site, status: 'completed', $or: [{ trade_in_status: 'none' }, { trade_in_status: { $exists: false } }], trade_in_checked: { $ne: true }, completed_at: { $gte: since } }).sort({ completed_at: 1 }).limit(500).toArray();
          for (const source of deals) {
            await invite(db, await db.collection('leads').findOne({ _id: id(source.lead_id), dealership_name: site }), 'post_sale', source, settings, source.completed_at, now);
            await db.collection('deals').findOneAndUpdate({ _id: source._id }, { $set: { trade_in_checked: true } });
          }
        }
        if (settings.lostLead) {
          const leads = await db.collection('leads').find({ dealership_name: site, status: 'lost', trade_in_loss_checked: { $ne: true }, 'loss_review.reviewed_at': { $gte: since } }).sort({ 'loss_review.reviewed_at': 1 }).limit(500).toArray();
          for (const lead of leads) {
            await invite(db, lead, 'lost_lead', lead, settings, lead.loss_review.reviewed_at, now);
            await db.collection('leads').findOneAndUpdate({ _id: lead._id, 'loss_review.id': lead.loss_review.id }, { $set: { trade_in_loss_checked: true } });
          }
        }
        if (settings.service) {
          const bookings = await db.collection('service_bookings').find({ dealership: site, status: 'booked', starts_at: { $gte: new Date(+now + DAY).toISOString(), $lt: new Date(+now + 5 * DAY).toISOString() }, observed_at: { $gte: new Date(+now - 7 * DAY).toISOString() } }).sort({ starts_at: 1 }).limit(1000).toArray();
          for (const booking of bookings.filter(row => dayKey(new Date(row.starts_at)) === dayKey(now, 3)))
            await invite(db, await db.collection('leads').findOne({ _id: id(booking.lead_id), dealership_name: site }), 'service', booking, settings, booking.starts_at, now);
        }
      }
      const pending = await db.collection('trade_in_opportunities').find({ status: 'open', expires_at: { $gt: now.toISOString() }, $or: [{ 'channels.sms': 'queued' }, { 'channels.email': 'queued' }] }).sort({ createdAt: 1 }).limit(100).toArray();
      for (const row of pending) {
        const lead = await db.collection('leads').findOne({ _id: id(row.lead_id), dealership_name: row.dealership });
        const config = await db.collection('integration_sync').findOne({ _id: settingsId(row.dealership) });
        const source = await sourceFor(db, row);
        const setting = config?.settings;
        const validSource = eligible(lead, row.kind, source) && (row.kind !== 'service' || source.starts_at === row.event_at && source.observed_at >= new Date(+now - 7 * DAY).toISOString() && dayKey(new Date(source.starts_at)) === dayKey(now, 3));
        const trigger = { post_sale: 'postSale', lost_lead: 'lostLead', service: 'service' }[row.kind];
        if (!setting?.enabled || !setting[trigger] || !validSource) {
          for (const channel of ['sms', 'email']) await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, [`channels.${channel}`]: 'queued' }, { $set: { [`channels.${channel}`]: 'cancelled' } });
          continue;
        }
        const url = `${env.TRADE_IN_PUBLIC_URL.replace(/\/$/, '')}/trade-in/${tokenFor(row, env)}`;
        const messageLead = row.kind === 'post_sale' ? { ...lead, vehicle_make: source.make || lead.vehicle_make, vehicle_model: source.model || lead.vehicle_model } : lead;
        const body = invitationText(messageLead, row.kind, url);
        for (const channel of ['sms', 'email']) {
          if (row.channels?.[channel] !== 'queued' || !setting.channels.includes(channel)) continue;
          if (env.TRADE_IN_SEND_ENABLED !== 'true') continue;
          if (channel === 'sms' && !sms.configured(row.dealership) || channel === 'email' && email === sendEmail && !smtpSettings(env).auth.pass) continue;
          const currentLead = await db.collection('leads').findOne({ _id: id(row.lead_id), dealership_name: row.dealership });
          if (!currentLead || optedOut(currentLead)) continue;
          const allowed = await db.collection('leads').findOneAndUpdate({ _id: currentLead._id, booran_opted_out: { $ne: true }, 'communication_consent.opted_out': { $ne: true },
            $or: [{ trade_in_contact_opportunity: row._id }, { trade_in_last_contact_at: { $exists: false } }, { trade_in_last_contact_at: { $lte: new Date(+now - 30 * DAY).toISOString() } }] },
          { $set: { trade_in_last_contact_at: now.toISOString(), trade_in_contact_opportunity: row._id } }, { returnDocument: 'after' });
          if (!allowed) { await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, [`channels.${channel}`]: 'queued' }, { $set: { [`channels.${channel}`]: 'suppressed' } }); continue; }
          if (channel === 'sms' && !currentLead.customer_phone || channel === 'email' && !currentLead.customer_email) {
            await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id }, { $set: { [`channels.${channel}`]: 'unavailable' } }); continue;
          }
          const claim = await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, status: 'open', [`channels.${channel}`]: 'queued' }, {
            $set: { [`channels.${channel}`]: 'sending', sending_started_at: now.toISOString() },
          }, { returnDocument: 'after' });
          if (!claim) continue;
          try {
            let result;
            if (channel === 'sms') {
              const messageId = hash('trade-in:' + row._id);
              await db.collection('customer_messages').findOneAndUpdate({ _id: messageId }, { $setOnInsert: { _id: messageId,
                lead_id: row.lead_id, dealership_name: row.dealership, phone: normalisePhone(currentLead.customer_phone), body, attachments: [],
                author: 'Trade-in follow-up', user_id: 'trade-in-automation', created_at: now.toISOString(), status: 'pending', provider: 'mobilemessage' } }, { upsert: true });
              result = await sms.sendSms({ phone: normalisePhone(currentLead.customer_phone), body, requestId: messageId, dealership: row.dealership });
              await db.collection('customer_messages').findOneAndUpdate({ _id: messageId }, { $set: result });
            } else { await email({ to: currentLead.customer_email, subject: `A vehicle offer from ${row.dealership}`, text: body }, env); result = { status: 'sent' }; }
            await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, [`channels.${channel}`]: 'sending' }, { $set: { [`channels.${channel}`]: deliveryState(result.status), updatedAt: now.toISOString() } });
          } catch {
            await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, [`channels.${channel}`]: 'sending' }, { $set: { [`channels.${channel}`]: 'unknown' } });
            if (channel === 'sms') await db.collection('customer_messages').findOneAndUpdate({ _id: hash('trade-in:' + row._id), status: 'pending' }, { $set: { status: 'unknown', error: 'Acceptance could not be confirmed. Check the provider before sending again.' } });
          }
        }
      }
      return { processed: pending.length };
    } finally { running = false; }
  }
  return { sweep, finishSubmission };
}
function smtpSettings(env) {
  return { host: env.TRADE_IN_SMTP_HOST || 'smtp.hostinger.com', port: 465, secure: true,
    auth: { user: env.TRADE_IN_SMTP_USER, pass: env.TRADE_IN_SMTP_PASSWORD }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 };
}
async function sendEmail(message, env) {
  const config = smtpSettings(env);
  if (!config.auth.user || !config.auth.pass) throw new Error('Trade-in email is not configured.');
  const transport = require('nodemailer').createTransport(config);
  try { await transport.sendMail({ ...message, from: config.auth.user }); } finally { transport.close(); }
}
function installTradeInManagement(router, database, engine, env = process.env) {
  const manager = req => { if (!isManager(req.user)) fail(403, 'Sales manager access is required.'); };
  router.get('/trade-in/loss-followups', route(async (req, res) => {
    manager(req);
    const result = await list((await database(req)).collection('leads'), req, { status: 'lost', merged_into: { $exists: false } }, 'updatedAt');
    result.data = result.data.map(lead => ({ _id: String(lead._id), customer: lead.customer_name, phone: lead.customer_phone,
      dealership: lead.dealership_name, reason: lead.loss_review?.reason || '', follow_up: lead.trade_in_manager_followup || null }));
    res.json(result);
  }));
  router.post('/trade-in/loss-followups/:id', route(async (req, res) => {
    manager(req); const db = await database(req);
    if (typeof req.body.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(req.body.requestId)) fail(400, 'A call request ID is required.');
    const lead = await db.collection('leads').findOne({ _id: id(req.params.id), status: 'lost' });
    if (!lead) fail(404, 'Lost customer not found.');
    const notes = string(req.body.notes, 'Call notes', { required: true, max: 2000 });
    if (!['price', 'valuation', 'margin', 'other'].includes(req.body.reason)) fail(400, 'Choose a lost-deal reason.');
    const fingerprint = hash(JSON.stringify([req.body.reason, notes]));
    const previous = (lead.trade_in_call_history || []).find(call => call.request_id === req.body.requestId) ||
      (lead.trade_in_manager_followup?.request_id === req.body.requestId ? lead.trade_in_manager_followup : null);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'This call request ID has already been used.');
      return res.json({ success: true, data: previous });
    }
    const follow_up = { request_id: req.body.requestId, fingerprint, notes, reason: req.body.reason, by: req.user.id, by_name: req.user.name, at: new Date().toISOString() };
    const changed = await db.collection('leads').findOneAndUpdate({ _id: lead._id, status: 'lost', 'trade_in_call_history.request_id': { $ne: req.body.requestId } }, {
      $set: { trade_in_manager_followup: follow_up }, $push: { trade_in_call_history: follow_up, diary_entries: { kind: 'trade_in_follow_up', author: req.user.name, author_id: req.user.id, date: follow_up.at, note: `Lost-deal follow-up (${follow_up.reason}): ${notes}` } },
    }, { returnDocument: 'after' });
    if (!changed) fail(409, 'The customer changed. Refresh before saving.');
    res.json({ success: true, data: follow_up });
  }));
  router.get('/trade-in/alerts', route(async (req, res) => {
    manager(req);
    const collection = (await database(req)).collection('sales_alerts');
    const query = { kind: 'service_trade_opportunity', read_by: { $ne: req.user.id } };
    const [items, total] = await Promise.all([collection.find(query).sort({ createdAt: -1 }).limit(20).toArray(), collection.countDocuments(query)]);
    res.json({ success: true, data: { items, total } });
  }));
  router.patch('/trade-in/alerts/:id/read', route(async (req, res) => {
    manager(req);
    if (!/^trade-in:[a-f0-9]{64}$/.test(req.params.id)) fail(404, 'Alert not found.');
    const row = await (await database(req)).collection('sales_alerts').findOneAndUpdate({ _id: req.params.id, kind: 'service_trade_opportunity' }, { $addToSet: { read_by: req.user.id } });
    if (!row) fail(404, 'Alert not found.');
    res.json({ success: true });
  }));
  router.get('/trade-in/settings', route(async (req, res) => {
    manager(req); const site = dealership(req.query.rooftop);
    if (!canAccessSite(req.user, site)) fail(403, 'This dealership is unavailable.');
    const row = await (await database()).collection('integration_sync').findOne({ _id: settingsId(site) });
    res.json({ success: true, data: { ...defaults, ...row?.settings, configured: configured(env), sendingEnabled: env.TRADE_IN_SEND_ENABLED === 'true', emailConfigured: Boolean(smtpSettings(env).auth.pass) } });
  }));
  router.put('/trade-in/settings', route(async (req, res) => {
    manager(req); const site = dealership(req.body.dealership);
    if (!canAccessSite(req.user, site)) fail(403, 'This dealership is unavailable.');
    const settings = {};
    for (const name of ['enabled', 'postSale', 'lostLead', 'service']) { if (typeof req.body[name] !== 'boolean') fail(400, 'Choose valid automation switches.'); settings[name] = req.body[name]; }
    if (!Array.isArray(req.body.channels) || !req.body.channels.length || req.body.channels.some(value => !['sms', 'email'].includes(value))) fail(400, 'Choose SMS, email or both.');
    settings.channels = [...new Set(req.body.channels)];
    if (settings.enabled && !configured(env)) fail(503, 'Configure TRADE_IN_PUBLIC_URL and TRADE_IN_TOKEN_SECRET before enabling automation.');
    const db = await database(), old = await db.collection('integration_sync').findOne({ _id: settingsId(site) });
    await ensureIndexes(db);
    await db.collection('integration_sync').findOneAndUpdate({ _id: settingsId(site) }, { $set: { dealership: site, kind: 'trade_in_settings', settings,
      enabled_at: old?.settings?.enabled ? old.enabled_at : new Date().toISOString(), updated_by: req.user.id, updatedAt: new Date().toISOString() } }, { upsert: true });
    res.json({ success: true, data: settings });
  }));
  router.get('/trade-in/opportunities', route(async (req, res) => {
    if (req.user.role === 'contractor') fail(403, 'A sales account is required.');
    const result = await list((await database(req)).collection('trade_in_opportunities'), req, {});
    result.data = result.data.map(({ submission_snapshot, ...row }) => row);
    res.json(result);
  }));
  router.get('/trade-in/service-bookings', route(async (req, res) => { manager(req); res.json(await list((await database(req)).collection('service_bookings'), req, {}, 'starts_at')); }));
  router.post('/trade-in/service-bookings', route(async (req, res) => { manager(req); res.status(201).json({ success: true, data: await bookService(await database(), req.body, req.user) }); }));

}

function installPublicTradeIn(router, database, storage, env = process.env) {
  router.post('/webhooks/trade-in/service-bookings', route(async (req, res) => {
    const secret = env.TRADE_IN_SERVICE_WEBHOOK_SECRET || '';
    if (secret.length < 32) fail(503, 'The service booking feed is not configured.');
    const provided = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const digest = value => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(provided), digest(secret))) fail(403, 'Service booking authentication failed.');
    const sites = (env.TRADE_IN_SERVICE_SITES || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!sites.includes(req.body.dealership)) fail(403, 'This dealership is not enabled for the service feed.');
    const actor = { id: 'service-booking-feed', name: 'Service booking feed', role: 'manager', allowedSites: sites };
    res.status(201).json({ success: true, data: await bookService(await database(), req.body, actor) });
  }));
  async function context(req, allowSubmitted = false) {
    const key = verifyToken(req.params.token, env), db = await database();
    const row = await db.collection('trade_in_opportunities').findOne({ _id: key });
    if (!row) fail(404, 'This invitation is unavailable.');
    if (row.status === 'cancelled' || row.status === 'opted_out' || !allowSubmitted && row.status !== 'open') fail(409, 'This invitation is no longer available.');
    return { db, row };
  }
  router.get('/public/trade-ins/:token', route(async (req, res) => {
    const { db, row } = await context(req, true);
    const photos = await db.collection('message_media').find({ trade_in_opportunity_id: row._id, lead_id: row.lead_id, status: { $ne: 'abandoned' } }).limit(10).toArray();
    const data = { dealership: row.dealership, status: row.status, expiresAt: row.expires_at,
      vehicleTypes: TYPES, sections: SECTIONS,
      photos: photos.map(photo => ({ id: String(photo._id), name: photo.name, section: photo.section, status: photo.status })) };
    res.json({ success: true, data });
  }));
  router.post('/public/trade-ins/:token/opt-out', route(async (req, res) => {
    const { db, row } = await context(req, true);
    await db.collection('leads').findOneAndUpdate({ _id: id(row.lead_id), dealership_name: row.dealership }, { $set: { booran_opted_out: true, 'communication_consent.opted_out': true, 'communication_consent.reason': 'Customer requested via trade-in invitation', 'communication_consent.changed_at': new Date().toISOString() } });
    await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id }, { $set: { status: 'opted_out' } });
    res.json({ success: true });
  }));
  router.post('/public/trade-ins/:token/photos', route(async (req, res) => {
    const { db, row } = await context(req);
    const fields = storage.validateMedia(req.body);
    if (!/^image\/(?:jpeg|png|webp|heic|heif)$/.test(fields.content_type) || fields.size > 2 * 1024 * 1024) fail(400, 'Choose a JPG, PNG, WebP or HEIC photo up to 2 MB.');
    if (!SECTIONS.includes(req.body.section)) fail(400, 'Choose a photo view.');
    const slot = await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, status: 'open', photo_count: { $lt: 10 } }, { $inc: { photo_count: 1 } }, { returnDocument: 'after' });
    if (!slot) fail(409, 'This invitation already has ten photos or is being submitted.');
    const mediaId = new ObjectId(), media = { _id: mediaId, ...fields, visibility: 'private', purpose: 'inspection',
      trade_in_opportunity_id: row._id, section: req.body.section, lead_id: row.lead_id, dealership_name: row.dealership,
      status: 'uploading', storage_backend: 'local', staging_key: `staging/${mediaId}`, storage_key: `files/${mediaId}`, created_at: new Date().toISOString() };
    try { const upload = await storage.prepare(media); await db.collection('message_media').insertOne(media); res.status(201).json({ success: true, data: { id: String(mediaId), upload } }); }
    catch (error) { await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id }, { $inc: { photo_count: -1 } }); await storage.remove?.(media).catch(() => {}); throw error; }
  }));
  async function photo(req) {
    const { db, row } = await context(req);
    const media = await db.collection('message_media').findOne({ _id: id(req.params.photoId), trade_in_opportunity_id: row._id, lead_id: row.lead_id });
    if (!media) fail(404, 'Photo not found.');
    return { db, row, media };
  }
  router.put('/public/trade-ins/:token/photos/:photoId/content', express.raw({ type: 'application/octet-stream', limit: '2mb' }), route(async (req, res) => {
    const { media } = await photo(req);
    if (media.status !== 'uploading' || !/^\d+$/.test(req.query.offset || '')) fail(409, 'This photo cannot be uploaded.');
    res.json({ success: true, data: { next_offset: await storage.uploadChunk(media, Number(req.query.offset), req.body) } });
  }));
  router.post('/public/trade-ins/:token/photos/:photoId/complete', route(async (req, res) => {
    const { db, media } = await photo(req);
    if (!['uploading', 'ready'].includes(media.status)) fail(409, 'Start a new photo upload.');
    if (media.status !== 'ready') {
      await storage.complete(media);
      await db.collection('message_media').findOneAndUpdate({ _id: media._id, status: 'uploading' }, { $set: { status: 'ready' } });
    }
    res.json({ success: true, data: { id: String(media._id), name: media.name, section: media.section } });
  }));
  router.delete('/public/trade-ins/:token/photos/:photoId', route(async (req, res) => {
    const { db, row, media } = await photo(req);
    if (media.status === 'ready') fail(409, 'An uploaded photo cannot be removed from this invitation.');
    const removed = await db.collection('message_media').findOneAndUpdate({ _id: media._id, status: 'uploading' }, { $set: { status: 'abandoned' } });
    if (removed) {
      await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id }, { $inc: { photo_count: -1 } });
      await storage.remove?.(media);
    }
    res.json({ success: true });
  }));
  router.post('/public/trade-ins/:token/submit', route(async (req, res) => {
    const { db, row } = await context(req, true);
    const body = req.body;
    if (!TYPES.includes(body.vehicleType)) fail(400, 'Choose a vehicle type.');
    const data = { vehicle_type: body.vehicleType, make: string(body.make, 'Make', { required: true, max: 80 }), model: string(body.model, 'Model', { required: true, max: 100 }),
      rego: string(body.rego, 'Registration', { max: 20 }).toUpperCase(), vin: string(body.vin, 'VIN / hull ID', { max: 30 }).toUpperCase(),
      notes: string(body.notes, 'Condition notes', { max: 5000 }) };
    for (const [key, min, max] of [['year', 1900, new Date().getFullYear() + 2], ['odometer', 0, 10000000]]) if (body[key] !== undefined && body[key] !== '') {
      if (!Number.isSafeInteger(body[key]) || body[key] < min || body[key] > max) fail(400, `Enter a valid ${key}.`); data[key] = body[key];
    }
    if (!Array.isArray(body.photoIds) || !body.photoIds.length || body.photoIds.length > 10 || new Set(body.photoIds).size !== body.photoIds.length) fail(400, 'Attach between one and ten photos.');
    const photos = await db.collection('message_media').find({ _id: { $in: body.photoIds.map(id) }, trade_in_opportunity_id: row._id, lead_id: row.lead_id, status: 'ready', visibility: 'private' }).toArray();
    if (photos.length !== body.photoIds.length) fail(400, 'Complete all selected photo uploads before submitting.');
    photos.sort((a, b) => String(a._id).localeCompare(String(b._id)));
    data.inspection = SECTIONS.map(section => ({ section, condition: 'unchecked', notes: '', photos: photos.filter(p => p.section === section).map(p => ({ id: String(p._id), name: p.name })) }));
    const fingerprint = hash(JSON.stringify(data));
    if (row.submission_hash && row.submission_hash !== fingerprint) fail(409, 'This invitation already contains a different submitted vehicle.');
    const saved = await db.collection('trade_in_opportunities').findOneAndUpdate({ _id: row._id, status: 'open' }, {
      $set: { status: 'submitting', submission_hash: fingerprint, submission_snapshot: { ...data, submitted_at: new Date().toISOString() } },
    }, { returnDocument: 'after' }) || row;
    if (!['submitting', 'submitted'].includes(saved.status) || saved.submission_hash !== fingerprint) fail(409, 'The invitation changed. Please reload it.');
    const appraisalId = await createTradeInService(database, { env }).finishSubmission(db, saved);
    res.json({ success: true, data: { appraisalId } });
  }));
}

module.exports = { TYPES, SECTIONS, defaults, configured, tokenFor, verifyToken, invitationText, dayKey, eligible, bookService, createTradeInService, installTradeInManagement, installPublicTradeIn };
