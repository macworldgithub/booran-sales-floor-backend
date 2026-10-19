// Explicit, live SMS smoke check using the real authenticated Express endpoints.
// Reuse --request-id if repeating a run after an interrupted/lost response.
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
const { randomBytes, createHash } = require('node:crypto');
const { createApp } = require('../server');
const { normalisePhone, configured } = require('../lib/mobilemessage');

async function main() {
  const arguments = process.argv.slice(2);
  const option = (key) => arguments[arguments.indexOf(key) + 1];
  for (const key of ['--phone', '--message', '--request-id']) if (!arguments.includes(key) || !option(key)) throw new Error(`Pass ${key} explicitly for this live SMS test.`);
  const phone = normalisePhone(option('--phone'));
  const body = option('--message');
  const requestId = option('--request-id');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) throw new Error('Use a UUID for --request-id.');
  if (!configured()) throw new Error('Mobile Message is not configured in the backend .env.');
  const client = new MongoClient(process.env.MONGODB_URI_FLWUP, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
  let db, server, sessionId;
  try {
    await client.connect();
    db = client.db();
    const user = await db.collection('users').findOne({ email: 'southmorang@booran.com', active: true });
    if (!user || user.role !== 'manager' || user.site !== 'South Morang') throw new Error('Expected South Morang staff account is unavailable.');
    // The database credential authorises this short-lived session for the existing account.
    // No password/role changes; the token never leaves this process and is revoked below.
    const token = randomBytes(32).toString('hex');
    sessionId = createHash('sha256').update(token).digest('hex');
    await db.collection('sessions').insertOne({ _id: sessionId, userId: user._id, createdAt: new Date(), expiresAt: new Date(Date.now() + 120000) });
    const app = createApp({ database: async (key) => { if (key !== 'MONGODB_URI_FLWUP') throw new Error('This smoke test only uses the CRM database.'); return db; } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    async function request(path, method = 'GET', data) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { cookie: `booran_session=${token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(25000) });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(`Backend ${method} ${path}: ${result.error || response.status}`);
      return result;
    }
    let lead = await db.collection('leads').findOne({ customer_phone: phone, source: 'Mobile Message SMS test', dealership_name: 'BYD South Morang' });
    let leadId;
    if (lead) leadId = String(lead._id);
    else {
      const result = await request('/leads', 'POST', { name: 'SMS Test Lead', phone, dealership_name: 'BYD South Morang', source: 'Mobile Message SMS test', notes: 'Test lead created at the user’s request to verify Mobile Message SMS.' });
      leadId = result.data._id;
    }
    console.log(JSON.stringify({ step: 'lead_ready', leadId, phone, dealership: 'BYD South Morang' }));
    const result = await request(`/leads/${leadId}/messages`, 'POST', { body, request_id: requestId, media_ids: [] });
    const stored = await db.collection('customer_messages').findOne({ _id: result.data.id, lead_id: leadId });
    const refreshed = await request(`/leads/${leadId}`);
    const history = await request(`/leads/${leadId}/messages`);
    console.log(JSON.stringify({ step: 'sms_result', leadId, phone, body: result.data.body, status: result.data.status, error: result.data.error, messageId: result.data.id, providerMessageId: stored?.provider_message_id, loggedInCustomerHistory: history.data.messages.some((message) => message.id === result.data.id), loggedInCustomerDiary: refreshed.data.diary_entries.some((entry) => entry.note.includes(`SMS ${result.data.status} to ${phone}: ${body}`)), staffIdentityRecorded: stored?.user_id === String(user._id) }));
    if (result.data.status !== 'queued') process.exitCode = 2;
  } finally {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    if (db && sessionId) await db.collection('sessions').deleteOne({ _id: sessionId });
    await client.close();
  }
}
main().catch((error) => { console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[database connection redacted]')); process.exitCode = 1; });
