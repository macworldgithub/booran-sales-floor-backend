const { createHash } = require('node:crypto');
const { phoneKey } = require('./message-history');

// Read the provider's inbox without consuming messages or replacing the shared
// Delivery Centre webhook. Only replies to this app's outgoing records belong here.
async function syncInbound({ db, lead, sms }) {
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
        const original = outgoing.find(row =>
          (event.original_message_id && row.provider_message_id === event.original_message_id || event.original_custom_ref && String(row._id) === event.original_custom_ref) &&
          (!event.original_message_id || !row.provider_message_id || row.provider_message_id === event.original_message_id) &&
          phoneKey(event.from) && phoneKey(event.from) === phoneKey(row.phone));
        if (!original) continue;
        const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(event.received_at) ? event.received_at.replace(' ', 'T') + 'Z' : event.received_at);
        if (!Number.isFinite(+date)) continue;
        const id = 'inbound:' + createHash('sha256').update(String(event.message_id)).digest('hex');
        const row = { _id: id, lead_id: String(lead._id), dealership_name: original.dealership_name, direction: 'inbound', status: 'received', body: event.message, phone: original.phone, author: lead.customer_name || 'Customer', created_at: date.toISOString(), attachments: [], provider: 'mobilemessage', provider_message_id: String(event.message_id), original_message_id: event.original_message_id, event_type: event.type };
        try { await db.collection('customer_messages').insertOne(row); }
        catch (error) { if (error.code === 11000) continue; throw error; }
        await db.collection('leads').findOneAndUpdate({ _id: lead._id }, { $push: { diary_entries: { author: 'Mobile Message', date: row.created_at, note: `SMS received from ${row.phone}: ${row.body}` } } }).catch(() => {});
      }
      offset += page.results.length;
      if (offset >= page.total) break;
      if (!page.results.length) return true;
    } while (true);
    await db.collection('leads').findOneAndUpdate({ _id: lead._id }, { $set: { sms_inbound_synced_at: started } });
    return false;
  } catch { return true; }
}
module.exports = { syncInbound };
