const { Binary } = require('mongodb');
const { createHash } = require('node:crypto');
const { invalid } = require('./records');
const local = require('./media-storage');

const CHUNK_SIZE = local.CHUNK_SIZE;
function createMongoMediaStorage(database) {
  const chunkId = (media, index) => `${media._id}:${index}`;
  const ids = (media) => Array.from({ length: Math.ceil(media.size / CHUNK_SIZE) }, (_, index) => chunkId(media, index));
  async function uploadChunk(media, offset, bytes) {
    if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(offset) || offset < 0 || offset % CHUNK_SIZE || bytes.length !== Math.min(CHUNK_SIZE, media.size - offset) || !bytes.length) invalid('Invalid photo/video upload chunk.');
    const index = offset / CHUNK_SIZE;
    const row = { _id: chunkId(media, index), index, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex'), data: new Binary(bytes) };
    const collection = (await database()).collection('message_media_chunks');
    try { await collection.insertOne(row); }
    catch (error) {
      if (error.code !== 11000) throw error;
      const previous = await collection.findOne({ _id: row._id });
      if (previous?.hash !== row.hash) throw Object.assign(new Error('This chunk differs from the previously uploaded file.'), { status: 409 });
    }
    return offset + bytes.length;
  }
  async function complete(media) {
    const rows = await (await database()).collection('message_media_chunks').find({ _id: { $in: ids(media) } }, { projection: { index: 1, size: 1 } }).sort({ index: 1 }).toArray();
    if (rows.length !== ids(media).length || rows.some((row, index) => row.index !== index || row.size !== Math.min(CHUNK_SIZE, media.size - index * CHUNK_SIZE))) invalid('The upload is incomplete. Upload the file again.');
  }
  async function readRange(media, start, end) {
    const collection = (await database()).collection('message_media_chunks');
    const buffers = [];
    for (let index = Math.floor(start / CHUNK_SIZE); index <= Math.floor(end / CHUNK_SIZE); index++) {
      const row = await collection.findOne({ _id: chunkId(media, index) });
      if (!row) throw Object.assign(new Error('Media not found.'), { status: 404 });
      const bytes = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data.buffer);
      const from = Math.max(0, start - index * CHUNK_SIZE);
      const to = Math.min(bytes.length, end - index * CHUNK_SIZE + 1);
      buffers.push(bytes.subarray(from, to));
    }
    return Buffer.concat(buffers);
  }
  return { configured: () => true, prepare: async () => ({ chunk_size: CHUNK_SIZE }), uploadChunk, complete, readRange };
}
function createMediaStorage(database, mode) {
  const mongo = createMongoMediaStorage(database);
  const backend = () => {
    const selected = mode || process.env.MEDIA_STORAGE_BACKEND || 'auto';
    return selected === 'auto' ? (process.env.VERCEL ? 'mongodb' : 'local') : selected;
  };
  const choose = (media) => media.storage_backend === 'mongodb' ? mongo : local;
  return {
    ...local,
    configured: () => backend() === 'mongodb' || local.configured(),
    prepare: (media) => { media.storage_backend = backend(); return choose(media).prepare(media); },
    uploadChunk: (media, ...args) => choose(media).uploadChunk(media, ...args),
    complete: (media) => choose(media).complete(media),
    readRange: (media, start, end) => mongo.readRange(media, start, end),
  };
}
module.exports = { createMongoMediaStorage, createMediaStorage };
