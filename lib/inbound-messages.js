const { createHash } = require('node:crypto');
const { phoneKey } = require('./message-history');
const { ObjectId } = require('mongodb');
const { canonicalLead } = require('./lead-identity');

const replyTo = (event, outgoing) => outgoing.find(row =>
  (event.original_message_id && row.provider_message_id === event.original_message_id || event.original_custom_ref && String(row._id) === event.original_custom_ref) &&
  (!event.original_message_id || !row.provider_message_id || row.provider_message_id === event.original_message_id) &&
  phoneKey(event.from) && phoneKey(event.from) === phoneKey(row.phone));

async function saveInbound({ db, lead, original, event, onInbound }) {
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(event.received_at) ? event.received_at.replace(' ', 'T') + 'Z' : event.received_at);
  if (!Number.isFinite(+date)) return false;
  const id = 'inbound:' + createHash('sha256').update(String(event.message_id)).digest('hex');
  const row = { _id: id, lead_id: String(lead._id), dealership_name: lead.dealership_name || original.dealership_name, direction: 'inbound', status: 'received', body: event.message, phone: original.phone, author: lead.customer_name || 'Customer', created_at: date.toISOString(), attachments: [], provider: 'mobilemessage', provider_message_id: String(event.message_id), original_message_id: event.original_message_id, event_type: event.type };
  try { await db.collection('customer_messages').insertOne(row); }
  catch (error) { if (error.code === 11000) return false; throw error; }
  await db.collection('leads').findOneAndUpdate({ _id: lead._id }, {
    $max: { last_engagement_at: row.created_at, last_activity_at: row.created_at },
    $push: { diary_entries: { author: 'Mobile Message', date: row.created_at, note: `SMS received from ${row.phone}: ${row.body}` } },
  }).catch(() => {});
  if (event.type === 'inbound' && onInbound) await onInbound(lead, id, row.body).catch(() => {});
  return true;
}

// One provider inbox read serves every user, even when no customer is open.
// Persist partial pages and overlap the previous UTC day for late arrivals.
async function pollInbound({ db, sms, onInbound, now = new Date(), maxPages = 5 }) {
  if (!sms.configured() || !sms.listInbound) return { configured: false, imported: 0 };
  const states = db.collection('integration_sync'), key = 'sms-inbound';
  const state = await states.findOne({ _id: key });
  let from = state?.from, offset = state?.offset || 0, started = state?.cycle_started || now.toISOString();
  if (!from) {
    const [earliest] = await db.collection('customer_messages').find({ direction: { $ne: 'inbound' }, created_at: { $exists: true } })
      .sort({ created_at: 1, _id: 1 }).limit(1).toArray();
    if (!earliest || !Number.isFinite(Date.parse(earliest.created_at))) return { configured: true, imported: 0 };
    from = earliest.created_at.slice(0, 10);
  }
  let imported = 0;
  try {
    for (let index = 0; index < maxPages; index++) {
      const page = await sms.listInbound({ from, offset });
      const events = page.results.filter(event => ['inbound', 'unsubscribe'].includes(event.type) && event.message_id && typeof event.message === 'string');
      const outgoing = events.length ? await db.collection('customer_messages').find({ direction: { $ne: 'inbound' }, $or: [
        { provider_message_id: { $in: events.map(event => event.original_message_id).filter(Boolean) } },
        { _id: { $in: events.map(event => event.original_custom_ref).filter(Boolean) } },
      ] }).toArray() : [];
      for (const event of events) {
        const original = replyTo(event, outgoing);
        if (!original || !ObjectId.isValid(original.lead_id)) continue;
        const lead = await canonicalLead(db.collection('leads'), { _id: new ObjectId(original.lead_id) });
        if (lead && await saveInbound({ db, lead, original, event, onInbound })) imported++;
      }
      offset += page.results.length;
      const complete = offset >= page.total;
      if (!complete && !page.results.length) throw new Error('Incomplete SMS inbox page.');
      await states.findOneAndUpdate({ _id: key }, { $set: { kind: 'sms_inbound',
        from: complete ? new Date(Date.parse(started) - 86400000).toISOString().slice(0, 10) : from,
        offset: complete ? 0 : offset, cycle_started: complete ? null : started,
        ...(complete ? { last_success: now.toISOString() } : {}), error: null,
      } }, { upsert: true });
      if (complete) return { configured: true, imported, complete: true };
    }
    return { configured: true, imported, complete: false };
  } catch (error) {
    await states.findOneAndUpdate({ _id: key }, { $set: { kind: 'sms_inbound', error: 'Incoming SMS checks are temporarily unavailable.', last_attempt: now.toISOString() } }, { upsert: true });
    throw error;
  }
}

// Read the provider's inbox without consuming messages or replacing the shared
// Delivery Centre webhook. Only replies to this app's outgoing records belong here.
async function syncInbound({ db, lead, sms, onInbound }) {
  if (!sms.configured() || !sms.listInbound) return false;
  if (Date.now() - Date.parse(lead.sms_inbound_synced_at || '') < 15000) return false;
  const outgoing = await db.collection('customer_messages').find({ lead_id: String(lead._id), direction: { $ne: 'inbound' } }).toArray();
  const dated = outgoing.filter(row => Number.isFinite(Date.parse(row.created_at)));
  if (!dated.length) return false;
  const started = new Date().toISOString();
  const earliest = dated.reduce((a, row) => row.created_at < a ? row.created_at : a, dated[0].created_at);
  // Re-read the whole last successful UTC day to overlap new/late replies.
  const from = (lead.sms_inbound_synced_at || earliest).slice(0, 10);
  const deadline = Date.now() + 6000;
  let offset = 0;
  try {
    do {
      if (Date.now() >= deadline) return true;
      const page = await sms.listInbound({ from, offset });
      for (const event of page.results) {
        if (!['inbound', 'unsubscribe'].includes(event.type) || !event.message_id || typeof event.message !== 'string') continue;
        const original = replyTo(event, outgoing);
        if (!original) continue;
        await saveInbound({ db, lead, original, event, onInbound });
      }
      offset += page.results.length;
      if (offset >= page.total) break;
      if (!page.results.length) return true;
    } while (true);
    await db.collection('leads').findOneAndUpdate({ _id: lead._id }, { $set: { sms_inbound_synced_at: started } });
    return false;
  } catch { return true; }
}
module.exports = { syncInbound, pollInbound };
