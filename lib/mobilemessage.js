const { invalid } = require('./records');

const { normalisePhone } = require('./phone');
const { phoneKey } = require('./phone');
const senderValue = value => typeof value === 'string' ? phoneKey(value) || value.trim() : undefined;

function senderFor(dealership) {
  const config = process.env.MOBILEMESSAGE_SENDERS_JSON;
  if (!config) return senderValue(process.env.MOBILEMESSAGE_SENDER_ID || process.env.MOBILEMESSAGE_FROM);
  try {
    const entries = Object.entries(JSON.parse(config)).filter(([, value]) => typeof value === 'string' && value.trim());
    if (!dealership) return senderValue(entries[0]?.[1]);
    return senderValue(entries.find(([site]) => site.toLowerCase() === dealership.toLowerCase())?.[1]);
  } catch { return undefined; }
}

function configured(dealership) {
  return Boolean(process.env.MOBILEMESSAGE_USERNAME && (process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY) && senderFor(dealership));
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

async function sendSms({ phone, body, requestId, dealership }, fetcher = fetch) {
  if (!configured(dealership)) return { status: 'failed', error: 'An approved Mobile Message sender is not configured for this dealership.' };
  try {
    const response = await fetcher(process.env.MOBILEMESSAGE_API_URL || 'https://api.mobilemessage.com.au/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${process.env.MOBILEMESSAGE_USERNAME}:${process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY}`).toString('base64')}`,
        'Idempotency-Key': requestId,
      },
      body: JSON.stringify({ enable_unicode: true, shorten_urls: 'auto', messages: [{ to: phoneKey(phone), message: body, sender: senderFor(dealership), custom_ref: requestId }] }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null);
    const result = data?.results?.[0];
    if (response.ok && ['success', 'queued', 'sent', 'accepted'].includes(result?.status?.toLowerCase()) && result?.message_id) {
      return { status: 'queued', provider_message_id: String(result.message_id) };
    }
    // An indeterminate response must not encourage sending the same message again.
    if (response.status >= 500 || response.status === 409 || !data || (response.ok && !result)) return { status: 'unknown', error: 'Acceptance could not be confirmed. Check Mobile Message before sending again.' };
    const providerError = typeof result?.error === 'string' ? result.error : typeof data.error === 'string' ? data.error : '';
    let error = 'Mobile Message rejected this SMS. Check the recipient and account settings.';
    if (response.status === 401) error = 'SMS account access was rejected. Ask an administrator to check the Mobile Message credentials.';
    else if (/credit|balance/i.test(providerError) || response.status === 403) error = 'Mobile Message cannot send with the current credits or sender permissions. Ask an administrator to check the account.';
    else if (/sender/i.test(providerError)) error = 'Mobile Message rejected the sender. Ask an administrator to select an approved sender for this dealership.';
    else if (/unsubscrib|opt.?out/i.test(providerError)) error = 'This customer has opted out of SMS. Their opt-out has been respected.';
    else if (response.status === 429) error = 'Mobile Message is busy. Please try again shortly.';
    else if (providerError) error = `Mobile Message: ${providerError.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 240)}`;
    return { status: 'failed', error, provider_http_status: response.status };
  } catch {
    return { status: 'unknown', error: 'Acceptance could not be confirmed. Check Mobile Message before sending again.' };
  }
}

async function accountStatus(dealership, fetcher = fetch) {
  const sender = senderFor(dealership);
  if (!configured(dealership)) return { configured: false, approved: false };
  const base = new URL(process.env.MOBILEMESSAGE_API_URL || 'https://api.mobilemessage.com.au/v1/messages');
  const Authorization = `Basic ${Buffer.from(`${process.env.MOBILEMESSAGE_USERNAME}:${process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY}`).toString('base64')}`;
  const read = async path => {
    const response = await fetcher(new URL(path, base), { headers: { Authorization }, signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!response.ok) throw new Error('Mobile Message account checks are temporarily unavailable.');
    return response.json();
  };
  const [account, senders] = await Promise.all([read('/v1/account'), read('/v1/senders')]);
  return { configured: true, sender, approved: Array.isArray(senders.results) && senders.results.some(row => senderValue(row.sender) === sender),
    creditBalance: typeof account.credit_balance === 'number' ? account.credit_balance : null };
}

module.exports = { normalisePhone, configured, validateSmsLength, deliveryStatus, lookupMessage, listInbound, sendSms, accountStatus, senderFor };
