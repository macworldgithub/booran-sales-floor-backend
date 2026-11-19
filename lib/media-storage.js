const fs = require('node:fs/promises');
const path = require('node:path');
const { invalid } = require('./records');

const MEDIA_TYPES = [
  // Photos (iOS / iPhone, Android, Web)
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/x-png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  'image/x-adobe-dng',
  'image/dng',
  'image/bmp',
  'image/x-ms-bmp',
  'image/tiff',
  // Videos (iOS / iPhone, Android, Web)
  'video/mp4',
  'video/quicktime',
  'video/x-quicktime',
  'video/x-m4v',
  'video/m4v',
  'video/webm',
  'video/3gpp',
  'video/3gpp2',
  'video/3gp',
  'video/x-msvideo',
  'video/avi',
  'video/msvideo',
  'video/x-matroska',
  'video/mkv',
  'video/mpeg',
  'video/mpg',
  'video/mp2t',
  'video/ts',
  'video/x-ms-wmv',
];

const EXTENSION_MIME_MAP = {
  // Photos
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  dng: 'image/x-adobe-dng',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // Videos
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  '3gpp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
};

const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

function normalizeMediaType(name, contentType) {
  const cleanType = typeof contentType === 'string' ? contentType.trim().toLowerCase() : '';
  if (cleanType && MEDIA_TYPES.includes(cleanType)) return cleanType;
  if (!cleanType || GENERIC_TYPES.has(cleanType)) {
    const ext = typeof name === 'string' ? name.trim().split('.').pop().toLowerCase() : '';
    if (ext && EXTENSION_MIME_MAP[ext]) return EXTENSION_MIME_MAP[ext];
  }
  return cleanType;
}

const MAX_MEDIA_SIZE = 500 * 1024 * 1024;
const CHUNK_SIZE = 2 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024;
function validateMedia(body) {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) invalid('Provide a filename up to 200 characters.');
  const resolvedType = normalizeMediaType(body.name, body.content_type);
  const privateContract = body.visibility === 'private' && body.purpose === 'contract' && (resolvedType === 'application/pdf' || body.content_type === 'application/pdf');
  if (!privateContract && !MEDIA_TYPES.includes(resolvedType)) invalid('Choose a supported photo or video, or a private PDF contract.');
  if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_MEDIA_SIZE) invalid('Each photo or video must be between 1 byte and 500 MB.');
  return { name: body.name.trim(), content_type: resolvedType || body.content_type, size: body.size };
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
    return { chunk_size: UPLOAD_CHUNK_SIZE };
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
module.exports = { ...createLocalStorage(), createLocalStorage, UPLOAD_CHUNK_SIZE };
