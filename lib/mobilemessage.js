const { invalid } = require('./records');

const { normalisePhone } = require('./phone');

function configured() {
  return Boolean(process.env.MOBILEMESSAGE_USERNAME && (process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY) && (process.env.MOBILEMESSAGE_SENDER_ID || process.env.MOBILEMESSAGE_FROM));
}

function deliveryStatus(value) {
  const status = String(value || '').toLowerCase();
  return ({ success: 'sent', accepted: 'queued', error: 'failed', undeliverable: 'failed' })[status] || (['pending', 'queued', 'scheduled', 'sent', 'delivered', 'failed', 'cancelled'].includes(status) ? status : null);
}
async function listInbound({ from, offset = 0 }, fetcher = fetch) {
  if (!configured()) return { results: [], total: 0 };
  const url = new URL(process.env.MOBILEMESSAGE_INBOUND_API_URL || 'https://api.mobilemessage.com.au/v1/inbound');
  url.searchParams.set('from', from);
  url.searchParams.set('limit', '200');
  url.searchParams.set('offset', String(offset));
  const Authorization = `Basic ${Buffer.from(`${process.env.MOBILEMESSAGE_USERNAME}:${process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY}`).toString('base64')}`;
  const response = await fetcher(url, { headers: { Authorization }, signal: AbortSignal.timeout(3000), cache: 'no-store' });
  if (!response.ok) throw new Error('Incoming SMS is temporarily unavailable.');
  const data = await response.json();
  if (data?.status !== 'complete' || !Array.isArray(data.results) || !Number.isInteger(data.total) || data.total < 0) throw new Error('Incoming SMS is temporarily unavailable.');
  return { results: data.results, total: data.total };
}
async function lookupMessage({ messageId, customRef, phone }, fetcher = fetch) {
  if (!configured() || (!messageId && !customRef)) return null;
  const url = new URL(process.env.MOBILEMESSAGE_API_URL || 'https://api.mobilemessage.com.au/v1/messages');
  url.searchParams.set(messageId ? 'message_id' : 'custom_ref', messageId || customRef);
  const Authorization = `Basic ${Buffer.from(`${process.env.MOBILEMESSAGE_USERNAME}:${process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY}`).toString('base64')}`;
  const response = await fetcher(url, { headers: { Authorization }, signal: AbortSignal.timeout(3000), cache: 'no-store' });
  if (!response.ok) throw new Error('Delivery status is temporarily unavailable.');
  const data = await response.json();
  const result = data?.results?.find((row) => {
    try { return Boolean(row.message_id) && (!messageId || String(row.message_id) === String(messageId)) && normalisePhone(row.to) === normalisePhone(phone); }
    catch { return false; }
  });
  const status = deliveryStatus(result?.status);
  if (!result || !status) return null;
  return { status, provider_message_id: String(result.message_id), error: status === 'failed' ? 'The carrier could not deliver this SMS. Check the recipient number in Mobile Message.' : status === 'cancelled' ? 'This SMS was cancelled.' : null };
}

function validateSmsLength(body) {
  const basic = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
  const extended = new Set('\f^{}\\[~]|€');
  let units = 0;
  let unicode = false;
  for (const char of body) {
    if (basic.has(char)) units += 1;
    else if (extended.has(char)) units += 2;
    else unicode = true;
  }
  if (unicode ? body.length > 670 : units > 1530) invalid(unicode ? 'Messages with emojis or Unicode, including links, must be no more than 670 characters (10 SMS parts).' : 'This message including links exceeds 10 SMS parts. Please shorten it.');
}

async function sendSms({ phone, body, requestId }, fetcher = fetch) {
  if (!configured()) return { status: 'failed', error: 'Mobile Message is not configured. Ask an administrator to configure SMS.' };
  try {
    const response = await fetcher(process.env.MOBILEMESSAGE_API_URL || 'https://api.mobilemessage.com.au/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${process.env.MOBILEMESSAGE_USERNAME}:${process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY}`).toString('base64')}`,
        'Idempotency-Key': requestId,
      },
      body: JSON.stringify({ enable_unicode: true, messages: [{ to: phone, message: body, sender: process.env.MOBILEMESSAGE_SENDER_ID || process.env.MOBILEMESSAGE_FROM, custom_ref: requestId }] }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null);
    const result = data?.results?.[0];
    if (response.ok && ['success', 'queued', 'sent', 'accepted'].includes(result?.status?.toLowerCase()) && result?.message_id) {
      return { status: 'queued', provider_message_id: String(result.message_id) };
    }
    // An indeterminate response must not encourage sending the same message again.
    if (response.status >= 500 || !data || (response.ok && !result)) return { status: 'unknown', error: 'Acceptance could not be confirmed. Check Mobile Message before sending again.' };
    return { status: 'failed', error: 'Mobile Message rejected this SMS. Check the sender, credits and recipient in Mobile Message.' };
  } catch {
    return { status: 'unknown', error: 'Acceptance could not be confirmed. Check Mobile Message before sending again.' };
  }
}

module.exports = { normalisePhone, configured, validateSmsLength, deliveryStatus, lookupMessage, listInbound, sendSms };
