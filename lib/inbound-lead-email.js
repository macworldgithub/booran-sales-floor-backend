const { createHash, timingSafeEqual } = require('node:crypto');
const { ObjectId } = require('mongodb');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createLead, serializeLead } = require('./records');
const { normalisePhone } = require('./phone');
const { createUniqueLead } = require('./lead-identity');
const { parseAdfLead } = require('./adf-lead');
const { route, fail } = require('./workflow-route');

const SITE = 'South Morang Hyundai';
const ADDRESSES = { new: 'SMHYNew@goodshowroom.com', used: 'SMHYUsed@goodshowroom.com' };
const MAX_EMAIL_SIZE = 10 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
function mailboxes(env = process.env) {
  return Object.entries(ADDRESSES).map(([category, address]) => ({ category, address,
    user: env[`HYUNDAI_INBOUND_${category.toUpperCase()}_USER`] || address.toLowerCase(),
    pass: env[`HYUNDAI_INBOUND_${category.toUpperCase()}_PASSWORD`],
    host: env.HYUNDAI_INBOUND_IMAP_HOST || 'imap.hostinger.com',
  }));
}

function labelled(text, labels) {
  const pattern = new RegExp(`^\\s*(?:${labels})[ \\t]*[:=-][ \\t]*([^\\r\\n]+)`, 'im');
  return pattern.exec(text)?.[1]?.trim() || '';
}
function emailLead(category, message) {
  if (!Object.hasOwn(ADDRESSES, category)) fail(400, 'Choose the New or Used inbox.');
  const messageId = typeof message.messageId === 'string' && message.messageId.trim();
  if (!messageId || messageId.length > 500) fail(400, 'An email message reference is required.');
  const adf = parseAdfLead(message);
  const text = String(message.text || '').slice(0, 100000), subject = String(message.subject || '').slice(0, 500);
  const name = adf?.name || labelled(text, 'Customer name|Full name|Name') ||
    [labelled(text, 'First name'), labelled(text, 'Last name|Surname')].filter(Boolean).join(' ') || `${category === 'new' ? 'New' : 'Used'} vehicle email enquiry`;
  const rawPhone = adf?.phone || labelled(text, 'Customer mobile|Customer phone|Mobile(?: number)?|Phone(?: number)?|Contact number|Telephone|Tel');
  let phone = adf?.phone || '';
  if (!adf && rawPhone) { try { phone = normalisePhone(rawPhone); } catch { /* Keep the original message for manager review. */ } }
  const rawEmail = adf?.email || labelled(text, 'Customer email|Email(?: address)?');
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail.slice(0, 254) : '';
  if (!adf && !phone && !email) throw Object.assign(new Error('No customer mobile or email was identified. Review the original lead email.'), { emailReview: true });
  const receivedAt = adf ? new Date(adf.adf.request_date) : Number.isFinite(Date.parse(message.date)) ? new Date(message.date) : new Date();
  const identity = adf?.adf.id ? JSON.stringify(['adf', SITE, adf.adf.provider.toLowerCase(), adf.adf.id_source.toLowerCase(), adf.adf.id])
    : `${ADDRESSES[category].toLowerCase()}:${messageId}`;
  const id = new ObjectId(hash(identity).slice(0, 24));
  return { ...createLead({ name, phone, email, dealership: SITE, source: 'Inbound Email',
    vehicle_make: adf?.vehicle_make || labelled(text, 'Vehicle make|Make').slice(0, 200), vehicle_model: adf?.vehicle_model || labelled(text, 'Vehicle model|Vehicle|Model').slice(0, 200),
    notes: [`${category === 'new' ? 'New' : 'Used'} vehicle lead received at ${ADDRESSES[category]}`, subject, adf?.notes || text].filter(Boolean).join('\n').slice(0, 5000),
  }, { name: 'Inbound lead email' }), _id: id, deal_id: `EMAIL-${id}`, owner_id: null, owner_name: 'Unassigned',
    ...(adf?.vehicle_year ? { vehicle_year: adf.vehicle_year } : {}),
    created_at: receivedAt.toISOString(), createdAt: receivedAt,
    inbound_email: { address: ADDRESSES[category], category, message_id: messageId, subject, received_at: new Date().toISOString(),
      format: adf ? 'adf' : 'labelled_text', ...(adf ? { adf: adf.adf } : {}) } };
}

