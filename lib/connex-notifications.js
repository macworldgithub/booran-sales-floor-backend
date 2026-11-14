const { SITE, attention, closed } = require('./connex-policy');
const { isManager, canAccessSite } = require('./roles');
const { normalisePhone } = require('./phone');
const { route, fail } = require('./workflow-route');
const smsDefault = require('./mobilemessage');
const calendar = require('./connex-calendar');
const { hash } = require('./connex-store');
const { ObjectId } = require('mongodb');
const defaults = { newAlerts: false, escalations: false, email: false, sms: false, phone: '' };
const preferenceId = id => `connex:notifications:${id}`;
function smtpConfig(env = process.env) {
  return { host: env.HYUNDAI_INBOUND_SMTP_HOST || 'smtp.hostinger.com', port: 465, secure: true,
    auth: { user: env.HYUNDAI_INBOUND_NEW_USER || 'smhynew@goodshowroom.com', pass: env.HYUNDAI_INBOUND_NEW_PASSWORD },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, logger: false, debug: false };
}
async function sendEmail({ to, subject, text }, env = process.env) {
  const config = smtpConfig(env);
  if (!config.auth.pass) throw new Error('Connex email delivery needs SMTP configuration.');
  const transporter = require('nodemailer').createTransport(config);
  try { await transporter.sendMail({ from: config.auth.user, to, subject, text }); } finally { transporter.close(); }
}
function installConnexNotifications(router, database, providers = {}) {
  const own = handler => route(async (req, res) => {
    if (!canAccessSite(req.user, SITE) || req.user.role === 'contractor') fail(403, 'South Morang Hyundai access is required.');
    await handler(req, res, await database());
  });
  router.get('/connex/notification-preferences', own(async (req, res, db) => {
    const prefs = await db.collection('integration_sync').findOne({ _id: preferenceId(req.user.id) });
    const deliveries = await db.collection('integration_sync').find({ kind: 'connex_notification', dealership: SITE, user_id: req.user.id }).sort({ created_at: -1 }).limit(10).toArray();
    res.json({ success: true, data: { preferences: { ...defaults, ...prefs?.preferences }, emailAddress: req.user.email,
      emailConfigured: Boolean(smtpConfig().auth.pass), smsConfigured: (providers.sms || smsDefault).configured(SITE),
      deliveries: deliveries.map(row => ({ id: row._id, channel: row.channel, type: row.type, status: row.status, createdAt: row.created_at, error: row.error })) } });
  }));
  router.put('/connex/notification-preferences', own(async (req, res, db) => {
    const preferences = {};
    for (const key of ['newAlerts', 'escalations', 'email', 'sms']) { if (typeof req.body[key] !== 'boolean') fail(400, 'Choose valid notification preferences.'); preferences[key] = req.body[key]; }
    if (typeof req.body.phone !== 'string' || req.body.phone.length > 30) fail(400, 'Enter your mobile number.');
    try { preferences.phone = req.body.phone.trim() ? normalisePhone(req.body.phone) : ''; } catch { fail(400, 'Enter a valid Australian mobile number.'); }
    if (preferences.sms && !preferences.phone) fail(400, 'Enter your mobile number to enable SMS notifications.');
    if (preferences.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.user.email || '')) fail(400, 'Your account needs a valid email address.');
    const state = db.collection('integration_sync'), old = await state.findOne({ _id: preferenceId(req.user.id) }), now = new Date();
    await state.findOneAndUpdate({ _id: preferenceId(req.user.id) }, { $set: { kind: 'connex_notification_preferences', dealership: SITE, user_id: req.user.id,
      preferences, updated_at: now, new_enabled_at: preferences.newAlerts && !old?.preferences?.newAlerts ? now : old?.new_enabled_at || now } }, { upsert: true });
    res.json({ success: true });
  }));
}
async function processConnexNotifications(db, providers = {}, now = new Date()) {
  const state = db.collection('integration_sync');
  await state.updateMany({ kind: 'connex_notification', dealership: SITE, status: 'sending', started_at: { $lte: new Date(+now - 300000) } },
    { $set: { status: 'needs_attention', error: 'Delivery was interrupted. Check the provider before resending; this notification is not automatically duplicated.' } });
  const settings = await state.find({ kind: 'connex_notification_preferences', dealership: SITE }).toArray();
  if (!settings.some(row => (row.preferences?.email || row.preferences?.sms) && (row.preferences?.newAlerts || row.preferences?.escalations))) return;
  const [records, users, holidaySettings] = await Promise.all([
    state.find({ kind: 'connex_record', dealership: SITE }).toArray(), db.collection('users').find({ active: true }).toArray(),
    state.findOne({ _id: 'connex:calendar' }),
  ]);
  const leadIds = [...new Set(records.map(row => row.lead_id).filter(ObjectId.isValid))].map(id => new ObjectId(id));
  const leads = await db.collection('leads').find({ _id: { $in: leadIds }, dealership_name: SITE, merged_into: { $exists: false } }, { projection: { _id: 1, owner_id: 1 } }).toArray();
  const owners = new Map(leads.map(lead => [String(lead._id), lead.owner_id]));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  for (const setting of settings) {
    const user = users.find(user => String(user._id) === setting.user_id), prefs = setting.preferences || defaults;
    if (!user || !canAccessSite(user, SITE) || user.role === 'contractor' || !prefs.email && !prefs.sms) continue;
    const visible = records.filter(record => isManager(user) || owners.get(record.lead_id) === String(user._id));
    const recent = visible.filter(record => record.snapshot.createdAt && Date.parse(record.snapshot.createdAt) >= +new Date(setting.new_enabled_at) &&
      +new Date(record.snapshot.createdAt) <= +now && !closed(record.snapshot.stage));
    const escalation = visible.filter(record => +now - Date.parse(record.snapshot.observedAt) < 7 * 3600000 &&
      Object.entries(attention(record.snapshot, now, calendar.holidays(holidaySettings))).some(([key, value]) => ['notAcceptedThreeDays', 'openSixWeeks'].includes(key) && value));
    for (const [type, enabled, count] of [['new', prefs.newAlerts, recent.length], ['escalation', prefs.escalations, escalation.length]]) {
      if (!enabled || !count) continue;
      // New-lead notifications checkpoint each source ID. Escalations are one daily digest.
      const previous = type === 'new' ? await state.findOne({ _id: `connex:notification-checkpoint:${setting.user_id}` }) : null;
      const fresh = type === 'new' ? recent.filter(record => !(previous?.recordIds || []).includes(record.recordId)) : [];
      if (type === 'new' && !fresh.length) continue;
      const batch = type === 'new' ? hash(fresh.map(record => record.recordId).sort()).slice(0, 24) : day;
      const amount = type === 'new' ? fresh.length : count;
      const text = `South Morang Hyundai: ${amount} ${type === 'new' ? 'new Connex enquiries' : 'Connex enquiries need attention (unaccepted for 3 days or open for 6 weeks)'}. Review in Sales Floor: https://booran-sales-floor.goodshowroom.com/?tab=today`;
      for (const channel of ['email', 'sms'].filter(channel => prefs[channel])) {
        const key = `connex:notification:${hash([setting.user_id, type, batch, channel])}`;
        await state.findOneAndUpdate({ _id: key }, { $setOnInsert: { kind: 'connex_notification', dealership: SITE, user_id: setting.user_id,
          channel, type, status: 'queued', text, created_at: now } }, { upsert: true });
      }
      if (type === 'new') await state.findOneAndUpdate({ _id: `connex:notification-checkpoint:${setting.user_id}` }, { $set: {
        kind: 'connex_notification_checkpoint', dealership: SITE, recordIds: [...new Set([...(previous?.recordIds || []), ...fresh.map(record => record.recordId)])].slice(-10000) } }, { upsert: true });
    }
  }
  const pending = await state.find({ kind: 'connex_notification', dealership: SITE, status: 'queued' }).sort({ created_at: 1 }).limit(20).toArray();
  for (const item of pending) {
    const user = users.find(user => String(user._id) === item.user_id), setting = settings.find(row => row.user_id === item.user_id), prefs = setting?.preferences;
    if (!user || !canAccessSite(user, SITE) || !prefs?.[item.channel] || !prefs[item.type === 'new' ? 'newAlerts' : 'escalations']) {
      await state.findOneAndUpdate({ _id: item._id, status: 'queued' }, { $set: { status: 'cancelled' } }); continue;
    }
    const claimed = await state.findOneAndUpdate({ _id: item._id, status: 'queued' }, { $set: { status: 'sending', started_at: now } }, { returnDocument: 'after' });
    if (!claimed) continue;
    try {
      if (item.channel === 'email') await (providers.sendEmail || sendEmail)({ to: user.email, subject: 'South Morang Hyundai — Connex lead alert', text: item.text });
      else {
        const result = await (providers.sms || smsDefault).sendSms({ phone: prefs.phone, body: item.text, requestId: hash(item._id), dealership: SITE });
        if (!['queued', 'sent', 'delivered'].includes(result.status)) throw new Error('SMS was not confirmed.');
      }
      await state.findOneAndUpdate({ _id: item._id }, { $set: { status: 'sent', sent_at: new Date(), error: null } });
    } catch {
      await state.findOneAndUpdate({ _id: item._id }, { $set: { status: 'needs_attention', error: 'Delivery was not confirmed. Check the email or SMS provider before resending.' } });
    }
  }
}
module.exports = { installConnexNotifications, processConnexNotifications, smtpConfig, defaults };
