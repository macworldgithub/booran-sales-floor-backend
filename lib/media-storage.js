const fs = require('node:fs/promises');
const path = require('node:path');
const { invalid } = require('./records');

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm'];
const MAX_MEDIA_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 2 * 1024 * 1024;
function validateMedia(body) {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) invalid('Provide a filename up to 200 characters.');
  if (!MEDIA_TYPES.includes(body.content_type)) invalid('Choose a supported photo or video (JPG, PNG, WebP, GIF, HEIC, MP4, MOV or WebM).');
  if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_MEDIA_SIZE) invalid('Each photo or video must be between 1 byte and 100 MB.');
  return { name: body.name.trim(), content_type: body.content_type, size: body.size };
}
const conflict = (message) => { throw Object.assign(new Error(message), { status: 409 }); };
const unavailable = 'Local media storage requires a backend server with persistent disk. Vercel cannot retain uploaded photos or videos.';

function createLocalStorage({ directory, serverless } = {}) {
  const configured = () => !(serverless ?? Boolean(process.env.VERCEL));
  function resolveFile(key) {
    if (!configured()) throw Object.assign(new Error(unavailable), { status: 503 });
    const root = path.resolve(__dirname, '..', directory || process.env.MEDIA_STORAGE_DIR || 'storage/media');
    if (typeof key !== 'string' || !/^(staging|files)\/[a-f0-9]{24}$/.test(key)) invalid('Invalid media storage key.');
    return path.join(root, ...key.split('/'));
  }
  // A disk lock also serialises writes when Node workers share the directory.
  async function exclusive(media, operation) {
    const staging = resolveFile(media.staging_key);
    await fs.mkdir(path.dirname(staging), { recursive: true });
    const lockPath = `${staging}.lock`;
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') conflict('This file is being saved. Please retry.'); throw error; }
    try { return await operation(staging); }
    finally { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
  }
  async function prepare(media) {
    const staging = resolveFile(media.staging_key);
    await fs.mkdir(path.dirname(staging), { recursive: true });
    await fs.mkdir(path.dirname(resolveFile(media.storage_key)), { recursive: true });
    const file = await fs.open(staging, 'wx', 0o600);
    await file.close();
    return { chunk_size: CHUNK_SIZE };
  }
  async function uploadChunk(media, offset, buffer) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(buffer) || !buffer.length || buffer.length > CHUNK_SIZE || offset + buffer.length > media.size) invalid('Invalid photo/video upload chunk.');
    return exclusive(media, async (staging) => {
      const file = await fs.open(staging, 'r+');
      try {
        const stat = await file.stat();
        if (offset > stat.size) conflict('Upload chunks must be sent in order.');
        if (offset < stat.size) {
          // A lost response can be retried only with the exact bytes already saved.
          if (offset + buffer.length > stat.size) conflict('This chunk overlaps a previous upload.');
          const previous = Buffer.alloc(buffer.length);
          const { bytesRead } = await file.read(previous, 0, previous.length, offset);
          if (bytesRead !== buffer.length || !previous.equals(buffer)) conflict('This chunk differs from the previously uploaded file.');
        } else {
          try {
            let written = 0;
            while (written < buffer.length) {
              const { bytesWritten } = await file.write(buffer, written, buffer.length - written, offset + written);
              if (!bytesWritten) throw new Error('The media file could not be written.');
              written += bytesWritten;
            }
            await file.sync();
          } catch (error) { await file.truncate(offset); throw error; }
        }
        return offset + buffer.length;
      } finally { await file.close(); }
    });
  }
  async function complete(media) {
    return exclusive(media, async (staging) => {
      const finalPath = resolveFile(media.storage_key);
      try {
        const final = await fs.stat(finalPath);
        if (final.size !== media.size) invalid('The stored photo/video does not match the upload.');
        return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const stat = await fs.stat(staging);
      if (stat.size !== media.size) invalid('The upload is incomplete. Upload the file again.');
      // Staging is never served. Rename exposes only the complete file.
      await fs.rename(staging, finalPath);
    });
  }
  async function download(media) {
    const filename = resolveFile(media.storage_key);
    try { const stat = await fs.stat(filename); if (!stat.isFile() || stat.size !== media.size) throw Object.assign(new Error('Media not found.'), { status: 404 }); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error('Media not found.'), { status: 404 }); throw error; }
    return filename;
  }
  return { configured, unavailable, validateMedia, MAX_MEDIA_SIZE, CHUNK_SIZE, prepare, uploadChunk, complete, download };
}
module.exports = { ...createLocalStorage(), createLocalStorage };
