const { createHash } = require('node:crypto');
const { isManager, canAccessSite } = require('./roles');
const { dealership, string } = require('./records');
const { validateSmsLength } = require('./mobilemessage');
const { route, fail } = require('./workflow-route');

const DEFAULT_TEMPLATE =
  "Thank you for considering {dealership} for your vehicle purchase. If you haven't found the right vehicle, please feel free to reach out to us anytime. Otherwise, we'd love the opportunity to help you again one day. All the best.";

const settingsId = site => `lost-sms:settings:${String(site || '').trim().toLowerCase()}`;
const optedOut = lead => lead?.booran_opted_out === true || lead?.communication_consent?.opted_out === true;
const successfulSend = result => ['queued', 'sent', 'delivered'].includes(result?.status);

async function getLostSmsSettings(db, site) {
  if (!site) return { enabled: true, template: DEFAULT_TEMPLATE };
  const row = await db.collection('integration_sync').findOne({ _id: settingsId(site) });
  return {
    enabled: row?.enabled !== undefined ? Boolean(row.enabled) : true,
    template: typeof row?.template === 'string' && row.template.trim() ? row.template.trim() : DEFAULT_TEMPLATE,
    updated_at: row?.updatedAt || null,
    updated_by_name: row?.updated_by_name || null,
  };
}

function renderLostFinalSms(template, lead, managerName = '') {
  const fullName = String(lead?.customer_name || '').trim();
  const firstName = fullName.split(/\s+/)[0] || 'there';
  const site = String(lead?.dealership_name || 'us').trim();
  const rendered = String(template || DEFAULT_TEMPLATE)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{customer_name\}/gi, fullName || 'there')
    .replace(/\{dealership\}/gi, site)
    .replace(/\{manager_name\}/gi, String(managerName || '').trim())
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return rendered;
}

async function sendLostFinalSms(db, lead, user, sms, { reviewId = null, sendFinalSms, customMessage } = {}) {
  if (!lead || sendFinalSms === false) return { status: 'skipped', reason: 'disabled_by_manager' };
  const settings = await getLostSmsSettings(db, lead.dealership_name);
  if (!settings.enabled && sendFinalSms !== true) return { status: 'skipped', reason: 'disabled_for_dealership' };
  if (optedOut(lead)) return { status: 'skipped', reason: 'opted_out' };
  if (!sms?.configured?.(lead.dealership_name)) return { status: 'skipped', reason: 'sms_not_configured' };

  let phone;
  try {
    phone = sms.normalisePhone(lead.customer_phone);
  } catch {
    return { status: 'skipped', reason: 'no_mobile' };
  }
  if (!phone) return { status: 'skipped', reason: 'no_mobile' };

  const leadId = String(lead._id);
  const messageKey = `lost-final-sms:${leadId}:${reviewId || 'direct'}`;
  const _id = createHash('sha256').update(messageKey).digest('hex');

  const existing = await db.collection('customer_messages').findOne({ _id, lead_id: leadId });
  if (existing) {
    return { status: existing.status, messageId: _id, body: existing.body, duplicate: true };
  }

  const rawBody = typeof customMessage === 'string' && customMessage.trim()
    ? customMessage.trim()
    : renderLostFinalSms(settings.template, lead, user?.name);
  validateSmsLength(rawBody);

  const now = new Date();
  const nowIso = now.toISOString();
  const row = {
    _id,
    lead_id: leadId,
    request_id: reviewId || _id,
    kind: 'lost_final_sms',
    dealership_name: lead.dealership_name,
    body: rawBody,
    attachments: [],
    phone,
    author: user?.name || 'Lost Lead Automation',
    user_id: user?.id || 'lost-lead-sms',
    created_at: nowIso,
    status: 'pending',
    provider: 'mobilemessage',
  };

  try {
    await db.collection('customer_messages').insertOne(row);
  } catch (error) {
    if (error.code === 11000) {
      const dup = await db.collection('customer_messages').findOne({ _id, lead_id: leadId });
      return { status: dup?.status || 'pending', messageId: _id, body: dup?.body || rawBody, duplicate: true };
    }
    throw error;
  }

  let result;
  try {
    result = await sms.sendSms({ phone, body: rawBody, requestId: _id, dealership: lead.dealership_name });
  } catch (error) {
    result = { status: 'unknown', error: error?.message || 'Acceptance could not be confirmed.' };
  }

  await db.collection('customer_messages').findOneAndUpdate({ _id, lead_id: leadId }, { $set: result });

  const sentOk = successfulSend(result);
  await db.collection('leads').findOneAndUpdate(
    { _id: lead._id },
    {
      $set: {
        lost_final_sms: {
          status: result.status,
          sent_at: nowIso,
          message_id: _id,
          review_id: reviewId || null,
          by: user?.id || null,
          by_name: user?.name || null,
          body: rawBody,
          ...(result.error ? { error: result.error } : {}),
        },
        updatedAt: now,
      },
      $push: {
        diary_entries: {
          kind: sentOk ? 'sms_sent' : 'sms_failed',
          author_role: user?.role || 'manager',
          author_id: user?.id || null,
          author: user?.name || 'Lost Lead Automation',
          date: nowIso,
          note: `Final Lost SMS ${result.status} to ${phone}: ${rawBody}`,
        },
      },
    }
  ).catch(() => {});

  return { status: result.status, messageId: _id, body: rawBody, error: result.error || null };
}

function installLostLeadSms(router, database, sms) {
  router.get('/crm/lost-sms-settings', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Manager access is required.');
    const site = dealership(req.query.rooftop);
    if (!canAccessSite(req.user, site)) fail(403, 'This dealership is unavailable.');
    const db = await database();
    const settings = await getLostSmsSettings(db, site);
    res.json({
      success: true,
      data: {
        ...settings,
        defaultTemplate: DEFAULT_TEMPLATE,
        smsConfigured: Boolean(sms?.configured?.(site)),
      },
    });
  }));

  router.put('/crm/lost-sms-settings', route(async (req, res) => {
    if (!isManager(req.user)) fail(403, 'Manager access is required.');
    const site = dealership(req.body.dealership);
    if (!canAccessSite(req.user, site)) fail(403, 'This dealership is unavailable.');
    if (typeof req.body.enabled !== 'boolean') fail(400, 'Choose whether automated Lost SMS is enabled.');
    const template = string(req.body.template, 'Final Lost SMS template', { required: true, max: 670 });
    validateSmsLength(renderLostFinalSms(template, { customer_name: 'Customer Example', dealership_name: site }, req.user.name));
    const db = await database();
    const now = new Date().toISOString();
    await db.collection('integration_sync').findOneAndUpdate(
      { _id: settingsId(site) },
      {
        $set: {
          kind: 'lost_sms_settings',
          dealership: site,
          enabled: req.body.enabled,
          template,
          updated_by: req.user.id,
          updated_by_name: req.user.name,
          updatedAt: now,
        },
      },
      { upsert: true }
    );
    res.json({
      success: true,
      data: {
        enabled: req.body.enabled,
        template,
        defaultTemplate: DEFAULT_TEMPLATE,
        smsConfigured: Boolean(sms?.configured?.(site)),
        updated_at: now,
        updated_by_name: req.user.name,
      },
    });
  }));
}

module.exports = {
  DEFAULT_TEMPLATE,
  getLostSmsSettings,
  renderLostFinalSms,
  sendLostFinalSms,
  installLostLeadSms,
};
