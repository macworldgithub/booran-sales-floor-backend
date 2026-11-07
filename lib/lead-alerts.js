const { createHash } = require('node:crypto');
const { reference } = require('./lead-allocation');
const { canAccessSite, isManager } = require('./roles');
const { dealership, string, draftingEnabled } = require('./records');
const { list, route, fail } = require('./workflow-route');

const titles = { high_buyer: 'High Buyer Alert', price_objection: 'Price Objection Alert', high_risk: 'High Risk Alert' };
const price = /(?:\$|\b(?:pric(?:e|es|ing)|cost|repayments?|trade[ -]?in|discount|quote|cheaper|dollars?|aud|valuations?)\b)/i;
function classify(text) {
  if (/(too expensive|outside (?:my|our) budget|better deal|do any better|can.?t afford|over (?:my|our) budget)/i.test(text)) return 'price_objection';
  if (/(need to think|not right now|still looking|leave it with me|get back to you)/i.test(text)) return 'high_risk';
  if (/(ready to buy|come in today|book an? (?:appointment|test drive)|finance|repayments?|trad(?:e|ing)[ -]?in|quot(?:e|es)|pric(?:e|ing)|compar(?:e|ing)|competitor)/i.test(text)) return 'high_buyer';
  return null;
}

async function publishPush(db, alert) {
  if (process.env.EXPO_PUSH_ENABLED !== 'true') return;
  const users = await db.collection('users').find({ active: true, role: { $ne: 'contractor' } }).toArray();
  const ids = users.filter(user => canAccessSite(user, alert.dealership) && (isManager(user) || String(user._id) === alert.owner_id)).map(user => String(user._id));
  if (!ids.length) return;
  const tokens = await db.collection('push_devices').find({ user_id: { $in: ids }, expiresAt: { $gt: new Date() } }).limit(100).toArray();
  if (!tokens.length) return;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.EXPO_PUSH_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_PUSH_ACCESS_TOKEN}`;
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST', headers, signal: AbortSignal.timeout(4000),
    body: JSON.stringify(tokens.map(row => ({
      to: row._id, title: titles[alert.kind], body: 'Open Booran Sales Floor to review the lead.',
      data: { leadId: alert.lead_id }, channelId: 'booran-alerts',
    }))),
  });
  if (!response.ok) throw new Error('Push service rejected the request');
  const result = await response.json();
  if (Array.isArray(result.data)) await Promise.all(result.data.map((ticket, index) => {
    if (ticket.details?.error === 'DeviceNotRegistered') return db.collection('push_devices').deleteOne({ _id: tokens[index]._id });
  }));
}

async function recordAlert(db, lead, eventId, body, category) {
  const kind = category || classify(body);
  if (!kind) return;
  const settings = await db.collection('alert_settings').findOne({ _id: lead.dealership_name.toLowerCase() });
  if (settings?.enabled && !settings.enabled.includes(kind)) return;
  const alert = {
    _id: createHash('sha256').update(`${lead._id}:${eventId}:${kind}`).digest('hex'),
    dealership: lead.dealership_name, owner_id: lead.owner_id || null, lead_id: String(lead._id),
    kind, title: titles[kind], createdAt: new Date().toISOString(),
  };
  try { await db.collection('sales_alerts').insertOne(alert); }
  catch (error) { if (error.code === 11000) return; throw error; }
  await publishPush(db, alert).catch(error => console.warn('Booran push delivery unavailable:', error.message));
}

async function checkAgedLeads(db, date = new Date()) {
  const end = new Date(+date - 3 * 86400000).toISOString();
  const start = new Date(+date - 4 * 86400000).toISOString();
  const rows = await db.collection('leads').find({
    status: { $in: ['new_lead', 'following_up'] }, merged_into: { $exists: false },
    $or: [
      { last_engagement_at: { $gte: start, $lt: end } },
      { last_engagement_at: { $exists: false }, last_activity_at: { $gte: start, $lt: end } },
      { last_engagement_at: { $exists: false }, last_activity_at: { $in: ['', null] }, created_at: { $gte: start, $lt: end } },
    ],
  }).sort({ created_at: -1, _id: 1 }).limit(200).toArray();
  for (let offset = 0; offset < rows.length; offset += 10) {
    await Promise.all(rows.slice(offset, offset + 10).filter(lead => lead.dealership_name).map(lead =>
      recordAlert(db, lead, `no-engagement:${lead.last_engagement_at || lead.last_activity_at || lead.created_at}`, '', 'high_risk')));
  }
  return rows.length;
}

function installLeadAlerts(router, database) {
  router.get('/lead-alerts', route(async (req, res) => {
    const db = await database(req);
    res.json(await list(db.collection('sales_alerts'), req, {}));
  }));
  router.patch('/lead-alerts/settings', route(async (req, res) => {
    const site = dealership(req.body.dealership);
    if (!isManager(req.user) || !canAccessSite(req.user, site)) fail(403, 'You cannot configure alerts for this dealership.');
    if (!Array.isArray(req.body.enabled) || req.body.enabled.length > 3 || req.body.enabled.some(kind => !Object.hasOwn(titles, kind))) fail(400, 'Choose valid alert categories.');
    const enabled = [...new Set(req.body.enabled)];
    await (await database()).collection('alert_settings').updateOne({ _id: site.toLowerCase() }, { $set: { enabled } }, { upsert: true });
    res.json({ success: true, data: { enabled } });
  }));
  router.get('/lead-alerts/settings', route(async (req, res) => {
    const site = dealership(req.query.rooftop);
    if (!isManager(req.user) || !canAccessSite(req.user, site)) fail(403, 'You cannot configure alerts for this dealership.');
    const settings = await (await database()).collection('alert_settings').findOne({ _id: site.toLowerCase() });
    res.json({ success: true, data: { enabled: settings?.enabled ?? Object.keys(titles) } });
  }));
  router.post('/push-devices', route(async (req, res) => {
    const token = req.body.token;
    if (req.user.role === 'contractor' || typeof token !== 'string' || !/^(?:Expo|Exponent)PushToken\[[a-z0-9_-]{12,256}\]$/i.test(token)) fail(400, 'Invalid push registration.');
    await (await database()).collection('push_devices').updateOne(
      { _id: token }, { $set: { user_id: req.user.id, expiresAt: new Date(Date.now() + 30 * 86400000) } }, { upsert: true },
    );
    res.json({ success: true });
  }));
  router.delete('/push-devices', route(async (req, res) => {
    if (typeof req.body?.token !== 'string') fail(400, 'Invalid push registration.');
    await (await database()).collection('push_devices').deleteOne({ _id: req.body.token, user_id: req.user.id });
    res.json({ success: true });
  }));

  router.patch('/leads/:id/ai', route(async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') fail(400, 'Select whether drafting is enabled.');
    const resumeHours = req.body.resumeAfterHours ?? 0;
    if (!Number.isInteger(resumeHours) || resumeHours < 0 || resumeHours > 168) fail(400, 'Choose a resume delay of up to 168 hours.');
    const db = await database(req);
    const lead = await db.collection('leads').findOneAndUpdate(reference(req.params.id), {
      $set: {
        booran_ai_enabled: req.body.enabled, booran_ai_resume_hours: req.body.enabled ? resumeHours : 0,
        booran_ai_resume_at: null, booran_ai_changed_at: new Date(), booran_ai_changed_by: req.user.id,
      },
    }, { returnDocument: 'after' });
    if (!lead) fail(404, 'Lead not found.');
    res.json({ success: true, data: { enabled: draftingEnabled(lead), resumeHours: lead.booran_ai_resume_hours } });
  }));
  router.post('/leads/:id/ai/draft', route(async (req, res) => {
    const db = await database(req);
    const lead = await db.collection('leads').findOne(reference(req.params.id));
    if (!lead) fail(404, 'Lead not found.');
    if (!draftingEnabled(lead)) fail(409, 'AI drafting is paused. Enable it to request a draft.');
    const question = string(req.body.question, 'Customer question', { required: true, max: 1000 });
    const fallback = 'Thanks for your enquiry. A team member can help with that. Would you like to arrange a time to speak?';
    if (price.test(question)) return res.json({ success: true, data: { draft: fallback } });
    const settings = await (await database()).collection('ai_knowledge').findOne({ _id: lead.dealership_name.toLowerCase() });
    if (!process.env.SMS_DRAFT_URL || !process.env.SMS_DRAFT_TOKEN || !settings?.knowledge) fail(503, 'AI drafting needs a configured provider and dealership knowledge.');
    let draft;
    try {
      const endpoint = new URL(process.env.SMS_DRAFT_URL);
      if (endpoint.protocol !== 'https:') throw new Error('HTTPS required');
      const response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.SMS_DRAFT_TOKEN}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000), body: JSON.stringify({
          question, knowledge: settings.knowledge,
          instruction: 'Draft a short SMS using only the approved dealership knowledge. Do not discuss pricing, discounts, trade-in values, repayment or quotes. Escalate these questions to a salesperson. Do not claim to be human. Return JSON with a draft string.',
        }),
      });
      if (!response.ok) throw new Error('Draft unavailable');
      draft = (await response.json()).draft;
    } catch { fail(503, 'AI drafting is temporarily unavailable.'); }
    if (typeof draft !== 'string' || !draft.trim() || draft.length > 600 || price.test(draft) || /\b\d[\d,.]{2,}\b/.test(draft)) draft = fallback;
    const current = await db.collection('leads').findOne({ _id: lead._id, booran_ai_changed_at: lead.booran_ai_changed_at });
    if (!current || !draftingEnabled(current)) fail(409, 'AI drafting was paused while the draft was being prepared.');
    res.json({ success: true, data: { draft } });
  }));
  router.patch('/ai-knowledge', route(async (req, res) => {
    const site = dealership(req.body.dealership);
    if (!isManager(req.user) || !canAccessSite(req.user, site)) fail(403, 'You cannot configure AI knowledge for this dealership.');
    const knowledge = string(req.body.knowledge, 'Approved dealer/OEM knowledge', { required: true, max: 12000 });
    await (await database()).collection('ai_knowledge').updateOne({ _id: site.toLowerCase() }, { $set: { knowledge } }, { upsert: true });
    res.json({ success: true });
  }));
}

module.exports = { installLeadAlerts, recordAlert, classify, checkAgedLeads };
