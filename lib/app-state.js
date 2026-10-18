const STATE_COLLECTIONS = ['users', 'sessions', 'login_attempts', 'appointments'];

async function initialiseAppState(db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('login_attempts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('appointments').createIndex({ when: 1, _id: 1 });
  await db.collection('appointments').createIndex({ dealership: 1, when: 1, _id: 1 });
}

module.exports = { STATE_COLLECTIONS, initialiseAppState };
