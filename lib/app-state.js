const STATE_COLLECTIONS = ['users', 'sessions', 'login_attempts', 'appointments'];

async function ensureQueryIndexes(db, definitions) {
  const outcomes = await Promise.allSettled(Object.entries(definitions).map(async ([name, keys]) => {
    const collection = db.collection(name);
    let existing;
    try { existing = await collection.indexes(); }
    catch (error) { if (error.code !== 26) throw error; existing = []; }
    const pending = keys.filter(key => !existing.some(index => JSON.stringify(index.key) === JSON.stringify(key)));
    if (pending.length) await collection.createIndexes(pending.map(key => ({
      key, name: Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join('_'),
    })));
  }));
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
}

async function initialiseAppState(db) {
  db = require('./lead-state').withLeadState(db);
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('login_attempts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('appointments').createIndex({ when: 1, _id: 1 });
  await db.collection('appointments').createIndex({ dealership: 1, when: 1, _id: 1 });
  await db.collection('leads').createIndex({ dealership_name: 1, source: 1, created_at: -1, _id: 1 });
  await db.collection('leads').createIndex({ owner_id: 1, created_at: -1, _id: 1 });
  await db.collection('message_media').createIndex({ status: 1, processing_started_at: 1 });
  await db.collection('leads').createIndex({ dealership_name: 1, 'loss_review.status': 1 });
  await db.collection('leads').createIndex({ owner_id: 1, last_activity_at: 1 });
  await db.collection('sales_tasks').createIndex({ assignee_id: 1, status: 1, due_at: 1 });
  await db.collection('deals').createIndex({ stock_key: 1 }, {
    unique: true, partialFilterExpression: { stock_key: { $exists: true }, status: { $in: ['registered', 'completed'] } },
  });
  await db.collection('deliveries').createIndex({ deal_id: 1 }, { unique: true });
  await db.collection('push_devices').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('sales_alerts').createIndex({ dealership: 1, createdAt: -1, _id: 1 });
  await ensureQueryIndexes(db, {
    leads: [{ status: 1, created_at: -1, _id: 1 }, { created_at: -1, _id: 1 },
      { last_activity_at: 1 }, { createdAt: 1 }, { 'loss_review.status': 1 }],
    sales_tasks: [{ status: 1, due_at: 1 }, { status: 1, createdAt: -1, _id: 1 }, { lead_id: 1, status: 1 }],
    deals: [{ lead_id: 1, createdAt: -1, _id: 1 }, { status: 1, completed_at: 1, owner_id: 1 }],
    appraisals: [{ lead_id: 1, createdAt: -1, _id: 1 }],
    deliveries: [{ lead_id: 1, createdAt: -1, _id: 1 }, { createdAt: -1, _id: 1 }],
    appointments: [{ leadId: 1, dealership: 1 }],
    customer_messages: [{ lead_id: 1, created_at: -1, _id: 1 }, { dealership_name: 1, phone: 1, created_at: -1 }],
    message_media: [{ lead_id: 1, status: 1, created_at: -1, _id: 1 }, { share_token: 1 }],
    sales_alerts: [{ lead_id: 1 }],
    lead_merge_requests: [{ dealership: 1, status: 1, createdAt: -1, _id: 1 }],
    lead_source_links: [{ lead_id: 1 }],
    lead_email_receipts: [{ dealership: 1, received_at: -1 }],
  });
}

async function initialiseInventoryIndexes(db) {
  await ensureQueryIndexes(db, {
    vehicles: [{ daysInStock: -1, _id: 1 }, { status: 1, daysInStock: -1, _id: 1 },
      { category: 1, daysInStock: -1, _id: 1 }, { agingBucket: 1, daysInStock: -1, _id: 1 }],
    actionitems: [{ status: 1, createdAt: -1, _id: 1 }, { createdAt: -1, _id: 1 }],
    feedlogs: [{ createdAt: -1, _id: 1 }],
  });
}

module.exports = { STATE_COLLECTIONS, initialiseAppState, initialiseInventoryIndexes };
