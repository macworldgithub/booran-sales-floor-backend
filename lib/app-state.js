const STATE_COLLECTIONS = ['users', 'sessions', 'login_attempts', 'appointments'];

async function initialiseAppState(db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('login_attempts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('appointments').createIndex({ when: 1, _id: 1 });
  await db.collection('appointments').createIndex({ dealership: 1, when: 1, _id: 1 });
  await db.collection('leads').createIndex({ dealership_name: 1, source: 1, created_at: -1, _id: 1 });
  await db.collection('leads').createIndex({ owner_id: 1, created_at: -1, _id: 1 });
  await db.collection('sales_tasks').createIndex({ assignee_id: 1, status: 1, due_at: 1 });
  await db.collection('deals').createIndex({ stock_key: 1 }, {
    unique: true, partialFilterExpression: { stock_key: { $exists: true }, status: { $in: ['registered', 'completed'] } },
  });
  await db.collection('deliveries').createIndex({ deal_id: 1 }, { unique: true });
  await db.collection('push_devices').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('sales_alerts').createIndex({ dealership: 1, createdAt: -1, _id: 1 });
}

module.exports = { STATE_COLLECTIONS, initialiseAppState };
