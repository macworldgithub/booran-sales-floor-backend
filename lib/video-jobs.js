const { randomUUID } = require('node:crypto');
const { brandVideo } = require('./video-branding');
let running = false;
async function processVideoJobs(db, storage, { render = brandVideo, concurrency = 2 } = {}) {
  if (running) return;
  running = true;
  try {
    const rows = await db.collection('message_media').find({ $or: [{ status: 'processing' }, { status: 'rendering', processing_started_at: { $lt: new Date(Date.now() - 5 * 60000).toISOString() } }] }).sort({ created_at: 1 }).limit(Math.max(1,Math.min(3,concurrency))).toArray();
    await Promise.all(rows.map(async row => {
      const lease = randomUUID();
      const claimed = await db.collection('message_media').findOneAndUpdate({ _id: row._id, status: row.status, processing_lease: row.processing_lease ?? null }, {
        $set: { status: 'rendering', processing_started_at: new Date().toISOString(), processing_lease: lease },
      }, { returnDocument: 'after' });
      if (!claimed) return;
      try {
        const fields = await render(claimed, storage, claimed.branding);
        const finish=async session=>{
          const ready=await db.collection('message_media').findOneAndUpdate({ _id: row._id, processing_lease: lease }, { $set: { ...fields, status: 'ready', processing_error: null } },{session});
          if(ready&&claimed.lead_id)await require('./crm-updates').completeVideoActions(db,claimed.lead_id,'uploaded',claimed.user_id,claimed.created_at,session);
        };
        if(claimed.lead_id)await db.client.withSession(session=>session.withTransaction(()=>finish(session)));
        else await finish();
      } catch (error) {
        await db.collection('message_media').findOneAndUpdate({ _id: row._id, processing_lease: lease }, { $set: { status: 'processing_failed', processing_error: error.status ? error.message : 'Video branding could not finish. Please retry.' } });
      }
    }));
  } finally { running = false; }
}
module.exports = { processVideoJobs };
