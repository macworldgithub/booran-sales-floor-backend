require('dotenv').config();
const { MongoClient } = require('mongodb');
const { createMediaStorage } = require('../lib/mongo-media-storage');
const { processVideoJobs } = require('../lib/video-jobs');
async function main() {
  const client = new MongoClient(process.env.MONGODB_URI_FLWUP);
  await client.connect();
  const db = client.db();
  const storage = createMediaStorage(async () => db);
  let stopped = false;
  process.on('SIGTERM', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });
  try { while (!stopped) { await processVideoJobs(db, storage); if (!process.argv.includes('--watch')) break; await new Promise(resolve => setTimeout(resolve, 5000)); } }
  finally { await client.close(); }
}
main().catch(() => { console.error('Video worker failed. Verify database and FFmpeg configuration.'); process.exitCode = 1; });
