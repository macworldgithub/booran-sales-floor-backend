const { ObjectId } = require('mongodb');
const { isManager } = require('./roles');
const { route, fail } = require('./workflow-route');

async function notificationScope(req, database) {
  if (!isManager(req.user) && req.user.role !== 'sales_consultant') fail(403, 'A sales account is required.');
  const db = await database(req);
  // Resolve current lead ownership, not the sender or owner at import time.
  // This also keeps notifications correct after assignment changes and merges.
  const leads = await db.collection('leads').find({ merged_into: { $exists: false } }, { projection: { _id: 1, customer_name: 1 } }).toArray();
  return { db, leads, query: { direction: 'inbound', event_type: { $ne: 'unsubscribe' }, lead_id: { $in: leads.map(lead => String(lead._id)) } } };
}

function installSmsNotifications(router, database, sms) {
  router.get('/notifications', route(async (req, res) => {
    const { db, leads, query } = await notificationScope(req, database);
    const unread = { ...query, notification_read_by: { $ne: req.user.id } };
    const match = req.query.unread === 'false' ? query : unread;
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1)), limit = 20;
    const [items, unreadCount, total, state] = await Promise.all([
      db.collection('customer_messages').find(match, { projection: { _id: 1, lead_id: 1, dealership_name: 1, body: 1, created_at: 1, notification_read_by: 1 } })
        .sort({ created_at: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
      db.collection('customer_messages').countDocuments(unread),
      db.collection('customer_messages').countDocuments(match),
      (await database()).collection('integration_sync').findOne({ _id: 'sms-inbound' }),
    ]);
    const names = new Map(leads.map(lead => [String(lead._id), lead.customer_name || 'Customer']));
    res.json({ success: true, data: { unreadCount, items: items.map(row => ({
      id: row._id, kind: 'sms_reply', leadId: row.lead_id, customer: names.get(row.lead_id),
      dealership: row.dealership_name, body: String(row.body || '').slice(0, 500), createdAt: row.created_at,
      read: row.notification_read_by?.includes(req.user.id) || false,
    })), warning: !sms.configured() ? 'Incoming SMS checks need messaging account configuration.' : state?.error || null,
      lastCheckedAt: state?.last_success || null }, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  }));
  router.post('/notifications/read-all', route(async (req, res) => {
    const { db, query } = await notificationScope(req, database);
    await db.collection('customer_messages').updateMany({ ...query, notification_read_by: { $ne: req.user.id } }, { $addToSet: { notification_read_by: req.user.id } });
    res.json({ success: true });
  }));
  router.patch('/notifications/:id/read', route(async (req, res) => {
    if (!isManager(req.user) && req.user.role !== 'sales_consultant') fail(403, 'A sales account is required.');
    if (!/^inbound:[a-f0-9]{64}$/.test(req.params.id)) fail(404, 'Notification not found.');
    const db = await database(req);
    const query = { _id: req.params.id, direction: 'inbound', event_type: { $ne: 'unsubscribe' } };
    const message = await db.collection('customer_messages').findOne(query);
    if (!message || !ObjectId.isValid(message.lead_id) || !await db.collection('leads').findOne({ _id: new ObjectId(message.lead_id), merged_into: { $exists: false } })) fail(404, 'Notification not found.');
    await db.collection('customer_messages').findOneAndUpdate(query, { $addToSet: { notification_read_by: req.user.id } });
    res.json({ success: true });
  }));
}
module.exports = { installSmsNotifications };
