const { invalid } = require('./records');
const local = require('./media-storage');

const CHUNK_SIZE = local.CHUNK_SIZE;
const chunkSize = media => media.storage_chunk_size || CHUNK_SIZE;
function createMongoMediaStorage(database) {
  const chunkId = (media, index) => `${media.storage_media_id || media._id}:${index}`;
  const ids = (media) => Array.from({ length: Math.ceil(media.size / chunkSize(media)) }, (_, index) => chunkId(media, index));
  async function readOnly() {
    throw Object.assign(new Error('MongoDB media storage is read-only. Start a new upload on the Sales Floor server.'), { status: 503 });
  }
  async function complete(media) {
    const CHUNK_SIZE = chunkSize(media);
    const rows = await (await database()).collection('message_media_chunks').find({ _id: { $in: ids(media) } }, { projection: { index: 1, size: 1 } }).sort({ index: 1 }).toArray();
    if (rows.length !== ids(media).length || rows.some((row, index) => row.index !== index || row.size !== Math.min(CHUNK_SIZE, media.size - index * CHUNK_SIZE))) invalid('The upload is incomplete. Upload the file again.');
  }
  async function readRange(media, start, end) {
    const CHUNK_SIZE = chunkSize(media);
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
  // Keep existing attachments readable without allowing any new chunk writes.
  return { configured: () => false, prepare: readOnly, uploadChunk: readOnly, complete, readRange };
}
function createMediaStorage(database, { localStorage = local } = {}) {
  const mongo = createMongoMediaStorage(database);
  const choose = (media) => media.storage_backend === 'mongodb' ? mongo : localStorage;
  return {
    ...localStorage,
    prepare: (media) => { media.storage_backend = 'local'; return localStorage.prepare(media); },
    uploadChunk: (media, ...args) => choose(media).uploadChunk(media, ...args),
    complete: (media) => choose(media).complete(media),
    readRange: (media, start, end) => mongo.readRange(media, start, end),
  };
}
module.exports = { createMongoMediaStorage, createMediaStorage };
