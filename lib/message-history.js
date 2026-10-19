
function phoneKey(value) {
  const number = String(value || '').replace(/\D/g, '');
  if (/^04\d{8}$/.test(number)) return `61${number.slice(1)}`;
  if (/^4\d{8}$/.test(number)) return `61${number}`;
  return /^614\d{8}$/.test(number) ? number : '';
}
function phonePattern(value) {
  const key = phoneKey(value);
  return key ? `^\\D*(?:61\\D*|0\\D*)?${key.slice(2).split('').join('\\D*')}\\D*$` : '(?!)';
}
const isoDate = (value) => {
  if (!value) return '';
  const date = new Date(typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isFinite(+date) ? date.toISOString() : '';
};
const rank = (status) => ({ failed: 5, error: 5, cancelled: 5, delivered: 6, received: 6, sent: 3, success: 3, queued: 2, pending: 1 })[status] || 0;
function mergeMessages(rows) {
  const messages = new Map();
  for (const row of rows) {
    const key = `${row.direction || 'outbound'}:${row.provider_message_id || row.id}`;
    const previous = messages.get(key);
    if (!previous) messages.set(key, row);
    else if (rank(row.status) > rank(previous.status)) { previous.status = row.status; previous.error = row.error; }
  }
  return [...messages.values()].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || b.id.localeCompare(a.id));
}

async function collectHistory({ db, lead }) {
  const focus = lead.customer_phone || lead.phone;
  const phone = { $regex: phonePattern(focus) };
  const query = phoneKey(focus) ? { $or: [{ lead_id: String(lead._id) }, { phone }] } : { lead_id: String(lead._id) };
  const native = await db.collection('customer_messages').find(query).toArray();
  const rows = native.map((row) => ({ ...row, id: String(row._id), direction: row.direction || 'outbound', source: 'Sales Floor', created_at: isoDate(row.created_at), attachments: row.attachments || [], saveReceipt: (fields) => db.collection('customer_messages').findOneAndUpdate({ _id: row._id, status: row.status }, { $set: fields }, { returnDocument: 'after' }) }));
  return { rows: mergeMessages(rows), warnings: [] };
}

async function refreshReceipts(rows, sms) {
  if (!sms.configured() || !sms.lookupMessage) return false;
  let unavailable = false;
  const deadline = Date.now() + 6000;
  const pending = rows.filter((row) => row.direction !== 'inbound' && row.saveReceipt && (!row.provider_checked_at || Date.now() - Date.parse(row.provider_checked_at) >= 15000) && ['queued', 'pending', 'sent', 'unknown', 'success', 'accepted'].includes(row.status) && (row.provider_message_id || row.source === 'Sales Floor'));
  for (let index = 0; index < pending.length; index += 3) {
    if (Date.now() >= deadline) { unavailable = true; break; }
    await Promise.all(pending.slice(index, index + 3).map(async (row) => {
      try {
        const result = await sms.lookupMessage({ messageId: row.provider_message_id, customRef: row.source === 'Sales Floor' ? row.id : undefined, phone: row.phone });
        if (!result) return;
        const saved = await row.saveReceipt({ ...result, provider_checked_at: new Date().toISOString() });
        if (saved) Object.assign(row, result);
      } catch { unavailable = true; }
    }));
  }
  return unavailable;
}
module.exports = { phoneKey, phonePattern, mergeMessages, collectHistory, refreshReceipts };
