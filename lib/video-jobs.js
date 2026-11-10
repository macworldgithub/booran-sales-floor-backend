const { randomUUID } = require('node:crypto');
const { brandVideo } = require('./video-branding');
let running = false;
async function processVideoJobs(db, storage) {
  if (running) return;
  running = true;
  try {
    const rows = await db.collection('message_media').find({ $or: [{ status: 'processing' }, { status: 'rendering', processing_started_at: { $lt: new Date(Date.now() - 15 * 60000).toISOString() } }] }).sort({ created_at: 1 }).limit(3).toArray();
    for (const row of rows) {
      const lease = randomUUID();
      const claimed = await db.collection('message_media').findOneAndUpdate({ _id: row._id, status: row.status, processing_lease: row.processing_lease ?? null }, {
        $set: { status: 'rendering', processing_started_at: new Date().toISOString(), processing_lease: lease },
      }, { returnDocument: 'after' });
      if (!claimed) continue;
      try {
        const fields = await brandVideo(claimed, storage, claimed.branding);
        await db.collection('message_media').findOneAndUpdate({ _id: row._id, processing_lease: lease }, { $set: { ...fields, status: 'ready', processing_error: null } });
      } catch (error) {
        await db.collection('message_media').findOneAndUpdate({ _id: row._id, processing_lease: lease }, { $set: { status: 'processing_failed', processing_error: error.status ? error.message : 'Video branding could not finish. Please retry.' } });
      }
    }
  } finally { running = false; }
}
module.exports = { processVideoJobs };
