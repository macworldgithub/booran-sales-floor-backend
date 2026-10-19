const { invalid } = require('./records');

function normalisePhone(value) {
  const number = String(value || '').replace(/[\s().-]/g, '').replace(/^\+/, '');
  const mobile = /^04\d{8}$/.test(number) ? `61${number.slice(1)}` : /^4\d{8}$/.test(number) ? `61${number}` : number;
  if (!/^614\d{8}$/.test(mobile)) invalid('The customer needs a valid Australian mobile number before sending SMS.');
  return `+${mobile}`;
}

function configured() {
  return Boolean(process.env.MOBILEMESSAGE_USERNAME && (process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY) && (process.env.MOBILEMESSAGE_SENDER_ID || process.env.MOBILEMESSAGE_FROM));
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

module.exports = { normalisePhone, configured, validateSmsLength, sendSms };