async function ingestLeadEmail(db, category, message) {
  if (!Object.hasOwn(ADDRESSES, category)) fail(400, 'Choose the New or Used inbox.');
  const messageId = typeof message.messageId === 'string' && message.messageId.trim();
  if (!messageId || messageId.length > 500) fail(400, 'An email message reference is required.');
  const receiptId = hash(`${ADDRESSES[category].toLowerCase()}:${messageId}`).slice(0, 24);
  const previous = await db.collection('lead_email_receipts').findOne({ _id: receiptId });
  if (previous) return { status: previous.status, leadId: previous.lead_id, replay: true };
  let lead;
  try { lead = emailLead(category, message); }
  catch (error) {
    if (!error.emailReview) throw error;
    await db.collection('lead_email_receipts').findOneAndUpdate({ _id: receiptId }, { $setOnInsert: {
      dealership: SITE, address: ADDRESSES[category], category, status: 'needs_review', message_id: messageId,
      reason: error.message, subject: String(message.subject || '').slice(0, 500), received_at: new Date(),
    } }, { upsert: true });
    return { status: 'needs_review', reason: error.message };
  }
  const result = await createUniqueLead(db, lead, { name: 'Inbound lead email' }, true);
  const status = result.duplicate ? 'merge_review' : 'imported';
  await db.collection('lead_email_receipts').findOneAndUpdate({ _id: receiptId }, { $setOnInsert: {
    dealership: SITE, address: ADDRESSES[category], category, status, lead_id: result.lead ? String(result.lead._id) : null,
    merge_request_id: result.requestId || null, received_at: new Date(),
  } }, { upsert: true });
  return { status, leadId: result.lead ? String(result.lead._id) : null, mergeRequested: result.duplicate === true,
    ...(result.inserted === false ? { replay: true } : {}) };
}

function installInboundEmailWebhook(router, database) {
  router.post('/integrations/inbound-email/:category', route(async (req, res) => {
    const secret = Buffer.from(process.env.HYUNDAI_INBOUND_EMAIL_SECRET || '');
    const token = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '');
    if (secret.length < 32 || token.length !== secret.length || !timingSafeEqual(secret, token)) fail(403, 'Email ingestion is not authorised.');
    const expected = ADDRESSES[req.params.category];
    if (!expected || (req.body.to && String(req.body.to).toLowerCase() !== expected.toLowerCase())) fail(400, 'This recipient is unavailable.');
    res.json({ success: true, data: await ingestLeadEmail(await database(), req.params.category, req.body) });
  }));
}

let polling = false;
async function pollLeadEmail(db, env = process.env, makeClient = options => new ImapFlow(options)) {
  if (polling) return;
  polling = true;
  try {
    for (const inbox of mailboxes(env).filter(inbox => inbox.pass)) {
      const client = makeClient({ host: inbox.host, port: 993, secure: true, auth: { user: inbox.user, pass: inbox.pass },
        logger: false, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000 });
      client.on('error', () => {});
      const key = `email:${inbox.address.toLowerCase()}`;
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX', { readOnly: true });
        try {
          const checkpoint = await db.collection('integration_sync').findOne({ _id: key });
          const validity = String(client.mailbox.uidValidity);
          const lastUid = checkpoint?.uid_validity === validity ? checkpoint.last_uid || 0 : 0;
          const found = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
          const uids = found.filter(uid => uid > lastUid).sort((a, b) => a - b).slice(0, 50);
          for (const uid of uids) {
            const info = await client.fetchOne(uid, { size: true }, { uid: true });
            if (info.size > MAX_EMAIL_SIZE) {
              await db.collection('lead_email_receipts').findOneAndUpdate({ _id: hash(`${key}:${validity}:${uid}`) }, { $setOnInsert: {
                dealership: SITE, address: inbox.address, status: 'needs_review', reason: 'Email exceeds the 10 MB ingestion limit. Review the original mailbox message.', received_at: new Date() },
              }, { upsert: true });
            } else {
              const item = await client.fetchOne(uid, { source: true }, { uid: true });
              const parsed = await simpleParser(item.source, { skipTextToHtml: true, skipImageLinks: true });
              await ingestLeadEmail(db, inbox.category, { messageId: parsed.messageId || `${validity}:${uid}`, subject: parsed.subject,
                text: parsed.text || '', attachments: parsed.attachments, date: parsed.date?.toISOString() });
            }
            // The inbox is left intact. Only our own checkpoint advances after durable ingestion.
            await db.collection('integration_sync').findOneAndUpdate({ _id: key }, { $set: {
              dealership: SITE, kind: 'inbound_email', address: inbox.address, last_uid: uid, uid_validity: validity,
              last_success: new Date(), error: null,
            } }, { upsert: true });
          }
          await db.collection('integration_sync').findOneAndUpdate({ _id: key }, { $set: {
            dealership: SITE, kind: 'inbound_email', address: inbox.address, last_success: new Date(), error: null,
          } }, { upsert: true });
        } finally { lock.release(); }
      } catch {
        await db.collection('integration_sync').findOneAndUpdate({ _id: key }, { $set: { dealership: SITE, kind: 'inbound_email',
          address: inbox.address, last_attempt: new Date(), error: 'The lead mailbox could not be read. Check its account access and IMAP settings.' } }, { upsert: true });
      } finally { await client.logout().catch(() => {}); }
    }
  } finally { polling = false; }
}

module.exports = { ADDRESSES, mailboxes, emailLead, ingestLeadEmail, installInboundEmailWebhook, pollLeadEmail };
